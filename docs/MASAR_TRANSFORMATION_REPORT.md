# مَسَارٌ | MASAR AI: Transformation Report

**Date:** 2026-11-04.

**Scope:** this upgrades the existing RAHHAL AI agent; it is not a rebuild.

**Tagline:** ذكاءٌ يقود رحلتك

MASAR AI is the new public brand. Internal identifiers are deliberately unchanged:

- the organization id `rahhal-ai-demo-company` and its stored name;
- package ids, env names, API routes and the `rahhal.settings.v1` storage key;
- the repository folder.

As a result, no database row, migration or stored reference was touched.

## 1. Reliability and model behaviour (Phase A)

| Change | Where | Evidence |
|---|---|---|
| Turn deadline defaults to **150 s**: code default, `.env.example`, and the local `.env` line (it was `60000`). It is still bounded; heavy research demos may use `AGENT_TIMEOUT_MS=180000`. | `server/src/config.ts`, `.env.example` | Unit suite |
| Capability facts (search, memory, CRM, voice, booking not supported) are now in the system prompt. The model no longer needs a `get_system_status` step before ordinary answers, which saves one full model call per turn on the free tier. The tool remains for explicit status questions. | `app.ts`, `system-prompt.ts`, `system-tools.ts` | `tests/system-prompt.test.ts` |
| Language rule: reply in the language of the customer's **latest** message (English stays English after Arabic turns; Franco → Egyptian Arabic). Egyptian Arabic is the default only when the language is unclear. Fixes the live finding where an English question got an Arabic reply. | `system-prompt.ts` | `tests/system-prompt.test.ts` |
| The customer-facing identity is MASAR AI. `customerFacingCompany()` keeps the stored demo company name internal. | `server/src/brand.ts` | Prompt test asserts no "RAHHAL" |
| Per-call provider budgets (primary 20 s, fallbacks 40 s), the 60 s cooldown, cancellation and timeout messages are unchanged. | | Unit suite |

**Groq as a backup (investigated, documented).**

- The full agent request is about 5.3k tokens (prompt plus 14 tool schemas). The free `openai/gpt-oss-120b` allows 8k tokens/min, so a turn with two or more steps exceeds it.
- `llama-3.3-70b-versatile` (12k/min) still cannot fit three steps.
- Groq therefore reliably covers **single-step** turns: plain answers and one catalog lookup. It is **not** a full multi-step backup on the free plan.
- Per-request tool selection could shrink the schemas, but was not implemented. Removing tools risks dropping the consent and approval flows, and live verification would spend real quota.

**Token streaming (investigated, not implemented).**

- The grounding guard checks the finished draft and may replace it. Streaming tokens would show text that could then be withdrawn.
- The UI therefore keeps streaming **real agent events**: model call, each tool start and finish, grounding check, final. It shows only progress that actually happens; it does not fake streaming.

## 2. Brand identity (Phase B)

- **Arabic wordmark:** the exact vocalized form **مَسَارٌ**, set in **Aref Ruqaa Ink 700** (OFL, self-hosted, Arabic subset only).
  - It was chosen after rendering Ruqaa and Amiri side by side. In Amiri the final tanween floated high and clipped; in Ruqaa the fatḥas and tanween sit tight and stay legible at 26 px.
  - Amiri was then uninstalled.
  - An E2E test asserts the text is exactly `مَسَارٌ`.
- **English wordmark:** MASAR in Space Grotesk (letter-spaced), with a gradient "AI".
- **Symbol** (original SVG, `client/src/components/Logo.tsx`):
  - a route leaves its origin, swings around a central intelligent node as an open orbit tilted −28°, and arrives at a destination station;
  - a faint full orbit sits underneath;
  - the tilt matches the 3D orb's main ring;
  - it works in monochrome (`gradient={false}`).
- **Favicon:** `client/public/favicon.svg`.
- **Title:** `مَسَارٌ · MASAR AI`.
- **Themes:** dark and light variants come from tokens.
- **Typography:** Tajawal (Arabic UI), Inter (English UI), Space Grotesk (English display), Aref Ruqaa Ink (wordmark only).
- **Palette:** the approved tokens are in `client/src/styles.css` `:root`. Brand colors are used for light and fills; small text uses contrast-checked roles.

## 3. Living AI Orb (Phase C): Three.js, one canvas

`client/src/orb/OrbScene.ts` (imperative, outside React's render loop) and `LivingOrb.tsx` (tiers, fallbacks, positioning).

- **Geometry:** a procedurally displaced core (simplex noise in the vertex shader) under a translucent fresnel membrane, inside an atmosphere halo.
  - Three tilted orbit rings carry travelling comets.
  - A 900-particle disk (320 in reduced) is computed entirely on the GPU from a time uniform.
  - **7 draw calls**; geometries are reused (core and membrane share one).
  - No post-processing, no shadows, no lights.
- **Real states:** `idle · thinking · searching · listening · responding · error`, mapped in `App.tsx` from server events and the recorder only:
  - `thinking` = a turn is live with no tool running;
  - `searching` = a tool call is running;
  - `listening` = the microphone is really recording;
  - `responding` = a 1.4 s pulse when the server delivers a completed answer;
  - `stopped` = a canceled turn settling back to idle.
  - Uniforms ease between states; nothing is simulated.
- **Audio:** the real microphone RMS (`useRecorder.amplitudeRef`) drives the displacement with fast attack and slow release. It returns to 0 the moment recording stops or is canceled.
- **Performance controls:**
  - lazy chunk;
  - shaders compiled with `compileAsync`, and only after the brand intro;
  - pixel ratio capped (1.75 full / 1.25 reduced);
  - about 30 fps when docked and idle;
  - paused when offscreen (IntersectionObserver) or when the tab is hidden;
  - sustained frames over 40 ms auto-downgrade full → reduced → CSS;
  - every geometry, material and the renderer are disposed on unmount.
- **Fallbacks:**
  - full WebGL → reduced WebGL → animated CSS orb (no WebGL, too slow, or a lost context) → static CSS orb (reduced motion).
  - The CSS orb also holds the slot while Three.js loads, so the workspace is never blank.
  - QA override: `?orb=full|reduced|css|static`.
- **Placement:** one orb is moved by a compositor-only transform between the empty-state hero slot and a top-bar dock slot. It animates on hero ⇄ dock and follows instantly on scroll and resize.
- **Accessibility:** the orb is `aria-hidden` and `pointer-events: none`. Its text twin is the top-bar status line ("Analyzing your request…", the running tool's name, "Listening…").

## 4. Living background (Phase D): CSS/SVG

`client/src/components/LivingBackground.tsx`, with styles in `styles.css`:

| Layer | Content |
|---|---|
| A | Aurora band plus three drifting radial glows |
| B | Two blurred liquid ribbons |
| C | Four travel routes with SMIL travellers |
| D | A sparse node network with pulses |
| E | Grain and vignette |
| F | Damped pointer parallax across three depth layers (CSS variables, no React state) |

- **Searching:** fast travellers and route comets appear, and routes and network brighten, only while a tool call is running.
- **Listening:** the cyan glow scales with the real microphone level.
- **Error:** a coral wash.
- **Visibility:** the central workspace is a light glass tint, so the motion is visible behind the conversation.
- **Blur budget:** backdrop blur is limited to the side panels and floating controls, so the whole screen is not re-blurred every frame.

## 5. Interface (Phase E)

- **Glass system:** `.panel`, `.workspace`, `.card-glass`, `.composer-shell`, with solid variants for dialogs and menus.
- **Messages:** gradient-tinted user bubbles; assistant text in glass cards.
- **Starters:** glass with gradient icon tiles and a hover lift.
- **Cards:** catalog, external and approval cards in glass with a calm hover lift. The data shown is unchanged.
- **Composer:** gradient focus glow, and a cyan glow while recording.
- **Live meter:** paints itself from a ref. Recording no longer re-renders the whole app about 15 times per second, which was an open M6 item.
- **Theme flash fixed:** `public/boot.js` applies the saved theme and language before first paint. It is a separate file because the CSP forbids inline scripts.
- **Brand intro:** about 1.3 s, once per browser session, never on conversation switches, skipped with reduced motion, `pointer-events: none`.

## 6. Verification (all run 2026-11-04)

| Check | Result |
|---|---|
| `npm run check` (server and client typecheck, unit/integration) | **173 / 173 pass** (170 before, plus 3 new prompt tests) |
| `npm run e2e` (desktop + Pixel 7) | **30 / 30 pass** (24 before, plus 6 new: brand, orb states, orb fallbacks including a real `WEBGL_lose_context` → CSS) |
| Secrets in `client/dist` | None found (key names and key prefixes scanned) |
| Horizontal overflow (desktop AR/EN, mobile AR/EN) | 0 px |
| Visual QA: `client/e2e-live/qa/masar-states.mjs` against the test server (no live quota) | Screenshots in `reports/masar-shots/` (Arabic and English, dark and light, desktop and mobile, intro, idle, catalog, searching, thinking, listening, external results) |
| Motion evidence | Screen recording `reports/masar-shots/video/masar-flow-ar-dark.webm` of the real app. The orb region changes within 600 ms and the background region within 1.5 s (pixel comparison). |
| State evidence | research → `searching` (orb and background); slow model call → `thinking`; Stop → `idle`; recording → `listening`; cancel → `idle` |

**Measured frame rate.** Hardware: Intel UHD Graphics 630 (ANGLE D3D11), headless Chromium, 1440×900, `client/e2e-live/qa/masar-perf.mjs`.

| Tier | Idle (hero) | Searching | Idle (docked) | Listening (fake microphone) |
|---|---|---|---|---|
| Full WebGL | 60.1 fps (p95 16.7 ms) | 60.7 | 60.2 | 57.5 (44.4 before the meter fix) |
| Reduced WebGL | 60.1 | 60.6 | 60.3 | 58.6 |
| CSS orb | 55.2 | 53.1 | 56.9 | 47.5 |
| Mobile emulation (412×915, DPR 2.6, 4× CPU throttle, reduced) | 56.5 | 60.0 | 60.3 | 39.6 (24.3 before the meter fix) |

These are single-run measurements, not averages over repeats.

**Bundle.**

| Chunk | Size |
|---|---|
| Main JS | 650 kB min / 206 kB gzip |
| Three.js orb chunk (lazy, loaded after first paint and the intro) | 544 kB min / 136 kB gzip |
| Ruqaa wordmark font | 136 kB woff2 |

## 6b. Live check of the prompt changes

**Setup:** 2026-11-04, three turns in one conversation. They ran through the real web API on :8787 with the configured free-tier chain (Gemini first) and the real Supabase. The conversation was deleted afterwards through the app (HTTP 204).

| Turn | Result | Model calls | Tools | `get_system_status` | Reply language |
|---|---|---|---|---|---|
| Arabic: Hurghada for 4 days | completed, 30.7 s | 2 | `search_company_packages` | not called | Arabic ✔ |
| English after Arabic: can you book flights / remember my preferences? | completed, 7.9 s | **1** | none | **not called** | **English ✔** |
| English: cheapest program per person? | completed, 14.0 s | 2 | `search_company_packages` | not called | English ✔ |

What each turn showed:

- **Capability question:** answered correctly from the in-prompt facts with no tool call: no booking or ticketing, memory off, and an offer to request consent. Before this change it cost an extra status call.
- **Catalog answers:** came from the tool, with the DEMO price notice.
- **Minor model-quality notes for M7:**
  - one colloquial typo ("حبوب" for "تحب");
  - one unprompted mention of the "university project", which the prompt discourages.

## 7. Not done or not verified

- **Live providers:** the prompt changes were checked live (§6b). The redesigned UI was QA'd only against the deterministic test server, to save quota. Live Tavily and voice were not re-run after the redesign; their server code is unchanged since the M6 live checks.
- **Devices and assistive tech:** not tested on a real phone (iOS or Android), with a real microphone voice, with a screen reader, or at 200% zoom.
- **GPU memory:** GPU memory release after unmount was not measured directly. The disposal path runs in the context-loss test without errors.
- **Pricing labels:** the pricing-basis text from the demo fixture ("per adult in double occupancy") still shows in English inside Arabic cards. This predates the transformation (it is data, not UI).
- **Groq:** a full multi-step Groq fallback is not available on the free plan (see §1).
- **Bundle size:** the main bundle is not code-split further. The wordmark font is not subset to the six glyphs it needs; that would need a subsetting tool, which is not installed.

---

# Round 2: quality fixes and the liquid glass orb (2026-11-04)

## R2.1 Conversation quality

**Root cause of the "university project" leaks.** The phrase was in the model's own context in two places:

- the system prompt identity line;
- the catalog tool's DEMO notice, which is returned on **every** catalog search.

Both now say only what the customer needs: a fictional demo company, demo prices, no real booking. The project origin is given only when the customer asks who built the assistant.

**Prompt guidance** (`system-prompt.ts`):

- talk like a human travel advisor, never about testing, development, prompts or tool names;
- writing quality, including standard Egyptian spellings (تحب، عايز، إزاي …) and consistent MSA;
- vary openings and greet only once;
- one follow-up question at most;
- the DEMO disclaimer appears the first time prices are shown and whenever the customer may take prices as real, not in every reply.

**Style guard** (`server/src/agent/style.ts`, built like the grounding guard):

- It checks the final reply for three high-precision issues:
  - a wrong reply language (clear Arabic vs clear English; Franco, very short, number-only and explicit "answer in …" requests are exempt);
  - unprompted university, project or testing talk;
  - pet names.
- On a hit, the draft is held back **once** and the model rewrites it from a runtime note. The customer never sees the draft: the transcript view now hides any draft followed by an `[Automatic runtime check…` note.
- A `style_check` trace event records issue codes only.
- Nothing is string-edited. Typos are left to prompt guidance, as requested.

**Saved scenarios before live quota** (`tests/style.test.ts`, 7 tests):

- 13 saved customer/reply pairs, including the 3 real replies from the earlier live check. The live "university project" reply is flagged; the clean ones are not.
- Also covered: the M6 English-question-answered-in-Arabic case, MSA, mixed, Franco, "answer in English", "who built you?", pet names, and number-only and link-only messages.
- Runtime tests: a wrong-language reply is rewritten once and only the rewrite is visible; at most one rewrite per turn; a clean reply costs no extra model call.

**Live check** (5 turns, one conversation, deleted afterwards). All five completed. The reply language was right every time, no university or testing mention appeared, and the style guard found no remaining issues:

| Turn | Result |
|---|---|
| Egyptian: two people in December | 19.0 s; catalog search; demo prices stated once |
| MSA: Hurghada vs Sharm | 13.6 s; `compare_company_packages` |
| English: per person, and can I book? | 14.1 s; clear "demo, no online booking", offers a quote request |
| Mixed: Sharm inclusions | 14.3 s; `get_package_details` |
| Off-topic: reverse a string in JavaScript | 7.7 s; a full answer, no travel pitch |

**Remaining quality limitations:**

- The MSA question was answered in Egyptian Arabic. The guard cannot tell MSA from Egyptian, only Arabic from English.
- One reply used a feminine self-reference ("حابة").
- The demo-price note still came back once in the inclusions turn.
- The English turn used 2 model calls without tools. That may have been a style or grounding rewrite; the client stream does not expose `style_check`, so this is not confirmed.

## R2.2 Supabase deletion: independent read-only verification

The checks were run with counts only; no content or ids were returned.

- **First live check:** after its HTTP 204 delete, 0 matching messages remained.
- **Second live check:** conversation `conv_c786cd63…` has 0 rows in conversations, messages, summaries, agent runs, approvals, memory events and consents.
- **Whole database:** 0 orphaned messages, agent runs or tool executions.
- **Residual test data:** 10 anonymous owner rows (`customers`: owner id and locale only, no personal data) from the M5/M6 and today's live tests. Between them they still hold 2 revoked consents and 4 memory audit events.
  - Deleting a conversation intentionally keeps the browser's owner identity and the consent audit trail.
  - Opening the console does not create owner rows: none came from the many screenshot sessions.
  - So this is **not** a deletion defect, and no regression test was added. There is also no retention job for anonymous owners whose conversations are all gone.
  - **Kept** at the user's request (2026-11-05).

## R2.3 Liquid glass orb (`client/src/orb/OrbScene.ts`)

**Approach.** One custom shader instead of `MeshPhysicalMaterial`:

- Physical transmission needs an extra full-scene render pass each frame and only refracts opaque objects.
- On a transparent canvas over the DOM it shows a dark veil on the light theme.
- The custom shader keeps one pass and gives real view-dependent depth.

**What the shader does:**

- **Liquid surface:** two noise octaves displace the sphere; normals are rebuilt from neighbouring displaced points. The real microphone level adds a ripple octave.
- **Glass:**
  - Schlick Fresnel (F0 0.04) reflects a procedural studio environment: cyan key light, teal side light, violet bounce, plus a bright softbox and a strip light, which give the crisp glass highlight.
  - The view ray is **refracted** (IOR 1.33) and **marched** through the sphere: 8 steps at full quality, 5 at reduced.
  - Domain-warped noise ridges form flowing energy filaments around a luminous nucleus.
- **Iridescence:** a thin-film term adds a subtle sheen at the rim.
- **Compositing:** premultiplied output, so clear glass lets the page through; a faint white sheen on the light theme avoids a grey veil.

**Orbits and particles:**

- Each ring is drawn twice (same geometry and material): its far arc is seen through the glass, its near arc stays in front.
- Particles are smaller, with occasional brighter sparks.

**Halo:** now fades to zero at its edge, with no hard rim.

**Unchanged:** the real state mapping (idle, thinking, searching, listening, responding, error, and stop settling to idle), microphone reactivity, tiers, the CSS and static fallbacks, context-loss handling, and disposal.

**New:** the docked orb renders at a pixel ratio of 0.6 (it is shown at about 15% scale).

**Evidence** (`reports/orb-compare/`):

- `before-after.png`: in-app hero close-ups before and after, dark and light.
- `states-sheet.png`: all six states in dark, plus idle and searching in light.
- Motion recordings: `video/orb-states-dark.webm` and `video/orb-states-light.webm`, the real orb cycling through every state.
- The dev-only lab harness `client/orb-lab.html` is not in the production build.

**Frame rate** (Intel UHD Graphics 630, ANGLE D3D11).

Orb alone, 600 px lab canvas (larger than the 260 px app hero), 3 s windows:

| Tier | Idle | Searching | Listening |
|---|---|---|---|
| full | 60.1 fps (p95 16.7 ms) | 60.1 | 60.1 |
| reduced | 60.1 | 60.0 | 60.3 |
| css | 60.1 | 60.1 | 60.3 |

Full app, 1440×900, same session:

| Tier | Idle (hero) | Searching | Idle (docked) | Listening |
|---|---|---|---|---|
| full | 52.6–56.6 fps | 55.3–55.7 | 56.1–60.2 | 52.2–59.5 |
| css (no WebGL) | 57.2 | 47.5 | 59.6 | 54.5 |

- The app dips come from the rest of the page (blurred glass panels over the animated background) and machine load: the no-WebGL CSS orb shows the same range.
- The earlier session measured about 60 fps in the app; that difference is environmental noise, since the orb alone holds 60 fps.
- Bundle: the orb chunk is 546 kB min / 137 kB gzip (was 544 / 136).

**Verification:**

| Check | Result |
|---|---|
| Typecheck (server and client) | Pass |
| Unit/integration tests | **180 / 180** |
| E2E | **30 / 30** |
| Secrets in the bundle | None |

**Not verified:** a real phone GPU, Safari or Firefox rendering of the glass shader, and long-session GPU memory.

---

# Round 3: polish pass (2026-11-05)

## R3.1 Language, register and voice

**Per-turn reply-language hint** (`style.ts` → `replyLanguage`). Fixed rules classify the latest customer message as English, Modern Standard Arabic or Egyptian Arabic:

- Script share decides English vs Arabic.
- Clear register markers decide MSA vs Egyptian: عايز، إيه، ده، كده، تحب … vs هل، ماذا، يمكن، أود، حيث …
- Ambiguous words are left out, and mixed, Franco or unclear messages give no hint.

The runtime adds one fixed sentence for that language to the per-turn prompt section, for example "answer in clear, neutral MSA from start to finish, with no Egyptian colloquial words". The customer's text itself never enters the system prompt.

**Style guard additions** (same hold-back-once-and-rewrite mechanism; nothing is string-edited):

- `register_mismatch`:
  - a formal (MSA) question answered with clearly Egyptian wording — the live finding;
  - an Egyptian question answered in heavy MSA, with a stricter threshold.
- `self_gender`: feminine first-person forms ("حابة أضيف", "أنا متأكدة").
  - It needs "أنا" or a following first-person verb, so addressing a woman ("حابة تعرفي؟") or feminine nouns ("الرحلة جاهزة") are not flagged.
  - The prompt also asks for consistent masculine singular self-reference.

**Demo disclaimer.** The runtime checks whether an earlier assistant reply already told the customer that the company and prices are demos. If so, the per-turn prompt says not to repeat it unless booking or payment comes up, or a price could be taken as real. The result cards keep their DEMO badge, so honesty stays visible.

## R3.2 RTL lists (`styles.css`, `Markdown.tsx`, `lib/markdown.ts`)

**Direction.** A reply's direction now comes from its dominant script, not its first character. An Arabic answer starting with `**Sharm**` stays RTL. List items follow that direction, so markers stay on one side, while their text remains bidi-correct.

**Markers and layout:**

- Browser list markers are replaced:
  - bullets are a small accent dot centred on the first line;
  - numbers are tabular digits in a soft pill, which avoids the Arabic "1." vs ".1" ambiguity.
- Markers sit in a reserved gutter (`padding-inline-start`, 26 px), measured about 31 px from the panel edge.
- Wrapped lines align with the text, not under the marker.
- Items are 0.5 em apart; headings get more space above than below.
- Numbering continues from the author's start number (CSS counter, `counter-reset` from `start`).
- Everything uses logical properties, so LTR mirrors RTL.

**Found and fixed during QA:** forcing `direction: ltr` on the number pill flipped it to the far side in RTL. It now uses `unicode-bidi: isolate` only.

**Card lists:** card inclusion/exclusion lists got more breathing room. The catalog's English pricing-basis phrases ("per adult in double occupancy") are now shown in Arabic in the Arabic UI.

## R3.3 Scrolling

**Scroll areas:**

- The track is transparent and the thumb is invisible at rest.
- A thin, low-contrast thumb appears while the area is hovered or has keyboard focus.
- Touch devices draw no scrollbar.
- The gutter is reserved so content never shifts.
- Wheel, touch and keyboard scrolling are unchanged.

**Welcome screen:**

- It is a scroll area, centred when there is room.
- The orb slot scales with viewport height (`clamp(130px, 23vh, 250px)`), and spacing tightens below 820 px height.
- Measured overflow: **0 px at 1440×900 and 1366×768** (was 34 px at 1366×768).
- Phones still scroll (26 px at 412×915, 83 px at 390×844, with four stacked starters), without a visible bar.

## R3.4 Spacing, alignment, edges

| Area | Change |
|---|---|
| Transcript | Column 840 px, aligned with the composer; 28 px between turns; assistant panels padded 14/20/16 px (12/16 on phones); user bubbles 20×12 px; activity, cards and actions spaced 10–16 px |
| Cards | 20 px inner padding, 14 px gaps |
| Top bar | 24 px sides |
| Sidebar | 20 px padding and gaps; history rows 10 px tall padding |
| Context panel | 24 px sides; sections 20 px with 12 px internal rhythm |
| Starter cards | Equal height, 16 px padding, 36 px icon tiles on the input radius |
| Light theme | Glass edges now use a dark hairline (they were white on white) |
| Radii | Consistent: panels 24, cards 18, inputs/icon tiles 12, pills full |

Evidence: `reports/round3-shots/` (Arabic and English, dark and light, 1440×900, 1366×768 and phones; welcome screens, list conversations, list close-ups).

## R3.5 Verification

| Check | Result |
|---|---|
| Typecheck (server and client, E2E tsconfig) | Pass |
| Unit/integration | **188 / 188**: 6 register/gender/disclaimer tests on saved live replies, plus 2 list/direction tests |
| E2E | **36 / 36** (desktop + Pixel 7), including new RTL list placement, LTR mirroring, quiet scrollbars and a no-scroll desktop welcome screen |

**Live check** (2 turns, deleted afterwards; a read-only Supabase check confirmed 0 rows and 0 orphans):

| Turn | Result |
|---|---|
| MSA question | Reply in MSA ("بناءً على… هل ترغب"), 30.3 s |
| Egyptian follow-up | Reply in Egyptian, 18.4 s |

Neither reply had a feminine self-reference or any remaining style issue. The live check added one more anonymous owner row, of the same kind as the 10 kept earlier.

## R3.6 Remaining limitations

- Register markers are word lists: very short or mixed messages get no register hint, and the model can still choose unusual phrasing ("الإيه المتضمن" in the live Egyptian reply).
- Demo-notice detection also matches demo words inside catalog data ("مواصلات تجريبية"). That only suppresses a repeated disclaimer; the cards still show DEMO.
- Nested Markdown lists are rendered as one flat list (the parser has no nesting).
- Not tested yet: phone hardware, Safari/Firefox, a screen reader, and 200% zoom.

---

# Round 4: responsive and adaptive layout (2026-11-05)

## R4.1 What was wrong

A sweep of 171 sampled viewport sizes on the welcome screen (`client/e2e-live/qa/layout-probe.mjs`) found overflow at **54** of them. There were three root causes:

1. **Clipped content.** Content was vertically centred with `justify-content: center`. When it was taller than the region, its top was pushed above the scroll origin and could not be reached.
2. **Fixed sizes.** The orb and spacing were fixed or `vh`-based, so they did not respond to the space actually left between the top bar and the composer.
3. **Stale height after resizing.** The shell was `100dvh` tall. Under viewport emulation that value was not re-evaluated on resize, so the layout kept its old height until reload (a resize from 1280×1440 to 1280×480 left a 1243 px region).

## R4.2 What changed

**Panel modes come from content, not device classes** (`useLayout`, `App.tsx`):

| Mode | Panels | Needs at least |
|---|---|---|
| wide | history + conversation + context | 72 em |
| medium | history + conversation; context in a drawer | 50 em |
| narrow | conversation first; history and context in drawers | below 50 em |

- The thresholds are em media queries listened to with `matchMedia` (no resize polling). They follow browser zoom and the reader's default font size: 200% zoom on a 1440 px window becomes narrow.
- The top bar separates "carries the brand" (narrow) from "compact controls" (narrow and medium).

**Fluid shell** (`.shell` in `styles.css`):

- One grid fixed to the layout viewport (`position: fixed; inset: 0`, no vh/dvh). It follows window resizes, zoom, mobile toolbars and the on-screen keyboard (`interactive-widget=resizes-content` was already set).
- Tracks are `clamp(…)` and `minmax(0, 1fr)`, gutters scale with the viewport, and every nested grid/flex child has `min-width: 0` / `min-height: 0`.
- Typography sizes moved from px to rem, so they follow the reader's font size.

**Conversation column:** a flex column with the top bar, one scrolling region and the composer. The composer is in normal flow, so its real height is always reserved and it cannot cover messages or suggestions.

**Adaptive welcome screen** (`.welcome`, a size container):

- **Orb:** the slot is the flexible part. It grows into whatever height the text and cards leave, between 3–4.5 rem and 15.5 rem, so the composition fills short and tall regions without magic numbers. The slot reserves its space, so lazy-loading WebGL causes no layout shift.
- **Text and spacing:** sizes and gaps are continuous `clamp()` functions of the available height and width (`cqh`/`cqw`).
- **Structure:** container queries change only structure:
  - two card columns below 34 rem of width, one below 21 rem;
  - a side-by-side hero (orb beside brand and greeting, cards in two wide columns) when the region is short but wide (under 28 rem tall, at least 30 rem wide).
- **Centring:** `justify-content: safe center` never pushes content above the scroll origin. Nothing is hidden to avoid a scrollbar; very small regions scroll naturally.

**Orb positioning** now also follows content reflow and font loading (ResizeObserver on the region's content, plus `document.fonts` `loadingdone`). Before, it could sit about 22 px off its slot after web fonts arrived.

**Adaptive top bar:** a container. Below 27 rem of its own width the connection pill keeps its dot and moves its label to screen readers, so the brand and controls never collide at 320 px.

## R4.3 Evidence (test server only; no Gemini/Groq/Tavily calls)

**Probe:** 171 sampled sizes, 320–2560 px wide and 480–1440 px tall. The sweep resizes one live page and re-checks every flagged size with a fresh load.

| Language | Sizes with overflow (before) | After | Resized vs fresh loads |
|---|---|---|---|
| Arabic | 54 | **6** | identical |
| English | — | **8** | identical |

- All remaining cases are phone-width regions under about 35 rem tall (for example 320–430 px wide, 480–700 px tall), where the brand, greeting, demo notice and four suggestions genuinely do not fit. They scroll, with nothing clipped and the composer never overlapping.
- Horizontal overflow: none at any size. Top clipping: none.

**Contact sheet** (`reports/responsive/contact-sheet.png`): 12 sampled sizes × (Arabic dark, English light). There is 0 px overflow at every size except English at 333×611 (14 px).

**Live resize recording** (`reports/responsive/video/live-resize-ar-dark.webm`): one session resized continuously, 1600×1000 → 360×480 → back up.

**Real browser:** the app's browser pane (Electron Chromium, DPR 2) at 1366×700, 900×560 and 420×760. At 420×760 the page is exactly 420 px wide, the region has no vertical overflow, and the cards sit inside 21–399 px.

**New E2E** (`client/e2e/responsive.spec.ts`):

- **Sampled sizes**, Arabic and English, 18 odd and in-between sizes (e.g. 333×611, 777×533, 1013×701, 1555×877). Each size checks:
  - the expected panel mode, computed from em, not from the size list;
  - no sideways overflow and no top clipping;
  - the composer not overlapping;
  - every suggestion reachable inside the region;
  - no vertical overflow whenever the region is at least 36 rem tall, or at least 19 rem tall in a wide-enough column.
- **Live resizing** through 26 steps in one session: the shell always matches the window height, and none of the failures above.
- **200% zoom equivalent** (720×450 at 2× scale): narrow mode, everything reachable, history drawer works.
- **Panel modes** while resizing: wide → medium → narrow, with drawers.
- **Small-window chat:** exactly one scrolling region, and the composer never covers the latest answer.
- **Mobile project:** portrait ↔ landscape rotation, and the on-screen keyboard shrinking the viewport while the composer keeps focus and stays visible.

**Totals:** **44 E2E pass** (8 skipped by design: the desktop-only sweeps on the mobile project and the mobile-only checks on desktop). **188 unit/integration tests pass.** Typecheck is clean.

## R4.4 Limitations

- Browser zoom is tested as its CSS equivalent (smaller CSS viewport at a higher device scale), not by driving the real zoom control. iOS Safari's dynamic toolbar and a real on-screen keyboard are not tested on hardware (simulated by viewport resizes).
- At the smallest phone heights (regions under about 35 rem) the welcome screen scrolls by design.
- Not tested: a screen reader with the drawers, or Firefox/Safari container-query rendering.

---

# Round 5: three focused UI fixes (2026-11-05)

| Issue | Cause | Fix |
|---|---|---|
| **Arabic composer not RTL** | The textarea used `dir="auto"`. With no text yet the browser resolves that to LTR, so the Arabic placeholder and caret started on the left. | `fieldDirection(text, uiLang)` (`client/src/lib/markdown.ts`): empty or digits-only → the UI language (RTL in Arabic, LTR in English); once letters are typed → the text's dominant script. `text-align: start` follows it. (`Composer.tsx`) |
| **Arabic header lockup drifting inward** | The orb's 44 px dock slot sat before the title even while empty (the orb is in the welcome hero), pushing "مساحة رحلتك / جاهز يساعدك" 76 px from the edge. | The slot takes space only when it shows something: the docked orb, or the brand symbol on narrow screens. Otherwise it is zero-width and its gap is cancelled, so the title starts at the bar's padding (24 px; right in Arabic, left in English). The two lines share the same start edge. No width transition, so the orb's flight to the dock is measured against the final slot. (`TopBar.tsx`) |
| **Blank drawer on narrow screens** | The glass `.panel` rule (unlayered CSS) set `position: relative`, overriding Tailwind's `fixed` on the drawer. The drawer rendered in page flow below the viewport (top = 780 px on a 780 px screen), leaving only the dark overlay. The confirm and memory-consent dialogs use the same class and had the same defect since the MASAR redesign. | Removed `position` from `.panel`; callers set their own positioning. Drawers and dialogs are fixed overlays again. (`styles.css`) |

**Tests:**

- `client/e2e/polish.spec.ts`, on desktop and mobile:
  - the Arabic composer is RTL when empty and with digits, and switches with the typed script;
  - the English composer stays LTR;
  - the header title and subtitle start at the bar padding (at most 28 px) in Arabic and English;
  - on narrow screens, Arabic and English, the history drawer opens fixed and on screen with content, three times in a row, and the context drawer opens with content;
  - the workspace is intact afterwards;
  - the delete-confirmation dialog is a fixed overlay on screen.
- A unit test for `fieldDirection`.

**Results:**

| Check | Result |
|---|---|
| Typecheck | Clean |
| Unit/integration | **189 / 189** |
| E2E | **56 passed**, 10 skipped by design (desktop-only header and viewport sweeps on the mobile project, mobile-only checks on desktop) |

Screenshots are in `reports/round5/`. No live provider calls were made.

**Limitation:** typing mixed Arabic and English flips the field direction by dominant script; text that is exactly balanced follows the 30% Arabic rule used for replies.
