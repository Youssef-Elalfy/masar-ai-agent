import { memo, useMemo, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { parseMarkdown, replyDirection, type Inline } from '../lib/markdown.ts';

function renderInline(nodes: Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}.${i}`;
    switch (n.type) {
      case 'text':
        return n.text;
      case 'br':
        return <br key={key} />;
      case 'code':
        return <code key={key} dir="ltr">{n.text}</code>;
      case 'strong':
        return <strong key={key}>{renderInline(n.children, key)}</strong>;
      case 'em':
        return <em key={key}>{renderInline(n.children, key)}</em>;
      case 'link': {
        const host = new URL(n.href).host.replace(/^www\./, '');
        const label = n.children.map((c) => (c.type === 'text' ? c.text : '')).join('');
        const bare = label === n.href || n.href === `${label}/`;
        return (
          <a key={key} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {bare ? <bdi dir="ltr">{label}</bdi> : renderInline(n.children, key)}
            {!bare && !label.includes(host) && <span className="text-meta text-muted ms-1" dir="ltr">({host})</span>}
            <ExternalLink aria-hidden="true" className="inline ms-0.5 align-[-2px]" size={13} />
          </a>
        );
      }
    }
  });
}

/** Renders agent Markdown as React elements (no HTML injection; links are http(s) only). */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const dir = useMemo(() => replyDirection(text), [text]);
  return (
    <div className="md" dir={dir}>
      {blocks.map((b, i) => {
        const key = String(i);
        switch (b.type) {
          case 'p':
            return <p key={key} dir="auto">{renderInline(b.inline, key)}</p>;
          case 'h':
            return b.level === 3 ? <h3 key={key}>{renderInline(b.inline, key)}</h3> : <h4 key={key}>{renderInline(b.inline, key)}</h4>;
          case 'ul':
            return <ul key={key}>{b.items.map((item, j) => <li key={j}>{renderInline(item, `${key}.${j}`)}</li>)}</ul>;
          case 'ol':
            return (
              // Number badges come from a CSS counter; it starts where the author's numbering starts.
              <ol key={key} start={b.start} style={{ counterReset: `md-ol ${b.start - 1}` }}>
                {b.items.map((item, j) => <li key={j}>{renderInline(item, `${key}.${j}`)}</li>)}
              </ol>
            );
          case 'code':
            return <pre key={key}><code>{b.text}</code></pre>;
          case 'hr':
            return <hr key={key} className="border-line" />;
          case 'table':
            return (
              <div key={key} className="table-wrap">
                <table>
                  <thead><tr>{b.head.map((c, j) => <th key={j} dir="auto">{renderInline(c, `${key}.h${j}`)}</th>)}</tr></thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>{row.map((c, j) => <td key={j} dir="auto" className="tabular">{renderInline(c, `${key}.${r}.${j}`)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
});
