import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FREE_TIER, loadConfig } from '../server/src/config.ts';

test('no keys → no provider, an actionable free-tier message, no simulated model', () => {
  const c = loadConfig({});
  assert.deepEqual(c.providers, []);
  assert.match(c.providerIssue ?? '', /GEMINI_API_KEY/);
  assert.equal(c.freeTierOnly, true);
  assert.equal(c.maxAgentSteps, 8);
});

test('Gemini key → two free Gemini models (primary + fallback); Groq key adds a third fallback', () => {
  const g = loadConfig({ GEMINI_API_KEY: 'g' });
  assert.deepEqual(g.providers.map((p) => `${p.kind}:${p.model}`), ['gemini:gemini-3.8-flash', 'gemini:gemini-3.5-flash-lite']);
  const both = loadConfig({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' });
  assert.deepEqual(both.providers.map((p) => `${p.kind}:${p.model}`), ['gemini:gemini-3.8-flash', 'gemini:gemini-3.5-flash-lite', 'groq:openai/gpt-oss-120b']);
});

test('free-tier only: paid providers are ignored even if their keys exist, and no paid key is required', () => {
  const c = loadConfig({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'paid', OPENAI_API_KEY: 'paid', OPENAI_MODEL: 'x' });
  assert.ok(c.providers.every((p) => p.kind === 'gemini' || p.kind === 'groq'));
  const paidOnly = loadConfig({ ANTHROPIC_API_KEY: 'paid' });
  assert.deepEqual(paidOnly.providers, []);
});

test('models outside the verified free-tier allowlist are refused (no silent paid usage)', () => {
  const c = loadConfig({ GEMINI_API_KEY: 'g', GEMINI_MODELS: 'gemini-3.1-pro-preview' });
  assert.deepEqual(c.providers, []);
  assert.match(c.providerIssue ?? '', /not on the verified free-tier allowlist/);
  assert.ok(!FREE_TIER.geminiChat.some((m: string) => m === 'gemini-3.1-pro-preview'));
});

test('embeddings default to Gemini gemini-embedding-001; STT to Groq Whisper; both need their keys', () => {
  const none = loadConfig({});
  assert.equal(none.embeddings, null);
  assert.equal(none.stt, null);
  const c = loadConfig({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' });
  assert.deepEqual(c.embeddings && { kind: c.embeddings.kind, model: c.embeddings.model }, { kind: 'gemini', model: 'gemini-embedding-001' });
  assert.deepEqual(c.stt && { kind: c.stt.kind, model: c.stt.model }, { kind: 'groq', model: 'whisper-large-v3-turbo' });
  assert.match(loadConfig({ GEMINI_API_KEY: 'g', EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'x' }).embeddingsIssue ?? '', /paid/);
});

test('issues never echo secret values', () => {
  const c = loadConfig({ GEMINI_API_KEY: 'AIza-secret-value', GEMINI_MODELS: 'gemini-ultra-paid' });
  assert.doesNotMatch(c.providerIssue ?? '', /AIza-secret-value/);
});
