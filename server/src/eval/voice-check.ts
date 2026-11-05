import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PROJECT_ROOT, loadConfig, loadDotEnv } from '../config.ts';
import { createApp, createEmbeddings, createProvider, createSpeechToText } from '../app.ts';
import { connectDatabase } from '../db/connect.ts';
import { normalizeDigits } from '../observability/redact.ts';
import { normalizeForSearch } from '../text/normalize.ts';
import { readAudioFile, VoiceInputError } from '../voice/stt.ts';

// Live M5 check: voice note → Groq Whisper → transcript → agent tools → answer.
// Default test audio is SYNTHETIC (Gemini TTS, free tier); pass --file <recording> to test a real voice note.
// Usage: npm run voice:check -- --confirm [--file path\to\note.ogg]

interface Sample {
  id: string;
  /** What the speaker says (reference transcript). */
  text: string;
  /** Words that must survive transcription (destination, amount). Alternatives separated by |. */
  keyTerms: string[];
  expectTool: string;
  /** Catalog price the answer should contain (digits; Latin or Arabic-Indic accepted). */
  expectPrice: number | null;
  /** Spoken budget: the reply must state it or ask the customer to confirm it, never use a different value. */
  budget?: { spoken: number; wrongReadings: number[] };
}

const SAMPLES: Sample[] = [
  { id: 'T043_eg_arabic', text: 'عايز الغردقة بسبعة آلاف جنيه الأسبوع الجاي', keyTerms: ['غردقه', 'سبعه|7000|7'], expectTool: 'search_company_packages', expectPrice: 6500 },
  { id: 'mixed_ar_en', text: 'I want a trip to Sharm El Sheikh for four days, والميزانية تمانية آلاف جنيه للفرد', keyTerms: ['sharm|شرم', 'four|4|اربعه', 'تمانيه|ثمانيه|8000|8'], expectTool: 'search_company_packages', expectPrice: 7800, budget: { spoken: 8000, wrongReadings: [3000] } },
];
const TTS_MODEL = 'gemini-3.8-flash-tts';
const SAMPLE_DIR = path.join(PROJECT_ROOT, '.tmp', 'voice-samples');

/** 16-bit mono PCM → WAV container (no ffmpeg needed). */
function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const TtsResponse = z.object({
  candidates: z.array(z.object({ content: z.object({ parts: z.array(z.looseObject({ inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional() })) }) })).min(1),
});

/** Synthetic voice note via Gemini TTS (free tier). Returns a WAV file path. */
async function synthesize(apiKey: string, sample: Sample): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      // Only the sentence itself: any instruction text would be spoken aloud by the TTS model.
      contents: [{ parts: [{ text: sample.text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
  const part = TtsResponse.parse(await res.json()).candidates[0]?.content.parts.find((p) => p.inlineData)?.inlineData;
  if (!part) throw new Error('TTS returned no audio');
  const rate = Number(/rate=(\d+)/.exec(part.mimeType)?.[1] ?? 24000);
  mkdirSync(SAMPLE_DIR, { recursive: true });
  const file = path.join(SAMPLE_DIR, `${sample.id}.wav`);
  writeFileSync(file, wav(Buffer.from(part.data, 'base64'), rate));
  return file;
}

/** Word error rate on normalized words (Arabic letter variants, digits and punctuation folded). */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const words = (s: string) => normalizeForSearch(normalizeDigits(s)).split(' ').filter(Boolean);
  const r = words(reference);
  const h = words(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => Array.from({ length: h.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      const row = d[i];
      const prev = d[i - 1];
      if (!row || !prev) continue;
      row[j] = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  return r.length === 0 ? 0 : (d[r.length]?.[h.length] ?? 0) / r.length;
}

loadDotEnv();
const config = loadConfig();
const provider = createProvider(config, { onFallback: (e) => console.log(`   ⇄ fallback: ${e.from} → ${e.to ?? 'none'} (${e.reason})`) });
const stt = createSpeechToText(config);
const geminiKey = config.providers.find((p) => p.kind === 'gemini')?.apiKey;
const userFile = process.argv.includes('--file') ? process.argv[process.argv.indexOf('--file') + 1] : undefined;
if (!provider || !stt || (!geminiKey && !userFile)) {
  console.error(`Cannot run: ${!provider ? config.providerIssue : !stt ? config.sttIssue : 'GEMINI_API_KEY needed for synthetic samples (or pass --file).'}`);
  process.exit(1);
}
console.log(userFile
  ? `M5 voice check: YOUR recording → ${stt.label} → agent (${provider.model}).`
  : `M5 voice check: ${SAMPLES.length} SYNTHETIC voice notes (${TTS_MODEL}, free tier) → ${stt.label} → agent (${provider.model}).`);
if (!process.argv.includes('--confirm')) {
  console.log('Dry run only. Re-run with --confirm.');
  process.exit(0);
}
const db = connectDatabase(config);
if ('error' in db) {
  console.error(db.error);
  process.exit(1);
}

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
};
const app = await createApp(config, provider, db.sql, createEmbeddings(config));
const ownerId = `voice-check-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const results: Array<Record<string, unknown>> = [];

try {
  // Failure paths first (no network): the user must get a friendly fallback, not a crash.
  for (const [bad, code] of [[path.join(PROJECT_ROOT, 'README.md'), 'UNSUPPORTED_FORMAT'], [path.join(SAMPLE_DIR, 'missing.ogg'), 'NOT_FOUND']] as const) {
    try {
      await readAudioFile(bad);
      check(false, `rejects ${code}`);
    } catch (err) {
      check(err instanceof VoiceInputError && err.code === code, `invalid input rejected with ${code} (text fallback offered)`);
    }
  }

  const samples: Array<Sample & { file: string; synthetic: boolean }> = userFile
    ? [{ id: 'user_recording', text: '', keyTerms: [], expectTool: '', expectPrice: null, file: userFile, synthetic: false }]
    : await Promise.all(SAMPLES.map(async (s) => ({ ...s, file: await synthesize(geminiKey ?? '', s), synthetic: true })));

  for (const s of samples) {
    console.log(`\n── ${s.id}${s.synthetic ? ' (synthetic TTS audio)' : ''}`);
    const audio = await readAudioFile(s.file);
    console.log(`   audio: ${path.relative(PROJECT_ROOT, s.file)} (${(audio.bytes.byteLength / 1024).toFixed(0)} KB)`);
    const t = await stt.transcribe(audio, AbortSignal.timeout(60_000));
    console.log(`   transcript (${t.language ?? '?'}, ${t.durationSec?.toFixed(1) ?? '?'} s${t.lowConfidence ? ', LOW CONFIDENCE' : ''}): ${t.text}`);
    const result: Record<string, unknown> = { id: s.id, synthetic: s.synthetic, transcript: t.text, language: t.language, lowConfidence: t.lowConfidence };
    if (s.text) {
      const wer = wordErrorRate(s.text, t.text);
      result['wer'] = wer;
      console.log(`   reference: ${s.text}`);
      console.log(`   word error rate: ${(wer * 100).toFixed(0)}%`);
      const normalized = normalizeForSearch(normalizeDigits(t.text));
      for (const term of s.keyTerms) {
        check(term.split('|').some((alt) => normalized.includes(normalizeForSearch(alt))), `   key term survived transcription`, term);
      }
    }
    // The CLI shows the transcript and the user confirms it (Enter = send); here the test user confirms.
    const conversationId = await app.conversations.create(ownerId, 'ar-EG');
    const turn = await app.runtime.runTurn({ conversationId, ownerId, userText: t.text, input: { kind: 'voice_transcript', lowConfidence: t.lowConfidence } });
    const tools = turn.toolCalls.map((c) => c.name);
    console.log(`   agent [${turn.status}] tools: ${tools.join(', ') || 'none'}${turn.groundingCorrections > 0 ? ' · grounding guard re-asked once' : ''}`);
    console.log(`   reply: ${turn.text.replace(/\s+/g, ' ').slice(0, 350)}`);
    result['tools'] = tools;
    result['reply'] = turn.text;
    if (s.expectTool) check(tools.includes(s.expectTool), `   agent used ${s.expectTool} on the voice transcript`);
    if (s.expectPrice !== null) {
      const digits = normalizeDigits(turn.text).replace(/[,٬]/g, '');
      check(digits.includes(String(s.expectPrice)), `   reply grounded in catalog price ${s.expectPrice} EGP`);
    }
    if (s.budget) {
      const digits = normalizeDigits(turn.text).replace(/[,٬]/g, '');
      const stated = digits.includes(String(s.budget.spoken));
      const asked = /[?؟]/.test(turn.text);
      const wrong = s.budget.wrongReadings.filter((n) => digits.includes(String(n)));
      check((stated || asked) && wrong.length === 0, `   budget ${s.budget.spoken} stated or confirmed, not guessed`, wrong.length ? `used ${wrong.join(', ')}` : stated ? 'stated' : asked ? 'asked to confirm' : 'neither');
    }
    check(turn.status === 'completed', '   turn completed');
    results.push(result);
  }

  const dir = path.join(PROJECT_ROOT, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `voice-check-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify({ ranAt: new Date().toISOString(), stt: stt.label, tts: userFile ? null : TTS_MODEL, model: provider.model, results, failures }, null, 2)}\n`);
  console.log(`\nReport: ${path.relative(PROJECT_ROOT, file)}`);
} finally {
  await app.memory.eraseAll(ownerId);
  await app.sql.close();
}
console.log(failures === 0 ? 'All M5 voice checks passed.' : `${failures} M5 voice check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
