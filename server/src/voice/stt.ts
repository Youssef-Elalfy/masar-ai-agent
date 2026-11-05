import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sendWithRetry, type RetryPolicy } from '../agent/providers/http.ts';
import { ProviderError, type FetchLike } from '../agent/providers/types.ts';

/** Groq free plan: 25 MB per file; formats from console.groq.com/docs/speech-to-text. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const AUDIO_TYPES: Record<string, string> = {
  '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.mp4': 'audio/mp4', '.mpeg': 'audio/mpeg', '.mpga': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm',
};

/** Domain vocabulary passed as the Whisper prompt (max 224 tokens) to help with names, places and money. */
const DEFAULT_PROMPT = 'مسار، الغردقة، شرم الشيخ، النوبة، الفيوم، أسوان، الأقصر، تركيا، اليابان، جنيه، دولار، ميزانية. Egyptian Arabic and English mixed.';

export class VoiceInputError extends Error {
  readonly code: 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' | 'EMPTY' | 'NOT_FOUND';
  constructor(code: VoiceInputError['code'], message: string) {
    super(message);
    this.name = 'VoiceInputError';
    this.code = code;
  }
}

export interface Transcript {
  text: string;
  language: string | null;
  durationSec: number | null;
  /** True when Whisper's segment scores suggest the user should check names/numbers before sending. */
  lowConfidence: boolean;
  model: string;
}

const VerboseSchema = z.looseObject({
  text: z.string(),
  language: z.string().optional(),
  duration: z.number().optional(),
  segments: z.array(z.looseObject({ avg_logprob: z.number().optional(), no_speech_prob: z.number().optional() })).optional(),
});

export interface SpeechToText {
  readonly label: string;
  transcribe(audio: { bytes: Uint8Array; filename: string }, signal: AbortSignal, opts?: { language?: string }): Promise<Transcript>;
}

/** Validates a local audio file before any upload (format + free-tier size limit). */
export async function readAudioFile(filePath: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const ext = path.extname(filePath).toLowerCase();
  if (!AUDIO_TYPES[ext]) throw new VoiceInputError('UNSUPPORTED_FORMAT', `Unsupported audio format "${ext || '?'}". Use one of: ${Object.keys(AUDIO_TYPES).join(' ')}`);
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    throw new VoiceInputError('NOT_FOUND', 'Audio file not found.');
  }
  if (size === 0) throw new VoiceInputError('EMPTY', 'Audio file is empty.');
  if (size > MAX_AUDIO_BYTES) throw new VoiceInputError('TOO_LARGE', `Audio is ${(size / 1048576).toFixed(1)} MB; the free tier allows 25 MB.`);
  return { bytes: new Uint8Array(await readFile(filePath)), filename: path.basename(filePath) };
}

/**
 * Groq Whisper transcription (OpenAI-compatible /audio/transcriptions). Audio is sent once and never
 * stored by this app; only the confirmed transcript enters the conversation.
 */
export class GroqWhisper implements SpeechToText {
  readonly label: string;
  private readonly opts: { apiKey: string; model: string; fetchImpl?: FetchLike; retry?: RetryPolicy };

  constructor(opts: { apiKey: string; model: string; fetchImpl?: FetchLike; retry?: RetryPolicy }) {
    this.opts = opts;
    this.label = `groq/${opts.model}`;
  }

  async transcribe(audio: { bytes: Uint8Array; filename: string }, signal: AbortSignal, opts: { language?: string } = {}): Promise<Transcript> {
    const ext = path.extname(audio.filename).toLowerCase();
    const type = AUDIO_TYPES[ext];
    if (!type) throw new VoiceInputError('UNSUPPORTED_FORMAT', `Unsupported audio format "${ext || '?'}".`);
    if (audio.bytes.byteLength > MAX_AUDIO_BYTES) throw new VoiceInputError('TOO_LARGE', 'Audio exceeds the 25 MB free-tier limit.');
    const form = new FormData();
    form.append('file', new Blob([audio.bytes], { type }), audio.filename);
    form.append('model', this.opts.model);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    form.append('prompt', DEFAULT_PROMPT);
    if (opts.language) form.append('language', opts.language);
    const response = await sendWithRetry({
      fetchImpl: this.opts.fetchImpl ?? fetch,
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
      signal,
      providerName: `Groq ${this.opts.model}`,
      ...(this.opts.retry ? { retry: this.opts.retry } : {}),
    });
    const parsed = VerboseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'Transcription response did not match the expected shape');
    const segments = parsed.data.segments ?? [];
    const lowConfidence = segments.some((s) => (s.avg_logprob ?? 0) < -1 || (s.no_speech_prob ?? 0) > 0.6) || parsed.data.text.trim().length === 0;
    return {
      text: parsed.data.text.trim(),
      language: parsed.data.language ?? null,
      durationSec: parsed.data.duration ?? null,
      lowConfidence,
      model: this.opts.model,
    };
  }
}
