import type { ChatMessage, ContentBlock } from './providers/types.ts';

export function toolCallIds(message: ChatMessage): string[] {
  return message.content.flatMap((b) => (b.type === 'tool_call' ? [b.id] : []));
}

export function unansweredToolCalls(history: ChatMessage[]): string[] {
  const last = history.at(-1);
  return last && last.role === 'assistant' ? toolCallIds(last) : [];
}

export function syntheticResults(ids: string[], code: string): ContentBlock[] {
  return ids.map((id) => ({
    type: 'tool_result',
    toolCallId: id,
    content: JSON.stringify({ ok: false, error: { code, message: 'This tool call was not executed.' } }),
    isError: true,
  }));
}

/**
 * Makes a stored transcript valid for any provider: every tool_call is answered by a tool_result
 * in the next user message, and tool_results without a preceding call are dropped.
 * Protects against crashes between appends (storage itself stays append-only).
 */
export function repairHistory(history: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (!msg) continue;
    const prev = out.at(-1);
    if (msg.role === 'user') {
      const expected = new Set(prev?.role === 'assistant' ? toolCallIds(prev) : []);
      const content = msg.content.filter((b) => b.type !== 'tool_result' || expected.has(b.toolCallId));
      const answered = new Set(content.flatMap((b) => (b.type === 'tool_result' ? [b.toolCallId] : [])));
      const missing = [...expected].filter((id) => !answered.has(id));
      const fixed = [...syntheticResults(missing, 'INTERRUPTED'), ...content];
      if (fixed.length > 0) out.push({ role: 'user', content: fixed });
      continue;
    }
    const pending = prev?.role === 'assistant' ? toolCallIds(prev) : [];
    if (pending.length > 0) out.push({ role: 'user', content: syntheticResults(pending, 'INTERRUPTED') });
    out.push(msg);
  }
  return out;
}
