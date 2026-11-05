import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { translate, type Lang, type StringKey } from '../lib/i18n.ts';

export type Theme = 'dark' | 'light';
export type MotionPref = 'system' | 'reduce';

interface Settings {
  lang: Lang;
  theme: Theme;
  motion: MotionPref;
}

const KEY = 'rahhal.settings.v1';

function load(): Settings {
  const fallback: Settings = {
    lang: navigator.language.toLowerCase().startsWith('en') ? 'en' : 'ar',
    theme: window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
    motion: 'system',
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return fallback;
    const p = parsed as Record<string, unknown>;
    return {
      lang: p['lang'] === 'en' || p['lang'] === 'ar' ? p['lang'] : fallback.lang,
      theme: p['theme'] === 'light' || p['theme'] === 'dark' ? p['theme'] : fallback.theme,
      motion: p['motion'] === 'reduce' ? 'reduce' : 'system',
    };
  } catch {
    return fallback;
  }
}

function subscribeReducedMotion(cb: () => void): () => void {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
const systemReducesMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Language, theme and motion preference: applied to <html>, persisted per browser (convenience only). */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);
  const systemReduce = useSyncExternalStore(subscribeReducedMotion, systemReducesMotion, () => false);
  const reducedMotion = settings.motion === 'reduce' || systemReduce;

  useEffect(() => {
    const html = document.documentElement;
    html.lang = settings.lang;
    html.dir = settings.lang === 'ar' ? 'rtl' : 'ltr';
    html.dataset['theme'] = settings.theme;
    html.dataset['motion'] = reducedMotion ? 'off' : 'on';
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      // Private mode or blocked storage: settings simply don't persist.
    }
  }, [settings, reducedMotion]);

  const t = useCallback((key: StringKey, vars?: Record<string, string | number>) => translate(settings.lang, key, vars), [settings.lang]);
  const update = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);
  // Memoised so consumers' effects only re-run when a setting actually changes.
  return useMemo(() => ({ ...settings, reducedMotion, systemReduce, t, update }), [settings, reducedMotion, systemReduce, t, update]);
}

export type SettingsApi = ReturnType<typeof useSettings>;
