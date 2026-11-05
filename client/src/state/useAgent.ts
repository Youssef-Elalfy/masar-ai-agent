import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client.ts';
import type { ConversationListItem, ConversationView, TurnEvent, TurnOutcome, TurnRequest } from '../../../server/src/web/contracts.ts';

export interface LiveTool {
  key: string;
  toolName: string;
  status: 'running' | 'ok' | 'error';
  errorCode: string | null;
  latencyMs: number | null;
}

/** The turn in flight. Every field is set from a server event, never from a timer. */
export interface LiveTurn {
  text: string;
  input: TurnRequest['input'];
  traceId: string | null;
  tools: LiveTool[];
  groundingChecks: number;
}

export interface FailedSend {
  text: string;
  input: TurnRequest['input'];
  code: string;
  message: string;
}

export type AgentVisualState = 'idle' | 'thinking' | 'searching' | 'error';

export function useAgent(locale: 'ar-EG' | 'en') {
  const [conversations, setConversations] = useState<ConversationListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [view, setView] = useState<ConversationView | null>(null);
  const [loadingView, setLoadingView] = useState(false);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [failed, setFailed] = useState<FailedSend | null>(null);
  const [lastOutcome, setLastOutcome] = useState<TurnOutcome | null>(null);
  const [lastTools, setLastTools] = useState<LiveTool[]>([]);
  const [consentRequested, setConsentRequested] = useState(false);
  const [revision, setRevision] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // The conversation currently on screen; late results for another conversation are ignored.
  const currentId = useRef<string | null>(null);
  const sending = useRef(false);
  useEffect(() => {
    currentId.current = conversationId;
  }, [conversationId]);

  const refreshList = useCallback(async () => {
    try {
      setConversations(await api.conversations());
      setListError(null);
    } catch (err) {
      setListError(err instanceof ApiError ? err.code : 'ERROR');
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const newConversation = useCallback(() => {
    abortRef.current?.abort();
    currentId.current = null;
    setConversationId(null);
    setView(null);
    setLive(null);
    setFailed(null);
    setLastOutcome(null);
    setLastTools([]);
  }, []);

  const openConversation = useCallback(async (id: string) => {
    abortRef.current?.abort();
    currentId.current = id;
    setConversationId(id);
    setLive(null);
    setFailed(null);
    setLastOutcome(null);
    setLastTools([]);
    setLoadingView(true);
    try {
      setView(await api.conversation(id));
    } catch (err) {
      setView(null);
      setConversationId(null);
      if (err instanceof ApiError && err.status === 404) void refreshList();
      throw err;
    } finally {
      setLoadingView(false);
    }
  }, [refreshList]);

  const deleteConversation = useCallback(async (id: string) => {
    await api.deleteConversation(id);
    if (id === conversationId) newConversation();
    await refreshList();
  }, [conversationId, newConversation, refreshList]);

  const send = useCallback(async (text: string, input: TurnRequest['input'] = { kind: 'text' }) => {
    const trimmed = text.trim();
    if (!trimmed || live || sending.current) return;
    sending.current = true;
    setFailed(null);
    setConsentRequested(false);
    const turn: LiveTurn = { text: trimmed, input, traceId: null, tools: [], groundingChecks: 0 };
    setLive(turn);
    const controller = new AbortController();
    abortRef.current = controller;
    let id = conversationId;
    let finished = false;
    try {
      if (!id) {
        id = await api.createConversation(locale);
        currentId.current = id;
        setConversationId(id);
        setView({ id, items: [], pendingApprovals: [] });
      }
      // The turn is tracked locally and mirrored into state, so updates never depend on stale closures.
      let current: LiveTurn = turn;
      const publish = (next: LiveTurn) => {
        current = next;
        setLive(next);
      };
      const onEvent = (e: TurnEvent) => {
        switch (e.type) {
          case 'ack':
            publish({ ...current, traceId: e.traceId });
            break;
          case 'tool_started':
            publish({ ...current, tools: [...current.tools, { key: `${e.step}:${e.toolName}:${current.tools.length}`, toolName: e.toolName, status: 'running', errorCode: null, latencyMs: null }] });
            break;
          case 'tool_finished': {
            const idx = current.tools.findIndex((t) => t.toolName === e.toolName && t.status === 'running');
            const prev = current.tools[idx];
            if (!prev) break;
            const tools = current.tools.slice();
            tools[idx] = { ...prev, status: e.outcome, errorCode: e.errorCode, latencyMs: e.latencyMs };
            publish({ ...current, tools });
            break;
          }
          case 'grounding_check':
            publish({ ...current, groundingChecks: current.groundingChecks + 1 });
            break;
          case 'final':
            finished = true;
            if (currentId.current !== e.conversation.id) {
              setLive(null);
              break;
            }
            setView(e.conversation);
            setLastOutcome(e.outcome);
            setConsentRequested(e.outcome.consentRequested);
            setLastTools(current.tools);
            setLive(null);
            setRevision((r) => r + 1);
            break;
          case 'error':
            finished = true;
            setFailed({ text: trimmed, input, code: e.code, message: e.message });
            setLive(null);
            break;
          case 'model_call':
            break;
        }
      };
      await api.turn(id, { text: trimmed, input }, onEvent, controller.signal);
      if (!finished) {
        // Stream ended without a result: the server may still have stored the turn, so reload instead of claiming "not sent".
        setFailed({ text: trimmed, input, code: 'STREAM_CLOSED', message: '' });
        setLive(null);
        if (currentId.current === id) {
          try {
            setView(await api.conversation(id));
          } catch {
            // keep the current view
          }
        }
      }
    } catch (err) {
      setLive(null);
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Stopped by the customer: reload the stored transcript (the server records the canceled turn).
        if (id && currentId.current === id) {
          try {
            const v = await api.conversation(id);
            if (currentId.current === id) setView(v);
          } catch {
            // keep the current view
          }
        }
      } else {
        setFailed({ text: trimmed, input, code: err instanceof ApiError ? err.code : 'ERROR', message: err instanceof Error ? err.message : 'Error' });
      }
    } finally {
      sending.current = false;
      if (abortRef.current === controller) abortRef.current = null;
      void refreshList();
    }
  }, [conversationId, live, locale, refreshList]);

  // Stop asks the server to cancel (the stream then delivers the stored "canceled" result); closing the stream is the fallback.
  const liveTraceId = live?.traceId ?? null;
  const stop = useCallback(() => {
    if (!liveTraceId) {
      abortRef.current?.abort();
      return;
    }
    api.cancelTurn(liveTraceId).catch(() => abortRef.current?.abort());
  }, [liveTraceId]);

  const reloadView = useCallback(async () => {
    if (!conversationId) return;
    try {
      setView(await api.conversation(conversationId));
    } catch {
      // ignore: the next turn reloads it
    }
  }, [conversationId]);

  const visualState: AgentVisualState = live
    ? live.tools.some((t) => t.status === 'running') ? 'searching' : 'thinking'
    : failed && failed.code === 'OFFLINE' ? 'error' : 'idle';

  return {
    conversations, listError, conversationId, view, loadingView, live, failed, lastOutcome, lastTools, consentRequested, revision, visualState,
    refreshList, newConversation, openConversation, deleteConversation, send, stop, reloadView,
    dismissFailed: () => setFailed(null),
    clearConsentRequest: () => setConsentRequested(false),
  };
}

export type AgentApi = ReturnType<typeof useAgent>;
