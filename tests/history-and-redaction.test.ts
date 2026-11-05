import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairHistory } from '../server/src/agent/history.ts';
import type { ChatMessage } from '../server/src/agent/providers/types.ts';
import { redactText, redactValue } from '../server/src/observability/redact.ts';
import { localDate, localWeekday } from '../server/src/text/dates.ts';

const call = (id: string) => ({ type: 'tool_call' as const, id, name: 't', input: {} });
const result = (id: string) => ({ type: 'tool_result' as const, toolCallId: id, content: '{}', isError: false });

test('repairHistory answers dangling tool calls and drops orphan results', () => {
  const broken: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }, result('orphan')] },
    { role: 'assistant', content: [call('a'), call('b')] },
    { role: 'user', content: [result('a')] },
    { role: 'assistant', content: [call('c')] },
    { role: 'assistant', content: [{ type: 'text', text: 'fallback' }] },
  ];
  const fixed = repairHistory(broken);
  assert.deepEqual(fixed.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(fixed[0]?.content.map((b) => b.type), ['text']);
  const ids = (i: number) => fixed[i]?.content.flatMap((b) => (b.type === 'tool_result' ? [b.toolCallId] : []));
  assert.deepEqual(ids(2)?.sort(), ['a', 'b']);
  assert.deepEqual(ids(4), ['c']);
});

test('repairHistory leaves a valid transcript unchanged', () => {
  const ok: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [call('a')] },
    { role: 'user', content: [result('a')] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];
  assert.deepEqual(repairHistory(ok), ok);
});

test('redaction: Egyptian mobiles in Latin or Arabic-Indic digits, +intl numbers, emails, long IDs', () => {
  assert.equal(redactText('رقمي 01012345678'), 'رقمي [REDACTED_PHONE]');
  assert.equal(redactText('رقمي ٠١٠١٢٣٤٥٦٧٨'), 'رقمي [REDACTED_PHONE]');
  assert.equal(redactText('call +44 20 7946 0958'), 'call [REDACTED_PHONE]');
  assert.equal(redactText('mail me: x.y@site.org'), 'mail me: [REDACTED_EMAIL]');
  assert.equal(redactText('card 4111111111111111'), 'card [REDACTED_NUMBER]');
});

test('redaction keeps prices and dates readable', () => {
  assert.equal(redactText('13000 vs 15600 EGP on 2026-11-20'), '13000 vs 15600 EGP on 2026-11-20');
});

test('redaction masks PII-shaped keys anywhere in nested objects', () => {
  assert.deepEqual(redactValue({ contactPhone: '010', customerName: 'A', destination: 'Luxor', nested: [{ userEmail: 'e' }] }), {
    contactPhone: '[REDACTED]', customerName: '[REDACTED]', destination: 'Luxor', nested: [{ userEmail: '[REDACTED]' }],
  });
});

test('dates use Africa/Cairo, not UTC (23:30 UTC on Nov 3 is already Nov 4 in Cairo)', () => {
  const lateUtc = new Date('2026-11-03T23:30:00Z');
  assert.equal(localDate(lateUtc), '2026-11-04');
  assert.equal(localWeekday(lateUtc), 'Wednesday');
});
