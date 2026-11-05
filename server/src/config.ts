import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Free-tier allowlists, verified against the official docs on 2026-11-03:
 * - Gemini: aistudio.google.com/docs/pricing (free tier "Free of charge") + model pages (function calling: Supported).
 * - Groq: console.groq.com/docs/models (production models) + docs/tool-use ("All models hosted on Groq support tool use").
 * Re-verify when changing models; free tiers and model IDs change.
 */
export const FREE_TIER = {
  geminiChat: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview'],
  geminiEmbedding: ['gemini-embedding-001'],
  // gpt-oss first: on 2026-11-03 the Llama models were not available to the user's Groq account (verified via /models).
  groqChat: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  groqStt: ['whisper-large-v3-turbo', 'whisper-large-v3'],
} as const;

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const stringWithDefault = (def: string) => z.preprocess(emptyToUndefined, z.string().default(def));
const intWithDefault = (def: number) => z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(def));
const bool = (def: boolean) => z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default(def ? 'true' : 'false')).transform((v) => v === 'true');

const EnvSchema = z.object({
  FREE_TIER_ONLY: bool(true),
  // Free-tier providers (primary → fallback order).
  GEMINI_API_KEY: optionalString,
  GEMINI_MODELS: stringWithDefault('gemini-3.8-flash,gemini-3.5-flash-lite'),
  GEMINI_RPM: intWithDefault(8),
  GEMINI_RPD: intWithDefault(200),
  GROQ_API_KEY: optionalString,
  GROQ_MODEL: stringWithDefault('openai/gpt-oss-120b'),
  GROQ_RPM: intWithDefault(25),
  GROQ_RPD: intWithDefault(900),
  // Paid providers: only used when FREE_TIER_ONLY=false.
  MODEL_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['anthropic', 'openai']).optional()),
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: stringWithDefault('claude-opus-5-5'),
  ANTHROPIC_EFFORT: z.preprocess(emptyToUndefined, z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium')),
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: optionalString,
  DATABASE_URL: optionalString,
  EMBEDDING_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['gemini', 'openai', 'none']).default('gemini')),
  EMBEDDING_MODEL: optionalString,
  EMBEDDING_DIMENSIONS: z.preprocess(emptyToUndefined, z.coerce.number().int().default(1024)),
  STT_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['groq', 'none']).default('groq')),
  STT_MODEL: stringWithDefault('whisper-large-v3-turbo'),
  CONTEXT_MAX_TOKENS: intWithDefault(24_000),
  CONTEXT_KEEP_RECENT_TOKENS: intWithDefault(8_000),
  // Worldwide offer search (M3): Tavily free "Researcher" plan (1,000 credits/month, no card); basic depth only.
  // CRM (M4): 32-byte base64 key for field-level encryption of lead contact details. Leads are disabled without it.
  PII_ENCRYPTION_KEY: optionalString,
  TRAVEL_SEARCH_PROVIDER: z.preprocess(emptyToUndefined, z.enum(['tavily', 'none']).default('tavily')),
  TAVILY_API_KEY: optionalString,
  MAX_AGENT_STEPS: intWithDefault(8),
  // Whole-turn deadline. Free-tier research turns measured ~100 s on 2026-11-04 (4 model calls of 20–30 s), so 90 s
  // cut them off. Still bounded; heavy research demos may override to 180000.
  AGENT_TIMEOUT_MS: intWithDefault(150_000),
  // Per model call inside the fallback chain. Measured 2026-11-04: gemini-3.5-flash-lite needs ~21 s for the full
  // agent prompt (~5.3k tokens), so 20 s made the chain abandon a model that was about to answer.
  PROVIDER_CALL_TIMEOUT_MS: intWithDefault(40_000),
  // The primary model gets less: when it is overloaded (503 / hanging) the turn falls back quickly.
  PROVIDER_PRIMARY_TIMEOUT_MS: intWithDefault(20_000),
  TOOL_TIMEOUT_MS: intWithDefault(10_000),
  AUDIT_LOG_REDACTION: bool(true),
});
type Env = z.infer<typeof EnvSchema>;

export interface RateLimitConfig {
  rpm: number;
  rpd: number | null;
}

export type ProviderConfig =
  | { kind: 'gemini'; apiKey: string; model: string; limit: RateLimitConfig }
  | { kind: 'groq'; apiKey: string; model: string; limit: RateLimitConfig }
  | { kind: 'anthropic'; apiKey: string; model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  | { kind: 'openai'; apiKey: string; model: string };

export interface AppConfig {
  freeTierOnly: boolean;
  /** Ordered chain: the first is primary, the rest are fallbacks. Empty = no usable provider. */
  providers: ProviderConfig[];
  /** Human-readable reason when no provider can be used; never contains secret values. */
  providerIssue: string | null;
  /** Supabase Postgres connection string (pooler). Null = not configured. */
  databaseUrl: string | null;
  /** Null when embeddings are disabled or no key is set (memory recall then uses lexical matching). */
  embeddings: { kind: 'gemini' | 'openai'; apiKey: string; model: string } | null;
  embeddingsIssue: string | null;
  /** Speech-to-text for voice notes; null = voice notes unavailable (text still works). */
  stt: { kind: 'groq'; apiKey: string; model: string } | null;
  sttIssue: string | null;
  context: { maxContextTokens: number; keepRecentTokens: number };
  /** External offer search; null = not connected (the tool then says so honestly). */
  search: { kind: 'tavily'; apiKey: string } | null;
  /** Base64 AES-256 key for CRM contact fields; null = lead tools report "not configured". */
  piiEncryptionKey: string | null;
  searchIssue: string | null;
  maxAgentSteps: number;
  agentTimeoutMs: number;
  /** Time budget of one model call before the fallback chain moves to the next model. */
  providerCallTimeoutMs: number;
  /** Time budget of the primary (first) model call. */
  providerPrimaryTimeoutMs: number;
  toolTimeoutMs: number;
  redactAuditLogs: boolean;
}

export function loadDotEnv(file = path.join(PROJECT_ROOT, '.env')): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

const list = (csv: string) => csv.split(',').map((s) => s.trim()).filter(Boolean);
const allowed = (model: string, allow: readonly string[]) => allow.includes(model);

function resolveProviders(env: Env): { providers: ProviderConfig[]; issue: string | null } {
  const providers: ProviderConfig[] = [];
  const problems: string[] = [];
  if (env.GEMINI_API_KEY) {
    for (const model of list(env.GEMINI_MODELS)) {
      if (env.FREE_TIER_ONLY && !allowed(model, FREE_TIER.geminiChat)) problems.push(`GEMINI_MODELS contains "${model}", which is not on the verified free-tier allowlist.`);
      else providers.push({ kind: 'gemini', apiKey: env.GEMINI_API_KEY, model, limit: { rpm: env.GEMINI_RPM, rpd: env.GEMINI_RPD } });
    }
  }
  if (env.GROQ_API_KEY) {
    if (env.FREE_TIER_ONLY && !allowed(env.GROQ_MODEL, FREE_TIER.groqChat)) problems.push(`GROQ_MODEL "${env.GROQ_MODEL}" is not on the verified free-tier allowlist.`);
    else providers.push({ kind: 'groq', apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL, limit: { rpm: env.GROQ_RPM, rpd: env.GROQ_RPD } });
  }
  if (!env.FREE_TIER_ONLY) {
    if ((env.MODEL_PROVIDER === 'anthropic' || !env.MODEL_PROVIDER) && env.ANTHROPIC_API_KEY) {
      providers.push({ kind: 'anthropic', apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL, effort: env.ANTHROPIC_EFFORT });
    }
    if ((env.MODEL_PROVIDER === 'openai' || !env.MODEL_PROVIDER) && env.OPENAI_API_KEY && env.OPENAI_MODEL) {
      providers.push({ kind: 'openai', apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL });
    }
  }
  if (problems.length > 0) return { providers: [], issue: problems.join(' ') };
  if (providers.length === 0) {
    return { providers: [], issue: 'No free-tier LLM key found. Set GEMINI_API_KEY (primary) and optionally GROQ_API_KEY (fallback) in .env.' };
  }
  return { providers, issue: null };
}

function resolveEmbeddings(env: Env): Pick<AppConfig, 'embeddings' | 'embeddingsIssue'> {
  if (env.EMBEDDING_PROVIDER === 'none') return { embeddings: null, embeddingsIssue: 'EMBEDDING_PROVIDER=none: memory recall uses lexical matching.' };
  if (env.EMBEDDING_DIMENSIONS !== 1024) throw new Error('EMBEDDING_DIMENSIONS must be 1024 to match the vector(1024) schema.');
  if (env.EMBEDDING_PROVIDER === 'gemini') {
    const model = env.EMBEDDING_MODEL ?? 'gemini-embedding-001';
    if (env.FREE_TIER_ONLY && !allowed(model, FREE_TIER.geminiEmbedding)) {
      return { embeddings: null, embeddingsIssue: `EMBEDDING_MODEL "${model}" is not on the free-tier allowlist; memory recall uses lexical matching.` };
    }
    if (!env.GEMINI_API_KEY) return { embeddings: null, embeddingsIssue: 'GEMINI_API_KEY not set: memory recall uses lexical matching until it is.' };
    return { embeddings: { kind: 'gemini', apiKey: env.GEMINI_API_KEY, model }, embeddingsIssue: null };
  }
  if (env.FREE_TIER_ONLY) return { embeddings: null, embeddingsIssue: 'OpenAI embeddings are paid and FREE_TIER_ONLY=true; memory recall uses lexical matching.' };
  if (!env.OPENAI_API_KEY) return { embeddings: null, embeddingsIssue: 'OPENAI_API_KEY not set: memory recall uses lexical matching until it is.' };
  return { embeddings: { kind: 'openai', apiKey: env.OPENAI_API_KEY, model: env.EMBEDDING_MODEL ?? 'text-embedding-3-small' }, embeddingsIssue: null };
}

function resolveStt(env: Env): Pick<AppConfig, 'stt' | 'sttIssue'> {
  if (env.STT_PROVIDER === 'none') return { stt: null, sttIssue: 'STT_PROVIDER=none: voice notes are disabled (text works).' };
  if (env.FREE_TIER_ONLY && !allowed(env.STT_MODEL, FREE_TIER.groqStt)) return { stt: null, sttIssue: `STT_MODEL "${env.STT_MODEL}" is not on the free-tier allowlist.` };
  if (!env.GROQ_API_KEY) return { stt: null, sttIssue: 'GROQ_API_KEY not set: voice notes are disabled (text works).' };
  return { stt: { kind: 'groq', apiKey: env.GROQ_API_KEY, model: env.STT_MODEL }, sttIssue: null };
}

function resolveSearch(env: Env): Pick<AppConfig, 'search' | 'searchIssue'> {
  if (env.TRAVEL_SEARCH_PROVIDER === 'none') return { search: null, searchIssue: 'TRAVEL_SEARCH_PROVIDER=none: worldwide offer search is not connected.' };
  if (!env.TAVILY_API_KEY) return { search: null, searchIssue: 'TAVILY_API_KEY not set: worldwide offer search is not connected (the agent says so).' };
  return { search: { kind: 'tavily', apiKey: env.TAVILY_API_KEY }, searchIssue: null };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = EnvSchema.parse(source);
  const { providers, issue } = resolveProviders(env);
  return {
    freeTierOnly: env.FREE_TIER_ONLY,
    providers,
    providerIssue: issue,
    databaseUrl: env.DATABASE_URL ?? null,
    ...resolveEmbeddings(env),
    ...resolveStt(env),
    context: { maxContextTokens: env.CONTEXT_MAX_TOKENS, keepRecentTokens: Math.min(env.CONTEXT_KEEP_RECENT_TOKENS, env.CONTEXT_MAX_TOKENS) },
    ...resolveSearch(env),
    piiEncryptionKey: env.PII_ENCRYPTION_KEY ?? null,
    maxAgentSteps: env.MAX_AGENT_STEPS,
    agentTimeoutMs: env.AGENT_TIMEOUT_MS,
    providerCallTimeoutMs: env.PROVIDER_CALL_TIMEOUT_MS,
    providerPrimaryTimeoutMs: env.PROVIDER_PRIMARY_TIMEOUT_MS,
    toolTimeoutMs: env.TOOL_TIMEOUT_MS,
    redactAuditLogs: env.AUDIT_LOG_REDACTION,
  };
}
