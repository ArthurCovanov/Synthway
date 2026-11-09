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

/** Raw values, for canvas drawing */
export const HUE_HEX: Record<NeonHue, string> = {
  pink: '#ff1aa8',
  magenta: '#f21cf0',
  violet: '#a31cff',
  blue: '#5f78ff',
  cyan: '#22e6ff',
  green: '#39ff88',
  yellow: '#ffe94a',
  orange: '#ff9b2f',
  red: '#ff3d4d',
  white: '#f4f0ff',
};

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
