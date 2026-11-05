import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../server/src/agent/system-prompt.ts';
import { loadCompanyFixture } from '../server/src/db/seed.ts';

const company = loadCompanyFixture();
const flags = {
  llmProvider: 'scripted',
  model: 'test',
  externalTravelSearch: 'connected (tavily web search)',
  longTermMemory: 'opt_in (pgvector)',
  leadCreation: 'enabled (demo CRM)',
  voice: 'voice_notes (groq/whisper)',
};

test('the customer-facing identity is MASAR AI; the stored demo company name stays internal', () => {
  const prompt = buildSystemPrompt(company, new Date('2026-11-04T10:00:00Z'));
  assert.match(prompt, /You are MASAR AI \(مَسَارٌ\)/);
  assert.match(prompt, /FICTIONAL demo travel company/);
  assert.doesNotMatch(prompt, /RAHHAL|رحّال/);
  assert.equal(company.id, 'rahhal-ai-demo-company', 'database identifier is unchanged');
});

test('capabilities are in the prompt, so capability answers need no get_system_status step (live: one extra model call)', () => {
  const prompt = buildSystemPrompt(company, new Date(), { summary: null, memory: null }, flags);
  assert.match(prompt, /external search: connected \(tavily web search\)/);
  assert.match(prompt, /do not call get_system_status for them/);
  assert.doesNotMatch(prompt, /Use get_system_status before claiming/);
  // Without flags (e.g. other callers) the old safe rule remains.
  assert.match(buildSystemPrompt(company, new Date()), /Use get_system_status before claiming any capability/);
});

test('reply language follows the latest message (live: an English question was answered in Arabic)', () => {
  const prompt = buildSystemPrompt(company, new Date());
  assert.match(prompt, /language of the customer's LATEST message/);
  assert.match(prompt, /An English message gets an English reply/);
});
