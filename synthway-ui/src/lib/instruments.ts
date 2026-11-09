import { LANGUAGES, t, translate, type MessageKey } from '../i18n';
import { ATTACK_CURVE, ENVELOPE_CURVE, WAVEFORM, type AttackCurve, type EnvelopeCurve, type UnisonParams, type Waveform } from '../types';
import { HUES, PARTIAL_HUES, type NeonHue } from './neon';
import { loadJson, newId, saveJson } from './storage';

/** Times in seconds, sustain level in [0, 1] */
export interface Envelope {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** How the decay falls; absent: linear (instruments saved before it) */
  curve?: EnvelopeCurve;
  /** How the attack rises; absent: a straight ramp */
  attack_curve?: AttackCurve;
  /** How the release falls; absent: like the decay (instruments saved before each segment had its own) */
  release_curve?: EnvelopeCurve;
}

/** The release's curve: its own, or the decay's for an envelope saved before it had one */
export function releaseCurveOf(envelope: Envelope): EnvelopeCurve {
  return envelope.release_curve ?? envelope.curve ?? ENVELOPE_CURVE.Linear;
}

/**
 * Level of an envelope, in [0, 1], t seconds after the note starts, the note
 * being released at noteOff: as the engine plays it (an exponential segment
 * falls 60 dB in its time, then stops)
 */
export function envelopeLevel(envelope: Envelope, t: number, noteOff: number): number {
  const { attack, decay, sustain, release } = envelope;
  const exponential = envelope.curve === ENVELOPE_CURVE.Exponential;
  const exponentialRelease = releaseCurveOf(envelope) === ENVELOPE_CURVE.Exponential;
  const convex = envelope.attack_curve === ATTACK_CURVE.Convex;
  const held = (time: number) => {
    if (time < attack) return convex ? (time / attack) ** 2 : time / attack;
    const since = time - attack;
    if (exponential) return decay > 0 ? sustain + (1 - sustain) * Math.pow(10, (-3 * since) / decay) : sustain;
    return since < decay ? 1 - ((1 - sustain) * since) / decay : sustain;
  };
  if (t <= noteOff) return held(t);
  const since = t - noteOff;
  if (release <= 0 || since >= release) return 0;
  return exponentialRelease ? held(noteOff) * Math.pow(10, (-3 * since) / release) : held(noteOff) * (1 - since / release);
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

/** Each label is read in the current language each time */
export const CATEGORY_LABEL: Record<InstrumentCategory, string> = {
  get lead() {
    return t('instruments.category.lead');
  },
  get bass() {
    return t('instruments.category.bass');
  },
  get pad() {
    return t('instruments.category.pad');
  },
  get pluck() {
    return t('instruments.category.pluck');
  },
  get fx() {
    return t('instruments.category.fx');
  },
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

// The partials (the instrument's timbre), volume, band-pass filter, reverb and unison reach the engine.
export interface Instrument {
  id: string;
  name: string;
  description: string;
  category: InstrumentCategory;
  hue: NeonHue;
  volume: number;
  partials: TimbrePartial[];
  filter: FilterSettings;
  /** Share of reverberated sound, 0 to 1 (synthway_engine_set_reverb); absent: none */
  reverb?: number;
  /** Each partial played by several detuned voices (synthway_engine_set_unison); absent: none */
  unison?: UnisonParams;
  /** Lowest octave of the keyboard, the last one played (MIN_OCTAVE to MAX_OCTAVE); absent: DEFAULT_OCTAVE */
  octave?: number;
  /** Locked: read only, like a saved version; it still plays, and a copy can be edited */
  locked?: boolean;
}

/** No unison: one voice per partial, the engine's default */
export const NO_UNISON: UnisonParams = { voices: 1, detune: 0, spread: 0 };

/** The unison an instrument plays with: NO_UNISON when it has none */
export function unisonOf(instrument: Instrument): UnisonParams {
  return instrument.unison ?? NO_UNISON;
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
/** Measured on the A5 of « Chasing Shadows » (other stem, 96.2 s): the level comes back after each kick
    along the square of a straight ramp, full after 90 ms */
const shadowEnvelope: Envelope = { attack: 0.09, decay: 0, sustain: 1, release: 0.05, attack_curve: ATTACK_CURVE.Convex };
/** Its harmonics 1 to 12, relative to the first: a sawtooth whose highs fall off faster (a low-pass) */
const SHADOW_HARMONICS = [1, 0.423, 0.169, 0.107, 0.068, 0.041, 0.033, 0.021, 0.014, 0.009, 0.008, 0.006];
/** The chord A5 + D6 of the same beat, as harmonics of D4 (×3 and ×4) with their own harmonics:
    measured by the core on 116.28-116.78 s, after the kick, where only that chord plays */
const SHADOW_CHORD_HARMONICS: [number, number][] = [
  [1, 0.17], [2, 0.19], [3, 1], [4, 0.92], [6, 0.44], [8, 0.33], [9, 0.2], [12, 0.21],
  [15, 0.08], [16, 0.09], [18, 0.05], [20, 0.04], [21, 0.03], [24, 0.03],
];
const shadowChordEnvelope: Envelope = {
  attack: 0.09,
  decay: 0,
  sustain: 1,
  release: 0.05,
  curve: ENVELOPE_CURVE.Exponential,
  attack_curve: ATTACK_CURVE.Convex,
  release_curve: ENVELOPE_CURVE.Exponential,
};

/** Their descriptions are read in the current language each time: a copy keeps the one of when it was made */
export const PRESET_INSTRUMENTS: Instrument[] = [
  {
    id: 'hologram-sine',
    name: 'Hologram Sine',
    get description() {
      return t('presets.hologramSine');
    },
    category: 'lead',
    hue: 'magenta',
    volume: 0.35,
    partials: single(WAVEFORM.Sine, { attack: 0.03, decay: 0.2, sustain: 0.85, release: 0.5 }),
    filter: { lowCutoff: 20, cutoff: 12000, resonance: 0.05 },
  },
  {
    id: 'rain-city-bass',
    name: 'Rain City Bass',
    get description() {
      return t('presets.rainCityBass');
    },
    category: 'bass',
    hue: 'blue',
    volume: 0.35,
    partials: single(WAVEFORM.Square, { attack: 0.005, decay: 0.3, sustain: 0.6, release: 0.2 }),
    filter: { lowCutoff: 20, cutoff: 900, resonance: 0.45 },
  },
  {
    id: 'siren-fx',
    name: 'Siren FX',
    get description() {
      return t('presets.sirenFx');
    },
    category: 'fx',
    hue: 'pink',
    volume: 0.2,
    partials: single(WAVEFORM.Square, { attack: 0.05, decay: 0.1, sustain: 1, release: 0.8 }),
    filter: { lowCutoff: 20, cutoff: 8000, resonance: 0.7 },
  },
  {
    id: 'haze-pad',
    name: 'Haze Pad',
    get description() {
      return t('presets.hazePad');
    },
    category: 'pad',
    hue: 'violet',
    volume: 0.25,
    partials: single(WAVEFORM.Triangle, { attack: 0.9, decay: 0.6, sustain: 0.8, release: 1.6 }),
    filter: { lowCutoff: 20, cutoff: 3200, resonance: 0.15 },
  },
  {
    id: 'chrome-pluck',
    name: 'Chrome Pluck',
    get description() {
      return t('presets.chromePluck');
    },
    category: 'pluck',
    hue: 'blue',
    volume: 0.3,
    partials: single(WAVEFORM.Sawtooth, { attack: 0.002, decay: 0.18, sustain: 0, release: 0.12 }),
    filter: { lowCutoff: 20, cutoff: 4200, resonance: 0.55 },
  },
  {
    id: 'neon-lead',
    name: 'Neon Lead',
    get description() {
      return t('presets.neonLead');
    },
    category: 'lead',
    hue: 'pink',
    volume: 0.3,
    partials: single(WAVEFORM.Sawtooth, { attack: 0.01, decay: 0.25, sustain: 0.7, release: 0.35 }),
    filter: { lowCutoff: 20, cutoff: 6500, resonance: 0.35 },
  },
  {
    id: 'glass-organ',
    name: 'Glass Organ',
    get description() {
      return t('presets.glassOrgan');
    },
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
    get description() {
      return t('presets.pluckedString');
    },
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
    get description() {
      return t('presets.neonBell');
    },
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
  {
    id: 'shadow-supersaw',
    name: 'Shadow Supersaw',
    get description() {
      return t('presets.shadowSupersaw');
    },
    category: 'lead',
    hue: 'violet',
    volume: 0.23,
    partials: partials(
      SHADOW_HARMONICS.map((amplitude, index) => [index + 1, amplitude, { ...shadowEnvelope }] as [number, number, Envelope]),
    ),
    filter: { lowCutoff: 20, cutoff: 20000, resonance: 0 },
    reverb: 0.2,
    unison: { voices: 7, detune: 15, spread: 0.6 },
    octave: 5,
  },
  {
    id: 'shadow-chord',
    name: 'Shadow Chord',
    get description() {
      return t('presets.shadowChord');
    },
    category: 'pad',
    hue: 'magenta',
    volume: 0.14,
    partials: partials(SHADOW_CHORD_HARMONICS.map(([ratio, amplitude]) => [ratio, amplitude, { ...shadowChordEnvelope }])),
    filter: { lowCutoff: 20, cutoff: 20000, resonance: 0 },
    reverb: 0.2,
    unison: { voices: 5, detune: 8, spread: 0.5 },
    octave: 4,
  },
];

/** Descriptions that come with Synthway: the presets', and a new instrument's */
const KNOWN_DESCRIPTION_KEYS: MessageKey[] = [
  'presets.hologramSine',
  'presets.rainCityBass',
  'presets.sirenFx',
  'presets.hazePad',
  'presets.chromePluck',
  'presets.neonLead',
  'presets.glassOrgan',
  'presets.pluckedString',
  'presets.neonBell',
  'presets.shadowSupersaw',
  'presets.shadowChord',
  'instruments.newDescription',
];

/** Each of them, in every language, to its key */
const KNOWN_DESCRIPTIONS = new Map(
  KNOWN_DESCRIPTION_KEYS.flatMap((key) => LANGUAGES.map(({ id }) => [translate(id, key), key] as const)),
);

/**
 * The key of a description that came with Synthway and was left as it is, in whichever language it
 * was saved; undefined for one the user wrote or changed
 */
export function knownDescriptionKey(description: string): MessageKey | undefined {
  return KNOWN_DESCRIPTIONS.get(description);
}

/**
 * The description to show: one that came with Synthway, still as it was, in the current language;
 * any other as it was saved
 */
export function instrumentDescription(instrument: Instrument): string {
  const key = knownDescriptionKey(instrument.description);
  return key ? t(key) : instrument.description;
}

/** Presets added after libraries already existed: offered once to each, and not brought back once deleted */
const LATER_PRESET_IDS = ['shadow-supersaw', 'shadow-chord'];
/* v1 was written while the state was being created, which React's StrictMode does twice: the second
   time, the preset counted as offered and was left out. v2 offers it again, once. */
const OFFERED_PRESETS_KEY = 'synthway.offered-presets.v2';

/** Records that the later presets have been offered: call it once the library is loaded (in an effect,
    not while creating the state, which must stay pure) */
export function markLaterPresetsOffered(): void {
  const offered = loadJson<string[]>(OFFERED_PRESETS_KEY, []);
  saveJson(OFFERED_PRESETS_KEY, Array.from(new Set([...offered, ...LATER_PRESET_IDS])));
}

export function createInstrument(): Instrument {
  return {
    id: newId(),
    name: t('instruments.newName'),
    description: t('instruments.newDescription'),
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
    name: t('instruments.copyName', { name: source.name }),
    partials: source.partials.map((partial) => ({ ...partial, envelope: { ...partial.envelope } })),
    filter: { ...source.filter },
    // The copy of a locked instrument is the one to edit
    locked: false,
  };
}

/**
 * What plays a track whose instrument is missing from the library (deleted, or from a file that did not
 * bring it): Hologram Sine as it comes with Synthway, even when the library no longer has it
 */
export const FALLBACK_INSTRUMENT: Instrument = PRESET_INSTRUMENTS.find((preset) => preset.id === 'hologram-sine')!;

/** Instruments saved before partials existed had one waveform and one envelope: they become one partial */
export type SavedInstrument = Omit<Instrument, 'partials'> & {
  partials?: TimbrePartial[];
  waveform?: Waveform;
  envelope?: Envelope;
};

/** Presets that came with partials: added once to libraries saved before them */
const ADDITIVE_PRESET_IDS = ['glass-organ', 'plucked-string', 'neon-bell'];

/** One instrument saved by an older version of the UI, in the current shape */
export function migrateInstrument({ waveform, envelope, partials: savedPartials, ...instrument }: SavedInstrument): Instrument {
  return {
    ...instrument,
    filter: { ...(instrument.filter ?? { cutoff: 12000, resonance: 0 }), lowCutoff: instrument.filter?.lowCutoff ?? 20 },
    hue: HUES.includes(instrument.hue) ? instrument.hue : 'violet',
    partials: Array.isArray(savedPartials)
      ? savedPartials
      : single(waveform ?? WAVEFORM.Sine, envelope ?? { attack: 0.005, decay: 0, sustain: 1, release: 0.01 }),
  };
}

export function migrateInstruments(saved: unknown): Instrument[] {
  if (!Array.isArray(saved) || saved.length === 0) {
    return PRESET_INSTRUMENTS.map((instrument) => ({ ...instrument }));
  }
  const list = saved as SavedInstrument[];
  const migrated: Instrument[] = list.map(migrateInstrument);
  // Copies: the library gets plain values, its description in the current language
  if (list.some((instrument) => !Array.isArray(instrument.partials))) {
    const ids = new Set(migrated.map((instrument) => instrument.id));
    migrated.push(
      ...PRESET_INSTRUMENTS.filter((preset) => ADDITIVE_PRESET_IDS.includes(preset.id) && !ids.has(preset.id)).map(
        (preset) => ({ ...preset }),
      ),
    );
  }
  const offered = loadJson<string[]>(OFFERED_PRESETS_KEY, []);
  const ids = new Set(migrated.map((instrument) => instrument.id));
  migrated.push(
    ...PRESET_INSTRUMENTS.filter(
      (preset) => LATER_PRESET_IDS.includes(preset.id) && !offered.includes(preset.id) && !ids.has(preset.id),
    ).map((preset) => ({ ...preset })),
  );
  return migrated;
}
