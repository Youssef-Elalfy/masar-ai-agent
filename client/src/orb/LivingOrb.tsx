import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { introFinished } from '../lib/intro.ts';
import type { OrbQuality, OrbScene, OrbState, OrbTheme } from './OrbScene.ts';

export type { OrbState };
/** full / reduced = WebGL tiers; css = animated CSS orb (no WebGL or too slow); static = reduced motion. */
export type OrbTier = 'full' | 'reduced' | 'css' | 'static';

/** Canvas size in CSS px. The stage scales it with a transform, so docking never resizes the WebGL buffer. */
export const ORB_BASE = 300;

function initialTier(reducedMotion: boolean): OrbTier {
  // QA override (?orb=full|reduced|css|static) to verify every fallback in a real browser.
  const forced = new URLSearchParams(window.location.search).get('orb');
  if (forced === 'full' || forced === 'reduced' || forced === 'css' || forced === 'static') return forced;
  if (reducedMotion) return 'static';
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  const lowEnd =
    (nav.hardwareConcurrency ?? 8) <= 4 ||
    (nav.deviceMemory ?? 8) <= 4 ||
    nav.connection?.saveData === true ||
    (window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 768);
  return lowEnd ? 'reduced' : 'full';
}

interface Props {
  state: OrbState;
  theme: OrbTheme;
  reducedMotion: boolean;
  docked: boolean;
  amplitudeRef: { readonly current: number };
}

/**
 * The Living Orb. Decorative (aria-hidden): every state it shows is also stated in text (top bar status, activity
 * list, live region). Three.js is loaded on demand in its own chunk; until it is ready — or if WebGL is missing,
 * lost or too slow — the CSS orb renders the same state, so the workspace is never blank.
 */
export function LivingOrb({ state, theme, reducedMotion, docked, amplitudeRef }: Props) {
  const [tier, setTier] = useState<OrbTier>(() => initialTier(reducedMotion));
  const [ready, setReady] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<OrbScene | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Latest props for the async scene setup without re-creating it.
  const latest = useRef({ state, theme, docked });
  latest.current = { state, theme, docked };

  useEffect(() => {
    setTier((t) => (reducedMotion ? 'static' : t === 'static' ? initialTier(false) : t));
  }, [reducedMotion]);

  useEffect(() => {
    if (tier !== 'full' && tier !== 'reduced') return;
    const el = canvas.current;
    if (!el) return;
    let disposed = false;
    let io: IntersectionObserver | null = null;
    let ro: ResizeObserver | null = null;
    const onVisibility = () => scene.current?.setVisible(!document.hidden);
    setReady(false);
    // After the brand intro (no compile hitch under its animation); the CSS orb holds the slot meanwhile.
    introFinished()
      .then(() => import('./OrbScene.ts'))
      .then(async ({ OrbScene }) => {
        if (disposed) return;
        const quality: OrbQuality = tier;
        const s = new OrbScene(el, {
          quality,
          theme: latest.current.theme,
          amplitude: amplitudeRef,
          onSlow: () => setTier((t) => (t === 'full' ? 'reduced' : 'css')),
          onContextLost: () => setTier('css'),
        });
        scene.current = s;
        await s.prepare();
        if (disposed) return;
        s.setState(latest.current.state);
        s.setDocked(latest.current.docked);
        io = new IntersectionObserver(([entry]) => s.setVisible(Boolean(entry?.isIntersecting) && !document.hidden));
        io.observe(el);
        ro = new ResizeObserver(() => s.resize());
        ro.observe(el);
        document.addEventListener('visibilitychange', onVisibility);
        s.start();
        setReady(true);
      })
      .catch(() => {
        // No WebGL (context creation throws) or the chunk failed to load: CSS orb.
        if (!disposed) setTier('css');
      });
    return () => {
      disposed = true;
      io?.disconnect();
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      scene.current?.destroy();
      scene.current = null;
    };
  }, [tier, amplitudeRef]);

  useEffect(() => scene.current?.setState(state), [state]);
  useEffect(() => scene.current?.setTheme(theme), [theme]);
  useEffect(() => scene.current?.setDocked(docked), [docked]);

  // CSS orb amplitude: written as a CSS variable from the real microphone level (no React re-render per frame).
  useEffect(() => {
    const el = box.current;
    if (!el || state !== 'listening' || tier === 'static' || ((tier === 'full' || tier === 'reduced') && ready)) {
      el?.style.setProperty('--amp', '0');
      return;
    }
    let raf = requestAnimationFrame(function loop() {
      el.style.setProperty('--amp', amplitudeRef.current.toFixed(3));
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  }, [state, tier, ready, amplitudeRef]);

  const webgl = tier === 'full' || tier === 'reduced';
  return (
    <div ref={box} className="orb" data-state={state} data-tier={tier} data-ready={webgl && ready} aria-hidden="true">
      {(!webgl || !ready) && (
        <div className="css-orb">
          <i className="co-atmo" />
          <i className="co-ring co-r1"><b /></i>
          <i className="co-ring co-r2"><b /></i>
          <i className="co-core" />
        </div>
      )}
      {webgl && <canvas key={tier} ref={canvas} className="orb-canvas" />}
    </div>
  );
}

interface StageProps extends Props {
  /** Element whose box the orb should occupy: the empty-state hero slot or the top-bar dock slot. */
  anchor: HTMLElement | null;
  container: HTMLElement | null;
}

/**
 * Positions the single orb over its current anchor with a compositor-only transform. Switching anchors
 * (hero ⇄ dock) animates the move; scroll and resize follow instantly.
 */
export function OrbStage({ anchor, container, ...orb }: StageProps) {
  const stage = useRef<HTMLDivElement>(null);
  const prevAnchor = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || !anchor || !container) return;
    const animate = prevAnchor.current !== null && prevAnchor.current !== anchor && !orb.reducedMotion;
    prevAnchor.current = anchor;
    let raf = 0;
    let current = '';
    const target = () => {
      const a = anchor.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      const scale = Math.max(a.width, 1) / ORB_BASE;
      const x = a.left - c.left + a.width / 2 - ORB_BASE / 2;
      const y = a.top - c.top + a.height / 2 - ORB_BASE / 2;
      el.style.visibility = a.width > 0 ? 'visible' : 'hidden';
      return `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${scale.toFixed(4)})`;
    };
    el.style.transition = animate ? 'transform 700ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
    current = target();
    el.style.transform = current;
    // Later moves (scroll, resize) follow instantly — but only when the target really changed, so the initial
    // ResizeObserver callback does not cut the hero⇄dock animation short.
    const place = () => {
      raf = 0;
      const next = target();
      if (next === current) return;
      current = next;
      el.style.transition = 'none';
      el.style.transform = next;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(place);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(anchor);
    ro.observe(container);
    // The anchor can move without changing size (text above it reflows when web fonts arrive, cards wrap):
    // also follow the scroll region's content box and font loading.
    const content = anchor.closest('[data-region]')?.firstElementChild;
    if (content) ro.observe(content);
    document.fonts?.addEventListener('loadingdone', schedule);
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('scroll', schedule, { capture: true });
      document.fonts?.removeEventListener('loadingdone', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [anchor, container, orb.reducedMotion]);

  return (
    <div ref={stage} className="orb-stage" style={{ width: ORB_BASE, height: ORB_BASE }}>
      <LivingOrb {...orb} />
    </div>
  );
}
