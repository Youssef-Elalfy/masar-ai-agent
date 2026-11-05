import { motion } from 'motion/react';
import { Check, CircleAlert, ExternalLink, FlaskConical, Globe, Plane, Scale, ShieldCheck, X } from 'lucide-react';
import type { Card, CompanyPackageCard, ComparisonCard, CrmRecordCard, ExternalOfferCard, ResearchNotice } from '../../../../server/src/web/contracts.ts';
import { formatCairo, formatMoney } from '../../lib/format.ts';
import type { SettingsApi } from '../../state/settings.ts';

type T = SettingsApi['t'];
type Lang = SettingsApi['lang'];

const cardBase = 'card-glass card-lift p-5';

// Pricing-basis phrases stored in the demo catalog (English data) shown in the reader's language; unknown text as is.
const BASIS_AR: Record<string, string> = {
  'per adult in double occupancy': 'للفرد البالغ في غرفة مزدوجة',
  'per adult': 'للفرد البالغ',
  'per person': 'للفرد',
};
const priceBasis = (basis: string, lang: Lang) => (lang === 'ar' ? BASIS_AR[basis.trim().toLowerCase()] ?? basis : basis);

function PackageCardView({ card, t, lang, onAsk }: { card: CompanyPackageCard; t: T; lang: Lang; onAsk: (text: string) => void }) {
  const name = lang === 'en' && card.nameEn ? card.nameEn : card.nameAr;
  const destination = lang === 'ar' && card.destinationAr ? card.destinationAr : card.destination;
  return (
    <article className={`${cardBase} flex flex-col gap-3.5`} aria-label={name}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-bold text-[17px] leading-snug" dir="auto">{name}</h3>
          <p className="text-meta text-muted mt-0.5" dir="auto">
            {destination} · <span className="tabular">{t('daysNights', { d: card.days, n: card.nights })}</span>
          </p>
        </div>
        <span className="badge badge-demo shrink-0"><FlaskConical size={13} aria-hidden="true" />{t('demoPackage')}</span>
      </header>
      <div>
        <p className="price text-price font-semibold text-[20px] leading-tight">
          <bdi>{formatMoney(card.price.amount, card.price.currency, lang)}</bdi>
          <span className="text-meta text-muted font-normal ms-1.5">{t('perPerson')}</span>
        </p>
        <p className="text-meta text-muted mt-0.5" dir="auto">{priceBasis(card.price.basis, lang)}</p>
        {card.partyTotal?.amount != null && (
          <p className="text-small mt-1">
            {t('partyTotal')}: <bdi className="tabular font-medium">{formatMoney(card.partyTotal.amount, card.price.currency, lang)}</bdi>
          </p>
        )}
      </div>
      {(card.inclusions.length > 0 || card.exclusions.length > 0) && (
        <div className="grid gap-2 text-small sm:grid-cols-2">
          {card.inclusions.length > 0 && (
            <div>
              <p className="text-meta text-muted mb-1">{t('included')}</p>
              <ul className="space-y-1.5">
                {card.inclusions.slice(0, 5).map((x) => (
                  <li key={x} className="flex gap-2" dir="auto"><Check size={15} className="text-success shrink-0 mt-1" aria-hidden="true" />{x}</li>
                ))}
              </ul>
            </div>
          )}
          {card.exclusions.length > 0 && (
            <div>
              <p className="text-meta text-muted mb-1">{t('excluded')}</p>
              <ul className="space-y-1.5">
                {card.exclusions.slice(0, 4).map((x) => (
                  <li key={x} className="flex gap-2" dir="auto"><X size={15} className="text-danger shrink-0 mt-1" aria-hidden="true" />{x}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="mt-auto pt-1">
        <button type="button" className="btn btn-secondary text-small" onClick={() => onAsk(lang === 'ar' ? `تفاصيل برنامج ${name}؟` : `Tell me the details of ${name}.`)}>
          {t('askDetails')}
        </button>
      </div>
    </article>
  );
}

function OfferCardView({ card, t, lang }: { card: ExternalOfferCard; t: T; lang: Lang }) {
  const flight = card.listingType === 'flight_fare';
  return (
    <article className={`${cardBase} flex flex-col gap-3.5`} aria-label={card.title ?? card.provider}>
      <header className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-meta text-muted break-all" dir="ltr" title={card.provider}>{card.provider}</span>
          <span className="badge badge-ext shrink-0"><Globe size={13} aria-hidden="true" />{t('external')}</span>
        </div>
        <h3 className="font-semibold leading-snug line-clamp-2" dir="auto">{card.title ?? card.destination}</h3>
        <div className="flex flex-wrap gap-1.5">
          <span className="badge bg-raised text-muted">{flight ? <Plane size={13} aria-hidden="true" /> : null}{flight ? t('flightOnly') : t('packageTour')}</span>
          {card.days !== null && <span className="badge bg-raised text-muted tabular">{card.nights !== null ? t('daysNights', { d: card.days, n: card.nights }) : t('daysOnly', { d: card.days })}</span>}
        </div>
      </header>
      <div>
        {card.price ? (
          <p className="price text-price font-semibold text-[19px]">
            <bdi>{formatMoney(card.price.amount, card.price.currency, lang)}</bdi>
            {card.price.basis && <span className="text-meta text-muted font-normal ms-1.5" dir="auto">{card.price.basis}</span>}
          </p>
        ) : card.pricesFound.length > 1 ? (
          <div>
            <p className="font-semibold text-price">{t('severalPrices')}</p>
            <ul className="flex flex-wrap gap-1.5 mt-1.5">
              {card.pricesFound.slice(0, 4).map((p, i) => (
                <li key={`${p.text}-${i}`} className="badge bg-raised text-fg" title={p.text}><bdi className="tabular">{formatMoney(p.amount, p.currency, lang)}</bdi></li>
              ))}
            </ul>
            <p className="text-meta text-muted mt-1.5">{t('severalPricesNote')}</p>
          </div>
        ) : (
          <p className="text-muted">{t('priceNotStated')}</p>
        )}
      </div>
      <footer className="mt-auto flex flex-col gap-1.5 pt-1">
        <p className="text-meta text-muted"><time dateTime={card.retrievedAt}>{t('retrieved', { t: formatCairo(card.retrievedAt, lang) })}</time></p>
        {card.url && (
          <a href={card.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-link text-small font-medium underline underline-offset-4 w-fit">
            {t('viewSource')}<ExternalLink size={14} aria-hidden="true" />
          </a>
        )}
      </footer>
    </article>
  );
}

function ResearchNoticeView({ card, t }: { card: ResearchNotice; t: T }) {
  const ok = card.status === 'ok' || card.status === 'no_results';
  return (
    <div className={`rounded-card border p-3.5 flex gap-3 ${ok ? 'border-line bg-surface' : 'border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-warning-bg'}`} role="note">
      {ok ? <ShieldCheck size={20} className="text-ext shrink-0 mt-0.5" aria-hidden="true" /> : <CircleAlert size={20} className="text-warning shrink-0 mt-0.5" aria-hidden="true" />}
      <div className="text-small">
        <p className="font-medium">
          {ok ? t('researchDone', { n: card.resultCount, p: card.provider ?? 'web' }) : t('researchFailed', { s: card.status })}
        </p>
        {ok && <p className="text-muted">{t('researchNote')}</p>}
      </div>
    </div>
  );
}

function ComparisonView({ card, t, lang }: { card: ComparisonCard; t: T; lang: Lang }) {
  return (
    <div className={`${cardBase} p-0 overflow-hidden`}>
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-line">
        <h3 className="font-semibold flex items-center gap-2"><Scale size={18} aria-hidden="true" className="text-accent" />{t('comparison')}</h3>
        <span className="badge badge-demo"><FlaskConical size={13} aria-hidden="true" />{t('demoPackage')}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-small">
          <tbody>
            {card.rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <th scope="row" className="text-start font-medium px-4 py-2.5" dir="auto">{lang === 'en' && r.nameEn ? r.nameEn : r.nameAr}</th>
                <td className="px-3 py-2.5 text-muted tabular whitespace-nowrap">{t('daysNights', { d: r.days, n: r.nights })}</td>
                <td className="px-4 py-2.5 text-end whitespace-nowrap">
                  <bdi className="price text-price font-semibold">{formatMoney(r.price.amount, r.price.currency, lang)}</bdi>
                  {card.cheapestId === r.id && <span className="badge badge-ok ms-2"><Check size={12} aria-hidden="true" />{t('cheapest')}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!card.sameCurrency && <p className="px-4 py-2 text-meta text-warning">{t('noConversion')}</p>}
    </div>
  );
}

function CrmRecordView({ card, t }: { card: CrmRecordCard; t: T }) {
  const label = card.record === 'lead' ? t('crmLead') : card.record === 'quote' ? t('crmQuote') : t('crmHandoff');
  return (
    <div className="rounded-card border border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-success-bg p-3.5 flex gap-3" role="status">
      <Check size={20} className="text-success shrink-0 mt-0.5" aria-hidden="true" />
      <div className="text-small">
        <p className="font-medium">
          {label} · <bdi dir="ltr" className="tabular">{card.reference}</bdi> · {card.created ? t('crmCreated') : t('crmExisting')}
        </p>
        <p className="text-muted">{t('crmNote')}</p>
      </div>
    </div>
  );
}

/** Result cards of one assistant answer (max 5 staggered entrances; amounts never animate). */
export function Cards({ cards, t, lang, reducedMotion, onAsk }: { cards: Card[]; t: T; lang: Lang; reducedMotion: boolean; onAsk: (text: string) => void }) {
  if (cards.length === 0) return null;
  const notices = cards.filter((c) => c.kind === 'research_notice' || c.kind === 'crm_record' || c.kind === 'comparison');
  const grid = cards.filter((c) => c.kind === 'company_package' || c.kind === 'external_offer');
  const item = (i: number) => ({
    initial: reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: reducedMotion ? 0 : 0.27, delay: reducedMotion ? 0 : Math.min(i, 4) * 0.045, ease: [0.22, 1, 0.36, 1] as const },
  });
  return (
    <div className="flex flex-col gap-3.5 mt-4">
      {notices.map((c, i) => (
        <motion.div key={`${c.kind}-${i}`} {...item(i)}>
          {c.kind === 'research_notice' && <ResearchNoticeView card={c} t={t} />}
          {c.kind === 'crm_record' && <CrmRecordView card={c} t={t} />}
          {c.kind === 'comparison' && <ComparisonView card={c} t={t} lang={lang} />}
        </motion.div>
      ))}
      {grid.length > 0 && (
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))]">
          {grid.map((c, i) => (
            <motion.div key={c.kind === 'company_package' || c.kind === 'external_offer' ? c.id : i} {...item(i + notices.length)} className="flex">
              <div className="w-full flex [&>article]:w-full">
                {c.kind === 'company_package' && <PackageCardView card={c} t={t} lang={lang} onAsk={onAsk} />}
                {c.kind === 'external_offer' && <OfferCardView card={c} t={t} lang={lang} />}
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
