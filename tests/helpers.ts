import type { AppConfig } from '../server/src/config.ts';
import type { Sql } from '../server/src/db/sql.ts';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from '../server/src/memory/embeddings.ts';
import { buildSearchText } from '../server/src/text/normalize.ts';
import { createApp, type App } from '../server/src/app.ts';
import type { CompletionRequest, CompletionResponse, ContentBlock, LLMProvider } from '../server/src/agent/providers/types.ts';
import { createTestSql } from './pglite-sql.ts';

/**
 * TEST-ONLY deterministic provider. It plays back scripted model turns so the loop, tools,
 * persistence and traces can be verified offline. It is never wired into the CLI.
 */
export class ScriptedProvider implements LLMProvider {
  readonly id = 'scripted-test';
  readonly model = 'scripted';
  readonly requests: CompletionRequest[] = [];
  private readonly script: (req: CompletionRequest, index: number) => CompletionResponse | Promise<CompletionResponse>;

  constructor(script: (req: CompletionRequest, index: number) => CompletionResponse | Promise<CompletionResponse>) {
    this.script = script;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // Snapshot messages: the runtime mutates its history array after the call.
    const snapshot = { ...request, messages: structuredClone(request.messages) };
    this.requests.push(snapshot);
    return this.script(snapshot, this.requests.length - 1);
  }
}

export const toolUse = (...calls: Array<{ id: string; name: string; input: unknown }>): CompletionResponse => ({
  content: calls.map((c): ContentBlock => ({ type: 'tool_call', ...c })),
  stopReason: 'tool_use',
  usage: { inputTokens: 100, outputTokens: 20 },
  model: 'scripted',
});

export const final = (text: string): CompletionResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { inputTokens: 120, outputTokens: 40 },
  model: 'scripted',
});

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    freeTierOnly: true,
    providers: [],
    providerIssue: 'test',
    stt: null,
    sttIssue: 'test',
    databaseUrl: null,
    embeddings: null,
    embeddingsIssue: 'test',
    context: { maxContextTokens: 100_000, keepRecentTokens: 20_000 },
    search: null,
    searchIssue: 'test',
    piiEncryptionKey: null,
    maxAgentSteps: 6,
    agentTimeoutMs: 10_000,
    providerCallTimeoutMs: 20_000,
    providerPrimaryTimeoutMs: 20_000,
    toolTimeoutMs: 2_000,
    redactAuditLogs: true,
    ...overrides,
  };
}

/** App on a migrated PGlite database; pass `sql` to share one database across tests in a file. */
export async function testApp(provider: LLMProvider, overrides: Partial<AppConfig> = {}, sql?: Sql, embeddings: EmbeddingProvider | null = null): Promise<App> {
  return createApp(testConfig(overrides), provider, sql ?? (await createTestSql()), embeddings, { seedDemo: true });
}

/**
 * TEST-ONLY deterministic embedder: hashed bag of normalized words (+ synonyms) → 1024-dim unit vector.
 * Texts sharing words land close together, which is enough to exercise pgvector recall offline.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly label = 'test/hash-bow@1024';
  calls = 0;
  failNext = false;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('embedding service down');
    }
    return texts.map((text) => {
      const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      for (const word of buildSearchText([text]).split(' ').filter((w) => w.length >= 3)) {
        let h = 2166136261;
        for (const ch of word) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619);
        const idx = Math.abs(h) % EMBEDDING_DIMENSIONS;
        v[idx] = (v[idx] ?? 0) + 1;
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

/** Parses the JSON payload the runtime sent back to the model for a given tool call id. */
export function toolResultPayload(request: CompletionRequest, toolCallId: string): unknown {
  for (const m of request.messages) {
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.toolCallId === toolCallId) return JSON.parse(b.content) as unknown;
    }
  }
  throw new Error(`No tool_result for ${toolCallId}`);
}
