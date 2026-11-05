import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ArrowUp, LoaderCircle, Mic, Paperclip, Square, TriangleAlert, X } from 'lucide-react';
import type { TurnRequest } from '../../../server/src/web/contracts.ts';
import type { RecorderApi } from '../state/useRecorder.ts';
import type { SettingsApi } from '../state/settings.ts';
import { fieldDirection } from '../lib/markdown.ts';

export interface ComposerHandle {
  fill: (text: string) => void;
  focus: () => void;
}

interface Props {
  s: SettingsApi;
  busy: boolean;
  voiceEnabled: boolean;
  maxChars: number;
  recorder: RecorderApi;
  onSend: (text: string, input: TurnRequest['input']) => void;
  onStop: () => void;
}

/** Live microphone meter from real samples; paints its own bars (transform/opacity) at ~15 fps without React renders. */
function LevelMeter({ levelsRef }: { levelsRef: { readonly current: readonly number[] } }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bars = Array.from(box.current?.children ?? []).filter((c): c is HTMLElement => c instanceof HTMLElement);
    let last = 0;
    let raf = requestAnimationFrame(function paint(t) {
      if (t - last > 66) {
        const levels = levelsRef.current;
        bars.forEach((bar, i) => {
          const v = levels[i] ?? 0;
          bar.style.transform = `scaleY(${Math.max(0.08, Math.min(1, v)).toFixed(3)})`;
          bar.style.opacity = (0.45 + v * 0.55).toFixed(3);
        });
        last = t;
      }
      raf = requestAnimationFrame(paint);
    });
    return () => cancelAnimationFrame(raf);
  }, [levelsRef]);
  return (
    <div ref={box} className="flex-1 flex items-center gap-[3px] h-8">
      {levelsRef.current.map((_, i) => <span key={i} className="flex-1 max-w-[6px] h-full rounded-full bg-[var(--cyan-400)] origin-center" style={{ transform: 'scaleY(0.08)', opacity: 0.45 }} />)}
    </div>
  );
}

const clock = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ s, busy, voiceEnabled, maxChars, recorder, onSend, onStop }, ref) {
  const [text, setText] = useState('');
  // The transcript stays a "voice transcript" only while the customer sends it unedited.
  const [voiceSource, setVoiceSource] = useState<{ text: string; lowConfidence: boolean } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    fill: (value: string) => {
      setText(value);
      setVoiceSource(null);
      requestAnimationFrame(() => area.current?.focus());
    },
    focus: () => area.current?.focus(),
  }));

  // A finished transcription fills the box for review (never sent automatically).
  useEffect(() => {
    if (recorder.phase === 'review' && recorder.transcript) {
      setText(recorder.transcript.text);
      setVoiceSource({ text: recorder.transcript.text, lowConfidence: recorder.transcript.lowConfidence });
      requestAnimationFrame(() => area.current?.focus());
    }
  }, [recorder.phase, recorder.transcript]);

  // Auto-grow up to ~8 lines; an empty box is always one line (measured after layout and on resize).
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const fit = () => {
      el.style.height = '';
      if (el.value) el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [text]);

  const submit = () => {
    const value = text.trim();
    if (!value || busy || value.length > maxChars) return;
    const input: TurnRequest['input'] = voiceSource && voiceSource.text.trim() === value
      ? { kind: 'voice_transcript', lowConfidence: voiceSource.lowConfidence }
      : { kind: 'text' };
    onSend(value, input);
    setText('');
    setVoiceSource(null);
    if (recorder.phase === 'review') recorder.reset();
  };

  const recording = recorder.phase === 'recording' || recorder.phase === 'requesting';
  // A real RTL field in Arabic: empty (placeholder, caret) it follows the UI language — dir="auto" fell back to LTR
  // on an empty field. Once the customer types, it follows the text's dominant script (English typed in the
  // Arabic UI aligns left, and the reverse).
  const fieldDir = fieldDirection(text, s.lang);
  const voiceErrorText = recorder.error
    ? recorder.error.kind === 'denied' ? s.t('voiceDenied')
      : recorder.error.kind === 'no_mic' ? s.t('voiceNoMic')
      : recorder.error.kind === 'unavailable' ? s.t('voiceUnavailable')
      : recorder.error.kind === 'offline' ? s.t('errOffline')
      : recorder.error.kind === 'too_large' ? s.t('voiceTooLarge')
      : recorder.error.kind === 'unsupported' ? s.t('voiceUnsupported')
      : recorder.error.kind === 'empty' ? s.t('voiceEmpty')
      : s.t('errGeneric')
    : null;

  return (
    <div className="mx-auto w-full max-w-[840px] px-3 sm:px-8 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
      <p className="sr-only" aria-live="polite">
        {recorder.phase === 'recording' ? s.t('voiceRecording') : recorder.phase === 'transcribing' ? s.t('voiceTranscribing') : recorder.phase === 'review' ? s.t('voiceReview') : ''}
      </p>
      {recorder.phase === 'error' && voiceErrorText && (
        <div className="mb-2 flex items-start gap-2 rounded-input bg-danger-bg text-danger px-3 py-2 text-small" role="alert">
          <TriangleAlert size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1">{voiceErrorText}</span>
          <button type="button" className="underline underline-offset-4" onClick={() => { recorder.reset(); area.current?.focus(); }}>{s.t('typeInstead')}</button>
        </div>
      )}
      {recorder.phase === 'review' && recorder.transcript && (
        <p className="mb-1.5 flex flex-wrap items-center gap-2 text-meta text-muted">
          <Mic size={14} aria-hidden="true" />
          {s.t('voiceReview')}
          {recorder.transcript.durationSec !== null && <span className="tabular">· {clock(Math.round(recorder.transcript.durationSec))}</span>}
          {recorder.transcript.lowConfidence && <span className="badge badge-warn"><TriangleAlert size={12} aria-hidden="true" />{s.t('voiceLowConfidence')}</span>}
        </p>
      )}
      <div className="composer-shell" data-recording={recording}>
        {recording ? (
          <div className="flex items-center gap-3 px-3 py-2.5 min-h-[60px]" role="status" aria-label={`${s.t('voiceRecording')} ${clock(recorder.seconds - (recorder.seconds % 5))}`}>
            <span className="status-dot text-[var(--cyan-400)]" aria-hidden="true" />
            <span className="tabular text-small w-12" aria-hidden="true">{clock(recorder.seconds)}</span>
            <div className="flex-1 flex items-center gap-[3px] h-8" aria-hidden="true">
              {s.reducedMotion
                ? <span className="text-meta text-muted">{s.t('voiceRecording')}…</span>
                : <LevelMeter levelsRef={recorder.levelsRef} />}
            </div>
            <button type="button" className="icon-btn" aria-label={s.t('voiceCancel')} title={s.t('voiceCancel')} onClick={() => { recorder.cancel(); requestAnimationFrame(() => area.current?.focus()); }}><X size={18} aria-hidden="true" /></button>
            <button type="button" autoFocus className="btn btn-primary !rounded-full !px-3" aria-label={s.t('voiceStop')} onClick={recorder.stop} disabled={recorder.phase === 'requesting'}>
              <Square size={14} fill="currentColor" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <form
            className="flex items-end gap-2 p-2.5 ps-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label htmlFor="composer" className="sr-only">{s.t('composerPlaceholder')}</label>
            <textarea
              id="composer"
              ref={area}
              rows={1}
              dir={fieldDir}
              value={text}
              maxLength={maxChars}
              disabled={recorder.phase === 'transcribing'}
              placeholder={recorder.phase === 'transcribing' ? s.t('voiceTranscribing') : s.t('composerPlaceholder')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted min-h-[44px] max-h-[220px] focus-visible:!outline-none"
            />
            {voiceEnabled && (
              <>
                <input
                  ref={file}
                  type="file"
                  accept="audio/*,.ogg,.m4a,.mp3,.wav,.webm,.flac"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) recorder.upload(f);
                    e.target.value = '';
                  }}
                />
                <button type="button" className="icon-btn" aria-label={s.t('voiceUpload')} title={s.t('voiceUpload')} disabled={busy || recorder.phase === 'transcribing'} onClick={() => file.current?.click()}>
                  <Paperclip size={18} aria-hidden="true" />
                </button>
                <button type="button" className="icon-btn" aria-label={s.t('voiceRecord')} title={s.t('voiceRecord')} disabled={busy || recorder.phase === 'transcribing'} onClick={() => void recorder.start()}>
                  {recorder.phase === 'transcribing' ? <LoaderCircle size={18} className="spin" aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
                </button>
              </>
            )}
            {busy ? (
              <button type="button" className="btn btn-secondary !rounded-full !px-3 h-11" aria-label={s.t('stop')} title={s.t('stop')} onClick={onStop}>
                <Square size={14} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button type="submit" className="btn btn-brand !rounded-full !px-0 w-11 h-11" aria-label={s.t('send')} title={s.t('send')} disabled={!text.trim() || recorder.phase === 'transcribing'}>
                <ArrowUp size={19} aria-hidden="true" />
              </button>
            )}
          </form>
        )}
      </div>
      {recorder.phase === 'review' && (
        <div className="mt-1.5 flex justify-end">
          <button type="button" className="btn btn-ghost text-small !min-h-8" onClick={() => { recorder.reset(); setText(''); setVoiceSource(null); }}>{s.t('voiceDiscard')}</button>
        </div>
      )}
    </div>
  );
});
