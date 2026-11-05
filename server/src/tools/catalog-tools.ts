import { z } from 'zod';
import type { CatalogRepository } from '../catalog/repository.ts';
import type { CompanyPackage } from '../catalog/types.ts';
import { customerFacingCompany } from '../brand.ts';
import type { CompanyInfo } from '../db/seed.ts';
import { localDate } from '../text/dates.ts';
import { defineTool, ToolError, type RegisteredTool, type SourceType } from './registry.ts';

const DEMO_NOTICE =
  'DEMO DATA: fictional company programs. Prices are illustrative, not real offers; no seats or departures are confirmed; booking is not available.';
const STALE_VERIFICATION_MS = 7 * 24 * 60 * 60 * 1000;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const currencyCode = z.string().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code such as EGP or USD').transform((c) => c.toUpperCase());

const PartySchema = {
  adults: z.number().int().min(1).max(50).optional().describe('Number of adult travelers, if the user said it.'),
  children: z.number().int().min(0).max(50).optional().describe('Number of children, if the user said it.'),
};
const BudgetSchema = {
  totalBudget: z.number().positive().optional().describe('Total budget for the whole party. Only set when the user said the budget is total.'),
  budgetCurrency: currencyCode.optional().describe('Currency of the user\'s budget (EGP if they said جنيه). Required for budget verdicts; never convert currencies.'),
};

function sourceTypeOf(packages: CompanyPackage[]): SourceType {
  return packages.length > 0 && packages.every((p) => p.sourceType === 'company_verified') ? 'company_verified' : 'company_demo';
}

interface Party { adults: number | undefined; children: number | undefined; totalBudget: number | undefined; budgetCurrency: string | undefined }

function pricing(p: CompanyPackage, party: Party) {
  const base = { perPerson: p.price.amount, currency: p.price.currency, basis: p.price.basis };
  const warnings: string[] = [];
  if (party.adults !== undefined && /double|twin|occupancy/i.test(p.price.basis) && party.adults % 2 === 1) {
    warnings.push(`Price basis is "${p.price.basis}"; a single-room supplement may apply for an odd number of adults. Confirm with the company.`);
  }
  if (party.adults === undefined) {
    return { ...base, adultsSubtotal: null, totalForParty: null, totalNote: 'Party size unknown; price shown per person.', warnings };
  }
  const adultsSubtotal = p.price.amount * party.adults;
  if (party.children !== undefined && party.children > 0) {
    return {
      ...base,
      adultsSubtotal,
      totalForParty: null,
      totalNote: `Adults only: ${party.adults} × ${p.price.amount} ${p.price.currency}. Child rates are not stored; ask the children's ages and confirm child pricing with the company. Do not assume a discount or the adult fare.`,
      warnings,
    };
  }
  let budgetVerdict: Record<string, unknown> = {};
  if (party.totalBudget !== undefined) {
    if (party.budgetCurrency === p.price.currency) {
      budgetVerdict = { withinTotalBudget: adultsSubtotal <= party.totalBudget, differenceFromBudget: party.totalBudget - adultsSubtotal };
    } else {
      warnings.push(`Budget currency is ${party.budgetCurrency ?? 'unknown'} but the price is in ${p.price.currency}; no budget verdict given and no conversion made.`);
    }
  }
  return {
    ...base,
    adultsSubtotal,
    totalForParty: adultsSubtotal,
    totalNote: `${party.adults} adult(s) × ${p.price.amount} ${p.price.currency} (${p.price.basis}).`,
    ...budgetVerdict,
    warnings,
  };
}

function packageSummary(p: CompanyPackage) {
  return {
    id: p.id, nameAr: p.nameAr, nameEn: p.nameEn, destination: p.destination, destinationAr: p.destinationAr, country: p.country,
    tripType: p.tripType, days: p.days, nights: p.nights, departureCity: p.departureCity, status: p.status, sourceType: p.sourceType, tags: p.tags,
  };
}

async function resolveOne(repo: CatalogRepository, reference: string): Promise<CompanyPackage> {
  const matches = await repo.resolve(reference);
  const [first] = matches;
  if (!first) throw new ToolError('NOT_FOUND', `No company package matches "${reference}". The company catalog does not contain it.`);
  if (matches.length > 1) {
    throw new ToolError('AMBIGUOUS_REFERENCE', `"${reference}" matches several packages; ask the user which one.`, {
      candidates: matches.map((m) => ({ id: m.id, nameAr: m.nameAr, destination: m.destination })),
    });
  }
  return first;
}

export function createCatalogTools(repo: CatalogRepository, company: CompanyInfo): RegisteredTool[] {
  const listDestinations = defineTool({
    name: 'list_company_destinations',
    description:
      'List every destination that currently has a program in the company catalog database. Use for "what trips do you have?" questions. The catalog can grow at any time; never assume the list from memory.',
    inputSchema: z.object({}),
    sideEffect: 'read',
    execute: async () => {
      const destinations = await repo.listDestinations();
      return {
        sourceType: company.fictional ? 'company_demo' : 'company_verified',
        summary: `${destinations.length} destination(s) in catalog`,
        result: { company: customerFacingCompany(company).name, companyIsFictional: company.fictional, notice: DEMO_NOTICE, destinations },
      };
    },
  });

  const searchPackages = defineTool({
    name: 'search_company_packages',
    description:
      'Search the company package catalog (structured DB, the only source of company prices). Free text matches destination, name or keywords in Arabic, English or Franco (e.g. "Hurghada", "الغردقة", "بحر", "sea", "desert"). Trip types: beach, culture, adventure. Pass party size, total budget and budget currency to get computed totals and a budget verdict. Returns exact stored prices with their basis.',
    inputSchema: z
      .object({
        query: z.string().max(200).optional().describe('Destination, package name or keywords. Omit to list all packages.'),
        tripType: z.string().max(40).optional().describe('Catalog trip type: beach, culture or adventure.'),
        maxPricePerPerson: z.number().positive().optional().describe('Requires budgetCurrency.'),
        minDays: z.number().int().positive().optional(),
        maxDays: z.number().int().positive().optional(),
        sortBy: z.enum(['price_asc', 'price_desc', 'days_asc', 'days_desc']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        ...BudgetSchema,
        ...PartySchema,
      })
      .refine((v) => v.maxPricePerPerson === undefined || v.budgetCurrency !== undefined, {
        message: 'maxPricePerPerson needs budgetCurrency; ask the user which currency if it is unclear.',
        path: ['budgetCurrency'],
      }),
    sideEffect: 'read',
    execute: async (input) => {
      const packages = await repo.search({
        ...(input.query !== undefined ? { text: input.query } : {}),
        ...(input.tripType !== undefined ? { tripType: input.tripType } : {}),
        ...(input.maxPricePerPerson !== undefined && input.budgetCurrency !== undefined
          ? { maxPricePerPerson: input.maxPricePerPerson, currency: input.budgetCurrency }
          : {}),
        ...(input.minDays !== undefined ? { minDays: input.minDays } : {}),
        ...(input.maxDays !== undefined ? { maxDays: input.maxDays } : {}),
        ...(input.sortBy !== undefined ? { sortBy: input.sortBy } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      const warnings: string[] = [];
      if (input.totalBudget !== undefined && input.adults === undefined) {
        warnings.push('A total budget was given without the number of travelers; ask how many people before judging fit.');
      }
      const party: Party = { adults: input.adults, children: input.children, totalBudget: input.totalBudget, budgetCurrency: input.budgetCurrency };
      return {
        sourceType: sourceTypeOf(packages),
        summary: `${packages.length} package(s): ${packages.map((p) => `${p.id}@${p.price.amount}${p.price.currency}`).join(', ') || 'none'}`,
        warnings,
        result: {
          notice: DEMO_NOTICE,
          count: packages.length,
          packages: packages.map((p) => ({ ...packageSummary(p), pricing: pricing(p, party) })),
          ...(packages.length === 0
            ? { note: 'No company package matches these filters. Say so plainly; for destinations outside the catalog, research_external_packages can be used.' }
            : {}),
        },
      };
    },
  });

  const getDetails = defineTool({
    name: 'get_package_details',
    description:
      'Get full stored details of ONE company package: inclusions, exclusions, day-by-day itinerary, pricing basis, status and disclaimer. Use for "is X included?" questions. Accepts a package id, slug or destination name.',
    inputSchema: z.object({ package: z.string().min(1).max(120).describe('Package id (e.g. pkg-fayoum-001), slug, or destination name.') }),
    sideEffect: 'read',
    execute: async (input) => {
      const p = await resolveOne(repo, input.package);
      return {
        sourceType: p.sourceType,
        summary: `details ${p.id}`,
        result: {
          notice: DEMO_NOTICE,
          package: {
            ...packageSummary(p), price: p.price, inclusions: p.inclusions, exclusions: p.exclusions, itinerary: p.itinerary,
            bookingEnabled: p.bookingEnabled, disclaimer: p.disclaimer, updatedAt: p.updatedAt,
          },
          missingFields: ['cancellation_policy', 'child_rates', 'confirmed_departure_dates'],
        },
      };
    },
  });

  const compare = defineTool({
    name: 'compare_company_packages',
    description:
      'Compare 2-6 company packages side by side on price, duration and type, with computed party totals. Results keep the order given, so "the second one" refers to position 2.',
    inputSchema: z.object({
      packages: z.array(z.string().min(1).max(120)).min(2).max(6).describe('Package ids, slugs or destination names, in the order the user mentioned them.'),
      ...BudgetSchema,
      ...PartySchema,
    }),
    sideEffect: 'read',
    execute: async (input) => {
      const resolved: CompanyPackage[] = [];
      for (const ref of input.packages) resolved.push(await resolveOne(repo, ref));
      const party: Party = { adults: input.adults, children: input.children, totalBudget: input.totalBudget, budgetCurrency: input.budgetCurrency };
      const rows = resolved.map((p, i) => ({ position: i + 1, ...packageSummary(p), pricing: pricing(p, party) }));
      const sameCurrency = new Set(resolved.map((p) => p.price.currency)).size === 1;
      const cheapest = sameCurrency ? [...resolved].sort((a, b) => a.price.amount - b.price.amount)[0] : undefined;
      const longest = [...resolved].sort((a, b) => b.days - a.days)[0];
      return {
        sourceType: sourceTypeOf(resolved),
        summary: `compared ${resolved.map((p) => p.id).join(' vs ')}`,
        result: {
          notice: DEMO_NOTICE,
          rows,
          cheapestPerPerson: cheapest ? { id: cheapest.id, amount: cheapest.price.amount, currency: cheapest.price.currency } : null,
          longest: longest ? { id: longest.id, days: longest.days } : null,
          sameCurrency,
        },
      };
    },
  });

  const departures = defineTool({
    name: 'check_company_departures',
    description:
      'Check stored departure dates and seat availability for one company package (from today onward unless a range is given). If none are stored, availability is unknown/on request; never state seats are available.',
    inputSchema: z.object({
      package: z.string().min(1).max(120),
      startDate: isoDate.optional().describe('Defaults to today (Africa/Cairo).'),
      endDate: isoDate.optional(),
    }),
    sideEffect: 'read',
    execute: async (input, ctx) => {
      const p = await resolveOne(repo, input.package);
      const rows = await repo.departures(p.id, input.startDate ?? localDate(ctx.now), input.endDate);
      const departuresView = rows.map((d) => ({
        ...d,
        verificationStale: d.verifiedAt === null || ctx.now.getTime() - Date.parse(d.verifiedAt) > STALE_VERIFICATION_MS,
      }));
      return {
        sourceType: p.sourceType,
        summary: `${rows.length} departure row(s) for ${p.id}`,
        result: {
          package: { id: p.id, nameAr: p.nameAr, status: p.status, bookingEnabled: p.bookingEnabled },
          departures: departuresView,
          availability: rows.length > 0 ? 'see_departures' : 'no_confirmed_departures',
          note:
            rows.length > 0
              ? 'Report seats exactly as stored with verifiedAt; if verificationStale is true, say availability must be reconfirmed.'
              : `No departure dates or seat counts are stored for this package (status: ${p.status}). Availability is on request and unconfirmed. Online booking is not supported.`,
        },
      };
    },
  });

  return [listDestinations, searchPackages, getDetails, compare, departures];
}
