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
import { DEFAULT_MAX_PARTIALS, type DeviceListResponse, type EngineStatus, type ToneParams, type Waveform } from '../types';
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
  noteOn: (frequency: number, volume: number) => void;
  noteOff: () => void;
  setParams: (params: ToneParams) => void;
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
      setError(`Lecture de l'état du serveur impossible : ${describe(e)}`);
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
        setError(`Impossible de démarrer l'audio : ${describe(e)}`);
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
      setError(`Impossible d'arrêter l'audio : ${describe(e)}`);
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

/** Short French explanation of why notes cannot be played, or null if they can */
export function playBlocker(server: SynthServerValue): string | null {
  if (server.connection === 'connecting') return 'Connexion au serveur…';
  if (server.connection === 'offline') return 'Serveur Synthway hors ligne';
  if (server.connection === 'foreign') return `Un autre service occupe le port ${SERVER_PORT}`;
  if (!server.coreLoaded) return 'Le serveur n’a pas chargé synthway-core';
  if (!server.engine.running) return 'Active l’audio pour jouer';
  if (!server.socketOpen) return 'Connexion temps réel…';
  return null;
}
