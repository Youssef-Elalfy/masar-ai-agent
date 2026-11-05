import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDown, Check, Copy, Mic, RotateCcw, TriangleAlert } from 'lucide-react';
import type { ConversationView, TranscriptItem } from '../../../server/src/web/contracts.ts';
import type { AgentApi } from '../state/useAgent.ts';
import type { SettingsApi } from '../state/settings.ts';
import { ActivitySummary, LiveActivity } from './Activity.tsx';
import { ApprovalCard } from './ApprovalCard.tsx';
import { Cards } from './cards/Cards.tsx';
import { AssistantMark } from './Logo.tsx';
import { Markdown } from './Markdown.tsx';

const enter = (reduced: boolean) => ({
  initial: reduced ? { opacity: 0 } : { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: reduced ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] as const },
});

function UserBubble({ text, pending, voice, s }: { text: string; pending?: boolean; voice?: boolean; s: SettingsApi }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[78%] rounded-card rounded-se-[6px] bubble-user px-5 py-3 whitespace-pre-wrap break-words" dir="auto">
        {voice && <Mic size={14} className="inline me-1.5 align-[-2px] text-muted" aria-label={s.t('voiceNote')} />}
        {text}
        {pending && <span className="sr-only">{s.t('sending')}</span>}
      </div>
    </div>
  );
}

function CopyButton({ text, s }: { text: string; s: SettingsApi }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn !w-8 !h-8"
      aria-label={copied ? s.t('copied') : s.t('copy')}
      title={copied ? s.t('copied') : s.t('copy')}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
    </button>
  );
}

function AssistantMessage({ item, s, onAsk, onRetry }: { item: Extract<TranscriptItem, { role: 'assistant' }>; s: SettingsApi; onAsk: (t: string) => void; onRetry: (() => void) | null }) {
  return (
    <div className="group flex gap-3.5">
      <AssistantMark active={false} size={24} />
      <div className="min-w-0 flex-1">
        <ActivitySummary activity={item.activity} s={s} />
        {item.text && <div className="msg-ai"><Markdown text={item.text} /></div>}
        <Cards cards={item.cards} t={s.t} lang={s.lang} reducedMotion={s.reducedMotion} onAsk={onAsk} />
        {item.text && (
          <div className="mt-2 flex gap-1 opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 transition-opacity">
            <CopyButton text={item.text} s={s} />
            {onRetry && (
              <button type="button" className="icon-btn !w-8 !h-8" aria-label={s.t('retry')} title={s.t('retry')} onClick={onRetry}>
                <RotateCcw size={15} aria-hidden="true" className="flip" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface Props {
  view: ConversationView | null;
  agent: AgentApi;
  s: SettingsApi;
  onAsk: (text: string) => void;
  onApprovalDecided: (approved: boolean) => void;
}

export function Transcript({ view, agent, s, onAsk, onApprovalDecided }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const items = view?.items ?? [];
  const lastUser = [...items].reverse().find((i) => i.role === 'user');
  const lastItem = items.at(-1);
  const lastAnswer = agent.lastOutcome && lastItem?.role === 'assistant' ? lastItem.text : '';
  const contentKey = `${view?.id}:${items.length}:${agent.live?.tools.length ?? -1}:${agent.live ? 1 : 0}:${view?.pendingApprovals.length}`;

  const scrollToEnd = (smooth: boolean) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth && !s.reducedMotion ? 'smooth' : 'auto' });
  };

  // New conversation opened: start at the end.
  useLayoutEffect(() => {
    scrollToEnd(false);
    setAtBottom(true);
    setUnseen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.id]);

  // The customer's own new message is always brought into view.
  const liveStarted = agent.live !== null;
  useEffect(() => {
    if (liveStarted) {
      scrollToEnd(true);
      setAtBottom(true);
      setUnseen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveStarted]);

  // New content: follow only if the reader is already at the bottom; otherwise show the "new messages" pill.
  useEffect(() => {
    if (atBottom) scrollToEnd(true);
    else setUnseen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey]);

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scroller}
        className="scroll-area h-full"
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          setAtBottom(bottom);
          if (bottom) setUnseen(false);
        }}
      >
        <div id="conversation" role="log" aria-live="off" aria-label={s.t('workspace')} className="mx-auto max-w-[840px] px-4 sm:px-8 pt-8 pb-10 flex flex-col gap-7">
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <motion.div key={`${view?.id}-${item.id}`} {...enter(s.reducedMotion)}>
                {item.role === 'user' ? (
                  <UserBubble text={item.text} s={s} />
                ) : (
                  <AssistantMessage
                    item={item}
                    s={s}
                    onAsk={onAsk}
                    onRetry={item === items.at(-1) && lastUser && !agent.live ? () => void agent.send(lastUser.text) : null}
                  />
                )}
              </motion.div>
            ))}
          </AnimatePresence>

          {view && view.pendingApprovals.length > 0 && !agent.live && (
            <div className="ps-[48px]">
              {view.pendingApprovals.map((a) => <ApprovalCard key={a.approvalId} approval={a} s={s} onDecided={onApprovalDecided} />)}
            </div>
          )}

          {agent.live && (
            <>
              <motion.div {...enter(s.reducedMotion)}>
                <UserBubble text={agent.live.text} pending voice={agent.live.input?.kind === 'voice_transcript'} s={s} />
              </motion.div>
              <motion.div {...enter(s.reducedMotion)} className="flex gap-3.5" aria-busy="true">
                <AssistantMark active size={24} />
                <div className="min-w-0 flex-1 pt-1.5 flex flex-col gap-2">
                  <p className="text-small text-accent flex items-center gap-2"><span className="status-dot live" aria-hidden="true" />{s.t('thinking')}</p>
                  <LiveActivity tools={agent.live.tools} groundingChecks={agent.live.groundingChecks} s={s} />
                </div>
              </motion.div>
            </>
          )}

          {agent.failed && (
            <div className="flex flex-col items-end gap-2">
              <div className="max-w-[80%] rounded-card rounded-se-[4px] border border-danger px-4 py-2.5 whitespace-pre-wrap break-words" dir="auto">{agent.failed.text}</div>
              <p className="flex items-center gap-2 text-small text-danger" role="alert">
                <TriangleAlert size={15} aria-hidden="true" />
                {agent.failed.code === 'OFFLINE' ? `${s.t('notSent')} · ${s.t('errOffline')}`
                  : agent.failed.code === 'RATE_LIMITED' ? `${s.t('notSent')} · ${s.t('errRateLimited')}`
                  : agent.failed.code === 'STREAM_CLOSED' || agent.failed.code === 'TURN_FAILED' ? s.t('connectionLost')
                  : `${s.t('notSent')} · ${s.t('errGeneric')}`}
                <button type="button" className="btn btn-secondary !min-h-8 text-small" onClick={() => agent.failed && void agent.send(agent.failed.text, agent.failed.input)}>
                  {s.t('retry')}
                </button>
              </p>
            </div>
          )}
        </div>
      </div>
      {/* Screen readers: status while working, then the answer once. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {agent.live ? s.t('thinking') : lastAnswer ? `${s.t('assistant')}: ${lastAnswer.slice(0, 400)}` : ''}
      </div>
      {unseen && !atBottom && (
        <button type="button" onClick={() => scrollToEnd(true)} className="absolute bottom-3 inset-x-0 mx-auto w-fit btn glass border border-line text-small shadow-[var(--shadow)]">
          <ArrowDown size={15} aria-hidden="true" />{s.t('newMessages')}
        </button>
      )}
    </div>
  );
}
