# MASAR AI — web console

This is the standalone **agent workspace** for the MASAR AI travel agent (مَسَارٌ, a fictional demo company). It is not a tourism website. It talks only to the agent server in `server/src/web/`; no agent logic or API keys live in the browser.

```bash
npm run build:client && npm run web   # http://127.0.0.1:8787
npm run dev:client                    # hot reload on :5173 (needs `npm run web` for the API)
npm run e2e                           # Playwright against client/e2e/e2e-server.ts (test-only, no live calls)
```

- `src/api/client.ts`: typed fetch/SSE client validated against `server/src/web/contracts.ts`.
- `src/state/`:
  - `useAgent`: turns, live tool events, history.
  - `useRecorder`: voice notes, real mic level.
  - `settings`: language, theme, motion.
- `src/components/`:
  - shell (Sidebar, TopBar), Transcript, Composer, ContextPanel
  - cards: package, external offer, comparison, CRM
  - ApprovalCard, Overlays (Radix dialogs/drawers), LivingBackground
- `src/lib/markdown.ts`: safe Markdown-to-data parser (http(s) links only, no HTML injection).

Evidence, limits and status: `docs/UI_IMPLEMENTATION_REPORT.md`.
