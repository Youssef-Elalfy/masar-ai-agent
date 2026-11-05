import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client.ts';
import type { TranscriptView } from '../../../server/src/web/contracts.ts';

export type RecorderPhase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'review' | 'error';
export type RecorderError = 'denied' | 'no_mic' | 'unsupported' | 'too_large' | 'server' | 'offline' | 'unavailable' | 'empty';

const MAX_SECONDS = 120;
const BARS = 24;
const PREFERRED = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

/**
 * Voice note capture → server transcription (Groq Whisper via /api/voice/transcribe) → transcript review.
 * The level meter and `amplitudeRef` come from the live microphone signal only; there is no simulated waveform.
 */
export function useRecorder(maxBytes: number) {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [error, setError] = useState<{ kind: RecorderError; message: string | null } | null>(null);
  const [seconds, setSeconds] = useState(0);
  // Level history for the meter, kept in a ref: the meter paints itself, so recording never re-renders the app.
  const levelsRef = useRef<number[]>(new Array<number>(BARS).fill(0));
  const [transcript, setTranscript] = useState<TranscriptView | null>(null);
  const amplitudeRef = useRef(0);
  const media = useRef<{ stream: MediaStream; recorder: MediaRecorder; ctx: AudioContext; raf: number; timer: number; chunks: Blob[]; discard: boolean } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const release = useCallback(() => {
    const m = media.current;
    if (!m) return;
    cancelAnimationFrame(m.raf);
    window.clearInterval(m.timer);
    m.stream.getTracks().forEach((t) => t.stop());
    void m.ctx.close().catch(() => undefined);
    media.current = null;
    amplitudeRef.current = 0;
    levelsRef.current = new Array<number>(BARS).fill(0);
  }, []);

  useEffect(() => () => {
    // Unmount: discard, never upload a half recording.
    if (media.current) media.current.discard = true;
    release();
    abort.current?.abort();
  }, [release]);

  const transcribe = useCallback(async (blob: Blob) => {
    if (blob.size > maxBytes) {
      setError({ kind: 'too_large', message: null });
      setPhase('error');
      return;
    }
    if (blob.size < 512) {
      setError({ kind: 'empty', message: null });
      setPhase('error');
      return;
    }
    setPhase('transcribing');
    const controller = new AbortController();
    abort.current = controller;
    try {
      setTranscript(await api.transcribe(blob, controller.signal));
      setPhase('review');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const kind: RecorderError = err instanceof ApiError
        ? err.code === 'OFFLINE' ? 'offline' : err.code === 'VOICE_UNAVAILABLE' ? 'unavailable' : err.code === 'UNSUPPORTED_FORMAT' ? 'unsupported' : err.code === 'TOO_LARGE' ? 'too_large' : 'server'
        : 'server';
      setError({ kind, message: err instanceof Error ? err.message : null });
      setPhase('error');
    }
  }, [maxBytes]);

  const start = useCallback(async () => {
    setError(null);
    setTranscript(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError({ kind: 'no_mic', message: null });
      setPhase('error');
      return;
    }
    setPhase('requesting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      setError({ kind: denied ? 'denied' : 'no_mic', message: null });
      setPhase('error');
      return;
    }
    const mimeType = PREFERRED.find((m) => MediaRecorder.isTypeSupported(m));
    let recorder: MediaRecorder;
    let ctx: AudioContext;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      ctx = new AudioContext();
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      setError({ kind: 'no_mic', message: null });
      setPhase('error');
      return;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const history: number[] = new Array<number>(BARS).fill(0);
    let smooth = 0;
    let lastPaint = 0;
    const m = { stream, recorder, ctx, raf: 0, timer: 0, chunks: [] as Blob[], discard: false };
    media.current = m;

    const loop = (t: number) => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      const rms = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      smooth = smooth * 0.7 + rms * 0.3;
      amplitudeRef.current = smooth;
      if (t - lastPaint > 66) {
        history.shift();
        history.push(smooth);
        levelsRef.current = history;
        lastPaint = t;
      }
      m.raf = requestAnimationFrame(loop);
    };
    m.raf = requestAnimationFrame(loop);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) m.chunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(m.chunks, { type: (recorder.mimeType || mimeType || 'audio/webm').split(';')[0] ?? 'audio/webm' });
      const discard = m.discard;
      release();
      if (discard) setPhase('idle');
      else void transcribe(blob);
    };
    const startedAt = Date.now();
    setSeconds(0);
    m.timer = window.setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS && recorder.state === 'recording') recorder.stop();
    }, 250);
    recorder.start(1000);
    setPhase('recording');
  }, [release, transcribe]);

  const stop = useCallback(() => {
    const m = media.current;
    if (m && m.recorder.state === 'recording') m.recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    const m = media.current;
    if (m) {
      m.discard = true;
      if (m.recorder.state === 'recording') m.recorder.stop();
      else release();
    }
    abort.current?.abort();
    setTranscript(null);
    setError(null);
    setPhase('idle');
  }, [release]);

  const upload = useCallback((file: File) => {
    setError(null);
    setTranscript(null);
    void transcribe(file);
  }, [transcribe]);

  return { phase, error, seconds, levelsRef, transcript, amplitudeRef, maxSeconds: MAX_SECONDS, start, stop, cancel, upload, reset: cancel };
}

export type RecorderApi = ReturnType<typeof useRecorder>;
