import { motion } from 'motion/react';
import { Globe, LayoutList, Mic, Scale } from 'lucide-react';
import type { SettingsApi } from '../state/settings.ts';
import { Wordmark } from './Logo.tsx';

interface Props {
  s: SettingsApi;
  voiceEnabled: boolean;
  onPick: (text: string) => void;
  onVoice: () => void;
  /** Slot the Living Orb occupies while the conversation is empty. */
  orbAnchor: (el: HTMLDivElement | null) => void;
}

const ease = [0.22, 1, 0.36, 1] as const;

/** New conversation: the orb, the brand, and real starter prompts (they fill the composer; nothing is auto-sent). */
export function EmptyState({ s, voiceEnabled, onPick, onVoice, orbAnchor }: Props) {
  const starters = [
    { icon: LayoutList, text: s.t('starterPrograms') },
    { icon: Scale, text: s.t('starterBudget') },
    { icon: Globe, text: s.t('starterTurkey') },
  ];
  const rise = (i: number) => ({
    initial: s.reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: s.reducedMotion ? 0 : 0.32, delay: s.reducedMotion ? 0 : 0.08 + i * 0.06, ease },
  });
  return (
    // One scrolling region, sized by the space the layout gives it (see .welcome in styles.css): the orb, type and
    // spacing scale with that height; content is centred with auto margins and scrolls only if it cannot fit.
    <div className="welcome scroll-area" data-region="welcome">
      <div className="welcome-inner">
        <div className="welcome-content">
        <div className="welcome-orb-slot"><div ref={orbAnchor} className="welcome-orb" /></div>
        <motion.div {...rise(0)} className="welcome-brand">
          <Wordmark lang={s.lang} size="lg" />
          <p className="text-meta text-muted label-caps">{s.t('tagline')}</p>
        </motion.div>
        <motion.div {...rise(1)} className="welcome-intro">
          <h2 className="welcome-title">{s.t('greeting')}</h2>
          <p className="welcome-sub">{s.t('greetingSub')}</p>
        </motion.div>
        <ul className="welcome-starters">
          {starters.map(({ icon: Icon, text }, i) => (
            <motion.li key={text} {...rise(2 + i)}>
              <button type="button" onClick={() => onPick(text)} className="starter">
                <span className="starter-icon"><Icon size={17} aria-hidden="true" /></span>
                <span dir="auto">{text}</span>
              </button>
            </motion.li>
          ))}
          {voiceEnabled && (
            <motion.li {...rise(5)}>
              <button type="button" onClick={onVoice} className="starter">
                <span className="starter-icon"><Mic size={17} aria-hidden="true" /></span>
                <span>{s.t('starterVoice')}</span>
              </button>
            </motion.li>
          )}
        </ul>
        </div>
      </div>
    </div>
  );
}
