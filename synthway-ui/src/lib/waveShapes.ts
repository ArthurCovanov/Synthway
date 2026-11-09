import { formatNumber, t } from '../i18n';
import { WAVE_SHAPE, type ShapeFit, type WaveformFit, type WaveShape } from '../types';

/*
 * Waveform profiles of the Analyzer: the shapes synthway-core compares a
 * note's harmonics with (synthway_analyzer_fit_waveform), and an instrument
 * made of one of them. Same formulas as synthway-core/src/analysis/waveform.c.
 */

// Getters: the texts are read in the current language each time
export const SHAPE_LABELS: Record<WaveShape, string> = {
  get [WAVE_SHAPE.Sine]() {
    return t('waveShapes.label.sine');
  },
  get [WAVE_SHAPE.Square]() {
    return t('waveShapes.label.square');
  },
  get [WAVE_SHAPE.Triangle]() {
    return t('waveShapes.label.triangle');
  },
  get [WAVE_SHAPE.Sawtooth]() {
    return t('waveShapes.label.sawtooth');
  },
  get [WAVE_SHAPE.Pulse]() {
    return t('waveShapes.label.pulse');
  },
};

/** What makes each shape, in a few words */
export const SHAPE_HINTS: Record<WaveShape, string> = {
  get [WAVE_SHAPE.Sine]() {
    return t('waveShapes.hint.sine');
  },
  get [WAVE_SHAPE.Square]() {
    return t('waveShapes.hint.square');
  },
  get [WAVE_SHAPE.Triangle]() {
    return t('waveShapes.hint.triangle');
  },
  get [WAVE_SHAPE.Sawtooth]() {
    return t('waveShapes.hint.sawtooth');
  },
  get [WAVE_SHAPE.Pulse]() {
    return t('waveShapes.hint.pulse');
  },
};

/** What the trial instrument is made of: the partials measured, the closest shape, or one shape */
export type BuildFrom = 'measured' | 'auto' | 'sine' | 'square' | 'triangle' | 'sawtooth' | 'pulse';

export const BUILD_FROM_SHAPE: Record<Exclude<BuildFrom, 'measured' | 'auto'>, WaveShape> = {
  sine: WAVE_SHAPE.Sine,
  square: WAVE_SHAPE.Square,
  triangle: WAVE_SHAPE.Triangle,
  sawtooth: WAVE_SHAPE.Sawtooth,
  pulse: WAVE_SHAPE.Pulse,
};

export const BUILD_FROM_OPTIONS: { value: BuildFrom; label: string }[] = (
  ['measured', 'auto', 'sawtooth', 'square', 'triangle', 'pulse', 'sine'] as const
).map((value) => ({
  value,
  get label() {
    if (value === 'measured') return t('waveShapes.measured');
    if (value === 'auto') return t('waveShapes.auto');
    return SHAPE_LABELS[BUILD_FROM_SHAPE[value]];
  },
}));

/** The fit a choice takes: the closest one for « auto », that shape's otherwise; null for the partials measured */
export function chosenFit(fit: WaveformFit | null, from: BuildFrom): ShapeFit | null {
  if (!fit || fit.fits.length === 0 || from === 'measured') return null;
  if (from === 'auto') return fit.fits[0];
  return fit.fits.find((candidate) => candidate.shape === BUILD_FROM_SHAPE[from]) ?? null;
}

/** Below this gap, a shape matches the harmonics measured well; above GAP_POOR, none does */
export const GAP_GOOD_DB = 3;
export const GAP_POOR_DB = 5;

const MISSING_DB = -200;

/** Level in dB of harmonic n (from 1) of a shape, relative to its 1st; MISSING_DB for one it lacks */
export function shapeDb(shape: WaveShape, duty: number, n: number): number {
  switch (shape) {
    case WAVE_SHAPE.Sine:
      return n === 1 ? 0 : MISSING_DB;
    case WAVE_SHAPE.Square:
      return n % 2 ? -20 * Math.log10(n) : MISSING_DB;
    case WAVE_SHAPE.Triangle:
      return n % 2 ? -40 * Math.log10(n) : MISSING_DB;
    case WAVE_SHAPE.Sawtooth:
      return -20 * Math.log10(n);
    case WAVE_SHAPE.Pulse: {
      const first = Math.abs(Math.sin(Math.PI * duty));
      const amplitude = Math.abs(Math.sin(Math.PI * n * duty)) / n;
      return first > 0 && amplitude >= first * 1e-10 ? 20 * Math.log10(amplitude / first) : MISSING_DB;
    }
    default:
      return MISSING_DB;
  }
}

/** Response in dB of the engine's low-pass (RBJ biquad, synthway_engine_set_filter) at frequency */
export function lowpassDb(frequency: number, cutoff: number, resonance: number, sampleRate = 48000): number {
  if (!(cutoff > 0)) return 0;
  const q = 0.70710678 + resonance * 9.29289322;
  const x = Math.tan((Math.PI * frequency) / sampleRate) / Math.tan((Math.PI * cutoff) / sampleRate);
  const a = 1 - x * x;
  const b = x / q;
  return -10 * Math.log10(a * a + b * b);
}

/** The shape's level for each harmonic measured, through its low-pass, raised to the measured levels (as the core fits it) */
export function fitLevels(fit: WaveformFit, shape: ShapeFit): number[] {
  const model = fit.harmonics.map((_, k) => {
    const base = shapeDb(shape.shape, shape.duty, k + 1);
    return base <= MISSING_DB ? MISSING_DB : base + lowpassDb((k + 1) * fit.frequency, shape.cutoff, shape.resonance);
  });
  const gaps = fit.harmonics
    .map((harmonic, k) => (harmonic.state === 0 && model[k] > MISSING_DB / 2 ? harmonic.level - model[k] : null))
    .filter((gap): gap is number => gap !== null)
    .sort((a, b) => a - b);
  const gain = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  return model.map((level) => (level <= MISSING_DB ? MISSING_DB : level + gain));
}

/** Harmonics of an instrument made of a shape: up to 20 kHz on the note analyzed, 64 at most */
const SHAPE_HIGHEST_HZ = 20000;
const SHAPE_MAX_PARTIALS = 64;
/** Harmonics this far below the strongest, through the low-pass at the note analyzed, are left out */
const SHAPE_RANGE_DB = 60;

/** The partials of an instrument made of a shape played at noteHz: its harmonics, as sines; the low-pass goes to the filter */
export function shapePartials(shape: ShapeFit, noteHz: number): { ratio: number; amplitude: number }[] {
  const count = Math.max(1, Math.min(SHAPE_MAX_PARTIALS, Math.floor(SHAPE_HIGHEST_HZ / Math.max(noteHz, 1))));
  const partials: { ratio: number; amplitude: number }[] = [];
  for (let n = 1; n <= count; n += 1) {
    const level = shapeDb(shape.shape, shape.duty, n);
    if (level <= MISSING_DB) continue;
    if (level + lowpassDb(n * noteHz, shape.cutoff, shape.resonance) < -SHAPE_RANGE_DB) continue;
    partials.push({ ratio: n, amplitude: 10 ** (level / 20) });
  }
  return partials;
}

export function formatHz(hz: number): string {
  return hz >= 1000 ? `${formatNumber(hz / 1000, { maximumFractionDigits: 1 })} kHz` : `${Math.round(hz)} Hz`;
}

/** "Sawtooth, low-pass 5.6 kHz", "Pulse 25%", "Square", in the current language */
export function describeShape(shape: ShapeFit): string {
  const label = SHAPE_LABELS[shape.shape];
  const name =
    shape.shape === WAVE_SHAPE.Pulse ? t('waveShapes.pulse', { name: label, percent: Math.round(shape.duty * 100) }) : label;
  if (!(shape.cutoff > 0)) return name;
  const cutoff = formatHz(shape.cutoff);
  return shape.resonance > 0
    ? t('waveShapes.lowpassResonance', { name, cutoff, resonance: Math.round(shape.resonance * 100) })
    : t('waveShapes.lowpass', { name, cutoff });
}
