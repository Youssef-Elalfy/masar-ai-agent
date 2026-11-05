import type { ConsentStore } from '../memory/consent-store.ts';
import type { ContextManager, ConversationSummary } from '../memory/context-manager.ts';
import type { ConversationStore } from '../memory/conversation-store.ts';
import type { TraceRecorder } from '../observability/trace.ts';
import { newTraceId } from '../observability/trace.ts';
import type { ApprovalStore, PendingApproval } from '../security/approvals.ts';
import { ToolError, type ConsentRequest, type RegisteredTool, type ToolContext, type ToolRegistry } from '../tools/registry.ts';
import { GROUNDING_NOTE, groundingIssues } from './grounding.ts';
import { mentionsDemoNotice, replyLanguage, styleIssues, styleNote } from './style.ts';
import { syntheticResults, unansweredToolCalls } from './history.ts';
import { ProviderError, type ChatMessage, type ContentBlock, type LLMProvider } from './providers/types.ts';

export interface AgentLimits {
  maxSteps: number;
  timeoutMs: number;
  toolTimeoutMs: number;
  /** Max characters of one tool result sent back to the model. */
  maxToolResultChars?: number;
}

/** Per-turn facts appended to the system prompt (dynamic part, after the stable instructions). */
export interface PromptExtras {
  summary: ConversationSummary | null;
  memory: { consentActive: boolean; itemCount: number; retrieval: string; declinedThisConversation: boolean } | null;
  /** How the latest customer message was produced (fixed facts only, never transcript text). */
  input?: TurnInputMode;
  /** Language/register of the latest customer message, detected by fixed rules (null = unclear, no hint). */
  replyLanguage?: 'english' | 'msa' | 'egyptian' | null;
  /** An earlier assistant reply in this conversation already said the company and its prices are demos. */
  demoNoticeGiven?: boolean;
}

/**
 * Typed text, or an automatic voice-note transcript the customer sent without editing.
 * A transcript the customer corrected by hand counts as typed text.
 */
export type TurnInputMode = { kind: 'text' } | { kind: 'voice_transcript'; lowConfidence: boolean };

export interface TurnArgs {
  conversationId: string;
  ownerId: string;
  userText: string;
  input?: TurnInputMode;
  /** Caller-chosen trace id (lets a client stream follow exactly this run's events). */
  traceId?: string;
  /** Customer pressed stop / closed the stream. The turn ends with status "canceled" and a consistent transcript. */
  signal?: AbortSignal;
}

export interface AgentDeps {
  provider: LLMProvider;
  registry: ToolRegistry;
  conversations: ConversationStore;
  approvals: ApprovalStore;
  consents: ConsentStore;
  tracer: TraceRecorder;
  limits: AgentLimits;
  systemPrompt: (now: Date, extras: PromptExtras) => string;
  /** Summarizes long conversations; without it the full transcript is sent. */
  context?: ContextManager;
  memoryStatus?: (ownerId: string, conversationId: string) => Promise<PromptExtras['memory']>;
  clock?: () => Date;
}

export type TurnStatus = 'completed' | 'canceled' | 'max_steps' | 'timeout' | 'provider_error' | 'refusal' | 'max_tokens' | 'incomplete' | 'empty_response';

export interface ToolCallSummary {
  step: number;
  name: string;
  outcome: 'ok' | 'error';
  errorCode: string | null;
  sourceType: string | null;
  latencyMs: number;
}

export interface TurnResult {
  traceId: string;
  conversationId: string;
  status: TurnStatus;
  text: string;
  steps: number;
  toolCalls: ToolCallSummary[];
  /** Write actions waiting for the user's explicit decision (shown by the client, not the model). */
  pendingApprovals: PendingApproval[];
  /** Consent prompts the client must show the user (the model can request but never grant consent). */
  consentRequests: ConsentRequest[];
  /** True when older turns were replaced by a stored summary in the model context. */
  usedSummary: boolean;
  /** Answers held back by the grounding guard and re-asked (0 or 1). */
  groundingCorrections: number;
  /** Answers held back by the style guard and rewritten (0 or 1). */
  styleCorrections: number;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  errorCode: string | null;
}

type Fallback = Exclude<TurnStatus, 'completed'>;

/** User-facing fallbacks: honest, friendly, never a stack trace or raw provider error. */
const FALLBACK_TEXT: Record<'ar' | 'en', Record<Fallback, string>> = {
  ar: {
    canceled: 'وقفت الرد زي ما طلبت. تقدر تكمّل أو تبعت سؤال جديد.',
    max_steps: 'معلش، الطلب ده محتاج خطوات أكتر من المسموح في المرة الواحدة. ممكن نقسّمه أو توضّحلي تحب أبدأ بإيه؟',
    timeout: 'معلش، الرد أخد وقت أطول من اللازم فوقفته. ممكن تبعت سؤالك تاني؟',
    provider_error: 'معلش، حصلت مشكلة مؤقتة في الاتصال بخدمة الذكاء الاصطناعي. جرّب تاني بعد شوية.',
    refusal: 'معلش، مش هقدر أساعد في الطلب ده بالشكل ده. لو تحب نجرب صياغة تانية أو موضوع تاني، أنا معاك.',
    max_tokens: 'الرد طلع أطول من الحد المسموح. تحب أختصره أو أكمّل جزء معيّن؟',
    incomplete: 'معلش، الرد ماكملش. ممكن تعيد السؤال؟',
    empty_response: 'معلش، مقدرتش أكوّن رد المرة دي. ممكن تعيد صياغة سؤالك؟',
  },
  en: {
    canceled: 'Stopped as you asked. You can continue or send a new question.',
    max_steps: 'Sorry, this request needs more steps than I can take at once. Could we split it, or tell me where to start?',
    timeout: 'Sorry, that took too long so I stopped. Could you send your question again?',
    provider_error: 'Sorry, there was a temporary problem reaching the AI service. Please try again shortly.',
    refusal: "Sorry, I can't help with that request as phrased. Happy to try a different wording or topic.",
    max_tokens: 'The answer ran longer than allowed. Shall I shorten it or continue a specific part?',
    incomplete: "Sorry, my answer didn't complete. Could you ask again?",
    empty_response: "Sorry, I couldn't put together an answer this time. Could you rephrase?",
  },
};

const fallbackFor = (status: Fallback, userText: string) => FALLBACK_TEXT[/[؀-ۿ]/.test(userText) ? 'ar' : 'en'][status];

function textOf(content: ContentBlock[]): string {
  return content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number, parent: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parent.addEventListener('abort', onParentAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ToolError('TOOL_TIMEOUT', `Tool did not finish within ${ms} ms.`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parent.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Bounded, model-directed tool loop:
 * model → validated tool calls (Zod) → approval gate → execution with timeout → results back to the model,
 * repeated until a final answer, the step limit or the deadline. Every action is traced.
 */
export class AgentRuntime {
  private readonly deps: AgentDeps;
  /** Serializes turns per conversation so concurrent submits cannot interleave tool pairs. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  async runTurn(args: TurnArgs): Promise<TurnResult> {
    const previous = this.locks.get(args.conversationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.runTurnUnlocked(args));
    this.locks.set(args.conversationId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(args.conversationId) === current) this.locks.delete(args.conversationId);
    }
  }

  private async runTurnUnlocked(args: TurnArgs): Promise<TurnResult> {
    const { provider, registry, conversations, tracer, limits } = this.deps;
    const clock = this.deps.clock ?? (() => new Date());
    const started = Date.now();
    const traceId = args.traceId ?? newTraceId();
    const deadline = args.signal ? AbortSignal.any([AbortSignal.timeout(limits.timeoutMs), args.signal]) : AbortSignal.timeout(limits.timeoutMs);
    const canceled = () => args.signal?.aborted === true;
    const toolCalls: ToolCallSummary[] = [];
    const pendingApprovals: PendingApproval[] = [];
    const consentRequests: ConsentRequest[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    // Throws ConversationAccessError for a foreign or unknown conversation (before any write).
    const prepared = this.deps.context
      ? await this.deps.context.prepare(args.conversationId, args.ownerId, deadline)
      : { messages: await conversations.load(args.conversationId, args.ownerId), summary: null, usage: { inputTokens: 0, outputTokens: 0 } };
    const history = prepared.messages;
    usage.inputTokens += prepared.usage.inputTokens;
    usage.outputTokens += prepared.usage.outputTokens;
    const extras: PromptExtras = {
      summary: prepared.summary,
      memory: this.deps.memoryStatus ? await this.deps.memoryStatus(args.ownerId, args.conversationId) : null,
      input: args.input ?? { kind: 'text' },
      replyLanguage: replyLanguage(args.userText),
      demoNoticeGiven: history.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text' && mentionsDemoNotice(b.text))),
    };

    const append = async (message: ChatMessage) => {
      history.push(message);
      await conversations.append(args.conversationId, args.ownerId, message, traceId);
    };

    await tracer.startRun({ traceId, conversationId: args.conversationId, ownerId: args.ownerId, provider: provider.id, model: provider.model });
    await append({ role: 'user', content: [{ type: 'text', text: args.userText }] });

    let status: TurnStatus = 'max_steps';
    let errorCode: string | null = null;
    let finalText = '';
    let step = 0;
    let groundingCorrections = 0;
    let styleCorrections = 0;

    try {
      while (step < limits.maxSteps) {
        step++;
        const lastStep = step === limits.maxSteps;
        const callStarted = Date.now();
        const response = await provider.complete({
          system: this.deps.systemPrompt(clock(), extras),
          messages: history,
          tools: registry.specs(),
          toolChoice: lastStep ? 'none' : 'auto',
          signal: deadline,
        });
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        tracer.modelCall({ traceId, step, latencyMs: Date.now() - callStarted, stopReason: response.stopReason, model: response.model });
        if (response.content.length > 0) await append({ role: 'assistant', content: response.content });

        const calls = response.content.flatMap((b) => (b.type === 'tool_call' ? [b] : []));
        if (response.stopReason === 'tool_use' && calls.length > 0 && !lastStep) {
          const ctx: ToolContext = {
            traceId, conversationId: args.conversationId, ownerId: args.ownerId, now: clock(), signal: deadline,
            requestConsent: (request) => {
              if (!consentRequests.some((r) => r.purpose === request.purpose)) consentRequests.push(request);
            },
          };
          const results = await this.executeCalls(calls, ctx, step, toolCalls, pendingApprovals);
          await append({ role: 'user', content: results });
          continue;
        }

        finalText = textOf(response.content);
        // Grounding guard: an answer that claims catalog knowledge without any catalog lookup in context is
        // held back once per turn; the model is told to look it up and answer again (customer never sees the draft).
        if (response.stopReason === 'end_turn' && finalText && !lastStep && groundingCorrections === 0) {
          const issues = groundingIssues(finalText, history);
          if (issues.length > 0) {
            groundingCorrections++;
            tracer.groundingCheck({ traceId, step, issues });
            await append({ role: 'user', content: [{ type: 'text', text: GROUNDING_NOTE }] });
            finalText = '';
            continue;
          }
        }
        // Style guard (same pattern): wrong reply language, unprompted development/meta talk or pet names → one
        // rewrite. High-precision rules only; nothing is string-edited.
        if (response.stopReason === 'end_turn' && finalText && !lastStep && styleCorrections === 0) {
          const issues = styleIssues(finalText, args.userText);
          if (issues.length > 0) {
            styleCorrections++;
            tracer.styleCheck({ traceId, step, issues });
            await append({ role: 'user', content: [{ type: 'text', text: styleNote(issues, args.userText) }] });
            finalText = '';
            continue;
          }
        }
        if (response.stopReason === 'end_turn') status = finalText ? 'completed' : 'empty_response';
        else if (response.stopReason === 'refusal' || response.stopReason === 'max_tokens') status = response.stopReason;
        else if (response.stopReason === 'tool_use') status = 'max_steps';
        else status = 'incomplete';
        // Truncated or late tool calls are never executed; with no usable text the user gets a fallback.
        if (status !== 'completed' && calls.length > 0) finalText = '';
        break;
      }
      if (status !== 'completed') errorCode ??= status.toUpperCase();
    } catch (err) {
      if (err instanceof ProviderError) {
        status = canceled() ? 'canceled' : err.code === 'PROVIDER_TIMEOUT' || deadline.aborted ? 'timeout' : 'provider_error';
        errorCode = canceled() ? 'CANCELED' : err.code;
      } else if (canceled()) {
        status = 'canceled';
        errorCode = 'CANCELED';
      } else if (deadline.aborted) {
        status = 'timeout';
        errorCode = 'AGENT_TIMEOUT';
      } else {
        status = 'provider_error';
        errorCode = 'INTERNAL_ERROR';
      }
    }

    // Never leave an unanswered tool call in the stored transcript.
    const dangling = unansweredToolCalls(history);
    if (dangling.length > 0) await append({ role: 'user', content: syntheticResults(dangling, 'NOT_EXECUTED') });
    if (!finalText && status !== 'completed') {
      finalText = fallbackFor(status, args.userText);
      await append({ role: 'assistant', content: [{ type: 'text', text: finalText }] });
    }

    const latencyMs = Date.now() - started;
    await tracer.finishRun({ traceId, status, errorCode, steps: step, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs });
    return {
      traceId, conversationId: args.conversationId, status, text: finalText, steps: step, toolCalls, pendingApprovals, consentRequests,
      usedSummary: prepared.summary !== null, groundingCorrections, styleCorrections, usage, latencyMs, errorCode,
    };
  }

  /** Read tools run in parallel; write tools run one at a time behind the approval gate. Order of results = order of calls. */
  private async executeCalls(
    calls: Array<Extract<ContentBlock, { type: 'tool_call' }>>,
    ctx: ToolContext,
    step: number,
    summaries: ToolCallSummary[],
    pendingApprovals: PendingApproval[],
  ): Promise<ContentBlock[]> {
    const results: ContentBlock[] = new Array<ContentBlock>(calls.length);
    const isWrite = (name: string) => this.deps.registry.get(name)?.sideEffect === 'write';
    await Promise.all(calls.map(async (call, i) => {
      if (!isWrite(call.name)) results[i] = await this.executeOne(call, ctx, step, summaries, pendingApprovals);
    }));
    for (const [i, call] of calls.entries()) {
      if (isWrite(call.name)) results[i] = await this.executeOne(call, ctx, step, summaries, pendingApprovals);
    }
    return results;
  }

  private async executeOne(
    call: Extract<ContentBlock, { type: 'tool_call' }>,
    ctx: ToolContext,
    step: number,
    summaries: ToolCallSummary[],
    pendingApprovals: PendingApproval[],
  ): Promise<ContentBlock> {
    const { registry, approvals, tracer, limits } = this.deps;
    const startedAt = Date.now();
    const tool: RegisteredTool | undefined = registry.get(call.name);
    tracer.toolStarted({ traceId: ctx.traceId, step, toolName: call.name });
    let payload: unknown;
    let outcome: 'ok' | 'error' = 'ok';
    let code: string | null = null;
    let summary: string | null = null;
    let sourceType: string | null = null;
    try {
      if (!tool) throw new ToolError('UNKNOWN_TOOL', `No tool named "${call.name}" exists.`);
      if (call.inputError) throw new ToolError('VALIDATION_ERROR', call.inputError);
      let runCtx = ctx;
      // Writes are validated before anything is shown to the customer for approval.
      const invalid = tool.sideEffect === 'write' ? tool.validate(call.input) : null;
      if (invalid) throw new ToolError('VALIDATION_ERROR', invalid);
      // Idempotent writes: an identical record that already exists is returned without asking again.
      const existing = tool.sideEffect === 'write' && tool.precheck ? await tool.precheck(call.input, ctx) : null;
      if (existing) {
        summary = existing.summary;
        sourceType = existing.sourceType;
        payload = { ok: true, sourceType: existing.sourceType, warnings: existing.warnings ?? [], result: existing.result };
      } else if (tool.authorization?.kind === 'consent') {
        if (!(await this.deps.consents.active(ctx.ownerId, tool.authorization.purpose))) {
          throw new ToolError('CONSENT_REQUIRED', 'The customer has not opted in to this. Ask them; if they agree, call request_memory_consent so the app can confirm with them.');
        }
      } else if (tool.authorization?.kind === 'approval') {
        const approvalId = await approvals.consume({ ownerId: ctx.ownerId, conversationId: ctx.conversationId, toolName: call.name, input: call.input });
        if (!approvalId) {
          const pending = await approvals.request({
            ownerId: ctx.ownerId, conversationId: ctx.conversationId, toolName: call.name, input: call.input, preview: tool.approvalPreview(call.input),
          });
          pendingApprovals.push(pending);
          throw new ToolError(
            'APPROVAL_REQUIRED',
            `"${call.name}" changes data. An approval request was shown to the user; tell them what will be saved and why, and wait for their decision. Retry with the same arguments only after they approve.`,
            { approvalId: pending.approvalId },
          );
        }
        runCtx = { ...ctx, approvalId };
      }
      if (!existing) {
        const out = await withTimeout((signal) => tool.run(call.input, { ...runCtx, signal }), limits.toolTimeoutMs, ctx.signal);
        summary = out.summary;
        sourceType = out.sourceType;
        payload = { ok: true, sourceType: out.sourceType, warnings: out.warnings ?? [], result: out.result };
      }
    } catch (err) {
      outcome = 'error';
      const safe = err instanceof ToolError ? err : new ToolError('TOOL_FAILED', 'The tool failed unexpectedly.');
      code = safe.code;
      summary = safe.message;
      payload = { ok: false, error: { code: safe.code, message: safe.message, ...(safe.details !== undefined ? { details: safe.details } : {}) } };
    }
    const latencyMs = Date.now() - startedAt;
    try {
      await tracer.recordTool({
        traceId: ctx.traceId, step, toolCallId: call.id, toolName: call.name, sideEffect: tool?.sideEffect ?? 'read', input: call.input,
        outcome, errorCode: code, resultSummary: summary, sourceType, latencyMs,
      });
    } catch {
      // A trace write failure must not break the user's turn or leave the tool call unanswered.
    }
    summaries.push({ step, name: call.name, outcome, errorCode: code, sourceType, latencyMs });
    let content = JSON.stringify(payload);
    const max = limits.maxToolResultChars ?? 24_000;
    if (content.length > max) {
      content = JSON.stringify({ ok: false, error: { code: 'RESULT_TOO_LARGE', message: 'Tool result exceeded the size limit; narrow the query.' } });
    }
    return { type: 'tool_result', toolCallId: call.id, content, isError: outcome === 'error' };
  }
}
