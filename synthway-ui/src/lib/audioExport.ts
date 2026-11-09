/**
 * The Composer's score as the engine plays it, for playback and for its export to an audio file:
 * the engine slot of each track, the glides of each note, and the request that has synthway-server
 * render the whole score offline (/api/render/score) exactly as playback plays it.
 */
import { t } from '../i18n';
import { AUDIO_FILE_FORMAT, MAX_INSTRUMENTS, type NoteGlide, type ScoreNote, type ScoreRamp, type ScoreRenderRequest } from '../types';
import { playedCurves, scoreCurveRamps } from './automation';
import { bendLine, STEPS_PER_BEAT, type Composition, type Note, type Track } from './composition';
import type { FileKind } from './files';
import { FALLBACK_INSTRUMENT, type Instrument } from './instruments';
import { instrumentSound } from './instrumentSound';
import { midiToFrequency } from './music';

/** Instrument slot of the track at index: slot 0 stays the keyboard's and the Instrument Creator's */
export function trackSlot(index: number): number {
  return 1 + (index % (MAX_INSTRUMENTS - 1));
}

/** Seconds of one step (a sixteenth note) at bpm */
export function stepSeconds(bpm: number): number {
  return 60 / bpm / STEPS_PER_BEAT;
}

/**
 * The glides of a note's curve, as the engine takes them, from `from` steps after its start (0: its
 * start, more when playback starts in its middle): each to the pitch of a point, in the time to reach it
 */
export function noteGlides(note: Note, from: number, secondsPerStep: number): NoteGlide[] {
  if (!note.bend?.length) return [];
  let at = from;
  return bendLine(note)
    .filter((point) => point.at > from)
    .map((point) => {
      const glide = { frequency: midiToFrequency(note.pitch + point.semitones), seconds: (point.at - at) * secondsPerStep };
      at = point.at;
      return glide;
    });
}

export type AudioExportFormat = 'wav' | 'ogg';

/** What the user chooses before exporting, kept from one export to the next */
export interface AudioExportSettings {
  format: AudioExportFormat;
  /** Seconds of silence before the first beat */
  leadIn: number;
  /** Seconds of silence once the sound has died out, faded */
  tailMargin: number;
}

export const DEFAULT_AUDIO_EXPORT: AudioExportSettings = { format: 'wav', leadIn: 1, tailMargin: 1 };

/** Longest silence before or after, as synthway-server accepts it */
export const MAX_EXPORT_SILENCE = 10;
/** Longest score, first beat to the end of the last bar, as synthway-server accepts it (MAX_SCORE_SECONDS) */
export const MAX_EXPORT_SECONDS = 3600;

/** Their descriptions in the current language, read when the save dialog opens */
export const AUDIO_FILES: Record<AudioExportFormat, FileKind> = {
  wav: {
    get description() {
      return t('songFile.audioWav');
    },
    extension: '.wav',
    pickerId: 'synthway-audio',
    mime: 'audio/wav',
  },
  ogg: {
    get description() {
      return t('songFile.audioOgg');
    },
    extension: '.ogg',
    pickerId: 'synthway-audio',
    mime: 'audio/ogg',
  },
};

/** Ogg Vorbis quality: about 190 kbit/s in stereo, hard to tell from the WAV */
export const OGG_QUALITY = 0.6;

/** What an export holds: the score's length, the tracks heard, those left out, those played by the fallback */
export interface ExportSummary {
  /** Seconds from the first beat to the end of the last bar */
  seconds: number;
  heard: Track[];
  muted: Track[];
  /** Heard, but with an instrument the library no longer has: FALLBACK_INSTRUMENT plays them */
  fallback: Track[];
  notes: number;
}

const libraryInstrument = (track: Track, instruments: Instrument[]) =>
  instruments.find((instrument) => instrument.id === track.instrumentId);

/** Steps of the whole score, to the end of its last bar */
export function scoreSteps(composition: Composition): number {
  return composition.bars * composition.beatsPerBar * STEPS_PER_BEAT;
}

export function exportSummary(composition: Composition, instruments: Instrument[]): ExportSummary {
  const steps = scoreSteps(composition);
  const heard = composition.tracks.filter((track) => !track.muted);
  return {
    seconds: steps * stepSeconds(composition.bpm),
    heard,
    muted: composition.tracks.filter((track) => track.muted),
    fallback: heard.filter((track) => !libraryInstrument(track, instruments)),
    notes: heard.reduce((count, track) => count + track.notes.filter((note) => note.start < steps).length, 0),
  };
}

/**
 * The score as playback plays it, for /api/render/score: muted tracks left out, a missing instrument
 * played by FALLBACK_INSTRUMENT, each note struck at its start and released at its end (at the end of
 * the score at the latest), with its instrument's volume and its curve's glides, and the ramps of the
 * tracks' automation curves.
 */
export function scoreRenderRequest(
  composition: Composition,
  instruments: Instrument[],
  settings: AudioExportSettings,
  sampleRate: number,
  maxPartials: number,
): ScoreRenderRequest {
  const steps = scoreSteps(composition);
  const seconds = stepSeconds(composition.bpm);
  const slots: ScoreRenderRequest['instruments'] = {};
  const notes: ScoreNote[] = [];
  const automation: ScoreRamp[] = [];
  composition.tracks.forEach((track, index) => {
    if (track.muted) return;
    const slot = trackSlot(index);
    for (const curve of playedCurves(track, slot)) automation.push(...scoreCurveRamps(curve, seconds, steps * seconds));
    const instrument = libraryInstrument(track, instruments) ?? FALLBACK_INSTRUMENT;
    // Beyond 15 tracks two share a slot, and, as in playback, the last one's sound
    slots[slot] = instrumentSound(instrument, maxPartials);
    for (const note of track.notes) {
      if (note.start >= steps) continue;
      const glides = noteGlides(note, 0, seconds);
      notes.push({
        start: note.start * seconds,
        end: Math.min(note.start + note.length, steps) * seconds,
        slot,
        frequency: midiToFrequency(note.pitch),
        volume: instrument.volume,
        ...(glides.length ? { glides } : {}),
      });
    }
  });
  return {
    format: settings.format === 'ogg' ? AUDIO_FILE_FORMAT.Ogg : AUDIO_FILE_FORMAT.Wav,
    sample_rate: sampleRate,
    channels: 2,
    quality: OGG_QUALITY,
    duration: steps * seconds,
    lead_in: settings.leadIn,
    tail_margin: settings.tailMargin,
    instruments: slots,
    notes,
    ...(automation.length ? { automation } : {}),
  };
}
