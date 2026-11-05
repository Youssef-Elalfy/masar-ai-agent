import { z } from 'zod';
import { postJsonWithRetry, type RetryPolicy } from '../agent/providers/http.ts';
import { ProviderError, type FetchLike } from '../agent/providers/types.ts';

/** Must match the vector(1024) columns in supabase/migrations. */
export const EMBEDDING_DIMENSIONS = 1024;

/** Retrieval models embed stored text and search queries differently. */
export type EmbeddingPurpose = 'document' | 'query';

export interface EmbeddingProvider {
  /** Stored next to every vector; vectors from different labels are never compared. */
  readonly label: string;
  embed(texts: string[], signal: AbortSignal, purpose?: EmbeddingPurpose): Promise<number[][]>;
}

/** L2-normalizes a vector (required for truncated gemini-embedding-001 outputs). */
export function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}

const GeminiEmbedResponse = z.object({ embedding: z.object({ values: z.array(z.number()) }) });

export interface GeminiEmbeddingOptions {
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
  retry?: RetryPolicy;
}

/**
 * Gemini embeddings (free tier) at 1024 dims via outputDimensionality, with RETRIEVAL_DOCUMENT /
 * RETRIEVAL_QUERY task types. gemini-embedding-001 outputs below 3072 dims must be normalized client-side.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly label: string;
  private readonly opts: GeminiEmbeddingOptions;

  constructor(opts: GeminiEmbeddingOptions) {
    this.opts = opts;
    this.label = `gemini/${opts.model}@${EMBEDDING_DIMENSIONS}`;
  }

  async embed(texts: string[], signal: AbortSignal, purpose: EmbeddingPurpose = 'document'): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) {
      const raw = await postJsonWithRetry({
        fetchImpl: this.opts.fetchImpl ?? fetch,
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.opts.model)}:embedContent`,
        headers: { 'x-goog-api-key': this.opts.apiKey },
        body: {
          content: { parts: [{ text }] },
          taskType: purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
          outputDimensionality: EMBEDDING_DIMENSIONS,
        },
        signal,
        providerName: `Gemini embeddings ${this.opts.model}`,
        ...(this.opts.retry ? { retry: this.opts.retry } : {}),
      });
      const parsed = GeminiEmbedResponse.safeParse(raw);
      if (!parsed.success || parsed.data.embedding.values.length !== EMBEDDING_DIMENSIONS) {
        throw new ProviderError('PROVIDER_BAD_RESPONSE', `Expected a ${EMBEDDING_DIMENSIONS}-dim Gemini embedding`);
      }
      out.push(normalize(parsed.data.embedding.values));
    }
    return out;
  }
}

const ResponseSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
  retry?: RetryPolicy;
}

/** OpenAI embeddings (multilingual, incl. Arabic), shortened to 1024 dims via the `dimensions` parameter. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly label: string;
  private readonly opts: OpenAIEmbeddingOptions;

  constructor(opts: OpenAIEmbeddingOptions) {
    this.opts = opts;
    this.label = `openai/${opts.model}@${EMBEDDING_DIMENSIONS}`;
  }

  async embed(texts: string[], signal: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const raw = await postJsonWithRetry({
      fetchImpl: this.opts.fetchImpl ?? fetch,
      url: 'https://api.openai.com/v1/embeddings',
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      body: { model: this.opts.model, input: texts, dimensions: EMBEDDING_DIMENSIONS },
      signal,
      providerName: 'OpenAI embeddings',
      ...(this.opts.retry ? { retry: this.opts.retry } : {}),
    });
    const parsed = ResponseSchema.safeParse(raw);
    if (!parsed.success) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'Embedding response did not match the expected shape');
    const ordered = [...parsed.data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (ordered.length !== texts.length || ordered.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new ProviderError('PROVIDER_BAD_RESPONSE', `Expected ${texts.length} embeddings of ${EMBEDDING_DIMENSIONS} dims`);
    }
    return ordered;
  }
}

/** pgvector text literal, passed as a parameter and cast with ::extensions.vector. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}
