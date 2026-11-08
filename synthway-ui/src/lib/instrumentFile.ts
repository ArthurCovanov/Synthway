/**
 * The instrument file (.swinst): one instrument of the Instrument Creator, to share or keep apart.
 * The same shape of instrument is embedded in the composition files (compositionFile.ts).
 * The format is described in docs/formats-de-fichier.md; any change to Instrument
 * goes through the `file-formats` skill.
 */
import { ATTACK_CURVE, ENVELOPE_CURVE, MAX_UNISON_DETUNE_CENTS, MAX_UNISON_VOICES, WAVEFORM } from '../types';
import {
  FileFormatError,
  formatVersion,
  isRecord,
  numberIn,
  oneOf,
  parseJsonObject,
  textOf,
  type FileKind,
} from './files';
import {
  CATEGORY_LABEL,
  keyboardOctave,
  migrateInstrument,
  type Envelope,
  type Instrument,
  type InstrumentCategory,
  type SavedInstrument,
  type TimbrePartial,
} from './instruments';
import { HUES, PARTIAL_HUES } from './neon';
import { MAX_RATIO, MIN_RATIO } from './partials';
import { sameValue } from './history';
import { newId } from './storage';

export const INSTRUMENT_FORMAT = 'synthway-instrument';
/** Raised when a field changes meaning or goes away, with a step in `readInstrument` for older files */
export const INSTRUMENT_FORMAT_VERSION = 1;

export const INSTRUMENT_FILE: FileKind = {
  description: 'Instrument Synthway',
  extension: '.swinst',
  pickerId: 'synthway-instruments',
};
/** What the open dialog offers: a renamed file (.json) opens too */
export const INSTRUMENT_FILE_ACCEPT = '.swinst,.json,application/json';

/** Longest name and description, as the Instrument Creator's fields */
const NAME_MAX = 40;
const DESCRIPTION_MAX = 120;
/** Longest envelope time synthway-server accepts */
const ENVELOPE_MAX_SECONDS = 10;

/** An instrument as files hold it: without its lock, which belongs to the library it is in */
export function exportedInstrument(instrument: Instrument): Instrument {
  const { locked: _locked, ...exported } = instrument;
  return exported;
}

/** The text of an instrument file */
export function instrumentFileText(instrument: Instrument): string {
  return JSON.stringify(
    {
      format: INSTRUMENT_FORMAT,
      version: INSTRUMENT_FORMAT_VERSION,
      savedAt: new Date().toISOString(),
      instrument: exportedInstrument(instrument),
    },
    null,
    2,
  );
}

/** Reads an instrument file: the instrument, unlocked, or a FileFormatError saying why not */
export function parseInstrumentFile(text: string): Instrument {
  const data = parseJsonObject(text);
  if (data.format !== INSTRUMENT_FORMAT) {
    throw new FileFormatError(
      data.format === 'synthway-composition'
        ? 'c’est un morceau : ouvre-le dans le Composer.'
        : 'ce n’est pas un instrument Synthway.',
    );
  }
  formatVersion(data, INSTRUMENT_FORMAT_VERSION);
  // Version 1 is the current one: a later version adds here the steps from the older ones
  return readInstrument(data.instrument);
}

/**
 * An instrument read from a file, whatever it holds: older shapes migrated as the library does,
 * values kept within what the engine accepts, unknown fields left out. Its id is kept, so that
 * compositions using it find it again. Throws a FileFormatError when there is no instrument at all.
 */
export function readInstrument(raw: unknown): Instrument {
  if (!isRecord(raw)) throw new FileFormatError('l’instrument est absent du fichier.');
  // Migrated, but still whatever the file held: each field is checked below
  const source = migrateInstrument(raw as unknown as SavedInstrument) as unknown as Record<string, unknown>;
  const ids = new Set<string>();
  const partials = (Array.isArray(source.partials) ? (source.partials as unknown[]) : [])
    .filter(isRecord)
    .map((partial, index) => readPartial(partial, index, ids));
  const filter = isRecord(source.filter) ? source.filter : {};
  const lowCutoff = numberIn(filter.lowCutoff, 20, 20000 / 1.05, 20);
  const instrument: Instrument = {
    id: textOf(source.id, 200, '').trim() || newId(),
    name: textOf(source.name, NAME_MAX, '').trim() || 'Instrument importé',
    description: textOf(source.description, DESCRIPTION_MAX, ''),
    category: oneOf(source.category, Object.keys(CATEGORY_LABEL) as InstrumentCategory[], 'lead'),
    hue: oneOf(source.hue, HUES, 'violet'),
    volume: numberIn(source.volume, 0, 1, 0.3),
    partials,
    filter: {
      lowCutoff,
      cutoff: numberIn(filter.cutoff, lowCutoff * 1.05, 20000, 20000),
      resonance: numberIn(filter.resonance, 0, 1, 0),
    },
  };
  if (source.reverb !== undefined) instrument.reverb = numberIn(source.reverb, 0, 1, 0);
  if (isRecord(source.unison)) {
    instrument.unison = {
      voices: Math.round(numberIn(source.unison.voices, 1, MAX_UNISON_VOICES, 1)),
      detune: numberIn(source.unison.detune, 0, MAX_UNISON_DETUNE_CENTS, 0),
      spread: numberIn(source.unison.spread, 0, 1, 0),
    };
  }
  if (typeof source.octave === 'number') instrument.octave = keyboardOctave(source.octave);
  return instrument;
}

/** `ids`: those already taken in the instrument, a partial keeps its own only when it is free */
function readPartial(raw: Record<string, unknown>, index: number, ids: Set<string>): TimbrePartial {
  const savedId = textOf(raw.id, 100, '').trim();
  const id = savedId && !ids.has(savedId) ? savedId : newId();
  ids.add(id);
  const partial: TimbrePartial = {
    id,
    ratio: numberIn(raw.ratio, MIN_RATIO, MAX_RATIO, 1),
    amplitude: numberIn(raw.amplitude, 0, 1, 0.5),
    waveform: oneOf(raw.waveform, Object.values(WAVEFORM), WAVEFORM.Sine),
    envelope: readEnvelope(raw.envelope),
    hue: oneOf(raw.hue, PARTIAL_HUES, PARTIAL_HUES[index % PARTIAL_HUES.length]),
  };
  if (raw.muted === true) partial.muted = true;
  if (raw.locked === true) partial.locked = true;
  return partial;
}

function readEnvelope(raw: unknown): Envelope {
  const source = isRecord(raw) ? raw : {};
  const envelope: Envelope = {
    attack: numberIn(source.attack, 0, ENVELOPE_MAX_SECONDS, 0.01),
    decay: numberIn(source.decay, 0, ENVELOPE_MAX_SECONDS, 0.2),
    sustain: numberIn(source.sustain, 0, 1, 0.7),
    release: numberIn(source.release, 0, ENVELOPE_MAX_SECONDS, 0.3),
  };
  const curves = Object.values(ENVELOPE_CURVE);
  if (curves.includes(source.curve as never)) envelope.curve = source.curve as Envelope['curve'];
  if (Object.values(ATTACK_CURVE).includes(source.attack_curve as never)) {
    envelope.attack_curve = source.attack_curve as Envelope['attack_curve'];
  }
  if (curves.includes(source.release_curve as never)) envelope.release_curve = source.release_curve as Envelope['release_curve'];
  return envelope;
}

/** What an instrument is, without what only concerns its editing: its lock, its partials' locks, its keyboard octave */
function essence(instrument: Instrument): unknown {
  const { locked: _locked, octave: _octave, ...rest } = instrument;
  return { ...rest, partials: rest.partials.map(({ locked: _partialLocked, ...partial }) => partial) };
}

/** Same instrument: same sound, same name and description, whatever their locks and keyboard octave */
export function sameInstrument(a: Instrument, b: Instrument): boolean {
  return sameValue(essence(a), essence(b));
}

/** What became of an instrument brought into the library (by an instrument file, or a composition) */
export type ImportOutcome =
  /** Added under its own id */
  | { kind: 'added'; instrument: Instrument }
  /** Another version of it (`existing`) has its id: added as a copy, with a new id and a name that tells it apart */
  | { kind: 'copied'; instrument: Instrument; existing: Instrument }
  /** Already in the library, the same: nothing added */
  | { kind: 'present'; instrument: Instrument };

/**
 * Brings instruments into a library: each one locked (an instrument from outside is not changed by
 * mistake: the user unlocks it to edit it), under its own id when it is free, so that compositions
 * using it find it. The library is not changed: the outcomes say what to add.
 */
export function importInstruments(library: Instrument[], incoming: Instrument[]): ImportOutcome[] {
  const taken = new Map(library.map((instrument) => [instrument.id, instrument]));
  const names = new Set(library.map((instrument) => instrument.name));
  return incoming.map((instrument) => {
    const existing = taken.get(instrument.id);
    if (existing && sameInstrument(existing, instrument)) return { kind: 'present', instrument: existing };
    let outcome: ImportOutcome;
    if (existing) {
      let name = `${instrument.name} (importé)`.slice(0, NAME_MAX);
      for (let n = 2; names.has(name); n += 1) name = `${instrument.name} (importé ${n})`.slice(0, NAME_MAX);
      outcome = { kind: 'copied', instrument: { ...instrument, id: newId(), name, locked: true }, existing };
    } else {
      outcome = { kind: 'added', instrument: { ...instrument, locked: true } };
    }
    taken.set(outcome.instrument.id, outcome.instrument);
    names.add(outcome.instrument.name);
    return outcome;
  });
}
