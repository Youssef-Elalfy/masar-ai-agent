# Milestones, Exit Criteria, and Developer Hand-off

## M0 — Audit and plan
Read all docs and prompts, inspect toolchain, nine user-installed Claude subagents, installed skills/MCP, model/API availability; report missing credentials without printing them. Verify SDK versions/current docs. Write `IMPLEMENTATION_PLAN.md` with cost/permission matrix.
**Exit:** precise dependencies, folder plan, hazards, plan approved/usable.

## M1 — Core demonstrable agent
TypeScript server + real LLM tool loop + typed `search_company_packages`, `get_package_details`, `compare_company_packages`, `check_company_departures` backed by DB/seed. Genuine tool logs/trace. Basic CLI or minimal local text UI. No flowchart-only simulation.
**Exit:** repeatable tests show actual tool selection, multiple steps, grounded prices, no fake inventory.

## M2 — Customer memory + consent
Persistent SQL sessions/summaries, opt-in long term memory, scoped retrieval, correction/deletion, tests for isolation across users. **Exit:** multi-session remember/update/forget tests pass.

## M3 — Worldwide travel discovery
Real licensed/safe external provider/web search, trusted URL attribution, recency and status classification, parsing with validation; fallback honest when provider unavailable. **Exit:** country queries beyond company DB return sourced listings or explicit lack of verified offers, never invented availability.

## M4 — CRM actions + handoff
Lead and quote-request creation after consent, idempotency and redacted logs. **Exit:** DB record correctly created, no write without consent.

## M5 — Voice
Voice notes STT and optional TTS, transcript correction, speaker handling in Egyptian Arabic; optional verified live voice; expose state/errors accurately. **Exit:** 8+ test voice samples or equivalent manual evidence, tool use shared with text.

## M6 — UX and hardening
Standalone chat/voice console (NOT travel website), AR RTL/EN LTR, accessibility, tests, privacy, rate-limit, failure handling, cost metrics, docs and demo video if user separately requests. **Exit:** usable by instructor without code editing and no unconnected features labeled live.

## M7 — Academic presentation package
System + behavior analysis diagrams, objective eval report, seeded demo and global research demonstration, known limitations. **Exit:** can reproduce 5 core tasks on demand.

## Minimum acceptance suite
1. At least 4 demo packages seeded, and create a fifth package without code/prompt edits.
2. Query all, compare under budget, clarify per person; exact prices from DB.
3. Company-vs-external routing for Turkey, Japan, any country; attributed sources or honest unavailability.
4. A tool used in actual execution, repeatable trace with return payload and result.
5. 10+ turn off-topic conversation without upselling until natural end.
6. Insult, slang, ambiguity, mid-conversation correction handled gracefully.
7. Persistence, memory consent + update + deletion, cross-user isolation.
8. Create quote request after consent, no duplicate under retries.
9. STT voice note returns accurate meaning; voice failure doesn't break text.
10. No false booking confirmation or real-time inventory, no leaked API keys.
11. Export evaluation report includes pass/fail, trace ID, tool selection, evidence correctness, response quality and latency.

## Report measurements
- Grounded answer accuracy: correct price/days/inclusions over labeled evaluation set.
- Tool selection recall/precision by task type; unintended tool calls.
- External offer evidence coverage and exactness, broken link rate, source freshness.
- Memory retrieval exactness, cross-user leakage 0, deletion behavior.
- Off-topic user completion (no premature tourism redirection), politeness/repair effectiveness.
- P50/P95 latency, estimated USD cost per run and success rate.
- Avoid promising artificial performance percentages before measurements.
