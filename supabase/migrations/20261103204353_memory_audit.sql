-- M2 review follow-up: content-free memory/consent audit log, save provenance, safer retention purge.

-- Audit of consent decisions and deletions (docs/03 "audit deletion"). Never stores memory content.
create table public.memory_events (
  id bigint generated always as identity primary key,
  owner_id text not null references public.customers (owner_id) on delete cascade,
  event text not null check (event in ('consent_granted', 'consent_declined', 'consent_revoked', 'memory_saved', 'memory_forgotten', 'erased_all')),
  conversation_id text,
  category text,
  item_count integer,
  trace_id text,
  policy_version text,
  occurred_at timestamptz not null default now()
);
create index memory_events_owner_idx on public.memory_events (owner_id, occurred_at desc);
create index memory_events_conversation_idx on public.memory_events (conversation_id, event);
alter table public.memory_events enable row level security;

-- Provenance: which agent run saved a preference.
alter table public.memory_items add column source_trace_id text;

-- Purge. The app keeps supersede chains one level deep (every replaced row points at the current
-- row), so an expired current row and its history are removed in ONE statement (no FK violation,
-- no resurrection of replaced values). Replaced history older than 30 days is dropped as well.
create or replace function public.purge_expired_data()
returns void
language sql
set search_path = ''
as $$
  delete from public.memory_items
  where (expires_at is not null and expires_at < now())
     or superseded_by in (select id from public.memory_items where expires_at is not null and expires_at < now())
     or (superseded_by is not null and updated_at < now() - interval '30 days');
  delete from public.conversations where expires_at < now();
  delete from public.conversation_summaries where expires_at < now();
  update public.approvals set status = 'expired' where status in ('pending', 'approved') and expires_at < now();
  delete from public.external_offers_cache where expires_at < now();
$$;
revoke execute on function public.purge_expired_data() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.memory_events from anon, authenticated';
    execute 'revoke execute on function public.purge_expired_data() from anon, authenticated';
  end if;
end
$$;
