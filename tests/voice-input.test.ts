import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_TRANSCRIPT_RULE } from '../server/src/agent/system-prompt.ts';
import type { TurnInputMode } from '../server/src/agent/runtime.ts';
import { ScriptedProvider, final, testApp } from './helpers.ts';

// The exact transcript Groq Whisper produced in the live M5 check for "…والميزانية تمانية آلاف جنيه للفرد".
const GARBLED = 'I want a trip to Sharm el-Sheikh for four days. والميزانية تمنتلاف كني للفرد.';

async function systemPromptFor(input?: TurnInputMode) {
  const provider = new ScriptedProvider(() => final('تمام، تقصد ميزانيتك كام بالظبط؟'));
  const app = await testApp(provider);
  const ownerId = `voice-${Math.random()}`;
  await app.runtime.runTurn({ conversationId: await app.conversations.create(ownerId), ownerId, userText: GARBLED, ...(input ? { input } : {}) });
  return provider.requests[0]?.system ?? '';
}

test('an unedited voice transcript tells the model to confirm unclear amounts instead of guessing', async () => {
  const system = await systemPromptFor({ kind: 'voice_transcript', lowConfidence: false });
  assert.ok(system.includes(VOICE_TRANSCRIPT_RULE));
  assert.doesNotMatch(system, /low confidence/);
});

test('a low-confidence transcript says so', async () => {
  assert.match(await systemPromptFor({ kind: 'voice_transcript', lowConfidence: true }), /flagged this transcript as low confidence/);
});

test('typed text (default) and hand-corrected transcripts get no voice rule', async () => {
  assert.ok(!(await systemPromptFor()).includes(VOICE_TRANSCRIPT_RULE));
  assert.ok(!(await systemPromptFor({ kind: 'text' })).includes(VOICE_TRANSCRIPT_RULE));
});

test('transcript text never enters the system prompt (it stays an untrusted user message)', async () => {
  const system = await systemPromptFor({ kind: 'voice_transcript', lowConfidence: true });
  assert.doesNotMatch(system, /تمنتلاف|Sharm el-Sheikh/);
});

test('the voice rule applies to its own turn only', async () => {
  const provider = new ScriptedProvider(() => final('تمام.'));
  const app = await testApp(provider);
  const conversationId = await app.conversations.create('voice-two-turns');
  await app.runtime.runTurn({ conversationId, ownerId: 'voice-two-turns', userText: GARBLED, input: { kind: 'voice_transcript', lowConfidence: false } });
  await app.runtime.runTurn({ conversationId, ownerId: 'voice-two-turns', userText: 'قصدي 8000 جنيه' });
  assert.ok(provider.requests[0]?.system.includes(VOICE_TRANSCRIPT_RULE));
  assert.ok(!provider.requests[1]?.system.includes(VOICE_TRANSCRIPT_RULE));
});
