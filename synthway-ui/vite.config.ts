import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Synthway's version, shown by the UI: package.json's, its single source
// (the Windows package is named after it too)
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

// Under WSL, a project stored on the Windows drive (/mnt/c/...) does not get
// file change events for edits made from Windows: poll so that HMR still works.
const onWindowsDrive = process.cwd().startsWith('/mnt/');

// Themes (src/themes/<theme>/, see src/lib/themes.ts). The code imports its
// stylesheets as '@theme/<file>', e.g. '@theme/components/Sidebar.module.css':
// each such import becomes a module that hands the file to src/lib/themes.ts,
// which puts in the page the current theme's version of it, or the default
// theme's. Since those modules are evaluated where the imports are, the
// stylesheets keep the order of the imports, as plain CSS imports would.
const THEME_IMPORT = '@theme/';
const THEME_MODULE = '\0synthway-theme:';
const themesLib = normalizePath(fileURLToPath(new URL('./src/lib/themes.ts', import.meta.url)));

function themes(): Plugin {
  return {
    name: 'synthway-themes',
    enforce: 'pre',
    // '.js' at the end, or Vite would take the module for a stylesheet
    resolveId(id) {
      return id.startsWith(THEME_IMPORT) ? `${THEME_MODULE}${id.slice(THEME_IMPORT.length)}.js` : null;
    },
    load(id) {
      if (!id.startsWith(THEME_MODULE)) return null;
      const file = JSON.stringify(id.slice(THEME_MODULE.length, -'.js'.length));
      return `import { stylesheet } from ${JSON.stringify(themesLib)};\nexport default stylesheet(${file});\n`;
    },
    transform(code, id) {
      // The class names of a CSS module are worked out by themes.ts, which does not see composes
      if (/\/src\/themes\/.*\.css(\?|$)/.test(id) && /^\s*composes\s*:/m.test(code)) {
        this.error(`${id.split('?')[0]}: "composes" is not supported in themes, list the selectors together instead`);
      }
      return null;
    },
  };
}

// synthway-server address. Dev server: its default port, 18741. Build: empty,
// the page calls its own origin, since synthway-server serves the built page
// itself (synthway-ui/dist). Overridable when the server runs elsewhere, e.g.
// the silent mock server: SYNTHWAY_SERVER_URL=http://127.0.0.1:18742 npm run dev
// The browser calls it directly (see src/lib/api.ts): Vite only serves the page.
export default defineConfig(({ command }) => {
  const serverUrl = process.env.SYNTHWAY_SERVER_URL ?? (command === 'build' ? '' : 'http://127.0.0.1:18741');
  return {
    plugins: [themes(), react()],
    // Where the UI calls the server, fixed when Vite starts or builds; the version
    define: { __SYNTHWAY_SERVER_URL__: JSON.stringify(serverUrl), __SYNTHWAY_VERSION__: JSON.stringify(version) },
    css: {
      modules: {
        // '<file>_<class>' (Sidebar_root), the same in every theme: a theme's
        // Sidebar.module.css replaces the default one, and its classes keep their names
        generateScopedName: (name, filename) =>
          `${basename(filename.split('?')[0]).replace(/\.module\.css$/, '')}_${name}`,
      },
    },
    // The themes' stylesheets travel inside the script (src/lib/themeSources.ts)
    build: { chunkSizeWarningLimit: 800 },
    server: {
      port: 5173,
      watch: onWindowsDrive ? { usePolling: true, interval: 300 } : undefined,
    },
  };
});
