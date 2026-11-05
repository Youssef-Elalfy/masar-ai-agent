import { z } from 'zod';
import { CrmError, type CrmService, type StoredRecord } from '../crm/crm-service.ts';
import { defineTool, ToolError, type RegisteredTool, type ToolOutput } from './registry.ts';

const DEMO_CRM_NOTE =
  'Stored in the DEMO company CRM only: the MASAR AI demo company is fictional, so no real staff member will call, and nothing is booked, reserved or paid. Tell the customer this plainly, give them the reference, and mention they can view or delete it with /leads.';

function toToolError(err: unknown): never {
  if (err instanceof CrmError) {
    throw new ToolError(err.code === 'INVALID_CONTACT' ? 'VALIDATION_ERROR' : err.code === 'NOT_FOUND' || err.code === 'NEEDS_LEAD' ? 'NOT_FOUND' : 'NOT_ALLOWED', err.message);
  }
  throw err;
}

function stored(kind: string, r: StoredRecord): ToolOutput {
  return {
    sourceType: 'system',
    summary: `${kind} ${r.created ? 'created' : 'already existed'} ${r.reference}`,
    result: { status: r.created ? 'created' : 'already_exists', reference: r.reference, id: r.id, recordStatus: r.status, createdAt: r.createdAt, note: DEMO_CRM_NOTE },
  };
}

const LeadSchema = z.object({
  name: z.string().min(2).max(80).describe('Customer name as they gave it.'),
  phone: z.string().min(6).max(25).describe('Phone as the customer gave it (Egyptian mobiles like 010…, Arabic digits OK).'),
  email: z.email().max(120).optional(),
  destination: z.string().max(80).optional(),
  dateRange: z.string().max(80).optional().describe('Normalized period, e.g. "December 2026".'),
  budgetAmount: z.number().positive().optional(),
  budgetCurrency: z.string().length(3).optional(),
  adults: z.number().int().min(1).max(50).optional(),
  children: z.number().int().min(0).max(50).optional(),
  notes: z.string().max(500).optional().describe('Travel needs only; never passwords, card numbers or IDs.'),
});

const QuoteSchema = z.object({
  leadId: z.uuid().optional().describe('id returned by create_lead; omit to use the customer\'s latest lead.'),
  packageId: z.string().max(60).optional().describe('Company package id (e.g. pkg-fayoum-001) if the quote is for a catalog program.'),
  destination: z.string().max(80).optional().describe('For trips outside the catalog (no packageId): the destination, e.g. "Turkey".'),
  summary: z.string().min(10).max(1000).describe('What the customer wants quoted: destination, dates, party, budget, special needs.'),
});

const HandoffSchema = z.object({
  reason: z.string().min(3).max(200).describe('Why a human is needed, e.g. "custom group itinerary", "complaint".'),
  summary: z.string().min(10).max(1000).describe('Short case summary for staff (no passwords or card data).'),
  leadId: z.uuid().optional(),
});

export function createCrmTools(crm: CrmService): RegisteredTool[] {
  const createLead = defineTool({
    name: 'create_lead',
    description:
      'Save the customer\'s contact details and trip needs as a lead in the demo company CRM, so a quote can be prepared. Only after the customer clearly wants to be contacted / get a quote and has given name + phone. The app shows them exactly what will be saved (masked) and asks them to approve; nothing is saved before that. Never claims booking or payment.',
    inputSchema: LeadSchema,
    sideEffect: 'write',
    authorization: { kind: 'approval' },
    approvalPreview: (input) => crm.leadPreview(input),
    precheck: async (input, ctx) => {
      // Validate before asking for approval, so the customer never approves a request that would fail.
      try {
        crm.normalizeLead(input);
        if (!crm.enabled) throw new CrmError('NOT_CONFIGURED', 'Lead storage is not configured in this deployment; say lead creation is not available yet.');
      } catch (err) {
        return toToolError(err);
      }
      const existing = await crm.findLead(ctx.ownerId, input);
      return existing ? stored('lead', existing) : null;
    },
    execute: async (input, ctx) => {
      try {
        return stored('lead', await crm.createLead(ctx.ownerId, input, { conversationId: ctx.conversationId, approvalId: ctx.approvalId ?? null }));
      } catch (err) {
        return toToolError(err);
      }
    },
  });

  const createQuote = defineTool({
    name: 'create_quote_request',
    description:
      'Create a quote request linked to the customer\'s lead (create the lead first). For catalog programs pass packageId; for other destinations leave it empty and describe the trip in summary. The customer approves it in the app first. A quote request is not a booking and has no confirmed price.',
    inputSchema: QuoteSchema,
    sideEffect: 'write',
    authorization: { kind: 'approval' },
    approvalPreview: (input) => ({
      purpose: 'Send a quote request to the DEMO company CRM (not a booking, no payment).',
      package: input.packageId ?? `custom trip (not in catalog)${input.destination ? `: ${input.destination}` : ''}`,
      summary: input.summary,
    }),
    precheck: async (input, ctx) => {
      const existing = await crm.findQuote(ctx.ownerId, input);
      return existing ? stored('quote request', existing) : null;
    },
    execute: async (input, ctx) => {
      try {
        return stored('quote request', await crm.createQuoteRequest(ctx.ownerId, input, { approvalId: ctx.approvalId ?? null }));
      } catch (err) {
        return toToolError(err);
      }
    },
  });

  const handoff = defineTool({
    name: 'request_human_handoff',
    description:
      'Ask for a human travel consultant to review the case (complex requests, complaints, or when the customer asks for a person). Shares only the summary you write. The customer approves first. This demo has no live chat, phone or WhatsApp channel: say a staff review was requested in the demo CRM, never that someone is calling now.',
    inputSchema: HandoffSchema,
    sideEffect: 'write',
    authorization: { kind: 'approval' },
    approvalPreview: (input) => ({ purpose: 'Ask a human consultant (DEMO company) to review your case.', reason: input.reason, summary: input.summary }),
    precheck: async (input, ctx) => {
      const existing = await crm.findOpenHandoff(ctx.ownerId, input);
      return existing ? stored('handoff', existing) : null;
    },
    execute: async (input, ctx) => {
      try {
        return stored('handoff', await crm.requestHandoff(ctx.ownerId, input, { conversationId: ctx.conversationId, approvalId: ctx.approvalId ?? null }));
      } catch (err) {
        return toToolError(err);
      }
    },
  });

  return [createLead, createQuote, handoff];
}
