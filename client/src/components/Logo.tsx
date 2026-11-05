import { useId } from 'react';

/**
 * MASAR symbol (original vector, 48×48): a route leaves its origin in the lower corner, swings around the central
 * intelligent node as an open orbit, and arrives at a destination station. The tilted orbit (−28°) is the same geometry the
 * Living Orb's rings use, so the mark and the orb read as one system. Works monochrome (gradient={false}).
 */
export const ORBIT_TILT_DEG = -28;
const ROUTE = 'M5.5 43.5C6.4 38.2 7.1 33.2 7.62 29.22A18 9 -28 1 1 35.6 26.66';

export function LogoMark({ size = 28, gradient = true, className }: { size?: number; gradient?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  const paint = gradient ? `url(#mg-${id})` : 'currentColor';
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} fill="none" aria-hidden="true" className={className}>
      {gradient && (
        <defs>
          <linearGradient id={`mg-${id}`} x1="4" y1="44" x2="44" y2="6" gradientUnits="userSpaceOnUse">
            <stop stopColor="#14D7C4" />
            <stop offset=".55" stopColor="#38BDF8" />
            <stop offset="1" stopColor="#6366F1" />
          </linearGradient>
          <radialGradient id={`mc-${id}`} cx="22" cy="22" r="7" gradientUnits="userSpaceOnUse">
            <stop stopColor="#E9FFFC" />
            <stop offset=".45" stopColor="#14D7C4" />
            <stop offset="1" stopColor="#38BDF8" />
          </radialGradient>
        </defs>
      )}
      {/* The full orbit, faint: the route is the travelled part of it. */}
      <ellipse cx="24" cy="24" rx="18" ry="9" transform="rotate(-28 24 24)" stroke={paint} strokeWidth="1.3" opacity="0.38" />
      <path d={ROUTE} stroke={paint} strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="24" cy="24" r="5.6" fill={gradient ? `url(#mc-${id})` : 'currentColor'} />
      <circle cx="35.6" cy="26.66" r="3.1" fill={paint} />
      <circle cx="5.5" cy="43.5" r="2.1" fill={paint} />
    </svg>
  );
}

/**
 * Wordmark. Arabic: the exact vocalized form مَسَارٌ set in Aref Ruqaa Ink (OFL) — chosen over Amiri after rendering
 * both: Ruqaa keeps the fatḥas and the final tanween tight to the letters and stays legible at 26 px.
 * English: MASAR in Space Grotesk with a gradient "AI".
 */
export function Wordmark({ lang, size = 'md' }: { lang: 'ar' | 'en'; size?: 'md' | 'lg' | 'xl' }) {
  return lang === 'ar' ? (
    <span className={`wordmark-ar wm-${size}`} lang="ar">
      <span className="wm-text">مَسَارٌ</span>
      <span className="wm-ai" dir="ltr" lang="en">AI</span>
    </span>
  ) : (
    <span className={`wordmark-en wm-${size}`} lang="en">
      MASAR <span className="wm-ai">AI</span>
    </span>
  );
}

/** Assistant avatar in the transcript; the halo runs only while the server reports real work on this turn. */
export function AssistantMark({ active, size = 28 }: { active: boolean; size?: number }) {
  return (
    <span className="ai-mark" data-active={active} style={{ width: size + 10, height: size + 10 }}>
      <LogoMark size={size} />
    </span>
  );
}
