import { existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import type { App } from '../app.ts';
import { ConversationAccessError } from '../memory/conversation-store.ts';
import { consentText, MEMORY_POLICY_VERSION } from '../memory/consent-store.ts';
import { newTraceId, type TraceEvent } from '../observability/trace.ts';
import { AUDIO_TYPES, MAX_AUDIO_BYTES, VoiceInputError, type SpeechToText } from '../voice/stt.ts';
import {
  ApprovalDecisionSchema, MAX_MESSAGE_CHARS, MemoryConsentRequestSchema, TurnRequestSchema,
  type ConversationView, type CrmList, type MemoryState, type Status, type TranscriptView, type TurnEvent,
} from './contracts.ts';
import { OwnerSessions, RateLimit } from './session.ts';
import { buildConversationView } from './views.ts';

export interface WebDeps {
  app: App;
  stt: SpeechToText | null;
  sessions: OwnerSessions;
  status: Omit<Status, 'limits'>;
  /** Built client (client/dist) served for non-API routes; null in development (Vite serves the client). */
  staticDir: string | null;
  limits?: { turnsPerMinute?: number; globalTurnsPerMinute?: number; voicePerMinute?: number };
  /**
   * Host names this server answers to (any port). Defaults to loopback only. Requests for any other Host are
   * refused, which blocks DNS-rebinding: a hostile page whose domain re-resolves to 127.0.0.1 would otherwise pass
   * the same-origin check (its Origin equals its own Host) and drive the local agent and its API quota.
   */
  allowedHostnames?: readonly string[];
}

export const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'] as const;

/** Host header without the port, lower-cased ("[::1]:8787" → "[::1]"). */
export function hostnameOf(hostHeader: string | undefined): string {
  return (hostHeader ?? '').trim().toLowerCase().replace(/:\d+$/, '');
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const JSON_LIMIT = 32 * 1024;
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'microphone=(self), camera=(), geolocation=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
};
// Inline style attributes are needed by Motion (transform/opacity); no inline scripts, no external origins.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const MIME_TO_EXT = new Map<string, string>([
  ...Object.entries(AUDIO_TYPES).map(([ext, mime]): [string, string] => [mime, ext]),
  ['audio/x-wav', '.wav'], ['audio/wave', '.wav'], ['audio/x-m4a', '.m4a'], ['audio/mp3', '.mp3'],
]);

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...(body === null ? {} : { 'content-type': 'application/json; charset=utf-8' }), ...headers });
  res.end(payload);
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) throw new HttpError(413, 'TOO_LARGE', 'Request body is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > max) throw new HttpError(413, 'TOO_LARGE', 'Request body is too large.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON.');
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readBody(req, JSON_LIMIT)).toString('utf8'));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'INVALID_JSON', 'Body is not valid JSON.');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new HttpError(400, 'VALIDATION_ERROR', result.error.issues[0]?.message ?? 'Invalid request.');
  return result.data;
}

/**
 * State-changing requests must come from this app: a custom header (forces a CORS preflight that this
 * server never grants) and, when the browser sends Origin, the same origin as the Host.
 */
function assertSameOrigin(req: IncomingMessage): void {
  if (req.headers['x-rahhal-client'] !== 'web') throw new HttpError(403, 'FORBIDDEN', 'Missing client header.');
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
    throw new HttpError(403, 'FORBIDDEN', 'Cross-origin request refused.');
  }
}

function traceToEvent(e: TraceEvent): TurnEvent | null {
  switch (e.kind) {
    case 'model_call':
      return { type: 'model_call', step: e.step, latencyMs: e.latencyMs };
    case 'tool_started':
      return { type: 'tool_started', step: e.step, toolName: e.toolName };
    case 'tool':
      return {
        type: 'tool_finished', step: e.execution.step, toolName: e.execution.toolName,
        outcome: e.execution.outcome === 'ok' ? 'ok' : 'error', errorCode: e.execution.errorCode, latencyMs: e.execution.latencyMs,
      };
    case 'grounding_check':
      return { type: 'grounding_check', step: e.step };
    default:
      return null;
  }
}

export function createWebHandler(deps: WebDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { app, stt, sessions } = deps;
  const allowedHostnames = new Set((deps.allowedHostnames ?? LOOPBACK_HOSTNAMES).map((h) => h.toLowerCase()));
  const turnLimit = new RateLimit(deps.limits?.turnsPerMinute ?? 8, 60_000);
  const globalTurnLimit = new RateLimit(deps.limits?.globalTurnsPerMinute ?? 30, 60_000);
  const voiceLimit = new RateLimit(deps.limits?.voicePerMinute ?? 6, 60_000);
  const status: Status = { ...deps.status, limits: { maxMessageChars: MAX_MESSAGE_CHARS, maxAudioBytes: MAX_AUDIO_BYTES } };
  /** Running turns by trace id, so the owner can stop one while still receiving its final (canceled) result. */
  const running = new Map<string, { ownerId: string; abort: AbortController }>();

  const conversationView = async (conversationId: string, ownerId: string): Promise<ConversationView> => {
    const history = await app.conversations.load(conversationId, ownerId);
    const pending = await app.approvals.pending(ownerId, conversationId);
    return buildConversationView(conversationId, history, pending.map((p) => ({ approvalId: p.approvalId, toolName: p.toolName, preview: p.argsPreview, expiresAt: p.expiresAt })));
  };

  const memoryState = async (ownerId: string, conversationId: string | null): Promise<MemoryState> => {
    const active = (await app.consents.active(ownerId, 'long_term_memory')) !== null;
    const declined = !active && conversationId !== null && (await app.consents.declinedIn(ownerId, conversationId));
    const label = app.memory.embeddingLabel;
    return {
      consent: active ? 'active' : declined ? 'declined' : 'off',
      policyVersion: MEMORY_POLICY_VERSION,
      consentText: { ar: consentText('ar', label, 'web'), en: consentText('en', label, 'web') },
      retrieval: app.memory.retrievalBackend,
      // Saved preferences are only ever listed while consent is active.
      items: active ? (await app.memory.list(ownerId)).map((i) => ({ id: i.id, category: i.category, content: i.content, updatedAt: i.updatedAt })) : [],
    };
  };

  async function runTurn(req: IncomingMessage, res: ServerResponse, ownerId: string, conversationId: string): Promise<void> {
    const body = await readJson(req, TurnRequestSchema);
    await app.conversations.assertOwner(conversationId, ownerId);
    if (!turnLimit.take(ownerId) || !globalTurnLimit.take('all')) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many messages in a short time. Please wait a minute (free-tier limits).');
    }
    const traceId = newTraceId();
    const abort = new AbortController();
    running.set(traceId, { ownerId, abort });
    let finished = false;
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    const emit = (event: TurnEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    // Closing the stream (stop button, tab closed) cancels the turn; the runtime keeps the transcript consistent.
    res.on('close', () => {
      if (!finished) abort.abort();
    });
    const unsubscribe = app.tracer.onEvent((e) => {
      if (e.traceId !== traceId) return;
      const event = traceToEvent(e);
      if (event) emit(event);
    });
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 15_000);
    try {
      emit({ type: 'ack', traceId, conversationId });
      const result = await app.runtime.runTurn({ conversationId, ownerId, userText: body.text, input: body.input ?? { kind: 'text' }, traceId, signal: abort.signal });
      emit({
        type: 'final',
        outcome: {
          traceId: result.traceId, status: result.status, errorCode: result.errorCode, steps: result.steps, latencyMs: result.latencyMs,
          consentRequested: result.consentRequests.length > 0, groundingCorrections: result.groundingCorrections,
        },
        conversation: await conversationView(conversationId, ownerId),
      });
    } catch {
      emit({ type: 'error', code: 'TURN_FAILED', message: 'The agent could not finish this turn.' });
    } finally {
      finished = true;
      running.delete(traceId);
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    }
  }

  async function transcribe(req: IncomingMessage, res: ServerResponse, ownerId: string): Promise<void> {
    if (!stt) throw new HttpError(503, 'VOICE_UNAVAILABLE', 'Voice notes are not configured on this server. You can type instead.');
    const mime = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const ext = MIME_TO_EXT.get(mime);
    if (!ext) throw new HttpError(415, 'UNSUPPORTED_FORMAT', 'This audio format is not supported. Use webm, ogg, mp3, m4a, wav or flac.');
    if (!voiceLimit.take(ownerId)) throw new HttpError(429, 'RATE_LIMITED', 'Too many voice notes in a short time. Please wait a minute.');
    const bytes = await readBody(req, MAX_AUDIO_BYTES);
    if (bytes.length < 512) throw new HttpError(400, 'EMPTY_AUDIO', 'The recording is empty or too short.');
    try {
      const t = await stt.transcribe({ bytes: new Uint8Array(bytes), filename: `voice-note${ext}` }, AbortSignal.timeout(60_000));
      if (!t.text.trim()) throw new HttpError(422, 'NO_SPEECH', 'No speech was recognized. Try again or type your message.');
      const view: TranscriptView = { text: t.text, language: t.language, durationSec: t.durationSec, lowConfidence: t.lowConfidence };
      send(res, 200, view);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof VoiceInputError) throw new HttpError(400, err.code, err.message);
      throw new HttpError(502, 'STT_UNAVAILABLE', 'Transcription is unavailable right now. Try again shortly or type your message.');
    }
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (!deps.staticDir || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const root = path.resolve(deps.staticDir);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    let file = path.resolve(root, `.${decoded}`);
    if (!file.startsWith(root + path.sep) && file !== root) return false;
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
    if (!existsSync(file)) return false;
    const type = STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream';
    const immutable = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, {
      ...SECURITY_HEADERS, 'content-type': type,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
    return true;
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    const method = req.method ?? 'GET';
    try {
      if (!allowedHostnames.has(hostnameOf(req.headers.host))) {
        throw new HttpError(421, 'MISDIRECTED_REQUEST', 'This server does not answer for that host name.');
      }
      if (!pathname.startsWith('/api/')) {
        if (!serveStatic(req, res, pathname)) send(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') assertSameOrigin(req);

      // Only GET /api/status issues a new anonymous owner. Issuing on every cookie-less request let a fresh browser's
      // parallel startup requests receive different owners (the last Set-Cookie won), so a conversation could be
      // created under one owner and continued under another (live bug, 404 on the first turn).
      let ownerId = sessions.verify(req);
      if (!ownerId) {
        if (method !== 'GET' || pathname !== '/api/status') {
          throw new HttpError(401, 'SESSION_REQUIRED', 'No browser session yet. Load /api/status first.');
        }
        const issued = sessions.issue(req.headers['x-forwarded-proto'] === 'https');
        ownerId = issued.ownerId;
        res.setHeader('set-cookie', issued.cookie);
      }

      const route = `${method} ${pathname}`;
      if (route === 'GET /api/status') return send(res, 200, status);
      if (route === 'GET /api/conversations') return send(res, 200, { conversations: await app.conversations.list(ownerId) });
      if (route === 'POST /api/conversations') {
        const body = await readJson(req, z.object({ locale: z.enum(['ar-EG', 'en']).optional() }));
        return send(res, 201, { id: await app.conversations.create(ownerId, body.locale ?? 'ar-EG') });
      }
      let m = /^\/api\/conversations\/(conv_[0-9a-f-]{36})(\/turns)?$/.exec(pathname);
      if (m?.[1]) {
        const conversationId = m[1];
        if (m[2] && method === 'POST') return await runTurn(req, res, ownerId, conversationId);
        if (!m[2] && method === 'GET') return send(res, 200, await conversationView(conversationId, ownerId));
        if (!m[2] && method === 'DELETE') {
          await app.conversations.delete(conversationId, ownerId);
          return send(res, 204, null);
        }
      }
      m = /^\/api\/turns\/(tr_[0-9a-f]{16})\/cancel$/.exec(pathname);
      if (m?.[1] && method === 'POST') {
        const turn = running.get(m[1]);
        if (!turn || turn.ownerId !== ownerId) throw new HttpError(404, 'NOT_FOUND', 'No running turn with that id.');
        turn.abort.abort();
        return send(res, 202, { canceled: true });
      }
      m = /^\/api\/approvals\/([0-9a-f-]{36})$/.exec(pathname);
      if (m?.[1] && method === 'POST') {
        const { approved } = await readJson(req, ApprovalDecisionSchema);
        const ok = await app.approvals.decide(m[1], ownerId, approved);
        if (!ok) throw new HttpError(409, 'APPROVAL_NOT_PENDING', 'This request was already decided or has expired. Ask the assistant again if needed.');
        return send(res, 200, { decided: approved ? 'approved' : 'declined' });
      }
      if (route === 'GET /api/memory') {
        const conv = url.searchParams.get('conversationId');
        return send(res, 200, await memoryState(ownerId, conv && /^conv_[0-9a-f-]{36}$/.test(conv) ? conv : null));
      }
      if (route === 'POST /api/memory/consent') {
        const body = await readJson(req, MemoryConsentRequestSchema);
        if (body.conversationId) await app.conversations.assertOwner(body.conversationId, ownerId);
        await app.conversations.ensureCustomer(ownerId);
        if (body.decision === 'grant') await app.consents.grant(ownerId, 'long_term_memory', { conversationId: body.conversationId });
        else if (body.conversationId) await app.consents.decline(ownerId, body.conversationId);
        return send(res, 200, await memoryState(ownerId, body.conversationId));
      }
      if (route === 'DELETE /api/memory/consent') {
        const out = await app.consents.revoke(ownerId, 'long_term_memory');
        return send(res, 200, { revoked: out.revoked, deletedMemories: out.deletedMemories });
      }
      if (route === 'DELETE /api/memory/items') return send(res, 200, { deleted: await app.memory.forget(ownerId, { kind: 'all' }) });
      m = /^\/api\/memory\/items\/([0-9a-f-]{36})$/.exec(pathname);
      if (m?.[1] && method === 'DELETE') {
        const deleted = await app.memory.forget(ownerId, { kind: 'item', itemId: m[1] });
        if (deleted === 0) throw new HttpError(404, 'NOT_FOUND', 'That saved preference does not exist.');
        return send(res, 200, { deleted });
      }
      if (route === 'GET /api/crm') {
        const records: CrmList['records'] = await app.crm.listForOwner(ownerId);
        return send(res, 200, { records });
      }
      if (route === 'DELETE /api/crm') return send(res, 200, await app.crm.deleteForOwner(ownerId));
      if (route === 'POST /api/voice/transcribe') return await transcribe(req, res, ownerId);
      throw new HttpError(404, 'NOT_FOUND', 'Unknown API route.');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: { code: err.code, message: err.message } });
      if (err instanceof ConversationAccessError) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Conversation not found.' } });
      // Never leak internals (SQL, provider messages, stack traces) to the browser.
      return send(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server. Please try again.' } });
    }
  };
}
