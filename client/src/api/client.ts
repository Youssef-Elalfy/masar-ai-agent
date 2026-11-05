import { z } from 'zod';
import {
  ApiErrorSchema, ConversationListSchema, ConversationViewSchema, CrmListSchema, MemoryStateSchema, StatusSchema, TranscriptSchema, TurnEventSchema,
  type ConversationListItem, type ConversationView, type CrmList, type MemoryState, type Status, type TranscriptView, type TurnEvent, type TurnRequest,
} from '../../../server/src/web/contracts.ts';

/** Typed client for the RAHHAL agent server. Every response is validated; nothing is assumed. */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const HEADERS = { 'x-rahhal-client': 'web' } as const;

/**
 * One browser session per page: the server issues the anonymous owner cookie only on GET /api/status.
 * Every other request waits for this bootstrap, so parallel startup requests can never end up under
 * different owners. After a server restart (401 SESSION_REQUIRED) all callers share one re-bootstrap.
 */
let session: Promise<void> | null = null;
function ensureSession(): Promise<void> {
  if (!session) {
    const current: Promise<void> = fetch('/api/status', { credentials: 'same-origin', headers: HEADERS }).then(
      () => undefined,
      () => {
        if (session === current) session = null;
      },
    );
    session = current;
  }
  return session;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const attempt = async () => {
    try {
      return await fetch(path, { credentials: 'same-origin', ...init });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError(0, 'OFFLINE', 'Cannot reach the RAHHAL server.');
    }
  };
  const used = ensureSession();
  await used;
  const res = await attempt();
  if (res.status !== 401) return res;
  if (session === used) session = null;
  await ensureSession();
  return attempt();
}

async function request<T>(method: string, path: string, schema: z.ZodType<T> | null, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await send(path, {
    method,
    headers: { ...HEADERS, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  return parseResponse(res, schema);
}

async function parseResponse<T>(res: Response, schema: z.ZodType<T> | null): Promise<T> {
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(data);
    throw parsed.success ? new ApiError(res.status, parsed.data.error.code, parsed.data.error.message) : new ApiError(res.status, 'HTTP_ERROR', `Server error (${res.status}).`);
  }
  if (!schema) return undefined as T;
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError(res.status, 'BAD_RESPONSE', 'Unexpected server response.');
  return parsed.data;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  status: () => request<Status>('GET', '/api/status', StatusSchema),
  conversations: async (): Promise<ConversationListItem[]> => (await request('GET', '/api/conversations', ConversationListSchema)).conversations,
  createConversation: async (locale: 'ar-EG' | 'en'): Promise<string> => (await request('POST', '/api/conversations', z.object({ id: z.string() }), { locale })).id,
  conversation: (id: string) => request<ConversationView>('GET', `/api/conversations/${id}`, ConversationViewSchema),
  deleteConversation: (id: string) => request<void>('DELETE', `/api/conversations/${id}`, null),
  cancelTurn: (traceId: string) => request('POST', `/api/turns/${traceId}/cancel`, z.object({ canceled: z.boolean() })),
  decideApproval: (approvalId: string, approved: boolean) => request('POST', `/api/approvals/${approvalId}`, z.object({ decided: z.enum(['approved', 'declined']) }), { approved }),
  memory: (conversationId: string | null) => request<MemoryState>('GET', `/api/memory${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`, MemoryStateSchema),
  memoryConsent: (decision: 'grant' | 'decline', conversationId: string | null) => request<MemoryState>('POST', '/api/memory/consent', MemoryStateSchema, { decision, conversationId }),
  revokeMemory: () => request('DELETE', '/api/memory/consent', z.object({ revoked: z.boolean(), deletedMemories: z.number() })),
  forgetItem: (itemId: string) => request('DELETE', `/api/memory/items/${itemId}`, z.object({ deleted: z.number() })),
  crm: () => request<CrmList>('GET', '/api/crm', CrmListSchema),
  deleteCrm: () => request('DELETE', '/api/crm', z.object({ leads: z.number(), quotes: z.number(), handoffs: z.number() })),

  async transcribe(audio: Blob, signal?: AbortSignal): Promise<TranscriptView> {
    const res = await send('/api/voice/transcribe', {
      method: 'POST', headers: { ...HEADERS, 'content-type': audio.type || 'application/octet-stream' }, body: audio,
      ...(signal ? { signal } : {}),
    });
    return parseResponse(res, TranscriptSchema);
  },

  /**
   * Runs one agent turn and streams the server's real events (SSE over a POST response).
   * Aborting the signal closes the stream, which cancels the turn on the server.
   */
  async turn(conversationId: string, body: TurnRequest, onEvent: (e: TurnEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await send(`/api/conversations/${conversationId}/turns`, {
      method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body), signal,
    });
    if (!res.ok || !res.body) await parseResponse(res, null);
    if (!res.body) throw new ApiError(res.status, 'BAD_RESPONSE', 'No event stream.');
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (!data) continue; // keep-alive comment
        const parsed = TurnEventSchema.safeParse(safeJson(data));
        if (parsed.success) onEvent(parsed.data);
      }
    }
  },
};
