// Types mirrored from synthway-server (src/models.py) and synthway-core
// (include/synthway/types.h). Keep them in sync when the core API changes
// (skill core-api-change).

/** synthway_waveform_t */
export const WAVEFORM = {
  Sine: 0,
  Square: 1,
  Triangle: 2,
  Sawtooth: 3,
} as const;

export type Waveform = (typeof WAVEFORM)[keyof typeof WAVEFORM];

export interface AudioDevice {
  index: number;
  name: string;
  id: string;
  is_default: boolean;
  sample_rate: number;
  channels: number;
  type: 'playback' | 'capture';
}

export interface DeviceListResponse {
  playback_devices: AudioDevice[];
  capture_devices: AudioDevice[];
}

export interface HealthResponse {
  status: string;
  core_loaded: boolean;
  core_version: string | null;
}

/** synthway_envelope_curve_t: how the decay and the release fall */
export const ENVELOPE_CURVE = {
  /** Straight ramps: decay and release are the times to reach the sustain level and silence */
  Linear: 0,
  /** A steady fall in dB, like a struck string: decay and release are the times to fall 60 dB */
  Exponential: 1,
} as const;
export type EnvelopeCurve = (typeof ENVELOPE_CURVE)[keyof typeof ENVELOPE_CURVE];

/** synthway_engine_set_envelope: times in seconds (0 to 10), sustain level in [0, 1] */
export interface EnvelopeParams {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** Partials only (the single oscillator's envelope is always linear); absent: linear */
  curve?: EnvelopeCurve;
}

/** synthway_partial_t: ratio in (0, 1000] (1 is the note played), amplitude in [0, 1] */
export interface PartialParams {
  ratio: number;
  amplitude: number;
  waveform: Waveform;
  envelope: EnvelopeParams;
}

/** synthway_timbre_t: plays every note instead of the single oscillator */
export interface TimbreParams {
  partials: PartialParams[];
}

/** SYNTHWAY_MAX_PARTIALS, until /api/engine/status gives the server's value */
export const DEFAULT_MAX_PARTIALS = 64;

export interface EngineStatus {
  is_running: boolean;
  is_tone_enabled: boolean;
  frequency: number;
  volume: number;
  waveform: Waveform;
  envelope: EnvelopeParams;
  /** null: the single oscillator plays */
  timbre: TimbreParams | null;
  max_partials: number;
  /** null when no engine is running */
  sample_rate: number | null;
  core_version: string;
}

/** State pushed by the server on /ws/synth after every message */
export interface SynthStateMessage {
  frequency: number;
  volume: number;
  waveform: Waveform;
  running: boolean;
  enabled: boolean;
}

export interface ToneParams {
  frequency?: number;
  volume?: number;
  waveform?: Waveform;
  envelope?: EnvelopeParams;
  /** null goes back to the single oscillator (waveform, envelope) */
  timbre?: TimbreParams | null;
  enabled?: boolean;
  low_cutoff?: number;
  cutoff?: number;
  resonance?: number;
}

/** synthway_analysis_partial_t: a peak of the spectrum */
export interface AnalysisPartial {
  frequency: number;
  /** frequency / fundamental, 0 without a fundamental */
  ratio: number;
  /** Relative to the strongest partial, in (0, 1] */
  amplitude: number;
}

/** synthway_analysis_t: what the analyzer hears at one moment */
export interface Analysis {
  sample_rate: number;
  /** Fundamental in Hz (the note played), 0 when none was found */
  frequency: number;
  /** How periodic the sound is, in [0, 1]: the note is reliable above about 0.8 */
  clarity: number;
  /** RMS level in dBFS, -120 for silence */
  level_db: number;
  /** Sorted by frequency */
  partials: AnalysisPartial[];
  spectrum_min_hz: number;
  spectrum_max_hz: number;
  /** Levels in dBFS, on log-spaced frequencies from spectrum_min_hz to spectrum_max_hz */
  spectrum_db: number[];
}

/** The note along a file: one value per point, points evenly spread */
export interface ClipTrack {
  frequency: number[];
  clarity: number[];
  level_db: number[];
}

/** An audio file loaded into the analyzer */
export interface ClipInfo {
  name: string;
  duration: number;
  sample_rate: number;
  frame_count: number;
  /** Peak of each equal part of the file */
  overview: number[];
  /** Independent Left/Right peaks for stereo waveform display */
  overview_left?: number[];
  overview_right?: number[];
  track: ClipTrack;
}

/**
 * A part of a clip, to draw it zoomed in: frame_count frames from first_frame
 * cut into equal parts, with the lowest and highest sample of each channel in
 * each. With as many parts as frames, each part is one sample (low = high).
 */
export interface ClipWaveformPart {
  first_frame: number;
  frame_count: number;
  left_low: number[];
  left_high: number[];
  right_low: number[];
  right_high: number[];
}

/** A note's partials and the envelope of each (synthway_analyzer_measure_envelopes): envelopes[i]
    goes with analysis.partials[i], whose amplitude is its peak */
export interface EnvelopeAnalysis {
  analysis: Analysis;
  envelopes: EnvelopeParams[];
}

/** A recording of the microphone, in seconds; lost: samples the core had no time to take, now silence */
export interface RecordingTimes {
  duration: number;
  lost: number;
}

/** Messages of /ws/analyzer, from the server */
export type AnalyzerMessage =
  /** exclusive: the microphone is heard without the system's audio effects; false: shared mode, with them */
  | { type: 'started'; device_index: number; sample_rate: number; exclusive: boolean }
  /** recording: only while recording */
  | { type: 'analysis'; analysis: Analysis; recording?: RecordingTimes }
  | { type: 'recording' }
  /** The recording has ended (also when the microphone closes): /api/analyzer/recording shows it */
  | ({ type: 'recorded' } & RecordingTimes)
  | { type: 'stopped' }
  | { type: 'error'; error: string };
