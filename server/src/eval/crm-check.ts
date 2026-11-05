import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, loadConfig, loadDotEnv } from '../config.ts';
import { createApp, createEmbeddings, createProvider } from '../app.ts';
import { connectDatabase } from '../db/connect.ts';

// Live M4 check: real agent + Supabase CRM. The script plays the customer: it sends the turns below and
// approves each pending write (logged). Afterwards it verifies encryption at rest, linkage, idempotency
// and reply honesty, then erases all test data. Never prints keys, connection strings or plaintext contact data.
// Usage: npm run crm:check -- --confirm [--keep]

const TEST_PHONE_LOCAL = '01000000000'; // placeholder test number; stored encrypted and erased afterwards
const TURNS = [
  `اسمي تجربة رحال ورقمي ${TEST_PHONE_LOCAL}، عايز عرض سعر لبرنامج الفيوم لشخصين بالغين في ديسمبر 2026. احفظ بياناتي واعمل طلب عرض السعر.`,
  'موافق، كمل.',
  'تمام، كمل لو فيه حاجة ناقصة.',
];
const REPEAT = 'اعمل نفس طلب عرض السعر تاني من فضلك.';

loadDotEnv();
const config = loadConfig();
const provider = createProvider(config, { onFallback: (e) => console.log(`   ⇄ fallback: ${e.from} → ${e.to ?? 'none'} (${e.reason})`) });
if (!provider || !config.piiEncryptionKey) {
  console.error(`Cannot run: ${!provider ? config.providerIssue : 'PII_ENCRYPTION_KEY is not set.'}`);
  process.exit(1);
}
console.log(`M4 live check on Supabase with ${provider.model}: ~${TURNS.length + 1} turns (free tier). Test data is erased at the end${process.argv.includes('--keep') ? ' (--keep: NOT erased)' : ''}.`);
if (!process.argv.includes('--confirm')) {
  console.log('Dry run only. Re-run with --confirm.');
  process.exit(0);
}
const db = connectDatabase(config);
if ('error' in db) {
  console.error(db.error);
  process.exit(1);
}

const app = await createApp(config, provider, db.sql, createEmbeddings(config));
const ownerId = `crm-check-${new Date().toISOString().replace(/[:.]/g, '-')}`;
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};
const replies: string[] = [];
const approvalsGranted: string[] = [];

try {
  const conversationId = await app.conversations.create(ownerId, 'ar-EG');
  const say = async (label: string, text: string) => {
    const turn = await app.runtime.runTurn({ conversationId, ownerId, userText: text });
    replies.push(turn.text);
    console.log(`\n── ${label} [${turn.status}] ${turn.latencyMs} ms · tools: ${turn.toolCalls.map((t) => `${t.name}(${t.errorCode ?? t.outcome})`).join(', ') || 'none'}`);
    console.log(`   reply: ${turn.text.replace(/\s+/g, ' ').slice(0, 400)}`);
    return turn;
  };
  for (const [i, text] of TURNS.entries()) {
    const turn = await say(`turn ${i + 1}`, text);
    for (const p of turn.pendingApprovals) {
      // The test customer approves; the preview shown is what a real customer would see.
      const preview = JSON.stringify(p.argsPreview);
      check(!preview.includes(TEST_PHONE_LOCAL.slice(3)) && !preview.includes('تجربة رحال'), `approval preview for ${p.toolName} is masked`, preview.slice(0, 160));
      approvalsGranted.push(p.toolName);
      await app.approvals.decide(p.approvalId, ownerId, true);
    }
    const kinds = (await app.crm.listForOwner(ownerId)).map((r) => r.kind);
    if (kinds.includes('lead') && kinds.includes('quote') && turn.pendingApprovals.length === 0) break;
  }
  // T042 live: asking for the same quote again must not create a duplicate or need a new approval.
  const repeat = await say('repeat request', REPEAT);
  check(repeat.pendingApprovals.length === 0, 'repeat request needs no new approval (idempotent)', `${repeat.pendingApprovals.length} pending`);
  check(!repeat.toolCalls.some((t) => t.errorCode === 'APPROVAL_REQUIRED'), 'repeat request triggered no approval prompt');
  console.log(`\nApprovals granted by the test customer: ${approvalsGranted.join(', ') || 'none'}`);

  // ── Verification on the stored data (read-only queries) ──
  const leads = await app.sql.query('select id, contact_name, contact_phone, consent_id, approval_id from public.leads where owner_id = $1', [ownerId]);
  const quotes = await app.sql.query('select id, lead_id, package_id, approval_id from public.quote_requests where owner_id = $1', [ownerId]);
  check(leads.length === 1, 'exactly one lead stored', `${leads.length}`);
  check(quotes.length === 1, 'exactly one quote request stored', `${quotes.length}`);
  const lead = leads[0];
  const enc = (v: unknown) => typeof v === 'string' && v.startsWith('enc:v1:') && !v.includes(TEST_PHONE_LOCAL.slice(1)) && !v.includes('رحال');
  check(lead !== undefined && enc(lead['contact_name']) && enc(lead['contact_phone']), 'contact name and phone encrypted at rest (no plaintext in the row)');
  check(lead !== undefined && lead['consent_id'] !== null && lead['approval_id'] !== null, 'lead carries consent + approval evidence');
  const quote = quotes[0];
  check(quote !== undefined && quote['lead_id'] === lead?.['id'], 'quote request linked to the lead', `package=${String(quote?.['package_id'] ?? 'custom')}`);
  check(quote !== undefined && quote['approval_id'] !== null, 'quote request carries approval evidence');
  const consent = await app.consents.active(ownerId, 'lead_creation');
  check(consent !== null, 'lead_creation consent recorded');
  const mine = await app.crm.listForOwner(ownerId);
  console.log(`Customer view (/leads):\n${mine.map((r) => `  • ${r.kind} ${r.reference} [${r.status}] ${r.detail}`).join('\n')}`);
  check(mine.some((r) => r.kind === 'lead' && /^\+20 10•+00 ·/.test(r.detail)), 'customer view shows the phone masked');
  const staff = await app.crm.staffList(false);
  const staffMine = staff.filter((s) => mine.some((m) => m.reference === s['reference']));
  console.log(`Staff view (masked): ${JSON.stringify(staffMine)}`);
  check(staffMine.length === 1 && !JSON.stringify(staffMine).includes(TEST_PHONE_LOCAL.slice(3)), 'staff view masked by default');
  const refs = mine.map((r) => r.reference);
  const allReplies = replies.join('\n');
  check(refs.some((r) => allReplies.includes(r)), 'agent gave the customer a stored reference number', refs.join(', '));
  check(/(تجريبي|تجريبية|demo|DEMO|مش حجز|ليس حجز|not a booking)/i.test(allReplies), 'agent says it is a demo / not a booking');
  check(!/(تم الحجز|حجزتلك|اتحجز|booking confirmed|تم الدفع|هيكلمك دلوقتي)/i.test(allReplies), 'agent never claims booking/payment/immediate callback');
  const traced = await app.sql.query(
    `select t.input_redacted from public.tool_executions t join public.agent_runs r on r.trace_id = t.trace_id
     where r.owner_id = $1 and t.tool_name in ('create_lead', 'create_quote_request')`,
    [ownerId],
  );
  check(traced.length > 0 && traced.every((t) => !JSON.stringify(t['input_redacted']).includes(TEST_PHONE_LOCAL.slice(3))), 'traces hold no contact data (keys + hash only)', `${traced.length} trace row(s)`);

  const dir = path.join(PROJECT_ROOT, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `crm-check-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify({ ranAt: new Date().toISOString(), model: provider.model, ownerId, approvalsGranted, references: refs, replies, failures }, null, 2)}\n`);
  console.log(`Report: ${path.relative(PROJECT_ROOT, file)}`);
} finally {
  if (!process.argv.includes('--keep')) {
    await app.memory.eraseAll(ownerId);
    const [left] = await app.sql.query(
      `select (select count(*) from public.leads where owner_id = $1)::int + (select count(*) from public.quote_requests where owner_id = $1)::int
            + (select count(*) from public.conversations where owner_id = $1)::int + (select count(*) from public.consents where owner_id = $1)::int as n`,
      [ownerId],
    );
    check(left?.['n'] === 0, 'test data erased (leads, quotes, conversations, consents)');
  }
  await app.sql.close();
}
console.log(failures === 0 ? 'All M4 live checks passed.' : `${failures} M4 live check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
