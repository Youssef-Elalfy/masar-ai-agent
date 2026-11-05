# RAHHAL AI — Implementation Plan

Target: a standalone, tool-using, stateful, observable AI travel **agent** for a fictional company. No tourism website. See `ENVIRONMENT_AUDIT.md` for what is verified on this machine.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime | Own agent loop in TypeScript (Node 24, native TS) | Spec allows "another justified TS runtime". An explicit loop makes every step (validation, approval gate, retry, trace) inspectable for the academic evaluation and keeps the LLM provider swappable. |
| LLM providers | Anthropic Messages API and OpenAI Chat Completions adapters via `fetch` | User chose both adapters and no SDK. Each adapter is only called "working" after a live call with a real key. Default Anthropic model `claude-opus-5-5` (override with `ANTHROPIC_MODEL`, e.g. `claude-haiku-5-5` for cheaper runs). OpenAI requires `OPENAI_MODEL`; no model ID is guessed. |
| Database | **Supabase Postgres** (free-tier project, eu-central-1, $0/month) + pgvector + pg_trgm. Migrations in `supabase/migrations/`; tests run the same SQL on PGlite (in-process Postgres 18 + pgvector) | User decision 2026-11-03: Supabase is the primary DB; no SQLite. RLS enabled on every table with no policies, so the public API roles cannot read anything; the agent server connects with `DATABASE_URL`. |
| Embeddings | OpenAI `text-embedding-3-small` at 1024 dims (user decision) behind an `EmbeddingProvider` port; model name stored per vector | Multilingual (Arabic) and cheap. Without a key, memory recall falls back to SQL filters + trigram matching, and says so. |
| Schemas | Zod 4; `z.toJSONSchema()` produces provider tool schemas | One source of truth for validation and the model-facing contract. |
| Tests | `node:test` + scripted test provider | Deterministic loop tests without network. The scripted provider lives under `tests/` only and is never selectable in the CLI. |
| History | Append-only per conversation | Required so Anthropic thinking blocks stay valid across turns; memory summarization (M2) starts a fresh model context instead of editing history. |

## Milestones

### M0 — Audit and plan ✅ (this document + `ENVIRONMENT_AUDIT.md`)

### M1 — Core agent ✅ offline; live run pending an LLM key
- `server/src/config.ts` typed env config (`.env` via `process.loadEnvFile`).
- `server/src/db/` Postgres access port (`sql.ts`, node-postgres `pg-sql.ts`), migration runner, idempotent seed from `fixtures/`.
- `server/src/catalog/` package repository with Arabic/English normalized search; adding a package = inserting a row (`npm run catalog:add`).
- `server/src/tools/` typed registry + `list_company_destinations`, `search_company_packages`, `get_package_details`, `compare_company_packages`, `check_company_departures`, `research_external_packages` (honest `unavailable` until M3), `get_system_status`.
- `server/src/agent/` provider interface, Anthropic/OpenAI adapters, bounded loop (max steps, deadline, per-tool timeout, Zod validation, unknown-tool and approval gates, retry/backoff on 429/5xx), system prompt from `prompts/RUNTIME_AGENT_BEHAVIOR.md` rules.
- `server/src/observability/` trace IDs, `agent_runs` + `tool_executions` tables, PII redaction.
- `server/src/cli.ts` terminal console (`npm run chat`) printing tool trace lines.
- **Exit:** unit + loop tests pass offline; one live run per configured provider shows real tool selection and grounded prices (blocked until a key exists).

### M1.5 — Supabase port + architect review fixes ✅ (`rahhal_core` + `fk_indexes` applied to Supabase 2026-11-03 and verified; catalog not yet seeded there)
- Schema `supabase/migrations/20261103200320_rahhal_core.sql`: catalog, customers, per-owner consent log, conversations (30-day TTL), append-only messages, summaries (90-day TTL), memory_items with pgvector(1024) + HNSW + trigram index, single-use approvals, leads, quote requests, handoffs, agent_runs/tool_executions (owner-scoped, cascade on erasure), external offer cache; `match_memory_items` (owner + consent + TTL + model scoped) and `purge_expired_data` functions.
- Review fixes: no unanswered tool calls in stored history (+ `repairHistory`), forced text answer on the last step, per-conversation lock, currency-safe budget verdicts, Arabic/Franco synonyms and clitics in search, redaction of Arabic-Indic digits and keyed PII, listener events carry no raw input, argument-bound single-use approvals with sequential write tools, Cairo-local date + weekday, departures from today with stale flags, org-scoped catalog queries, fallbacks in the user's language, oversized tool results capped.

### M2 — Memory + consent ✅ offline (live embeddings pending an OpenAI key)
- `EmbeddingProvider` (OpenAI 3-small @1024, fetch) + `MemoryService`: consent grant/revoke (server-side, recorded from the user's explicit UI/CLI decision, never by the model), `request_memory_consent` (queues a client prompt; cannot grant), `retrieve_customer_memory` (pgvector → trigram fallback, plus earlier-conversation summaries for opted-in owners), `upsert_customer_preference` (consent-gated; single-value categories superseded), `forget_customer_memory` (per-call user approval, hard delete). Contact details rejected as memory. Withdrawing consent deletes memories and summary vectors.
- Tool authorization model: read tools run freely; write tools are gated by either a standing consent (memory saves) or an argument-bound, single-use approval (deletions, future CRM writes).
- Conversation summarization (`ContextManager`): above `CONTEXT_MAX_TOKENS` older turns become a rolling summary with topic state (active topic, off-topic thread open, travel intent, open questions) in the system prompt; recent turns stay verbatim and storage stays append-only. Summarizer failure falls back to the full transcript.
- CLI: `/memory`, `/memory on|off`, `/forget`, and consent/approval prompts after each turn.
- Tests (15 new): no-consent refusal, later-session recall, Arabic lexical recall, correction, contact refusal, forget, withdrawn consent, cross-user isolation, embedding outage, OpenAI adapter shape, end-to-end consent flow through the agent loop, approval-gated deletion, 20-turn summarized conversation, summarizer failure, cross-session summary recall.
- Architect review of M2 (no Critical; 4 High, 11 Medium) applied: Arabic-Indic digits accepted in preferences (H1); summaries moved out of the system prompt into a fenced untrusted-notes message (H2); forget/revoke propagate to conversation summaries and past-conversation recall only returns summaries created after the current consent (H3); compaction falls back to an earlier clean turn start (H4); server-fixed versioned consent text disclosing the embedding processor (M1); declines recorded and respected (M2); save provenance via trace id + CLI echo (M3); dedupe + replacesItemId (M4); item ids + forget by item, strict forget schema (M5); content-free `memory_events` audit (M6); one latest summary per past conversation (M7); conversation TTL extends with activity + safe purge with one-level supersede chains (M8); 2 chars/token estimate (M9); summarizer input cap, failure backoff, unparseable output discarded (M10); consent-guarded insert and consent join on every read (M11); small profiles (≤15) returned whole; `/erase`. A real bug found by the new tests (forget-by-item resurrected replaced history) was fixed.
- Schema follow-up `20261103204353_memory_audit.sql` (memory_events, memory_items.source_trace_id, purge function) — **applied to Supabase 2026-11-03 with user approval** (version 20261103204353; verified RLS on, no API grants, 0 unindexed FKs; `npm run db:check` 14/14).
- Not verified live: OpenAI embeddings and summarization quality with a real model (no keys); the Anthropic history-compaction behavior with thinking blocks (opaque blocks are stripped from pre-summary turns) must be confirmed in the first live run.

### M3 — Worldwide travel discovery
Provider adapter behind `research_external_packages` (search API + allow-listed fetch, SSRF guard, injection-safe parsing, `TravelOfferResult` schema from `contracts/`), offer cache, timeout/429 tests. Needs a provider key you choose.

### M4 — CRM actions
`create_lead`, `create_quote_request`, `request_human_handoff` with server-side approval records, idempotency keys, redacted logs. Approval records (argument-bound, single-use) already exist from M1.5; the tables are in the schema.

### M5 — Voice notes
Upload/record → STT → same agent → optional TTS; size/time limits; transcript correction. Realtime only after this is stable.

### M6 — Web console ✅ implemented (see docs/UI_IMPLEMENTATION_REPORT.md)
Standalone agent workspace (not a website) per `prompts/POST_M4_FRONTEND_ULTIMATE_PROMPT_v1.1.md`: HTTP/SSE adapter over the existing runtime (owner cookie, CSRF guard, rate limits, CSP, cancel), truthful tool activity from trace events, cards rebuilt from stored tool results, history, memory consent, CRM approvals, voice notes, AR/EN, dark/light, reduced motion, CSS/SVG Living Background. Live UI testing found and fixed a catalog multi-destination search bug (Hurghada dropped → model guessed "over budget"). Verified: 167 tests, Playwright 24/24, live Gemini + Supabase check. Remaining: live CRM/Tavily/voice through the UI, code-splitting, FPS profiling, manual screen-reader and 200% zoom checks.

#### Original M6 plan
Small React/Vite chat + voice console (RTL/LTR, DEMO labels, trace drawer), HTTP API, rate limiting, CORS, circuit breaker, Playwright E2E.

### M7 — Evaluation + academic package
Eval runner over `tests/evals/scenarios.jsonl` (expected vs observed tools, latency, tokens/cost), report, diagrams, demo script.

## Subagent use
- `senior-ai-automation-architect`: independent review of the M1 loop and tool contracts (read-only review, findings come back to this session).
- `senior-backend-developer`: M2/M4 schema and Postgres port.
- `frontend-qa`: M6/M7 eval and Playwright runs.
- `senior-frontend-developer` + `senior-ui-ux-designer`: M6 console only.
- `ai-project-manager`, `senior-devops-engineer`: on request (milestone gates, CI/secrets).
- `senior-motion-video-producer` deferred; `senior-game-developer` not used.

## Cost and permission matrix
| Action | Cost | Needs your approval |
|---|---|---|
| Live LLM calls | per-token API billing on your key | adding the key is your action; eval runs will state estimated cost first |
| Travel search provider | provider-specific | yes, provider choice + key |
| Supabase project | free tier possible | yes |
| New npm dependencies | none | yes, asked per milestone |
| Deployments, pushes | — | yes, never automatic |

## Provider decision (2026-11-03, user): free tiers only
- Chain: Gemini `gemini-3.8-flash` → `gemini-3.5-flash-lite` → Groq `openai/gpt-oss-120b`; embeddings `gemini-embedding-001` @1024 (normalized, task types); STT Groq `whisper-large-v3-turbo`. Verified against official docs and the user's own keys via `npm run providers:check` (Llama models were not available on the user's Groq account).
- Gemini adapter replays model parts unchanged (thought signatures); foreign history uses the documented `skip_thought_signature_validator` placeholder on the first function call. Quota-aware 429 handling (per-minute retried, per-day fails fast), client-side RPM/RPD pacing, fallback with cooldowns (daily → Pacific midnight). `FREE_TIER_ONLY=true` refuses paid providers and non-allowlisted models.
- Privacy note shown in the memory consent text: Gemini free-tier content may be used by Google to improve its products.

### M5 — Voice notes ✅ verified live (synthetic + real human recording)
`/voice <file>` in the console: format/size validation (25 MB free-tier limit), Groq Whisper transcription with a domain prompt, low-confidence flag, user confirms or corrects the transcript before it reaches the agent; audio is not stored.
- Live check 2026-11-04 (`npm run voice:check -- --confirm`, free tier, $0): two **synthetic** notes made with Gemini TTS `gemini-3.8-flash-tts` (WAV in `.tmp/voice-samples/`), report in `reports/voice-check-*.json`. 12/13 checks pass: invalid file / missing file rejected with text fallback; Egyptian Arabic note WER 29% ("بسبعة آلاف" → "ب 7000", meaning kept) → `search_company_packages` → 6,500 EGP DEMO price; mixed AR/EN note WER 19% → 7,800 EGP DEMO price.
- **Fixed: guessed amounts.** In the mixed note Whisper wrote "تمنتلاف كني" for "تمانية آلاف جنيه" (not flagged low-confidence) and the agent read the budget as 3,000. Now `runTurn` takes `input: { kind: 'voice_transcript', lowConfidence }` for transcripts the customer accepted unedited (a hand-corrected transcript counts as typed text); the per-turn prompt section then adds a fixed rule (`VOICE_TRANSCRIPT_RULE`): use clear parts, but quote and confirm any garbled amount/date/name instead of guessing. Transcript text never enters the system prompt. Tests: `tests/voice-input.test.ts`. Live rerun (2026-11-04, report `reports/voice-check-2026-11-04T00-42-55-019Z.json`): 13/14 — the agent still searched and quoted 7,800 EGP, then quoted the unclear word "أفغنية" and asked for the exact budget; the remaining failure is Whisper's transcription of the Arabic amount in mixed EN/AR speech (STT limit, WER 19–57% on synthetic audio across runs; the run-to-run variation comes from the TTS audio).
- First run exposed a real agent failure: `gemini-3.5-flash-lite` answered without any tool call, claimed Sharm was not in the catalog and suggested Siwa (not a company program). Fixed structurally with a runtime **grounding guard** (`server/src/agent/grounding.ts`): catalog claims without a successful catalog tool result are re-asked once per turn; covered by `tests/grounding.test.ts`. In the rerun the model called the catalog tool itself.
- **Real human recording verified (2026-11-04)**: the user ran an Egyptian Arabic voice note through `npm run voice:check -- --confirm --file <path>` (report `reports/voice-check-2026-11-04T00-52-05-629Z.json`, `synthetic: false`): 0 failures — invalid/missing file paths rejected with text fallback, Whisper detected Arabic (not flagged low-confidence), the agent completed the turn using `search_company_packages` + `get_package_details`, and the reply quoted the catalog DEMO price (Sharm, 7,800 EGP per person). `gemini-3.8-flash` was at its daily free quota, so the chain fell back to `gemini-3.5-flash-lite`. For a real recording the script has no reference text, so it does not measure WER or key terms.
- **Remaining transcription limits:** Arabic amounts spoken inside mixed EN/AR speech are still often mis-transcribed by Whisper (the agent now confirms such values instead of guessing); WER was only measured on synthetic audio; the CLI transcript confirm/correct step remains the safeguard.
- Not yet built: browser recording (M6), realtime voice.

### M3 — Worldwide travel discovery ✅ verified live
- Verified 2026-11-04: Gemini 3.x "Grounding with Google Search" is **Not available** on the free tier (paid tier only), so it was rejected. Brave now requires a card. User chose **Tavily free** (1,000 credits/month, no card; basic search = 1 credit).
- `research_external_packages`: two structured queries (EN + AR) → Tavily basic search (non-offer domains excluded) → **deterministic** extraction (no LLM): provider = domain, days/nights from text, price kept only when it literally appears with a currency (Latin/Arabic digits) → offers validated against a strict mirror of `contracts/travel-offer-result.schema.json` (status `listed_unverified`, source_type `external_listing`, verified_at null) with evidence (sanitized snippet ≤400 chars, prices found, published date).
- Safety: https-only URLs (no credentials, no other schemes), control/bidi characters stripped, `untrustedContent: true` + presentation rules; no page fetching (no SSRF surface). Failures map to honest statuses (rate_limited, quota_exhausted, timeout, auth_failed, unavailable, provider_not_configured). 6 h result cache; evidence stored in `external_offers_cache` (24 h).

### Live verification (2026-11-03, free tier, $0)
- First run (8 scenarios): 5 completed, 3 timed out. Cause, measured directly: `gemini-3.8-flash` answered 503 "high demand" (sometimes after ~9 s); retries without a per-call budget consumed the 60 s turn deadline before the fallback could run. `gemini-3.5-flash-lite` answered the same request in ~1.5 s with the correct tool call.
- Fixes: 20 s per-call budget in the fallback chain (hang → next model), 1 retry for free-tier calls, 60 s cooldown for overloaded models, 90 s turn deadline; prompt fix for T036 (the model had claimed a consent prompt without calling `request_memory_consent`). Regression test added.
- Rerun of the 4 affected scenarios: all completed and grounded (T009 Hurghada 13,000 within budget / Sharm 15,600 over by 600; T010 asks children's ages, no guessed discount; T016 honest "external search not connected"; T036 calls `request_memory_consent`). 13 runs are traced in Supabase `agent_runs`/`tool_executions` (owners `live-smoke-*`).
- Observed latency: ~6–8 s per model step on flash-lite, mostly the client-side pacing at GEMINI_RPM=8; raise it to the limit shown in AI Studio to go faster.

### M3 live verification (2026-11-03/04)
- One capped live search (`npm run research:check -- --confirm`, hard limit 2 Tavily queries = 2 credits): 8/8 listings contract-valid, https, provider = domain, source pages exist (7× HTTP 200/206, TripAdvisor 403 = blocks bots), every price verbatim in the source with currency, all `listed_unverified`.
- Manual review found what checks missed, then fixed (regression tests on the saved real hits, `tests/fixtures/tavily-turkey-2026-11-03.json`): 3 irrelevant pages (Egypt tours *from* Turkey, Egypt-only tours) → destination relevance + direction filter; combined/multiple prices ("599 دولار + 17,500 جنيه", "$300 … $1215") → no single headline price, all prices with context; flight-fare pages labelled `flight_fare`; "seen 1 day ago" no longer a trip length; price basis detection; per-call model budget now starts after client-side pacing; ≤6 listings, 300-char snippets; Cairo-time retrieval display.
- Replay of the saved real results through the live agent (0 search credits): 5 relevant listings, reply states catalog has no Turkey, labels listings as external and unverified, shows both currencies for the combined price, several prices for ilinktours, "$14 per adult, varies by group size" with context, flights as flights, links + retrieval time; every quoted price backed by a listing. Remaining: occasional model typos on free-tier flash-lite (e.g. "رححال").

### M4 — CRM actions ✅ verified live
- No migration needed (tables from `rahhal_core`). `CrmService`: leads with AES-256-GCM encrypted name/phone/email (`PII_ENCRYPTION_KEY`, server env only), phone validation/normalization (Egyptian local/intl, Arabic digits), content-hash idempotency keys (owner-scoped unique), quote requests linked to the owner's lead (package must exist), human-handoff requests (24 h dedupe); masked customer view, deletion with consent withdrawal, staff view (masked unless --reveal).
- Tools `create_lead`, `create_quote_request`, `request_human_handoff`: write tools behind argument-bound single-use approval; the customer sees a masked preview (also what is stored in `approvals`); approval of the exact action is recorded as consent (`lead_creation` / `human_handoff`). New runtime guarantees: write arguments are schema-validated and pre-checked BEFORE any approval is requested; an identical existing record is returned as `already_exists` with no new approval (T042). Results instruct the agent to say it is a demo CRM: no real callback, booking, payment or messaging.
- Tests (8 new): phone normalization/masking, encryption round trip + tamper/wrong-key, encrypted at rest + consent + idempotency + cross-owner isolation, quotes, not-configured refusal, deletion/erase cascade, T040/T041/T042 end-to-end through the agent loop, invalid phone rejected before approval.

### M4 live verification (2026-11-04)
- `npm run crm:check -- --confirm`: the script plays the customer (placeholder phone), approves each prompt, verifies, then erases its data. Final run 19/19: masked approval previews, one lead + one linked quote (pkg-fayoum-001), contact fields `enc:v1` at rest, consent + approval evidence on both rows, masked customer/staff views, references given (RL-…/RQ-…), demo honesty (no booking/payment/callback), traces without contact data, repeat request → existing quote, no approval, no duplicate; Supabase confirmed empty afterwards.
- Found live, fixed, regression-tested: idempotency keys hashed model-written text, so a reworded "same quote again" (and "ديسمبر" vs "December") looked new. Now lead = owner + normalized phone; quote = lead + package (or destination for custom trips). Earlier runs: a script bug skipped the repeat turn (run 1), a failed edit re-ran the unchanged script (run 2), run 3 exposed the paraphrase gap.
- Minor: the agent once said data can be managed "from the account options" (it is `/leads`). gemini-3.8-flash daily free quota was exhausted during these runs; flash-lite served all turns.
