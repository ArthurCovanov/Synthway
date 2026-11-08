import { ENVELOPE_CURVE, WAVEFORM, type EnvelopeCurve, type Waveform } from '../types';
import { HUES, PARTIAL_HUES, type NeonHue } from './neon';
import { newId } from './storage';

/** Times in seconds, sustain level in [0, 1] */
export interface Envelope {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** How the decay and the release fall; absent: linear (instruments saved before it) */
  curve?: EnvelopeCurve;
}

/**
 * Level of an envelope, in [0, 1], t seconds after the note starts, the note
 * being released at noteOff: as the engine plays it (an exponential segment
 * falls 60 dB in its time, then stops)
 */
export function envelopeLevel(envelope: Envelope, t: number, noteOff: number): number {
  const { attack, decay, sustain, release } = envelope;
  const exponential = envelope.curve === ENVELOPE_CURVE.Exponential;
  const held = (time: number) => {
    if (time < attack) return time / attack;
    const since = time - attack;
    if (exponential) return decay > 0 ? sustain + (1 - sustain) * Math.pow(10, (-3 * since) / decay) : sustain;
    return since < decay ? 1 - ((1 - sustain) * since) / decay : sustain;
  };
  if (t <= noteOff) return held(t);
  const since = t - noteOff;
  if (release <= 0 || since >= release) return 0;
  return exponential ? held(noteOff) * Math.pow(10, (-3 * since) / release) : held(noteOff) * (1 - since / release);
}

/** Moments to draw an envelope at, up to total: its corners, and enough in between for its curves */
export function envelopeTimes(envelope: Envelope, noteOff: number, total: number, steps = 96): number[] {
  const corners = [envelope.attack, envelope.attack + envelope.decay, noteOff, noteOff + envelope.release];
  const times = Array.from({ length: steps + 1 }, (_, i) => (total * i) / steps);
  for (const corner of corners) if (corner > 0 && corner < total) times.push(corner);
  return times.sort((a, b) => a - b);
}

export interface FilterSettings {
  lowCutoff: number; // Hz
  cutoff: number; // Hz
  resonance: number; // [0, 1]
}

export type InstrumentCategory = 'lead' | 'bass' | 'pad' | 'pluck' | 'fx';

export const CATEGORY_LABEL: Record<InstrumentCategory, string> = {
  lead: 'Lead',
  bass: 'Basse',
  pad: 'Nappe',
  pluck: 'Pluck',
  fx: 'FX',
};

/** One partial: its own oscillator and envelope (synthway_partial_t) */
export interface TimbrePartial {
  id: string;
  /** Frequency relative to the note played: 1 is the note, 2 its octave, 2.76 an inharmonic partial */
  ratio: number;
  amplitude: number; // [0, 1]
  waveform: Waveform;
  envelope: Envelope;
  /** Colour on the graphs, kept when the partial moves */
  hue: NeonHue;
  /** Inactive: kept in the list and on the spectrum, but neither played nor summed */
  muted?: boolean;
  /** Locked: nothing about this partial can be changed, nor can it be deleted */
  locked?: boolean;
}

// The partials (the instrument's timbre), volume, and band-pass filter reach the engine.
export interface Instrument {
  id: string;
  name: string;
  description: string;
  category: InstrumentCategory;
  hue: NeonHue;
  volume: number;
  partials: TimbrePartial[];
  filter: FilterSettings;
  /** Lowest octave of the keyboard, the last one played (MIN_OCTAVE to MAX_OCTAVE); absent: DEFAULT_OCTAVE */
  octave?: number;
  /** Locked: read only, like a saved version; it still plays, and a copy can be edited */
  locked?: boolean;
}

/** Octaves the keyboard of the Instrument Creator can start from: it shows two, from C of that octave */
export const MIN_OCTAVE = 1;
export const MAX_OCTAVE = 6;
export const DEFAULT_OCTAVE = 4;

/** The keyboard octave for a note's octave, or the one an instrument keeps: within MIN_OCTAVE and MAX_OCTAVE */
export function keyboardOctave(octave: number | undefined): number {
  return octave === undefined || !Number.isFinite(octave)
    ? DEFAULT_OCTAVE
    : Math.min(MAX_OCTAVE, Math.max(MIN_OCTAVE, Math.round(octave)));
}

/** Partials of a preset, given as [ratio, amplitude, envelope]: sines, coloured in PARTIAL_HUES order */
function partials(list: [number, number, Envelope][], waveform: Waveform = WAVEFORM.Sine): TimbrePartial[] {
  return list.map(([ratio, amplitude, envelope], index) => ({
    id: `p${index + 1}`,
    ratio,
    amplitude,
    waveform,
    envelope,
    hue: PARTIAL_HUES[index % PARTIAL_HUES.length],
  }));
}

/** One partial at the note's frequency: what an instrument was before partials existed */
function single(waveform: Waveform, envelope: Envelope): TimbrePartial[] {
  return partials([[1, 1, envelope]], waveform);
}

const bellEnvelope = (decay: number): Envelope => ({ attack: 0.002, decay, sustain: 0, release: 0.8 });
const stringEnvelope = (harmonic: number): Envelope => ({
  attack: 0.003,
  decay: Number((1.6 / Math.pow(harmonic, 0.6)).toFixed(2)),
  sustain: 0,
  release: 0.15,
});
const organEnvelope: Envelope = { attack: 0.02, decay: 0.1, sustain: 0.9, release: 0.12 };

export const PRESET_INSTRUMENTS: Instrument[] = [
  {
    id: 'neon-lead',
    name: 'Neon Lead',
    description: 'Dent de scie tranchante, taillée pour les mélodies.',
    category: 'lead',
    hue: 'pink',
    volume: 0.3,
    partials: single(WAVEFORM.Sawtooth, { attack: 0.01, decay: 0.25, sustain: 0.7, release: 0.35 }),
    filter: { lowCutoff: 20, cutoff: 6500, resonance: 0.35 },
  },
  {
    id: 'rain-city-bass',
    name: 'Rain City Bass',
    description: 'Carré profond et sombre, pour poser le groove.',
    category: 'bass',
    hue: 'blue',
    volume: 0.35,
    partials: single(WAVEFORM.Square, { attack: 0.005, decay: 0.3, sustain: 0.6, release: 0.2 }),
    filter: { lowCutoff: 20, cutoff: 900, resonance: 0.45 },
  },
  {
    id: 'haze-pad',
    name: 'Haze Pad',
    description: 'Nappe triangulaire lente, comme une brume au néon.',
    category: 'pad',
    hue: 'violet',
    volume: 0.25,
    partials: single(WAVEFORM.Triangle, { attack: 0.9, decay: 0.6, sustain: 0.8, release: 1.6 }),
    filter: { lowCutoff: 20, cutoff: 3200, resonance: 0.15 },
  },
  {
    id: 'hologram-sine',
    name: 'Hologram Sine',
    description: 'Sinusoïde pure et cristalline, sans une harmonique de trop.',
    category: 'lead',
    hue: 'magenta',
    volume: 0.35,
    partials: single(WAVEFORM.Sine, { attack: 0.03, decay: 0.2, sustain: 0.85, release: 0.5 }),
    filter: { lowCutoff: 20, cutoff: 12000, resonance: 0.05 },
  },
  {
    id: 'chrome-pluck',
    name: 'Chrome Pluck',
    description: 'Attaque sèche et déclin court, pour les arpèges.',
    category: 'pluck',
    hue: 'blue',
    volume: 0.3,
    partials: single(WAVEFORM.Sawtooth, { attack: 0.002, decay: 0.18, sustain: 0, release: 0.12 }),
    filter: { lowCutoff: 20, cutoff: 4200, resonance: 0.55 },
  },
  {
    id: 'siren-fx',
    name: 'Siren FX',
    description: 'Carré strident pour les alarmes et les effets.',
    category: 'fx',
    hue: 'pink',
    volume: 0.2,
    partials: single(WAVEFORM.Square, { attack: 0.05, decay: 0.1, sustain: 1, release: 0.8 }),
    filter: { lowCutoff: 20, cutoff: 8000, resonance: 0.7 },
  },
  {
    id: 'glass-organ',
    name: 'Glass Organ',
    description: 'Six harmoniques tenues, comme les tirettes d’un orgue.',
    category: 'pad',
    hue: 'cyan',
    volume: 0.28,
    partials: partials([
      [1, 0.8, organEnvelope],
      [2, 0.6, organEnvelope],
      [3, 0.45, organEnvelope],
      [4, 0.3, organEnvelope],
      [6, 0.2, organEnvelope],
      [8, 0.15, organEnvelope],
    ]),
    filter: { lowCutoff: 20, cutoff: 9000, resonance: 0.1 },
  },
  {
    id: 'plucked-string',
    name: 'Plucked String',
    description: 'Huit harmoniques en 1/n : les aiguës s’éteignent d’abord.',
    category: 'pluck',
    hue: 'yellow',
    volume: 0.28,
    partials: partials(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, Number((1 / n).toFixed(2)), stringEnvelope(n)] as [number, number, Envelope]),
    ),
    filter: { lowCutoff: 20, cutoff: 7000, resonance: 0.2 },
  },
  {
    id: 'neon-bell',
    name: 'Neon Bell',
    description: 'Partiels inharmoniques de cloche, chacun avec sa propre durée.',
    category: 'fx',
    hue: 'green',
    volume: 0.3,
    partials: partials([
      [0.5, 0.35, bellEnvelope(3.5)],
      [1, 0.6, bellEnvelope(3)],
      [1.19, 0.35, bellEnvelope(2.4)],
      [1.5, 0.25, bellEnvelope(2)],
      [2, 0.45, bellEnvelope(1.8)],
      [2.76, 0.2, bellEnvelope(1.1)],
      [5.4, 0.12, bellEnvelope(0.6)],
      [8.93, 0.07, bellEnvelope(0.35)],
    ]),
    filter: { lowCutoff: 20, cutoff: 12000, resonance: 0.05 },
  },
];

export function createInstrument(): Instrument {
  return {
    id: newId(),
    name: 'Nouvel instrument',
    description: 'À toi de sculpter son caractère.',
    category: 'lead',
    hue: 'violet',
    volume: 0.3,
    partials: single(WAVEFORM.Sine, { attack: 0.02, decay: 0.2, sustain: 0.7, release: 0.3 }),
    filter: { lowCutoff: 20, cutoff: 8000, resonance: 0.2 },
  };
}

/** Envelope of the partials of an instrument made from an analysis, until each gets its own: the measured spectrum, held */
const MEASURED_ENVELOPE: Envelope = { attack: 0.01, decay: 0, sustain: 1, release: 0.2 };
/** Highest peak the sum of its partials may reach at once, at the instrument's volume */
const MEASURED_PEAK = 0.8;

/**
 * An instrument made of partials measured by the Analyzer: their ratio to the
 * note and their amplitude, as sines, each with the envelope measured on a
 * note (else all with one held envelope). Its volume keeps the sum of the
 * partials from saturating; its filter is wide open, the measured spectrum
 * already holds the sound's own. Its keyboard starts at noteOctave, the
 * octave of the note analyzed (within the keyboard's).
 */
export function instrumentFromPartials(
  name: string,
  description: string,
  measured: { ratio: number; amplitude: number; envelope?: Envelope }[],
  noteOctave?: number,
): Instrument {
  const kept = measured.filter((partial) => partial.ratio > 0 && partial.ratio <= 1000 && partial.amplitude > 0);
  const total = kept.reduce((sum, partial) => sum + partial.amplitude, 0);
  return {
    id: newId(),
    name,
    description,
    category: 'lead',
    hue: 'green',
    volume: Number(Math.min(0.3, Math.max(0.05, MEASURED_PEAK / Math.max(total, 1e-6))).toFixed(2)),
    partials: partials(
      kept.map((partial) => [
        Number(partial.ratio.toFixed(4)),
        Math.max(0.001, Number(partial.amplitude.toFixed(3))),
        { ...(partial.envelope ?? MEASURED_ENVELOPE) },
      ]),
    ),
    filter: { lowCutoff: 20, cutoff: 20000, resonance: 0 },
    octave: keyboardOctave(noteOctave),
  };
}

export function duplicateInstrument(source: Instrument): Instrument {
  return {
    ...source,
    id: newId(),
    name: `${source.name} (copie)`,
    partials: source.partials.map((partial) => ({ ...partial, envelope: { ...partial.envelope } })),
    filter: { ...source.filter },
    // The copy of a locked instrument is the one to edit
    locked: false,
  };
}

/** Instruments saved before partials existed had one waveform and one envelope: they become one partial */
type SavedInstrument = Omit<Instrument, 'partials'> & {
  partials?: TimbrePartial[];
  waveform?: Waveform;
  envelope?: Envelope;
};

/** Presets that came with partials: added once to libraries saved before them */
const ADDITIVE_PRESET_IDS = ['glass-organ', 'plucked-string', 'neon-bell'];

export function migrateInstruments(saved: unknown): Instrument[] {
  if (!Array.isArray(saved) || saved.length === 0) {
    return PRESET_INSTRUMENTS.map((instrument) => ({ ...instrument }));
  }
  const list = saved as SavedInstrument[];
  const migrated: Instrument[] = list.map(({ waveform, envelope, partials: savedPartials, ...instrument }) => ({
    ...instrument,
    filter: { ...(instrument.filter ?? { cutoff: 12000, resonance: 0 }), lowCutoff: instrument.filter?.lowCutoff ?? 20 },
    hue: HUES.includes(instrument.hue) ? instrument.hue : 'violet',
    partials: Array.isArray(savedPartials)
      ? savedPartials
      : single(waveform ?? WAVEFORM.Sine, envelope ?? { attack: 0.005, decay: 0, sustain: 1, release: 0.01 }),
  }));
  if (list.some((instrument) => !Array.isArray(instrument.partials))) {
    const ids = new Set(migrated.map((instrument) => instrument.id));
    migrated.push(
      ...PRESET_INSTRUMENTS.filter((preset) => ADDITIVE_PRESET_IDS.includes(preset.id) && !ids.has(preset.id)),
    );
  }
  return migrated;
}
