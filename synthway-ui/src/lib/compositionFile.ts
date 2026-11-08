/**
 * The composition file (.swsong): a score of the Composer, with a copy of each instrument its tracks
 * use, so that it plays the same on a library that lacks them (deleted since, or another machine).
 * The format is described in docs/formats-de-fichier.md; any change to
 * Composition, Track or Note goes through the `file-formats` skill.
 */
import { AUTOMATION_SPECS, MAX_AUTOMATION_POINTS, sortedPoints, type AutomationSpec } from './automation';
import {
  DEFAULT_BASE_PITCH,
  MAX_BARS,
  MAX_BEND_POINTS,
  STEPS_PER_BEAT,
  type AutomationLane,
  type AutomationPoint,
  type BendPoint,
  type Composition,
  type Note,
  type Track,
} from './composition';
import { FileFormatError, formatVersion, isRecord, numberIn, oneOf, parseJsonObject, textOf, type FileKind } from './files';
import { exportedInstrument, readInstrument, sameInstrument } from './instrumentFile';
import type { Instrument } from './instruments';
import { HUES } from './neon';
import { newId } from './storage';

export const COMPOSITION_FORMAT = 'synthway-composition';
/** Raised when a field changes meaning or goes away, with a step in `parseCompositionFile` for older files */
export const COMPOSITION_FORMAT_VERSION = 1;

export const COMPOSITION_FILE: FileKind = {
  description: 'Morceau Synthway',
  extension: '.swsong',
  pickerId: 'synthway-songs',
};
/** What the open dialog offers: a renamed file (.json) opens too */
export const COMPOSITION_FILE_ACCEPT = '.swsong,.json,application/json';

/** Limits of the Composer's fields: tempo, track name */
const BPM_MIN = 40;
const BPM_MAX = 240;
const TRACK_NAME_MAX = 24;
const MAX_BEATS_PER_BAR = 16;
/** The longest score, in steps: MAX_BARS bars of the most beats */
const MAX_STEPS = MAX_BARS * MAX_BEATS_PER_BAR * STEPS_PER_BEAT;

/**
 * The text of a composition file. Ids are left out (they only matter while it is open); each track
 * keeps its instrument's id and current name, and the instruments it uses are embedded as they are
 * in `library` (a track's missing instrument cannot be: only its id and name are kept).
 */
export function compositionFileText(composition: Composition, library: Instrument[]): string {
  const used = new Map<string, Instrument>();
  const tracks = composition.tracks.map((track) => {
    const instrument = library.find((item) => item.id === track.instrumentId);
    if (instrument) used.set(instrument.id, instrument);
    const notes = track.notes.map(({ pitch, start, length, bend }) =>
      bend?.length ? { pitch, start, length, bend } : { pitch, start, length },
    );
    const automation = automationOf(track);
    return {
      name: track.name,
      instrumentId: track.instrumentId,
      instrumentName: instrument?.name ?? track.instrumentName,
      hue: track.hue,
      basePitch: track.basePitch ?? DEFAULT_BASE_PITCH,
      muted: track.muted,
      hidden: Boolean(track.hidden),
      notes,
      ...(automation ? { automation } : {}),
    };
  });
  return JSON.stringify(
    {
      format: COMPOSITION_FORMAT,
      version: COMPOSITION_FORMAT_VERSION,
      savedAt: new Date().toISOString(),
      composition: { bpm: composition.bpm, beatsPerBar: composition.beatsPerBar, bars: composition.bars, tracks },
      instruments: Array.from(used.values(), exportedInstrument),
    },
    null,
    2,
  );
}

/** A track's curves as written: their points only, the empty ones left out; undefined when it has none */
function automationOf(track: Track): Track['automation'] {
  const written: NonNullable<Track['automation']> = {};
  for (const spec of AUTOMATION_SPECS) {
    const lane = track.automation?.[spec.id];
    if (!lane || lane.points.length === 0) continue;
    const point = ({ at, value }: AutomationPoint) => ({ at, value });
    written[spec.id] = lane.right?.length ? { points: lane.points.map(point), right: lane.right.map(point) } : { points: lane.points.map(point) };
  }
  return Object.keys(written).length ? written : undefined;
}

export interface OpenedComposition {
  /** With new ids */
  composition: Composition;
  /** The copies of instruments the file brings (unlocked), those of its tracks only */
  instruments: Instrument[];
}

/** Reads a composition file, or throws a FileFormatError saying why it cannot */
export function parseCompositionFile(text: string): OpenedComposition {
  const data = parseJsonObject(text);
  if (data.format !== COMPOSITION_FORMAT) {
    throw new FileFormatError(
      data.format === 'synthway-instrument'
        ? 'c’est un instrument : importe-le dans l’Instrument Creator.'
        : 'ce n’est pas un morceau Synthway.',
    );
  }
  formatVersion(data, COMPOSITION_FORMAT_VERSION);
  // Version 1 is the current one: a later version adds here the steps from the older ones
  const raw = data.composition;
  if (!isRecord(raw) || !Array.isArray(raw.tracks)) throw new FileFormatError('le morceau est absent du fichier.');
  const tracks = raw.tracks.filter(isRecord).map(readTrack);
  if (tracks.length === 0) throw new FileFormatError('le morceau n’a aucune piste.');
  const composition: Composition = {
    bpm: numberIn(raw.bpm, BPM_MIN, BPM_MAX, 98),
    beatsPerBar: Math.round(numberIn(raw.beatsPerBar, 1, MAX_BEATS_PER_BAR, 4)),
    bars: Math.round(numberIn(raw.bars, 1, MAX_BARS, 4)),
    tracks,
  };
  const usedIds = new Set(tracks.map((track) => track.instrumentId));
  const instruments: Instrument[] = [];
  for (const item of Array.isArray(data.instruments) ? data.instruments : []) {
    // A damaged copy is left out: its tracks then say their instrument is missing
    try {
      const instrument = readInstrument(item);
      if (usedIds.has(instrument.id) && !instruments.some((other) => other.id === instrument.id)) instruments.push(instrument);
    } catch (error) {
      if (!(error instanceof FileFormatError)) throw error;
    }
  }
  return { composition, instruments };
}

function readTrack(raw: Record<string, unknown>, index: number): Track {
  const track: Track = {
    id: newId(),
    name: textOf(raw.name, TRACK_NAME_MAX, '') || `Piste ${index + 1}`,
    instrumentId: textOf(raw.instrumentId, 200, ''),
    hue: oneOf(raw.hue, HUES, HUES[index % HUES.length]),
    basePitch: Math.round(numberIn(raw.basePitch, -120, 247, DEFAULT_BASE_PITCH)),
    muted: raw.muted === true,
    hidden: raw.hidden === true,
    notes: (Array.isArray(raw.notes) ? raw.notes : []).filter(isRecord).map(readNote),
  };
  const instrumentName = textOf(raw.instrumentName, 40, '');
  if (instrumentName) track.instrumentName = instrumentName;
  const automation = readAutomation(raw.automation);
  if (automation) track.automation = automation;
  return track;
}

/** The value a point without one takes: the setting's neutral value (full volume, centre, open filter, none) */
function neutralValue(spec: AutomationSpec): number {
  if (spec.id === 'volume') return 1;
  if (spec.id === 'lowPass') return spec.max;
  return Math.min(spec.max, Math.max(spec.min, 0));
}

function readPoints(raw: unknown, spec: AutomationSpec): AutomationPoint[] {
  if (!Array.isArray(raw)) return [];
  const points = raw.filter(isRecord).map((point) => ({
    at: numberIn(point.at, 0, MAX_STEPS, 0),
    value: numberIn(point.value, spec.min, spec.max, neutralValue(spec)),
  }));
  return sortedPoints(points).slice(0, MAX_AUTOMATION_POINTS);
}

/** A track's curves: unknown settings and curves without points left out; right side only for the settings that have one */
function readAutomation(raw: unknown): Track['automation'] {
  if (!isRecord(raw)) return undefined;
  const automation: NonNullable<Track['automation']> = {};
  for (const spec of AUTOMATION_SPECS) {
    const item = raw[spec.id];
    if (!isRecord(item)) continue;
    const points = readPoints(item.points, spec);
    if (points.length === 0) continue;
    const lane: AutomationLane = { points };
    const right = spec.stereo ? readPoints(item.right, spec) : [];
    if (right.length) lane.right = right;
    automation[spec.id] = lane;
  }
  return Object.keys(automation).length ? automation : undefined;
}

function readNote(raw: Record<string, unknown>): Note {
  const pitch = Math.round(numberIn(raw.pitch, 0, 127, 60));
  const note: Note = {
    id: newId(),
    pitch,
    start: Math.round(numberIn(raw.start, 0, MAX_STEPS, 0)),
    length: Math.round(numberIn(raw.length, 1, MAX_STEPS, 1)),
  };
  if (Array.isArray(raw.bend)) {
    const bend: BendPoint[] = raw.bend
      .filter(isRecord)
      .map((point) => ({
        at: numberIn(point.at, 0, MAX_STEPS, 0),
        semitones: numberIn(point.semitones, -pitch, 127 - pitch, 0),
      }))
      .filter((point) => point.at > 0)
      .sort((a, b) => a.at - b.at)
      .slice(0, MAX_BEND_POINTS);
    if (bend.length) note.bend = bend;
  }
  return note;
}

/** What opening a composition does to the library, and what the user is told */
export interface InstrumentCheck {
  /** Instruments the file brings that the library lacks: to add, locked */
  added: Instrument[];
  /** In the library under the same id, but no longer as the file saved them: the library's version plays */
  changed: Instrument[];
  /** Tracks whose instrument is neither in the library nor in the file: played by the fallback instrument */
  missing: Track[];
}

/** Checks the instruments of an opened composition against the library */
export function checkInstruments(opened: OpenedComposition, library: Instrument[]): InstrumentCheck {
  const added: Instrument[] = [];
  const changed: Instrument[] = [];
  for (const instrument of opened.instruments) {
    const existing = library.find((item) => item.id === instrument.id);
    if (!existing) added.push({ ...instrument, locked: true });
    else if (!sameInstrument(existing, instrument)) changed.push(existing);
  }
  const known = new Set([...library, ...added].map((instrument) => instrument.id));
  const missing = opened.composition.tracks.filter((track) => !known.has(track.instrumentId));
  return { added, changed, missing };
}
