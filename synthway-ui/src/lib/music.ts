import { WAVEFORM, type Waveform } from '../types';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToName(midi: number): string {
  const pitchClass = ((midi % 12) + 12) % 12;
  return `${NOTE_NAMES[pitchClass]}${Math.floor(midi / 12) - 1}`;
}

export function isBlackKey(midi: number): boolean {
  const pitchClass = ((midi % 12) + 12) % 12;
  return [1, 3, 6, 8, 10].includes(pitchClass);
}

/** French names of NOTE_NAMES */
export const SOLFEGE_NAMES = ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];

export interface NoteReading {
  midi: number;
  /** C, C#… */
  name: string;
  octave: number;
  /** Do, Do♯… */
  solfege: string;
  /** Gap to the equal-tempered note, in [-50, 50] */
  cents: number;
}

/** Nearest equal-tempered note of a frequency, with A4 tuned to `a4` Hz */
export function frequencyToNote(frequency: number, a4 = 440): NoteReading | null {
  if (!(frequency > 0)) return null;
  const exact = 69 + 12 * Math.log2(frequency / a4);
  const midi = Math.round(exact);
  const pitchClass = ((midi % 12) + 12) % 12;
  return {
    midi,
    name: NOTE_NAMES[pitchClass],
    octave: Math.floor(midi / 12) - 1,
    solfege: SOLFEGE_NAMES[pitchClass],
    cents: (exact - midi) * 100,
  };
}

/** Nearest harmonic of a ratio to the fundamental, and the gap to it in cents (null below the fundamental) */
export function harmonicGap(ratio: number): { harmonic: number; cents: number } | null {
  if (!(ratio >= 0.75)) return null;
  const harmonic = Math.max(1, Math.round(ratio));
  return { harmonic, cents: 1200 * Math.log2(ratio / harmonic) };
}

/** "+3.2" / "−12.0": cents with an explicit sign */
export function formatCents(cents: number, decimals = 1): string {
  const text = Math.abs(cents).toFixed(decimals);
  if (Number(text) === 0) return `±${text}`;
  return `${cents > 0 ? '+' : '−'}${text}`;
}

export const WAVEFORM_OPTIONS: { value: Waveform; label: string; short: string }[] = [
  { value: WAVEFORM.Sine, label: 'Sinus', short: 'SIN' },
  { value: WAVEFORM.Square, label: 'Carré', short: 'SQR' },
  { value: WAVEFORM.Triangle, label: 'Triangle', short: 'TRI' },
  { value: WAVEFORM.Sawtooth, label: 'Dent de scie', short: 'SAW' },
];

const TWO_PI = Math.PI * 2;

/** One sample in [-1, 1] at `phase` (radians), same shapes as synthway-core/src/synth/oscillator.c */
export function sampleWave(waveform: Waveform, phase: number): number {
  const p = ((phase % TWO_PI) + TWO_PI) % TWO_PI;
  switch (waveform) {
    case WAVEFORM.Square:
      return p < Math.PI ? 1 : -1;
    case WAVEFORM.Triangle:
      return p <= Math.PI ? (2 / Math.PI) * p - 1 : 1 - (2 / Math.PI) * (p - Math.PI);
    case WAVEFORM.Sawtooth:
      return p / Math.PI - 1;
    default:
      return Math.sin(p);
  }
}

/** SVG path of `cycles` periods of a waveform, inside a width x height box */
export function wavePath(waveform: Waveform, width: number, height: number, cycles = 1.5): string {
  const steps = 160;
  const mid = height / 2;
  const amp = height * 0.42;
  let d = '';
  for (let i = 0; i <= steps; i += 1) {
    const x = (i / steps) * width;
    const y = mid - sampleWave(waveform, (i / steps) * cycles * TWO_PI) * amp;
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}
