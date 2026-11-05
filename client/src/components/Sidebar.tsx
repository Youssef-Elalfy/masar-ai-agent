import { useMemo, useState } from 'react';
import { MessageSquare, Plus, Search, Trash2 } from 'lucide-react';
import type { ConversationListItem } from '../../../server/src/web/contracts.ts';
import { dateGroup, type DateGroup } from '../lib/format.ts';
import type { SettingsApi } from '../state/settings.ts';
import { LogoMark, Wordmark } from './Logo.tsx';

interface Props {
  s: SettingsApi;
  conversations: ConversationListItem[] | null;
  activeId: string | null;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (item: ConversationListItem) => void;
  showBrand?: boolean;
}

const GROUPS: DateGroup[] = ['today', 'yesterday', 'earlier'];

export function Sidebar({ s, conversations, activeId, onNew, onOpen, onDelete, showBrand = true }: Props) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (conversations ?? []).filter((c) => !q || (c.title ?? '').toLowerCase().includes(q));
  }, [conversations, query]);

  return (
    <nav aria-label={s.t('menu')} className="flex flex-col h-full min-h-0 gap-5 p-5">
      {showBrand && (
        <div className="flex items-center gap-3 px-1 pt-1">
          <LogoMark size={40} />
          <div className="flex flex-col gap-1 min-w-0">
            <Wordmark lang={s.lang} />
            <span className="text-meta text-muted leading-snug">{s.t('tagline')}</span>
          </div>
        </div>
      )}
      <button type="button" className="btn btn-brand w-full !min-h-11" onClick={onNew}>
        <Plus size={18} aria-hidden="true" />{s.t('newChat')}
      </button>
      <div className="relative">
        <Search size={16} className="absolute top-1/2 -translate-y-1/2 start-3 text-muted pointer-events-none" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={s.t('searchChats')}
          aria-label={s.t('searchChats')}
          className="w-full rounded-input border border-line bg-[var(--glass-card)] ps-9 pe-3 py-2 text-small placeholder:text-muted focus:border-focus"
        />
      </div>
      <div className="scroll-area flex-1 min-h-0 -mx-2 px-2">
        {conversations === null ? (
          <ul className="flex flex-col gap-2" aria-hidden="true">
            {[0, 1, 2].map((i) => <li key={i} className="h-14 rounded-input bg-raised/60" />)}
          </ul>
        ) : filtered.length === 0 ? (
          <p className="text-small text-muted px-2 py-3">{conversations.length === 0 ? s.t('noChats') : s.t('noMatch')}</p>
        ) : (
          GROUPS.map((g) => {
            const rows = filtered.filter((c) => dateGroup(c.updatedAt) === g);
            if (rows.length === 0) return null;
            return (
              <section key={g} className="mb-4">
                <h2 className="label-caps text-muted px-3 mb-1.5">{s.t(g)}</h2>
                <ul className="flex flex-col gap-0.5">
                  {rows.map((c) => {
                    const active = c.id === activeId;
                    return (
                      <li key={c.id} className="group relative">
                        <button
                          type="button"
                          onClick={() => onOpen(c.id)}
                          aria-current={active ? 'page' : undefined}
                          className={`w-full text-start rounded-input px-3 py-2.5 pe-10 flex items-start gap-2.5 transition-colors ${active ? 'bg-raised/90 shadow-[inset_0_1px_0_var(--glass-hi)]' : 'hover:bg-raised/60'}`}
                        >
                          {active && <span className="absolute inset-y-2 start-0 w-[3px] rounded-full bg-action" aria-hidden="true" />}
                          <MessageSquare size={16} className="mt-1 shrink-0 text-muted" aria-hidden="true" />
                          <span className="min-w-0">
                            <span className="block truncate" dir="auto">{c.title ?? s.t('untitled')}</span>
                            <span className="block text-meta text-muted tabular">{c.userTurns} {s.t('turns')}</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="icon-btn !w-8 !h-8 absolute top-1/2 -translate-y-1/2 end-1.5 opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 focus:opacity-100"
                          aria-label={`${s.t('deleteChat')}: ${c.title ?? s.t('untitled')}`}
                          onClick={() => onDelete(c)}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}
      </div>
      <p className="text-meta text-muted px-1">{s.t('demoNotice')}</p>
    </nav>
  );
}
