-- Covering indexes for foreign keys flagged by the Supabase performance advisor (0001_unindexed_foreign_keys).
-- They keep cascading erasure (delete customer → sessions, memories, CRM rows) and joins fast as data grows.

create index if not exists agent_runs_owner_idx on public.agent_runs (owner_id);
create index if not exists handoff_requests_owner_idx on public.handoff_requests (owner_id);
create index if not exists handoff_requests_lead_idx on public.handoff_requests (lead_id);
create index if not exists handoff_requests_approval_idx on public.handoff_requests (approval_id);
create index if not exists leads_consent_idx on public.leads (consent_id);
create index if not exists leads_approval_idx on public.leads (approval_id);
create index if not exists memory_items_consent_idx on public.memory_items (consent_id);
create index if not exists memory_items_superseded_by_idx on public.memory_items (superseded_by);
create index if not exists quote_requests_lead_idx on public.quote_requests (lead_id);
create index if not exists quote_requests_package_idx on public.quote_requests (package_id);
create index if not exists quote_requests_approval_idx on public.quote_requests (approval_id);
