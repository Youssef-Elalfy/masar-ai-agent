import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const version = process.version;
console.log(`RAHHAL AI setup check — Node ${version}`);
if (Number(version.match(/^v(\d+)/)?.[1] || 0) < 20) {
  console.error('Node 20+ required for planned TypeScript app.');
  process.exitCode = 1;
}
for (const cmd of ['git', 'claude', 'ffmpeg']) {
  try {
    const found = process.platform === 'win32' ? 'where' : 'which';
    const path = execFileSync(found, [cmd], { encoding: 'utf8', timeout: 3000 }).split(/\r?\n/)[0];
    console.log(`${cmd}: ${path}`);
  } catch { console.log(`${cmd}: not found (optional at specification stage)`); }
}
for (const file of ['README.md', 'CLAUDE.md', 'prompts/ULTIMATE_MASTER_PROMPT_CLAUDE_CODE.md', 'fixtures/packages.json']) {
  console.log(`${existsSync(file) ? 'OK' : 'MISSING'} ${file}`);
  if (!existsSync(file)) process.exitCode = 1;
}
console.log('This check does not verify AI or third-party API access.');
