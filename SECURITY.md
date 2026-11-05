# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (**Security → Report a vulnerability**). Do not open a public issue for security problems, and
never include real API keys, database credentials or personal data in a report.

You can expect an acknowledgement within a few days. This is a portfolio / demonstration project maintained by one
developer, so fixes are best-effort.

## Supported versions

Only the latest commit on `main` is supported.

## Handling secrets

- All credentials live in a local `.env` file, which is git-ignored. `.env.example` lists variable names only.
- Secrets are read **only by the Node.js server**. The React client receives no environment variables (no `VITE_*`
  values) and talks only to the local server's `/api`.
- `node scripts/secret-scan.mjs` checks every text file (including the built client) for the values in your `.env`
  and for common credential formats. It prints variable names and file paths, never values.
- `node scripts/env-check.mjs` validates your configuration (status only, no values).
- If a credential is ever exposed, rotate it at the provider. Deleting it from a later commit does not remove it from
  Git history.

## Security design (summary)

- **Sessions:** anonymous per-browser owner identity in an HMAC-SHA256 signed, `HttpOnly`, `SameSite=Strict` cookie.
  Every conversation, memory and CRM record is scoped to its owner.
- **Request checks:** state-changing requests need a custom client header and a same-origin `Origin`. The server
  answers only to allowed host names (loopback by default, `WEB_ALLOWED_HOSTS` for deployments), which blocks
  DNS-rebinding.
- **Browser hardening:** strict Content-Security-Policy (`script-src 'self'`, no inline scripts, no `unsafe-eval`,
  `frame-ancestors 'none'`), `nosniff`, `no-referrer`, `X-Frame-Options: DENY`.
- **Agent safety:**
  - Tool arguments are validated with Zod.
  - Write actions (leads, quotes, human handoff) need the customer's approval, bound to the exact arguments and usable
    once.
  - Long-term memory is opt-in with server-fixed consent wording.
  - Web search results are sanitized and treated as untrusted data, never as instructions.
- **Data:** CRM contact fields are encrypted at rest with AES-256-GCM, and traces redact personal data. The database
  has row-level security enabled with no grants to the public API roles. The server connects to Postgres directly.
- **Limits:** request-size limits, per-browser and global rate limits, bounded turn deadlines, tool timeouts and
  cancellation.

The latest audit is in [docs/FINAL_SECURITY_QA_REPORT.md](docs/FINAL_SECURITY_QA_REPORT.md).
