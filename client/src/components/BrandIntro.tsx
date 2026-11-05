import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { SettingsApi } from '../state/settings.ts';
import { markIntroFinished } from '../lib/intro.ts';
import { Wordmark } from './Logo.tsx';

const KEY = 'masar.intro.v1';
const ROUTE = 'M5.5 43.5C6.4 38.2 7.1 33.2 7.62 29.22A18 9 -28 1 1 35.6 26.66';
const ease = [0.22, 1, 0.36, 1] as const;

function shouldPlay(reducedMotion: boolean): boolean {
  if (reducedMotion) return false;
  try {
    if (sessionStorage.getItem(KEY)) return false;
    sessionStorage.setItem(KEY, '1');
  } catch {
    // storage blocked: play once per page load
  }
  return true;
}

/**
 * Brand entrance (~1.6 s, once per browser session, never on conversation switches, skipped with reduced motion):
 * a route point travels the MASAR path, the symbol resolves, مَسَارٌ fades in, then the mark dissolves into the
 * Living Orb behind it. Decorative and non-blocking (pointer-events: none); the app is already live underneath.
 */
export function BrandIntro({ s }: { s: SettingsApi }) {
  const [play, setPlay] = useState(() => shouldPlay(s.reducedMotion));
  useEffect(() => {
    if (!play) {
      markIntroFinished();
      return;
    }
    const t = window.setTimeout(() => setPlay(false), 1300);
    return () => window.clearTimeout(t);
  }, [play]);

  return (
    <AnimatePresence onExitComplete={markIntroFinished}>
      {play && (
        <motion.div className="intro" aria-hidden="true" initial={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.45, ease } }}>
          <motion.div className="intro-mark" exit={{ scale: 1.6, opacity: 0, filter: 'blur(6px)', transition: { duration: 0.45, ease } }}>
            <svg viewBox="0 0 48 48" width="112" height="112" fill="none">
              <defs>
                <linearGradient id="intro-g" x1="4" y1="44" x2="44" y2="6" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#14D7C4" />
                  <stop offset=".55" stopColor="#38BDF8" />
                  <stop offset="1" stopColor="#6366F1" />
                </linearGradient>
              </defs>
              <motion.ellipse cx="24" cy="24" rx="18" ry="9" transform="rotate(-28 24 24)" stroke="url(#intro-g)" strokeWidth="1" initial={{ opacity: 0 }} animate={{ opacity: 0.38 }} transition={{ delay: 0.5, duration: 0.5 }} />
              <motion.path d={ROUTE} stroke="url(#intro-g)" strokeWidth="2.6" strokeLinecap="round"
                initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.8, ease: [0.65, 0, 0.35, 1] }} />
              {/* The travelling route point: a short bright dash riding just ahead of the drawn path. */}
              <motion.path d={ROUTE} stroke="#E8FFFB" strokeWidth="3.4" strokeLinecap="round" pathLength={1} strokeDasharray="0.02 1"
                initial={{ strokeDashoffset: 0.02, opacity: 1 }} animate={{ strokeDashoffset: -0.98, opacity: [1, 1, 0] }}
                transition={{ duration: 0.8, ease: [0.65, 0, 0.35, 1] }} />
              <motion.circle cx="5.5" cy="43.5" r="2.1" fill="url(#intro-g)" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ duration: 0.25, ease }} style={{ transformOrigin: '5.5px 43.5px' }} />
              <motion.circle cx="24" cy="24" r="5.6" fill="#14D7C4" initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.45, duration: 0.4, ease }} style={{ transformOrigin: '24px 24px' }} />
              <motion.circle cx="35.6" cy="26.66" r="3.1" fill="url(#intro-g)" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.72, duration: 0.3, ease }} style={{ transformOrigin: '35.6px 26.66px' }} />
            </svg>
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.55, duration: 0.45, ease }}>
              <Wordmark lang={s.lang} size="lg" />
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
