import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Synthway's version, shown by the UI: package.json's, its single source
// (the Windows package is named after it too)
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

// Under WSL, a project stored on the Windows drive (/mnt/c/...) does not get
// file change events for edits made from Windows: poll so that HMR still works.
const onWindowsDrive = process.cwd().startsWith('/mnt/');

// synthway-server address. Dev server: its default port, 18741. Build: empty,
// the page calls its own origin, since synthway-server serves the built page
// itself (synthway-ui/dist). Overridable when the server runs elsewhere, e.g.
// the silent mock server: SYNTHWAY_SERVER_URL=http://127.0.0.1:18742 npm run dev
// The browser calls it directly (see src/lib/api.ts): Vite only serves the page.
export default defineConfig(({ command }) => {
  const serverUrl = process.env.SYNTHWAY_SERVER_URL ?? (command === 'build' ? '' : 'http://127.0.0.1:18741');
  return {
    plugins: [react()],
    // Where the UI calls the server, fixed when Vite starts or builds; the version
    define: { __SYNTHWAY_SERVER_URL__: JSON.stringify(serverUrl), __SYNTHWAY_VERSION__: JSON.stringify(version) },
    server: {
      port: 5173,
      watch: onWindowsDrive ? { usePolling: true, interval: 300 } : undefined,
    },
  };
});
