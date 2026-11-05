import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, ClipboardList, Compass, ExternalLink, Activity as ActivityIcon, Link2, Trash2 } from 'lucide-react';
import type { CrmList, MemoryState } from '../../../server/src/web/contracts.ts';
import { api } from '../api/client.ts';
import { activityLabel } from '../lib/i18n.ts';
import { formatCairo } from '../lib/format.ts';
import type { AgentApi } from '../state/useAgent.ts';
import type { SettingsApi } from '../state/settings.ts';
import { StepIcon } from './Activity.tsx';
import { ConfirmDialog } from './Overlays.tsx';

const FILTER_LABELS: Record<string, { ar: string; en: string }> = {
  query: { ar: 'البحث', en: 'Search' }, destination: { ar: 'الوجهة', en: 'Destination' }, tripType: { ar: 'نوع الرحلة', en: 'Trip type' },
  minDays: { ar: 'أقل مدة (أيام)', en: 'Min days' }, maxDays: { ar: 'أقصى مدة (أيام)', en: 'Max days' }, days: { ar: 'المدة (أيام)', en: 'Days' },
  maxPricePerPerson: { ar: 'أقصى سعر للفرد', en: 'Max price / person' }, totalBudget: { ar: 'الميزانية الإجمالية', en: 'Total budget' },
  maxBudget: { ar: 'الميزانية', en: 'Budget' }, budgetCurrency: { ar: 'العملة', en: 'Currency' }, currency: { ar: 'العملة', en: 'Currency' },
  adults: { ar: 'بالغين', en: 'Adults' }, children: { ar: 'أطفال', en: 'Children' }, travelers: { ar: 'المسافرين', en: 'Travelers' },
  dateRange: { ar: 'الفترة', en: 'Dates' }, departureCity: { ar: 'مدينة السفر', en: 'Departure city' },
};

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 py-5 border-b border-line last:border-0">
      <h2 className="label-caps text-muted flex items-center gap-2.5">{icon}{title}</h2>
      {children}
    </section>
  );
}

export function ContextPanel({ agent, s, onEnableMemory, refreshKey }: { agent: AgentApi; s: SettingsApi; onEnableMemory: (state: MemoryState) => void; refreshKey: number }) {
  const [memory, setMemory] = useState<MemoryState | null>(null);
  const [crm, setCrm] = useState<CrmList | null>(null);
  const [confirm, setConfirm] = useState<null | 'memoryOff' | 'forgetAll' | 'crm'>(null);
  const [showTrace, setShowTrace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latest = useRef(0);
  const conversationId = agent.conversationId;
  const refresh = useCallback(async () => {
    const ticket = ++latest.current; // ignore out-of-order responses
    try {
      const [m, c] = await Promise.all([api.memory(conversationId), api.crm()]);
      if (ticket !== latest.current) return;
      setMemory(m);
      setCrm(c);
      setError(null);
    } catch {
      if (ticket === latest.current) setError('errGeneric');
    }
  }, [conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh, agent.revision, refreshKey]);

  const items = agent.view?.items ?? [];
  const journey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it?.role !== 'assistant') continue;
      const withFilters = [...it.activity].reverse().find((a) => a.filters);
      if (withFilters?.filters) return withFilters.filters;
    }
    return null;
  }, [items]);
  const sources = useMemo(() => {
    const seen = new Map<string, { url: string; provider: string; retrievedAt: string }>();
    for (const it of items) {
      if (it.role !== 'assistant') continue;
      for (const c of it.cards) if (c.kind === 'external_offer' && c.url && !seen.has(c.url)) seen.set(c.url, { url: c.url, provider: c.provider, retrievedAt: c.retrievedAt });
    }
    return [...seen.values()];
  }, [items]);
  const steps = agent.live?.tools ?? agent.lastTools;
  const traceId = agent.live?.traceId ?? agent.lastOutcome?.traceId ?? null;

  return (
    <aside aria-label={s.t('context')} className="scroll-area h-full px-6 py-2">
      <Section icon={<Compass size={15} aria-hidden="true" />} title={s.t('journey')}>
        {journey ? (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-small">
              {Object.entries(journey).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{FILTER_LABELS[k]?.[s.lang] ?? k}</dt>
                  <dd className="font-medium tabular" dir="auto">{String(v)}</dd>
                </div>
              ))}
            </dl>
            <p className="text-meta text-faint">{s.t('journeyFrom')}</p>
          </>
        ) : <p className="text-small text-muted">{s.t('journeyEmpty')}</p>}
      </Section>

      <Section icon={<ActivityIcon size={15} aria-hidden="true" />} title={s.t('activity')}>
        {steps.length === 0 ? <p className="text-small text-muted">{s.t('activityEmpty')}</p> : (
          <ul className="flex flex-col gap-1.5 text-small" aria-live="polite">
            {steps.map((t) => (
              <li key={t.key} className="flex items-center gap-2">
                <StepIcon status={t.status} />
                <span className="flex-1">{activityLabel(s.lang, t.toolName)}</span>
                {t.latencyMs !== null && <span className="text-meta text-faint tabular">{(t.latencyMs / 1000).toFixed(1)}s</span>}
              </li>
            ))}
          </ul>
        )}
        {traceId && (
          <div>
            <button type="button" className="text-meta text-muted underline underline-offset-4" aria-expanded={showTrace} onClick={() => setShowTrace((v) => !v)}>{s.t('advanced')}</button>
            {showTrace && <p className="mt-1 text-meta"><span className="text-muted">{s.t('traceId')}: </span><code dir="ltr" className="select-all">{traceId}</code></p>}
          </div>
        )}
      </Section>

      <Section icon={<Link2 size={15} aria-hidden="true" />} title={s.t('sources')}>
        {sources.length === 0 ? <p className="text-small text-muted">{s.t('sourcesEmpty')}</p> : (
          <ul className="flex flex-col gap-2">
            {sources.map((src) => (
              <li key={src.url} className="text-small">
                <a href={src.url} target="_blank" rel="noopener noreferrer nofollow" className="text-link underline underline-offset-4 inline-flex items-center gap-1 break-all" dir="ltr">
                  {src.provider}<ExternalLink size={13} aria-hidden="true" />
                </a>
                <p className="text-meta text-faint">{formatCairo(src.retrievedAt, s.lang)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={<Brain size={15} aria-hidden="true" />} title={s.t('memory')}>
        {memory && (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className={`badge ${memory.consent === 'active' ? 'badge-ok' : 'bg-raised text-muted'}`}>
                {memory.consent === 'active' ? s.t('memoryOn') : memory.consent === 'declined' ? s.t('memoryDeclined') : s.t('memoryOff')}
              </span>
              {memory.consent === 'active'
                ? <button type="button" className="text-meta text-danger underline underline-offset-4" onClick={() => setConfirm('memoryOff')}>{s.t('memoryDisable')}</button>
                : <button type="button" className="btn btn-secondary !min-h-8 text-small" onClick={() => onEnableMemory(memory)}>{s.t('memoryEnable')}</button>}
            </div>
            {memory.consent === 'active' && (memory.items.length === 0 ? <p className="text-small text-muted">{s.t('memoryEmpty')}</p> : (
              <ul className="flex flex-col gap-1.5">
                {memory.items.map((m) => (
                  <li key={m.id} className="flex items-start gap-2 text-small rounded-input bg-raised/60 px-2.5 py-2">
                    <span className="flex-1 min-w-0" dir="auto"><span className="text-muted">{m.category}: </span>{m.content}</span>
                    <button
                      type="button"
                      className="icon-btn !w-7 !h-7 shrink-0"
                      aria-label={`${s.t('forget')}: ${m.content}`}
                      title={s.t('forget')}
                      onClick={async () => {
                        try {
                          await api.forgetItem(m.id);
                          await refresh();
                        } catch {
                          setError('errGeneric');
                        }
                      }}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ))}
            {memory.consent === 'active' && memory.items.length > 1 && (
              <button type="button" className="text-meta text-danger underline underline-offset-4 w-fit" onClick={() => setConfirm('forgetAll')}>{s.t('forgetAll')}</button>
            )}
          </>
        )}
      </Section>

      <Section icon={<ClipboardList size={15} aria-hidden="true" />} title={s.t('crm')}>
        {crm && (crm.records.length === 0 ? <p className="text-small text-muted">{s.t('crmEmpty')}</p> : (
          <>
            <ul className="flex flex-col gap-1.5 text-small">
              {crm.records.map((r) => (
                <li key={r.reference} className="rounded-input bg-raised/60 px-2.5 py-2">
                  <p className="font-medium"><bdi dir="ltr" className="tabular">{r.reference}</bdi> · {r.kind === 'lead' ? s.t('crmLead') : r.kind === 'quote' ? s.t('crmQuote') : s.t('crmHandoff')}</p>
                  <p className="text-meta text-muted" dir="auto">{r.detail} · {r.status}</p>
                </li>
              ))}
            </ul>
            <p className="text-meta text-faint">{s.t('crmNote')}</p>
            <button type="button" className="text-meta text-danger underline underline-offset-4 w-fit" onClick={() => setConfirm('crm')}>{s.t('crmDeleteAll')}</button>
          </>
        ))}
      </Section>
      {error && <p className="text-small text-danger py-2" role="alert">{s.t('errGeneric')}</p>}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => { if (!o) setConfirm(null); }}
        title={s.t('confirmTitle')}
        body={confirm === 'memoryOff' ? s.t('memoryDisableBody') : confirm === 'forgetAll' ? s.t('forgetAllBody') : s.t('crmDeleteBody')}
        confirmLabel={s.t('delete')}
        s={s}
        onConfirm={async () => {
          if (confirm === 'memoryOff') await api.revokeMemory();
          else if (confirm === 'forgetAll') await Promise.all((memory?.items ?? []).map((m) => api.forgetItem(m.id)));
          else await api.deleteCrm();
          await refresh();
        }}
      />
    </aside>
  );
}
