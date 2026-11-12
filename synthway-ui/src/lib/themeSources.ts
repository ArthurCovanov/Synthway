// The stylesheets of every theme, as text, by path ('../themes/<theme>/<file>').
// Kept apart from themes.ts so that, in development, an edited stylesheet or a
// new theme is swapped in without reloading the page: themes.ts accepts the
// updates of this module.
export const SOURCES = import.meta.glob<string>('../themes/*/**/*.css', {
  query: '?inline',
  import: 'default',
  eager: true,
});
