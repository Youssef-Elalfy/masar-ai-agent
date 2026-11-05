import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { maskName, maskPhone, normalizePhone } from '../server/src/crm/contact.ts';
import { CrmError, CrmService } from '../server/src/crm/crm-service.ts';
import { ConsentStore } from '../server/src/memory/consent-store.ts';
import { MemoryService } from '../server/src/memory/memory-service.ts';
import { seedDemoCatalog } from '../server/src/db/seed.ts';
import { PiiCipher } from '../server/src/security/pii-crypto.ts';
import { ScriptedProvider, final, testApp, toolResultPayload, toolUse } from './helpers.ts';
import { createTestSql } from './pglite-sql.ts';

const KEY = randomBytes(32).toString('base64');
const sql = await createTestSql();
const consents = new ConsentStore(sql);
await seedDemoCatalog(sql);
const crm = new CrmService(sql, consents, new PiiCipher(KEY));
const ensureCustomer = (owner: string) => sql.query('insert into public.customers (owner_id) values ($1) on conflict do nothing', [owner]);
const LEAD = { name: 'Ahmed Hassan', phone: '٠١٠١٢٣٤٥٦٧٨', destination: 'Fayoum', dateRange: 'December 2026', adults: 2, budgetAmount: 7000, budgetCurrency: 'EGP' };
const Payload = z.looseObject({ ok: z.boolean(), error: z.looseObject({ code: z.string() }).optional(), result: z.looseObject({ status: z.string(), reference: z.string(), id: z.string(), note: z.string() }).optional() });

test('phone normalization (Egyptian local/intl, Arabic digits) and masking', () => {
  for (const raw of ['01012345678', '+20 10 1234 5678', '00201012345678', '٠١٠١٢٣٤٥٦٧٨', '1012345678']) assert.equal(normalizePhone(raw), '+201012345678', raw);
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  for (const bad of ['12345', '0101234567', 'call me', '01312345678']) assert.equal(normalizePhone(bad), null, bad);
  assert.equal(maskPhone('+201012345678'), '+20 10••••••78');
  assert.equal(maskName('Ahmed Hassan'), 'A•••• H•••••');
});

test('field encryption: AES-256-GCM round trip, tamper and wrong-key detection', () => {
  const cipher = new PiiCipher(KEY);
  const enc = cipher.encrypt('+201012345678');
  assert.ok(enc.startsWith('enc:v1:') && !enc.includes('1012345678'));
  assert.notEqual(enc, cipher.encrypt('+201012345678'), 'random IV per value');
  assert.equal(cipher.decrypt(enc), '+201012345678');
  assert.throws(() => cipher.decrypt(`${enc.slice(0, -4)}AAAA`));
  assert.throws(() => new PiiCipher(randomBytes(32).toString('base64')).decrypt(enc));
  assert.throws(() => new PiiCipher('c2hvcnQ='));
});

test('leads: contact fields encrypted at rest, consent recorded, idempotent (T042), owner-scoped', async () => {
  await ensureCustomer('crm-a');
  const first = await crm.createLead('crm-a', LEAD, { conversationId: 'conv-a', approvalId: null });
  assert.equal(first.created, true);
  assert.match(first.reference, /^RL-[0-9A-F]{8}$/);
  const [row] = await sql.query('select contact_name, contact_phone, consent_id from public.leads where id = $1', [first.id]);
  assert.ok(String(row?.['contact_phone']).startsWith('enc:v1:') && !String(row?.['contact_phone']).includes('1012345678'));
  assert.ok(!String(row?.['contact_name']).includes('Ahmed'));
  assert.ok((await consents.active('crm-a', 'lead_creation'))?.id === row?.['consent_id']);
  // Same request again (e.g. sent twice by mistake) → same record, no duplicate.
  const again = await crm.createLead('crm-a', { ...LEAD, phone: '+20 10 1234 5678' }, { conversationId: 'conv-a', approvalId: null });
  assert.deepEqual([again.created, again.id], [false, first.id]);
  const [count] = await sql.query(`select count(*)::int as n from public.leads where owner_id = 'crm-a'`);
  assert.equal(count?.['n'], 1);
  // Another customer can neither find nor reference it.
  assert.equal(await crm.findLead('crm-b', LEAD), null);
  await ensureCustomer('crm-b');
  await assert.rejects(crm.createQuoteRequest('crm-b', { leadId: first.id, summary: 'Fayoum for two in December' }, { approvalId: null }), (e: unknown) => e instanceof CrmError && e.code === 'NEEDS_LEAD');
});

test('quote requests: linked to the owner\'s lead, idempotent, package must exist', async () => {
  await ensureCustomer('crm-q');
  await crm.createLead('crm-q', LEAD, { conversationId: 'c', approvalId: null });
  const q1 = await crm.createQuoteRequest('crm-q', { packageId: 'pkg-fayoum-001', summary: 'Fayoum, 2 adults, December 2026, budget 7000 EGP' }, { approvalId: null });
  const q2 = await crm.createQuoteRequest('crm-q', { packageId: 'pkg-fayoum-001', summary: 'Fayoum, 2 adults, December 2026, budget 7000 EGP' }, { approvalId: null });
  assert.deepEqual([q1.created, q2.created, q2.id], [true, false, q1.id]);
  assert.match(q1.reference, /^RQ-/);
  await assert.rejects(crm.createQuoteRequest('crm-q', { packageId: 'pkg-made-up', summary: 'something long enough' }, { approvalId: null }), (e: unknown) => e instanceof CrmError && e.code === 'NOT_FOUND');
  const mine = await crm.listForOwner('crm-q');
  assert.deepEqual(mine.map((r) => r.kind), ['lead', 'quote']);
  assert.match(mine[0]?.detail ?? '', /^\+20 10•+78/);
});

test('without PII_ENCRYPTION_KEY, leads are refused (never stored in plaintext)', async () => {
  const off = new CrmService(sql, consents, null);
  assert.equal(off.enabled, false);
  await assert.rejects(off.createLead('crm-a', LEAD, { conversationId: 'c', approvalId: null }), (e: unknown) => e instanceof CrmError && e.code === 'NOT_CONFIGURED');
});

test('deleting CRM data withdraws consent; erase-all cascades', async () => {
  await ensureCustomer('crm-d');
  await crm.createLead('crm-d', LEAD, { conversationId: 'c', approvalId: null });
  await crm.requestHandoff('crm-d', { reason: 'custom group itinerary', summary: 'Group of 12 wants Fayoum + Siwa' }, { conversationId: 'c', approvalId: null });
  assert.deepEqual(await crm.deleteForOwner('crm-d'), { leads: 1, quotes: 0, handoffs: 1 });
  assert.equal(await consents.active('crm-d', 'lead_creation'), null);
  await crm.createLead('crm-d', LEAD, { conversationId: 'c', approvalId: null });
  await new MemoryService(sql, consents, null).eraseAll('crm-d');
  const [row] = await sql.query(`select count(*)::int as n from public.leads where owner_id = 'crm-d'`);
  assert.equal(row?.['n'], 0);
});

test('T040/T041/T042 through the agent: approval with masked preview → stored lead + quote; repeats need no new approval', async () => {
  const owner = 'crm-agent';
  const leadArgs = { name: 'Ahmed Hassan', phone: '01012345678', destination: 'Fayoum', dateRange: 'December 2026', adults: 2 };
  const quoteArgs = { packageId: 'pkg-fayoum-001', summary: 'Fayoum program for 2 adults in December 2026' };
  const provider = new ScriptedProvider((req, i) => {
    switch (i) {
      case 0: return toolUse({ id: 'l1', name: 'create_lead', input: leadArgs });
      case 1: assert.equal(Payload.parse(toolResultPayload(req, 'l1')).error?.code, 'APPROVAL_REQUIRED'); return final('هيظهرلك طلب موافقة بالبيانات اللي هتتحفظ.');
      case 2: return toolUse({ id: 'l2', name: 'create_lead', input: leadArgs }, { id: 'q1', name: 'create_quote_request', input: quoteArgs });
      case 3: return final('تمام');
      case 4: return toolUse({ id: 'q2', name: 'create_quote_request', input: quoteArgs });
      case 5: return final('done');
      case 6: return toolUse({ id: 'l3', name: 'create_lead', input: leadArgs }, { id: 'q3', name: 'create_quote_request', input: quoteArgs });
      default: return final('موجود قبل كده');
    }
  });
  const app = await testApp(provider, { piiEncryptionKey: KEY });
  const conv = await app.conversations.create(owner);

  // T040: nothing stored without the customer's approval; the preview is masked.
  const t1 = await app.runtime.runTurn({ conversationId: conv, ownerId: owner, userText: 'اسمي أحمد ورقمي 01012345678 وعايز الفيوم، خد رقمي وحطه في الـCRM' });
  const [pending] = t1.pendingApprovals;
  assert.ok(pending);
  assert.equal(z.looseObject({ phone: z.string() }).parse(pending.argsPreview).phone, '+20 10••••••78');
  assert.ok(!JSON.stringify(pending.argsPreview).includes('Ahmed'));
  const [stored] = await app.sql.query('select args_preview from public.approvals where id = $1', [pending.approvalId]);
  assert.ok(!JSON.stringify(stored?.['args_preview']).includes('1012345678'));
  assert.equal((await app.crm.listForOwner(owner)).length, 0);

  // T041: the customer approves the lead; the quote then needs its own approval.
  await app.approvals.decide(pending.approvalId, owner, true);
  const t2 = await app.runtime.runTurn({ conversationId: conv, ownerId: owner, userText: 'موافق، واعمل طلب عرض سعر لرحلة الفيوم' });
  assert.deepEqual(t2.toolCalls.map((t) => [t.name, t.outcome, t.errorCode]), [['create_lead', 'ok', null], ['create_quote_request', 'error', 'APPROVAL_REQUIRED']]);
  const quoteApproval = t2.pendingApprovals.find((p) => p.toolName === 'create_quote_request');
  assert.ok(quoteApproval);
  await app.approvals.decide(quoteApproval.approvalId, owner, true);
  const t3 = await app.runtime.runTurn({ conversationId: conv, ownerId: owner, userText: 'أيوه' });
  assert.equal(t3.toolCalls[0]?.outcome, 'ok');
  const created = Payload.parse(toolResultPayload(provider.requests[5] ?? provider.requests[4]!, 'q2')).result;
  assert.equal(created?.status, 'created');
  assert.match(created?.note ?? '', /no real staff member will call/);

  // T042: the same lead/quote again → returned as existing, no new approval, no duplicate.
  const t4 = await app.runtime.runTurn({ conversationId: conv, ownerId: owner, userText: 'اعمل نفس الطلب تاني' });
  assert.deepEqual(t4.pendingApprovals, []);
  assert.deepEqual(t4.toolCalls.map((t) => t.outcome), ['ok', 'ok']);
  const statuses = ['l3', 'q3'].map((id) => Payload.parse(toolResultPayload(provider.requests[7]!, id)).result?.status);
  assert.deepEqual(statuses, ['already_exists', 'already_exists']);
  const kinds = (await app.crm.listForOwner(owner)).map((r) => r.kind);
  assert.deepEqual(kinds, ['lead', 'quote']);

  // Traces keep only key names + hash for these writes.
  const traced = await app.tracer.toolExecutions(t2.traceId);
  assert.ok(traced.every((t) => !JSON.stringify(t.inputRedacted).includes('1012345678')));
});

test('invalid phone is rejected before any approval is requested', async () => {
  const provider = new ScriptedProvider((req, i) => (i === 0
    ? toolUse({ id: 'bad', name: 'create_lead', input: { name: 'Mona', phone: '12345' } })
    : (assert.equal(Payload.parse(toolResultPayload(req, 'bad')).error?.code, 'VALIDATION_ERROR'), final('الرقم مش مظبوط'))));
  const app = await testApp(provider, { piiEncryptionKey: KEY });
  const t = await app.runtime.runTurn({ conversationId: await app.conversations.create('crm-bad'), ownerId: 'crm-bad', userText: 'رقمي 12345' });
  assert.deepEqual(t.pendingApprovals, []);
});

test('live finding: reworded repeats are still recognized (lead = phone, quote = lead + package/destination)', async () => {
  await ensureCustomer('crm-para');
  const lead = await crm.createLead('crm-para', { ...LEAD, dateRange: 'ديسمبر 2026' }, { conversationId: 'c', approvalId: null });
  const leadAgain = await crm.createLead('crm-para', { ...LEAD, dateRange: 'December 2026', notes: 'same person, reworded' }, { conversationId: 'c', approvalId: null });
  assert.deepEqual([leadAgain.created, leadAgain.id], [false, lead.id]);
  const q = await crm.createQuoteRequest('crm-para', { packageId: 'pkg-fayoum-001', summary: 'طلب عرض سعر لبرنامج مغامرة الفيوم لشخصين بالغين في ديسمبر 2026' }, { approvalId: null });
  assert.equal((await crm.findQuote('crm-para', { packageId: 'pkg-fayoum-001', summary: 'نفس الطلب: الفيوم لاتنين، شهر 12' }))?.id, q.id);
  const custom = await crm.createQuoteRequest('crm-para', { destination: 'Turkey', summary: 'Istanbul 7 days for two adults' }, { approvalId: null });
  assert.equal((await crm.findQuote('crm-para', { destination: 'turkey', summary: 'Turkey week, 2 people' }))?.id, custom.id);
  assert.notEqual(custom.id, q.id);
});
