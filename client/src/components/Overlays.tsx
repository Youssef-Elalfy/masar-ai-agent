import { useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { motion } from 'motion/react';
import { LoaderCircle, X } from 'lucide-react';
import type { SettingsApi } from '../state/settings.ts';

const overlay = 'fixed inset-0 z-40 bg-[#0b122099] data-[state=open]:animate-none';

/** Confirmation for destructive actions; resolves only after the server confirms (errors stay visible). */
export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel, s, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; body: string; confirmLabel: string; s: SettingsApi; onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!busy) { setError(null); onOpenChange(o); } }}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay} />
        <Dialog.Content className="fixed z-50 inset-x-4 top-1/2 -translate-y-1/2 mx-auto max-w-[440px] max-h-[calc(100dvh-2rem)] overflow-y-auto panel panel-solid p-5 flex flex-col gap-4 focus:outline-none">
          <motion.div initial={s.reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: s.reducedMotion ? 0 : 0.23 }} className="flex flex-col gap-3">
            <Dialog.Title className="font-bold text-[18px]">{title}</Dialog.Title>
            <Dialog.Description className="text-muted">{body}</Dialog.Description>
            {error && <p className="text-small text-danger" role="alert">{error}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild><button type="button" className="btn btn-secondary" disabled={busy} autoFocus>{s.t('cancel')}</button></Dialog.Close>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await onConfirm();
                    onOpenChange(false);
                  } catch {
                    setError(s.t('errGeneric'));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Server-fixed memory consent wording (never model-authored). Focus starts on "Not now"; Esc declines. */
export function ConsentDialog({ open, text, s, onDecision }: { open: boolean; text: string; s: SettingsApi; onDecision: (grant: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (grant: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await onDecision(grant);
    } catch {
      setError(s.t('errGeneric'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o && !busy) void decide(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay} />
        <Dialog.Content className="fixed z-50 inset-x-4 top-1/2 -translate-y-1/2 mx-auto max-w-[480px] max-h-[calc(100dvh-2rem)] overflow-y-auto panel panel-solid p-5 flex flex-col gap-4 focus:outline-none">
          <Dialog.Title className="font-bold text-[18px]">{s.t('memoryDialogTitle')}</Dialog.Title>
          <Dialog.Description className="text-muted leading-relaxed" dir="auto">{text}</Dialog.Description>
          {error && <p className="text-small text-danger" role="alert">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" disabled={busy} autoFocus onClick={() => void decide(false)}>{s.t('notNow')}</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide(true)}>
              {busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
              {s.t('allow')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Off-canvas drawer (tablet/mobile): inline-start for history, inline-end or bottom sheet for context. */
export function Drawer({ open, onOpenChange, side, title, s, children }: {
  open: boolean; onOpenChange: (o: boolean) => void; side: 'start' | 'end' | 'bottom'; title: string; s: SettingsApi; children: ReactNode;
}) {
  const position = side === 'bottom'
    ? 'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-[22px] rounded-b-none'
    : `inset-y-0 ${side === 'start' ? 'start-0 rounded-e-[22px]' : 'end-0 rounded-s-[22px]'} w-[min(88vw,340px)] rounded-none`;
  const dir = s.lang === 'ar' ? -1 : 1;
  const from = side === 'bottom' ? { y: 24 } : { x: (side === 'start' ? -14 : 14) * dir };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay} />
        <Dialog.Content className={`fixed z-50 ${position} panel panel-solid !shadow-2xl flex flex-col focus:outline-none overflow-hidden`} aria-describedby={undefined}>
          <motion.div
            initial={s.reducedMotion ? { opacity: 0 } : { opacity: 0, ...from }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            transition={{ duration: s.reducedMotion ? 0 : 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-col min-h-0 h-full"
          >
            {side === 'bottom' && <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-line-strong" aria-hidden="true" />}
            <div className="flex items-center justify-between px-4 pt-3 pb-1">
              <Dialog.Title className="font-semibold">{title}</Dialog.Title>
              <Dialog.Close asChild><button type="button" className="icon-btn" aria-label={s.t('close')}><X size={18} aria-hidden="true" /></button></Dialog.Close>
            </div>
            <div className="min-h-0 flex-1 flex flex-col">{children}</div>
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
