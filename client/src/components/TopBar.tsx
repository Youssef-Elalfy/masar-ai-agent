import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Check, Languages, Menu, Moon, PanelRight, Settings2, Sun, Wind } from 'lucide-react';
import type { SettingsApi } from '../state/settings.ts';
import { LogoMark } from './Logo.tsx';

export type Connection = 'connecting' | 'connected' | 'offline';

interface Props {
  s: SettingsApi;
  connection: Connection;
  model: string | null;
  /** Settings collapse into one menu (the bar is narrower than the full control row). */
  compact: boolean;
  /** The history panel (with the brand) is hidden, so the bar carries the brand name. */
  brandInBar: boolean;
  onMenu: (() => void) | null;
  onContext: (() => void) | null;
  orbAnchor: (el: HTMLDivElement | null) => void;
  orbDocked: boolean;
  /** Present only while a real turn is running (from server events). */
  activity: string | null;
}

function ConnectionPill({ connection, s }: { connection: Connection; s: SettingsApi }) {
  const style = connection === 'connected' ? 'badge-ok' : connection === 'offline' ? 'badge-danger' : 'bg-raised text-muted';
  return (
    <span role="status" className={`conn-pill badge ${style} !py-1`} title={connection === 'connected' ? s.t('connected') : connection === 'offline' ? s.t('offline') : s.t('connecting')}>
      <span className={`status-dot ${connection === 'connecting' ? 'hollow' : ''}`} aria-hidden="true" />
      <span className="conn-text">{connection === 'connected' ? s.t('connected') : connection === 'offline' ? s.t('offline') : s.t('connecting')}</span>
    </span>
  );
}

export function TopBar({ s, connection, model, compact, brandInBar, onMenu, onContext, orbAnchor, orbDocked, activity }: Props) {
  const item = 'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-small outline-none cursor-pointer data-[highlighted]:bg-raised';
  return (
    <header className="topbar flex items-center gap-2 sm:gap-3 h-16 px-2 sm:px-6 border-b border-line shrink-0">
      {onMenu && <button type="button" className="icon-btn" aria-label={s.t('menu')} onClick={onMenu}><Menu size={20} aria-hidden="true" /></button>}
      {/* Dock slot for the Living Orb once the conversation has messages (the orb itself is decorative). It only takes
          space when it shows something — the docked orb, or the brand symbol on narrow screens — so the title is
          otherwise anchored at the bar's start edge (right in Arabic, left in English). No width transition: the
          orb's flight to the dock is measured against the slot's final size. */}
      <div
        ref={orbAnchor}
        className={`h-11 shrink-0 grid place-items-center ${orbDocked || brandInBar ? 'w-11 -ms-1' : 'w-0 -me-2 sm:-me-3'}`}
        aria-hidden="true"
      >
        {/* While the orb is the hero of an empty conversation, the static symbol holds its dock slot. */}
        {brandInBar && <LogoMark size={30} className={`transition-opacity duration-300 ${orbDocked ? 'opacity-0' : 'opacity-100'}`} />}
      </div>
      <div className="min-w-0 flex flex-col gap-0.5 leading-tight text-start">
        <h1 className="font-semibold truncate text-[15px] sm:text-[16px]">{brandInBar ? s.t('brand') : s.t('workspace')}</h1>
        {/* Text twin of the orb state: only shown while the server reports real work on this turn. */}
        <p className={`text-meta truncate ${activity ? 'text-accent' : 'text-muted'}`}>{activity ?? s.t('readyStatus')}</p>
      </div>
      <div className="ms-auto flex items-center gap-1.5">
        <ConnectionPill connection={connection} s={s} />
        {model && !compact && <span className="hidden xl:inline text-meta text-faint tabular" dir="ltr" title={model}>{model.split('→')[0]}</span>}
        {!compact && (
          <>
            <div role="group" aria-label={s.t('language')} className="flex rounded-input border border-line p-0.5">
              {(['ar', 'en'] as const).map((l) => (
                <button key={l} type="button" aria-pressed={s.lang === l} onClick={() => s.update({ lang: l })}
                  className={`px-2.5 py-1 rounded-[9px] text-meta font-medium ${s.lang === l ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}>
                  {l === 'ar' ? 'عربي' : 'EN'}
                </button>
              ))}
            </div>
            <button type="button" className="icon-btn" aria-label={`${s.t('theme')}: ${s.theme === 'dark' ? s.t('dark') : s.t('light')}`} title={s.t('theme')}
              onClick={() => s.update({ theme: s.theme === 'dark' ? 'light' : 'dark' })}>
              {s.theme === 'dark' ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
            </button>
            <button type="button" className="icon-btn" aria-pressed={s.reducedMotion} aria-label={s.t('reduceMotion')} title={s.t('reduceMotion')} disabled={s.systemReduce}
              onClick={() => s.update({ motion: s.motion === 'reduce' ? 'system' : 'reduce' })}>
              <Wind size={18} aria-hidden="true" />
            </button>
          </>
        )}
        {compact && (
          <Dropdown.Root dir={s.lang === 'ar' ? 'rtl' : 'ltr'}>
            <Dropdown.Trigger asChild>
              <button type="button" className="icon-btn" aria-label={s.t('settings')}><Settings2 size={19} aria-hidden="true" /></button>
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content align="end" sideOffset={6} className="z-50 min-w-[210px] panel panel-solid p-1.5">
                <Dropdown.Label className="px-2.5 py-1 text-meta text-muted flex items-center gap-2"><Languages size={14} aria-hidden="true" />{s.t('language')}</Dropdown.Label>
                {(['ar', 'en'] as const).map((l) => (
                  <Dropdown.Item key={l} className={item} onSelect={() => s.update({ lang: l })}>
                    <Check size={15} className={s.lang === l ? '' : 'invisible'} aria-hidden="true" />{l === 'ar' ? 'العربية' : 'English'}
                  </Dropdown.Item>
                ))}
                <Dropdown.Separator className="my-1 h-px bg-line" />
                <Dropdown.Item className={item} onSelect={() => s.update({ theme: s.theme === 'dark' ? 'light' : 'dark' })}>
                  {s.theme === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}{s.theme === 'dark' ? s.t('light') : s.t('dark')}
                </Dropdown.Item>
                <Dropdown.CheckboxItem className={item} checked={s.reducedMotion} disabled={s.systemReduce} onCheckedChange={(v) => s.update({ motion: v ? 'reduce' : 'system' })}>
                  <Wind size={15} aria-hidden="true" />{s.t('reduceMotion')}
                  <Dropdown.ItemIndicator className="ms-auto"><Check size={15} aria-hidden="true" /></Dropdown.ItemIndicator>
                </Dropdown.CheckboxItem>
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        )}
        {onContext && <button type="button" className="icon-btn" aria-label={s.t('context')} onClick={onContext}><PanelRight size={19} aria-hidden="true" className="flip" /></button>}
      </div>
    </header>
  );
}
