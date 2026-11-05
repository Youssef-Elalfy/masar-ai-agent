import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// MASAR AI web console (standalone agent UI, not a website). The API runs separately: `npm run web`.
// `vite --mode e2e` proxies to the deterministic test server (client/e2e/e2e-server.ts, :8799) instead, so UI work
// never spends live LLM / Tavily / Groq quota.
export default defineConfig(({ mode }) => {
  const api = { target: mode === 'e2e' ? 'http://127.0.0.1:8799' : 'http://127.0.0.1:8787', changeOrigin: false };
  return {
    root: path.resolve(import.meta.dirname),
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      // Same-origin in the browser; the API checks Origin === Host, so the Host header is kept as is.
      proxy: { '/api': api },
    },
    preview: { host: '127.0.0.1', port: 4173, proxy: { '/api': api } },
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  };
});
