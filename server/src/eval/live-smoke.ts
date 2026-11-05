import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PROJECT_ROOT, loadConfig, loadDotEnv } from '../config.ts';
import { createApp, createEmbeddings, createProvider } from '../app.ts';
import { connectDatabase } from '../db/connect.ts';

// Live smoke run: real LLM + real Supabase, selected scenarios from tests/evals/scenarios.jsonl.
// Uses provider quota (free tier) or money (paid) → refuses to run without --confirm. Prints no secrets.
// Usage: npm run live:smoke -- [--confirm] [--ids T002,T009,...] [--erase]

const DEFAULT_IDS = ['T001_pkg_list', 'T002_pkg_hurghada', 'T009_pkg_two_person', 'T010_pkg_family_children', 'T016_travel_turkey', 'T025_offtopic_programming', 'T031_insult', 'T036_memory_consent'];

/** USD per million tokens (input, output) for models in the bundled claude-api reference; others report tokens only. */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};
/** Rough per-scenario budget used for the pre-run estimate (system prompt + tools + up to 3 model steps). */
const EST_INPUT_TOKENS_PER_SCENARIO = 3 * 7_000;
const EST_OUTPUT_TOKENS_PER_SCENARIO = 3 * 600;

const ScenarioSchema = z.object({ id: z.string(), input: z.string(), expected_tools: z.array(z.string()), expected_behavior: z.string() });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

loadDotEnv();
const config = loadConfig();
const provider = createProvider(config, { onFallback: (e) => console.log(`   ⇄ fallback: ${e.from} → ${e.to ?? 'none'} (${e.reason})`) });
if (!provider) {
  console.error(`Live smoke cannot run: ${config.providerIssue}`);
  process.exit(1);
}
const scenarios = readFileSync(path.join(PROJECT_ROOT, 'tests', 'evals', 'scenarios.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => ScenarioSchema.parse(JSON.parse(l)));
const ids = (arg('--ids') ?? DEFAULT_IDS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const selected = ids.map((id) => scenarios.find((s) => s.id === id || s.id.startsWith(`${id}_`))).filter((s): s is z.infer<typeof ScenarioSchema> => s !== undefined);
if (selected.length === 0) {
  console.error('No matching scenario ids.');
  process.exit(1);
}

const price = config.freeTierOnly ? undefined : PRICES[provider.model];
const estimate = price
  ? (selected.length * (EST_INPUT_TOKENS_PER_SCENARIO * price.input + EST_OUTPUT_TOKENS_PER_SCENARIO * price.output)) / 1_000_000
  : null;
console.log(`Live smoke: ${selected.length} scenario(s) on ${provider.model}, embeddings: ${config.embeddings ? config.embeddings.model : 'off (lexical)'}`);
if (config.freeTierOnly) {
  console.log(`Free tier only: $0. Expect roughly ${selected.length * 2}-${selected.length * 4} model requests (2-4 per scenario) against your daily free quota; rate limits are paced client-side.`);
} else {
  console.log(estimate === null ? 'Estimated cost: unknown for this model (tokens will be reported).' : `Estimated upper-bound cost: ~${estimate.toFixed(2)} (actual is reported after the run).`);
}
if (!process.argv.includes('--confirm')) {
  console.log('Dry run only. Re-run with --confirm to make the API calls.');
  process.exit(0);
}

const db = connectDatabase(config);
if ('error' in db) {
  console.error(db.error);
  process.exit(1);
}
const app = await createApp(config, provider, db.sql, createEmbeddings(config));
if (process.argv.includes('--verbose')) {
  const t0 = Date.now();
  app.tracer.onEvent((e) => {
    const at = `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
    if (e.kind === 'model_call') console.log(`   ${at} model step ${e.step}: ${e.model} → ${e.stopReason} in ${e.latencyMs} ms`);
    if (e.kind === 'tool') console.log(`   ${at} tool ${e.execution.toolName} → ${e.execution.outcome}${e.execution.errorCode ? `:${e.execution.errorCode}` : ''} (${e.execution.latencyMs} ms)`);
  });
}
const ownerId = `live-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const report: Array<Record<string, unknown>> = [];
let inputTokens = 0;
let outputTokens = 0;

try {
  for (const s of selected) {
    const conversationId = await app.conversations.create(ownerId, 'ar-EG');
    const result = await app.runtime.runTurn({ conversationId, ownerId, userText: s.input });
    const used = [...new Set(result.toolCalls.map((t) => t.name))];
    const missing = s.expected_tools.filter((t) => !used.includes(t));
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    console.log(`\n── ${s.id}  [${result.status}] ${result.latencyMs} ms  trace ${result.traceId}`);
    console.log(`   user: ${s.input}`);
    console.log(`   tools used: ${used.join(', ') || '(none)'}   expected: ${s.expected_tools.join(', ') || '(none)'}${missing.length > 0 ? `   MISSING: ${missing.join(', ')}` : ''}`);
    console.log(`   expected behavior: ${s.expected_behavior}`);
    console.log(`   reply: ${result.text}`);
    if (result.consentRequests.length > 0) console.log('   (consent prompt would be shown to the customer; not granted in smoke runs)');
    report.push({
      id: s.id, input: s.input, status: result.status, traceId: result.traceId, latencyMs: result.latencyMs,
      expectedTools: s.expected_tools, usedTools: used, missingTools: missing, toolCalls: result.toolCalls,
      expectedBehavior: s.expected_behavior, reply: result.text, usage: result.usage,
      // Behavior is judged by a human (or a later M7 grader); tool coverage is only a signal, not a pass/fail.
    });
  }
} finally {
  if (process.argv.includes('--erase')) await app.memory.eraseAll(ownerId);
  await app.sql.close();
}

const actualCost = price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null;
const summary = {
  ranAt: new Date().toISOString(), provider: provider.id, model: provider.model, ownerId, scenarios: report.length,
  inputTokens, outputTokens, estimatedCostUsd: actualCost, dataErased: process.argv.includes('--erase'), results: report,
};
const dir = path.join(PROJECT_ROOT, 'reports');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `live-smoke-${summary.ranAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nTokens in/out: ${inputTokens}/${outputTokens}${actualCost === null ? '' : ` · cost ≈ $${actualCost.toFixed(4)}`}`);
console.log(`Report: ${path.relative(PROJECT_ROOT, file)} · owner ${ownerId}${summary.dataErased ? ' (erased)' : ' (kept in Supabase as evidence)'}`);
