import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_MAX_PARTIALS,
  type AutomationRamp,
  type DeviceListResponse,
  type EngineStatus,
  type InstrumentParams,
  type NoteGlide,
  type ToneParams,
  type Waveform,
} from '../types';
import { t } from '../i18n';
import { api, SERVER_PORT, SynthSocket } from './api';
import { usePersistentState } from './storage';

/**
 * - connecting: first check not done yet
 * - online: synthway-server answers /health
 * - offline: nothing answers
 * - foreign: something else answers on the server port
 */
export type Connection = 'connecting' | 'online' | 'offline' | 'foreign';

export interface EngineState {
  running: boolean;
  enabled: boolean;
  frequency: number;
  volume: number;
  waveform: Waveform;
  /** Most partials a timbre can hold (synthway-core limit) */
  maxPartials: number;
  /** Sample rate of the running engine, null without one */
  sampleRate: number | null;
}

export interface AudioConfig {
  deviceIndex: number; // -1: system default
  sampleRate: number;
}

interface SynthServerValue {
  connection: Connection;
  coreLoaded: boolean;
  coreVersion: string | null;
  socketOpen: boolean;
  devices: DeviceListResponse | null;
  engine: EngineState;
  audioConfig: AudioConfig;
  busy: boolean;
  error: string | null;
  /** Notes can be sent: server online, core loaded, audio started, socket open */
  canPlay: boolean;
  setAudioConfig: (config: AudioConfig) => void;
  refresh: () => void;
  startAudio: (initial?: ToneParams) => Promise<boolean>;
  stopAudio: () => Promise<void>;
  /** The single note, on instrument 0 (set by setParams) */
  noteOn: (frequency: number, volume: number) => void;
  noteOff: () => void;
  setParams: (params: ToneParams) => void;
  /** Polyphony: a note alongside the others, named by id, on an instrument slot (0 to MAX_INSTRUMENTS - 1),
      with the glides it plays from its start */
  startNote: (id: number, instrument: number, frequency: number, volume: number, glides?: NoteGlide[]) => void;
  releaseNote: (id: number) => void;
  releaseAllNotes: () => void;
  setInstrument: (slot: number, params: InstrumentParams) => void;
  /** Automation: ramps of instrument slots' settings (synthway_engine_automate), in order */
  automate: (ramps: AutomationRamp[]) => void;
  /** Gives a slot's settings back to its instrument; no slot: every slot's */
  clearAutomation: (slot?: number) => void;
}

const POLL_MS = 4000;

const IDLE_ENGINE: EngineState = {
  running: false,
  enabled: false,
  frequency: 440,
  volume: 0.25,
  waveform: 0,
  maxPartials: DEFAULT_MAX_PARTIALS,
  sampleRate: null,
};

function fromStatus(status: EngineStatus): EngineState {
  return {
    running: status.is_running,
    enabled: status.is_tone_enabled,
    frequency: status.frequency,
    volume: status.volume,
    waveform: status.waveform,
    maxPartials: status.max_partials ?? DEFAULT_MAX_PARTIALS,
    sampleRate: status.sample_rate ?? null,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SynthServerContext = createContext<SynthServerValue | null>(null);

export function SynthServerProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection>('connecting');
  const [coreLoaded, setCoreLoaded] = useState(false);
  const [coreVersion, setCoreVersion] = useState<string | null>(null);
  const [socketOpen, setSocketOpen] = useState(false);
  const [devices, setDevices] = useState<DeviceListResponse | null>(null);
  const [engine, setEngine] = useState<EngineState>(IDLE_ENGINE);
  const [audioConfig, setAudioConfig] = usePersistentState<AudioConfig>('synthway.audio.v1', () => ({
    deviceIndex: -1,
    sampleRate: 48000,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<SynthSocket | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const health = await api.health();
      if (typeof health.core_loaded !== 'boolean') {
        setConnection('foreign');
        return;
      }
      setCoreLoaded(health.core_loaded);
      setCoreVersion(health.core_version ?? null);
      setConnection('online');
    } catch {
      // A service that does not let this page read it still answers
      setConnection((await api.portAnswers()) ? 'foreign' : 'offline');
    }
  }, []);

  const loadServerState = useCallback(async () => {
    try {
      const [deviceList, status] = await Promise.all([api.devices(), api.engineStatus()]);
      setDevices(deviceList);
      setEngine(fromStatus(status));
    } catch (e) {
      setError(t('server.stateFailed', { reason: describe(e) }));
    }
  }, []);

  useEffect(() => {
    void checkHealth();
    const timer = window.setInterval(() => void checkHealth(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [checkHealth]);

  // Online with a loaded core: fetch devices and engine state, open the socket
  useEffect(() => {
    if (connection !== 'online' || !coreLoaded) {
      setDevices(null);
      setEngine(IDLE_ENGINE);
      return undefined;
    }
    void loadServerState();
    const socket = new SynthSocket({
      onState: (state) =>
        setEngine((current) => ({
          ...current,
          running: state.running,
          enabled: state.enabled,
          frequency: state.frequency,
          volume: state.volume,
          waveform: state.waveform,
        })),
      onOpenChange: setSocketOpen,
    });
    socket.connect();
    socketRef.current = socket;
    return () => {
      socket.close();
      socketRef.current = null;
      setSocketOpen(false);
    };
  }, [connection, coreLoaded, loadServerState]);

  const refresh = useCallback(() => {
    setError(null);
    void checkHealth().then(() => loadServerState());
  }, [checkHealth, loadServerState]);

  const startAudio = useCallback(
    async (initial: ToneParams = {}) => {
      setBusy(true);
      setError(null);
      try {
        const { envelope, timbre, ...tone } = initial;
        // The server keeps the envelope and the timbre, and applies them to the new engine
        if (envelope) await api.setEnvelope(envelope);
        if (timbre) await api.setTimbre(timbre);
        else if (timbre === null) await api.clearTimbre();
        await api.startEngine({
          device_index: audioConfig.deviceIndex,
          sample_rate: audioConfig.sampleRate,
          channels: 2,
        });
        // Apply the instrument's sound. The server starts the engine muted;
        // `enabled: false` keeps it so until the first note_on.
        await api.setTone({ ...tone, enabled: false });
        setEngine(fromStatus(await api.engineStatus()));
        return true;
      } catch (e) {
        setError(t('server.startFailed', { reason: describe(e) }));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [audioConfig],
  );

  const stopAudio = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.stopEngine();
      setEngine((current) => ({ ...current, running: false, enabled: false, sampleRate: null }));
    } catch (e) {
      setError(t('server.stopFailed', { reason: describe(e) }));
    } finally {
      setBusy(false);
    }
  }, []);

  const noteOn = useCallback((frequency: number, volume: number) => {
    socketRef.current?.noteOn(frequency, volume);
  }, []);

  const noteOff = useCallback(() => {
    socketRef.current?.noteOff();
  }, []);

  const setParams = useCallback((params: ToneParams) => {
    socketRef.current?.setParams(params);
  }, []);

  const startNote = useCallback((id: number, instrument: number, frequency: number, volume: number, glides?: NoteGlide[]) => {
    socketRef.current?.startNote(id, instrument, frequency, volume, glides);
  }, []);

  const releaseNote = useCallback((id: number) => {
    socketRef.current?.releaseNote(id);
  }, []);

  const releaseAllNotes = useCallback(() => {
    socketRef.current?.releaseAllNotes();
  }, []);

  const setInstrument = useCallback((slot: number, params: InstrumentParams) => {
    socketRef.current?.setInstrument(slot, params);
  }, []);

  const automate = useCallback((ramps: AutomationRamp[]) => {
    socketRef.current?.automate(ramps);
  }, []);

  const clearAutomation = useCallback((slot?: number) => {
    socketRef.current?.clearAutomation(slot);
  }, []);

  const canPlay = connection === 'online' && coreLoaded && socketOpen && engine.running;

  const value = useMemo<SynthServerValue>(
    () => ({
      connection,
      coreLoaded,
      coreVersion,
      socketOpen,
      devices,
      engine,
      audioConfig,
      busy,
      error,
      canPlay,
      setAudioConfig,
      refresh,
      startAudio,
      stopAudio,
      noteOn,
      noteOff,
      setParams,
      startNote,
      releaseNote,
      releaseAllNotes,
      setInstrument,
      automate,
      clearAutomation,
    }),
    [
      connection,
      coreLoaded,
      coreVersion,
      socketOpen,
      devices,
      engine,
      audioConfig,
      busy,
      error,
      canPlay,
      setAudioConfig,
      refresh,
      startAudio,
      stopAudio,
      noteOn,
      noteOff,
      setParams,
      startNote,
      releaseNote,
      releaseAllNotes,
      setInstrument,
      automate,
      clearAutomation,
    ],
  );

  return <SynthServerContext.Provider value={value}>{children}</SynthServerContext.Provider>;
}

export function useSynthServer(): SynthServerValue {
  const value = useContext(SynthServerContext);
  if (!value) {
    throw new Error('useSynthServer must be used inside <SynthServerProvider>');
  }
  return value;
}

/** Short explanation, in the current language, of why notes cannot be played, or null if they can */
export function playBlocker(server: SynthServerValue): string | null {
  if (server.connection === 'connecting') return t('server.blocker.connecting');
  if (server.connection === 'offline') return t('server.blocker.offline');
  if (server.connection === 'foreign') return t('server.blocker.foreign', { port: SERVER_PORT });
  if (!server.coreLoaded) return t('server.blocker.noCore');
  if (!server.engine.running) return t('server.blocker.audioOff');
  if (!server.socketOpen) return t('server.blocker.socket');
  return null;
}
