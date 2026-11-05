import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { markIntroFinished } from '../lib/intro.ts';
import { LivingOrb, type OrbState } from './LivingOrb.tsx';

/**
 * Dev-only QA harness (client/orb-lab.html, served by `vite`, never part of the production build): renders the real
 * LivingOrb large on the real theme background so close-ups, recordings and per-state FPS can be captured.
 * ?state=idle|thinking|searching|listening|responding|error  &theme=dark|light  &amp=0..1 (fixed test level for the
 * listening close-up only; in the app the level always comes from the real microphone)  &cycle=1 (steps through every
 * state every 2.5 s for the motion recording).
 */
const params = new URLSearchParams(window.location.search);
const STATES: OrbState[] = ['idle', 'thinking', 'searching', 'listening', 'responding', 'error'];
const stateParam = params.get('state');
const state: OrbState = STATES.find((s) => s === stateParam) ?? 'idle';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const amp = { current: Number(params.get('amp') ?? 0) };
document.documentElement.dataset['theme'] = theme;
markIntroFinished();

function Lab() {
  const [current, setCurrent] = useState<OrbState>(state);
  useEffect(() => {
    if (params.get('cycle') !== '1') return;
    let i = 0;
    const t = window.setInterval(() => {
      i = (i + 1) % STATES.length;
      const next = STATES[i] ?? 'idle';
      amp.current = next === 'listening' ? 0.35 : 0;
      setCurrent(next);
    }, 2500);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--lb-base)' }}>
      <div style={{ width: 600, height: 600 }} data-lab-state={current}>
        <LivingOrb state={current} theme={theme} reducedMotion={false} docked={false} amplitudeRef={amp} />
      </div>
      <p style={{ position: 'fixed', bottom: 16, insetInline: 0, textAlign: 'center', color: 'var(--muted)', font: '14px system-ui' }}>{current}</p>
    </div>
  );
}

const root = document.getElementById('lab');
if (root) createRoot(root).render(<Lab />);
