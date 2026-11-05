import { z } from 'zod';
import type { ChatMessage } from '../agent/providers/types.ts';
import { RUNTIME_NOTE_PREFIX } from '../agent/style.ts';
import type { Activity, ApprovalView, Card, CompanyPackageCard, ConversationView, TranscriptItem } from './contracts.ts';

/**
 * Builds the customer-facing view of a stored conversation. Cards come only from successful tool
 * results that are already in the transcript (no new lookups, so re-rendering never re-runs a search).
 */

const Price = z.object({ amount: z.number(), currency: z.string(), basis: z.string() });
const Pricing = z.looseObject({ perPerson: z.number(), currency: z.string(), basis: z.string(), totalForParty: z.number().nullable().optional(), totalNote: z.string().optional() });
const PackageSummary = z.looseObject({
  id: z.string(), nameAr: z.string(), nameEn: z.string().nullable(), destination: z.string(), destinationAr: z.string().nullable().optional(),
  tripType: z.string().nullable().optional(), days: z.number(), nights: z.number(), departureCity: z.string().nullable().optional(), sourceType: z.string(),
});
const SearchResult = z.looseObject({ packages: z.array(PackageSummary.extend({ pricing: Pricing })) });
const DetailsResult = z.looseObject({ package: PackageSummary.extend({ price: Price, inclusions: z.array(z.string()), exclusions: z.array(z.string()) }) });
const CompareResult = z.looseObject({
  rows: z.array(PackageSummary.extend({ position: z.number(), pricing: Pricing })),
  cheapestPerPerson: z.looseObject({ id: z.string() }).nullable(),
  sameCurrency: z.boolean(),
});
const Offer = z.looseObject({
  id: z.string(), provider: z.string(), provider_url: z.string().nullable(), title: z.string().nullable(), destination: z.string(),
  days: z.number().nullable(), nights: z.number().nullable(), price_amount: z.number().nullable(), price_currency: z.string().nullable(),
  price_basis: z.string().nullable(), status: z.string(), retrieved_at: z.string(),
  evidence: z.looseObject({
    pricesFound: z.array(z.looseObject({ amount: z.number(), currency: z.string(), text: z.string() })),
    listingType: z.enum(['package_or_tour', 'flight_fare']),
    priceNote: z.string().nullable(),
  }),
});
const ResearchResult = z.looseObject({ status: z.string(), provider: z.string().nullable().optional(), retrievedAt: z.string(), offers: z.array(Offer) });
const CrmResult = z.looseObject({ status: z.enum(['created', 'already_exists']), reference: z.string() });
const Payload = z.looseObject({ ok: z.boolean(), result: z.unknown().optional() });

/** Search criteria shown as "Journey context" (from the agent's own search calls, so it has provenance). */
const FILTER_KEYS: Record<string, readonly string[]> = {
  search_company_packages: ['query', 'tripType', 'maxPricePerPerson', 'minDays', 'maxDays', 'adults', 'children', 'totalBudget', 'budgetCurrency'],
  research_external_packages: ['destination', 'days', 'dateRange', 'departureCity', 'maxBudget', 'currency', 'travelers'],
};

export function searchFilters(toolName: string, input: unknown): Record<string, string | number> | null {
  const keys = FILTER_KEYS[toolName];
  if (!keys || input === null || typeof input !== 'object') return null;
  const out: Record<string, string | number> = {};
  for (const key of keys) {
    const value: unknown = (input as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, 80);
  }
  return Object.keys(out).length > 0 ? out : null;
}

const CRM_TOOLS: Record<string, 'lead' | 'quote' | 'handoff'> = { create_lead: 'lead', create_quote_request: 'quote', request_human_handoff: 'handoff' };

function packageCard(p: z.infer<typeof PackageSummary>, price: z.infer<typeof Price>): CompanyPackageCard {
  return {
    kind: 'company_package', id: p.id, nameAr: p.nameAr, nameEn: p.nameEn, destination: p.destination, destinationAr: p.destinationAr ?? null,
    days: p.days, nights: p.nights, tripType: p.tripType ?? null, departureCity: p.departureCity ?? null, sourceType: p.sourceType,
    price, partyTotal: null, inclusions: [], exclusions: [],
  };
}

/** Cards for one successful tool result; unknown tools or unexpected shapes produce none. */
export function cardsFor(toolName: string, content: string): Card[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const payload = Payload.safeParse(parsed);
  if (!payload.success || !payload.data.ok) return [];
  const result = payload.data.result;
  switch (toolName) {
    case 'search_company_packages': {
      const r = SearchResult.safeParse(result);
      if (!r.success) return [];
      return r.data.packages.map((p) => ({
        ...packageCard(p, { amount: p.pricing.perPerson, currency: p.pricing.currency, basis: p.pricing.basis }),
        partyTotal: p.pricing.totalNote !== undefined && p.pricing.totalForParty !== undefined
          ? { amount: p.pricing.totalForParty ?? null, note: p.pricing.totalNote }
          : null,
      }));
    }
    case 'get_package_details': {
      const r = DetailsResult.safeParse(result);
      if (!r.success) return [];
      const p = r.data.package;
      return [{ ...packageCard(p, p.price), inclusions: p.inclusions, exclusions: p.exclusions }];
    }
    case 'compare_company_packages': {
      const r = CompareResult.safeParse(result);
      if (!r.success) return [];
      return [{
        kind: 'comparison', sameCurrency: r.data.sameCurrency, cheapestId: r.data.cheapestPerPerson?.id ?? null,
        rows: r.data.rows.map((row) => ({
          position: row.position, id: row.id, nameAr: row.nameAr, nameEn: row.nameEn, days: row.days, nights: row.nights,
          price: { amount: row.pricing.perPerson, currency: row.pricing.currency }, partyTotal: row.pricing.totalForParty ?? null,
        })),
      }];
    }
    case 'research_external_packages': {
      const r = ResearchResult.safeParse(result);
      if (!r.success) return [];
      const notice: Card = { kind: 'research_notice', status: r.data.status, provider: r.data.provider ?? null, retrievedAt: r.data.retrievedAt, resultCount: r.data.offers.length };
      return [notice, ...r.data.offers.map((o): Card => ({
        kind: 'external_offer', id: o.id, provider: o.provider,
        // Only https links reach the client (the extractor already enforces this; checked again here).
        url: o.provider_url !== null && /^https:\/\//i.test(o.provider_url) ? o.provider_url : null,
        title: o.title, destination: o.destination, days: o.days, nights: o.nights,
        price: o.price_amount !== null && o.price_currency !== null ? { amount: o.price_amount, currency: o.price_currency, basis: o.price_basis } : null,
        pricesFound: o.evidence.pricesFound.map((p) => ({ amount: p.amount, currency: p.currency, text: p.text })),
        priceNote: o.evidence.priceNote, listingType: o.evidence.listingType, status: o.status, retrievedAt: o.retrieved_at,
      }))];
    }
    default: {
      const record = CRM_TOOLS[toolName];
      if (!record) return [];
      const r = CrmResult.safeParse(result);
      return r.success ? [{ kind: 'crm_record', record, reference: r.data.reference, created: r.data.status === 'created' }] : [];
    }
  }
}

/** Package cards for the same id within one answer are merged (details add inclusions to a search hit). */
function mergeCards(cards: Card[]): Card[] {
  const out: Card[] = [];
  const packages = new Map<string, CompanyPackageCard>();
  for (const card of cards) {
    if (card.kind !== 'company_package') {
      out.push(card);
      continue;
    }
    const prev = packages.get(card.id);
    if (!prev) {
      packages.set(card.id, card);
      out.push(card);
      continue;
    }
    const merged: CompanyPackageCard = {
      ...prev, ...card,
      partyTotal: card.partyTotal ?? prev.partyTotal,
      inclusions: card.inclusions.length > 0 ? card.inclusions : prev.inclusions,
      exclusions: card.exclusions.length > 0 ? card.exclusions : prev.exclusions,
    };
    packages.set(card.id, merged);
    out[out.indexOf(prev)] = merged;
  }
  return out;
}

interface Draft {
  id: string;
  segments: string[];
  activity: Array<Activity & { callId: string }>;
  cards: Card[];
}

export function buildTranscript(history: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let draft: Draft | null = null;
  const callNames = new Map<string, string>();
  const flush = () => {
    if (draft) {
      items.push({
        role: 'assistant', id: draft.id, text: draft.segments.join('\n\n').trim(),
        activity: draft.activity.map(({ toolName, outcome, errorCode, filters }) => ({ toolName, outcome, errorCode, filters })),
        cards: mergeCards(draft.cards),
      });
    }
    draft = null;
  };

  history.forEach((message, index) => {
    if (message.role === 'user') {
      for (const block of message.content) {
        if (block.type === 'text') {
          if (block.text.startsWith(RUNTIME_NOTE_PREFIX)) {
            // The draft before a runtime note was held back (grounding or style guard) and never shown to the customer.
            draft?.segments.pop();
            continue;
          }
          flush();
          items.push({ role: 'user', id: `m${index}`, text: block.text });
        } else if (block.type === 'tool_result' && draft) {
          const entry = draft.activity.find((a) => a.callId === block.toolCallId);
          if (entry) {
            const code = block.isError ? (/"code"\s*:\s*"([A-Z_]+)"/.exec(block.content)?.[1] ?? 'TOOL_ERROR') : null;
            // A write waiting for the customer's approval is not a failure: it is pending their decision.
            entry.outcome = !block.isError ? 'ok' : code === 'APPROVAL_REQUIRED' ? 'pending' : 'error';
            entry.errorCode = code === 'APPROVAL_REQUIRED' ? null : code;
          }
          const name = callNames.get(block.toolCallId);
          if (name && !block.isError) draft.cards.push(...cardsFor(name, block.content));
        }
      }
      return;
    }
    draft ??= { id: `m${index}`, segments: [], activity: [], cards: [] };
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) draft.segments.push(block.text);
      if (block.type === 'tool_call') {
        callNames.set(block.id, block.name);
        draft.activity.push({ callId: block.id, toolName: block.name, outcome: 'pending', errorCode: null, filters: searchFilters(block.name, block.input) });
      }
    }
  });
  flush();
  return items;
}

export function buildConversationView(id: string, history: ChatMessage[], pendingApprovals: ApprovalView[]): ConversationView {
  return { id, items: buildTranscript(history), pendingApprovals };
}
