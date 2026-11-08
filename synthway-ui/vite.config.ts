import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Under WSL, a project stored on the Windows drive (/mnt/c/...) does not get
// file change events for edits made from Windows: poll so that HMR still works.
const onWindowsDrive = process.cwd().startsWith('/mnt/');

// synthway-server address (its default port is 18741), overridable when the
// server runs elsewhere, e.g. the silent mock server:
// SYNTHWAY_SERVER_URL=http://127.0.0.1:18742 npm run dev
// The browser calls it directly (see src/lib/api.ts): Vite only serves the page.
const serverUrl = process.env.SYNTHWAY_SERVER_URL ?? 'http://127.0.0.1:18741';

export default defineConfig({
  plugins: [react()],
  // Where the UI calls the server, fixed when Vite starts or builds
  define: { __SYNTHWAY_SERVER_URL__: JSON.stringify(serverUrl) },
  server: {
    port: 5173,
    watch: onWindowsDrive ? { usePolling: true, interval: 300 } : undefined,
  },
});
