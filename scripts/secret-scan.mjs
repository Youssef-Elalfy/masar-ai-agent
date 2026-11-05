// Secret scan (prints variable names / pattern names and file paths only — never a value).
// 1. Every non-empty value in .env that looks secret is searched for verbatim in all project files.
// 2. Generic credential formats are searched for everywhere (Google/Gemini keys, Groq, Tavily, JWTs, DB URLs with
//    passwords, private keys). Usage: node scripts/secret-scan.mjs [--staged] [--include-node-modules]
//    --staged scans exactly the files staged for the next Git commit, read from the index.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const skipDirs = new Set(['.git', process.argv.includes('--include-node-modules') ? '' : 'node_modules']);
const binary = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|webm|mp4|wav|ogg|mp3|m4a|zip|pdf|wasm|data)$/i;

const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|CONNECTION|PRIVATE/i;
const envSecrets = [];
if (existsSync(path.join(root, '.env'))) {
  for (const line of readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^['"]|['"]$/g, '');
    if (SECRET_NAME.test(m[1]) && value.length >= 12) envSecrets.push({ name: m[1], value });
  }
}
const PATTERNS = [
  ['google-api-key', /AIza[0-9A-Za-z_-]{35}/],
  ['google-ai-studio-key', /\bAQ\.[A-Za-z0-9_.-]{40,}/],
  ['groq-key', /gsk_[A-Za-z0-9]{20,}/],
  ['tavily-key', /tvly-[A-Za-z0-9_-]{16,}/],
  ['jwt', /eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/],
  ['supabase-secret', /sb_secret_[A-Za-z0-9_-]{16,}/],
  ['db-url-with-password', /postgres(?:ql)?:\/\/[^:\s/'"`]+:[^@\s'"`]{6,}@[^\s'"`]+/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const findings = [];
let files = 0;
function check(rel, text) {
  files++;
  for (const s of envSecrets) if (text.includes(s.value)) findings.push(`${rel}: contains the value of .env ${s.name}`);
  for (const [name, re] of PATTERNS) {
    const m = re.exec(text);
    // Placeholders in docs/examples are not secrets.
    if (m && !/your|example|placeholder|xxxx|<|\.\.\./i.test(m[0])) findings.push(`${rel}: matches ${name}`);
  }
}
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) continue;
    const full = path.join(dir, entry);
    const rel = path.relative(root, full).replaceAll('\\', '/');
    const st = statSync(full);
    if (st.isDirectory()) { walk(full); continue; }
    if (rel === '.env' || binary.test(entry) || st.size > 20 * 1024 * 1024) continue;
    check(rel, readFileSync(full, 'utf8'));
  }
}
if (process.argv.includes('--staged')) {
  // Exactly what the next commit contains: every staged blob, read from the Git index (not the working tree).
  const staged = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
  for (const rel of staged) {
    if (rel === '.env') findings.push('.env is staged: unstage it (git rm --cached .env)');
    if (binary.test(rel)) continue;
    check(rel, execFileSync('git', ['show', `:${rel}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString('utf8'));
  }
} else {
  walk(root);
}
console.log(`scanned ${files} text files; ${envSecrets.length} secret-like .env values checked (names: ${envSecrets.map((s) => s.name).join(', ') || 'none'})`);
console.log(findings.length ? findings.join('\n') : 'no secret values or credential patterns found outside .env');
process.exitCode = findings.length ? 1 : 0;
