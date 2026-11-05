import { useEffect, useRef } from 'react';

export type BackgroundPreset = 'calm' | 'explore' | 'focus';
export type BackgroundState = 'idle' | 'thinking' | 'searching' | 'listening' | 'error';

interface Props {
  preset: BackgroundPreset;
  state: BackgroundState;
  motion: boolean;
  /** Live microphone level 0..1 (only while really recording); written as a CSS variable, no re-render. */
  amplitudeRef?: React.RefObject<number>;
}

// Shared route geometry (1440×900 design space, sliced to cover the viewport).
const ROUTES = [
  'M-60 700C240 560 460 760 720 610S1150 360 1500 420',
  'M-80 250C200 180 380 330 640 280S980 120 1520 200',
  'M180 980C320 760 600 800 800 690S1180 560 1480 620',
  'M900 -40C960 160 1180 220 1260 400S1300 700 1500 820',
] as const;
const NODES: ReadonlyArray<readonly [number, number]> = [[720, 610], [640, 280], [1060, 452], [360, 296], [1262, 400], [800, 690], [214, 238]];
const LINKS: ReadonlyArray<readonly [number, number]> = [[0, 5], [0, 2], [1, 3], [1, 2], [2, 4], [3, 6], [5, 2]];
// Ambient travellers (slow) and research travellers (fast, rendered only while a real tool call is running).
const TRAVELLERS = [
  { route: 0, dur: 14, begin: 0 }, { route: 0, dur: 14, begin: -7 }, { route: 1, dur: 17, begin: -3 },
  { route: 2, dur: 15, begin: -9 }, { route: 3, dur: 12, begin: -5 },
] as const;
const SEARCHERS = [
  { route: 0, dur: 3.2, begin: 0 }, { route: 1, dur: 3.8, begin: -1.2 }, { route: 2, dur: 3.5, begin: -2 }, { route: 3, dur: 2.9, begin: -0.6 },
] as const;

/**
 * "Living Travel Intelligence" background, CSS/SVG only (the 3D is reserved for the orb):
 * A aurora light · B liquid ribbons · C travel routes with moving points · D sparse network pulses ·
 * E grain + vignette depth · F damped pointer parallax. Every animation is transform/opacity on composited layers
 * or a handful of SVG points; reduced motion renders the same composition still. Decorative: aria-hidden.
 */
export function LivingBackground({ preset, state, motion, amplitudeRef }: Props) {
  const root = useRef<HTMLDivElement>(null);

  // Pointer parallax (±14px, damped, per-layer depth via CSS): fine pointers only; stops when the pointer rests.
  useEffect(() => {
    const el = root.current;
    if (!el || !motion || preset === 'calm' || !window.matchMedia('(pointer: fine)').matches) {
      el?.style.setProperty('--px', '0');
      el?.style.setProperty('--py', '0');
      return;
    }
    let raf = 0;
    let target = { x: 0, y: 0 };
    let pos = { x: 0, y: 0 };
    const tick = () => {
      pos = { x: pos.x + (target.x - pos.x) * 0.07, y: pos.y + (target.y - pos.y) * 0.07 };
      el.style.setProperty('--px', pos.x.toFixed(3));
      el.style.setProperty('--py', pos.y.toFixed(3));
      raf = Math.abs(target.x - pos.x) + Math.abs(target.y - pos.y) > 0.002 ? requestAnimationFrame(tick) : 0;
    };
    const onMove = (e: PointerEvent) => {
      target = { x: (e.clientX / window.innerWidth - 0.5) * -2, y: (e.clientY / window.innerHeight - 0.5) * -2 };
      if (!raf && !document.hidden) raf = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, [motion, preset]);

  // Listening: mirror the real microphone level into --amp (≤30 writes/s), reset when it stops.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (state !== 'listening' || !motion || !amplitudeRef) {
      el.style.setProperty('--amp', '0');
      return;
    }
    let last = 0;
    let raf = requestAnimationFrame(function loop(t) {
      if (t - last > 33) {
        el.style.setProperty('--amp', (amplitudeRef.current ?? 0).toFixed(3));
        last = t;
      }
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  }, [state, motion, amplitudeRef]);

  return (
    <div ref={root} className="lb" data-preset={preset} data-state={state} data-motion={motion ? 'on' : 'off'} aria-hidden="true">
      <div className="lb-layer lb-depth-1">
        <div className="lb-aurora" />
        <div className="lb-glow lb-a"><i /></div>
        <div className="lb-glow lb-b"><i /></div>
        <div className="lb-glow lb-c"><i /></div>
        <div className="lb-glow lb-err"><i /></div>
      </div>
      <div className="lb-layer lb-depth-2">
        <svg className="lb-ribbons" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" fill="none">
          <defs>
            <linearGradient id="lb-rib-a" x1="0" x2="1" y1="0" y2="0">
              <stop stopColor="#14D7C4" stopOpacity="0" />
              <stop offset=".3" stopColor="#14D7C4" />
              <stop offset=".65" stopColor="#38BDF8" />
              <stop offset="1" stopColor="#6366F1" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="lb-rib-b" x1="1" x2="0" y1="0" y2="0">
              <stop stopColor="#6366F1" stopOpacity="0" />
              <stop offset=".4" stopColor="#38BDF8" />
              <stop offset="1" stopColor="#14D7C4" stopOpacity="0" />
            </linearGradient>
          </defs>
          <g className="lb-rib lb-rib-1"><path d="M-120 520C180 380 420 640 760 500S1240 300 1580 420" stroke="url(#lb-rib-a)" strokeWidth="110" strokeLinecap="round" /></g>
          <g className="lb-rib lb-rib-2"><path d="M-120 700C260 600 520 820 860 690S1300 560 1580 650" stroke="url(#lb-rib-b)" strokeWidth="70" strokeLinecap="round" /></g>
        </svg>
      </div>
      <div className="lb-layer lb-depth-3">
        <svg className="lb-routes" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" fill="none">
          <defs>
            <linearGradient id="lb-route-g" x1="0" x2="1">
              <stop stopColor="#14D7C4" />
              <stop offset="1" stopColor="#38BDF8" />
            </linearGradient>
            <radialGradient id="lb-dot-g">
              <stop stopColor="#E8FFFB" />
              <stop offset=".35" stopColor="#14D7C4" />
              <stop offset="1" stopColor="#14D7C4" stopOpacity="0" />
            </radialGradient>
          </defs>
          <g className="lb-lines" stroke="currentColor" strokeWidth="1">
            {ROUTES.map((d, i) => <path key={d} id={`lb-r${i}`} d={d} vectorEffect="non-scaling-stroke" strokeDasharray={i % 2 ? '2 9' : undefined} />)}
          </g>
          <g className="lb-net" stroke="currentColor" strokeWidth="1">
            {LINKS.map(([a, b]) => {
              const p = NODES[a];
              const q = NODES[b];
              return p && q ? <line key={`${a}-${b}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} vectorEffect="non-scaling-stroke" /> : null;
            })}
          </g>
          <g className="lb-nodes">
            {NODES.map(([x, y], i) => (
              <g key={`${x}-${y}`} transform={`translate(${x} ${y})`}>
                <circle className="lb-node-pulse" r="14" style={{ animationDelay: `${-i * 1.7}s` }} />
                <circle className="lb-node" r="3" />
              </g>
            ))}
          </g>
          <g className="lb-arcs">
            {ROUTES.map((d) => <path key={d} d={d} pathLength={1} stroke="url(#lb-route-g)" strokeWidth="1.6" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
          </g>
          {motion && (
            <g className="lb-travellers">
              {TRAVELLERS.map((t) => (
                <circle key={`${t.route}${t.begin}`} r="5" fill="url(#lb-dot-g)">
                  <animateMotion dur={`${t.dur}s`} begin={`${t.begin}s`} repeatCount="indefinite" rotate="auto">
                    <mpath href={`#lb-r${t.route}`} />
                  </animateMotion>
                </circle>
              ))}
            </g>
          )}
          {motion && state === 'searching' && (
            <g className="lb-searchers">
              {SEARCHERS.map((t) => (
                <circle key={`${t.route}${t.begin}`} r="6" fill="url(#lb-dot-g)">
                  <animateMotion dur={`${t.dur}s`} begin={`${t.begin}s`} repeatCount="indefinite">
                    <mpath href={`#lb-r${t.route}`} />
                  </animateMotion>
                </circle>
              ))}
            </g>
          )}
        </svg>
      </div>
      <div className="lb-grain" />
      <div className="lb-vignette" />
    </div>
  );
}
