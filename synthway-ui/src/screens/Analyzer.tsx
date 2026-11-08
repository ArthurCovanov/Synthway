import { Crosshair, FileAudio, Mic, MicOff, Pause, Play, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { AnalysisSpectrum, partialColor } from '../components/AnalysisSpectrum';
import { ClipWaveform } from '../components/ClipWaveform';
import layout from '../components/layout.module.css';
import { ScreenHeader } from '../components/ScreenHeader';
import { Badge, Button, Field, Panel, Section, Segmented, Slider, SoonBadge, inputClass, selectClass } from '../components/ui';
import { Tuner } from '../components/Tuner';
import { AnalyzerSocket, api, NOISE_GATE_OFF } from '../lib/api';
import { formatCents, frequencyToNote, harmonicGap } from '../lib/music';
import { usePersistentState } from '../lib/storage';
import { useSynthServer } from '../lib/SynthServer';
import type { Analysis, AnalyzerMessage, ClipInfo } from '../types';
import styles from './Analyzer.module.css';

/*
 * Analyzer, first step: shows, never records nor plays.
 *   - Micro: synthway-core listens to a capture device and analyzes what it
 *     hears; the server sends the results 20 times a second (/ws/analyzer).
 *   - Fichier: a WAV, FLAC or MP3 file is sent whole to the core, which decodes
 *     it; the note is followed along it, and a cursor picks the moment analyzed.
 *     « Parcourir » moves the cursor at real speed, without sound.
 * Next steps: hear the file through the core, follow each partial over time
 * (its envelope), and build an Instrument Creator card from the partials.
 */

type Source = 'micro' | 'file';
type Listening = 'off' | 'starting' | 'on';

const ACCEPTED_FILES = '.wav,.flac,.mp3,audio/wav,audio/x-wav,audio/flac,audio/mpeg';
/** A partial counts as a harmonic within this many cents of a whole ratio */
const HARMONIC_CENTS = 30;
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

export function Analyzer() {
  const server = useSynthServer();
  const online = server.connection === 'online' && server.coreLoaded;
  const [source, setSource] = usePersistentState<Source>('synthway.analyzer.source.v1', () => 'micro');
  const [a4, setA4] = usePersistentState<number>('synthway.analyzer.a4.v1', () => 440);
  const [inputDevice, setInputDevice] = usePersistentState<number>('synthway.analyzer.input.v1', () => -1);
  /** In dBFS; NOISE_GATE_OFF: off, the default */
  const [noiseGate, setNoiseGate] = usePersistentState<number>('synthway.analyzer.noise-gate.v1', () => NOISE_GATE_OFF);
  const noiseGateRef = useRef(noiseGate);
  noiseGateRef.current = noiseGate;

  /* ---------- Microphone ---------- */

  const [listening, setListening] = useState<Listening>('off');
  const [inputRate, setInputRate] = useState<number | null>(null);
  const [inputExclusive, setInputExclusive] = useState(false);
  const [liveAnalysis, setLiveAnalysis] = useState<Analysis | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const socketRef = useRef<AnalyzerSocket | null>(null);
  const listeningRef = useRef<Listening>('off');
  listeningRef.current = listening;

  const onSocketMessage = useCallback((message: AnalyzerMessage) => {
    if (message.type === 'started') {
      setListening('on');
      setInputRate(message.sample_rate);
      setInputExclusive(message.exclusive === true);
      setLiveError(null);
    } else if (message.type === 'analysis') {
      if (listeningRef.current !== 'off') setLiveAnalysis(message.analysis);
    } else if (message.type === 'stopped') {
      setListening('off');
    } else if (message.type === 'error') {
      setLiveError(message.error);
      if (listeningRef.current === 'starting') setListening('off');
    }
  }, []);

  const onSocketClose = useCallback(() => {
    if (listeningRef.current !== 'off') setLiveError('Connexion au serveur perdue : le micro est fermé.');
    setListening('off');
  }, []);

  const startListening = () => {
    socketRef.current ??= new AnalyzerSocket(onSocketMessage, onSocketClose);
    setLiveError(null);
    setLiveAnalysis(null);
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
  }, [source, online, stopListening]);

  /* ---------- File ---------- */

  const [clip, setClip] = useState<ClipInfo | null>(null);
  const [clipTime, setClipTime] = useState(0);
  const [clipAnalysis, setClipAnalysis] = useState<Analysis | null>(null);
  const [uploading, setUploading] = useState(false);
  const [clipError, setClipError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const timeRef = useRef(0);
  timeRef.current = clipTime;

  const showClip = useCallback((loaded: ClipInfo) => {
    setClip(loaded);
    setClipAnalysis(null);
    setClipTime(clearestMoment(loaded));
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
    setScanning(false);
    try {
      showClip(await api.uploadClip(file));
    } catch (error) {
      setClipError(`${file.name} : ${describe(error)}`);
    } finally {
      setUploading(false);
    }
  };

  // One analysis request at a time; while one runs, only the latest moment asked waits
  const wanted = useRef<number | null>(null);
  const inFlight = useRef(false);
  const requestAnalysis = useCallback(async (time: number) => {
    wanted.current = time;
    if (inFlight.current) return;
    inFlight.current = true;
    while (wanted.current !== null) {
      const next = wanted.current;
      wanted.current = null;
      try {
        setClipAnalysis(await api.analyzeClip(next, noiseGateRef.current));
      } catch (error) {
        setClipError(describe(error));
      }
    }
    inFlight.current = false;
  }, []);

  useEffect(() => {
    if (clip && online) void requestAnalysis(clipTime);
  }, [clip, clipTime, noiseGate, online, requestAnalysis]);

  // « Parcourir »: the cursor moves at real speed, the analysis follows; nothing is played
  useEffect(() => {
    if (!scanning || !clip) return undefined;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = timeRef.current + (now - last) / 1000;
      last = now;
      if (next >= clip.duration) {
        setClipTime(clip.duration);
        setScanning(false);
        return;
      }
      setClipTime(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [scanning, clip]);

  const toggleScan = () => {
    if (!clip) return;
    if (!scanning && clipTime >= clip.duration - 0.01) setClipTime(0);
    setScanning(!scanning);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropping(false);
    const file = event.dataTransfer.files[0];
    if (file && online && !uploading) void upload(file);
  };

  /* ---------- Display ---------- */

  const analysis = source === 'micro' ? liveAnalysis : clipAnalysis;
  const partials = analysis?.partials ?? [];
  const captureDevices = server.devices?.capture_devices ?? [];

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
                  ? `À l’écoute à ${((inputRate ?? 0) / 1000).toFixed(1)} kHz. Rien n’est enregistré : seules la note et les partiels s’affichent.`
                  : 'synthway-core ouvre le micro quand tu cliques sur Écouter, et le ferme quand tu arrêtes ou quittes l’onglet. Rien n’est enregistré.'}
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
          ) : (
            <Section
              title="Fichier"
              badge={clip ? <Badge>{clip.name}</Badge> : undefined}
              actions={
                <>
                  {clip && (
                    <>
                      <Button size="small" onClick={toggleScan} title="Fait avancer le curseur en temps réel, sans jouer le son">
                        {scanning ? <Pause size={13} /> : <Play size={13} />}
                        {scanning ? 'Pause' : 'Parcourir'}
                      </Button>
                      <Button
                        size="small"
                        onClick={() => {
                          setScanning(false);
                          setClipTime(clearestMoment(clip));
                        }}
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
                    onSeek={(time) => {
                      setScanning(false);
                      setClipTime(time);
                    }}
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
                  note le long du fichier. Clique ou glisse pour choisir le moment analysé (flèches : ±10 ms).
                </p>
              )}
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
            <Tuner analysis={analysis} a4={a4} hold={source === 'micro'} />
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
          </Section>
        </Panel>

        <Panel className={styles.partialsPanel}>
          <Section
            title="Partiels"
            badge={<Badge>{partials.length}</Badge>}
            actions={
              <span className={styles.soon} title="Prochaine étape : une carte de l’Instrument Creator à partir de ces partiels">
                Créer un instrument <SoonBadge />
              </span>
            }
          >
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
    </div>
  );
}
