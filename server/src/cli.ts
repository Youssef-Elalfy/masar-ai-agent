import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig, loadDotEnv } from './config.ts';
import { createApp, createEmbeddings, createProvider, createSpeechToText, type App } from './app.ts';
import { readAudioFile, VoiceInputError, type SpeechToText } from './voice/stt.ts';
import { connectDatabase } from './db/connect.ts';
import { consentText } from './memory/consent-store.ts';
import type { TurnInputMode } from './agent/runtime.ts';

const OWNER_ID = 'local-cli-user';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const teal = (s: string) => `\x1b[36m${s}\x1b[0m`;
const isYes = (answer: string) => ['y', 'yes', 'ايوه', 'أيوه', 'نعم', 'موافق'].includes(answer.trim().toLowerCase());

const HELP = 'Commands: /new  /voice <audio file>  /memory  /memory on  /memory off  /forget  /leads  /leads delete  /erase  /exit';

/** Approval previews are already masked; show them as readable lines. */
function formatPreview(preview: unknown): string {
  if (preview === null || typeof preview !== 'object') return `    ${String(preview)}`;
  return Object.entries(preview).map(([k, v]) => `    ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
}

/**
 * Voice note: validate → transcribe (Groq Whisper) → show transcript → user confirms or corrects.
 * Audio is read once and never stored; failures fall back to typing.
 */
async function voiceNote(filePath: string, stt: SpeechToText | null, rl: Interface): Promise<{ text: string; input: TurnInputMode } | null> {
  if (!stt) {
    console.log(dim('Voice notes are not configured (GROQ_API_KEY). You can type your message instead.'));
    return null;
  }
  if (!filePath) {
    console.log(dim('Usage: /voice path\\to\\note.ogg  (flac, mp3, mp4, m4a, ogg, wav, webm; max 25 MB)'));
    return null;
  }
  try {
    const audio = await readAudioFile(filePath.replace(/^"|"$/g, ''));
    console.log(dim(`Transcribing with ${stt.label}…`));
    const t = await stt.transcribe(audio, AbortSignal.timeout(60_000));
    if (!t.text) {
      console.log(dim('No speech was recognized. Please try again or type your message.'));
      return null;
    }
    console.log(dim(`\nTranscript${t.language ? ` (${t.language})` : ''}${t.durationSec ? `, ${t.durationSec.toFixed(1)} s` : ''}${t.lowConfidence ? ' — LOW CONFIDENCE, please check names and numbers' : ''}:`));
    console.log(`  ${t.text}`);
    const answer = (await rl.question(dim('Send this? [Enter = yes / type a corrected version / n = cancel] '))).trim();
    if (answer.toLowerCase() === 'n') return null;
    // A hand-corrected transcript is the customer's own text; an accepted one stays a raw transcript.
    return answer ? { text: answer, input: { kind: 'text' } } : { text: t.text, input: { kind: 'voice_transcript', lowConfidence: t.lowConfidence } };
  } catch (err) {
    const message = err instanceof VoiceInputError ? err.message : 'Voice transcription is unavailable right now.';
    console.log(dim(`${message} You can type your message instead.`));
    return null;
  }
}

/** Shows the server-fixed consent notice (never model-authored) and records the user's decision. */
async function askMemoryConsent(app: App, rl: Interface, conversationId: string): Promise<boolean> {
  console.log(dim(`\n${consentText('ar', app.memory.embeddingLabel)}\n${consentText('en', app.memory.embeddingLabel)}`));
  if (isYes(await rl.question(dim('Allow long-term memory? [y/N] ')))) {
    await app.consents.grant(OWNER_ID, 'long_term_memory', { conversationId });
    console.log(dim('Memory ON.'));
    return true;
  }
  await app.consents.decline(OWNER_ID, conversationId);
  console.log(dim('Memory stays OFF (the assistant will not ask again in this conversation).'));
  return false;
}

/** Memory controls the customer can use directly (spec: show, correct, forget, clear, withdraw consent). */
async function handleMemoryCommand(app: App, rl: Interface, line: string, conversationId: string): Promise<void> {
  if (line === '/memory') {
    const status = await app.memory.status(OWNER_ID);
    const items = await app.memory.list(OWNER_ID);
    console.log(dim(`Long-term memory: ${status.consentActive ? 'ON' : 'OFF'} · ${app.memory.retrievalBackend}`));
    for (const item of items) console.log(dim(`  • [${item.category}] ${item.content}  (${item.updatedAt.slice(0, 10)})`));
    if (items.length === 0) console.log(dim('  (nothing saved)'));
  } else if (line === '/memory on') {
    await askMemoryConsent(app, rl, conversationId);
  } else if (line === '/memory off') {
    if (!isYes(await rl.question(dim('Turn memory off and delete all saved preferences and conversation summaries? [y/N] ')))) return;
    const result = await app.consents.revoke(OWNER_ID, 'long_term_memory');
    console.log(dim(result.revoked ? `Memory OFF. Deleted ${result.deletedMemories} saved item(s).` : 'Memory was already off.'));
  } else if (line === '/forget') {
    if (!isYes(await rl.question(dim('Delete all saved preferences (and conversation summaries)? [y/N] ')))) return;
    console.log(dim(`Deleted ${await app.memory.forget(OWNER_ID, { kind: 'all' }, { conversationId })} item(s).`));
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const provider = createProvider(config, {
    onFallback: (e) => console.log(dim(`  ⇄ ${e.from} unavailable (${e.reason}); ${e.to ? `using ${e.to}` : 'no fallback left'} · retry in ~${Math.ceil(e.cooldownMs / 1000)} s`)),
  });
  if (!provider) {
    console.error(`MASAR AI cannot start a live session: ${config.providerIssue}`);
    console.error('No simulated model is used in the console. Add a free-tier key to .env (see README) and run `npm run chat` again.');
    process.exitCode = 1;
    return;
  }
  const stt = createSpeechToText(config);
  const db = connectDatabase(config);
  if ('error' in db) {
    console.error(db.error);
    process.exitCode = 1;
    return;
  }

  const app = await createApp(config, provider, db.sql, createEmbeddings(config));
  app.tracer.onEvent((e) => {
    if (e.kind === 'tool') {
      const t = e.execution;
      const status = t.outcome === 'ok' ? 'ok' : `error:${t.errorCode ?? '?'}`;
      console.log(dim(`  ↳ [step ${t.step}] ${t.toolName} ${JSON.stringify(t.inputRedacted)} → ${status} (${t.latencyMs} ms) ${t.resultSummary ?? ''}`));
    } else if (e.kind === 'run_finished') {
      console.log(dim(`  [trace ${e.traceId}] ${e.status} · ${e.steps} model step(s) · ${e.latencyMs} ms · tokens in/out ${e.inputTokens}/${e.outputTokens}`));
    }
  });

  let conversationId = await app.conversations.create(OWNER_ID, 'ar-EG');
  console.log(teal(`MASAR AI — DEMO agent console (${provider.model}, Supabase Postgres, free-tier only: ${config.freeTierOnly ? 'yes' : 'NO'})`));
  console.log(dim(`${app.company.name} is fictional; catalog prices are DEMO data. Memory: ${app.memory.retrievalBackend}. Voice notes: ${stt ? stt.label : 'off'}. ${HELP}`));
  for (const issue of [config.embeddingsIssue, config.sttIssue, config.searchIssue]) if (issue) console.log(dim(issue));
  console.log(dim(`session ${conversationId}`));

  const rl = createInterface({ input, output });
  try {
    for (;;) {
      const line = (await rl.question('\nأنت › ')).trim();
      if (!line) continue;
      if (line === '/exit') break;
      if (line === '/help') {
        console.log(dim(HELP));
        continue;
      }
      if (line === '/new') {
        conversationId = await app.conversations.create(OWNER_ID, 'ar-EG');
        console.log(dim(`new session ${conversationId}`));
        continue;
      }
      if (line.startsWith('/memory') || line === '/forget') {
        await handleMemoryCommand(app, rl, line, conversationId);
        continue;
      }
      if (line === '/leads') {
        const records = await app.crm.listForOwner(OWNER_ID);
        if (records.length === 0) console.log(dim('No leads, quote requests or handoffs stored for you.'));
        for (const r of records) console.log(dim(`  • ${r.kind} ${r.reference} [${r.status}] ${r.createdAt.slice(0, 16)} — ${r.detail}`));
        continue;
      }
      if (line === '/leads delete') {
        if (isYes(await rl.question(dim('Delete your leads, quote requests and handoff requests from the demo CRM? [y/N] ')))) {
          const n = await app.crm.deleteForOwner(OWNER_ID);
          console.log(dim(`Deleted ${n.leads} lead(s), ${n.quotes} quote request(s), ${n.handoffs} handoff(s); CRM consent withdrawn.`));
        }
        continue;
      }
      if (line === '/erase') {
        if (isYes(await rl.question(dim('Erase EVERYTHING stored about you (conversations, memory, traces)? [y/N] ')))) {
          await app.memory.eraseAll(OWNER_ID);
          conversationId = await app.conversations.create(OWNER_ID, 'ar-EG');
          console.log(dim(`Erased. New empty session ${conversationId}`));
        }
        continue;
      }
      let userText = line;
      let turnInput: TurnInputMode = { kind: 'text' };
      if (line.startsWith('/voice')) {
        const note = await voiceNote(line.slice('/voice'.length).trim(), stt, rl);
        if (!note) continue;
        userText = note.text;
        turnInput = note.input;
      }
      try {
        const turnStarted = new Date().toISOString();
        const result = await app.runtime.runTurn({ conversationId, ownerId: OWNER_ID, userText, input: turnInput });
        console.log(`\n${teal('مسار ›')} ${result.text}`);
        if (result.usedSummary) console.log(dim('  (older turns are summarized in the model context)'));
        // Make every memory write visible to the user, so nothing is remembered silently.
        if (result.toolCalls.some((t) => t.name === 'upsert_customer_preference' && t.outcome === 'ok')) {
          for (const item of (await app.memory.list(OWNER_ID)).filter((i) => i.updatedAt >= turnStarted)) {
            console.log(dim(`  🧠 saved [${item.category}] ${item.content}  (/memory to review, /forget to delete)`));
          }
        }
        // Consent and approvals are decided by the user here, never by the model.
        if (result.consentRequests.length > 0) await askMemoryConsent(app, rl, conversationId);
        for (const p of result.pendingApprovals) {
          console.log(dim(`\nThe assistant asks to run "${p.toolName}":\n${formatPreview(p.argsPreview)}`));
          const approved = isYes(await rl.question(dim('Approve? [y/N] ')));
          await app.approvals.decide(p.approvalId, OWNER_ID, approved);
          console.log(dim(approved ? 'Approved. Ask the assistant to continue.' : 'Declined.'));
        }
      } catch {
        console.log(`\n${teal('مسار ›')} معلش، حصلت مشكلة غير متوقعة. جرّب تاني.`);
      }
    }
  } finally {
    rl.close();
    await app.sql.close();
  }
}

await main();
