# RAHHAL AI — M6 Web Console: UI Implementation Report

> Superseded visually on 2026-11-04 by the MASAR AI transformation (brand, 3D orb, living background, glass UI): see [MASAR_TRANSFORMATION_REPORT.md](MASAR_TRANSFORMATION_REPORT.md). The 90 s deadline discussed below is now 150 s by default.

Date: 2026-11-04. Scope: the standalone **agent console** in `client/` plus a minimal HTTP/SSE adapter in `server/src/web/` over the existing M1–M5 runtime. It is not a tourism website: there is no landing page, hero, destination gallery or booking storefront.

## 1. What was built

| Area | Implementation | Backed by |
|---|---|---|
| Server adapter | `server/src/web/` on Node `http` (no framework). Signed per-browser owner cookie (HMAC, HttpOnly, SameSite=Strict); CSRF guard (custom header + Origin = Host); JSON body limit; rate limits per browser and global (free-tier protection); CSP and security headers; static serving with traversal protection | Same `AgentRuntime`, tools, Supabase repositories, approvals, consent and CRM as the CLI. No agent logic in the browser |
| Turn transport | `POST /api/conversations/:id/turns` → **SSE**: `ack`, `model_call`, `tool_started`, `tool_finished`, `grounding_check`, `final`, `error`. `POST /api/turns/:traceId/cancel` for Stop | `TraceRecorder` events (new `tool_started`); caller-supplied trace id; new `signal` → status `canceled` with a consistent transcript |
| Transcript view | `views.ts` rebuilds messages, tool activity and cards from the **stored** transcript. Reloads never re-run tools. Drafts held back by the grounding guard are never shown | Stored `tool_result` JSON only |
| Cards | Company package (DEMO badge, DB price + basis, party total, inclusions/exclusions), external listing (provider, "External · Availability not verified", single price only if the source states exactly one, otherwise "Several prices", flight-only label, retrieval time in Cairo, https source link), comparison (no cross-currency claims), research notice, CRM record (reference, "demo CRM, no booking") | catalog / research / CRM tool results |
| Agent activity | Inline live steps and a collapsed "Used N tools" summary; context panel with the activity list and an optional trace id. Waiting-for-approval is shown as pending, not failed | Real SSE tool events only. No timers, no fake progress |
| Journey context | Search criteria (destination, days, budget, party) taken from the agent's own read-only search calls, labelled "From the agent's latest search" | Whitelisted read-tool inputs (write-tool inputs, which can hold PII, are never exposed) |
| History | List grouped Today/Yesterday/Earlier, search, resume, delete with confirmation (removes messages, summaries, approvals and traces; memory and CRM have their own controls) | `ConversationStore.list/delete` (owner-scoped) |
| Memory | Consent dialog with **server-fixed** wording (now points to the Memory panel), grant/decline recorded server-side, preference list shown only while consent is active, forget item, erase all, turn off and delete | `ConsentStore`, `MemoryService` |
| CRM approvals | Approval card with a server-masked preview; Approve/Decline sent once (409 if already decided); after approval the client sends a visible "Approved. Please go ahead." turn so the model retries with the same arguments (single-use approval). "My requests" panel with delete all | `ApprovalStore.pending/decide`, `CrmService` |
| Voice notes | Record (MediaRecorder + AnalyserNode: the meter and background glow follow **real** microphone level) or upload, then server transcription (Groq Whisper), then an editable transcript, then send. Unedited transcripts are sent as `voice_transcript`, so the M5 rule to confirm unclear amounts applies. Errors: permission denied, no mic, unsupported format, too large, offline, voice unavailable | `POST /api/voice/transcribe` → existing `GroqWhisper` |
| Settings | Arabic/English (RTL/LTR, Tajawal/Inter self-hosted), dark/light (contrast-verified tokens), reduce motion (respects the OS setting; a user override can only make it stricter); persisted in localStorage (convenience only) | — |
| Living background | CSS/SVG "Living Travel Intelligence": static canvas and grain, 3 radial glows that animate transform only (no animated blur), static route lines, damped pointer parallax (desktop, explore preset), presets `calm` / `explore` / `focus`. States: thinking = halo on the assistant mark only; searching = one route arc **only during a real tool event**; listening = glow scales with real mic amplitude; error = static coral. Paused when the tab is hidden; static under reduced motion | Agent visual state from SSE and recorder state |

**Facebook Reel reference:** it was **not inspected** (not accessible here). The background is an original interpretation of section 18 of the brand doc, not a copy of the Reel.

## 2. Agent issues found and fixed during live UI testing (M1–M5 code)

1. **Catalog search dropped a destination.** Live, "الغردقة أو شرم … 8000" returned only Sharm; the model then claimed Hurghada was over budget (it is 6,500 EGP).
   - Root cause: the repository kept only the rows matching the most query tokens.
   - Fix: it now also keeps rows matching tokens the best rows don't cover. A regression test was added. The system prompt also says to look up a missing destination rather than guess.
   - Verified live afterwards: both packages were returned with their DB prices.
2. **Brand voice.** The reply mentioned the graduation project unprompted, used "حبايبي" and said "إجمالي الحجز". The prompt now forbids pet names and unprompted project mentions, and asks for "الإجمالي".
3. **Stop race.** Aborting the stream reloaded the transcript before the server had stored the canceled turn. A server-side cancel endpoint now keeps the stream open until the real `final` event.

## 3. Independent QA review (`frontend-qa` subagent, read-only)

The review found no Critical issues. It confirmed:
- no `dangerouslySetInnerHTML`, and links are http(s) only;
- the CSRF guard and cookie handling are correct;
- static serving is protected against path traversal;
- no secrets in the client;
- activity is truthful (server events only).

**Fixed after the review**
- **High:**
  - **Refetch storm:** the settings object changed on every render, so the memory and CRM panels refetched constantly. The object is now memoised, and out-of-order responses are ignored.
  - **Screen readers:** assistant answers were never announced; they are now, through a polite live region (covered by E2E).
  - **Abort race:** a late reload could show the wrong conversation; results are now guarded by conversation id.
  - **Dialogs:** they now scroll at 200% zoom and in landscape.
- **Medium:**
  - The Stop button is focused when recording starts, and recording status is announced.
  - A dropped stream says "check the conversation, it may have been saved" and reloads, instead of a false "Not sent".
  - Server status is re-checked every 30 s.
  - The customer's own new message always scrolls into view.
  - Inputs use 16px text, so iOS doesn't zoom on focus.
  - Links show the real host when their label differs, and bare URLs are isolated LTR.
  - Provider names wrap instead of being cut.
  - Copy, retry and delete actions stay visible on touch devices.
  - Error messages are localized by error code.
- **Low:**
  - Parallax now restarts correctly.
  - Removed an ineffective hidden-tab pause.
  - Unmounting the recorder discards the recording instead of uploading it.
  - Microphone tracks are stopped if `MediaRecorder` or `AudioContext` fails.
  - Double-submit guard.
  - A malformed static URL returns 404 instead of 500.
- **Exposed by the fix:** the memory panel had only refreshed by accident during the storm. It now refreshes explicitly after each server-confirmed consent decision.

**Open (documented, not yet done)**
- The recorder level meter re-renders the app at about 15 fps while recording.
- A flash of the default theme or language on first paint (CSP forbids an inline pre-paint script).
- `x-forwarded-proto` is trusted, and there is no Host allowlist. This matters only if the server is exposed beyond localhost; it binds 127.0.0.1 by default.
- Bundle code-splitting (`LazyMotion`).
- `@radix-ui/react-tooltip` is installed but unused.
- iOS keyboard overlap needs a real device.

## 4. Verification evidence

| Check | Result |
|---|---|
| `npm run typecheck`, `npm run typecheck:client` (strict, incl. e2e) | pass |
| `npm test` (node:test, PGlite with the real migrations) | **167/167 pass** (re-run after the QA fixes): incl. 13 web API tests (owner isolation, CSRF, tampered cookie, SSE order, cards = DB prices, reload without re-running tools, hidden grounding drafts, approval single-use + owner scope + pending state, memory consent, delete, voice formats, rate limit, static traversal, Stop over HTTP) and Markdown safety tests |
| `npm run e2e` (Playwright, Chromium, desktop 1440×900 + Pixel 7) | **24/24 pass** (re-run after the QA fixes): empty state, AR/EN + theme persistence, catalog cards + journey + resume, external listings (recorded real Tavily data), CRM approval flow, consent dialog, Stop, voice note with a fake mic → transcript review → send, delete with confirmation, reduced motion (no infinite animations running), background never intercepts input, accessibility basics (named buttons, landmarks, no horizontal scroll, keyboard send) |
| Screenshots | `reports/ui-screenshots/` (14 files, desktop + mobile) |
| Secret scan of `client/dist` | no env names, keys or connection strings |
| **Live** (real Gemini free tier + Supabase, `npm run web`, built-in browser) | Status/connected, Arabic RTL + dark mode, "إيه برامج الشركة المتاحة؟" → `list_company_destinations` → 4 catalog destinations. Budget question → found and fixed the search bug above; re-run → 2 catalog searches streamed live → Hurghada 6,500 and Sharm 7,800 DEMO cards, party totals 13,000 / 15,600, journey panel filled from the real search |

E2E uses a **test-only** server (`client/e2e/e2e-server.ts`): the real HTTP layer, runtime, tools and SQL, with a scripted LLM, the recorded real Tavily fixture (0 credits) and a fake STT. It proves the UI and contract behavior, not model quality.

### Live UI check script (Tavily, memory, CRM, voice)

`client/e2e-live/live-ui.spec.ts` with `client/playwright.live.config.ts` runs against a running `npm run web`. Each run writes a report to `reports/ui-live-check-*.json` and saves screenshots as `reports/ui-screenshots/live-*.png`.
- **Steps:** a Tavily search (about 2 credits), memory consent, save, then forget; CRM approve and reference; a Groq voice note (it uploads `.tmp/voice-samples/T043_eg_arabic.wav`).
- **Data:** a fake name and phone.
- **Cleanup:** it always deletes the CRM records, memory consent and conversations it created.
- **Fail-fast:** if the first live turn returns the provider-unavailable fallback, the run is recorded as BLOCKED instead of hanging.

Findings from running it (2026-11-04):
1. **Real bug, fixed: new visitors' first turn failed.** A fresh browser's parallel startup requests each received a different anonymous owner, and the last `Set-Cookie` won. The trace showed `POST /api/conversations → 201` and then `POST …/turns → 404`.
   - Fix: only `GET /api/status` issues an owner; other routes without a session return `401 SESSION_REQUIRED`.
   - The client bootstraps one session per page and re-bootstraps once (shared) after a server restart.
   - A regression test was added.
   - Afterwards the live run showed the correct server response for the first turn.
2. **Environment:** the server process started by the Claude desktop preview launcher got network errors for every provider. The same server started from a normal shell reached them. For live checks, run `npm run web` in a normal terminal.
3. **Free-tier capacity (external):** with network access, the blocking reasons were:
   - `gemini-3.8-flash`: 503 (overloaded);
   - `gemini-3.5-flash-lite`: 503, or no answer within the 20 s per-call budget;
   - Groq `gpt-oss-120b`: 429 on the per-minute quota.

   The agent prompt is about 5.3k tokens (14 tool schemas), so multi-step turns do not fit Groq's free per-minute token budget. The UI showed the honest fallback ("temporary problem reaching the AI service"), and nothing was invented.
4. The web server now logs provider fallback reasons (provider, model and reason only).
5. **Per-call budgets fixed.** Measured: `gemini-3.5-flash-lite` needs about 21 s for the full agent prompt, so the 20 s budget abandoned it just before it answered.
   - The primary model now gets 20 s (`PROVIDER_PRIMARY_TIMEOUT_MS`) and each fallback 40 s (`PROVIDER_CALL_TIMEOUT_MS`).
   - A regression test was added.
6. **Turn deadline.** At today's Gemini latency a research turn needs 4 model calls of 20–30 s each (about 100 s). That does not fit the default 90 s `AGENT_TIMEOUT_MS`.
   - The live research and voice runs used `AGENT_TIMEOUT_MS=180000` as a process override (`.env` unchanged).
   - Recommendation for demos on the free tier: set `AGENT_TIMEOUT_MS=150000` to `180000`. The UI streams every tool step, so long turns stay visibly in progress.
7. **Markdown fix.** Numbered items separated by blank lines rendered as "1., 1., 1."; ordered lists now keep their numbers (test added).

### Live results through the UI (2026-11-04, real Gemini free tier + Supabase + Tavily + Groq)

| Step | Result | Evidence |
|---|---|---|
| Worldwide research (Tavily) | ✅ The agent checked the catalog (no Turkey program), then searched the web → **6 external listing cards** from real Tavily results. All https, each with provider and retrieval time in Cairo, labelled "External · Availability not verified". The Sources panel lists 6 hosts; Journey context shows Turkey, 7 days, December 2026, Cairo, 1 traveler. | `reports/ui-screenshots/live-research.png`, `reports/ui-live-check-2026-11-04T17-1*.json` |
| Memory | ✅ The consent dialog shows the server wording, including the Gemini free-tier disclosure. After Allow, a preference was saved ("يفضل رحلات الشاطئ والبحر"), shown in the Memory panel, then forgotten. | `live-consent.png`, `live-memory-saved.png` |
| CRM | ✅ The approval card shows a masked preview (the phone is not shown). Two approvals → lead **RL-DFE66C05** and quote request **RQ-7B92883E** saved in Supabase, listed under "My requests", then deleted. | `live-crm-approval.png`, `live-crm-saved.png` |
| Voice note (Groq Whisper) | ✅ The uploaded WAV was transcribed ("أعيز الغردقة ب 7000 جنيه…"), reviewed, then sent. The agent searched the catalog, showed the Hurghada card at **6,500 EGP**, noted 7,000 EGP covers one person, and asked to confirm dates. | `live-voice-review.png`, `live-voice-answer.png` |
| Cleanup | ✅ Verified read-only in Supabase afterwards: 0 test conversations, leads, quotes, memory items or active web consents. Two conversations left by an earlier run were removed with the app's owner-scoped delete; the script now verifies cleanup through the API. | — |

**Model-quality observations** (`gemini-3.5-flash-lite` serving; `gemini-3.8-flash` was overloaded):
- It answered an English question in Arabic.
- It did not call `request_memory_consent` by itself; the customer opted in from the panel.
- It made one unnecessary `get_system_status` call.
- In the CRM run it hit the 90 s deadline after the records were already saved. The UI showed the records, confirmed by the server, and the honest timeout message.

These are recorded for M7 evaluation, not hidden.

## 5. Status

**COMPLETE**
- Real text chat over SSE with truthful tool activity.
- Company package cards with DB prices and DEMO labels.
- External listing cards (**verified live**: 6 real Tavily listings).
- History: create, resume, search, delete.
- Memory consent and controls (**verified live**: save, show, forget).
- CRM approval flow (**verified live**: lead and quote in Supabase, then deleted).
- Voice notes (**verified live**: Groq Whisper → review → agent turn).
- Settings: language, theme, reduced motion.
- Living background with real-state reactivity.
- Responsive desktop, tablet and mobile.

**PARTIAL / not verified live through the UI**
- Live turns on the free tier currently take about 30–100 s, and research turns need a longer `AGENT_TIMEOUT_MS` than the 90 s default (see findings 5–6).
- Browser microphone recording was tested with Chromium's fake device (E2E), not a real microphone. The live voice check used file upload.
- No token streaming: the backend returns whole answers, so only message entrance is animated, honestly.
- Bundle is about 201 KB gzipped JS, not yet code-split.
- No measured FPS/battery profile on integrated GPU or mobile hardware.
- 200% zoom and a screen reader were not tested manually.

**BLOCKED / not in scope**
- Realtime voice (second stage).
- TTS replies.
- Accounts/login: the owner identity is an anonymous signed per-browser cookie. Set `WEB_SESSION_SECRET` so sessions survive restarts.

## 6. Run on Windows

```bash
npm run build:client
npm run web            # → http://127.0.0.1:8787 (serves the built console + API)
# development with hot reload: npm run web  +  npm run dev:client → http://127.0.0.1:5173
npm run e2e            # deterministic browser tests (no paid/live calls)
```

**Free-tier impact of this milestone:**
- About 8 Gemini free-tier model calls for the live UI checks.
- 0 Tavily credits.
- 0 Groq calls.
- No paid services.
- Test conversations created in Supabase under anonymous web owners contain no personal data and expire with the 30-day retention.
