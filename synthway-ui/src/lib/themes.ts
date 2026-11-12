import { loadJson, saveJson } from './storage';
import { SOURCES } from './themeSources';

// Themes: each folder of src/themes is a theme (see its README). The code
// imports its stylesheets as '@theme/<file>' (vite.config.ts), and each of them
// lands here: the page gets the current theme's version of the file, or the
// default theme's when the theme does not have it. A CSS module's classes are
// named '<file>_<class>' in every theme, so a theme's file replaces the default
// one, rule for rule. Changing theme swaps the text of the stylesheets in place.

export const DEFAULT_THEME = 'default';

const STORAGE_KEY = 'synthway.theme.v1';

type Sources = Record<string, string>;

/** Stylesheets by theme, then by file ('components/Sidebar.module.css') */
function byTheme(sources: Sources): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  for (const [path, css] of Object.entries(sources)) {
    const [theme, ...file] = path.replace(/^\.\.\/themes\//, '').split('/');
    if (!result.has(theme)) result.set(theme, new Map());
    result.get(theme)!.set(file.join('/'), css);
  }
  return result;
}

let themes = byTheme(SOURCES);

/** The themes found in src/themes, the default one first */
export function listThemes(): string[] {
  return [...themes.keys()].sort((a, b) =>
    a === DEFAULT_THEME ? -1 : b === DEFAULT_THEME ? 1 : a.localeCompare(b),
  );
}

/** A theme's name as shown, from its folder: 'retro-light' → 'Retro light' */
export function themeName(folder: string): string {
  const words = folder.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

let current: string = (() => {
  const saved = loadJson<unknown>(STORAGE_KEY, undefined);
  return typeof saved === 'string' && themes.has(saved) ? saved : DEFAULT_THEME;
})();
document.documentElement.dataset.theme = current;

export function getTheme(): string {
  return current;
}

/** One <style> per stylesheet, in the order of the imports: at equal specificity, the later one wins */
const sheets = new Map<string, HTMLStyleElement>();

function cssOf(file: string): string {
  return themes.get(current)?.get(file) ?? themes.get(DEFAULT_THEME)?.get(file) ?? '';
}

function render(): void {
  document.documentElement.dataset.theme = current;
  for (const [file, element] of sheets) {
    element.textContent = cssOf(file);
  }
}

/** Shows a theme, kept for the next visits; an unknown theme gives the default one */
export function setTheme(theme: string): void {
  current = themes.has(theme) ? theme : DEFAULT_THEME;
  saveJson(STORAGE_KEY, current);
  render();
}

/** A CSS module's classes: '<file>_<class>', whatever the theme (vite.config.ts) */
function classNames(file: string): Readonly<Record<string, string>> {
  const prefix = file.slice(file.lastIndexOf('/') + 1).replace(/\.module\.css$/, '');
  return new Proxy<Record<string, string>>(
    {},
    { get: (_target, name) => (typeof name === 'string' ? `${prefix}_${name}` : undefined) },
  );
}

/**
 * Puts a stylesheet of the theme in the page, once: what an '@theme/<file>'
 * import does (vite.config.ts). Returns its class names, for a CSS module.
 */
export function stylesheet(file: string): Readonly<Record<string, string>> {
  if (!sheets.has(file)) {
    const element = document.createElement('style');
    element.dataset.themeFile = file;
    element.textContent = cssOf(file);
    document.head.appendChild(element);
    sheets.set(file, element);
  }
  return classNames(file);
}

if (import.meta.hot) {
  // Development: an edited stylesheet, or a theme added, shows up in place
  import.meta.hot.accept('./themeSources', (module) => {
    if (module) {
      themes = byTheme(module.SOURCES as Sources);
      if (!themes.has(current)) current = DEFAULT_THEME;
      render();
    }
  });
}
