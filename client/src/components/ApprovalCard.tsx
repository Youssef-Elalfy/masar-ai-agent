import { useState } from 'react';
import { Check, CircleX, LoaderCircle, ShieldAlert } from 'lucide-react';
import type { ApprovalView } from '../../../server/src/web/contracts.ts';
import { api, ApiError } from '../api/client.ts';
import { hasKey } from '../lib/i18n.ts';
import type { SettingsApi } from '../state/settings.ts';

type Phase = 'idle' | 'sending' | 'approved' | 'declined' | 'error';

function previewRows(preview: unknown): Array<[string, string]> {
  if (preview === null || typeof preview !== 'object') return [];
  return Object.entries(preview as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' '), typeof v === 'string' ? v : JSON.stringify(v)]);
}

/**
 * A write action the agent wants to run (lead, quote, handoff). The server already masked the preview.
 * The decision is sent once; the agent then continues only because the customer said so.
 */
export function ApprovalCard({ approval, s, onDecided }: { approval: ApprovalView; s: SettingsApi; onDecided: (approved: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const titleKey = `tool_${approval.toolName}`;
  const title = hasKey(titleKey) ? s.t(titleKey) : approval.toolName;

  const decide = async (approved: boolean) => {
    setPhase('sending');
    setError(null);
    try {
      await api.decideApproval(approval.approvalId, approved);
      setPhase(approved ? 'approved' : 'declined');
      onDecided(approved);
    } catch (err) {
      setPhase('error');
      setError(err instanceof ApiError && err.code === 'APPROVAL_NOT_PENDING' ? s.t('approvalExpired') : err instanceof ApiError && err.code === 'OFFLINE' ? s.t('errOffline') : s.t('errGeneric'));
    }
  };

  const locked = phase !== 'idle' && phase !== 'error';
  return (
    <section role="group" aria-labelledby={`ap-${approval.approvalId}`} className="card-glass !border-s-[3px] !border-s-warning p-4 mt-3 flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <ShieldAlert size={18} className="text-warning" aria-hidden="true" />
        <h3 id={`ap-${approval.approvalId}`} className="font-semibold">{s.t('approvalNeeded')}: <span className="font-normal">{title}</span></h3>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
        {previewRows(approval.preview).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted capitalize">{k}</dt>
            <dd dir="auto" className="break-words">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-meta text-muted">{s.t('approvalNote')}</p>
      {phase === 'approved' || phase === 'declined' ? (
        <p className={`flex items-center gap-2 font-medium ${phase === 'approved' ? 'text-success' : 'text-muted'}`} role="status">
          {phase === 'approved' ? <Check size={16} aria-hidden="true" /> : <CircleX size={16} aria-hidden="true" />}
          {phase === 'approved' ? s.t('approved') : s.t('declined')}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" disabled={locked} onClick={() => void decide(true)}>
            {phase === 'sending' ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
            {s.t('approve')}
          </button>
          <button type="button" className="btn btn-secondary" disabled={locked} onClick={() => void decide(false)}>{s.t('decline')}</button>
        </div>
      )}
      {error && <p className="text-small text-danger" role="alert">{error}</p>}
    </section>
  );
}
