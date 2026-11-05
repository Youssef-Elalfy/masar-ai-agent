# مَسَارٌ | MASAR AI: Final Security, Engineering QA and Release-Readiness Audit

**Date:** 2026-11-05.

**Scope:** the full repository (server, agent runtime and tools, web client, Supabase project, tests, reports, build output).

**Method:** read-only inspection first, then small localized fixes with regression tests.

**Out of scope:** no deployment, no repository created or pushed, no credentials rotated, no live model/search quota spent, and no Supabase data changed.

## 1. Executive summary

MASAR AI is in good shape for a portfolio release.

- **Code base:** no secret values were found in any source file, build output, log or report. Dependencies have 0 known vulnerabilities.
- **Database:** Supabase is locked to deny-all for the public API roles (RLS on every table, no grants to `anon`/`authenticated`).
- **Isolation:** owner isolation, approval binding, consent enforcement, untrusted-content handling, XSS-safe Markdown and redaction were already covered by tests.

**Defects found and fixed in this audit, each with a regression test:**

- 2 Medium: DNS-rebinding exposure of the local server; a database-pool error that could crash the server.
- 1 Medium release-hygiene gap: `.gitignore`.
- 2 Low items: a Content-Security-Policy violation report, and an unused dependency.

**One High item remains open and needs the owner:** credentials the owner reports were visible in earlier screenshots must be rotated before publication. Medium and Low recommendations are listed in §2.

**Recommendation: READY WITH CONDITIONS** (see §15).

## 2. Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| H1 | **High** | Credentials possibly exposed in earlier screenshots, as reported by the owner. Screenshots can't be scanned for text, so all live credentials are treated as exposed. | **Open — owner action** (§8) |
| M1 | Medium | **DNS rebinding.** The web server checked `Origin == Host` but had no allowlist of host names. A hostile site whose domain re-resolves to 127.0.0.1 passes that check (its Origin equals its own Host). It could then obtain an anonymous session and drive the local agent, spending the owner's API quota and writing demo CRM/memory rows under its own owner. Other owners' data was never readable (owner scoping held). | **Fixed** |
| M2 | Medium | **Server crash on a dropped database connection.** The `pg.Pool` had no `error` listener. When the network or the Supabase pooler drops an idle connection, node-postgres emits `error` on the pool, and with no listener Node exits the process. In addition, a transaction whose rollback failed returned the broken client to the pool. | **Fixed** |
| M3 | Medium | **Defence in depth.** The server connects with the privileged `postgres` role, which bypasses RLS. Owner isolation is enforced only in application SQL (tested), not by the database. | **Open — recommendation** (needs a credential/role change, so owner approval) |
| M4 | Medium | **Release hygiene.** `.gitignore` did not exclude `reports/` (82 MB of screenshots, recordings, Playwright traces, live-check logs), `.impeccable/` (contains absolute local paths) or `.claude/`. | **Fixed** |
| L1 | Low | The strict CSP reported a violation on every load: Zod 4's `new Function("")` eval-support probe. It is caught, so there's no functional impact, but it adds noise to CSP monitoring. | **Fixed** |
| L2 | Low | The session cookie is a stateless HMAC: there is no server-side expiry or revocation (the browser keeps it 30 days). Rotating `WEB_SESSION_SECRET` invalidates every session. | Open — accepted for an anonymous demo |
| L3 | Low | `style-src 'unsafe-inline'` is required by Motion's inline transforms. There are no inline scripts, `script-src 'self'` holds, and there is no `unsafe-eval`. | Accepted |
| L4 | Low | No HSTS header. The cookie gets `Secure` only when `x-forwarded-proto: https` is present. This is relevant only when deployed behind HTTPS. | Open — deployment note |
| L5 | Low | The per-browser rate limit (8 turns/min) can be sidestepped by minting new anonymous owners. The global cap (30 turns/min) still bounds quota use. | Accepted |
| L6 | Low | Unused dependency `@radix-ui/react-tooltip`. | **Fixed** (removed) |
| L7 | Low | Unexpected server errors return a generic 500 (good: no leakage) but are not logged server-side, which makes diagnosis harder. | Open — recommendation |
| L8 | Low | Anonymous owner rows have no retention job. Conversation deletion keeps the owner identity and consent audit trail by design. The 11 test-owner rows are kept, per the owner's decision, and were not touched. | Open — recommendation |
| L9 | Low | The developer CLI `npm run research:check` (manual, behind `--confirm`) fetches search-result URLs and follows redirects. The web server and agent runtime never fetch arbitrary URLs (no SSRF surface). | Accepted (developer tool only) |
| I1 | Info | The Supabase advisor flags `rls_enabled_no_policy` on all 17 tables. This is intentional deny-all for the public API roles; the app uses the database connection, not PostgREST. | Intentional |

## 3. Evidence per finding

- **H1:**
  - `scripts/secret-scan.mjs` (new) reads `.env` in memory and searches all 231 text files for those exact values, plus generic formats: Google/Gemini, Groq and Tavily keys, JWTs, Supabase secrets, DB URLs with passwords, private keys.
  - Result: *no secret values or credential patterns found outside .env* (variable names only, never values).
  - The built bundle `client/dist` was included in the scan; source maps are disabled (`sourcemap: false`) and none exist.
  - Images and recordings cannot be text-scanned, hence H1.
- **M1:** reproduced in `tests/web.test.ts`, "DNS-rebinding guard". The test sends raw HTTP requests with `Host: evil.example:<port>`:
  - `GET /api/status`, `POST /api/conversations` (with matching Origin) and `GET /` are now refused with **421**, with no session cookie issued.
  - `127.0.0.1`, `localhost` and `LOCALHOST` still get 200.
  - Live server check after the fix: `127.0.0.1` → 200, `localhost` → 200, `evil.example` → **421**.
- **M2:** `tests/pg-pool.test.ts` emits an `ECONNRESET` pool error. It does not throw; it logs the error code only, never the connection string.
- **M3:** read-only SQL. The MCP connection role is `postgres`, all 17 public tables have RLS with 0 policies, and there are 0 grants to `anon`/`authenticated`.
- **M4:** `.gitignore` before/after. `.impeccable/hook.cache.json` was the only publishable file containing a local absolute path.
- **L1:** `client/e2e/security.spec.ts` "strict CSP holds" fails without the fix (`script-src eval`) and passes with it (`client/src/zod-config.ts`, imported first in `main.tsx`).

## 4. Changes implemented

| File | Change |
|---|---|
| `server/src/web/server.ts` | Host-name allowlist (default loopback, any port; 421 otherwise). `LOOPBACK_HOSTNAMES`, `hostnameOf`. |
| `server/src/web/main.ts`, `.env.example` | Allowlist = loopback + bind host (if it is a name) + `WEB_ALLOWED_HOSTS` (new, documented placeholder). |
| `server/src/db/pg-sql.ts` | `createPool` with a pool `error` listener (code-only log); destroy a client whose rollback failed. |
| `client/src/zod-config.ts`, `client/src/main.tsx` | Zod jitless mode, imported first: no CSP violation. |
| `package.json` | Removed unused `@radix-ui/react-tooltip`. |
| `.gitignore` | Exclude `reports/`, `test-results/`, `playwright-report/`, `.impeccable/`, `.claude/`, `.tmp/`, recordings. |
| `README.md` | Current status updated; link to this report. |
| `scripts/secret-scan.mjs` | Reusable secret scanner (names and paths only). |
| `client/e2e-live/qa/orb-lifecycle.mjs` | WebGL lifecycle probe. |
| `tests/web.test.ts`, `tests/pg-pool.test.ts`, `client/e2e/security.spec.ts` | New regression tests. |

## 5. Tests executed (2026-11-05)

| Check | Command | Result |
|---|---|---|
| TypeScript (server, client, E2E) | `npm run check` | **Pass** |
| Unit + integration | `npm test` (inside check) | **191 passed, 0 failed, 0 skipped** |
| Production build | `npm run build:client` | **Pass** (main 652 kB / 207 kB gzip; lazy orb chunk 546 kB / 137 kB gzip) |
| Playwright E2E (desktop + Pixel 7) | `npm run e2e` | **62 passed, 0 failed, 10 skipped** (by design: desktop-only sweeps/header checks on mobile, mobile-only rotation/keyboard checks on desktop) |
| Dependency audit | `npm audit` | **0 vulnerabilities** (all severities) |
| Secret scan | `node scripts/secret-scan.mjs` | **Clean** (231 files; 6 secret-like env values checked) |
| Browser security | `client/e2e/security.spec.ts` | No CSP violations (load, chat, links); headers present; no inline scripts; external links http(s) only with `noopener`/`noreferrer` |
| Supabase security advisors | MCP `get_advisors` | INFO only (`rls_enabled_no_policy`, intentional) |
| Migrations | MCP `list_migrations` vs `supabase/migrations` | Identical (3/3) |
| Live host guard | curl against :8787 | 200 / 200 / **421** |
| Live model / Tavily / Groq | — | **Not run** (not needed for this audit; no quota spent) |

## 6. Dependency audit

- `npm audit`: 0 vulnerabilities.
- Available updates are patch or minor only, none security-related: `lucide-react` 1.67→1.68, `motion` 14.9.0→14.9.1, `@types/node` 24→26 (dev, major; not applied).
- No major upgrades were made.
- Removed the one unused runtime dependency.

## 7. Agent and backend security review (existing coverage, verified by the suite)

| Property | How it is enforced | Test evidence |
|---|---|---|
| Write tools need consent | Approval bound to the exact argument hash, single-use, owner-scoped, 15 min expiry | "H6: write tools need a user approval bound to the exact arguments, and it is single-use"; "approval for one set of arguments does not authorize different arguments" |
| Memory privacy | Opt-in consent (server-fixed, versioned wording), saves guarded in SQL after revocation, contact data refused as memory, recall owner- and consent-scoped | T036, M11, T047 cross-user isolation, "withdrawn consent erases memories" |
| CRM privacy | AES-256-GCM contact fields with tamper/wrong-key detection, masked approval previews, idempotent | "field encryption…", T040–T042 |
| Untrusted web content | Tavily snippets sanitized (control/bidi characters stripped, length capped) and labelled as external, unverified listings; prices only when literally present with a currency | "untrusted snippets are sanitized", T016/T024, price-extraction tests |
| No invented catalog facts | Grounding guard re-asks once when a catalog claim has no lookup in context | `tests/grounding.test.ts` (from a live hallucination) |
| No invented bookings or availability | Prompt rules plus tool contracts: `listed_unverified`, no booking or payment tools exist | research and CRM tests; style guard |
| XSS | Markdown rendered as React elements (no HTML injection), http(s) links only, `noopener noreferrer` | `tests/client-markdown.test.ts`, E2E security spec |
| Owner isolation | Signed cookie; every query scoped by owner; one indistinguishable 404 | "owners are isolated…", "conversations are isolated per owner…" |
| CSRF | Custom header (forces preflight), Origin check, `SameSite=Strict`; host allowlist now added | "state-changing requests need the client header…", "DNS-rebinding guard…" |
| Logs | Trace inputs redacted (Egyptian mobiles in both digit forms, intl numbers, emails, IDs); write-tool inputs stored as key names + hash | redaction tests |
| Limits | 32 KB JSON bodies, 25 MB audio, rate limits per owner, global and voice, bounded turn deadline, tool timeouts, cancellation | web and runtime tests |
| SQL injection | Parameterized queries throughout (`$1…`); no string-built SQL with input | code review |

## 8. Secret exposure and rotation checklist (owner action; variable names only)

Rotate in this order, then update `.env` locally (never commit it) and restart `npm run web`:

1. **`DATABASE_URL`**: reset the database password (Supabase dashboard → Project Settings → Database → Reset database password), then paste the new Session-pooler connection string.
2. **`GEMINI_API_KEY`**: Google AI Studio → API keys → delete the old key, create a new one (free tier).
3. **`GROQ_API_KEY`**: Groq console → API Keys → revoke and create.
4. **`TAVILY_API_KEY`**: Tavily dashboard → API keys → regenerate.
5. **`WEB_SESSION_SECRET`**: generate a new random value of at least 32 characters. All browser sessions reset (expected).
6. **`PII_ENCRYPTION_KEY`**: generate a new 32-byte base64 key. Safe now because there are 0 lead rows; with stored leads, rotating would make their contact fields undecryptable.
7. If set in your `.env`: **`SUPABASE_SERVICE_ROLE_KEY`** / **`SUPABASE_ANON_KEY`** (Supabase → API keys → roll), and any unused keys listed in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TRAVEL_SEARCH_API_KEY`, `AMADEUS_CLIENT_SECRET`): revoke if they ever held real values.

After rotating, re-run `node scripts/secret-scan.mjs` and delete any screenshots that showed keys.

## 9. Supabase and privacy assessment

- **RLS:** enabled on all 17 public tables, with 0 policies and 0 grants to `anon`/`authenticated`, so the publishable API key cannot read or write anything.
- **Functions:** 0 `SECURITY DEFINER` functions.
- **Migrations:** consistent with the repository.
- **Data in place:**

  | Table | Rows |
  |---|---|
  | conversations | 23 (earlier CLI/eval history) |
  | leads | 0 |
  | quote requests | 0 |
  | memory items | 0 |
  | customers (incl. kept test owners) | 22+ |

  Every conversation deleted during testing was verified gone, with no orphans.
- **Retention:**
  - conversations expire after 30 days (`expires_at`);
  - summaries after 90 days;
  - approvals after 15 minutes;
  - no job yet enforces deletion of expired rows or anonymous owners (L8).
- **Recommendation (M3):** create a dedicated database role for the app with `select/insert/update/delete` on the app tables only (no DDL, no `postgres` superuser) and use it in `DATABASE_URL`. Owner approval is needed (credential and role change).

## 10. Frontend and accessibility

**Verified by E2E:**

- landmarks and named controls; keyboard send;
- focus-trapped Radix dialogs and drawers, now correctly fixed on screen (Round 5);
- polite live region for answers;
- reduced motion: no infinite animations;
- RTL/LTR composer and lists;
- no horizontal overflow across 18 sampled sizes;
- a 200% zoom equivalent;
- mobile rotation and on-screen keyboard;
- strict CSP.

**Contrast:** text-role tokens were checked at ≥ 4.5:1 in M6; the MASAR glass surfaces keep text panels ≥ 72% opaque.

**Not verified:** a real screen reader (NVDA/VoiceOver), the browser's real zoom control, iOS Safari on a device, Firefox/Safari rendering of container queries and the glass shader.

## 11. Three.js and performance

| Aspect | Result |
|---|---|
| Lifecycle | `orb-lifecycle.mjs`: 24 mount/unmount cycles of the WebGL orb (more than Chrome's 16-context limit) produced **no "too many WebGL contexts" warnings and no context loss**; the orb ended at full quality |
| JS heap | 9.0 → 10.5 MB after forced GC (samples 9.9 / 13.3 / 13.5 / 13.5 MB mid-run); no growth trend |
| Disposal | Geometries, materials and the renderer are disposed on unmount; context loss falls back to the CSS orb (E2E-tested) |
| Frame rate (Round 2, Intel UHD 630) | The orb alone holds 60 fps in every state and tier at 600 px; in-app 52–60 fps, the same range as the no-WebGL CSS orb |

**Not measured:** GPU memory directly (no browser API exposes it). So **no leak-free claim is made for GPU memory**; only the context count and JS heap were checked.

## 12. AI agent reliability (no live calls this round)

| Area | State |
|---|---|
| Free-tier chain | Gemini primary (20 s budget) → Gemini lite → Groq (40 s) with cooldowns; turn deadline 150 s (configurable, bounded) |
| Groq | Limited to single-step turns by its free 8k tokens/min — documented, not presented as a full backup |
| Language | Per-turn register hint (English / MSA / Egyptian); style guard rewrites once on language or register mismatch, feminine self-reference, unprompted university mention or pet names |
| Voice | Unedited transcripts make the model confirm unclear amounts |
| Grounding | Catalog claims require a lookup; external listings are `listed_unverified` with provider, https link and Cairo retrieval time |
| Consent and approvals | As in §7; cancellation stores a consistent `canceled` turn |

All of this is covered by saved-scenario and scripted tests (191 unit/integration). The latest live checks were in Rounds 2–3; their results are in `docs/MASAR_TRANSFORMATION_REPORT.md`.

## 13. Known limitations

- Free-tier latency: turns take 30–100 s.
- Groq cannot back up multi-step turns.
- Speech-to-text misreads some mixed-language Arabic amounts.
- The register detector uses word lists.
- Nested Markdown lists render flat.
- On the smallest phone heights the welcome screen scrolls by design.
- Model wording quality varies (flash-lite).

## 14. GitHub readiness checklist

- [x] `.env` ignored; `.env.example` has empty placeholders only (verified: no secret-named variable has a value).
- [x] No secret values in any text file or the client bundle; no source maps.
- [x] `.gitignore` excludes `node_modules/`, `dist/`, `reports/`, Playwright output, `.tmp/` (voice samples), `.impeccable/`, `.claude/`, recordings.
- [x] Test fixtures use fake phone numbers and placeholder credentials only.
- [x] Licenses compatible with publication:
  - fonts (Tajawal, Inter, Space Grotesk, Aref Ruqaa Ink) OFL-1.1;
  - three, React, Motion, Radix, Zod, pg MIT; lucide ISC;
  - simplex noise (webgl-noise) MIT, credited in `client/src/orb/noise.ts`;
  - the MASAR logo, symbol and orb are original work in this repository.
- [ ] **Rotate the credentials in §8 first (H1).**
- [ ] Choose and add a project `LICENSE` file (none yet).
- [ ] Decide whether to publish `deliverables/` (specification .docx/.pdf), `prompts/` and `design/`. These are the owner's documents; no secrets were found in their text files, but the .docx/.pdf content was not scanned.
- [ ] Delete or keep the screenshots that showed credentials outside the repository.
- [ ] Optional: curate a small `docs/media/` set of screenshots (from `reports/`, now ignored) for the README.
- [ ] Then `git init`, review `git status`, commit, and create the repository. **Not done (not approved).**

## 15. Release recommendation

**READY WITH CONDITIONS.**

There are no Critical findings. The only High finding (H1) is not a code defect: the owner must rotate the credentials listed in §8 before any publication or deployment. The Medium code defects (M1, M2, M4) are fixed with regression tests. M3 (a least-privilege database role) is recommended before any public deployment, and is not required for a portfolio repository.

**Conditions:**

1. Rotate the credentials (§8).
2. Add a LICENSE.
3. Decide on `deliverables/` and `prompts/`.
4. Before a public *deployment* (not needed for GitHub), also apply M3, HSTS behind HTTPS (L4), and a retention job (L8).
