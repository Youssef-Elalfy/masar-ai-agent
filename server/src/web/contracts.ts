import { z } from 'zod';

/**
 * HTTP contract between the MASAR AI web console (client/) and the agent server.
 * Imported by both sides; it must stay free of Node-only imports.
 * Everything here is derived from real server state: stored transcripts, tool results, trace events.
 */

// ───────────── Status ─────────────
export const StatusSchema = z.object({
  company: z.object({ name: z.string(), fictional: z.boolean() }),
  model: z.string(),
  freeTierOnly: z.boolean(),
  features: z.object({
    voiceNotes: z.boolean(),
    webResearch: z.boolean(),
    crm: z.boolean(),
    memoryRetrieval: z.string(),
  }),
  limits: z.object({ maxMessageChars: z.number(), maxAudioBytes: z.number() }),
});
export type Status = z.infer<typeof StatusSchema>;

// ───────────── Conversations ─────────────
export const ConversationListItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  userTurns: z.number(),
});
export type ConversationListItem = z.infer<typeof ConversationListItemSchema>;
export const ConversationListSchema = z.object({ conversations: z.array(ConversationListItemSchema) });

/** One executed tool call, as the customer may see it (name + outcome; never inputs or reasoning). */
export const ActivitySchema = z.object({
  toolName: z.string(),
  outcome: z.enum(['ok', 'error', 'pending']),
  errorCode: z.string().nullable(),
  /** Search criteria of read-only search tools (whitelisted keys; never write-tool inputs, which may hold PII). */
  filters: z.record(z.string(), z.union([z.string(), z.number()])).nullable(),
});
export type Activity = z.infer<typeof ActivitySchema>;

const Money = z.object({ amount: z.number(), currency: z.string() });

export const CompanyPackageCardSchema = z.object({
  kind: z.literal('company_package'),
  id: z.string(),
  nameAr: z.string(),
  nameEn: z.string().nullable(),
  destination: z.string(),
  destinationAr: z.string().nullable(),
  days: z.number(),
  nights: z.number(),
  tripType: z.string().nullable(),
  departureCity: z.string().nullable(),
  sourceType: z.string(),
  price: Money.extend({ basis: z.string() }),
  partyTotal: z.object({ amount: z.number().nullable(), note: z.string() }).nullable(),
  inclusions: z.array(z.string()),
  exclusions: z.array(z.string()),
});
export type CompanyPackageCard = z.infer<typeof CompanyPackageCardSchema>;

export const ExternalOfferCardSchema = z.object({
  kind: z.literal('external_offer'),
  id: z.string(),
  provider: z.string(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  destination: z.string(),
  days: z.number().nullable(),
  nights: z.number().nullable(),
  /** Single headline price only when the source states exactly one price. */
  price: Money.extend({ basis: z.string().nullable() }).nullable(),
  /** Every price found verbatim in the source, with the exact text it was read from. */
  pricesFound: z.array(Money.extend({ text: z.string() })),
  priceNote: z.string().nullable(),
  listingType: z.enum(['package_or_tour', 'flight_fare']),
  status: z.string(),
  retrievedAt: z.string(),
});
export type ExternalOfferCard = z.infer<typeof ExternalOfferCardSchema>;

export const ResearchNoticeSchema = z.object({
  kind: z.literal('research_notice'),
  status: z.string(),
  provider: z.string().nullable(),
  retrievedAt: z.string(),
  resultCount: z.number(),
});
export type ResearchNotice = z.infer<typeof ResearchNoticeSchema>;

export const ComparisonCardSchema = z.object({
  kind: z.literal('comparison'),
  sameCurrency: z.boolean(),
  cheapestId: z.string().nullable(),
  rows: z.array(z.object({
    position: z.number(),
    id: z.string(),
    nameAr: z.string(),
    nameEn: z.string().nullable(),
    days: z.number(),
    nights: z.number(),
    price: Money,
    partyTotal: z.number().nullable(),
  })),
});
export type ComparisonCard = z.infer<typeof ComparisonCardSchema>;

export const CrmRecordCardSchema = z.object({
  kind: z.literal('crm_record'),
  record: z.enum(['lead', 'quote', 'handoff']),
  reference: z.string(),
  created: z.boolean(),
});
export type CrmRecordCard = z.infer<typeof CrmRecordCardSchema>;

export const CardSchema = z.discriminatedUnion('kind', [
  CompanyPackageCardSchema, ExternalOfferCardSchema, ResearchNoticeSchema, ComparisonCardSchema, CrmRecordCardSchema,
]);
export type Card = z.infer<typeof CardSchema>;

export const TranscriptItemSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), id: z.string(), text: z.string() }),
  z.object({ role: z.literal('assistant'), id: z.string(), text: z.string(), activity: z.array(ActivitySchema), cards: z.array(CardSchema) }),
]);
export type TranscriptItem = z.infer<typeof TranscriptItemSchema>;

export const ApprovalViewSchema = z.object({
  approvalId: z.string(),
  toolName: z.string(),
  /** Server-masked preview: exactly what will be saved, as the customer sees it. */
  preview: z.unknown(),
  expiresAt: z.string(),
});
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

export const ConversationViewSchema = z.object({
  id: z.string(),
  items: z.array(TranscriptItemSchema),
  pendingApprovals: z.array(ApprovalViewSchema),
});
export type ConversationView = z.infer<typeof ConversationViewSchema>;

// ───────────── Turns (SSE) ─────────────
export const MAX_MESSAGE_CHARS = 4000;
export const TurnRequestSchema = z.object({
  text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  input: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text') }),
    z.object({ kind: z.literal('voice_transcript'), lowConfidence: z.boolean() }),
  ]).optional(),
});
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

export const TurnOutcomeSchema = z.object({
  traceId: z.string(),
  status: z.string(),
  errorCode: z.string().nullable(),
  steps: z.number(),
  latencyMs: z.number(),
  /** The model asked to enable memory; the client shows the server-fixed consent dialog. */
  consentRequested: z.boolean(),
  groundingCorrections: z.number(),
});
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

/** Server-sent events of one turn, in order. Every event mirrors something the server actually did. */
export const TurnEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ack'), traceId: z.string(), conversationId: z.string() }),
  z.object({ type: z.literal('model_call'), step: z.number(), latencyMs: z.number() }),
  z.object({ type: z.literal('tool_started'), step: z.number(), toolName: z.string() }),
  z.object({ type: z.literal('tool_finished'), step: z.number(), toolName: z.string(), outcome: z.enum(['ok', 'error']), errorCode: z.string().nullable(), latencyMs: z.number() }),
  z.object({ type: z.literal('grounding_check'), step: z.number() }),
  z.object({ type: z.literal('final'), outcome: TurnOutcomeSchema, conversation: ConversationViewSchema }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type TurnEvent = z.infer<typeof TurnEventSchema>;

// ───────────── Approvals, memory, CRM, voice ─────────────
export const ApprovalDecisionSchema = z.object({ approved: z.boolean() });

export const MemoryStateSchema = z.object({
  consent: z.enum(['active', 'declined', 'off']),
  policyVersion: z.string(),
  consentText: z.object({ ar: z.string(), en: z.string() }),
  retrieval: z.string(),
  items: z.array(z.object({ id: z.string(), category: z.string(), content: z.string(), updatedAt: z.string() })),
});
export type MemoryState = z.infer<typeof MemoryStateSchema>;
export const MemoryConsentRequestSchema = z.object({ decision: z.enum(['grant', 'decline']), conversationId: z.string().nullable() });

export const CrmListSchema = z.object({
  records: z.array(z.object({ kind: z.enum(['lead', 'quote', 'handoff']), reference: z.string(), status: z.string(), createdAt: z.string(), detail: z.string() })),
});
export type CrmList = z.infer<typeof CrmListSchema>;

export const TranscriptSchema = z.object({
  text: z.string(),
  language: z.string().nullable(),
  durationSec: z.number().nullable(),
  lowConfidence: z.boolean(),
});
export type TranscriptView = z.infer<typeof TranscriptSchema>;

export const ApiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export type ApiError = z.infer<typeof ApiErrorSchema>;
