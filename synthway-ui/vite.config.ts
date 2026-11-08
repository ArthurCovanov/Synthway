import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Under WSL, a project stored on the Windows drive (/mnt/c/...) does not get
// file change events for edits made from Windows: poll so that HMR still works.
const onWindowsDrive = process.cwd().startsWith('/mnt/');

// synthway-server address (its default port is 18741), overridable when the
// server runs elsewhere, e.g. the silent mock server:
// SYNTHWAY_SERVER_URL=http://localhost:18742 npm run dev
const serverUrl = process.env.SYNTHWAY_SERVER_URL ?? 'http://localhost:18741';

export default defineConfig({
  plugins: [react()],
  // Lets the UI name the right port in its messages (fixed at build time)
  define: { __SYNTHWAY_SERVER_URL__: JSON.stringify(serverUrl) },
  server: {
    port: 5173,
    watch: onWindowsDrive ? { usePolling: true, interval: 300 } : undefined,
    // `vite preview` reuses these rules
    proxy: {
      '/api': { target: serverUrl, changeOrigin: true },
      '/health': { target: serverUrl, changeOrigin: true },
      '/ws': { target: serverUrl.replace(/^http/, 'ws'), ws: true },
    },
  },
});
