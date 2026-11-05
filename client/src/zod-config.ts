import { z } from 'zod';

// Imported first in main.tsx, before any module that defines schemas: Zod 4 reads this flag when schemas are created.
// Without it, Zod probes for eval support with `new Function` on first use; the throw is caught, but a strict CSP
// (script-src 'self', no 'unsafe-eval') still reports a violation. Jitless mode skips the probe; validation is
// unchanged.
z.config({ jitless: true });
