import type { AppConfig, ProviderConfig } from './config.ts';
import { CatalogRepository } from './catalog/repository.ts';
import { loadCompanyFixture, seedDemoCatalog, type CompanyInfo } from './db/seed.ts';
import type { Sql } from './db/sql.ts';
import { AgentRuntime } from './agent/runtime.ts';
import { AnthropicProvider } from './agent/providers/anthropic.ts';
import { FallbackProvider, RateLimitedProvider, RateLimiter, type FallbackEvent } from './agent/providers/fallback.ts';
import { GeminiProvider } from './agent/providers/gemini.ts';
import { GROQ_BASE_URL, OpenAIProvider } from './agent/providers/openai.ts';
import type { LLMProvider } from './agent/providers/types.ts';
import { GroqWhisper, type SpeechToText } from './voice/stt.ts';
import { ExternalResearchService } from './research/research-service.ts';
import { TavilySearch, type WebSearch } from './research/tavily.ts';
import { buildSystemPrompt } from './agent/system-prompt.ts';
import { ConsentStore } from './memory/consent-store.ts';
import { ContextManager } from './memory/context-manager.ts';
import { ConversationStore } from './memory/conversation-store.ts';
import { GeminiEmbeddingProvider, OpenAIEmbeddingProvider, type EmbeddingProvider } from './memory/embeddings.ts';
import { MemoryService } from './memory/memory-service.ts';
import { TraceRecorder } from './observability/trace.ts';
import { ApprovalStore } from './security/approvals.ts';
import { createCatalogTools } from './tools/catalog-tools.ts';
import { createExternalResearchTool } from './tools/external-research.ts';
import { createMemoryTools } from './tools/memory-tools.ts';
import { createCrmTools } from './tools/crm-tools.ts';
import { CrmService } from './crm/crm-service.ts';
import { PiiCipher } from './security/pii-crypto.ts';
import { ToolRegistry } from './tools/registry.ts';
import { createSystemStatusTool } from './tools/system-tools.ts';

/** Free-tier calls should not sleep long inside a turn: hand over to the next provider instead. */
const MAX_RETRY_WAIT_MS = 8_000;
const FREE_TIER_RETRY = { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 4_000 };

function createOne(p: ProviderConfig): LLMProvider {
  switch (p.kind) {
    case 'gemini':
      return new RateLimitedProvider(new GeminiProvider({ apiKey: p.apiKey, model: p.model, maxRetryWaitMs: MAX_RETRY_WAIT_MS, retry: FREE_TIER_RETRY }), new RateLimiter(p.limit), MAX_RETRY_WAIT_MS);
    case 'groq':
      return new RateLimitedProvider(
        new OpenAIProvider({ apiKey: p.apiKey, model: p.model, id: 'groq', baseUrl: GROQ_BASE_URL, maxRetryWaitMs: MAX_RETRY_WAIT_MS, retry: FREE_TIER_RETRY }),
        new RateLimiter(p.limit),
        MAX_RETRY_WAIT_MS,
      );
    case 'anthropic':
      return new AnthropicProvider({ apiKey: p.apiKey, model: p.model, effort: p.effort });
    case 'openai':
      return new OpenAIProvider({ apiKey: p.apiKey, model: p.model });
  }
}

/** Rate-limited free-tier chain (primary → fallbacks). Null when no provider is configured. */
export function createProvider(config: AppConfig, opts: { onFallback?: (e: FallbackEvent) => void } = {}): LLMProvider | null {
  const chain = config.providers.map(createOne);
  if (chain.length === 0) return null;
  return chain.length === 1
    ? (chain[0] ?? null)
    : new FallbackProvider(chain, { perCallTimeoutMs: config.providerCallTimeoutMs, primaryCallTimeoutMs: config.providerPrimaryTimeoutMs, ...(opts.onFallback ? { onFallback: opts.onFallback } : {}) });
}

export function createEmbeddings(config: AppConfig): EmbeddingProvider | null {
  const e = config.embeddings;
  if (!e) return null;
  return e.kind === 'gemini'
    ? new GeminiEmbeddingProvider({ apiKey: e.apiKey, model: e.model })
    : new OpenAIEmbeddingProvider({ apiKey: e.apiKey, model: e.model });
}

export function createWebSearch(config: AppConfig): WebSearch | null {
  return config.search ? new TavilySearch({ apiKey: config.search.apiKey }) : null;
}

export function createSpeechToText(config: AppConfig): SpeechToText | null {
  return config.stt ? new GroqWhisper({ apiKey: config.stt.apiKey, model: config.stt.model }) : null;
}

export interface App {
  sql: Sql;
  company: CompanyInfo;
  catalog: CatalogRepository;
  registry: ToolRegistry;
  conversations: ConversationStore;
  approvals: ApprovalStore;
  consents: ConsentStore;
  memory: MemoryService;
  crm: CrmService;
  context: ContextManager;
  tracer: TraceRecorder;
  runtime: AgentRuntime;
}

/**
 * Composition root. Database (already migrated), LLM provider and embedding provider are injected,
 * so the CLI passes Supabase + real providers and tests pass PGlite + scripted/fake ones.
 * Startup never writes the catalog unless `seedDemo` is set (tests); use `npm run db:seed` for real databases.
 */
export async function createApp(
  config: AppConfig,
  provider: LLMProvider,
  sql: Sql,
  embeddings: EmbeddingProvider | null = null,
  /** seedDemo: tests only. webSearch: inject a search backend (tests); defaults to the configured one. */
  opts: { seedDemo?: boolean; webSearch?: WebSearch | null } = {},
): Promise<App> {
  const company = opts.seedDemo ? (await seedDemoCatalog(sql)).company : loadCompanyFixture();
  const catalog = new CatalogRepository(sql, company.id);
  const conversations = new ConversationStore(sql);
  const approvals = new ApprovalStore(sql);
  const consents = new ConsentStore(sql);
  const memory = new MemoryService(sql, consents, embeddings);
  const context = new ContextManager({
    sql, conversations, provider, consents, embeddings,
    budget: { maxContextTokens: config.context.maxContextTokens, keepRecentTokens: config.context.keepRecentTokens },
  });
  const crm = new CrmService(sql, consents, config.piiEncryptionKey ? new PiiCipher(config.piiEncryptionKey) : null);
  const research = new ExternalResearchService({ sql, search: opts.webSearch !== undefined ? opts.webSearch : createWebSearch(config) });
  // Static per process: the same facts feed get_system_status and the system prompt, so the model does not need a
  // status tool call (a full extra model step on the free tier) before answering capability questions.
  const capabilities = {
    llmProvider: provider.id,
    model: provider.model,
    externalTravelSearch: research.providerId ? `connected (${research.providerId} web search; external listings are unverified, not live inventory)` : 'not_connected',
    longTermMemory: `opt_in (${memory.retrievalBackend})`,
    leadCreation: crm.enabled
      ? 'enabled (demo CRM in Supabase, encrypted contact fields, customer approval per action; no real staff follow-up, no booking/payment)'
      : 'not_configured (PII_ENCRYPTION_KEY missing)',
    voice: config.stt ? `voice_notes (${config.stt.kind}/${config.stt.model}); live voice not implemented` : 'not_configured',
  };
  const registry = new ToolRegistry().register(
    ...createCatalogTools(catalog, company),
    ...createMemoryTools(memory, consents),
    ...createCrmTools(crm),
    createExternalResearchTool(research),
    createSystemStatusTool(capabilities),
  );
  const tracer = new TraceRecorder(sql, { redact: config.redactAuditLogs });
  const runtime = new AgentRuntime({
    provider,
    registry,
    conversations,
    approvals,
    consents,
    tracer,
    context,
    limits: { maxSteps: config.maxAgentSteps, timeoutMs: config.agentTimeoutMs, toolTimeoutMs: config.toolTimeoutMs },
    systemPrompt: (now, extras) => buildSystemPrompt(company, now, extras, capabilities),
    memoryStatus: async (ownerId, conversationId) => ({
      ...(await memory.status(ownerId)),
      retrieval: memory.retrievalBackend,
      declinedThisConversation: await consents.declinedIn(ownerId, conversationId),
    }),
  });
  return { sql, company, catalog, registry, conversations, approvals, consents, memory, crm, context, tracer, runtime };
}
