import type { NeonHue } from './neon';
import { newId } from './storage';

/** A point of a note's pitch curve: `at` steps after the note's start, `semitones` from its pitch (fractions allowed) */
export interface BendPoint {
  at: number;
  semitones: number;
}

/** Positions and lengths are in steps (sixteenth notes) */
export interface Note {
  id: string;
  pitch: number; // MIDI note number, where the note starts
  start: number;
  length: number;
  /**
   * Pitch curve, sorted by `at`: from the note's pitch at its start, straight lines in semitones
   * through the points, then held to its end. Points beyond its end only bend the line up to it.
   * Absent or empty: the note stays at its pitch.
   */
  bend?: BendPoint[];
}

/** Most points a note's curve holds (the engine queues 64 glides per note) */
export const MAX_BEND_POINTS = 32;

/**
 * The note's curve as a line, from its start to its end: (0, 0), the points within the note,
 * and its end, held at the last point or cut on the way to the next one.
 */
export function bendLine(note: Note): BendPoint[] {
  const line: BendPoint[] = [{ at: 0, semitones: 0 }];
  for (const point of note.bend ?? []) {
    const last = line[line.length - 1];
    if (point.at <= 0) continue;
    if (point.at >= note.length) {
      // Cut at the end, on the way to this point
      const share = (note.length - last.at) / (point.at - last.at);
      line.push({ at: note.length, semitones: last.semitones + (point.semitones - last.semitones) * share });
      return line;
    }
    line.push(point);
  }
  line.push({ at: note.length, semitones: line[line.length - 1].semitones });
  return line;
}

/** Semitones from the note's pitch, `at` steps after its start */
export function bendAt(note: Note, at: number): number {
  const line = bendLine(note);
  for (let i = 1; i < line.length; i += 1) {
    const [a, b] = [line[i - 1], line[i]];
    if (at <= b.at) return b.at > a.at ? a.semitones + ((at - a.at) / (b.at - a.at)) * (b.semitones - a.semitones) : b.semitones;
  }
  return line[line.length - 1].semitones;
}

export interface Track {
  id: string;
  name: string;
  instrumentId: string;
  hue: NeonHue;
  /** Reference pitch used when centering this track's piano roll. */
  basePitch?: number;
  muted: boolean;
  solo?: boolean;
  /** When true, this track's ghost notes are hidden when another track is selected */
  hidden?: boolean;
  notes: Note[];
}

export interface Composition {
  bpm: number;
  beatsPerBar: number;
  bars: number;
  tracks: Track[];
}

export const STEPS_PER_BEAT = 4;
/** C0 under the project's MIDI octave naming convention. */
export const DEFAULT_BASE_PITCH = 12;

function notes(list: [pitch: number, start: number, length: number][]): Note[] {
  return list.map(([pitch, start, length]) => ({ id: newId(), pitch, start, length }));
}

export function createTrack(index: number, instrumentId: string, hue: NeonHue): Track {
  return {
    id: newId(),
    name: `Piste ${index}`,
    instrumentId,
    hue,
    basePitch: DEFAULT_BASE_PITCH,
    muted: false,
    solo: false,
    hidden: false,
    notes: [],
  };
}

export function defaultComposition(): Composition {
  return {
    bpm: 98,
    beatsPerBar: 4,
    bars: 4,
    tracks: [
      {
        id: newId(),
        name: 'Mélodie',
        instrumentId: 'neon-lead',
        hue: 'pink',
        basePitch: DEFAULT_BASE_PITCH,
        muted: false,
        solo: false,
        hidden: false,
        // A minor arpeggio climbing over two bars
        notes: notes([
          [69, 0, 2], [72, 2, 2], [76, 4, 2], [79, 6, 2],
          [77, 8, 4], [76, 12, 2], [72, 14, 2],
          [74, 16, 2], [77, 18, 2], [81, 20, 4], [79, 24, 6],
        ]),
      },
      {
        id: newId(),
        name: 'Basse',
        instrumentId: 'rain-city-bass',
        hue: 'blue',
        basePitch: DEFAULT_BASE_PITCH,
        muted: false,
        solo: false,
        hidden: false,
        notes: notes([
          [45, 0, 4], [45, 6, 2], [41, 8, 4], [41, 14, 2],
          [43, 16, 4], [43, 22, 2], [40, 24, 8],
        ]),
      },
      {
        id: newId(),
        name: 'Nappe',
        instrumentId: 'haze-pad',
        hue: 'violet',
        basePitch: DEFAULT_BASE_PITCH,
        muted: false,
        solo: false,
        hidden: false,
        notes: [],
      },
    ],
  };
}
