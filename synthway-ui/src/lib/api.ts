import type {
  Analysis,
  AnalyzerMessage,
  AutomationRamp,
  ClipInfo,
  ClipWaveformPart,
  DeviceListResponse,
  EngineStatus,
  EnvelopeAnalysis,
  EnvelopeParams,
  HealthResponse,
  InstrumentParams,
  NoteGlide,
  NoteSpan,
  ScoreRenderInfo,
  ScoreRenderRequest,
  SeparationModel,
  SeparationStatus,
  SynthStateMessage,
  TimbreParams,
  ToneParams,
  WaveformFit,
} from '../types';
import { t } from '../i18n';

// The browser calls synthway-server directly, at the address given to Vite
// (see vite.config.ts): the server accepts pages served by this machine (its
// CORS rule). The dev server only serves the page, so no request goes through
// WSL when the server runs on Windows. No address (a build, by default): the
// page is served by synthway-server itself, and calls its own origin.
const serverAddress = new URL(__SYNTHWAY_SERVER_URL__ || window.location.origin);
export const SERVER_PORT = serverAddress.port || (serverAddress.protocol === 'https:' ? '443' : '80');

/** SYNTHWAY_ANALYZER_NOISE_GATE_OFF: the analyzer's noise gate ignores nothing */
export const NOISE_GATE_OFF = -120;
export const SERVER_HOST = `${serverAddress.hostname}:${SERVER_PORT}`;

/** Full address of a server path, e.g. '/health' */
function serverUrl(path: string): string {
  return `${serverAddress.origin}${path}`;
}

/** Full address of a server WebSocket, e.g. '/ws/synth' */
function socketUrl(path: string): string {
  return `${serverAddress.origin.replace(/^http/, 'ws')}${path}`;
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 4000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(serverUrl(path), {
      ...init,
      signal: controller.signal,
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    if (!res.ok) {
      throw new Error(t('server.httpError', { method: init.method ?? 'GET', path, status: res.status }));
    }
    return (await res.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

/** What an analysis looks at: a moment, or a zone (start < end), in seconds */
export type AnalysisTarget = { time: number } | { start: number; end: number };

/** Analysis window: from ANALYSIS_WINDOW_MIN_MS to ANALYSIS_WINDOW_MAX_MS; the core takes 10 to 500 */
export const ANALYSIS_WINDOW_MIN_MS = 20;
export const ANALYSIS_WINDOW_MAX_MS = 320;
/** About the core's usual window (8192 samples at 48 kHz) */
export const ANALYSIS_WINDOW_DEFAULT_MS = 170;

/** Zones are analyzed at up to 100 moments: slower than one window */
const ZONE_TIMEOUT_MS = 20000;

/** Tolerance of « harmoniques seulement », as the « Harmonique » column of the partials */
export const HARMONIC_CENTS = 30;

/** How a moment or a zone is analyzed (see synthway_analyzer_analyze_clip_range) */
export interface AnalysisOptions {
  /** Peaks below it (dBFS) are ignored as ambient noise; NOISE_GATE_OFF: none */
  noiseGateDb: number;
  windowMs: number;
  /** The note the ratios are taken to, 0: the note heard */
  referenceHz: number;
  /** Only partials this close to a whole ratio, 0: every partial */
  harmonicCents: number;
}

function analysisPath(base: string, target: AnalysisTarget, options: AnalysisOptions): string {
  const where =
    'time' in target ? `time=${target.time.toFixed(4)}` : `start=${target.start.toFixed(4)}&end=${target.end.toFixed(4)}`;
  return (
    `${base}?${where}&window_ms=${Math.round(options.windowMs)}&noise_gate_db=${options.noiseGateDb}` +
    `&reference_hz=${options.referenceHz.toFixed(3)}&harmonic_cents=${options.harmonicCents}`
  );
}

function notesPath(base: string, zone: { start: number; end: number }, options: AnalysisOptions): string {
  return `${base}?start=${zone.start.toFixed(4)}&end=${zone.end.toFixed(4)}&window_ms=${Math.round(options.windowMs)}&noise_gate_db=${options.noiseGateDb}`;
}

function waveformFitPath(base: string, zone: { start: number; end: number }, options: AnalysisOptions): string {
  return `${notesPath(base, zone, options)}&reference_hz=${options.referenceHz.toFixed(3)}`;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const api = {
  health: () => request<Partial<HealthResponse>>('/health', {}, 2500),
  /**
   * Whether anything answers on the server port, even without allowing this
   * page to read it (no CORS header): tells a foreign service from no server
   */
  portAnswers: async () => {
    try {
      await fetch(serverUrl('/health'), { mode: 'no-cors', signal: AbortSignal.timeout(2500) });
      return true;
    } catch {
      return false;
    }
  },
  devices: () => request<DeviceListResponse>('/api/devices', {}, 10000),
  engineStatus: () => request<EngineStatus>('/api/engine/status'),
  startEngine: (config: { device_index: number; sample_rate: number; channels: number }) =>
    post<{ running: boolean }>('/api/engine/start', config),
  stopEngine: () => post<{ running: boolean }>('/api/engine/stop'),
  setTone: (params: Omit<ToneParams, 'envelope' | 'timbre'>) => post<unknown>('/api/synth/tone', params),
  setEnvelope: (envelope: EnvelopeParams) => post<EnvelopeParams>('/api/synth/envelope', envelope),
  setTimbre: (timbre: TimbreParams) => post<TimbreParams>('/api/synth/timbre', timbre),
  clearTimbre: () => request<{ timbre: null }>('/api/synth/timbre', { method: 'DELETE' }),
  /** The file loaded last into the analyzer, null when none */
  clip: async () => {
    try {
      return await request<ClipInfo | null>('/api/analyzer/clip', {}, 30000);
    } catch {
      return null;
    }
  },
  /** A moment of the loaded file through a window, or the median over a zone */
  analyzeClip: (target: AnalysisTarget, options: AnalysisOptions) =>
    request<Analysis>(analysisPath('/api/analyzer/clip/analysis', target, options), {}, ZONE_TIMEOUT_MS),
  /** The partials of one note of the loaded file and the envelope of each: the zone goes from its attack to the next note */
  clipEnvelopes: (zone: { start: number; end: number }, options: AnalysisOptions) =>
    request<EnvelopeAnalysis>(analysisPath('/api/analyzer/clip/envelopes', zone, options), {}, ZONE_TIMEOUT_MS),
  /** The notes heard in a zone of the loaded file, even several at once, and when each starts and ends */
  clipNotes: (zone: { start: number; end: number }, options: AnalysisOptions) =>
    request<NoteSpan[]>(notesPath('/api/analyzer/clip/notes', zone, options), {}, ZONE_TIMEOUT_MS),
  /** The waveform of frames frames of the loaded file from first, in count parts (never more than frames) */
  clipWaveform: (first: number, frames: number, count: number) =>
    request<ClipWaveformPart>(`/api/analyzer/clip/waveform?first=${first}&frames=${frames}&count=${count}`),
  uploadClip,
  /** The microphone's last recording, shown like a file; null when none or while recording */
  recording: async () => {
    try {
      return await request<ClipInfo | null>('/api/analyzer/recording', {}, 30000);
    } catch {
      return null;
    }
  },
  /** Like analyzeClip, for the last recording */
  analyzeRecording: (target: AnalysisTarget, options: AnalysisOptions) =>
    request<Analysis>(analysisPath('/api/analyzer/recording/analysis', target, options), {}, ZONE_TIMEOUT_MS),
  /** Like clipEnvelopes, for the last recording */
  recordingEnvelopes: (zone: { start: number; end: number }, options: AnalysisOptions) =>
    request<EnvelopeAnalysis>(analysisPath('/api/analyzer/recording/envelopes', zone, options), {}, ZONE_TIMEOUT_MS),
  /** Which waveform the note of a zone of the loaded file is closest to (options.referenceHz: that note; 0, the zone's) */
  clipWaveformFit: (zone: { start: number; end: number }, options: AnalysisOptions) =>
    request<WaveformFit>(waveformFitPath('/api/analyzer/clip/waveform-fit', zone, options), {}, ZONE_TIMEOUT_MS),
  /** Like clipWaveformFit, for the last recording */
  recordingWaveformFit: (zone: { start: number; end: number }, options: AnalysisOptions) =>
    request<WaveformFit>(waveformFitPath('/api/analyzer/recording/waveform-fit', zone, options), {}, ZONE_TIMEOUT_MS),
  /** Like clipNotes, for the last recording */
  recordingNotes: (zone: { start: number; end: number }, options: AnalysisOptions) =>
    request<NoteSpan[]>(notesPath('/api/analyzer/recording/notes', zone, options), {}, ZONE_TIMEOUT_MS),
  recordingWaveform: (first: number, frames: number, count: number) =>
    request<ClipWaveformPart>(`/api/analyzer/recording/waveform?first=${first}&frames=${frames}&count=${count}`),
  /** Decomposer: whether Demucs is ready, the piece loaded, the separation and its stems */
  separation: () => request<SeparationStatus>('/api/separation'),
  /** The piece to decompose, in place of the previous one and its stems */
  uploadSeparationSource: (file: File) => uploadAudio<SeparationStatus>('/api/separation/source', file),
  /** Clears the piece and its stems: the Decomposer becomes empty */
  clearSeparationSource: () => request<SeparationStatus>('/api/separation/source', { method: 'DELETE' }),
  /** Starts decomposing the piece, in the background: separation() follows it */
  runSeparation: (model: SeparationModel) => postExplained<SeparationStatus>('/api/separation/run', { model }),
  cancelSeparation: () => postExplained<SeparationStatus>('/api/separation/cancel'),
  /** Loads a stem into the Analyzer, in place of its file */
  stemToAnalyzer: (name: string) =>
    postExplained<ClipInfo>(`/api/separation/stems/${encodeURIComponent(name)}/analyzer`, undefined, 30000),
  /** Renders a score into an audio file, offline (nothing is played): the file, and what it is made of */
  renderScore: async (score: ScoreRenderRequest): Promise<{ file: Blob; info: ScoreRenderInfo }> => {
    const res = await fetch(serverUrl('/api/render/score'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(score),
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
    });
    if (!res.ok) throw await refusal(res);
    const info = JSON.parse(res.headers.get('X-Synthway-Render') ?? 'null') as ScoreRenderInfo | null;
    if (!info) throw new Error(t('server.renderInfoMissing'));
    return { file: await res.blob(), info };
  },
};

/** Longest a score render may take: the server renders much faster than real time, even an hour */
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;

/** The piece loaded into the Decomposer, as it was sent */
export const SEPARATION_SOURCE_URL = serverUrl('/api/separation/source');

/** A stem of the last separation as a WAV file: played, or downloaded */
export function separationStemUrl(name: string, download = false): string {
  return serverUrl(`/api/separation/stems/${encodeURIComponent(name)}.wav${download ? '?download=true' : ''}`);
}

/** The last recording as a WAV file, written by the core */
export const RECORDING_WAV_URL = serverUrl('/api/analyzer/recording.wav');
/** Decoded WAV for the loaded Analyzer file; the browser handles playback. */
export const ANALYZER_CLIP_WAV_URL = serverUrl('/api/analyzer/clip.wav');

/**
 * Sends an audio file to the analyzer, whole (the core decodes it). The error
 * message is the server's when it gives one (format, size).
 */
function uploadClip(file: File): Promise<ClipInfo> {
  return uploadAudio<ClipInfo>('/api/analyzer/clip', file);
}

/** Sends an audio file whole, as the raw body; the error message is the server's when it gives one */
async function uploadAudio<T>(path: string, file: File): Promise<T> {
  const res = await fetch(serverUrl(`${path}?name=${encodeURIComponent(file.name)}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as T;
}

/** A POST whose refusal says why: the server's message when it gives one (busy, Demucs missing...) */
async function postExplained<T>(path: string, body?: unknown, timeoutMs = 15000): Promise<T> {
  const res = await fetch(serverUrl(path), {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as T;
}

/** The server's message for a refused request (its detail, in French: not translated), or else its HTTP status */
async function refusal(res: Response): Promise<Error> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') detail = body.detail;
  } catch {
    // No JSON body: keep the status
  }
  return new Error(detail);
}

/**
 * Live analysis of the microphone, through /ws/analyzer: the server opens the
 * microphone on start() and closes it on stop() or when the socket closes.
 * record() and stopRecord() record it meanwhile, in the core.
 * No reconnection: a lost connection stops listening, on purpose.
 */
export class AnalyzerSocket {
  private ws: WebSocket | null = null;
  /** Messages waiting for the socket to open, in order */
  private pending: object[] = [];
  private readonly onMessage: (message: AnalyzerMessage) => void;
  private readonly onClose: () => void;

  constructor(onMessage: (message: AnalyzerMessage) => void, onClose: () => void) {
    this.onMessage = onMessage;
    this.onClose = onClose;
  }

  start(deviceIndex: number, noiseGateDb: number = NOISE_GATE_OFF): void {
    this.send({ type: 'start', device_index: deviceIndex, sample_rate: 0, noise_gate_db: noiseGateDb });
  }

  /** Changes the noise gate while listening; without an open socket, start() will carry it */
  setNoiseGate(noiseGateDb: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'set', noise_gate_db: noiseGateDb }));
    }
  }

  /** Records the open microphone from now on, with no time limit; send it after start() */
  record(): void {
    this.send({ type: 'record' });
  }

  /** Ends the recording: a 'recorded' message follows, the microphone keeps listening */
  stopRecord(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'stop_record' }));
  }

  stop(): void {
    // Without an open socket, nothing listens: a start still waiting is dropped
    this.pending = [];
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'stop' }));
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.pending = [];
    ws?.close();
  }

  private send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return;
    }
    // Opens the socket on first use; the messages leave once it is open
    this.pending.push(payload);
    if (this.ws) return;
    const ws = new WebSocket(socketUrl('/ws/analyzer'));
    this.ws = ws;
    ws.onopen = () => {
      for (const message of this.pending) ws.send(JSON.stringify(message));
      this.pending = [];
    };
    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as AnalyzerMessage;
        if (data && typeof data === 'object' && 'type' in data) this.onMessage(data);
      } catch {
        // Ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
        this.onClose();
      }
    };
  }
}

interface SocketListener {
  onState: (state: SynthStateMessage) => void;
  onOpenChange: (open: boolean) => void;
}

/** Real-time channel to /ws/synth, reconnecting automatically. */
export class SynthSocket {
  private ws: WebSocket | null = null;
  private retryTimer: number | undefined;
  private retryDelay = 500;
  private closed = false;
  private readonly listener: SocketListener;

  constructor(listener: SocketListener) {
    this.listener = listener;
  }

  connect(): void {
    this.closed = false;
    const ws = new WebSocket(socketUrl('/ws/synth'));
    this.ws = ws;

    ws.onopen = () => {
      this.retryDelay = 500;
      this.listener.onOpenChange(true);
    };
    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const data: unknown = JSON.parse(event.data);
        if (data && typeof data === 'object' && 'running' in data) {
          this.listener.onState(data as SynthStateMessage);
        }
      } catch {
        // Ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
      }
      this.listener.onOpenChange(false);
      if (!this.closed) {
        this.scheduleReconnect();
      }
    };
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
  }

  noteOn(frequency: number, volume: number): void {
    this.send({ type: 'note_on', frequency, volume });
  }

  noteOff(): void {
    this.send({ type: 'note_off' });
  }

  setParams(params: ToneParams): void {
    this.send({ type: 'set_param', ...params });
  }

  /** One more note alongside the others, with its own attack; the same id strikes that note again.
      Its glides, chained, leave with it. */
  startNote(id: number, instrument: number, frequency: number, volume: number, glides: NoteGlide[] = []): void {
    this.send({ type: 'note_on', id, instrument, frequency, volume, ...(glides.length ? { glides } : {}) });
  }

  releaseNote(id: number): void {
    this.send({ type: 'note_off', id });
  }

  /** Releases every note started by startNote */
  releaseAllNotes(): void {
    this.send({ type: 'all_notes_off' });
  }

  setInstrument(slot: number, params: InstrumentParams): void {
    this.send({ type: 'set_instrument', slot, ...params });
  }

  /** Ramps of instrument slots' settings, in order (ignored by the server while the engine is stopped) */
  automate(ramps: AutomationRamp[]): void {
    if (ramps.length) this.send({ type: 'automate', ramps });
  }

  /** Gives a slot's settings back to its instrument; no slot: every slot's */
  clearAutomation(slot?: number): void {
    this.send(slot === undefined ? { type: 'clear_automation' } : { type: 'clear_automation', slot });
  }

  private send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect(): void {
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 8000);
  }
}
