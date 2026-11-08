import type { NeonHue } from './neon';
import { newId } from './storage';

/** Positions and lengths are in steps (sixteenth notes) */
export interface Note {
  id: string;
  pitch: number; // MIDI note number
  start: number;
  length: number;
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
