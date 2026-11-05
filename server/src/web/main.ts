import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { PROJECT_ROOT, loadConfig, loadDotEnv } from '../config.ts';
import { createApp, createEmbeddings, createProvider, createSpeechToText } from '../app.ts';
import { connectDatabase } from '../db/connect.ts';
import { LOOPBACK_HOSTNAMES, createWebHandler } from './server.ts';
import { OwnerSessions } from './session.ts';

// MASAR AI web console server: the same agent runtime as the CLI, exposed over HTTP + SSE.
// Usage: npm run web   (serves client/dist when built; in development run `npm run dev:client` too)

loadDotEnv();
const config = loadConfig();
// Fallback reasons are logged (provider/model/reason only, never content or keys) to make free-tier capacity visible.
const provider = createProvider(config, { onFallback: (e) => console.warn(`[provider] ${e.from} → ${e.to ?? 'none'}: ${e.reason}`) });
if (!provider) {
  console.error(`Cannot start: ${config.providerIssue ?? 'no LLM provider configured.'}`);
  process.exit(1);
}
const db = connectDatabase(config);
if ('error' in db) {
  console.error(db.error);
  process.exit(1);
}

const secretEnv = process.env['WEB_SESSION_SECRET'] ?? '';
let secret: Buffer;
if (secretEnv.length >= 32) {
  secret = Buffer.from(secretEnv, 'utf8');
} else {
  secret = randomBytes(32);
  console.warn('WEB_SESSION_SECRET is not set (min 32 chars): using a random per-process secret, so browser sessions reset when the server restarts.');
}

const app = await createApp(config, provider, db.sql, createEmbeddings(config));
const stt = createSpeechToText(config);
const distDir = path.join(PROJECT_ROOT, 'client', 'dist');
// Host names the server answers to: loopback, the bind host when it is a name, and WEB_ALLOWED_HOSTS
// (comma-separated, e.g. the public domain behind a reverse proxy). Anything else is refused (DNS-rebinding guard).
const bindHost = process.env['WEB_HOST'] ?? '127.0.0.1';
const allowedHostnames = [
  ...LOOPBACK_HOSTNAMES,
  ...(bindHost === '0.0.0.0' || bindHost === '::' ? [] : [bindHost]),
  ...(process.env['WEB_ALLOWED_HOSTS'] ?? '').split(',').map((h) => h.trim()).filter(Boolean),
];
const handler = createWebHandler({
  allowedHostnames,
  app,
  stt,
  sessions: new OwnerSessions(secret),
  staticDir: existsSync(path.join(distDir, 'index.html')) ? distDir : null,
  status: {
    company: { name: app.company.name, fictional: app.company.fictional },
    model: provider.model,
    freeTierOnly: config.freeTierOnly,
    features: { voiceNotes: stt !== null, webResearch: config.search !== null, crm: app.crm.enabled, memoryRetrieval: app.memory.retrievalBackend },
  },
});

const host = process.env['WEB_HOST'] ?? '127.0.0.1';
const port = Number(process.env['WEB_PORT'] ?? 8787);
const server = createServer((req, res) => void handler(req, res));
server.listen(port, host, () => {
  console.log(`MASAR AI web console API on http://${host}:${port} (model chain: ${provider.model}; free-tier only: ${config.freeTierOnly ? 'yes' : 'NO'})`);
  console.log(existsSync(path.join(distDir, 'index.html')) ? `Serving the built console from client/dist.` : 'Client not built: run `npm run dev:client` and open http://localhost:5173');
});

const shutdown = () => {
  server.close();
  void app.sql.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
