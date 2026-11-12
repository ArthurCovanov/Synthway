// Accent colours available to instruments, tracks and partials: the logo's
// neons first, then brighter colours that tell partials apart at a glance

export type NeonHue =
  | 'pink'
  | 'magenta'
  | 'violet'
  | 'blue'
  | 'cyan'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'white';

export const HUES: NeonHue[] = ['pink', 'magenta', 'violet', 'blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'white'];

/** Order in which new partials take their colour: white for the fundamental, then the most contrasted ones */
export const PARTIAL_HUES: NeonHue[] = ['pink', 'magenta', 'violet', 'blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'white'];

/**
 * Colours of the graphs, from the theme: usable as an SVG attribute or a
 * style; a canvas reads them with themeColor()
 */
export const HUE_DRAW: Record<NeonHue, string> = {
  pink: 'var(--neon-pink)',
  magenta: 'var(--neon-magenta)',
  violet: 'var(--neon-violet)',
  blue: 'var(--neon-blue-mid)',
  cyan: 'var(--neon-cyan)',
  green: 'var(--neon-green)',
  yellow: 'var(--neon-yellow)',
  orange: 'var(--neon-orange)',
  red: 'var(--neon-red)',
  white: 'var(--neon-white)',
};

/** Value of a theme variable ('--grid' or 'var(--grid)') where `element` is, for a canvas */
export function themeColor(element: Element, variable: string): string {
  const name = /^var\((--[\w-]+)\)$/.exec(variable)?.[1] ?? variable;
  return getComputedStyle(element).getPropertyValue(name).trim();
}

/** Theme variables, for CSS (blue uses its brighter variant to stay readable) */
export const HUE_VAR: Record<NeonHue, string> = {
  pink: 'var(--neon-pink)',
  magenta: 'var(--neon-magenta)',
  violet: 'var(--neon-violet)',
  blue: 'var(--neon-blue-soft)',
  cyan: 'var(--neon-cyan)',
  green: 'var(--neon-green)',
  yellow: 'var(--neon-yellow)',
  orange: 'var(--neon-orange)',
  red: 'var(--neon-red)',
  white: 'var(--neon-white)',
};
// The name of each hue, shown by the Instrument Creator: instruments.hue.<hue> in the locale files
