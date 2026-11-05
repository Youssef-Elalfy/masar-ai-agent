# RAHHAL AI — Standalone Agent Interface
## UI/UX, Brand Identity & Motion Design System | v1.1 | 04 Nov 2026

> **Scope locked:** A polished, bilingual **standalone AI travel agent workspace**, NOT a travel marketing website. These frontend specifications complement the existing working Node.js/TypeScript AI agent, Supabase, CRM, memory, company packages, and external travel discovery. Nothing here authorizes redesigning the backend or implementing a landing page, destination catalog website, or cinematic travel hero.

## 01 — Product mission / الهدف
**RAHHAL AI / رحّال AI** is a fictional tourism company's genuine tool-using travel agent. The UI must make its intelligence and actions legible: what the customer asked, what the agent actually searched, which tools executed, where the results came from, how consent works, and which travel offers are verified vs unverified. The agent can discuss off-topic subjects fully, then invite travel discussion only at a natural conversational endpoint (never every turn).

**Brand statement:** Travel Smarter. Decide Faster. / «اسأل، قارن، وسافر بذكاء».

**Creative direction:** *AI Travel Command Center* — premium conversational workspace with understated travel motifs, deep ocean/night colors, kinetic intelligence cues, and a breathing ambient glow. Aim for **Smart • Premium • Fluid • Trustworthy • Alive**. The interface must remain usable when all motion is disabled.

**Product goals:** instructor can test company packages, Egyptian Arabic, worldwide external listings with sources, memory consent/correction/forgetting, lead/quote creation following user approval, voice notes once backend supports them, agent trace and errors. Every visible capability must map to a genuine backend feature. No fake success, fabricated availability, simulated live voice, placeholder source cards presented as real, or claim that it is a real human.

## 02 — Brand and visual identity
### 2.1 Naming and personality
- Official UI wordmark: **RAHHAL AI**, Arabic display: **رحّال AI**. Fictional company demo — display subtle `DEMO` status wherever company packages/prices are shown.
- Short sign-off: **رحلتك أذكى مع رحّال**. English: **Your intelligent travel companion**.
- Logo concept: clean compass ring intersected by a single route node and small AI spark; optional subtly animated path only when idle and motion allowed. Create a **vector SVG**, not a raster emoji, with monochrome and reversed variants. Avoid generic airplane clip-art.
- Voice: Egyptian Arabic that reads naturally, polite and warm but not overly familiar; avoid unnecessary «حبايبي» and never call it a graduation project unprompted. Reply in English when addressed in English. Agent transparently identifies as AI.

### 2.2 Core color tokens
| Token | Hex | Purpose |
|---|---|---|
| `--navy-950` | `#0B1220` | Dark canvas |
| `--navy-900` | `#111A2E` | Floating surfaces and panels |
| `--navy-800` | `#19273B` | Secondary elevated surfaces |
| `--teal-400` | `#14D7C4` | Main AI accent, active state (avoid tiny text on white) |
| `--cyan-400` | `#38BDF8` | Search/voice state, focus emphasis |
| `--indigo-500` | `#6366F1` | Rare secondary AI glow |
| `--gold-400` | `#F5B942` | Travel premium accent, not every button |
| `--white-50` | `#F8FAFC` | Dark-theme foreground text |
| `--slate-400` | `#94A3B8` | Secondary text in dark UI; verify contrast |
| `--coral-400` | `#F47764` | Caution / error accent |
| `--light-canvas` | `#F5F7FA` | Light-theme background |
| `--light-ink` | `#172337` | Light-theme content foreground |
| `--success-600` | `#0F8B79` | Accessible success text in light UI |

Primary dark gradient: `linear-gradient(135deg,#14D7C4 0%,#38BDF8 50%,#6366F1 100%)`; use for accents, avatar halo and active indicator, **not for body paragraphs**. Use static alternatives for reduced motion. Light theme is first-class, not simply inverted dark colors; verify semantic contrast pairs. Gold is an accent, **not** a “best deal” claim unless backed by real comparison data.

### 2.3 Typography
- Arabic body & app chrome: **Tajawal**, fallback `Noto Sans Arabic`, `system-ui`, `sans-serif`.
- English UI: **Inter**, fallback `system-ui`, `sans-serif`.
- Optional display headlines only: **Space Grotesk** (EN) and Tajawal Bold (AR). Do not overuse fonts or load all weights.
- Arabic body: 15–17 px (16px default), line height 1.7–1.9. English body: 15–16 px at 1.5–1.65. Headings: 22–32 px. Metadata: ≥12–13 px.
- Numbers, prices, dates and currencies use tabular numerals for alignment. Support Arabic-Indic digit input without misformatting monetary amounts. Prefer true Unicode bidi isolation (`bdi` / `dir="auto"`) for mixed direction text, URLs and code blocks.

### 2.4 Shape, texture, elevation
- 4px spacing grid; shell gap 20–24px desktop, 12–16px mobile.
- Radius: 12px inputs, 16px conversation cards, 20–24px panels; pill only for action chips or status.
- Glassmorphism only on nav/overlay layers: low-opacity translucent fill and *small* blur. Chat body must remain readable on solid surfaces.
- Elevation: 1 subtle soft shadow, ambient outline, no heavy neon borders or noisy gradients.
- Iconography: Lucide, consistent 18/20px. Never rely on color alone to communicate verified/unverified.

## 03 — Information architecture: ONE app, not tourism pages
### Desktop shell (≥1200px)
**Left rail, 252–282px:** RAHHAL logo; New Conversation; searchable recent chats grouped by date; recent/saved; language/theme/settings. Resizable or collapsible and keyboard accessible.

**Center panel, fluid max-width 820–940px:** greeting/empty state (only on new conversation), prompt chips, conversational transcript, inline package/listing results, composer anchored to bottom; inline explanatory search/agent activity based on real tool state. No full-screen landing hero.

**Optional right context drawer, 296–340px:** `Current Journey` (requirements extracted with provenance), `Sources` (links and retrieved dates), `Memory` (opt-in state and saved preferences), `Agent Activity` (user-safe execution events, not chain-of-thought). Close on narrow screens.

### Tablet (768–1199px)
Rail collapses; center fills; context becomes slide-over with accessible focus trap.

### Mobile (<768px)
Single-column conversation, fixed/sticky safe-area-aware composer, bottom-sheet source/details, top toolbar for history and settings; no hover-only functionality; touch targets ideally ≥44px. Ensure keyboard does not hide composer. Respect Android/iOS safe areas.

## 04 — Interface screen & component inventory
1. **New conversation / empty state:** restrained breathing compass/avatar, «أهلاً! تحب أساعِدك تختار رحلتك؟» and 3–4 genuine starter prompts (e.g. programs, budget comparison, Turkey, voice). No animated travel marketing montage.
2. **Text conversation:** distinct user/assistant styles, token streaming if backend supports it, Markdown rendering with sanitized links, clear timestamps, copy and retry; stop/cancel for active generation where API supports cancellation.
3. **Company Package Card:** name, destination, exact price *from company's DB*, currency, days/nights, inclusions/exclusions, departure info, `DEMO PACKAGE`, CTA “اسأل عن التفاصيل” or create quote only via functioning tool. Do not use a booking-confirmed badge.
4. **External Offer Card:** publisher/provider, title, source URL and `retrieved_at` local Cairo time, explicitly `External • Availability not verified`; price only if sourced; multiple competing prices displayed as such; distinguish flight-only from package and estimated itinerary.
5. **Comparison Panel:** same currency or explicitly no conversion, total vs per-person labels, source-backed highlights, clear tradeoffs; never invent ranking.
6. **Agent Activity panel:** user-safe events `Analyzing`, `Searching company catalog`, `Searching Tavily`, `Comparing options`, `Requesting consent`, `Completed / Unavailable` **only when backed by actual server events**. No fake progress bars or fabricated trace. Trace IDs optionally visible with advanced toggle; no private model thoughts or secrets.
7. **Memory & privacy:** on/off state, consent explanation including free-model data-handling disclosure, stored preference list, correction/delete/erase actions, confirmations, denied state, clear “not saved” state. Use server-confirmed events; no optimistic “saved” before success.
8. **CRM / quote:** explicit opt-in forms with name/contact only when needed, destination/date/budget summary, review step, exact confirmed action and result; never submit silently or claim booking/payment.
9. **Voice notes:** record/upload file, recording timer, animated input amplitude only if audio signal exists, stop/play/delete, transcript preview, editable correction, confirm transcript then send to same agent runtime. Mic permission denied, too large, format unsupported, offline or STT limit produce actionable messages. Voice reply / realtime mode should be visible only after server confirms availability.
10. **History:** conversation list, search, resume, delete with correct scope; cross-user session isolation.
11. **Settings:** language, theme, reduce motion override, sound preference, data retention explanation, basic accessibility.
12. **Errors & empty states:** no web search key / exhausted credits / timeout / invalid price / 503 / quota / no source results / network disconnect; display truthful fallback and retry without leaking internals.

## 05 — Core visual states and interactions
### AI turn lifecycle
`idle → composing → submitting → analyzing → tool-running (0..N) → streaming/responding → completed` with branches `consent-required`, `tool-unavailable`, `timed-out`, `canceled`, `error`.
- Compose input cannot silently disappear during failure. Preserve user's draft on retry.
- Distinguish real typing/streaming from backend buffering. If backend responds at once, animate the **bubble's entrance** only; don't pretend token streaming exists.
- Tool call phases come from backend execution events, not guessed intervals.
- New package/search card result animates gently after server result; don't animate amounts before settled.
- Inline view may show last verified partial results when later tools fail, labeled appropriately.

### Motion spec (including no-motion path)
| Motion | Duration | Behavior |
|---|---|---|
| New message | 160–240ms | fade + translateY(6–10px) |
| Button/toggle | 100–160ms | color + subtle scale ≤1.02 |
| Package/listing card | 220–320ms | stagger 40–65ms, max 5 cards |
| Context drawer | 220–300ms | slide ~12–20px + opacity |
| Dialog/backdrop | 180–260ms | fade, minimal travel |
| Search/voice indicator | state-linked | smooth loop only while actually active |
| Ambient Aurora | 12–24s loop | 2–3 blurred orbs at ≤0.08–0.14 opacity, no moving text |

Use **Motion for React** (`motion/react`) as default, simple CSS transitions for trivial states. GSAP only if a measured/justified need, NOT automatically. Avoid particle-heavy canvas/WebGL and perpetual full-screen expensive blur. `prefers-reduced-motion` should remove translations/loops and retain simple opacity or instant changes. Add a user setting to reduce motion as well.

### Performance constraints
- Smooth chat scroll; respect user manually reading old messages (don't force auto-scroll).
- Use `transform` and `opacity`; avoid layout thrashing and filtering over huge areas; tune for typical 60fps, not a guaranteed benchmark.
- Lazy load history, modals and large cards; cache remote photos responsibly; abort requests, avoid duplicate tool execution on retry.
- `npm run build`/typecheck, a11y audits and browser performance checks must pass before delivery. Offline and slow-connection behavior defined.

## 06 — UI architecture & frontend integration contract
**Keep current repo:** use `client/` as the sole frontend; do not create a new Next.js tourism app or rewrite `server/`. Inspect existing architecture before changing dependencies. Prefer React + TypeScript + Vite + Tailwind + shadcn/ui/Radix + Motion + Lucide, subject to existing package versions, approval and exact compatibility.

**Server integration** (implement/adjust minimally using existing contracts):
- `/api/conversations` create/list/load/delete; stable conversation and owner IDs.
- `/api/agent/turn` / streaming transport (SSE or streaming fetch) with server authoritative states, tool events, trace IDs, and cancel support, **only if backend actually implements this**.
- `/api/catalog` company program search/details (demo label); `/api/research` sourced external offers through existing agent action, avoiding uncontrolled extra Tavily calls.
- `/api/memory` consent/preferences/correction/forget; `/api/leads` quote/handoff post-approval if M4 complete.
- `/api/voice/transcribe` when M5 ready; no browser-side Groq/Tavily/Gemini secrets.

Names above describe functional requirements, **not existing endpoints**. Claude must inspect current server and write typed client contracts matching reality rather than assume paths or invent API responses. If the server is CLI-only, add a small secure adapter/API to expose existing services without duplicating tools. Do not expose `DATABASE_URL`, service keys, provider API keys, raw internal prompts or full trace internals to the client.

**Frontend modules**: `app-shell`, `navigation/history`, `chat/composer`, `chat/message`, `agent-activity`, `travel/company-package`, `travel/external-offer`, `travel/comparison`, `memory`, `voice`, `crm`, `settings`, `api/contracts`, `design-system`.

## 07 — Accessibility & language quality
- Full Arabic RTL layout and English LTR; language setting and auto-direction per message; multilingual code and URLs handled safely.
- Semantic landmarks, keyboard navigation, obvious focus ring, Escape closes overlays, screen reader accessible status messages (`aria-live` throttled), no endless announcements during streaming.
- Aim WCAG AA contrast for text and components; verify color combinations empirically. Support zoom ≥200% and reduced motion.
- Use accessible button labels for microphone and stop; provide transcript edits and error recovery.
- Accessible notice: **AI assistant / demo company**; external offers and company demo pricing never disguised as verified live booking.

## 08 — Photography and assets
Use authentic real-world destination photography only inside **actual travel result cards or contextual empty state** (if it adds value). Prefer existing licensed assets; Unsplash/Pexels can supplement after license and attribution verification. Keep per-card imagery light and lazy-loaded, with descriptive alt text. Never hotlink unsupported paid/protected media. Avoid photoreal AI avatars claiming to be human; use geometric vector assistant icon instead.

## 09 — Developer agents, skills, MCPs
Claude development subagents are distinct from the app runtime agent. Verify and delegate only installed exact IDs:
- `senior-ui-ux-designer`: audit visual system, RTL layout, accessibility and design quality.
- `senior-frontend-developer`: implement reusable React architecture, state, streaming and integrations.
- `frontend-qa`: browser journeys, screenshots, Playwright, reduced-motion and mobile tests.
- `senior-ai-automation-architect`: verify real tool event/consent presentation and no hallucinated states.
- `senior-backend-developer`: only minimal necessary secure API adapter work.
- `ai-project-manager`: phase gates / consolidation if useful.
Do not summon `senior-game-developer` or `senior-motion-video-producer` for a chat interface.

Possible installed skills/tools to verify, **never assume available**: `frontend-design`, `impeccable`/Impeccable.style, Taste Skill, `emil-design-eng`, `animation-performance`, Playwright CLI/MCP, `Awesome DESIGN.md`, Context7 (may need reconnect), Figma MCP (optional for editable UI comps), Unsplash/Pexels (license compliant), Supabase MCP for read-only verification. Do not install paid components or use third-party plugins without necessity and consent.

## 10 — Build sequence, explicitly aligned with existing M4–M6
**Existing roadmap:** M4 = CRM actions/handoff; M5 = voice; M6 = UX & hardening. Frontend should **begin after M4 completes** and integrates progressively with M5; M6 is final polish and acceptance. The client currently may still be a stub; inspect first.

**Gate A — after M4 passes:** read current project docs and test suite; audit `client/`; inspect actual endpoint/streaming support; freeze feature contract. Produce a 1-page design plan + wireframe, without restarting M1–M4.

**Gate B — UI foundation:** establish tokens, logos, typography, theme, RTL/LTR, sidebar, chat shell, composer, accessible nav. Use real test messages without pretending live backend action; display genuine server data only when wired.

**Gate C — Live integration:** wire real agent turns, grounded company packages/external search sources, actual tool activity and timestamps, history and memory consent, M4 lead/quote/handoff actions. Verify never more than one user-approved write per action.

**Gate D — M5 voice:** connect actual voice-note STT and transcript editing/confirmation; optional TTS only when available; do not present fake realtime conversation.

**Gate E — M6 finish:** responsive visual polish, memory/quote reliability, accessibility, reduced motion, load/performance, Playwright screenshot audit, complete demo for instructor and evidence/traces.

## 11 — Acceptance criteria (blocking, testable)
1. Arabic RTL and English LTR function correctly with mixed currencies, URLs and code.
2. A user can create, resume, search and delete real conversations with persistence and user isolation.
3. Text questions invoke existing **genuine** agent tools; UI accurately reflects real tool execution.
4. Company package cards show **DB values** and DEMO flags; no invented prices.
5. Tavily search listings show real source URLs, retrieval time, category, unverified state, and correct currency/price ambiguity; no premature “book now”.
6. Agent handles off-topic dialogue without redirecting mid-topic, and insult/ambiguity naturally; UI doesn't force tourism suggestions.
7. Memory consent reflects actual server state, rejection persists, edit/forget/erase work with confirmation and no false claim.
8. M4 lead/quote/handoff writes use server-authorized approval and show actual result; retries idempotent.
9. Voice note record/upload → editable transcript → confirm → real agent turn when M5 ready; disabled gracefully if not.
10. Search/agent status cannot be faked by static timers and must be truthfully unavailable when API fails.
11. Reduced-motion, keyboard/screenreader, contrast and mobile layouts pass QA.
12. No secrets/client DB access or log leaks; no premium dependencies or surprise charges.
13. Existing backend tests remain green; frontend unit/integration + Playwright E2E verified with evidence (screenshots + logs).
14. No public tourism website, brochure or cinematic hero is built.

## 12 — Reference links (official)
- Motion for React: https://motion.dev/docs/react
- AnimatePresence: https://motion.dev/docs/react-animate-presence
- W3C motion accessibility: https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions
- Lucide: https://lucide.dev/
- Supabase: https://supabase.com/docs
- Radix UI: https://www.radix-ui.com/primitives
- Unsplash License: https://unsplash.com/license

---
**Decision log:** This v1.0 UI system supersedes only the older minimal-console styling in `docs/12_BRAND_MINIMAL_DEMO_UI.md`. It does **not** supersede the no-tourism-website rule or agent functional specifications. Frontend UX should express the existing intelligent agent honestly, not conceal or replace its logic.


## 18 — LIVING BACKGROUND / Reel-inspired motion direction (v1.1)
### Reference and scope honesty
User reference: https://www.facebook.com/reel/1619659506373215 . This Facebook Reel could not be independently inspected in the handoff environment (access throttled). The requested high-level visual direction is a **cinematic, animated, alive background** similar to advanced motion-rich product sites. The precise colors, camera moves, animation geometry and pacing of this specific Reel are **NOT verified**. If Claude can access the reference or if the user attaches a screen recording, study it frame-by-frame *as inspiration only*, not as copyrighted asset to re-host or copy pixel-for-pixel. Never claim the reference was seen when it was not.

### Proposed visual experience: Living Travel Intelligence
- **Layer 1 — Dark atmospheric canvas**: Midnight Navy `#0B1220`, Deep Space Blue `#111A2E` with subtle grain; content contrast remains at AA or better.
- **Layer 2 — Flowing aurora / liquid ribbon**: one or two slow, low-opacity teal/cyan/indigo light fields (CSS/SVG blur or lightweight WebGL shader as justified). Sweep gently across background; no distracting full-screen video loops behind paragraphs.
- **Layer 3 — Travel intelligence paths**: very fine compass/route curves and moving data-node particles, subtle and sparse. Movements express discovery, not a stereotypical travel landing page.
- **Layer 4 — Soft parallax on pointer**: at most ±8–12 px offset on large screens, pointer-velocity damped; disabled on touch and reduced motion. Never tie layout or chat scroll to camera moves.
- **Layer 5 — Agent-state reactivity**: IDLE = 18–24s ambient breathing; THINKING = localized halo around assistant mark only, not faster whole-background animation; SEARCHING = one subtle moving route arc triggered by *actual tool event*; LISTENING = small audio-reactive glow driven only by real microphone amplitude; ERROR = calm static warning state (no red flashing).
- **Layer 6 — Interaction polish**: 160–240ms chat reveal, 200–320ms drawers/cards, tool result list short stagger; no fake typing/search progress.

### Engineering hierarchy (must choose the lightest viable approach)
1. **Default:** CSS gradients + transform animations + SVG paths, with `motion/react` for UI state transitions.
2. **Optional:** Canvas 2D / lightweight shader / WebGL (e.g. OGL or Three.js) ONLY if the real design direction cannot be achieved smoothly with CSS/SVG, after measuring performance on target hardware.
3. **Alternative:** licensed, locally hosted, compressed seamless background loop MP4/WebM with poster fallback only if a footage-like effect is actually preferred. `muted autoplay loop playsInline`, no audio, pause control, save-data policy and rights check. Don't add video simply because a Facebook Reel was supplied as a *reference for motion*.
4. No extra image/video generation APIs or paid services required; build original procedural motion.

### Performance & accessibility gates
- Target a smooth, responsive interface rather than promising constant 60 FPS. Test both standard laptop integrated graphics and mobile browser; if expensive, degrade to static gradients/SVG.
- Limit animated DOM surfaces, avoid excessive `filter: blur` or `backdrop-filter` and full-screen repainting; only animate `transform` and `opacity` where possible.
- When using WebGL: dynamic pixel ratio cap, reduced internal resolution, careful GPU memory cleanup, visibility pause, context-loss handling and static fallback.
- Respect `prefers-reduced-motion: reduce` and UI toggle; all perpetual motion must stop (static, attractive alternative). Users must be able to pause decorative motion.
- Ensure reading contrast and clean compositing in both light and dark modes. No motion layer may intercept clicks, block the composer, or cause scroll jank.
- The living background appears in the **standalone agent shell/new chat empty state and around conversation**, not as a site-wide tourism Hero.

### Required Claude deliverables for motion
- `LivingBackground` component with CSS/SVG fallback and configurable presets `calm`, `explore`, `focus`.
- `useAgentVisualState` selector driven by real agent events (idle, thinking, searching, listening, responding, error); no fabricated intermediate states.
- Motion pause/reduced-motion behavior and persistent local user preference when appropriate.
- Browser screenshots and short real recordings showing desktop/mobile, idle/active/reduced-motion.
- FPS/performance and accessibility review, plus `docs/UI_IMPLEMENTATION_REPORT.md` explaining selected approach and why.

### Visual examples for inspiration (not evidence of the Facebook Reel)
- Motion.page free loops: https://motion.page/backgrounds/
- Animated light procedural background gallery: https://www.movidmo.com/backgrounds/
- These are optional study references; verify rights and performance before using any external asset.
