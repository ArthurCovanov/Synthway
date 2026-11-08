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

/** synthway_envelope_curve_t: how the decay or the release falls */
export const ENVELOPE_CURVE = {
  /** A straight ramp: the decay or release is the time to reach the sustain level or silence */
  Linear: 0,
  /** A steady fall in dB, like a struck string: the decay or release is the time to fall 60 dB */
  Exponential: 1,
} as const;
export type EnvelopeCurve = (typeof ENVELOPE_CURVE)[keyof typeof ENVELOPE_CURVE];

/** synthway_attack_curve_t: how the attack rises */
export const ATTACK_CURVE = {
  /** A straight ramp */
  Linear: 0,
  /** The square of a straight ramp: slow, then faster and faster, heard as an exponential swell */
  Convex: 1,
} as const;
export type AttackCurve = (typeof ATTACK_CURVE)[keyof typeof ATTACK_CURVE];

/** synthway_engine_set_envelope: times in seconds (0 to 10), sustain level in [0, 1] */
export interface EnvelopeParams {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** The decay's; partials only (the single oscillator's envelope is always linear); absent: linear */
  curve?: EnvelopeCurve;
  /** Partials only; absent: a straight attack */
  attack_curve?: AttackCurve;
  /** Partials only; absent: the decay's curve */
  release_curve?: EnvelopeCurve;
}

/** synthway_engine_set_unison: each partial played by voices detuned oscillators */
export interface UnisonParams {
  /** 1 to MAX_UNISON_VOICES; 1: no unison */
  voices: number;
  /** Cents between the partial and its outermost voices, below and above (0 to MAX_UNISON_DETUNE_CENTS) */
  detune: number;
  /** Stereo width of the voices, 0 (mono) to 1 */
  spread: number;
}

/** SYNTHWAY_MAX_UNISON_VOICES and SYNTHWAY_MAX_UNISON_DETUNE_CENTS */
export const MAX_UNISON_VOICES = 8;
export const MAX_UNISON_DETUNE_CENTS = 100;

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

/** SYNTHWAY_MAX_INSTRUMENTS: instrument slots of the engine; 0 is the one set_param sets */
export const MAX_INSTRUMENTS = 16;

/** A glide of a note (synthway_engine_note_glide): to this frequency, in this time, in a straight line in semitones */
export interface NoteGlide {
  frequency: number;
  seconds: number;
}

/** synthway_instrument_t, as set_instrument takes it: an absent field takes its default */
export interface InstrumentParams {
  waveform?: Waveform;
  envelope?: EnvelopeParams;
  /** null or absent: the single oscillator (waveform, envelope) */
  timbre?: TimbreParams | null;
  low_cutoff?: number;
  cutoff?: number;
  resonance?: number;
  reverb?: number;
  unison?: UnisonParams;
}

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
  /** Share of reverberated sound, 0 (none) to 1 (the reverb alone) */
  reverb?: number;
  unison?: UnisonParams;
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

/** synthway_note_span_t: a note heard in a zone, and when (seconds from the start of the file) */
export interface NoteSpan {
  frequency: number;
  start: number;
  end: number;
  /** In (0, 1]: 1 for the strongest note of the zone */
  strength: number;
}

/** synthway_wave_shape_t: the shapes a note's harmonics are compared with (the waveforms of WAVEFORM, same values, and a pulse) */
export const WAVE_SHAPE = {
  Sine: 0,
  Square: 1,
  Triangle: 2,
  Sawtooth: 3,
  Pulse: 4,
} as const;
export type WaveShape = (typeof WAVE_SHAPE)[keyof typeof WAVE_SHAPE];

/** SYNTHWAY_HARMONIC_*: one harmonic of a waveform fit */
export const HARMONIC_STATE = {
  /** Above the background around it */
  Heard: 0,
  /** Not above it: missing, or too weak to tell */
  Faint: 1,
  /** Also a harmonic of another note heard with it: left out of the fit */
  Shared: 2,
} as const;
export type HarmonicState = (typeof HARMONIC_STATE)[keyof typeof HARMONIC_STATE];

export interface HarmonicLevel {
  /** dB relative to the strongest heard harmonic (0) */
  level: number;
  /** The background around it, on the same scale */
  background: number;
  state: HarmonicState;
}

/** synthway_shape_fit_t: one shape, with the engine's low-pass and the level that bring it closest */
export interface ShapeFit {
  shape: WaveShape;
  /** Share of the period a pulse is high; 0.5 for the square, 0 for the others */
  duty: number;
  /** Cutoff of the low-pass in Hz; 0: none */
  cutoff: number;
  /** Of that low-pass, in [0, 1] */
  resonance: number;
  /** Mean gap in dB between the harmonics measured and the shape's */
  error_db: number;
}

/** synthway_waveform_fit_t: the harmonics of a note, and the waveforms closest to them */
export interface WaveformFit {
  /** The note in Hz; 0: none */
  frequency: number;
  /** Moments of the zone where the note is heard; 0: never alone, no fits */
  moments: number;
  /** From the 1st */
  harmonics: HarmonicLevel[];
  /** Even harmonics against their odd neighbours, dB: a sawtooth about -1, a square far below */
  even_db: number;
  /** Even harmonics compared; 0: even_db tells nothing */
  even_count: number;
  /** Fall of the heard harmonics, dB per octave */
  slope: number;
  /** One per shape, closest first; empty without a fit */
  fits: ShapeFit[];
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

/** A Demucs model of the Decomposer: 4 stems, the same fine-tuned (4 times slower), or 6 stems */
export type SeparationModel = 'htdemucs' | 'htdemucs_ft' | 'htdemucs_6s';

/** A stem of a separation: drums, bass, vocals, other, guitar or piano */
export interface SeparationStem {
  name: string;
  /** Highest sample of each equal part of the stem, to draw it */
  peaks: number[];
}

/** What GET /api/separation says: whether Demucs is ready, the piece loaded, the separation and its stems */
export interface SeparationStatus {
  available: boolean;
  /** Why Demucs cannot run, null when it can */
  reason: string | null;
  models: SeparationModel[];
  source: { name: string; size: number } | null;
  job: {
    state: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
    stage: 'starting' | 'loading' | 'reading' | 'separating' | 'saving' | null;
    /** Share of the separation done, 0 to 1 */
    progress: number;
    model: SeparationModel | null;
    /** cuda or cpu, once Demucs has started */
    device: string | null;
    error: string | null;
  };
  result: {
    model: SeparationModel;
    device: string;
    sample_rate: number;
    duration: number;
    /** How long the separation took */
    seconds: number;
    stems: SeparationStem[];
  } | null;
}
