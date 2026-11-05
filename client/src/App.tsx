import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MotionConfig } from 'motion/react';
import type { ConversationListItem, MemoryState, Status } from '../../server/src/web/contracts.ts';
import { api, ApiError } from './api/client.ts';
import { useAgent } from './state/useAgent.ts';
import { useRecorder } from './state/useRecorder.ts';
import { useSettings } from './state/settings.ts';
import { Composer, type ComposerHandle } from './components/Composer.tsx';
import { ContextPanel } from './components/ContextPanel.tsx';
import { EmptyState } from './components/EmptyState.tsx';
import { LivingBackground, type BackgroundPreset, type BackgroundState } from './components/LivingBackground.tsx';
import { ConfirmDialog, ConsentDialog, Drawer } from './components/Overlays.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { TopBar, type Connection } from './components/TopBar.tsx';
import { Transcript } from './components/Transcript.tsx';
import { BrandIntro } from './components/BrandIntro.tsx';
import { activityLabel } from './lib/i18n.ts';
import { OrbStage, type OrbState } from './orb/LivingOrb.tsx';

/**
 * Workspace modes, decided by whether the panels' content fits — not by device classes:
 *  - wide:   history + conversation + context side by side (needs ≈ 16 + 34 + 19 rem plus gutters);
 *  - medium: history + conversation; context opens as a drawer (≈ 15 + 32 rem);
 *  - narrow: conversation first; history and context open as drawers.
 * The thresholds are in em, so they follow browser zoom and the user's default font size (200% zoom on a wide
 * monitor becomes medium or narrow). matchMedia fires only when a threshold is crossed, not on every resize.
 */
type Layout = 'wide' | 'medium' | 'narrow';
const WIDE = '(min-width: 72em)';
const MEDIUM = '(min-width: 50em)';
const layoutNow = (): Layout => (window.matchMedia(WIDE).matches ? 'wide' : window.matchMedia(MEDIUM).matches ? 'medium' : 'narrow');
function useLayout(): Layout {
  return useSyncExternalStore(
    (cb) => {
      const queries = [window.matchMedia(WIDE), window.matchMedia(MEDIUM)];
      queries.forEach((q) => q.addEventListener('change', cb));
      return () => queries.forEach((q) => q.removeEventListener('change', cb));
    },
    layoutNow,
    () => 'wide',
  );
}

export function App() {
  const s = useSettings();
  const layout = useLayout();
  const agent = useAgent(s.lang === 'ar' ? 'ar-EG' : 'en');
  const [status, setStatus] = useState<Status | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const recorder = useRecorder(status?.limits.maxAudioBytes ?? 25 * 1024 * 1024);
  const composer = useRef<ComposerHandle>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [toDelete, setToDelete] = useState<ConversationListItem | null>(null);
  const [consent, setConsent] = useState<{ text: string } | null>(null);
  // Bumped after server-confirmed consent decisions so the memory panel re-reads the server state.
  const [memoryRev, setMemoryRev] = useState(0);
  // Living Orb anchors: the empty-state hero slot or the top-bar dock slot (one orb, one WebGL canvas).
  const [heroAnchor, setHeroAnchor] = useState<HTMLDivElement | null>(null);
  const [dockAnchor, setDockAnchor] = useState<HTMLDivElement | null>(null);
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
  // "Responding": a short pulse when the server delivers a completed answer (the real final event, not a timer
  // guessing at generation). A canceled turn simply settles back to idle.
  const [responding, setResponding] = useState(false);
  useEffect(() => {
    if (!agent.lastOutcome || agent.lastOutcome.status !== 'completed') return;
    setResponding(true);
    const t = window.setTimeout(() => setResponding(false), 1400);
    return () => window.clearTimeout(t);
  }, [agent.lastOutcome]);

  // Server status = the only source for which features are offered (no fake capability indicators).
  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
      setConnection('connected');
    } catch {
      setConnection('offline');
    }
  }, []);
  useEffect(() => {
    void loadStatus();
    const onOnline = () => void loadStatus();
    const onOffline = () => setConnection('offline');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const poll = window.setInterval(() => {
      if (!document.hidden) void loadStatus();
    }, 30_000);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [loadStatus]);
  useEffect(() => {
    if (agent.failed?.code === 'OFFLINE') setConnection('offline');
    else if (agent.lastOutcome) setConnection('connected');
  }, [agent.failed, agent.lastOutcome]);

  // The model asked for memory consent: show the server-fixed wording (the model can never grant it).
  const openConsent = useCallback(async (known?: MemoryState) => {
    try {
      const state = known ?? (await api.memory(agent.conversationId));
      if (state.consent === 'active') return;
      setConsent({ text: state.consentText[s.lang] });
    } catch {
      // ignore: the memory panel shows errors
    }
  }, [agent.conversationId, s.lang]);
  useEffect(() => {
    if (agent.consentRequested) {
      agent.clearConsentRequest();
      void openConsent();
    }
  }, [agent, openConsent]);

  const send = useCallback((text: string, input?: Parameters<typeof agent.send>[1]) => {
    void agent.send(text, input);
  }, [agent]);

  const voiceEnabled = status?.features.voiceNotes === true;
  const recording = recorder.phase === 'recording';
  const bgState: BackgroundState = recording ? 'listening' : connection === 'offline' ? 'error' : agent.visualState;
  const empty = !agent.view || agent.view.items.length === 0;
  const showEmpty = empty && !agent.live && !agent.failed && !agent.loadingView;
  const orbState: OrbState = bgState === 'idle' && responding ? 'responding' : bgState;
  const runningTool = agent.live?.tools.find((t) => t.status === 'running');
  const activity = recording ? s.t('statusListening') : agent.live ? (runningTool ? activityLabel(s.lang, runningTool.toolName) : s.t('statusThinking')) : null;
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
  const preset: BackgroundPreset = layout === 'narrow' || saveData ? 'calm' : empty && !agent.live ? 'explore' : 'focus';

  const openConversation = (id: string) => {
    setMenuOpen(false);
    void agent.openConversation(id).catch(() => undefined);
  };
  const newConversation = () => {
    setMenuOpen(false);
    recorder.reset();
    agent.newConversation();
    requestAnimationFrame(() => composer.current?.focus());
  };

  const sidebar = (
    <Sidebar s={s} conversations={agent.conversations} activeId={agent.conversationId} onNew={newConversation} onOpen={openConversation} onDelete={setToDelete} showBrand={layout !== 'narrow'} />
  );
  const context = <ContextPanel agent={agent} s={s} refreshKey={memoryRev} onEnableMemory={(m) => void openConsent(m)} />;

  return (
    <MotionConfig reducedMotion={s.reducedMotion ? 'always' : 'user'}>
      <LivingBackground preset={preset} state={bgState} motion={!s.reducedMotion} amplitudeRef={recorder.amplitudeRef} />
      <BrandIntro s={s} />
      <a href="#composer" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:z-50 btn btn-primary">{s.t('skipToChat')}</a>
      <div className="shell" data-layout={layout}>
        {layout !== 'narrow' && <div className="panel min-h-0 min-w-0 overflow-hidden">{sidebar}</div>}

        <main ref={setMainEl} className={`workspace-grid ${layout === 'narrow' ? '' : 'workspace'}`}>
          <OrbStage
            anchor={showEmpty ? heroAnchor : dockAnchor}
            container={mainEl}
            state={orbState}
            theme={s.theme}
            reducedMotion={s.reducedMotion}
            docked={!showEmpty}
            amplitudeRef={recorder.amplitudeRef}
          />
          <TopBar
            s={s}
            connection={connection}
            model={status?.model ?? null}
            compact={layout !== 'wide'}
            brandInBar={layout === 'narrow'}
            onMenu={layout === 'narrow' ? () => setMenuOpen(true) : null}
            onContext={layout === 'wide' ? null : () => setContextOpen(true)}
            orbAnchor={setDockAnchor}
            orbDocked={!showEmpty}
            activity={activity}
          />
          {connection === 'offline' && (
            <div className="mx-auto mt-3 w-[calc(100%-24px)] max-w-[880px] rounded-input bg-danger-bg text-danger px-3 py-2 text-small flex items-center gap-3" role="alert">
              <span className="flex-1">{s.t('errOffline')}</span>
              <button type="button" className="underline underline-offset-4" onClick={() => void loadStatus()}>{s.t('retry')}</button>
            </div>
          )}
          {showEmpty ? (
            <EmptyState s={s} voiceEnabled={voiceEnabled} onPick={(text) => composer.current?.fill(text)} onVoice={() => void recorder.start()} orbAnchor={setHeroAnchor} />
          ) : (
            <Transcript
              view={agent.view}
              agent={agent}
              s={s}
              onAsk={(text) => send(text)}
              onApprovalDecided={(approved) => send(approved ? s.t('approvedFollowUp') : s.t('declinedFollowUp'))}
            />
          )}
          <Composer
            ref={composer}
            s={s}
            busy={agent.live !== null}
            voiceEnabled={voiceEnabled}
            maxChars={status?.limits.maxMessageChars ?? 4000}
            recorder={recorder}
            onSend={(text, input) => send(text, input)}
            onStop={agent.stop}
          />
        </main>

        {layout === 'wide' && <div className="panel min-h-0 min-w-0 overflow-hidden">{context}</div>}
      </div>

      {layout === 'narrow' && <Drawer open={menuOpen} onOpenChange={setMenuOpen} side="start" title={s.t('brand')} s={s}>{sidebar}</Drawer>}
      {layout !== 'wide' && (
        <Drawer open={contextOpen} onOpenChange={setContextOpen} side={layout === 'narrow' ? 'bottom' : 'end'} title={s.t('context')} s={s}>{context}</Drawer>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => { if (!o) setToDelete(null); }}
        title={s.t('deleteChatTitle')}
        body={s.t('deleteChatBody')}
        confirmLabel={s.t('delete')}
        s={s}
        onConfirm={async () => {
          if (toDelete) await agent.deleteConversation(toDelete.id);
        }}
      />
      <ConsentDialog
        open={consent !== null}
        text={consent?.text ?? ''}
        s={s}
        onDecision={async (grant) => {
          await api.memoryConsent(grant ? 'grant' : 'decline', agent.conversationId);
          setConsent(null);
          setMemoryRev((r) => r + 1);
          if (grant && agent.conversationId) send(s.t('memoryGrantedFollowUp'));
        }}
      />
    </MotionConfig>
  );
}

export { ApiError };
