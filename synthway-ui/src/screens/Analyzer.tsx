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
  /** The waveform it was made of (« Dent de scie, passe-bas 5,6 kHz »), null: the partials measured */
  profile: string | null;
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

function formatNoiseGate(gate: number): string {
  if (gate <= NOISE_GATE_OFF) return 'Désactivé';
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
  return `Zone de ${zone.start.toFixed(2)} s à ${zone.end.toFixed(2)} s (${formatDuration(zone.end - zone.start)}), lue en boucle par « Lire » et analysée en entier (médiane de ses moments). Un clic ou Échap la retire.`;
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
  if (!target) return 'en direct, au micro (fenêtre habituelle, environ 170 ms)';
  if ('time' in target) return `l’instant ${target.time.toFixed(2)} s, à travers une fenêtre de ${windowMs} ms`;
  return `la zone de ${target.start.toFixed(2)} s à ${target.end.toFixed(2)} s : médiane de ses moments, par fenêtres de ${windowMs} ms`;
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
      onError('La lecture a échoué.');
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
        if (!(error instanceof DOMException && error.name === 'AbortError')) onError(`Lecture impossible : ${describe(error)}`);
      });
    },
    [clip, onTime, onError],
  );

  const pause = useCallback(() => audioRef.current?.pause(), []);
  return { playing, toggle, pause };
}

export function Analyzer({ onSaveInstrument }: { onSaveInstrument: (instrument: Instrument) => void }) {
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
    if (listeningRef.current !== 'off') setLiveError('Connexion au serveur perdue : le micro est fermé.');
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
      setClipError(`${file.name} : ${describe(error)}`);
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
        setWaveFitError(`Mesure de la forme d’onde impossible : ${describe(error)}`);
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
  const makeInstrument = async (): Promise<{ instrument: Instrument; noteMidi: number | null; profile: string | null } | null> => {
    if (!analysis || !canCreate || creating) return null;
    const target = analyzedTarget;
    const described = describeAnalyzed(target, windowMs);
    const origin = source === 'micro' ? (onRecording ? 'l’enregistrement du micro' : 'le micro, en direct') : clip?.name ?? 'un fichier';
    const prefix = source === 'micro' ? (onRecording ? 'Enregistrement' : 'Micro') : clip?.name ?? 'Son';
    const harmonics = harmonicsOnly && target ? ', harmoniques seulement' : '';
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
        setCreateError(`Mesure des enveloppes impossible : ${describe(error)}`);
        return null;
      } finally {
        setCreating(false);
      }
      if (found.frequency <= 0 || partialsMade.length === 0) {
        setCreateError('La mesure des enveloppes n’a trouvé ni note ni partiel dans cette zone.');
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
            fitted.frequency > 0 && fitted.moments === 0
              ? 'Cette note n’est jamais entendue seule ici : choisis une note dans les puces, ou « Partiels mesurés ».'
              : 'Pas de forme d’onde mesurée ici : choisis « Partiels mesurés ».',
          );
          return null;
        }
      } catch (error) {
        setCreateError(`Mesure de la forme d’onde impossible : ${describe(error)}`);
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
    const envelopes = zoneTarget
      ? 'une enveloppe mesurée par partiel (exponentielle)'
      : 'une seule enveloppe (une zone d’une seule note donne celle de chaque partiel)';
    const made = shape
      ? `Forme ${describeShape(shape)} (écart ${shape.error_db.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} dB) : ${count} harmonique${
          count > 1 ? 's' : ''
        } en sinusoïdes, ${shape.cutoff > 0 ? 'son passe-bas dans le filtre' : 'sans passe-bas'}, ${
          zoneTarget ? 'l’enveloppe mesurée sur son partiel le plus fort pour toutes' : 'une seule enveloppe'
        }.`
      : `${count} partiel${count > 1 ? 's' : ''} mesuré${count > 1 ? 's' : ''}, sinusoïdes, ${envelopes}.`;
    const instrument = instrumentFromPartials(
      `${prefix}${noteName ? ` · ${noteName}` : ''}${shape ? ` · ${describeShape({ ...shape, cutoff: 0 })}` : ''}`,
      `Créé dans l’Analyzer depuis ${origin} : ${described}, rapports à ${noteName || 'la note'}${harmonics}. ${made}`,
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
      profile: shape ? describeShape(shape) : null,
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
      profile: result.profile,
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
        index="03"
        eyebrow="Analyse sonore"
        title="Analyzer"
        subtitle="La note jouée et les partiels d’un son, au micro ou depuis un fichier."
      >
        <Segmented
          label="Source du son"
          value={source}
          onChange={setSource}
          options={[
            { value: 'micro', label: 'Micro', icon: <Mic size={14} />, title: 'Analyse en direct de ce que le micro entend' },
            { value: 'file', label: 'Fichier', icon: <FileAudio size={14} />, title: 'Analyse d’un fichier WAV, FLAC ou MP3' },
          ]}
        />
      </ScreenHeader>

      <div className={styles.body}>
        <Panel className={styles.source}>
          {source === 'micro' ? (
            <>
              <Section
                title="Micro"
                badge={
                  listening === 'on' ? (
                    <Badge tone="live">À l’écoute</Badge>
                  ) : listening === 'starting' ? (
                    <Badge>Ouverture…</Badge>
                  ) : (
                    <Badge>Coupé</Badge>
                  )
                }
              >
                <div className={styles.micRow}>
                  <Field label="Entrée">
                    <select
                      className={selectClass}
                      value={inputDevice}
                      disabled={listening !== 'off'}
                      onChange={(event) => setInputDevice(Number(event.target.value))}
                    >
                      <option value={-1}>Entrée par défaut du système</option>
                      {captureDevices.map((device) => (
                        <option key={device.index} value={device.index}>
                          {device.name}
                          {device.is_default ? ' (défaut)' : ''}
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
                    {listening === 'off' ? 'Écouter' : 'Arrêter'}
                  </Button>
                </div>
                <p className={styles.note}>
                  {listening === 'on'
                    ? `À l’écoute à ${((inputRate ?? 0) / 1000).toFixed(1)} kHz. ${
                        recording === 'on' ? 'Enregistrement en cours.' : 'Rien n’est enregistré : seules la note et les partiels s’affichent.'
                      }`
                    : 'synthway-core ouvre le micro quand tu cliques sur Écouter ou Enregistrer, et le ferme quand tu arrêtes ou quittes l’onglet.'}
                </p>
                {listening === 'on' &&
                  (inputExclusive ? (
                    <p className={styles.note}>
                      Mode exclusif : le son arrive sans les effets audio de Windows (réduction de bruit, gain automatique).
                      Pendant l’écoute, les autres applications ne peuvent pas utiliser ce micro.
                    </p>
                  ) : (
                    <p className={styles.warning}>
                      Mode partagé : Windows a refusé le mode exclusif, ses effets audio s’appliquent. La réduction de bruit
                      peut étouffer une note tenue. Désactive les « Améliorations audio » du micro dans les Paramètres de
                      Windows (Système › Son).
                    </p>
                  ))}
                {!online && <p className={styles.note}>Le serveur n’est pas connecté (voir les Réglages).</p>}
                {liveError && <p className={styles.error}>{liveError}</p>}
              </Section>

              <Section
                title="Enregistrement"
                className={styles.recordSection}
                badge={
                  recording === 'on' ? (
                    <Badge tone="danger">● {(recordTimes?.duration ?? 0).toFixed(1)} s</Badge>
                  ) : recording === 'starting' ? (
                    <Badge>Ouverture…</Badge>
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
                          title={recordPlaying ? 'Met la lecture en pause (Espace)' : 'Lit l’enregistrement à partir du curseur, qui le suit (coupe l’écoute). Espace : lecture / pause'}
                        >
                          {recordPlaying ? <Pause size={13} /> : <Play size={13} />}
                          {recordPlaying ? 'Pause' : 'Lire'}
                        </Button>
                        <Button size="small" onClick={downloadRecording} title="Télécharge l’enregistrement en WAV (mono, 16 bits)">
                          <Download size={13} />
                          Télécharger .wav
                        </Button>
                      </>
                    )}
                    <Button
                      size="small"
                      variant={recording === 'off' ? 'primary' : 'default'}
                      disabled={!online || recording === 'starting'}
                      onClick={recording === 'off' ? startRecording : () => socketRef.current?.stopRecord()}
                      title={recording === 'off' ? 'Enregistre ce que le micro entend, sans limite de durée' : undefined}
                    >
                      {recording === 'off' ? <Circle size={13} /> : <Square size={13} />}
                      {recording === 'off' ? 'Enregistrer' : 'Arrêter l’enregistrement'}
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
                      label="Moment analysé dans l’enregistrement"
                    />
                  ) : (
                    <div className={styles.dropHint} data-recording={recording === 'on' ? 'true' : undefined}>
                      <Circle size={28} />
                      {recording === 'on' ? (
                        <span>Enregistrement… {(recordTimes?.duration ?? 0).toFixed(1)} s. Arrête quand tu veux.</span>
                      ) : (
                        <span>Clique sur « Enregistrer » : le micro s’ouvre et tout ce qu’il entend est gardé, sans limite de durée.</span>
                      )}
                      <span className={styles.note}>La forme d’onde de l’enregistrement s’affichera ici. Rien n’est joué.</span>
                    </div>
                  )}
                </div>
                {recordClip && recording === 'off' && (
                  <p className={styles.note}>
                    {(recordClip.sample_rate / 1000).toFixed(1)} kHz ·{' '}
                    {recordTime === null
                      ? 'clique sur l’enregistrement pour analyser un moment, glisse pour choisir une zone à lire en boucle, ou « Lire » : l’écoute s’arrête.'
                      : 'un clic choisit le moment analysé et le départ de « Lire » (flèches : ±10 ms), un glissé une zone à lire en boucle. « Écouter » reprend le direct et retire le curseur.'}
                  </p>
                )}
                {recordClip && recordSelection && <p className={styles.note}>{describeZone(recordSelection)}</p>}
                {recordTimes && recordTimes.lost > 0 && (
                  <p className={styles.warning}>
                    {recordTimes.lost.toFixed(2)} s perdues pendant l’enregistrement (le serveur n’a pas suivi), remplacées par du silence.
                  </p>
                )}
                {recordError && <p className={styles.error}>{recordError}</p>}
              </Section>
            </>
          ) : (
            <Section
              title="Fichier"
              badge={clip ? <Badge>{clip.name}</Badge> : undefined}
              actions={
                <>
                  {clip && (
                    <>
                      <Button
                        size="small"
                        disabled={!online}
                        onClick={() => toggleClipPlayback(clipTime)}
                        title={clipPlaying ? 'Met la lecture en pause (Espace)' : 'Lit le fichier à partir du curseur, qui le suit. Espace : lecture / pause'}
                      >
                        {clipPlaying ? <Pause size={13} /> : <Play size={13} />}
                        {clipPlaying ? 'Pause' : 'Lire'}
                      </Button>
                      <Button
                        size="small"
                        onClick={() => seekClip(clearestMoment(clip))}
                        title="Place le curseur sur le moment où la note est la plus nette"
                      >
                        <Crosshair size={13} />
                        Moment le plus net
                      </Button>
                    </>
                  )}
                  <Button size="small" variant="primary" disabled={!online || uploading} onClick={() => fileInput.current?.click()}>
                    <Upload size={13} />
                    {uploading ? 'Chargement…' : 'Importer un son'}
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
                    <span>Dépose un fichier WAV, FLAC ou MP3 ici, ou clique sur « Importer un son ».</span>
                    <span className={styles.note}>Une note tenue donne la lecture la plus nette. Rien n’est joué.</span>
                  </div>
                )}
              </div>
              {clip && (
                <p className={styles.note}>
                  {formatDuration(clip.duration)} · {(clip.sample_rate / 1000).toFixed(1)} kHz · les points roses suivent la
                  note le long du fichier. Un clic choisit le moment analysé et le départ de « Lire » (flèches : ±10 ms), un
                  glissé une zone à lire en boucle.
                </p>
              )}
              {clip && clipSelection && <p className={styles.note}>{describeZone(clipSelection)}</p>}
              {!online && <p className={styles.note}>Le serveur n’est pas connecté (voir les Réglages).</p>}
              {clipError && <p className={styles.error}>{clipError}</p>}
            </Section>
          )}
        </Panel>

        <Panel className={styles.tunerPanel}>
          <Section
            title="Note"
            actions={
              <label className={styles.a4} title="Fréquence de référence du La 4">
                La4 =
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
              <span className={styles.referenceLabel}>Note de référence</span>
              <Segmented
                compact
                label="Note de référence"
                value={referenceMidi === null ? 'auto' : 'fixed'}
                onChange={(mode) =>
                  mode === 'auto' ? setReferenceMidi(null) : setReference(shownNote?.midi ?? 43)
                }
                options={[
                  { value: 'auto', label: 'Auto', title: 'La note entendue (sur une zone, la plus basse de ses notes nettes)' },
                  { value: 'fixed', label: 'Fixée', title: 'Les rapports sont pris à la note choisie, dans son octave' },
                ]}
              />
              {referenceMidi !== null && (
                <span className={styles.referencePicker}>
                  <select
                    className={selectClass}
                    aria-label="Nom de la note de référence"
                    value={referencePitchClass}
                    onChange={(event) => setReference(referenceMidi - referencePitchClass + Number(event.target.value))}
                  >
                    {NOTE_NAMES.map((name, index) => (
                      <option key={name} value={index}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <Button size="small" iconOnly title="Une octave plus bas" onClick={() => setReference(referenceMidi - 12)}>
                    <Minus size={13} />
                  </Button>
                  <span className={styles.mono}>
                    {midiLabel(referenceMidi)} · {referenceHz.toFixed(1)} Hz
                  </span>
                  <Button size="small" iconOnly title="Une octave plus haut" onClick={() => setReference(referenceMidi + 12)}>
                    <Plus size={13} />
                  </Button>
                </span>
              )}
            </div>
            <p className={styles.note}>
              {referenceMidi === null
                ? 'Les rapports sont pris à la note entendue. Sur une zone, c’est la plus basse de ses notes nettes : une fondamentale qui s’éteint avant ses harmoniques ne la fait pas monter d’une octave. Fixe-la si tu connais la note jouée.'
                : `Les rapports sont pris à ${midiLabel(referenceMidi)}, accordée sur ce que l’Analyzer entend de cette note dans n’importe quelle octave. Les moments sur une autre note ne comptent pas. Ne vaut pas pour l’écoute en direct.`}
            </p>
          </Section>
        </Panel>

        <Panel className={styles.spectrumPanel}>
          <Section title="Spectre" badge={analysis ? <Badge>{(analysis.sample_rate / 1000).toFixed(1)} kHz</Badge> : undefined}>
            <div className={styles.spectrum}>
              <AnalysisSpectrum analysis={analysis} noiseGateDb={noiseGate > NOISE_GATE_OFF ? noiseGate : undefined} />
            </div>
            <div className={styles.gateRow}>
              <Slider
                label="Anti-bruit"
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
                        Désactiver
                      </Button>
                      <span>{NOISE_GATE_OFF} : désactivé</span>
                    </div>
                  ),
                }}
              />
              <p className={styles.note}>
                {noiseGate > NOISE_GATE_OFF
                  ? 'Les pics sous la ligne jaune sont ignorés : ce ne sont plus des partiels, et sans partiel au-dessus, pas de note.'
                  : 'Monte-le juste au-dessus du bruit de fond (ventilateur, souffle) pour que l’analyse l’ignore.'}
              </p>
            </div>
            <div className={styles.gateRow}>
              <Slider
                label="Fenêtre d’analyse"
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
                      <span>la fenêtre habituelle</span>
                    </div>
                  ),
                }}
              />
              <p className={styles.note}>
                {analyzedTarget === null
                  ? 'Pour le curseur et les zones. En direct, au micro, l’analyse garde sa fenêtre habituelle (environ 170 ms).'
                  : zoneMode
                    ? 'Avec une zone, l’analyse passe des fenêtres de cette durée sur toute la zone (jusqu’à 100, au moins 10 ms d’écart) et garde la médiane de chaque partiel.'
                    : 'Le curseur analyse cette durée autour de lui (les bornes vertes sur la forme d’onde). Plus courte : plus précise dans le temps ; plus longue : plus fine en fréquence, et meilleure pour les notes graves.'}
              </p>
              {windowTooShort && (
                <p className={styles.warning}>
                  {minWindowMs <= ANALYSIS_WINDOW_MAX_MS
                    ? `Pour ${shownNoteName} (${analysis?.frequency.toFixed(1)} Hz), il faut au moins ${minWindowMs} ms pour séparer ses harmoniques : à ${windowMs} ms, elles se mélangent.`
                    : `${shownNoteName} est trop grave pour séparer ses harmoniques, même à ${ANALYSIS_WINDOW_MAX_MS} ms.`}
                </p>
              )}
            </div>
          </Section>
        </Panel>

        <Panel className={styles.partialsPanel}>
          <Section
            title="Partiels"
            badge={<Badge>{partials.length}</Badge>}
            actions={
              <Button
                size="small"
                variant={draft && !draftStale ? 'default' : 'primary'}
                disabled={!canCreate || creating}
                onClick={() => void tryInstrument()}
                title={
                  !canCreate
                    ? 'Il faut une note et ses partiels : place le curseur ou choisis une zone sur un son'
                    : `${draft ? 'Refait l’instrument à l’essai' : 'Fait un instrument à l’essai'} avec ces partiels${
                        zoneMode ? ' et l’enveloppe de chacun, mesurée sur la zone' : ' (rapports et amplitudes)'
                      }, joué au clavier en bas. Rien n’est sauvegardé.`
                }
              >
                {draft ? <RefreshCw size={13} /> : <Sparkles size={13} />}
                {creating ? 'Mesure des enveloppes…' : draft ? 'Mettre à jour l’essai' : 'Essayer l’instrument'}
              </Button>
            }
          >
            <div className={styles.partialsHead}>
              <p className={styles.note}>
                {analysis
                  ? `Analyse de ${describeAnalyzed(analyzedTarget, windowMs)}${
                      analyzedTarget && shownNoteName ? `, rapports à ${shownNoteName}` : ''
                    }.`
                  : 'Place le curseur ou choisis une zone sur un son.'}
              </p>
              <Toggle
                label="Harmoniques seulement"
                hint={`À ${HARMONIC_CENTS} cents d’un rapport entier : écarte les autres instruments d’un mix (pas en direct)`}
                checked={harmonicsOnly}
                onChange={setHarmonicsOnly}
              />
            </div>
            {zoneNotes && zoneNotes.length > 0 && (
              <div className={styles.zoneNotes}>
                <p className={strongNotes.length > 1 && !notesZone ? styles.warning : styles.note}>
                  {notesZone
                    ? 'Une note seule, sur son temps dans la zone : les rapports sont pris à elle, les autres notes sont écartées (leurs harmoniques communes restent mêlées).'
                    : strongNotes.length > 1
                      ? `Plusieurs notes jouées ensemble ou à la suite : l’analyse de la zone les prend pour une seule${
                          shownNoteName ? `, ${shownNoteName}` : ''
                        }. Choisis-en une pour son timbre seul, ou garde la zone entière pour un instrument qui joue tout l’accord sur une seule touche.`
                      : 'Notes entendues dans la zone : un clic en analyse une seule.'}
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
                        title={`Analyser ${name} seule, de ${span.start.toFixed(2)} à ${span.end.toFixed(2)} s : rapports pris à ${name} (${span.frequency.toFixed(1)} Hz). Force ${Math.round(span.strength * 100)} % de la plus forte.`}
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
                    <Button size="small" onClick={backToNotesZone} title="Revient à la zone choisie et à la note de référence automatique">
                      Toute la zone
                    </Button>
                  )}
                </div>
              </div>
            )}
            {zoneOtherNotes > OTHER_NOTES_SHARE && (
              <p className={styles.warning}>
                La zone contient d’autres notes que {shownNoteName} ({Math.round(zoneOtherNotes * 100)} % du temps). Elles sont
                écartées, mais une zone sur une seule note, de son attaque à la suivante, donne le résultat le plus net.
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
                {zoneMode
                  ? 'L’instrument à l’essai reçoit aussi l’enveloppe de chaque partiel, mesurée sur la zone : qu’elle aille de l’attaque de la note à la suivante.'
                  : 'Avec une zone d’une seule note, de son attaque à la suivante, l’instrument à l’essai reçoit aussi l’enveloppe de chaque partiel.'}
              </p>
            )}
            {createError && !draft && <p className={styles.warning}>{createError}</p>}
            {partials.length === 0 ? (
              <p className={styles.note}>
                {analysis ? 'Aucun pic ne se détache du bruit.' : 'Les partiels du son analysé s’affichent ici, du plus grave au plus aigu.'}
              </p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Fréquence</th>
                      <th>Note</th>
                      <th>Rapport</th>
                      <th>Harmonique</th>
                      <th>Amplitude</th>
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
                            {!gap ? 'sous la note' : harmonic ? `n°${gap.harmonic} ${formatCents(gap.cents)} c` : 'inharmonique'}
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
              <span className={styles.trialEyebrow}>Instrument à l’essai</span>
              <span className={styles.trialName} title={draft.instrument.description}>
                {draft.instrument.name}
              </span>
            </span>
            <span className={styles.note}>
              {draft.instrument.partials.length} partiel{draft.instrument.partials.length > 1 ? 's' : ''}
              {draft.noteMidi !== null ? ` · rapports à ${midiLabel(draft.noteMidi)}` : ''}
              {draft.profile
                ? ` · ${draft.profile}`
                : draft.target && 'start' in draft.target
                  ? ' · une enveloppe mesurée par partiel'
                  : ' · une seule enveloppe'}
            </span>
            {createError ? (
              <span className={styles.warning}>{createError}</span>
            ) : draftStale ? (
              <span className={styles.warning}>
                La sélection ou les réglages ont changé depuis : l’instrument reste tel quel, « Mettre à jour » le refait avec eux.
              </span>
            ) : draft.target === null ? (
              <span className={styles.note}>
                Fait sur ce que le micro entendait au clic : « Mettre à jour » reprend ce qu’il entend.
              </span>
            ) : (
              <span className={styles.note}>
                {draft.noteMidi !== null ? `Joue ${midiLabel(draft.noteMidi)} (le point vert) et` : 'Joue-le et'} compare avec
                l’original. Rien n’est gardé avant « Sauvegarder ».
              </span>
            )}
          </div>
          <div className={styles.trialVolume}>
            <Slider
              label="Volume"
              value={draft.instrument.volume}
              min={0}
              max={1}
              step={0.01}
              format={(volume) => `${Math.round(volume * 100)} %`}
              onChange={setDraftVolume}
            />
          </div>
          <div className={styles.trialActions}>
            {draftSelectionBack && (
              <Button
                size="small"
                onClick={backToDraftSelection}
                title="Remet la zone (ou le moment) et la note de référence d’où vient l’instrument à l’essai"
              >
                <Undo2 size={13} />
                Revenir à sa sélection
              </Button>
            )}
            <Button
              size="small"
              variant={draftStale ? 'primary' : 'default'}
              disabled={!canCreate || creating}
              onClick={() => void tryInstrument()}
              title={
                canCreate
                  ? 'Refait l’instrument à l’essai depuis la sélection et les réglages affichés'
                  : 'Il faut une note et ses partiels : place le curseur ou choisis une zone sur un son'
              }
            >
              <RefreshCw size={13} />
              {creating ? 'Mesure…' : 'Mettre à jour'}
            </Button>
            <Button
              size="small"
              disabled={!online || !originalZone}
              onClick={playOriginal}
              title={
                originalZone
                  ? 'Lit en boucle la zone sélectionnée, pour comparer'
                  : 'Choisis une zone sur le son pour la réécouter en boucle'
              }
            >
              {originalPlaying ? <Pause size={13} /> : <Play size={13} />}
              {originalPlaying ? 'Pause' : 'Lire l’original'}
            </Button>
            <Button size="small" onClick={() => setDraft(null)} title="Ferme l’essai sans rien garder">
              <X size={13} />
              Abandonner
            </Button>
            <Button
              size="small"
              variant="primary"
              onClick={saveDraft}
              title="Ajoute l’instrument à la bibliothèque et l’ouvre dans l’Instrument Creator"
            >
              <Save size={13} />
              Sauvegarder
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
            draft.noteMidi !== null
              ? `${midiLabel(draft.noteMidi)} : la note analysée, qui doit sonner comme l’original`
              : undefined
          }
        />
      )}
    </div>
  );
}
