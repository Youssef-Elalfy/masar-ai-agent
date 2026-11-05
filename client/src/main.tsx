import './zod-config.ts'; // must stay the first import
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/tajawal/arabic-400.css';
import '@fontsource/tajawal/arabic-500.css';
import '@fontsource/tajawal/arabic-700.css';
import '@fontsource/tajawal/400.css';
import '@fontsource/tajawal/500.css';
import '@fontsource/tajawal/700.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
// Brand wordmark only (مَسَارٌ): Arabic subset of Aref Ruqaa Ink, weight 700.
import '@fontsource/aref-ruqaa-ink/arabic-700.css';
import './styles.css';
import { App } from './App.tsx';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
