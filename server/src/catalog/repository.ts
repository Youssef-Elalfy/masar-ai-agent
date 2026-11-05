import { z } from 'zod';
import { zIso, zIsoNullable, zNum, zStringList, type Sql } from '../db/sql.ts';
import { buildSearchText, queryTokens, tokenMatches } from '../text/normalize.ts';
import { PackageInputSchema, type CompanyPackage, type Departure, type PackageFilters, type PackageInput } from './types.ts';

const PackageRow = z.object({
  id: z.string(),
  slug: z.string(),
  destination: z.string(),
  destination_ar: z.string().nullable(),
  country: z.string(),
  trip_type: z.string(),
  name_en: z.string().nullable(),
  name_ar: z.string(),
  days: zNum,
  nights: zNum,
  price_amount: zNum,
  price_currency: z.string(),
  price_basis: z.string(),
  departure_city: z.string().nullable(),
  source_type: z.enum(['company_demo', 'company_verified']),
  status: z.string(),
  booking_enabled: z.boolean(),
  inclusions: zStringList,
  exclusions: zStringList,
  itinerary: zStringList,
  tags: zStringList,
  disclaimer: z.string(),
  search_text: z.string(),
  updated_at: zIso,
});

const DepartureRow = z.object({
  id: z.string(),
  package_id: z.string(),
  departure_date: z.string(),
  origin: z.string().nullable(),
  availability_status: z.string(),
  seats_remaining: zNum.nullable(),
  verified_at: zIsoNullable,
  provider: z.string().nullable(),
});

type ParsedRow = z.infer<typeof PackageRow>;

function toPackage(r: ParsedRow): CompanyPackage {
  return {
    id: r.id,
    slug: r.slug,
    destination: r.destination,
    destinationAr: r.destination_ar,
    country: r.country,
    tripType: r.trip_type,
    nameEn: r.name_en,
    nameAr: r.name_ar,
    days: r.days,
    nights: r.nights,
    price: { amount: r.price_amount, currency: r.price_currency.trim(), basis: r.price_basis },
    departureCity: r.departure_city,
    sourceType: r.source_type,
    status: r.status,
    bookingEnabled: r.booking_enabled,
    inclusions: r.inclusions,
    exclusions: r.exclusions,
    itinerary: r.itinerary,
    tags: r.tags,
    disclaimer: r.disclaimer,
    updatedAt: r.updated_at,
  };
}

const PACKAGE_COLUMNS = `id, slug, destination, destination_ar, country, trip_type, name_en, name_ar, days, nights, price_amount,
  price_currency, price_basis, departure_city, source_type, status, booking_enabled, inclusions, exclusions, itinerary, tags,
  disclaimer, search_text, updated_at`;

/** Company catalog, scoped to one organization. Structured rows are the only source of company prices. */
export class CatalogRepository {
  private readonly sql: Sql;
  readonly organizationId: string;

  constructor(sql: Sql, organizationId: string) {
    this.sql = sql;
    this.organizationId = organizationId;
  }

  static async ensureOrganization(sql: Sql, org: { id: string; name: string; nameAr: string | null; demo: boolean }): Promise<void> {
    await sql.query(
      `insert into public.organizations (id, name, name_ar, demo_flag) values ($1, $2, $3, $4)
       on conflict (id) do update set name = excluded.name, name_ar = excluded.name_ar, demo_flag = excluded.demo_flag`,
      [org.id, org.name, org.nameAr, org.demo],
    );
  }

  /** Validates and upserts one package row. A new destination needs no code or prompt change. */
  async upsertPackage(input: PackageInput): Promise<CompanyPackage> {
    const p = PackageInputSchema.parse(input);
    if (p.nights > p.days) throw new Error(`Package ${p.id}: nights (${p.nights}) cannot exceed days (${p.days}).`);
    const searchText = buildSearchText(
      [p.id, p.slug, p.destination, p.destination_ar, p.country, p.type, p.name_en, p.name_ar, ...p.tags].filter((v): v is string => typeof v === 'string'),
    );
    await this.sql.query(
      `insert into public.packages (id, organization_id, slug, destination, destination_ar, country, trip_type, name_en, name_ar,
         days, nights, price_amount, price_currency, price_basis, departure_city, source_type, status, booking_enabled,
         inclusions, exclusions, itinerary, tags, disclaimer, search_text, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb, $23, $24, now())
       on conflict (id) do update set slug = excluded.slug, destination = excluded.destination, destination_ar = excluded.destination_ar,
         country = excluded.country, trip_type = excluded.trip_type, name_en = excluded.name_en, name_ar = excluded.name_ar,
         days = excluded.days, nights = excluded.nights, price_amount = excluded.price_amount, price_currency = excluded.price_currency,
         price_basis = excluded.price_basis, departure_city = excluded.departure_city, source_type = excluded.source_type,
         status = excluded.status, booking_enabled = excluded.booking_enabled, inclusions = excluded.inclusions,
         exclusions = excluded.exclusions, itinerary = excluded.itinerary, tags = excluded.tags, disclaimer = excluded.disclaimer,
         search_text = excluded.search_text, updated_at = now()
       where public.packages.organization_id = excluded.organization_id`,
      [
        p.id, this.organizationId, p.slug, p.destination, p.destination_ar, p.country, p.type, p.name_en, p.name_ar,
        p.days, p.nights, p.price_per_person, p.currency, p.pricing_basis, p.departure_city, p.source_type, p.status,
        p.booking_enabled, JSON.stringify(p.included_ar), JSON.stringify(p.excluded_ar), JSON.stringify(p.itinerary_ar),
        JSON.stringify(p.tags), p.disclaimer_ar, searchText,
      ],
    );
    const saved = await this.getById(p.id);
    if (!saved) throw new Error(`Package ${p.id} was not persisted (it may belong to another organization).`);
    return saved;
  }

  async getById(id: string): Promise<CompanyPackage | null> {
    const rows = await this.sql.query(
      `select ${PACKAGE_COLUMNS} from public.packages where id = $1 and organization_id = $2 and active`,
      [id, this.organizationId],
    );
    const row = rows[0];
    return row ? toPackage(PackageRow.parse(row)) : null;
  }

  /** Resolves a model-supplied reference (id, slug or destination/name text). Several results = ambiguous. */
  async resolve(reference: string): Promise<CompanyPackage[]> {
    const rows = await this.sql.query(
      `select ${PACKAGE_COLUMNS} from public.packages where organization_id = $1 and active and (id = $2 or slug = $2)`,
      [this.organizationId, reference],
    );
    const direct = rows[0];
    if (direct) return [toPackage(PackageRow.parse(direct))];
    return this.search({ text: reference });
  }

  async search(filters: PackageFilters = {}): Promise<CompanyPackage[]> {
    const where = ['organization_id = $1', 'active'];
    const params: unknown[] = [this.organizationId];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (filters.tripType) add('lower(trip_type) = lower(?)', filters.tripType);
    if (filters.country) add('lower(country) = lower(?)', filters.country);
    if (filters.currency) add('price_currency = upper(?)', filters.currency);
    if (filters.maxPricePerPerson !== undefined) add('price_amount <= ?', filters.maxPricePerPerson);
    if (filters.minDays !== undefined) add('days >= ?', filters.minDays);
    if (filters.maxDays !== undefined) add('days <= ?', filters.maxDays);
    const order = {
      price_asc: 'price_amount asc',
      price_desc: 'price_amount desc',
      days_asc: 'days asc, price_amount asc',
      days_desc: 'days desc, price_amount asc',
    }[filters.sortBy ?? 'price_asc'];

    const rows = (await this.sql.query(`select ${PACKAGE_COLUMNS} from public.packages where ${where.join(' and ')} order by ${order}, id`, params))
      .map((r) => PackageRow.parse(r));

    let result = rows;
    const tokens = filters.text ? queryTokens(filters.text) : [];
    if (filters.text && tokens.length === 0) result = [];
    if (tokens.length > 0) {
      // Keep the rows matching the most tokens ("Hurghada beach" → Hurghada, not every beach package), plus any row
      // matching a token none of those rows cover, so a multi-destination query ("الغردقة شرم الشيخ") keeps every
      // destination the customer named instead of silently dropping one.
      const scored = rows.map((row) => {
        const matched = tokens.filter((t) => tokenMatches(row.search_text, t));
        return { row, matched, score: matched.length };
      });
      const best = Math.max(0, ...scored.map((s) => s.score));
      if (best === 0) {
        result = [];
      } else {
        const covered = new Set(scored.filter((s) => s.score === best).flatMap((s) => s.matched));
        result = scored.filter((s) => s.score === best || (s.score > 0 && s.matched.some((t) => !covered.has(t)))).map((s) => s.row);
      }
    }
    return result.slice(0, filters.limit ?? 50).map(toPackage);
  }

  async listDestinations(): Promise<Array<{ destination: string; destinationAr: string | null; country: string; packageCount: number }>> {
    const rows = await this.sql.query(
      `select destination, destination_ar, country, count(*)::int as package_count from public.packages
       where organization_id = $1 and active group by destination, destination_ar, country order by country, destination`,
      [this.organizationId],
    );
    return rows.map((r) => {
      const p = z.object({ destination: z.string(), destination_ar: z.string().nullable(), country: z.string(), package_count: zNum }).parse(r);
      return { destination: p.destination, destinationAr: p.destination_ar, country: p.country, packageCount: p.package_count };
    });
  }

  async departures(packageId: string, startDate?: string, endDate?: string): Promise<Departure[]> {
    const where = ['d.package_id = $1', 'p.organization_id = $2'];
    const params: unknown[] = [packageId, this.organizationId];
    if (startDate) { params.push(startDate); where.push(`d.departure_date >= $${params.length}::date`); }
    if (endDate) { params.push(endDate); where.push(`d.departure_date <= $${params.length}::date`); }
    const rows = await this.sql.query(
      `select d.id, d.package_id, d.departure_date::text as departure_date, d.origin, d.availability_status, d.seats_remaining,
              d.verified_at, d.provider
       from public.package_departures d join public.packages p on p.id = d.package_id
       where ${where.join(' and ')} order by d.departure_date`,
      params,
    );
    return rows.map((r) => {
      const d = DepartureRow.parse(r);
      return {
        id: d.id, packageId: d.package_id, departureDate: d.departure_date, origin: d.origin, availabilityStatus: d.availability_status,
        seatsRemaining: d.seats_remaining, verifiedAt: d.verified_at, provider: d.provider,
      };
    });
  }
}
