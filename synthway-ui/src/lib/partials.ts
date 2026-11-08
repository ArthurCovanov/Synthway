import { WAVEFORM, type TimbreParams, type Waveform } from '../types';
import type { Envelope, TimbrePartial } from './instruments';
import { PARTIAL_HUES, type NeonHue } from './neon';
import { newId } from './storage';

/** Ratios accepted by synthway-core (synthway_partial_t) */
export const MIN_RATIO = 0.01;
export const MAX_RATIO = 1000;

export function formatRatio(ratio: number): string {
  return `×${Number(ratio.toFixed(3))}`;
}

/**
 * Harmonics hidden in a non-sine waveform, relative to its first one:
 * [multiple of the partial's ratio, relative amplitude]. Same shapes as
 * synthway-core/src/synth/oscillator.c: a square or a triangle has the odd
 * harmonics (1/n, 1/n²), a sawtooth all of them (1/n).
 */
export function waveformHarmonics(waveform: Waveform, maxMultiple: number): [number, number][] {
  const harmonics: [number, number][] = [];
  if (waveform === WAVEFORM.Sine) return harmonics;
  const oddOnly = waveform !== WAVEFORM.Sawtooth;
  for (let n = 2; n <= maxMultiple && harmonics.length < 256; n += 1) {
    if (oddOnly && n % 2 === 0) continue;
    harmonics.push([n, waveform === WAVEFORM.Triangle ? 1 / (n * n) : 1 / n]);
  }
  return harmonics;
}

/**
 * First note (MIDI) at which the partial goes above half the sample rate, where
 * it folds back as another frequency; null if no note up to highestMidi does.
 */
export function aliasingFrom(ratio: number, sampleRate: number, highestMidi: number): number | null {
  const limit = 69 + 12 * Math.log2(sampleRate / 2 / ratio / 440);
  const first = Math.max(0, Math.floor(limit) + 1);
  return first <= highestMidi ? first : null;
}

/** The partials that sound: the inactive ones are only kept for later */
export function activePartials(partials: TimbrePartial[]): TimbrePartial[] {
  return partials.filter((partial) => !partial.muted);
}

/** Highest possible peak of the sum: every active partial at its top at the same time */
export function peakSum(partials: TimbrePartial[]): number {
  return activePartials(partials).reduce((sum, partial) => sum + partial.amplitude, 0);
}

/** First colour no partial uses yet, in PARTIAL_HUES order */
export function nextPartialHue(partials: TimbrePartial[]): NeonHue {
  const used = new Set(partials.map((partial) => partial.hue));
  return PARTIAL_HUES.find((hue) => !used.has(hue)) ?? PARTIAL_HUES[partials.length % PARTIAL_HUES.length];
}

const DEFAULT_ENVELOPE: Envelope = { attack: 0.02, decay: 0.2, sustain: 0.7, release: 0.3 };

/** A new partial on the next free harmonic, at 1/n, with the envelope of `template` */
export function newPartial(partials: TimbrePartial[], template?: TimbrePartial, at?: { ratio: number; amplitude: number }): TimbrePartial {
  const taken = new Set(partials.map((partial) => partial.ratio));
  let harmonic = 1;
  while (taken.has(harmonic)) harmonic += 1;
  const ratio = at?.ratio ?? harmonic;
  return {
    id: newId(),
    ratio,
    amplitude: at?.amplitude ?? Number(Math.max(0.05, Math.min(1, 1 / ratio)).toFixed(2)),
    waveform: WAVEFORM.Sine,
    envelope: { ...(template?.envelope ?? partials[0]?.envelope ?? DEFAULT_ENVELOPE) },
    hue: nextPartialHue(partials),
  };
}

/** Sine partials that add up to the waveform (its first `count` harmonics), all with `envelope` */
export function harmonicSeries(waveform: Waveform, count: number, envelope: Envelope): TimbrePartial[] {
  const series: TimbrePartial[] = [];
  const add = (ratio: number, amplitude: number) =>
    series.push({
      id: newId(),
      ratio,
      amplitude: Number(amplitude.toFixed(3)),
      waveform: WAVEFORM.Sine,
      envelope: { ...envelope },
      hue: PARTIAL_HUES[series.length % PARTIAL_HUES.length],
    });
  add(1, 1);
  for (const [multiple, amplitude] of waveformHarmonics(waveform, count * 2)) {
    if (series.length >= count) break;
    add(multiple, amplitude);
  }
  return series;
}

/** What the engine receives: the active partials, at most maxPartials of them */
export function toTimbre(partials: TimbrePartial[], maxPartials: number): TimbreParams {
  return {
    partials: activePartials(partials).slice(0, maxPartials).map(({ ratio, amplitude, waveform, envelope }) => ({
      ratio,
      amplitude,
      waveform,
      envelope: { ...envelope },
    })),
  };
}
