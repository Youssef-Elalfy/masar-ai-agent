/**
 * Minimal, safe Markdown for agent replies. Output is a plain data tree rendered by React (no HTML strings,
 * no dangerouslySetInnerHTML). Links are kept only for http(s); anything else stays visible text.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' };

export type Block =
  | { type: 'p'; inline: Inline[] }
  | { type: 'h'; level: 3 | 4; inline: Inline[] }
  | { type: 'ul'; items: Inline[][] }
  | { type: 'ol'; items: Inline[][]; start: number }
  | { type: 'code'; text: string }
  | { type: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { type: 'hr' };

/**
 * Base direction of a whole reply from its dominant script (not its first character): an Arabic answer that starts
 * with "**Sharm**" or a number stays RTL, so its lists put their markers on the right.
 */
export function replyDirection(text: string): 'rtl' | 'ltr' {
  const letters = text.replace(/https?:\/\/\S+|`[^`]*`/g, ' ').match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 'ltr';
  const arabic = letters.filter((c) => /\p{Script=Arabic}/u.test(c)).length;
  return arabic / letters.length >= 0.3 ? 'rtl' : 'ltr';
}

/**
 * Direction of the message field: the UI language while it has no letters (empty, or only digits/punctuation),
 * then the dominant script of what is typed.
 */
export function fieldDirection(text: string, uiLang: 'ar' | 'en'): 'rtl' | 'ltr' {
  if (!/\p{L}/u.test(text)) return uiLang === 'ar' ? 'rtl' : 'ltr';
  return replyDirection(text);
}

/** Returns a normalized https/http URL, or null for any other scheme or malformed input. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?،؛])|((?<![\w*])\*[^*\n]+?\*(?![\w*]))|((?<![\w_])_[^_\n]+?_(?![\w_]))/u;

export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest.length > 0) {
    const m = depth > 4 ? null : INLINE.exec(rest);
    if (!m || m.index === undefined) {
      pushText(out, rest);
      break;
    }
    if (m.index > 0) pushText(out, rest.slice(0, m.index));
    const [token] = m;
    if (m[1]) out.push({ type: 'code', text: token.slice(1, -1) });
    else if (m[2]) out.push({ type: 'strong', children: parseInline(token.slice(2, -2), depth + 1) });
    else if (m[3]) {
      const close = token.indexOf('](');
      const label = token.slice(1, close);
      const href = safeHref(token.slice(close + 2, -1));
      out.push(href ? { type: 'link', href, children: parseInline(label, depth + 1) } : { type: 'text', text: token });
    } else if (m[4]) {
      const href = safeHref(token);
      out.push(href ? { type: 'link', href, children: [{ type: 'text', text: token }] } : { type: 'text', text: token });
    } else if (m[5] || m[6]) out.push({ type: 'em', children: parseInline(token.slice(1, -1), depth + 1) });
    rest = rest.slice(m.index + token.length);
  }
  return out;
}

function pushText(out: Inline[], text: string): void {
  const parts = text.split('\n');
  parts.forEach((part, i) => {
    if (i > 0) out.push({ type: 'br' });
    if (!part) return;
    const last = out.at(-1);
    if (last?.type === 'text') last.text += part;
    else out.push({ type: 'text', text: part });
  });
}

const splitRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => parseInline(c.trim()));
const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) blocks.push({ type: 'p', inline: parseInline(para.join('\n').trim()) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*```/.test(line)) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) code.push(lines[i++] ?? '');
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      blocks.push({ type: 'hr' });
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ type: 'h', level: (heading[1]?.length ?? 3) <= 2 ? 3 : 4, inline: parseInline(heading[2] ?? '') });
      continue;
    }
    if (line.includes('|') && isTableSep(lines[i + 1] ?? '')) {
      flushPara();
      const head = splitRow(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) rows.push(splitRow(lines[i++] ?? ''));
      i--;
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const kind = bullet ? 'ul' : 'ol';
      // Keep the author's numbering: models often put a blank line between "1." and "2.", which starts a new list.
      const start = numbered ? Number(/^\s*(\d+)/.exec(line)?.[1] ?? 1) : 1;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        const m = kind === 'ul' ? /^\s*[-*•]\s+(.*)$/.exec(l) : /^\s*\d+[.)]\s+(.*)$/.exec(l);
        if (m) items.push(parseInline(m[1] ?? ''));
        else if (l.trim() && /^\s{2,}/.test(l) && items.length > 0) items[items.length - 1]?.push({ type: 'br' }, ...parseInline(l.trim()));
        else break;
        i++;
      }
      i--;
      blocks.push(kind === 'ol' ? { type: 'ol', items, start } : { type: 'ul', items });
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}
