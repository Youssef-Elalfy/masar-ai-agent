import { z } from 'zod';
import { FREE_TIER, loadConfig, loadDotEnv } from '../config.ts';

// Zero-quota provider check: lists models (GET) to confirm the keys work and that the configured
// free-tier models are available to THIS account. No generation calls; keys are never printed.

loadDotEnv();
const config = loadConfig();
let failures = 0;
const report = (ok: boolean, label: string, detail: string) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${detail}`);
};

const GeminiModels = z.object({
  models: z.array(z.looseObject({ name: z.string(), supportedGenerationMethods: z.array(z.string()).optional() })).optional(),
  nextPageToken: z.string().optional(),
});
const GroqModels = z.object({ data: z.array(z.looseObject({ id: z.string(), active: z.boolean().optional() })) });

async function getJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: res.ok ? ((await res.json()) as unknown) : null };
}

const geminiKey = process.env['GEMINI_API_KEY']?.trim();
if (!geminiKey) {
  report(false, 'Gemini key', 'GEMINI_API_KEY is not set');
} else {
  const methods = new Map<string, string[]>();
  let pageToken: string | undefined;
  let status = 200;
  do {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await getJson(url, { 'x-goog-api-key': geminiKey });
    status = res.status;
    if (status !== 200) break;
    const page = GeminiModels.parse(res.body);
    for (const m of page.models ?? []) methods.set(m.name.replace(/^models\//, ''), m.supportedGenerationMethods ?? []);
    pageToken = page.nextPageToken;
  } while (pageToken);
  report(status === 200, 'Gemini key', status === 200 ? `valid (${methods.size} models visible)` : `HTTP ${status} (check the key and that the Generative Language API is enabled)`);
  if (status === 200) {
    for (const p of config.providers.filter((x) => x.kind === 'gemini')) {
      const m = methods.get(p.model);
      report(m?.includes('generateContent') === true, `Gemini chat ${p.model}`, m ? `available, methods: ${m.join(', ')}` : 'NOT available to this key');
    }
    if (config.embeddings?.kind === 'gemini') {
      const m = methods.get(config.embeddings.model);
      report(m?.includes('embedContent') === true, `Gemini embeddings ${config.embeddings.model}`, m ? `available, methods: ${m.join(', ')}` : 'NOT available to this key');
    } else {
      report(false, 'Gemini embeddings', config.embeddingsIssue ?? 'not configured');
    }
  }
}

const groqKey = process.env['GROQ_API_KEY']?.trim();
if (!groqKey) {
  report(false, 'Groq key', 'GROQ_API_KEY is not set (fallback LLM and voice notes disabled)');
} else {
  const res = await getJson('https://api.groq.com/openai/v1/models', { authorization: `Bearer ${groqKey}` });
  report(res.status === 200, 'Groq key', res.status === 200 ? 'valid' : `HTTP ${res.status}`);
  if (res.status === 200) {
    const ids = new Map(GroqModels.parse(res.body).data.map((m) => [m.id, m.active !== false]));
    for (const p of config.providers.filter((x) => x.kind === 'groq')) report(ids.get(p.model) === true, `Groq chat ${p.model}`, ids.has(p.model) ? 'available' : 'NOT available');
    if (config.stt) report(ids.get(config.stt.model) === true, `Groq speech-to-text ${config.stt.model}`, ids.has(config.stt.model) ? 'available' : 'NOT available');
  }
}

console.log(`INFO  free-tier only: ${config.freeTierOnly}; chain: ${config.providers.map((p) => `${p.kind}:${p.model}`).join(' → ') || '(none)'}`);
console.log(`INFO  allowlists: gemini [${FREE_TIER.geminiChat.join(', ')}], groq [${FREE_TIER.groqChat.join(', ')}]`);
console.log(failures === 0 ? 'All provider checks passed (no generation quota used).' : `${failures} provider check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
