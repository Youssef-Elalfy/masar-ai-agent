import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUNDING_NOTE, groundingIssues } from '../server/src/agent/grounding.ts';
import type { ChatMessage, CompletionRequest } from '../server/src/agent/providers/types.ts';
import { ScriptedProvider, final, testApp, toolUse } from './helpers.ts';

// The exact unsupported answer gemini-3.5-flash-lite gave in the live voice test (no tool was called).
const LIVE_HALLUCINATION = 'يا هلا بيك! راجعت كتالوج الشركة وعشان شرم الشيخ مش موجودة في الكتالوج الحالي، ممكن أرشح لك رحلات تانية زي الغردقة أو سيوة.';

const lastUserText = (req: CompletionRequest | undefined) =>
  req?.messages.at(-1)?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('') ?? '';

test('catalog claims need a catalog lookup in context; other answers are untouched', () => {
  const noLookup: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'عايز شرم 4 أيام' }] }];
  assert.deepEqual(groundingIssues(LIVE_HALLUCINATION, noLookup), ['catalog_claim_without_lookup']);
  assert.deepEqual(groundingIssues('I checked our programs: nothing for Sharm.', noLookup), ['catalog_claim_without_lookup']);
  assert.deepEqual(groundingIssues('قانون نيوتن التاني بيقول إن القوة = الكتلة × العجلة.', noLookup), []);
  const withLookup: ChatMessage[] = [
    ...noLookup,
    { role: 'assistant', content: [{ type: 'tool_call', id: 's1', name: 'search_company_packages', input: { query: 'شرم' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 's1', content: '{"ok":true}', isError: false }] },
  ];
  assert.deepEqual(groundingIssues('راجعت الكتالوج: شرم 7800 جنيه للفرد (تجريبي).', withLookup), []);
  const failedLookup: ChatMessage[] = [...noLookup, withLookup[1] as ChatMessage, { role: 'user', content: [{ type: 'tool_result', toolCallId: 's1', content: '{}', isError: true }] }];
  assert.deepEqual(groundingIssues('راجعت الكتالوج', failedLookup), ['catalog_claim_without_lookup']);
});

test('live regression: an ungrounded catalog answer is held back, the model looks it up and answers from data', async () => {
  const provider = new ScriptedProvider((req, i) => {
    if (i === 0) return final(LIVE_HALLUCINATION);
    if (i === 1) {
      assert.equal(lastUserText(req), GROUNDING_NOTE);
      return toolUse({ id: 's1', name: 'search_company_packages', input: { query: 'Sharm', maxDays: 4 } });
    }
    return final('شرم الشيخ موجودة: جنة سيناء 4 أيام / 3 ليالي بـ 7,800 جنيه للفرد (أسعار تجريبية).');
  });
  const app = await testApp(provider);
  const result = await app.runtime.runTurn({ conversationId: await app.conversations.create('g-1'), ownerId: 'g-1', userText: 'I want a trip to Sharm for four days' });
  assert.equal(result.status, 'completed');
  assert.equal(result.groundingCorrections, 1);
  assert.deepEqual(result.toolCalls.map((t) => t.name), ['search_company_packages']);
  assert.match(result.text, /7,800/);
  assert.doesNotMatch(result.text, /سيوة/);
});

test('the guard re-asks at most once per turn (no loops, bounded free-tier usage)', async () => {
  const provider = new ScriptedProvider(() => final('راجعت الكتالوج ومفيش حاجة.'));
  const app = await testApp(provider);
  const result = await app.runtime.runTurn({ conversationId: await app.conversations.create('g-2'), ownerId: 'g-2', userText: 'عندكم إيه؟' });
  assert.equal(provider.requests.length, 2);
  assert.equal(result.groundingCorrections, 1);
  assert.equal(result.status, 'completed');
});

test('off-topic answers are never re-asked', async () => {
  const provider = new ScriptedProvider(() => final('أكيد! JavaScript لغة برمجة للويب… نبدأ بالمتغيرات.'));
  const app = await testApp(provider);
  const result = await app.runtime.runTurn({ conversationId: await app.conversations.create('g-3'), ownerId: 'g-3', userText: 'علمني JavaScript' });
  assert.equal(provider.requests.length, 1);
  assert.equal(result.groundingCorrections, 0);
});
