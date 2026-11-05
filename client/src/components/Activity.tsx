import { useState } from 'react';
import { Check, ChevronDown, CircleX, Hourglass, LoaderCircle, RefreshCcw } from 'lucide-react';
import type { Activity } from '../../../server/src/web/contracts.ts';
import { activityLabel } from '../lib/i18n.ts';
import type { LiveTool } from '../state/useAgent.ts';
import type { SettingsApi } from '../state/settings.ts';

type Step = { key: string; toolName: string; status: 'running' | 'ok' | 'error' | 'pending'; errorCode: string | null; latencyMs?: number | null };

export function StepIcon({ status }: { status: Step['status'] }) {
  if (status === 'running') return <LoaderCircle size={15} className="spin text-accent" aria-hidden="true" />;
  if (status === 'ok') return <Check size={15} className="text-success" aria-hidden="true" />;
  if (status === 'error') return <CircleX size={15} className="text-danger" aria-hidden="true" />;
  return <Hourglass size={15} className="text-warning" aria-hidden="true" />;
}

function stepText(step: Step, s: SettingsApi): string {
  const label = activityLabel(s.lang, step.toolName);
  if (step.status === 'pending') return `${label} · ${s.t('waitingApproval')}`;
  if (step.status === 'error') return `${label} · ${s.t('failed')}${step.errorCode ? ` (${step.errorCode})` : ''}`;
  return label;
}

/** Live progress of the running turn, straight from server tool events (no timers, no invented steps). */
export function LiveActivity({ tools, groundingChecks, s }: { tools: LiveTool[]; groundingChecks: number; s: SettingsApi }) {
  return (
    <ul className="flex flex-col gap-1 text-small text-muted" aria-label={s.t('activity')}>
      {tools.map((tool) => (
        <li key={tool.key} className="flex items-center gap-2">
          <StepIcon status={tool.status} />
          <span>{stepText(tool, s)}</span>
          {tool.latencyMs !== null && <span className="text-meta text-faint tabular">{(tool.latencyMs / 1000).toFixed(1)}s</span>}
        </li>
      ))}
      {groundingChecks > 0 && (
        <li className="flex items-center gap-2"><RefreshCcw size={15} className="text-accent" aria-hidden="true" />{s.t('groundingRecheck')}</li>
      )}
    </ul>
  );
}

/** Collapsed summary of the tools an answer used ("Used 2 tools · Show"). */
export function ActivitySummary({ activity, s }: { activity: Activity[]; s: SettingsApi }) {
  const [open, setOpen] = useState(false);
  if (activity.length === 0) return null;
  const failed = activity.filter((a) => a.outcome === 'error').length;
  return (
    <div className="mb-2.5">
      <button type="button" className="inline-flex items-center gap-1.5 text-meta text-muted hover:text-fg rounded-md py-1" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <StepIcon status={failed > 0 ? 'error' : activity.some((a) => a.outcome === 'pending') ? 'pending' : 'ok'} />
        {s.t('usedTools', { n: activity.length })} · {open ? s.t('hide') : s.t('show')}
        <ChevronDown size={14} aria-hidden="true" className={open ? 'rotate-180' : ''} />
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-1 text-small text-muted ps-1">
          {activity.map((a, i) => (
            <li key={`${a.toolName}-${i}`} className="flex items-center gap-2">
              <StepIcon status={a.outcome} />
              {stepText({ key: String(i), toolName: a.toolName, status: a.outcome, errorCode: a.errorCode }, s)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
