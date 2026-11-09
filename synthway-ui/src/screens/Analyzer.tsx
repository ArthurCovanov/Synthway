import {
  Circle,
  Crosshair,
  Download,
  FileAudio,
  Mic,
  MicOff,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Square,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { AnalysisSpectrum, partialColor } from '../components/AnalysisSpectrum';
import { ClipWaveform, type ClipSelection } from '../components/ClipWaveform';
import { KeyboardDock } from '../components/KeyboardDock';
import layout from '../components/layout.module.css';
import { ScreenHeader } from '../components/ScreenHeader';
import { Badge, Button, Field, Panel, Section, Segmented, Slider, Toggle, inputClass, selectClass } from '../components/ui';
import { Tuner } from '../components/Tuner';
import { WaveformFitCard } from '../components/WaveformFitCard';
// translateNow: the module t, for messages made in callbacks and requests, which
// must not run again when the language changes
import { t, t as translateNow, useI18n } from '../i18n';
import {
  ANALYSIS_WINDOW_DEFAULT_MS,
  ANALYSIS_WINDOW_MAX_MS,
  ANALYSIS_WINDOW_MIN_MS,
  ANALYZER_CLIP_WAV_URL,
  AnalyzerSocket,
  api,
  HARMONIC_CENTS,
  NOISE_GATE_OFF,
  RECORDING_WAV_URL,
  type AnalysisOptions,
  type AnalysisTarget,
} from '../lib/api';
import { useInstrumentSound } from '../lib/instrumentSound';
import { instrumentFromPartials, type Instrument } from '../lib/instruments';
import { useSpaceBar } from '../lib/keyboard';
import { formatCents, frequencyToNote, harmonicGap, NOTE_NAMES } from '../lib/music';
import { usePersistentState } from '../lib/storage';
import { chosenFit, describeShape, shapePartials, type BuildFrom } from '../lib/waveShapes';
import { useSynthServer } from '../lib/SynthServer';
import type {
  Analysis,
  AnalyzerMessage,
  ClipInfo,
  EnvelopeParams,
  NoteSpan,
  RecordingTimes,
  ShapeFit,
  WaveformFit,
} from '../types';
import styles from './Analyzer.module.css';

/*
 * Analyzer: analyzes the microphone or a loaded audio file.
 *   - Micro: synthway-core listens to a capture device and analyzes what it
 *     hears; the server sends the results 20 times a second (/ws/analyzer).
 *     « Enregistrer » records it in the core, with no time limit; the
 *     recording is then shown and played like a file. Placing the cursor on it
 *     or playing it stops listening, and listening again removes the cursor:
 *     the panels below show one or the other. The recording can be downloaded
 *     as a WAV file.
 *   - Fichier: a WAV, FLAC or MP3 file is sent whole to the core, which decodes
 *     it; the note is followed along it, and a cursor picks the moment analyzed.
 *   « Lire » (or the space bar) plays the file or the recording in the browser,
 *   from the cursor, which follows it; placing the cursor pauses it. Dragging
 *   on the waveform selects a zone, which « Lire » then plays in a loop.
 * What the panels below show: without a zone, the moment of the cursor seen
 * through the analysis window (« Fenêtre d'analyse », drawn as green bounds on
 * the waveform); with a zone, the median of its moments, computed by the core.
 * Their ratios are taken to the reference note: the one heard (for a zone, the
 * low end of its notes, octave errors corrected by the core), or one fixed
 * here, in the octave chosen. « Harmoniques seulement » keeps only partials
 * near a whole ratio, which leaves out most of the other instruments of a mix.
 * « Essayer l'instrument » makes a trial instrument of those partials (with
 * each one's envelope, measured on a zone), played on the keyboard at the
 * bottom, where the note analyzed is marked. It stays as it is while the
 * selection or the settings change: « Mettre à jour » makes it again from
 * them, « Revenir à sa sélection » brings back the zone it was made from,
 * « Lire l'original » plays the zone. « Sauvegarder » adds it to the library
 * and opens it in the Instrument Creator; leaving the screen loses it.
 * « Forme d'onde » tells which waveform the note is closest to (sawtooth,
 * square, triangle, pulse, sine, each through the low-pass that fits it best,
 * synthway_analyzer_fit_waveform). « Essai fait de » chooses what the trial
 * instrument is made of: the partials measured, or the harmonics of a shape,
 * as sines, with its low-pass in the instrument's filter.
 */

type Source = 'micro' | 'file';
type Listening = 'off' | 'starting' | 'on';

/** The trial instrument: made from the analysis on demand, played at the bottom, saved on demand */
interface Draft {
  instrument: Instrument;
  /** The note its ratios are taken to (MIDI), marked on the keyboard */
  noteMidi: number | null;
  /** What it was made from (see analysisBasis): another basis now, « Mettre à jour » takes it */
  basis: string;
  /** Where it was made: its source, sound, selection and fixed reference note, to come back to them */
  source: Source;
  clipKey: string;
  target: AnalysisTarget | null;
  referenceMidi: number | null;
  /** The volume was set by hand: « Mettre à jour » keeps it */
  volumeSet: boolean;
  /** The waveform it was made of (described at display: « Dent de scie, passe-bas 5,6 kHz »), null: the partials measured */
  shape: ShapeFit | null;
}

/** The zone a waveform fit looks at: the zone, or the moment's window */
function fitZone(target: AnalysisTarget, windowMs: number): { start: number; end: number } {
  if ('start' in target) return target;
  const half = windowMs / 2000;
  return { start: Math.max(0, target.time - half), end: target.time + half };
}

/** A file or a recording, to tell it from another one */
function clipKeyOf(clip: ClipInfo | null): string {
  return clip ? `${clip.name}:${clip.frame_count}:${clip.sample_rate}` : '';
}

/** What an analysis is made from: the sound, the selection and the settings. Live, the microphone alone */
function analysisBasis(
  source: Source,
  clipKey: string,
  target: AnalysisTarget | null,
  settings: (string | number | boolean)[],
): string {
  if (!target) return `${source}|live`;
  const where = 'time' in target ? `t${target.time.toFixed(4)}` : `z${target.start.toFixed(4)}-${target.end.toFixed(4)}`;
  return [source, clipKey, where, ...settings].join('|');
}

const ACCEPTED_FILES = '.wav,.flac,.mp3,audio/wav,audio/x-wav,audio/flac,audio/mpeg';
/** Harmonics of a note part from 6 bins of a Blackman window apart: windows shorter than 6 periods mix them */
const PERIODS_PER_WINDOW = 6;
/** A fixed reference note, as MIDI notes: C0 (16 Hz) to D#8 (4978 Hz), within what the core accepts */
/** A note of a zone this strong next to the strongest is played, not a trace of another sound */
const STRONG_NOTE = 0.5;
const REFERENCE_MIDI_MIN = 12;
const REFERENCE_MIDI_MAX = 111;
/** Track points of a zone on another note than its reference, above this share, earn a warning */
const OTHER_NOTES_SHARE = 0.25;
/** Anti-noise slider: 0 is off, then 1 to GATE_SLIDER_MAX raise the gate from -99 to -20 dBFS.
    Its popup takes any gate the core accepts, from NOISE_GATE_OFF to 0 dBFS. */
const GATE_SLIDER_ZERO_DB = -100;
const GATE_SLIDER_MAX = 80;

// The helpers below that write text use the module's t(): they are called while
// the Analyzer renders, which follows the language through useI18n()

function formatNoiseGate(gate: number): string {
  if (gate <= NOISE_GATE_OFF) return t('common.off');
  const level = Number((-gate).toFixed(1));
  return level === 0 ? '0 dBFS' : `−${level} dBFS`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The clearest moment of a file among its loud ones (within 20 dB of the loudest), else its middle */
function clearestMoment(clip: ClipInfo): number {
  const { frequency, clarity, level_db: level } = clip.track;
  const loudest = Math.max(...level);
  let best = -1;
  for (let i = 0; i < frequency.length; i += 1) {
    if (frequency[i] > 0 && level[i] >= loudest - 20 && (best < 0 || clarity[i] > clarity[best])) best = i;
  }
  return best < 0 ? clip.duration / 2 : ((best + 0.5) / frequency.length) * clip.duration;
}

function formatDuration(seconds: number): string {
  return seconds < 60 ? `${seconds.toFixed(2)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

function describeZone(zone: ClipSelection): string {
  return t('analyzer.zone', {
    start: zone.start.toFixed(2),
    end: zone.end.toFixed(2),
    duration: formatDuration(zone.end - zone.start),
  });
}

/** The zone if there is one (playback moving the cursor does not change it), else the cursor's moment */
function useAnalysisTarget(selection: ClipSelection | null, time: number | null): AnalysisTarget | null {
  const start = selection?.start;
  const end = selection?.end;
  const moment = selection ? null : time;
  return useMemo(
    () => (start !== undefined && end !== undefined ? { start, end } : moment !== null ? { time: moment } : null),
    [start, end, moment],
  );
}

/** Analyses of a file or a recording, one request at a time: while one runs, only the latest target asked waits */
function useAnalysisRequests(
  fetchAnalysis: (target: AnalysisTarget, options: AnalysisOptions) => Promise<Analysis>,
  optionsRef: { current: AnalysisOptions },
  onAnalysis: (analysis: Analysis) => void,
  onError: (error: string) => void,
) {
  const wanted = useRef<AnalysisTarget | null>(null);
  const inFlight = useRef(false);
  return useCallback(
    async (target: AnalysisTarget) => {
      wanted.current = target;
      if (inFlight.current) return;
      inFlight.current = true;
      while (wanted.current !== null) {
        const next = wanted.current;
        wanted.current = null;
        try {
          onAnalysis(await fetchAnalysis(next, optionsRef.current));
        } catch (error) {
          onError(describe(error));
        }
      }
      inFlight.current = false;
    },
    [fetchAnalysis, optionsRef, onAnalysis, onError],
  );
}

/** What the analysis shown looks at, in words */
function describeAnalyzed(target: AnalysisTarget | null, windowMs: number): string {
  if (!target) return t('analyzer.analyzed.live');
  if ('time' in target) return t('analyzer.analyzed.moment', { time: target.time.toFixed(2), window: windowMs });
  return t('analyzer.analyzed.zone', { start: target.start.toFixed(2), end: target.end.toFixed(2), window: windowMs });
}

function midiFrequency(midi: number, a4: number): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

function midiLabel(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Share of the clear points of the note track, within a zone, on another note than reference (in any octave) */
function otherNotesShare(clip: ClipInfo, zone: ClipSelection, reference: number): number {
  const { frequency, clarity } = clip.track;
  let clear = 0;
  let other = 0;
  for (let i = 0; i < frequency.length; i += 1) {
    const time = ((i + 0.5) / frequency.length) * clip.duration;
    if (time < zone.start || time > zone.end || !(frequency[i] > 0) || clarity[i] < 0.5) continue;
    clear += 1;
    const semitones = 12 * Math.log2(frequency[i] / reference);
    if (Math.abs(semitones - 12 * Math.round(semitones / 12)) > 1.5) other += 1;
  }
  return clear >= 3 ? other / clear : 0;
}

/** While playing, the cursor follows 20 times a second, like the microphone's analyses */
const PLAYBACK_FOLLOW_MS = 50;
/** How often playback looks for the end of its loop: it can run this much past it before going back */
const LOOP_CHECK_MS = 10;

/**
 * Plays a file or a recording in the browser, from the WAV the server makes of
 * it (the server answers Range requests, so the browser can start anywhere).
 * toggle(from) plays from the cursor, or pauses; while playing, onTime moves
 * the cursor. With a loop, playback stays in it, going back to its start at its
 * end (by a seek: a short gap can be heard). onTime and onError must be
 * stable. clip null: nothing to play.
 */
function useClipPlayer(
  url: string,
  clip: ClipInfo | null,
  loop: ClipSelection | null,
  onTime: (time: number) => void,
  onError: (error: string) => void,
) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const loopRef = useRef(loop);
  loopRef.current = loop;

  useEffect(() => {
    setPlaying(false);
    if (!clip) return undefined;
    // A new address for each clip, so that no cache serves the previous one
    const audio = new Audio(`${url}?v=${Date.now()}`);
    audio.preload = 'auto';
    audioRef.current = audio;
    audio.addEventListener('play', () => setPlaying(true));
    audio.addEventListener('pause', () => setPlaying(false));
    audio.addEventListener('ended', () => {
      const zone = loopRef.current;
      if (!zone) {
        onTime(clip.duration);
        return;
      }
      // A loop up to the end of the clip
      audio.currentTime = zone.start;
      void audio.play().catch(() => undefined);
    });
    audio.addEventListener('error', () => {
      setPlaying(false);
      onError(t('analyzer.playback.failed'));
    });
    // Polled rather than on 'timeupdate' (4 times a second), and only while playing:
    // a pause can come from placing the cursor elsewhere, which then wins
    let followed = 0;
    const tick = window.setInterval(() => {
      if (audio.paused) return;
      const zone = loopRef.current;
      if (zone && audio.currentTime >= zone.end) audio.currentTime = zone.start;
      if (performance.now() - followed >= PLAYBACK_FOLLOW_MS) {
        followed = performance.now();
        onTime(audio.currentTime);
      }
    }, LOOP_CHECK_MS);
    return () => {
      window.clearInterval(tick);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if (audioRef.current === audio) audioRef.current = null;
    };
  }, [url, clip, onTime, onError]);

  /** Plays from `from`, or pauses where playback is */
  const toggle = useCallback(
    (from: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      if (!audio.paused) {
        audio.pause();
        onTime(audio.currentTime);
        return;
      }
      // Kept by the browser even before the WAV has loaded. From outside the loop (the whole
      // clip without one) or from its end, it starts at its start (the end of the clip can
      // fall a hair before the end of its WAV, which would play nothing)
      const start = loopRef.current?.start ?? 0;
      const end = loopRef.current?.end ?? clip?.duration ?? 0;
      audio.currentTime = from >= start && from < end - 0.01 ? from : start;
      audio.play().catch((error: unknown) => {
        // AbortError: paused or replaced before it could start
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          onError(t('analyzer.playback.impossible', { error: describe(error) }));
        }
      });
    },
    [clip, onTime, onError],
  );

  const pause = useCallback(() => audioRef.current?.pause(), []);
  return { playing, toggle, pause };
}

export function Analyzer({ onSaveInstrument }: { onSaveInstrument: (instrument: Instrument) => void }) {
  const { t, formatNumber } = useI18n();
  const server = useSynthServer();
  const online = server.connection === 'online' && server.coreLoaded;
  const [source, setSource] = usePersistentState<Source>('synthway.analyzer.source.v1', () => 'micro');
  const [a4, setA4] = usePersistentState<number>('synthway.analyzer.a4.v1', () => 440);
  const [inputDevice, setInputDevice] = usePersistentState<number>('synthway.analyzer.input.v1', () => -1);
  /** In dBFS; NOISE_GATE_OFF: off, the default */
  const [noiseGate, setNoiseGate] = usePersistentState<number>('synthway.analyzer.noise-gate.v1', () => NOISE_GATE_OFF);
  /** Analysis window of the cursor (and of each moment of a zone), in ms */
  const [windowMs, setWindowMs] = usePersistentState<number>(
    'synthway.analyzer.window-ms.v1',
    () => ANALYSIS_WINDOW_DEFAULT_MS,
  );
  /** A reference note fixed by the user (MIDI), null: the note heard. Kept for this visit only: it belongs to one sound */
  const [referenceMidi, setReferenceMidi] = useState<number | null>(null);
  const referenceHz = referenceMidi === null ? 0 : midiFrequency(referenceMidi, a4);
  /** Only the partials near a whole ratio: on by default, a mix holds other instruments */
  const [harmonicsOnly, setHarmonicsOnly] = usePersistentState<boolean>('synthway.analyzer.harmonics-only.v1', () => true);
  /** What « Essayer l'instrument » makes the instrument of: the partials measured, or a waveform */
  const [buildFrom, setBuildFrom] = usePersistentState<BuildFrom>('synthway.analyzer.build-from.v1', () => 'measured');
  const optionsRef = useRef<AnalysisOptions>({ noiseGateDb: noiseGate, windowMs, referenceHz, harmonicCents: 0 });
  optionsRef.current = { noiseGateDb: noiseGate, windowMs, referenceHz, harmonicCents: harmonicsOnly ? HARMONIC_CENTS : 0 };
  /** « Essayer l'instrument » on a zone: its envelopes are being measured */
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** The trial instrument, played on the keyboard at the bottom; null: none */
  const [draft, setDraft] = useState<Draft | null>(null);
  useInstrumentSound(draft?.instrument ?? null);

  /* ---------- Microphone ---------- */

  const [listening, setListening] = useState<Listening>('off');
  const [inputRate, setInputRate] = useState<number | null>(null);
  const [inputExclusive, setInputExclusive] = useState(false);
  const [liveAnalysis, setLiveAnalysis] = useState<Analysis | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const socketRef = useRef<AnalyzerSocket | null>(null);
  const listeningRef = useRef<Listening>('off');
  listeningRef.current = listening;

  // Recording: in the core, then shown like a file, with a cursor (null: none, the live analysis shows)
  const [recording, setRecording] = useState<Listening>('off');
  const [recordTimes, setRecordTimes] = useState<RecordingTimes | null>(null);
  const [recorded, setRecorded] = useState(0); // recordings finished on this screen: each one is fetched
  const [recordClip, setRecordClip] = useState<ClipInfo | null>(null);
  const [recordTime, setRecordTime] = useState<number | null>(null);
  const [recordAnalysis, setRecordAnalysis] = useState<Analysis | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const recordingRef = useRef<Listening>('off');
  recordingRef.current = recording;
  const [recordSelection, setRecordSelection] = useState<ClipSelection | null>(null);
  const {
    playing: recordPlaying,
    toggle: toggleRecordPlayback,
    pause: pauseRecordPlayback,
  } = useClipPlayer(RECORDING_WAV_URL, online ? recordClip : null, recordSelection, setRecordTime, setRecordError);

  const onSocketMessage = useCallback((message: AnalyzerMessage) => {
    if (message.type === 'started') {
      setListening('on');
      setInputRate(message.sample_rate);
      setInputExclusive(message.exclusive === true);
      setLiveError(null);
      // « Enregistrer » with the microphone closed: it is open now
      if (recordingRef.current === 'starting') socketRef.current?.record();
    } else if (message.type === 'analysis') {
      if (listeningRef.current !== 'off') setLiveAnalysis(message.analysis);
      if (message.recording) setRecordTimes(message.recording);
    } else if (message.type === 'recording') {
      setRecording('on');
    } else if (message.type === 'recorded') {
      setRecording('off');
      setRecordTimes({ duration: message.duration, lost: message.lost });
      setRecorded((count) => count + 1);
    } else if (message.type === 'stopped') {
      setListening('off');
    } else if (message.type === 'error') {
      setLiveError(message.error);
      if (listeningRef.current === 'starting') setListening('off');
      if (recordingRef.current === 'starting') setRecording('off');
    }
  }, []);

  const onSocketClose = useCallback(() => {
    if (listeningRef.current !== 'off') setLiveError(translateNow('analyzer.mic.connectionLost'));
    setListening('off');
    setRecording('off');
  }, []);

  const startListening = () => {
    socketRef.current ??= new AnalyzerSocket(onSocketMessage, onSocketClose);
    setLiveError(null);
    setLiveAnalysis(null);
    pauseRecordPlayback();
    setRecordTime(null); // listening again removes the cursor and the zone from the recording
    setRecordSelection(null);
    setListening('starting');
    socketRef.current.start(inputDevice, noiseGate);
  };

  // While listening, a new noise gate applies at once
  useEffect(() => {
    socketRef.current?.setNoiseGate(noiseGate);
  }, [noiseGate]);

  const stopListening = useCallback(() => {
    if (listeningRef.current === 'off') return;
    socketRef.current?.stop();
    setListening('off');
  }, []);

  // Leaving the screen closes the socket, and the server closes the microphone
  useEffect(() => () => socketRef.current?.close(), []);
  useEffect(() => {
    if (source !== 'micro' || !online) stopListening();
    if (source !== 'micro') pauseRecordPlayback();
  }, [source, online, stopListening, pauseRecordPlayback]);

  /* ---------- Recording ---------- */

  const startRecording = () => {
    setRecordClip(null);
    setRecordTime(null);
    setRecordSelection(null);
    setRecordAnalysis(null);
    setRecordTimes(null);
    setRecordError(null);
    setRecording('starting');
    // The microphone opens first if needed: 'started' then asks to record
    if (listeningRef.current === 'on') socketRef.current?.record();
    else if (listeningRef.current === 'off') startListening();
  };

  // Placing the cursor pauses playback and stops listening: the panels below show the recording
  const seekRecording = useCallback(
    (time: number) => {
      pauseRecordPlayback();
      stopListening();
      setRecordTime(time);
    },
    [pauseRecordPlayback, stopListening],
  );

  // Playing it stops listening too, and starts from the cursor (the start when there is none)
  const playOrPauseRecording = () => {
    stopListening();
    toggleRecordPlayback(recordTime ?? 0);
  };

  // The recording just finished, or the last one when the screen opens: the cursor goes to its clearest moment
  useEffect(() => {
    if (!online) return undefined;
    let cancelled = false;
    void api.recording().then((loaded) => {
      if (cancelled || !loaded || recordingRef.current !== 'off') return;
      setRecordClip(loaded);
      setRecordSelection(null);
      seekRecording(clearestMoment(loaded));
    });
    return () => {
      cancelled = true;
    };
  }, [online, recorded, seekRecording]);

  const requestRecordAnalysis = useAnalysisRequests(api.analyzeRecording, optionsRef, setRecordAnalysis, setRecordError);
  const recordTarget = useAnalysisTarget(recordSelection, recordTime);
  useEffect(() => {
    if (recordClip && recordTarget && online) void requestRecordAnalysis(recordTarget);
  }, [recordClip, recordTarget, noiseGate, windowMs, referenceHz, harmonicsOnly, online, requestRecordAnalysis]);

  const downloadRecording = () => {
    const link = document.createElement('a');
    link.href = RECORDING_WAV_URL;
    link.download = '';
    link.click();
  };

  /* ---------- File ---------- */

  const [clip, setClip] = useState<ClipInfo | null>(null);
  const [clipTime, setClipTime] = useState(0);
  const [clipAnalysis, setClipAnalysis] = useState<Analysis | null>(null);
  const [uploading, setUploading] = useState(false);
  const [clipError, setClipError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [clipSelection, setClipSelection] = useState<ClipSelection | null>(null);
  const {
    playing: clipPlaying,
    toggle: toggleClipPlayback,
    pause: pauseClipPlayback,
  } = useClipPlayer(ANALYZER_CLIP_WAV_URL, online ? clip : null, clipSelection, setClipTime, setClipError);

  // Placing the cursor pauses playback
  const seekClip = (time: number) => {
    pauseClipPlayback();
    setClipTime(time);
  };

  const showClip = useCallback((loaded: ClipInfo) => {
    setClip(loaded);
    setClipAnalysis(null);
    setClipTime(0);
    setClipSelection(null);
  }, []);

  // The server keeps the file loaded last: shown again when the screen opens
  useEffect(() => {
    if (!online || clip) return;
    let cancelled = false;
    void api.clip().then((loaded) => {
      if (!cancelled && loaded) showClip(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [online, clip, showClip]);

  const upload = async (file: File) => {
    setUploading(true);
    setClipError(null);
    pauseClipPlayback();
    try {
      showClip(await api.uploadClip(file));
    } catch (error) {
      setClipError(t('analyzer.file.uploadError', { name: file.name, error: describe(error) }));
    } finally {
      setUploading(false);
    }
  };

  const requestAnalysis = useAnalysisRequests(api.analyzeClip, optionsRef, setClipAnalysis, setClipError);
  const clipTarget = useAnalysisTarget(clipSelection, clipTime);

  useEffect(() => {
    if (clip && clipTarget && online) void requestAnalysis(clipTarget);
  }, [clip, clipTarget, noiseGate, windowMs, referenceHz, harmonicsOnly, online, requestAnalysis]);

  useEffect(() => {
    if (source !== 'file') pauseClipPlayback();
  }, [source, pauseClipPlayback]);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropping(false);
    const file = event.dataTransfer.files[0];
    if (file && online && !uploading) void upload(file);
  };

  /* ---------- Display ---------- */

  const onRecording = source === 'micro' && recordTarget !== null;
  const analysis = source === 'micro' ? (onRecording ? recordAnalysis : liveAnalysis) : clipAnalysis;
  const partials = analysis?.partials ?? [];
  const captureDevices = server.devices?.capture_devices ?? [];
  /** What the analysis shown looks at: null for the microphone, live */
  const analyzedTarget = source === 'micro' ? (onRecording ? recordTarget : null) : clipTarget;
  const zoneMode = analyzedTarget !== null && !('time' in analyzedTarget);
  const measured = partials.filter((partial) => partial.ratio > 0);
  const canCreate = online && analysis !== null && analysis.frequency > 0 && measured.length > 0;
  const shownNote = analysis && analysis.frequency > 0 ? frequencyToNote(analysis.frequency, a4) : null;
  const shownNoteName = shownNote ? `${shownNote.name}${shownNote.octave}` : '';
  // Harmonics of the note part from about 6 periods of it on: a shorter window mixes them
  const minWindowMs = analysis && analysis.frequency > 0 ? Math.ceil((PERIODS_PER_WINDOW * 1000) / analysis.frequency) : 0;
  const windowTooShort = analyzedTarget !== null && minWindowMs > windowMs;
  const zoneClip = source === 'micro' ? recordClip : clip;
  const zoneOtherNotes =
    zoneMode && zoneClip && analyzedTarget && 'start' in analyzedTarget && analysis && analysis.frequency > 0
      ? otherNotesShare(zoneClip, analyzedTarget, analysis.frequency)
      : 0;
  /** The fixed reference note's pitch class and octave, to edit them */
  const referencePitchClass = referenceMidi === null ? 0 : ((referenceMidi % 12) + 12) % 12;
  const setReference = (midi: number) =>
    setReferenceMidi(Math.max(REFERENCE_MIDI_MIN, Math.min(REFERENCE_MIDI_MAX, Math.round(midi))));

  /* ---------- Notes of the zone: several at once, and when each plays ---------- */

  const [zoneNotes, setZoneNotes] = useState<NoteSpan[] | null>(null);
  /** The zone the notes were found in, while one of them is analyzed alone */
  const [notesZone, setNotesZone] = useState<ClipSelection | null>(null);
  const zone = analyzedTarget && 'start' in analyzedTarget ? analyzedTarget : null;
  const zoneKey = zone ? `${source}:${zone.start.toFixed(4)}:${zone.end.toFixed(4)}` : '';
  useEffect(() => {
    if (!online || !zone) {
      setZoneNotes(null);
      return undefined;
    }
    let cancelled = false;
    const find = source === 'micro' ? api.recordingNotes : api.clipNotes;
    find(zone, optionsRef.current)
      .then((notes) => {
        if (!cancelled) setZoneNotes(notes);
      })
      .catch(() => {
        if (!cancelled) setZoneNotes(null);
      });
    return () => {
      cancelled = true;
    };
    // zone is followed through zoneKey: it is a new object at every render
  }, [zoneKey, windowMs, noiseGate, online]);
  const selectZone = source === 'micro' ? setRecordSelection : setClipSelection;
  /** One note alone: its time in the zone, and the ratios taken to it (the other notes are left out) */
  const analyzeNote = (span: NoteSpan) => {
    const note = frequencyToNote(span.frequency, a4);
    if (!note) return;
    setNotesZone((kept) => kept ?? zone);
    setReference(note.midi);
    selectZone({ start: span.start, end: span.end });
  };
  const backToNotesZone = () => {
    selectZone(notesZone);
    setReferenceMidi(null);
    setNotesZone(null);
  };
  /** Another zone chosen by hand: the notes are found again in it */
  const selectByHand = (select: (zone: ClipSelection | null) => void) => (picked: ClipSelection | null) => {
    select(picked);
    setNotesZone(null);
  };
  const strongNotes = zoneNotes?.filter((span) => span.strength >= STRONG_NOTE) ?? [];

  /* ---------- Waveform of the note: which shape its harmonics are closest to ---------- */

  const [waveFit, setWaveFit] = useState<WaveformFit | null>(null);
  const [waveFitLoading, setWaveFitLoading] = useState(false);
  const [waveFitError, setWaveFitError] = useState<string | null>(null);
  const fitTarget = analyzedTarget ? fitZone(analyzedTarget, windowMs) : null;
  const fitKey = fitTarget
    ? `${source}:${clipKeyOf(zoneClip)}:${fitTarget.start.toFixed(4)}:${fitTarget.end.toFixed(4)}:${referenceHz.toFixed(3)}`
    : '';
  useEffect(() => {
    if (!online || !fitTarget) {
      setWaveFit(null);
      setWaveFitError(null);
      setWaveFitLoading(false);
      return undefined;
    }
    let cancelled = false;
    setWaveFitLoading(true);
    const fitOf = source === 'micro' ? api.recordingWaveformFit : api.clipWaveformFit;
    fitOf(fitTarget, optionsRef.current)
      .then((fit) => {
        if (cancelled) return;
        setWaveFit(fit);
        setWaveFitError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setWaveFit(null);
        setWaveFitError(translateNow('analyzer.build.waveformError', { error: describe(error) }));
      })
      .finally(() => {
        if (!cancelled) setWaveFitLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // fitTarget is followed through fitKey: it is a new object at every render
  }, [fitKey, windowMs, noiseGate, online]);
  const noteLabel = (frequency: number) => {
    const note = frequencyToNote(frequency, a4);
    return note ? `${note.name}${note.octave}` : `${Math.round(frequency)} Hz`;
  };
  /** The note fitted is a weak one of the zone (a trace under the notes played): its strength, and the strong ones */
  const fittedSpan =
    waveFit && waveFit.frequency > 0
      ? zoneNotes?.find((span) => Math.abs(1200 * Math.log2(span.frequency / waveFit.frequency)) < 50)
      : undefined;
  const weakFittedNote =
    fittedSpan && fittedSpan.strength < STRONG_NOTE
      ? { strength: fittedSpan.strength, strong: strongNotes.map((span) => noteLabel(span.frequency)) }
      : null;

  /* ---------- Trial instrument ---------- */

  const basis = analysisBasis(source, clipKeyOf(zoneClip), analyzedTarget, [
    windowMs,
    noiseGate,
    referenceMidi ?? 'auto',
    harmonicsOnly,
    a4,
    buildFrom,
  ]);
  /** The selection or a setting changed since the trial instrument was made */
  const draftStale = draft !== null && draft.basis !== basis;
  /** Its zone or moment can be brought back: it was made on the sound still loaded there */
  const draftSelectionBack =
    draft !== null &&
    draft.target !== null &&
    draft.clipKey === clipKeyOf(draft.source === 'micro' ? recordClip : clip) &&
    analysisBasis(draft.source, draft.clipKey, draft.target, [draft.referenceMidi ?? 'auto']) !==
      analysisBasis(source, clipKeyOf(zoneClip), analyzedTarget, [referenceMidi ?? 'auto']);
  const originalZone = source === 'micro' ? recordSelection : clipSelection;
  const originalPlaying = source === 'micro' ? recordPlaying : clipPlaying;

  /**
   * An instrument from the partials shown. A zone also gives each partial its
   * envelope, measured on the note (synthway_analyzer_measure_envelopes); a
   * moment gives one envelope for all. null: none (createError says why).
   */
  const makeInstrument = async (): Promise<{ instrument: Instrument; noteMidi: number | null; shape: ShapeFit | null } | null> => {
    if (!analysis || !canCreate || creating) return null;
    const target = analyzedTarget;
    // Its name and description are written in the language of the moment, and stay so
    const described = describeAnalyzed(target, windowMs);
    const origin =
      source === 'micro'
        ? onRecording
          ? t('analyzer.build.originRecording')
          : t('analyzer.build.originLive')
        : clip?.name ?? t('analyzer.build.originFile');
    const prefix =
      source === 'micro'
        ? onRecording
          ? t('analyzer.build.prefixRecording')
          : t('analyzer.build.prefixLive')
        : clip?.name ?? t('analyzer.build.prefixFile');
    const harmonics = harmonicsOnly && target ? t('analyzer.build.harmonicsOnly') : '';
    let found = analysis;
    let partialsMade: { ratio: number; amplitude: number; envelope?: EnvelopeParams }[] = measured;
    setCreateError(null);
    if (target && 'start' in target) {
      setCreating(true);
      try {
        const measure = source === 'micro' ? api.recordingEnvelopes : api.clipEnvelopes;
        const result = await measure(target, optionsRef.current);
        found = result.analysis;
        partialsMade = result.analysis.partials
          .map((partial, i) => ({ ratio: partial.ratio, amplitude: partial.amplitude, envelope: result.envelopes[i] }))
          .filter((partial) => partial.ratio > 0 && partial.envelope);
      } catch (error) {
        setCreateError(t('analyzer.build.envelopesError', { error: describe(error) }));
        return null;
      } finally {
        setCreating(false);
      }
      if (found.frequency <= 0 || partialsMade.length === 0) {
        setCreateError(t('analyzer.build.envelopesEmpty'));
        return null;
      }
    }

    // A waveform: its harmonics as sines, its low-pass in the filter, and one
    // envelope for all, the one measured on the strongest partial
    let shape: ShapeFit | null = null;
    if (buildFrom !== 'measured' && target) {
      setCreating(true);
      try {
        const fitOf = source === 'micro' ? api.recordingWaveformFit : api.clipWaveformFit;
        const fitted = await fitOf(fitZone(target, windowMs), optionsRef.current);
        shape = chosenFit(fitted, buildFrom);
        if (!shape) {
          setCreateError(
            fitted.frequency > 0 && fitted.moments === 0 ? t('analyzer.build.neverAlone') : t('analyzer.build.noShape'),
          );
          return null;
        }
      } catch (error) {
        setCreateError(t('analyzer.build.waveformError', { error: describe(error) }));
        return null;
      } finally {
        setCreating(false);
      }
      const strongest = partialsMade.reduce<(typeof partialsMade)[number] | undefined>(
        (best, partial) => (!best || partial.amplitude > best.amplitude ? partial : best),
        undefined,
      );
      partialsMade = shapePartials(shape, found.frequency).map((partial) => ({ ...partial, envelope: strongest?.envelope }));
    }

    const note = frequencyToNote(found.frequency, a4);
    const noteName = note ? `${note.name}${note.octave}` : '';
    const count = partialsMade.length;
    const zoneTarget = target !== null && 'start' in target;
    const made = shape
      ? t('analyzer.build.shape', {
          count,
          shape: describeShape(shape),
          gap: formatNumber(shape.error_db, { maximumFractionDigits: 1 }),
          filter: shape.cutoff > 0 ? t('analyzer.build.shapeFilter') : t('analyzer.build.shapeNoFilter'),
          envelope: zoneTarget ? t('analyzer.build.shapeEnvelopeZone') : t('analyzer.build.shapeEnvelopeMoment'),
        })
      : t('analyzer.build.partials', {
          count,
          envelopes: zoneTarget ? t('analyzer.build.envelopePerPartial') : t('analyzer.build.envelopeSingle'),
        });
    const instrument = instrumentFromPartials(
      `${prefix}${noteName ? ` · ${noteName}` : ''}${shape ? ` · ${describeShape({ ...shape, cutoff: 0 })}` : ''}`,
      t('analyzer.build.description', {
        origin,
        analyzed: described,
        note: noteName || t('analyzer.build.theNote'),
        harmonics,
        made,
      }),
      partialsMade,
      // Its keyboard starts at the note's octave: C2 analyzed, octave 2
      note?.octave,
    );
    return {
      instrument: shape
        ? {
            ...instrument,
            filter: {
              lowCutoff: 20,
              cutoff: shape.cutoff > 0 ? Math.min(20000, Math.round(shape.cutoff)) : 20000,
              resonance: shape.resonance,
            },
          }
        : instrument,
      noteMidi: note?.midi ?? null,
      shape,
    };
  };

  /** « Essayer l'instrument » and « Mettre à jour »: the trial instrument, made again from the analysis shown */
  const tryInstrument = async () => {
    // What it is made from, taken now: the selection can move while the envelopes are measured
    const made = { basis, source, clipKey: clipKeyOf(zoneClip), target: analyzedTarget, referenceMidi };
    const result = await makeInstrument();
    if (!result) return;
    setDraft((previous) => ({
      ...made,
      instrument: previous?.volumeSet ? { ...result.instrument, volume: previous.instrument.volume } : result.instrument,
      noteMidi: result.noteMidi,
      volumeSet: previous?.volumeSet ?? false,
      shape: result.shape,
    }));
  };

  const setDraftVolume = (volume: number) =>
    setDraft((current) => current && { ...current, instrument: { ...current.instrument, volume }, volumeSet: true });

  const setDraftOctave = (octave: number) =>
    setDraft((current) => current && { ...current, instrument: { ...current.instrument, octave } });

  /** Its zone (or moment) and reference note again, after a click elsewhere on the sound */
  const backToDraftSelection = () => {
    if (!draft?.target) return;
    const { target } = draft;
    const zone = 'start' in target ? { start: target.start, end: target.end } : null;
    setSource(draft.source);
    setReferenceMidi(draft.referenceMidi);
    setNotesZone(null);
    if (draft.source === 'micro') {
      pauseRecordPlayback();
      stopListening();
      setRecordSelection(zone);
      if ('time' in target) setRecordTime(target.time);
    } else {
      pauseClipPlayback();
      setClipSelection(zone);
      if ('time' in target) setClipTime(target.time);
    }
  };

  /** The zone selected, in a loop: the sound to compare the trial instrument with */
  const playOriginal = () => {
    if (!originalZone) return;
    if (source === 'micro') {
      stopListening();
      toggleRecordPlayback(originalZone.start);
    } else {
      toggleClipPlayback(originalZone.start);
    }
  };

  const saveDraft = () => {
    if (draft) onSaveInstrument(draft.instrument);
  };

  // The space bar is the « Lire » / « Pause » button of the tab shown, from the cursor
  useSpaceBar(() => {
    if (!online) return;
    if (source === 'file') {
      if (clip) toggleClipPlayback(clipTime);
    } else if (recordClip && recording === 'off') {
      playOrPauseRecording();
    }
  });

  return (
    <div className={layout.screen}>
      <ScreenHeader
        index="02"
        eyebrow={t('analyzer.eyebrow')}
        title="Analyzer"
        subtitle={t('analyzer.subtitle')}
      >
        <Segmented
          label={t('analyzer.source.label')}
          value={source}
          onChange={setSource}
          options={[
            {
              value: 'micro',
              label: t('analyzer.source.micro'),
              icon: <Mic size={14} />,
              title: t('analyzer.source.microTitle'),
            },
            {
              value: 'file',
              label: t('analyzer.source.file'),
              icon: <FileAudio size={14} />,
              title: t('analyzer.source.fileTitle'),
            },
          ]}
        />
      </ScreenHeader>

      <div className={styles.body}>
        <Panel className={styles.source}>
          {source === 'micro' ? (
            <>
              <Section
                title={t('analyzer.mic.title')}
                badge={
                  listening === 'on' ? (
                    <Badge tone="live">{t('analyzer.mic.listening')}</Badge>
                  ) : listening === 'starting' ? (
                    <Badge>{t('analyzer.opening')}</Badge>
                  ) : (
                    <Badge>{t('analyzer.mic.off')}</Badge>
                  )
                }
              >
                <div className={styles.micRow}>
                  <Field label={t('analyzer.mic.input')}>
                    <select
                      className={selectClass}
                      value={inputDevice}
                      disabled={listening !== 'off'}
                      onChange={(event) => setInputDevice(Number(event.target.value))}
                    >
                      <option value={-1}>{t('analyzer.mic.defaultInput')}</option>
                      {captureDevices.map((device) => (
                        <option key={device.index} value={device.index}>
                          {device.is_default ? t('analyzer.mic.defaultDevice', { name: device.name }) : device.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Button
                    variant={listening === 'off' ? 'primary' : 'default'}
                    disabled={!online || listening === 'starting'}
                    onClick={listening === 'off' ? startListening : stopListening}
                  >
                    {listening === 'off' ? <Mic size={15} /> : <MicOff size={15} />}
                    {listening === 'off' ? t('analyzer.mic.listen') : t('analyzer.mic.stop')}
                  </Button>
                </div>
                <p className={styles.note}>
                  {listening === 'on'
                    ? `${t('analyzer.mic.listeningAt', { rate: ((inputRate ?? 0) / 1000).toFixed(1) })} ${
                        recording === 'on' ? t('analyzer.mic.recordingNow') : t('analyzer.mic.nothingRecorded')
                      }`
                    : t('analyzer.mic.idle')}
                </p>
                {listening === 'on' &&
                  (inputExclusive ? (
                    <p className={styles.note}>{t('analyzer.mic.exclusive')}</p>
                  ) : (
                    <p className={styles.warning}>{t('analyzer.mic.shared')}</p>
                  ))}
                {!online && <p className={styles.note}>{t('analyzer.offline')}</p>}
                {liveError && <p className={styles.error}>{liveError}</p>}
              </Section>

              <Section
                title={t('analyzer.record.title')}
                className={styles.recordSection}
                badge={
                  recording === 'on' ? (
                    <Badge tone="danger">● {(recordTimes?.duration ?? 0).toFixed(1)} s</Badge>
                  ) : recording === 'starting' ? (
                    <Badge>{t('analyzer.opening')}</Badge>
                  ) : recordClip ? (
                    <Badge>{formatDuration(recordClip.duration)}</Badge>
                  ) : undefined
                }
                actions={
                  <>
                    {recordClip && recording === 'off' && (
                      <>
                        <Button
                          size="small"
                          disabled={!online}
                          onClick={playOrPauseRecording}
                          title={recordPlaying ? t('analyzer.playback.pauseTitle') : t('analyzer.record.playTitle')}
                        >
                          {recordPlaying ? <Pause size={13} /> : <Play size={13} />}
                          {recordPlaying ? t('analyzer.playback.pause') : t('analyzer.playback.play')}
                        </Button>
                        <Button size="small" onClick={downloadRecording} title={t('analyzer.record.downloadTitle')}>
                          <Download size={13} />
                          {t('analyzer.record.download')}
                        </Button>
                      </>
                    )}
                    <Button
                      size="small"
                      variant={recording === 'off' ? 'primary' : 'default'}
                      disabled={!online || recording === 'starting'}
                      onClick={recording === 'off' ? startRecording : () => socketRef.current?.stopRecord()}
                      title={recording === 'off' ? t('analyzer.record.startTitle') : undefined}
                    >
                      {recording === 'off' ? <Circle size={13} /> : <Square size={13} />}
                      {recording === 'off' ? t('analyzer.record.start') : t('analyzer.record.stop')}
                    </Button>
                  </>
                }
              >
                <div className={styles.drop}>
                  {recordClip ? (
                    <ClipWaveform
                      clip={recordClip}
                      time={recordTime}
                      a4={a4}
                      zoomable
                      playing={recordPlaying}
                      loadWaveform={api.recordingWaveform}
                      onSeek={seekRecording}
                      selection={recordSelection}
                      onSelect={selectByHand(setRecordSelection)}
                      windowSeconds={windowMs / 1000}
                      label={t('analyzer.record.waveformLabel')}
                    />
                  ) : (
                    <div className={styles.dropHint} data-recording={recording === 'on' ? 'true' : undefined}>
                      <Circle size={28} />
                      {recording === 'on' ? (
                        <span>{t('analyzer.record.inProgress', { seconds: (recordTimes?.duration ?? 0).toFixed(1) })}</span>
                      ) : (
                        <span>{t('analyzer.record.hint')}</span>
                      )}
                      <span className={styles.note}>{t('analyzer.record.placeholder')}</span>
                    </div>
                  )}
                </div>
                {recordClip && recording === 'off' && (
                  <p className={styles.note}>
                    {(recordClip.sample_rate / 1000).toFixed(1)} kHz ·{' '}
                    {recordTime === null ? t('analyzer.record.noCursor') : t('analyzer.record.withCursor')}
                  </p>
                )}
                {recordClip && recordSelection && <p className={styles.note}>{describeZone(recordSelection)}</p>}
                {recordTimes && recordTimes.lost > 0 && (
                  <p className={styles.warning}>{t('analyzer.record.lost', { seconds: recordTimes.lost.toFixed(2) })}</p>
                )}
                {recordError && <p className={styles.error}>{recordError}</p>}
              </Section>
            </>
          ) : (
            <Section
              title={t('analyzer.file.title')}
              badge={clip ? <Badge>{clip.name}</Badge> : undefined}
              actions={
                <>
                  {clip && (
                    <>
                      <Button
                        size="small"
                        disabled={!online}
                        onClick={() => toggleClipPlayback(clipTime)}
                        title={clipPlaying ? t('analyzer.playback.pauseTitle') : t('analyzer.file.playTitle')}
                      >
                        {clipPlaying ? <Pause size={13} /> : <Play size={13} />}
                        {clipPlaying ? t('analyzer.playback.pause') : t('analyzer.playback.play')}
                      </Button>
                      <Button
                        size="small"
                        onClick={() => seekClip(clearestMoment(clip))}
                        title={t('analyzer.file.clearestTitle')}
                      >
                        <Crosshair size={13} />
                        {t('analyzer.file.clearest')}
                      </Button>
                    </>
                  )}
                  <Button size="small" variant="primary" disabled={!online || uploading} onClick={() => fileInput.current?.click()}>
                    <Upload size={13} />
                    {uploading ? t('analyzer.file.loading') : t('analyzer.file.import')}
                  </Button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept={ACCEPTED_FILES}
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void upload(file);
                    }}
                  />
                </>
              }
            >
              <div
                className={styles.drop}
                data-dropping={dropping ? 'true' : undefined}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDropping(true);
                }}
                onDragLeave={() => setDropping(false)}
                onDrop={onDrop}
              >
                {clip ? (
                  <ClipWaveform
                    clip={clip}
                    time={clipTime}
                    a4={a4}
                    zoomable
                    stereo
                    playing={clipPlaying}
                    loadWaveform={api.clipWaveform}
                    onSeek={seekClip}
                    selection={clipSelection}
                    onSelect={selectByHand(setClipSelection)}
                    windowSeconds={windowMs / 1000}
                  />
                ) : (
                  <div className={styles.dropHint}>
                    <FileAudio size={28} />
                    <span>{t('analyzer.file.drop')}</span>
                    <span className={styles.note}>{t('analyzer.file.dropNote')}</span>
                  </div>
                )}
              </div>
              {clip && (
                <p className={styles.note}>
                  {t('analyzer.file.info', {
                    duration: formatDuration(clip.duration),
                    rate: (clip.sample_rate / 1000).toFixed(1),
                  })}
                </p>
              )}
              {clip && clipSelection && <p className={styles.note}>{describeZone(clipSelection)}</p>}
              {!online && <p className={styles.note}>{t('analyzer.offline')}</p>}
              {clipError && <p className={styles.error}>{clipError}</p>}
            </Section>
          )}
        </Panel>

        <Panel className={styles.tunerPanel}>
          <Section
            title={t('analyzer.note.title')}
            actions={
              <label className={styles.a4} title={t('analyzer.note.a4Title')}>
                {t('analyzer.note.a4')}
                <input
                  className={inputClass}
                  type="number"
                  min={400}
                  max={480}
                  step={0.5}
                  value={a4}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (value >= 400 && value <= 480) setA4(value);
                  }}
                />
                Hz
              </label>
            }
          >
            <Tuner analysis={analysis} a4={a4} hold={source === 'micro' && !onRecording} />
            <div className={styles.referenceRow}>
              <span className={styles.referenceLabel}>{t('analyzer.note.reference')}</span>
              <Segmented
                compact
                label={t('analyzer.note.reference')}
                value={referenceMidi === null ? 'auto' : 'fixed'}
                onChange={(mode) =>
                  mode === 'auto' ? setReferenceMidi(null) : setReference(shownNote?.midi ?? 43)
                }
                options={[
                  { value: 'auto', label: t('analyzer.note.auto'), title: t('analyzer.note.autoTitle') },
                  { value: 'fixed', label: t('analyzer.note.fixed'), title: t('analyzer.note.fixedTitle') },
                ]}
              />
              {referenceMidi !== null && (
                <span className={styles.referencePicker}>
                  <select
                    className={selectClass}
                    aria-label={t('analyzer.note.referenceName')}
                    value={referencePitchClass}
                    onChange={(event) => setReference(referenceMidi - referencePitchClass + Number(event.target.value))}
                  >
                    {NOTE_NAMES.map((name, index) => (
                      <option key={name} value={index}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <Button size="small" iconOnly title={t('analyzer.note.octaveDown')} onClick={() => setReference(referenceMidi - 12)}>
                    <Minus size={13} />
                  </Button>
                  <span className={styles.mono}>
                    {midiLabel(referenceMidi)} · {referenceHz.toFixed(1)} Hz
                  </span>
                  <Button size="small" iconOnly title={t('analyzer.note.octaveUp')} onClick={() => setReference(referenceMidi + 12)}>
                    <Plus size={13} />
                  </Button>
                </span>
              )}
            </div>
            <p className={styles.note}>
              {referenceMidi === null
                ? t('analyzer.note.autoNote')
                : t('analyzer.note.fixedNote', { note: midiLabel(referenceMidi) })}
            </p>
          </Section>
        </Panel>

        <Panel className={styles.spectrumPanel}>
          <Section
            title={t('analyzer.spectrum.title')}
            badge={analysis ? <Badge>{(analysis.sample_rate / 1000).toFixed(1)} kHz</Badge> : undefined}
          >
            <div className={styles.spectrum}>
              <AnalysisSpectrum analysis={analysis} noiseGateDb={noiseGate > NOISE_GATE_OFF ? noiseGate : undefined} />
            </div>
            <div className={styles.gateRow}>
              <Slider
                label={t('analyzer.spectrum.gate')}
                value={Math.max(0, Math.min(GATE_SLIDER_MAX, noiseGate - GATE_SLIDER_ZERO_DB))}
                min={0}
                max={GATE_SLIDER_MAX}
                step={1}
                // The gate itself, not the slider's position: a typed gate can lie beyond its travel
                format={() => formatNoiseGate(noiseGate)}
                onChange={(value) => setNoiseGate(value === 0 ? NOISE_GATE_OFF : value + GATE_SLIDER_ZERO_DB)}
                edit={{
                  value: noiseGate,
                  min: NOISE_GATE_OFF,
                  max: 0,
                  unit: 'dBFS',
                  decimals: 1,
                  onCommit: setNoiseGate,
                  extra: (
                    <div className={styles.gateExtra}>
                      <Button
                        size="small"
                        disabled={noiseGate <= NOISE_GATE_OFF}
                        onClick={() => setNoiseGate(NOISE_GATE_OFF)}
                      >
                        {t('analyzer.spectrum.gateDisable')}
                      </Button>
                      <span>{t('analyzer.spectrum.gateOffValue', { value: NOISE_GATE_OFF })}</span>
                    </div>
                  ),
                }}
              />
              <p className={styles.note}>
                {noiseGate > NOISE_GATE_OFF ? t('analyzer.spectrum.gateOn') : t('analyzer.spectrum.gateHint')}
              </p>
            </div>
            <div className={styles.gateRow}>
              <Slider
                label={t('analyzer.spectrum.window')}
                value={Math.max(ANALYSIS_WINDOW_MIN_MS, Math.min(ANALYSIS_WINDOW_MAX_MS, windowMs))}
                min={ANALYSIS_WINDOW_MIN_MS}
                max={ANALYSIS_WINDOW_MAX_MS}
                step={5}
                format={() => `${windowMs} ms`}
                onChange={setWindowMs}
                edit={{
                  value: windowMs,
                  min: ANALYSIS_WINDOW_MIN_MS,
                  max: ANALYSIS_WINDOW_MAX_MS,
                  unit: 'ms',
                  decimals: 0,
                  onCommit: (value) => setWindowMs(Math.round(value)),
                  extra: (
                    <div className={styles.gateExtra}>
                      <Button
                        size="small"
                        disabled={windowMs === ANALYSIS_WINDOW_DEFAULT_MS}
                        onClick={() => setWindowMs(ANALYSIS_WINDOW_DEFAULT_MS)}
                      >
                        {ANALYSIS_WINDOW_DEFAULT_MS} ms
                      </Button>
                      <span>{t('analyzer.spectrum.windowDefault')}</span>
                    </div>
                  ),
                }}
              />
              <p className={styles.note}>
                {analyzedTarget === null
                  ? t('analyzer.spectrum.windowLive')
                  : zoneMode
                    ? t('analyzer.spectrum.windowZone')
                    : t('analyzer.spectrum.windowMoment')}
              </p>
              {windowTooShort && (
                <p className={styles.warning}>
                  {minWindowMs <= ANALYSIS_WINDOW_MAX_MS
                    ? t('analyzer.spectrum.windowTooShort', {
                        note: shownNoteName,
                        frequency: analysis?.frequency.toFixed(1) ?? '',
                        min: minWindowMs,
                        window: windowMs,
                      })
                    : t('analyzer.spectrum.windowTooLow', { note: shownNoteName, max: ANALYSIS_WINDOW_MAX_MS })}
                </p>
              )}
            </div>
          </Section>
        </Panel>

        <Panel className={styles.partialsPanel}>
          <Section
            title={t('analyzer.partials.title')}
            badge={<Badge>{partials.length}</Badge>}
            actions={
              <Button
                size="small"
                variant={draft && !draftStale ? 'default' : 'primary'}
                disabled={!canCreate || creating}
                onClick={() => void tryInstrument()}
                title={
                  !canCreate
                    ? t('analyzer.partials.needNote')
                    : draft
                      ? zoneMode
                        ? t('analyzer.partials.remakeZone')
                        : t('analyzer.partials.remakeMoment')
                      : zoneMode
                        ? t('analyzer.partials.makeZone')
                        : t('analyzer.partials.makeMoment')
                }
              >
                {draft ? <RefreshCw size={13} /> : <Sparkles size={13} />}
                {creating
                  ? t('analyzer.partials.measuringEnvelopes')
                  : draft
                    ? t('analyzer.partials.updateTrial')
                    : t('analyzer.partials.try')}
              </Button>
            }
          >
            <div className={styles.partialsHead}>
              <p className={styles.note}>
                {!analysis
                  ? t('analyzer.partials.empty')
                  : analyzedTarget && shownNoteName
                    ? t('analyzer.partials.analysisOfRatios', {
                        what: describeAnalyzed(analyzedTarget, windowMs),
                        note: shownNoteName,
                      })
                    : t('analyzer.partials.analysisOf', { what: describeAnalyzed(analyzedTarget, windowMs) })}
              </p>
              <Toggle
                label={t('analyzer.partials.harmonicsOnly')}
                hint={t('analyzer.partials.harmonicsOnlyHint', { cents: HARMONIC_CENTS })}
                checked={harmonicsOnly}
                onChange={setHarmonicsOnly}
              />
            </div>
            {zoneNotes && zoneNotes.length > 0 && (
              <div className={styles.zoneNotes}>
                <p className={strongNotes.length > 1 && !notesZone ? styles.warning : styles.note}>
                  {notesZone
                    ? t('analyzer.zoneNotes.single')
                    : strongNotes.length > 1
                      ? shownNoteName
                        ? t('analyzer.zoneNotes.severalNamed', { note: shownNoteName })
                        : t('analyzer.zoneNotes.several')
                      : t('analyzer.zoneNotes.heard')}
                </p>
                <div className={styles.noteChips}>
                  {zoneNotes.map((span, index) => {
                    const note = frequencyToNote(span.frequency, a4);
                    const name = note ? `${note.name}${note.octave}` : `${Math.round(span.frequency)} Hz`;
                    return (
                      <button
                        key={index}
                        type="button"
                        className={styles.noteChip}
                        data-weak={span.strength < STRONG_NOTE ? 'true' : undefined}
                        disabled={!online}
                        onClick={() => analyzeNote(span)}
                        title={t('analyzer.zoneNotes.chipTitle', {
                          name,
                          start: span.start.toFixed(2),
                          end: span.end.toFixed(2),
                          frequency: span.frequency.toFixed(1),
                          strength: Math.round(span.strength * 100),
                        })}
                      >
                        <span className={styles.noteChipName}>{name}</span>
                        <span className={styles.noteChipTime}>
                          {span.start.toFixed(2)}–{span.end.toFixed(2)} s
                        </span>
                        <span className={styles.noteChipBar}>
                          <span style={{ width: `${Math.round(span.strength * 100)}%` }} />
                        </span>
                      </button>
                    );
                  })}
                  {notesZone && (
                    <Button size="small" onClick={backToNotesZone} title={t('analyzer.zoneNotes.wholeZoneTitle')}>
                      {t('analyzer.zoneNotes.wholeZone')}
                    </Button>
                  )}
                </div>
              </div>
            )}
            {zoneOtherNotes > OTHER_NOTES_SHARE && (
              <p className={styles.warning}>
                {t('analyzer.zoneNotes.others', { note: shownNoteName, percent: Math.round(zoneOtherNotes * 100) })}
              </p>
            )}
            {analyzedTarget !== null && (
              <WaveformFitCard
                fit={waveFit}
                loading={waveFitLoading}
                error={waveFitError}
                noteName={noteLabel}
                weakNote={weakFittedNote}
                buildFrom={buildFrom}
                onBuildFrom={setBuildFrom}
              />
            )}
            {canCreate && (
              <p className={styles.note}>
                {zoneMode ? t('analyzer.partials.envelopeZone') : t('analyzer.partials.envelopeMoment')}
              </p>
            )}
            {createError && !draft && <p className={styles.warning}>{createError}</p>}
            {partials.length === 0 ? (
              <p className={styles.note}>
                {analysis ? t('analyzer.partials.noPeak') : t('analyzer.partials.placeholder')}
              </p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t('analyzer.partials.frequency')}</th>
                      <th>{t('analyzer.partials.note')}</th>
                      <th>{t('analyzer.partials.ratio')}</th>
                      <th>{t('analyzer.partials.harmonic')}</th>
                      <th>{t('analyzer.partials.amplitude')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {partials.map((partial, index) => {
                      const note = frequencyToNote(partial.frequency, a4);
                      const gap = harmonicGap(partial.ratio);
                      const harmonic = gap && Math.abs(gap.cents) <= HARMONIC_CENTS;
                      const db = 20 * Math.log10(partial.amplitude);
                      return (
                        <tr key={index}>
                          <td>
                            <span className={styles.swatch} style={{ background: partialColor(index) }} />
                            {index + 1}
                          </td>
                          <td className={styles.mono}>{partial.frequency.toFixed(2)} Hz</td>
                          <td className={styles.mono}>
                            {note ? `${note.name}${note.octave} ${formatCents(note.cents, 0)}` : '—'}
                          </td>
                          <td className={styles.mono}>{partial.ratio > 0 ? `×${partial.ratio.toFixed(3)}` : '—'}</td>
                          <td className={styles.mono} data-kind={harmonic ? 'harmonic' : 'inharmonic'}>
                            {!gap
                              ? t('analyzer.partials.belowNote')
                              : harmonic
                                ? t('analyzer.partials.harmonicNumber', { number: gap.harmonic, cents: formatCents(gap.cents) })
                                : t('analyzer.partials.inharmonic')}
                          </td>
                          <td>
                            <span className={styles.amplitude}>
                              <span className={styles.amplitudeBar}>
                                <span style={{ width: `${Math.round(partial.amplitude * 100)}%`, background: partialColor(index) }} />
                              </span>
                              <span className={styles.mono}>{db > -0.05 ? '0' : db.toFixed(1)} dB</span>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </Panel>
      </div>

      {draft && (
        <Panel as="div" className={styles.trial}>
          <div className={styles.trialInfo}>
            <span className={styles.trialHead}>
              <span className={styles.trialEyebrow}>{t('analyzer.trial.eyebrow')}</span>
              <span className={styles.trialName} title={draft.instrument.description}>
                {draft.instrument.name}
              </span>
            </span>
            <span className={styles.note}>
              {[
                t('analyzer.trial.partials', { count: draft.instrument.partials.length }),
                draft.noteMidi !== null ? t('analyzer.trial.ratiosTo', { note: midiLabel(draft.noteMidi) }) : null,
                draft.shape
                  ? describeShape(draft.shape)
                  : draft.target && 'start' in draft.target
                    ? t('analyzer.trial.envelopePerPartial')
                    : t('analyzer.trial.envelopeSingle'),
              ]
                .filter((part) => part !== null)
                .join(' · ')}
            </span>
            {createError ? (
              <span className={styles.warning}>{createError}</span>
            ) : draftStale ? (
              <span className={styles.warning}>{t('analyzer.trial.stale')}</span>
            ) : draft.target === null ? (
              <span className={styles.note}>{t('analyzer.trial.live')}</span>
            ) : (
              <span className={styles.note}>
                {draft.noteMidi !== null
                  ? t('analyzer.trial.compareNote', { note: midiLabel(draft.noteMidi) })
                  : t('analyzer.trial.compare')}
              </span>
            )}
          </div>
          <div className={styles.trialVolume}>
            <Slider
              label={t('analyzer.trial.volume')}
              value={draft.instrument.volume}
              min={0}
              max={1}
              step={0.01}
              format={(volume) => t('analyzer.trial.percent', { value: Math.round(volume * 100) })}
              onChange={setDraftVolume}
            />
          </div>
          <div className={styles.trialActions}>
            {draftSelectionBack && (
              <Button size="small" onClick={backToDraftSelection} title={t('analyzer.trial.backTitle')}>
                <Undo2 size={13} />
                {t('analyzer.trial.back')}
              </Button>
            )}
            <Button
              size="small"
              variant={draftStale ? 'primary' : 'default'}
              disabled={!canCreate || creating}
              onClick={() => void tryInstrument()}
              title={canCreate ? t('analyzer.trial.updateTitle') : t('analyzer.partials.needNote')}
            >
              <RefreshCw size={13} />
              {creating ? t('analyzer.trial.measuring') : t('analyzer.trial.update')}
            </Button>
            <Button
              size="small"
              disabled={!online || !originalZone}
              onClick={playOriginal}
              title={originalZone ? t('analyzer.trial.playOriginalTitle') : t('analyzer.trial.playOriginalNoZone')}
            >
              {originalPlaying ? <Pause size={13} /> : <Play size={13} />}
              {originalPlaying ? t('analyzer.playback.pause') : t('analyzer.trial.playOriginal')}
            </Button>
            <Button size="small" onClick={() => setDraft(null)} title={t('analyzer.trial.discardTitle')}>
              <X size={13} />
              {t('analyzer.trial.discard')}
            </Button>
            <Button size="small" variant="primary" onClick={saveDraft} title={t('analyzer.trial.saveTitle')}>
              <Save size={13} />
              {t('analyzer.trial.save')}
            </Button>
          </div>
        </Panel>
      )}
      {draft && (
        <KeyboardDock
          instrument={draft.instrument}
          onOctaveChange={setDraftOctave}
          markedNote={draft.noteMidi ?? undefined}
          markedTitle={
            draft.noteMidi !== null ? t('analyzer.trial.markedNote', { note: midiLabel(draft.noteMidi) }) : undefined
          }
        />
      )}
    </div>
  );
}
