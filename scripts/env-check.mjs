// Environment check: reports Configured / Missing / Invalid format / Unused for each variable — never a value.
// Usage: node scripts/env-check.mjs
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, '.env');
if (!existsSync(file)) {
  console.log('No .env file. Copy .env.example to .env and fill in your own values.');
  process.exit(1);
}
const env = {};
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

const base64Bytes = (v) => {
  try {
    return /^[A-Za-z0-9+/]+={0,2}$/.test(v) ? Buffer.from(v, 'base64').length : -1;
  } catch {
    return -1;
  }
};
const dbUrlOk = (v) => {
  try {
    const u = new URL(v);
    return /^postgres(ql)?:$/.test(u.protocol) && !!u.hostname && !!u.username && !!u.password && u.pathname.length > 1;
  } catch {
    return false;
  }
};
const distinctChars = (v) => new Set(v).size;

// [name, required?, validator, note]
const RULES = [
  ['DATABASE_URL', true, dbUrlOk, 'Postgres connection string (Supabase pooler); used by the server only'],
  // Classic "AIza…" keys and the newer AI Studio "AQ.…" keys are both accepted (the server sends either in a header).
  ['GEMINI_API_KEY', true, (v) => /^AIza[0-9A-Za-z_-]{35}$/.test(v) || /^AQ\.[A-Za-z0-9_.-]{30,}$/.test(v), 'Google AI Studio key (primary LLM + embeddings)'],
  ['GROQ_API_KEY', false, (v) => /^gsk_[A-Za-z0-9]{40,}$/.test(v), 'Groq key (fallback LLM + Whisper voice notes)'],
  ['TAVILY_API_KEY', false, (v) => /^tvly-[A-Za-z0-9_-]{20,}$/.test(v), 'Tavily key (worldwide offer research)'],
  ['PII_ENCRYPTION_KEY', false, (v) => base64Bytes(v) === 32, '32-byte base64 key for AES-256-GCM CRM contact fields'],
  ['WEB_SESSION_SECRET', false, (v) => v.length >= 32 && distinctChars(v) >= 16, 'HMAC secret for the anonymous browser session cookie (≥ 32 chars)'],
];
// Present in some .env files but not read by the application code (it connects to Postgres directly).
const UNUSED = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'TRAVEL_SEARCH_API_KEY', 'AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET', 'APP_ORIGIN', 'PORT', 'VOICE_PROVIDER', 'SPEECH_TO_TEXT_MODEL', 'TEXT_TO_SPEECH_MODEL', 'MEMORY_OPT_IN_DEFAULT', 'COST_BUDGET_USD_PER_SESSION', 'AMADEUS_ENV'];

let problems = 0;
console.log('Variable                    Status            Purpose');
for (const [name, required, ok, note] of RULES) {
  const v = env[name] ?? '';
  const status = !v ? (required ? 'MISSING' : 'not set (optional)') : ok(v) ? 'Configured' : 'INVALID FORMAT';
  if (status === 'MISSING' || status === 'INVALID FORMAT') problems++;
  console.log(`${name.padEnd(28)}${status.padEnd(18)}${note}`);
}
const fp = (v) => createHash('sha256').update(v).digest('hex');
if (env.WEB_SESSION_SECRET && env.PII_ENCRYPTION_KEY && fp(env.WEB_SESSION_SECRET) === fp(env.PII_ENCRYPTION_KEY)) {
  problems++;
  console.log('WEB_SESSION_SECRET and PII_ENCRYPTION_KEY are the SAME value: use two independent secrets.');
} else if (env.WEB_SESSION_SECRET && env.PII_ENCRYPTION_KEY) {
  console.log('WEB_SESSION_SECRET and PII_ENCRYPTION_KEY are distinct.');
}
for (const name of UNUSED) {
  if (env[name]) console.log(`${name.padEnd(28)}${'Unused'.padEnd(18)}set in .env but not read by the application${/KEY|SECRET/.test(name) ? ' — consider removing the secret from .env' : ''}`);
}
console.log(problems ? `${problems} problem(s) found.` : 'All set variables have a valid format.');
process.exitCode = problems ? 1 : 0;
