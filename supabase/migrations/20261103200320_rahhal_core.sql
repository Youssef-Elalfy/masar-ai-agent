-- RAHHAL AI core schema (Supabase Postgres + pgvector).
-- Applied to Supabase via the MCP apply_migration tool (after approval) and to PGlite in tests.
-- Access model: the agent server connects as a privileged role; RLS is enabled with NO policies,
-- so the public anon/authenticated API roles can read or write nothing.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ───────────────────────── Company catalog ─────────────────────────
create table public.organizations (
  id text primary key,
  name text not null,
  name_ar text,
  demo_flag boolean not null,
  created_at timestamptz not null default now()
);

create table public.packages (
  id text primary key,
  organization_id text not null references public.organizations (id),
  slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
  destination text not null,
  destination_ar text,
  country text not null,
  trip_type text not null,
  name_en text,
  name_ar text not null,
  days integer not null check (days > 0),
  nights integer not null check (nights >= 0 and nights <= days),
  price_amount numeric(12, 2) not null check (price_amount >= 0),
  price_currency char(3) not null,
  price_basis text not null,
  departure_city text,
  source_type text not null check (source_type in ('company_demo', 'company_verified')),
  status text not null,
  booking_enabled boolean not null default false,
  inclusions jsonb not null default '[]',
  exclusions jsonb not null default '[]',
  itinerary jsonb not null default '[]',
  tags jsonb not null default '[]',
  disclaimer text not null,
  search_text text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index packages_org_active_price_idx on public.packages (organization_id, active, price_amount);

create table public.package_departures (
  id text primary key,
  package_id text not null references public.packages (id) on delete cascade,
  departure_date date not null,
  origin text,
  availability_status text not null check (availability_status in ('confirmed', 'limited', 'sold_out', 'on_request', 'unknown')),
  seats_remaining integer check (seats_remaining >= 0),
  verified_at timestamptz,
  provider text
);
create index package_departures_pkg_date_idx on public.package_departures (package_id, departure_date);

-- ───────────────────────── Customers, consent, sessions ─────────────────────────
-- owner_id is a server-issued pseudonymous id; never taken from model output.
create table public.customers (
  owner_id text primary key,
  locale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references public.customers (owner_id) on delete cascade,
  purpose text not null check (purpose in ('long_term_memory', 'contact_storage', 'lead_creation', 'human_handoff')),
  policy_version text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  evidence_conversation_id text,
  evidence_message_seq integer
);
create unique index consents_one_active_per_purpose on public.consents (owner_id, purpose) where revoked_at is null;

create table public.conversations (
  id text primary key,
  owner_id text not null references public.customers (owner_id) on delete cascade,
  locale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);
create index conversations_owner_idx on public.conversations (owner_id, updated_at desc);

-- Append-only transcript (provider-neutral content blocks).
create table public.messages (
  id bigint generated always as identity primary key,
  conversation_id text not null references public.conversations (id) on delete cascade,
  owner_id text not null,
  seq integer not null,
  role text not null check (role in ('user', 'assistant')),
  content jsonb not null,
  trace_id text,
  recorded_at timestamptz not null default now(),
  unique (conversation_id, seq)
);

create table public.conversation_summaries (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null references public.conversations (id) on delete cascade,
  owner_id text not null,
  summary text not null,
  covers_until_seq integer not null,
  topic_state jsonb not null default '{}',
  embedding extensions.vector(1024),
  embedding_model text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days'),
  check ((embedding is null) = (embedding_model is null))
);
create index conversation_summaries_conv_idx on public.conversation_summaries (conversation_id, covers_until_seq desc);

-- ───────────────────────── Long-term memory (opt-in) ─────────────────────────
create table public.memory_items (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references public.customers (owner_id) on delete cascade,
  consent_id uuid not null references public.consents (id),
  kind text not null check (kind in ('preference', 'fact', 'contact')),
  category text not null,
  content text not null,
  value jsonb,
  purpose text not null,
  source_conversation_id text,
  source_message_seq integer,
  confidence real not null default 1 check (confidence between 0 and 1),
  embedding extensions.vector(1024),
  embedding_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  deleted_at timestamptz,
  superseded_by uuid references public.memory_items (id),
  -- Contact details are never embedded or semantically searchable.
  check (kind <> 'contact' or embedding is null),
  check ((embedding is null) = (embedding_model is null))
);
create index memory_items_owner_active_idx on public.memory_items (owner_id, category)
  where deleted_at is null and superseded_by is null;
create index memory_items_embedding_idx on public.memory_items using hnsw (embedding extensions.vector_cosine_ops);
create index memory_items_content_trgm_idx on public.memory_items using gin (content extensions.gin_trgm_ops);

-- ───────────────────────── Approvals and CRM ─────────────────────────
-- Single-use, argument-bound approvals for write tools (human in the loop).
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references public.customers (owner_id) on delete cascade,
  conversation_id text not null,
  tool_name text not null,
  args_hash text not null,
  args_preview jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'consumed', 'expired')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  consumed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '15 minutes')
);
create index approvals_owner_status_idx on public.approvals (owner_id, status);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references public.customers (owner_id) on delete cascade,
  consent_id uuid not null references public.consents (id),
  approval_id uuid references public.approvals (id),
  idempotency_key text not null,
  contact_name text,
  contact_phone text,
  contact_email text,
  destination text,
  date_range text,
  budget_amount numeric(12, 2),
  budget_currency char(3),
  party_adults integer,
  party_children integer,
  notes text,
  status text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  created_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)
);

create table public.quote_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references public.customers (owner_id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  package_id text references public.packages (id),
  approval_id uuid references public.approvals (id),
  idempotency_key text not null,
  summary text not null,
  status text not null default 'submitted' check (status in ('submitted', 'in_review', 'answered', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)
);

create table public.handoff_requests (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references public.customers (owner_id) on delete cascade,
  lead_id uuid references public.leads (id) on delete set null,
  approval_id uuid references public.approvals (id),
  reason text not null,
  summary text not null,
  status text not null default 'open' check (status in ('open', 'assigned', 'closed')),
  created_at timestamptz not null default now()
);

-- ───────────────────────── Observability ─────────────────────────
create table public.agent_runs (
  trace_id text primary key,
  conversation_id text not null,
  owner_id text not null references public.customers (owner_id) on delete cascade,
  provider text not null,
  model text not null,
  status text not null,
  error_code text,
  steps integer not null default 0,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  latency_ms integer
);
create index agent_runs_conversation_idx on public.agent_runs (conversation_id, started_at);

create table public.tool_executions (
  id bigint generated always as identity primary key,
  trace_id text not null references public.agent_runs (trace_id) on delete cascade,
  step integer not null,
  tool_call_id text not null,
  tool_name text not null,
  input_redacted jsonb not null,
  outcome text not null check (outcome in ('ok', 'error')),
  error_code text,
  result_summary text,
  source_type text,
  latency_ms integer not null,
  executed_at timestamptz not null default now()
);
create index tool_executions_trace_idx on public.tool_executions (trace_id);

-- ───────────────────────── External offers (M3) ─────────────────────────
create table public.external_offers_cache (
  id uuid primary key default gen_random_uuid(),
  provider_name text not null,
  source_url text not null check (source_url ~ '^https://'),
  country text,
  destination text,
  title text,
  price_amount numeric(12, 2),
  price_currency char(3),
  price_basis text,
  travel_dates text,
  status text not null check (status in ('listed_unverified', 'verified_available', 'verified_unavailable', 'on_request', 'unknown')),
  payload jsonb not null,
  raw_hash text not null unique,
  retrieved_at timestamptz not null,
  verified_at timestamptz,
  expires_at timestamptz not null
);

-- ───────────────────────── Functions ─────────────────────────
-- Consent-aware, owner-scoped semantic recall. Contact items, revoked consent, deleted,
-- superseded and expired items are never returned; vectors from other models are never compared.
create function public.match_memory_items(
  p_owner_id text,
  p_query_embedding extensions.vector(1024),
  p_embedding_model text,
  p_match_count integer,
  p_min_similarity double precision
)
returns table (id uuid, category text, content text, value jsonb, confidence real, updated_at timestamptz, similarity double precision)
language sql
stable
set search_path = ''
as $$
  select m.id, m.category, m.content, m.value, m.confidence, m.updated_at,
         1 - (m.embedding operator(extensions.<=>) p_query_embedding) as similarity
  from public.memory_items m
  join public.consents c on c.id = m.consent_id and c.revoked_at is null and c.owner_id = m.owner_id
  where m.owner_id = p_owner_id
    and m.kind <> 'contact'
    and m.deleted_at is null
    and m.superseded_by is null
    and (m.expires_at is null or m.expires_at > now())
    and m.embedding_model = p_embedding_model
    and 1 - (m.embedding operator(extensions.<=>) p_query_embedding) >= p_min_similarity
  order by m.embedding operator(extensions.<=>) p_query_embedding
  limit least(p_match_count, 50);
$$;

-- Retention: removes expired transcripts, summaries, memories, approvals and offer cache rows.
create function public.purge_expired_data()
returns void
language sql
set search_path = ''
as $$
  delete from public.conversations where expires_at < now();
  delete from public.conversation_summaries where expires_at < now();
  delete from public.memory_items where expires_at is not null and expires_at < now() and superseded_by is null;
  update public.approvals set status = 'expired' where status in ('pending', 'approved') and expires_at < now();
  delete from public.external_offers_cache where expires_at < now();
$$;

-- ───────────────────────── Lock down the public API surface ─────────────────────────
alter table public.organizations enable row level security;
alter table public.packages enable row level security;
alter table public.package_departures enable row level security;
alter table public.customers enable row level security;
alter table public.consents enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.conversation_summaries enable row level security;
alter table public.memory_items enable row level security;
alter table public.approvals enable row level security;
alter table public.leads enable row level security;
alter table public.quote_requests enable row level security;
alter table public.handoff_requests enable row level security;
alter table public.agent_runs enable row level security;
alter table public.tool_executions enable row level security;
alter table public.external_offers_cache enable row level security;

revoke execute on function public.match_memory_items(text, extensions.vector, text, integer, double precision) from public;
revoke execute on function public.purge_expired_data() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke execute on function public.match_memory_items(text, extensions.vector, text, integer, double precision) from anon, authenticated';
    execute 'revoke execute on function public.purge_expired_data() from anon, authenticated';
  end if;
end
$$;
