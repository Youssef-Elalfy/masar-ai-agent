import { createHash } from 'node:crypto';
import { z } from 'zod';
import { zIso, zNum, type Sql } from '../db/sql.ts';
import type { ConsentStore } from '../memory/consent-store.ts';
import { redactText } from '../observability/redact.ts';
import type { PiiCipher } from '../security/pii-crypto.ts';
import { normalizeForSearch } from '../text/normalize.ts';
import { maskEmail, maskName, maskPhone, normalizePhone } from './contact.ts';

export interface LeadInput {
  name: string;
  phone: string;
  email?: string | undefined;
  destination?: string | undefined;
  dateRange?: string | undefined;
  budgetAmount?: number | undefined;
  budgetCurrency?: string | undefined;
  adults?: number | undefined;
  children?: number | undefined;
  notes?: string | undefined;
}

export interface QuoteInput {
  leadId?: string | undefined;
  packageId?: string | undefined;
  /** For trips outside the catalog: the destination (used to recognize repeats). */
  destination?: string | undefined;
  summary: string;
}

export interface HandoffInput {
  reason: string;
  summary: string;
  leadId?: string | undefined;
}

export class CrmError extends Error {
  readonly code: 'NOT_CONFIGURED' | 'INVALID_CONTACT' | 'NEEDS_LEAD' | 'NOT_FOUND';
  constructor(code: CrmError['code'], message: string) {
    super(message);
    this.name = 'CrmError';
    this.code = code;
  }
}

export interface StoredRecord {
  id: string;
  reference: string;
  status: string;
  createdAt: string;
  created: boolean;
}

/** Short human reference for a record id (shown to the customer). */
export function reference(prefix: 'RL' | 'RQ' | 'RH', id: string): string {
  return `${prefix}-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

function hashOf(parts: Array<string | number | null | undefined>): string {
  return createHash('sha256').update(JSON.stringify(parts.map((p) => (typeof p === 'string' ? normalizeForSearch(p) : p ?? null)))).digest('hex');
}

const MAX_NOTES = 500;
const MAX_SUMMARY = 1000;
const HANDOFF_DEDUPE_HOURS = 24;

const RecordRow = z.object({ id: z.string(), status: z.string(), created_at: zIso });

/**
 * Demo CRM backed by Supabase: leads (encrypted contact fields), quote requests and human-handoff
 * requests. Callers (tools) run only after the customer approved the exact action; that approval is
 * recorded as consent. Nothing here books, charges, or contacts anyone.
 */
export class CrmService {
  private readonly sql: Sql;
  private readonly consents: ConsentStore;
  private readonly cipher: PiiCipher | null;

  constructor(sql: Sql, consents: ConsentStore, cipher: PiiCipher | null) {
    this.sql = sql;
    this.consents = consents;
    this.cipher = cipher;
  }

  get enabled(): boolean {
    return this.cipher !== null;
  }

  private requireCipher(): PiiCipher {
    if (!this.cipher) throw new CrmError('NOT_CONFIGURED', 'Lead storage is not configured (PII_ENCRYPTION_KEY missing).');
    return this.cipher;
  }

  /** Validates/normalizes contact data; throws INVALID_CONTACT with a user-safe message. */
  normalizeLead(input: LeadInput): LeadInput & { phone: string } {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new CrmError('INVALID_CONTACT', 'The phone number does not look valid. Ask the customer to re-check it (Egyptian mobiles: 01xxxxxxxxx).');
    const name = input.name.trim();
    if (name.length < 2) throw new CrmError('INVALID_CONTACT', 'A name is needed for the request.');
    return { ...input, name, phone, email: input.email?.trim().toLowerCase(), notes: input.notes ? redactText(input.notes).slice(0, MAX_NOTES) : undefined };
  }

  /** Masked view shown in the approval prompt (enough to recognize, not to reuse). */
  leadPreview(input: LeadInput): Record<string, unknown> {
    let phone = '(invalid)';
    try {
      phone = maskPhone(this.normalizeLead(input).phone);
    } catch {
      // keep "(invalid)"; the tool will reject it
    }
    return {
      purpose: 'Save your contact details as a quote/lead request in the DEMO company CRM (no booking, no payment).',
      name: maskName(input.name),
      phone,
      ...(input.email ? { email: maskEmail(input.email) } : {}),
      ...(input.destination ? { destination: input.destination } : {}),
      ...(input.dateRange ? { dates: input.dateRange } : {}),
      ...(input.budgetAmount !== undefined ? { budget: `${input.budgetAmount} ${input.budgetCurrency ?? ''}`.trim() } : {}),
      ...(input.adults !== undefined ? { adults: input.adults } : {}),
      ...(input.children !== undefined ? { children: input.children } : {}),
    };
  }

  /**
   * One lead per customer contact: keyed on the normalized phone only, so a reworded request (model paraphrase,
   * "ديسمبر" vs "December") is recognized as the same lead. Further trips become additional quote requests.
   */
  private leadKey(input: LeadInput & { phone: string }): string {
    return hashOf(['lead', input.phone]);
  }

  async findLead(ownerId: string, input: LeadInput): Promise<StoredRecord | null> {
    let normalized;
    try {
      normalized = this.normalizeLead(input);
    } catch {
      return null;
    }
    const rows = await this.sql.query('select id, status, created_at from public.leads where owner_id = $1 and idempotency_key = $2', [ownerId, this.leadKey(normalized)]);
    const row = rows[0];
    if (!row) return null;
    const r = RecordRow.parse(row);
    return { id: r.id, reference: reference('RL', r.id), status: r.status, createdAt: r.created_at, created: false };
  }

  async createLead(ownerId: string, input: LeadInput, ctx: { conversationId: string; approvalId: string | null }): Promise<StoredRecord> {
    const cipher = this.requireCipher();
    const lead = this.normalizeLead(input);
    const key = this.leadKey(lead);
    // The customer's approval of this exact action is the consent; it is recorded with its evidence.
    const consent = await this.consents.grant(ownerId, 'lead_creation', { conversationId: ctx.conversationId });
    const inserted = await this.sql.query(
      `insert into public.leads (owner_id, consent_id, approval_id, idempotency_key, contact_name, contact_phone, contact_email, destination, date_range,
         budget_amount, budget_currency, party_adults, party_children, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (owner_id, idempotency_key) do nothing
       returning id, status, created_at`,
      [ownerId, consent.id, ctx.approvalId, key, cipher.encrypt(lead.name), cipher.encrypt(lead.phone), lead.email ? cipher.encrypt(lead.email) : null,
        lead.destination ?? null, lead.dateRange ?? null, lead.budgetAmount ?? null, lead.budgetCurrency?.toUpperCase() ?? null, lead.adults ?? null,
        lead.children ?? null, lead.notes ?? null],
    );
    const row = inserted[0];
    if (row) {
      const r = RecordRow.parse(row);
      return { id: r.id, reference: reference('RL', r.id), status: r.status, createdAt: r.created_at, created: true };
    }
    const existing = await this.findLead(ownerId, input);
    if (!existing) throw new Error('Lead was neither inserted nor found.');
    return existing;
  }

  private async resolveLead(ownerId: string, leadId: string | undefined): Promise<string> {
    const rows = leadId
      ? await this.sql.query('select id from public.leads where owner_id = $1 and id::text = $2', [ownerId, leadId])
      : await this.sql.query('select id from public.leads where owner_id = $1 order by created_at desc limit 1', [ownerId]);
    const id = rows[0]?.['id'];
    if (typeof id !== 'string') {
      throw new CrmError('NEEDS_LEAD', leadId ? 'That lead does not exist for this customer.' : 'Create a lead (create_lead) with the customer\'s approval first.');
    }
    return id;
  }

  /** Same lead + same catalog package (or same destination for custom trips) = same quote; free-text wording is ignored. */
  private quoteKey(leadId: string, input: QuoteInput): string {
    const subject = input.packageId ? `pkg:${input.packageId}` : input.destination ? `dest:${normalizeForSearch(input.destination)}` : `text:${input.summary}`;
    return hashOf(['quote', leadId, subject]);
  }

  async findQuote(ownerId: string, input: QuoteInput): Promise<StoredRecord | null> {
    let leadId: string;
    try {
      leadId = await this.resolveLead(ownerId, input.leadId);
    } catch {
      return null;
    }
    const rows = await this.sql.query('select id, status, created_at from public.quote_requests where owner_id = $1 and idempotency_key = $2', [ownerId, this.quoteKey(leadId, input)]);
    const row = rows[0];
    if (!row) return null;
    const r = RecordRow.parse(row);
    return { id: r.id, reference: reference('RQ', r.id), status: r.status, createdAt: r.created_at, created: false };
  }

  async createQuoteRequest(ownerId: string, input: QuoteInput, ctx: { approvalId: string | null }): Promise<StoredRecord> {
    this.requireCipher();
    const leadId = await this.resolveLead(ownerId, input.leadId);
    if (input.packageId) {
      const pkg = await this.sql.query('select 1 from public.packages where id = $1 and active', [input.packageId]);
      if (pkg.length === 0) throw new CrmError('NOT_FOUND', `Company package "${input.packageId}" does not exist; leave packageId empty for destinations outside the catalog.`);
    }
    const inserted = await this.sql.query(
      `insert into public.quote_requests (owner_id, lead_id, package_id, approval_id, idempotency_key, summary)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (owner_id, idempotency_key) do nothing returning id, status, created_at`,
      [ownerId, leadId, input.packageId ?? null, ctx.approvalId, this.quoteKey(leadId, input), redactText(input.summary).slice(0, MAX_SUMMARY)],
    );
    const row = inserted[0];
    if (row) {
      const r = RecordRow.parse(row);
      return { id: r.id, reference: reference('RQ', r.id), status: r.status, createdAt: r.created_at, created: true };
    }
    const existing = await this.findQuote(ownerId, input);
    if (!existing) throw new Error('Quote request was neither inserted nor found.');
    return existing;
  }

  async findOpenHandoff(ownerId: string, input: HandoffInput): Promise<StoredRecord | null> {
    const rows = await this.sql.query(
      `select id, status, created_at from public.handoff_requests
       where owner_id = $1 and status = 'open' and reason = $2 and created_at > now() - make_interval(hours => $3) order by created_at desc limit 1`,
      [ownerId, input.reason.trim().slice(0, 200), HANDOFF_DEDUPE_HOURS],
    );
    const row = rows[0];
    if (!row) return null;
    const r = RecordRow.parse(row);
    return { id: r.id, reference: reference('RH', r.id), status: r.status, createdAt: r.created_at, created: false };
  }

  async requestHandoff(ownerId: string, input: HandoffInput, ctx: { conversationId: string; approvalId: string | null }): Promise<StoredRecord> {
    this.requireCipher();
    const existing = await this.findOpenHandoff(ownerId, input);
    if (existing) return existing;
    const leadId = input.leadId ? await this.resolveLead(ownerId, input.leadId) : null;
    await this.consents.grant(ownerId, 'human_handoff', { conversationId: ctx.conversationId });
    const [row] = await this.sql.query(
      `insert into public.handoff_requests (owner_id, lead_id, approval_id, reason, summary) values ($1, $2, $3, $4, $5) returning id, status, created_at`,
      [ownerId, leadId, ctx.approvalId, input.reason.trim().slice(0, 200), redactText(input.summary).slice(0, MAX_SUMMARY)],
    );
    const r = RecordRow.parse(row);
    return { id: r.id, reference: reference('RH', r.id), status: r.status, createdAt: r.created_at, created: true };
  }

  /** What the customer can see about themselves (masked). */
  async listForOwner(ownerId: string): Promise<Array<{ kind: 'lead' | 'quote' | 'handoff'; reference: string; status: string; createdAt: string; detail: string }>> {
    const out: Array<{ kind: 'lead' | 'quote' | 'handoff'; reference: string; status: string; createdAt: string; detail: string }> = [];
    for (const r of await this.sql.query('select id, status, created_at, contact_phone, destination, date_range from public.leads where owner_id = $1 order by created_at', [ownerId])) {
      const row = RecordRow.extend({ contact_phone: z.string().nullable(), destination: z.string().nullable(), date_range: z.string().nullable() }).parse(r);
      let phone = '••••';
      try {
        if (this.cipher && row.contact_phone) phone = maskPhone(this.cipher.decrypt(row.contact_phone));
      } catch {
        phone = '(unreadable with current key)';
      }
      out.push({ kind: 'lead', reference: reference('RL', row.id), status: row.status, createdAt: row.created_at, detail: `${phone} · ${row.destination ?? '-'} · ${row.date_range ?? '-'}` });
    }
    for (const r of await this.sql.query('select id, status, created_at, package_id, summary from public.quote_requests where owner_id = $1 order by created_at', [ownerId])) {
      const row = RecordRow.extend({ package_id: z.string().nullable(), summary: z.string() }).parse(r);
      out.push({ kind: 'quote', reference: reference('RQ', row.id), status: row.status, createdAt: row.created_at, detail: `${row.package_id ?? 'custom'} · ${row.summary.slice(0, 80)}` });
    }
    for (const r of await this.sql.query('select id, status, created_at, reason from public.handoff_requests where owner_id = $1 order by created_at', [ownerId])) {
      const row = RecordRow.extend({ reason: z.string() }).parse(r);
      out.push({ kind: 'handoff', reference: reference('RH', row.id), status: row.status, createdAt: row.created_at, detail: row.reason });
    }
    return out;
  }

  /** Deletes the customer's CRM records and withdraws the related consents. */
  async deleteForOwner(ownerId: string): Promise<{ leads: number; quotes: number; handoffs: number }> {
    return this.sql.transaction(async (tx) => {
      const handoffs = (await tx.query('delete from public.handoff_requests where owner_id = $1 returning id', [ownerId])).length;
      const quotes = (await tx.query('delete from public.quote_requests where owner_id = $1 returning id', [ownerId])).length;
      const leads = (await tx.query('delete from public.leads where owner_id = $1 returning id', [ownerId])).length;
      await tx.query("update public.consents set revoked_at = now() where owner_id = $1 and purpose in ('lead_creation', 'human_handoff', 'contact_storage') and revoked_at is null", [ownerId]);
      return { leads, quotes, handoffs };
    });
  }

  /** Staff view for the demo (all owners). Contact fields decrypted only when reveal=true. */
  async staffList(reveal: boolean): Promise<Array<Record<string, unknown>>> {
    const cipher = this.requireCipher();
    const rows = await this.sql.query(
      `select l.id, l.owner_id, l.status, l.created_at, l.contact_name, l.contact_phone, l.contact_email, l.destination, l.date_range,
              l.budget_amount, l.budget_currency, l.party_adults, l.party_children,
              (select count(*)::int from public.quote_requests q where q.lead_id = l.id) as quotes
       from public.leads l order by l.created_at desc limit 100`,
    );
    return rows.map((r) => {
      const row = RecordRow.extend({
        owner_id: z.string(), contact_name: z.string().nullable(), contact_phone: z.string().nullable(), contact_email: z.string().nullable(),
        destination: z.string().nullable(), date_range: z.string().nullable(), budget_amount: zNum.nullable(), budget_currency: z.string().nullable(),
        party_adults: zNum.nullable(), party_children: zNum.nullable(), quotes: zNum,
      }).parse(r);
      const dec = (v: string | null, mask: (s: string) => string) => {
        if (!v) return null;
        try {
          const plain = cipher.decrypt(v);
          return reveal ? plain : mask(plain);
        } catch {
          return '(unreadable with current key)';
        }
      };
      return {
        reference: reference('RL', row.id), status: row.status, createdAt: row.created_at, name: dec(row.contact_name, maskName), phone: dec(row.contact_phone, maskPhone),
        email: dec(row.contact_email, maskEmail), destination: row.destination, dates: row.date_range,
        budget: row.budget_amount === null ? null : `${row.budget_amount} ${row.budget_currency?.trim() ?? ''}`.trim(),
        party: `${row.party_adults ?? '?'} adult(s), ${row.party_children ?? 0} child(ren)`, quotes: row.quotes,
      };
    });
  }
}
