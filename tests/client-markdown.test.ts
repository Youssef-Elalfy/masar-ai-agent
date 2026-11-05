import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldDirection, parseInline, parseMarkdown, replyDirection, safeHref } from '../client/src/lib/markdown.ts';

test('composer direction: the UI language while empty or digits-only, then the dominant script of the text', () => {
  assert.equal(fieldDirection('', 'ar'), 'rtl');
  assert.equal(fieldDirection('', 'en'), 'ltr');
  assert.equal(fieldDirection('8000 ', 'ar'), 'rtl');
  assert.equal(fieldDirection('Sharm in December', 'ar'), 'ltr');
  assert.equal(fieldDirection('عايز شرم', 'en'), 'rtl');
});

test('reply direction follows the dominant script, not the first character (lists keep their markers on one side)', () => {
  assert.equal(replyDirection('**Sharm El Sheikh** برنامج جنة سيناء 4 أيام بـ 7,800 جنيه للفرد'), 'rtl');
  assert.equal(replyDirection('7,800 جنيه للفرد'), 'rtl');
  assert.equal(replyDirection('The cheapest program is الفيوم (Fayoum), 3,200 EGP.'), 'ltr');
  assert.equal(replyDirection('شوف https://www.example-travel-site.com/very/long/english/path ده'), 'rtl');
  assert.equal(replyDirection('12345'), 'ltr');
});

test('ordered lists keep their author start for the CSS counter', () => {
  const blocks = parseMarkdown('3. الخطوة التالتة\n4. الخطوة الرابعة');
  assert.ok(blocks[0]?.type === 'ol');
  assert.equal(blocks[0].start, 3);
  assert.equal(blocks[0].items.length, 2);
});
import { formatMoney } from '../client/src/lib/format.ts';

test('only http(s) links survive; script and data schemes stay plain text', () => {
  assert.equal(safeHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,<script>'), null);
  assert.equal(safeHref('https://user:pw@example.com'), null);
  assert.deepEqual(parseInline('[click](javascript:alert(1))'), [{ type: 'text', text: '[click](javascript:alert(1))' }]);
  const link = parseInline('[المصدر](https://tour.example/turkey)');
  assert.deepEqual(link, [{ type: 'link', href: 'https://tour.example/turkey', children: [{ type: 'text', text: 'المصدر' }] }]);
});

test('raw HTML is text, never markup', () => {
  const blocks = parseMarkdown('<img src=x onerror=alert(1)> **مهم**');
  assert.deepEqual(blocks, [{ type: 'p', inline: [{ type: 'text', text: '<img src=x onerror=alert(1)> ' }, { type: 'strong', children: [{ type: 'text', text: 'مهم' }] }] }]);
});

test('lists, headings, tables and code blocks as the model writes them', () => {
  const md = '### الغردقة\n- **السعر:** 6,500 جنيه\n- 4 أيام\n\n| البرنامج | السعر |\n|---|---|\n| شرم | 7,800 |\n\n```\ncode\n```';
  const blocks = parseMarkdown(md);
  assert.deepEqual(blocks.map((b) => b.type), ['h', 'ul', 'table', 'code']);
  const table = blocks[2];
  assert.ok(table?.type === 'table');
  assert.equal(table.rows.length, 1);
});

test('numbered items separated by blank lines keep their numbers (live render showed 1., 1., 1.)', () => {
  const blocks = parseMarkdown(['1. أول', '', '2. تاني', '', '3. تالت'].join('\n'));
  assert.deepEqual(blocks.map((b) => (b.type === 'ol' ? b.start : -1)), [1, 2, 3]);
});

test('bare URLs become links without trailing punctuation; prices keep Western digits', () => {
  assert.deepEqual(parseInline('شوف https://a.example/x.'), [{ type: 'text', text: 'شوف ' }, { type: 'link', href: 'https://a.example/x', children: [{ type: 'text', text: 'https://a.example/x' }] }, { type: 'text', text: '.' }]);
  assert.equal(formatMoney(7800, 'EGP', 'ar'), '7,800 جنيه');
  assert.equal(formatMoney(599, 'USD', 'en'), '599 USD');
});
