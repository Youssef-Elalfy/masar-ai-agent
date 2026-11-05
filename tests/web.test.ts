import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { App } from '../server/src/app.ts';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../server/src/agent/providers/types.ts';
import { GROUNDING_NOTE } from '../server/src/agent/grounding.ts';
import { ConversationViewSchema, TurnEventSchema, type TurnEvent } from '../server/src/web/contracts.ts';
import { createWebHandler, type WebDeps } from '../server/src/web/server.ts';
import { OwnerSessions } from '../server/src/web/session.ts';
import type { SpeechToText } from '../server/src/voice/stt.ts';
import { ScriptedProvider, final, testApp, toolUse } from './helpers.ts';

interface Harness {
  app: App;
  base: string;
  server: Server;
  close: () => Promise<void>;
}

async function start(provider: LLMProvider, opts: { stt?: SpeechToText | null; staticDir?: string | null; limits?: WebDeps['limits']; pii?: boolean } = {}): Promise<Harness> {
  const app = await testApp(provider, opts.pii ? { piiEncryptionKey: randomBytes(32).toString('base64') } : {});
  const handler = createWebHandler({
    app,
    stt: opts.stt ?? null,
    sessions: new OwnerSessions(randomBytes(32)),
    staticDir: opts.staticDir ?? null,
    status: { company: { name: app.company.name, fictional: true }, model: provider.model, freeTierOnly: true, features: { voiceNotes: !!opts.stt, webResearch: false, crm: app.crm.enabled, memoryRetrieval: app.memory.retrievalBackend } },
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    app, base, server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.sql.close();
    },
  };
}

/** A browser session: keeps the owner cookie and sends the client header like the real console. */
function client(base: string) {
  let cookie = '';
  const call = async (method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> => {
    // Like the real console: the session (owner cookie) is bootstrapped through GET /api/status first.
    if (!cookie && pathname !== '/api/status') await call('GET', '/api/status');
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'x-rahhal-client': 'web', ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0] ?? '';
    return res;
  };
  return {
    call,
    get cookie() { return cookie; },
    set cookie(v: string) { cookie = v; },
    async json<T = unknown>(method: string, pathname: string, body?: unknown): Promise<{ status: number; body: T }> {
      const res = await call(method, pathname, body);
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
    },
    async turn(conversationId: string, text: string): Promise<TurnEvent[]> {
      const res = await call('POST', `/api/conversations/${conversationId}/turns`, { text });
      assert.equal(res.status, 200, await res.clone().text());
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      const raw = await res.text();
      return raw.split('\n\n').filter((chunk) => chunk.startsWith('data: ')).map((chunk) => TurnEventSchema.parse(JSON.parse(chunk.slice(6))));
    },
  };
}

const newConversation = async (c: ReturnType<typeof client>) => (await c.json<{ id: string }>('POST', '/api/conversations', {})).body.id;

test('status exposes features but no secrets; every browser gets its own signed owner cookie', async () => {
  const h = await start(new ScriptedProvider(() => final('hi')));
  try {
    const c = client(h.base);
    const status = await c.json<Record<string, unknown>>('GET', '/api/status');
    assert.equal(status.status, 200);
    assert.doesNotMatch(JSON.stringify(status.body), /apiKey|DATABASE_URL|postgres:\/\//i);
    assert.match(c.cookie, /^rahhal_owner=web_[0-9a-f-]{36}\./);
    const first = c.cookie;
    await c.json('GET', '/api/conversations');
    assert.equal(c.cookie, first, 'a valid cookie is kept');
    c.cookie = `${first.slice(0, -3)}AAA`; // tampered signature
    await c.json('GET', '/api/conversations');
    assert.notEqual(c.cookie, first, 'a tampered cookie is replaced by a fresh owner');
  } finally {
    await h.close();
  }
});

test('state-changing requests need the client header and same origin (CSRF)', async () => {
  const h = await start(new ScriptedProvider(() => final('hi')));
  try {
    const noHeader = await fetch(`${h.base}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403);
    const crossOrigin = await fetch(`${h.base}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rahhal-client': 'web', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(crossOrigin.status, 403);
    const c = client(h.base);
    await c.call('GET', '/api/status');
    const sameOrigin = await fetch(`${h.base}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rahhal-client': 'web', origin: h.base, cookie: c.cookie }, body: '{}' });
    assert.equal(sameOrigin.status, 201);
  } finally {
    await h.close();
  }
});

/** Raw HTTP request with an arbitrary Host header (fetch does not allow setting Host). */
function rawRequest(base: string, opts: { method: string; path: string; host: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; setCookie: string | undefined }> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: Number(port), method: opts.method, path: opts.path, headers: { host: opts.host, ...(opts.headers ?? {}) } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, setCookie: res.headers['set-cookie']?.[0] }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

test('DNS-rebinding guard: only allowed host names are served; a rebound hostile domain gets nothing', async () => {
  const h = await start(new ScriptedProvider(() => final('hi')));
  try {
    const port = new URL(h.base).port;
    // A hostile page whose domain now resolves to 127.0.0.1: its Origin equals its Host, so the same-origin check
    // alone would pass. The Host allowlist refuses it before any session, static file or API work.
    const status = await rawRequest(h.base, { method: 'GET', path: '/api/status', host: `evil.example:${port}` });
    assert.equal(status.status, 421);
    assert.equal(status.setCookie, undefined, 'no owner session is issued to a foreign host');
    const post = await rawRequest(h.base, {
      method: 'POST', path: '/api/conversations', host: `evil.example:${port}`,
      headers: { 'content-type': 'application/json', 'x-rahhal-client': 'web', origin: `http://evil.example:${port}` }, body: '{}',
    });
    assert.equal(post.status, 421);
    assert.equal((await rawRequest(h.base, { method: 'GET', path: '/', host: `evil.example:${port}` })).status, 421);
    // Loopback names keep working, with any port.
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      assert.equal((await rawRequest(h.base, { method: 'GET', path: '/api/status', host })).status, 200, host);
    }
  } finally {
    await h.close();
  }
});

test('a turn streams real tool events and returns cards built from the stored catalog result', async () => {
  const provider = new ScriptedProvider((req, i) => {
    if (i === 0) return toolUse({ id: 's1', name: 'search_company_packages', input: { query: 'شرم الشيخ' } });
    return final('لقيت برنامج شرم الشيخ (DEMO).');
  });
  const h = await start(provider);
  try {
    const c = client(h.base);
    const id = await newConversation(c);
    const events = await c.turn(id, 'عايز شرم');
    const types = events.map((e) => e.type);
    assert.deepEqual(types.slice(0, 1), ['ack']);
    assert.ok(types.indexOf('tool_started') < types.indexOf('tool_finished'), types.join(','));
    assert.equal(types.at(-1), 'final');
    const finalEvent = events.at(-1);
    assert.ok(finalEvent?.type === 'final');
    assert.equal(finalEvent.outcome.status, 'completed');
    const assistant = finalEvent.conversation.items.at(-1);
    assert.ok(assistant?.role === 'assistant');
    assert.deepEqual(assistant.activity, [{ toolName: 'search_company_packages', outcome: 'ok', errorCode: null, filters: { query: 'شرم الشيخ' } }]);
    const card = assistant.cards.find((x) => x.kind === 'company_package');
    assert.ok(card?.kind === 'company_package');
    const [stored] = await h.app.catalog.resolve(card.id);
    assert.equal(card.price.amount, stored?.price.amount, 'card price is the DB price');
    assert.equal(card.price.currency, stored?.price.currency);
    assert.equal(card.sourceType, 'company_demo');

    // Reloading the conversation yields the same view (cards rebuilt from history, no new tool call).
    const before = provider.requests.length;
    const reloaded = await c.json('GET', `/api/conversations/${id}`);
    assert.deepEqual(ConversationViewSchema.parse(reloaded.body), finalEvent.conversation);
    assert.equal(provider.requests.length, before);

    const list = await c.json<{ conversations: Array<{ id: string; title: string | null; userTurns: number }> }>('GET', '/api/conversations');
    assert.deepEqual(list.body.conversations.map((x) => [x.id, x.title, x.userTurns]), [[id, 'عايز شرم', 1]]);
  } finally {
    await h.close();
  }
});

test('owners are isolated: another browser cannot read, continue or delete a conversation', async () => {
  const h = await start(new ScriptedProvider(() => final('ok')));
  try {
    const alice = client(h.base);
    const mallory = client(h.base);
    const id = await newConversation(alice);
    assert.equal((await mallory.json('GET', `/api/conversations/${id}`)).status, 404);
    assert.equal((await mallory.call('POST', `/api/conversations/${id}/turns`, { text: 'hi' })).status, 404);
    assert.equal((await mallory.call('DELETE', `/api/conversations/${id}`)).status, 404);
    assert.deepEqual((await mallory.json<{ conversations: unknown[] }>('GET', '/api/conversations')).body.conversations, []);
    assert.equal((await alice.json('GET', `/api/conversations/${id}`)).status, 200);
  } finally {
    await h.close();
  }
});

test('a draft held back by the grounding guard never appears in the view', async () => {
  const provider = new ScriptedProvider((req, i) => {
    if (i === 0) return final('راجعت الكتالوج: مفيش شرم.');
    if (i === 1) return toolUse({ id: 's1', name: 'search_company_packages', input: { query: 'Sharm' } });
    return final('شرم موجودة في الكتالوج (DEMO).');
  });
  const h = await start(provider);
  try {
    const c = client(h.base);
    const id = await newConversation(c);
    const events = await c.turn(id, 'Sharm?');
    assert.ok(events.some((e) => e.type === 'grounding_check'));
    const view = ConversationViewSchema.parse((await c.json('GET', `/api/conversations/${id}`)).body);
    assert.equal(view.items.length, 2);
    const assistant = view.items[1];
    assert.ok(assistant?.role === 'assistant');
    assert.equal(assistant.text, 'شرم موجودة في الكتالوج (DEMO).');
    assert.doesNotMatch(JSON.stringify(view), /مفيش شرم/);
    assert.doesNotMatch(JSON.stringify(view), new RegExp(GROUNDING_NOTE.slice(1, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await h.close();
  }
});

test('CRM writes wait for the customer: pending approval is listed, decided once, and owner-scoped', async () => {
  const lead = { name: 'Youssef Test', phone: '01012345678', destination: 'Sharm' };
  const provider = new ScriptedProvider((req, i) => (i === 0 ? toolUse({ id: 'l1', name: 'create_lead', input: lead }) : final('محتاج موافقتك الأول.')));
  const h = await start(provider, { pii: true });
  try {
    const c = client(h.base);
    const id = await newConversation(c);
    const events = await c.turn(id, 'سجلني');
    const fin = events.at(-1);
    assert.ok(fin?.type === 'final');
    const [pending] = fin.conversation.pendingApprovals;
    assert.ok(pending);
    const answer = fin.conversation.items.at(-1);
    assert.ok(answer?.role === 'assistant');
    assert.deepEqual(answer.activity.map((a) => [a.toolName, a.outcome, a.errorCode]), [['create_lead', 'pending', null]], 'waiting for approval is not shown as a failure');
    assert.equal(pending.toolName, 'create_lead');
    assert.doesNotMatch(JSON.stringify(pending.preview), /01012345678/, 'phone is masked in the preview');
    const leadsBefore = await c.json<{ records: unknown[] }>('GET', '/api/crm');
    assert.deepEqual(leadsBefore.body.records, [], 'nothing saved before approval');

    const other = client(h.base);
    assert.equal((await other.json('POST', `/api/approvals/${pending.approvalId}`, { approved: true })).status, 409);
    assert.equal((await c.json('POST', `/api/approvals/${pending.approvalId}`, { approved: true })).status, 200);
    assert.equal((await c.json('POST', `/api/approvals/${pending.approvalId}`, { approved: true })).status, 409, 'single decision');
    const after = ConversationViewSchema.parse((await c.json('GET', `/api/conversations/${id}`)).body);
    assert.deepEqual(after.pendingApprovals, []);
  } finally {
    await h.close();
  }
});

test('memory: consent is server state; preferences are listed only while consent is active', async () => {
  const h = await start(new ScriptedProvider(() => final('ok')));
  try {
    const c = client(h.base);
    const id = await newConversation(c);
    let state = await c.json<{ consent: string; items: unknown[]; consentText: { ar: string; en: string } }>('GET', `/api/memory?conversationId=${id}`);
    assert.equal(state.body.consent, 'off');
    assert.match(state.body.consentText.en, /Memory panel/);
    assert.doesNotMatch(state.body.consentText.en, /\/forget/);
    state = await c.json('POST', '/api/memory/consent', { decision: 'decline', conversationId: id });
    assert.equal(state.body.consent, 'declined');
    state = await c.json('POST', '/api/memory/consent', { decision: 'grant', conversationId: id });
    assert.equal(state.body.consent, 'active');
    const revoke = await c.json<{ revoked: boolean }>('DELETE', '/api/memory/consent');
    assert.equal(revoke.body.revoked, true);
    assert.equal((await c.json<{ consent: string }>('GET', '/api/memory')).body.consent, 'off');
    assert.equal((await c.json('DELETE', '/api/memory/items/00000000-0000-0000-0000-000000000000')).status, 404);
  } finally {
    await h.close();
  }
});

test('deleting a conversation removes it for its owner only', async () => {
  const h = await start(new ScriptedProvider(() => final('ok')));
  try {
    const c = client(h.base);
    const id = await newConversation(c);
    await c.turn(id, 'hello');
    assert.equal((await c.call('DELETE', `/api/conversations/${id}`)).status, 204);
    assert.equal((await c.json('GET', `/api/conversations/${id}`)).status, 404);
    assert.deepEqual((await c.json<{ conversations: unknown[] }>('GET', '/api/conversations')).body.conversations, []);
  } finally {
    await h.close();
  }
});

test('voice: unavailable without STT, validated formats, transcript from the real STT interface', async () => {
  const noVoice = await start(new ScriptedProvider(() => final('ok')));
  try {
    const res = await client(noVoice.base).call('POST', '/api/voice/transcribe', undefined, { 'content-type': 'audio/webm' });
    assert.equal(res.status, 503);
  } finally {
    await noVoice.close();
  }
  const received: Array<{ filename: string; size: number }> = [];
  const stt: SpeechToText = {
    label: 'test/stt',
    async transcribe(audio) {
      received.push({ filename: audio.filename, size: audio.bytes.byteLength });
      return { text: 'عايز الغردقة', language: 'arabic', durationSec: 2.5, lowConfidence: false, model: 'test' };
    },
  };
  const h = await start(new ScriptedProvider(() => final('ok')), { stt });
  try {
    const c = client(h.base);
    const audio = new Uint8Array(4096).fill(7);
    await c.call('GET', '/api/status');
    const bad = await fetch(`${h.base}/api/voice/transcribe`, { method: 'POST', headers: { 'x-rahhal-client': 'web', 'content-type': 'video/x-msvideo', cookie: c.cookie }, body: audio });
    assert.equal(bad.status, 415);
    const ok = await fetch(`${h.base}/api/voice/transcribe`, { method: 'POST', headers: { 'x-rahhal-client': 'web', 'content-type': 'audio/webm;codecs=opus', cookie: c.cookie }, body: audio });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { text: 'عايز الغردقة', language: 'arabic', durationSec: 2.5, lowConfidence: false });
    assert.deepEqual(received, [{ filename: 'voice-note.webm', size: 4096 }]);
  } finally {
    await h.close();
  }
});

test('turns are rate limited per browser (free-tier protection)', async () => {
  const h = await start(new ScriptedProvider(() => final('ok')), { limits: { turnsPerMinute: 1 } });
  try {
    const c = client(h.base);
    const id = await newConversation(c);
    await c.turn(id, 'one');
    const second = await c.call('POST', `/api/conversations/${id}/turns`, { text: 'two' });
    assert.equal(second.status, 429);
  } finally {
    await h.close();
  }
});

test('static files cannot escape the client build folder', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rahhal-dist-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>RAHHAL</title>');
  const h = await start(new ScriptedProvider(() => final('ok')), { staticDir: dir });
  try {
    const res = await fetch(`${h.base}/..%2F..%2Fpackage.json`);
    const body = await res.text();
    assert.doesNotMatch(body, /"dependencies"/);
    const index = await fetch(`${h.base}/`);
    assert.match(index.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(index.headers.get('x-frame-options'), 'DENY');
  } finally {
    await h.close();
  }
});

/** Waits until the request is aborted (a model that never answers in time). */
class HangingProvider implements LLMProvider {
  readonly id = 'hanging';
  readonly model = 'hanging';
  started: () => void = () => undefined;
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.started();
    // Like fetch: an already-aborted signal rejects immediately, otherwise on abort.
    return new Promise((_, reject) => {
      if (request.signal?.aborted) reject(new Error('aborted'));
      request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }
}

test('stop: canceling a running turn ends it as "canceled" with a consistent transcript', async () => {
  const provider = new HangingProvider();
  const app = await testApp(provider);
  try {
    const conversationId = await app.conversations.create('cancel-1');
    const controller = new AbortController();
    provider.started = () => controller.abort();
    const result = await app.runtime.runTurn({ conversationId, ownerId: 'cancel-1', userText: 'Stop me', signal: controller.signal });
    assert.equal(result.status, 'canceled');
    assert.equal(result.errorCode, 'CANCELED');
    assert.match(result.text, /Stopped/);
    const history = await app.conversations.load(conversationId, 'cancel-1');
    assert.equal(history.at(-1)?.role, 'assistant');
  } finally {
    await app.sql.close();
  }
});

test('stop over HTTP: the owner cancels a running turn and the stream delivers the stored "canceled" result', async () => {
  const provider = new HangingProvider();
  const h = await start(provider);
  try {
    const c = client(h.base);
    const mallory = client(h.base);
    const id = await newConversation(c);
    const res = await c.call('POST', `/api/conversations/${id}/turns`, { text: 'long question' });
    const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
    assert.ok(reader);
    let buffer = '';
    const events: TurnEvent[] = [];
    let canceled = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      for (let sep = buffer.indexOf('\n\n'); sep >= 0; sep = buffer.indexOf('\n\n')) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!chunk.startsWith('data: ')) continue;
        const event = TurnEventSchema.parse(JSON.parse(chunk.slice(6)));
        events.push(event);
        if (event.type === 'ack' && !canceled) {
          canceled = true;
          assert.equal((await mallory.call('POST', `/api/turns/${event.traceId}/cancel`, {})).status, 404, 'other owners cannot stop it');
          assert.equal((await c.call('POST', `/api/turns/${event.traceId}/cancel`, {})).status, 202);
        }
      }
    }
    const fin = events.at(-1);
    assert.ok(fin?.type === 'final');
    assert.equal(fin.outcome.status, 'canceled');
    const last = fin.conversation.items.at(-1);
    assert.ok(last?.role === 'assistant');
    assert.match(last.text, /Stopped as you asked/);
  } finally {
    await h.close();
  }
});

test('live regression: only GET /api/status issues an owner, so parallel first requests cannot split a browser across owners', async () => {
  const h = await start(new ScriptedProvider(() => final('ok')));
  try {
    const noSession = await fetch(`${h.base}/api/conversations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rahhal-client': 'web' }, body: '{}' });
    assert.equal(noSession.status, 401);
    assert.equal(noSession.headers.get('set-cookie'), null, 'no owner is issued outside /api/status');
    assert.match(await noSession.text(), /"code":"SESSION_REQUIRED"/);
    const list = await fetch(`${h.base}/api/conversations`);
    assert.equal(list.status, 401);
    // With the bootstrapped cookie, create + turn stay under the same owner (the failing live sequence).
    const c = client(h.base);
    const id = await newConversation(c);
    const events = await c.turn(id, 'hello');
    assert.equal(events.at(-1)?.type, 'final');
  } finally {
    await h.close();
  }
});
