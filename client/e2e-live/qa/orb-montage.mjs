// Builds one comparison sheet (PNG) from orb close-ups via a local HTML page rendered by Chromium (no image libs).
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const [out, ...files] = process.argv.slice(2);
const cells = files.map((f) => `<figure><img src="data:image/png;base64,${readFileSync(f).toString('base64')}"><figcaption>${f.split('/').pop().replace('.png', '')}</figcaption></figure>`).join('');
const html = `<html><body style="margin:0;background:#0b1220;font:14px system-ui;color:#cbd5e1"><div style="display:grid;grid-template-columns:repeat(4,300px);gap:8px;padding:8px">${cells}</div>
<style>figure{margin:0}img{width:300px;height:300px;object-fit:cover;border-radius:10px;display:block}figcaption{padding:4px 2px}</style></body></html>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1240, height: 100 } });
await p.setContent(html);
await p.screenshot({ path: out, fullPage: true });
await b.close();
