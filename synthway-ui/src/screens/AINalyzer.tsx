import { AudioLines, Download, ExternalLink, FileAudio, Pause, Play, Square, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import layout from '../components/layout.module.css';
import { ScreenHeader } from '../components/ScreenHeader';
import { Badge, Button, Panel, Section, Segmented } from '../components/ui';
import { api, SEPARATION_SOURCE_URL, separationStemUrl } from '../lib/api';
import { saveJson, usePersistentState } from '../lib/storage';
import { useSynthServer } from '../lib/SynthServer';
import type { SeparationModel, SeparationStatus } from '../types';
import styles from './AINalyzer.module.css';

/*
 * AI-nalyzer: decomposes a piece of music into its stems (drums, bass, vocals,
 * other; guitar and piano with the 6-stem model) with Demucs v4, a neural
 * network run by synthway-server in a process of its own (synthway-demucs/).
 * The piece is sent whole to the server, « Decompose » starts the separation
 * in the background and this page follows it. Each stem can be played in the
 * browser, downloaded, or sent to the Analyzer (its Fichier tab), to analyze
 * one instrument without the others. Third-party tool: credited in the header.
 */

const ACCEPTED_FILES = '.wav,.flac,.mp3,.ogg,audio/wav,audio/x-wav,audio/flac,audio/mpeg,audio/ogg';
/** While a separation runs, its progress is asked this often */
const POLL_MS = 500;
/** While playing, the cursor follows 20 times a second */
const PLAYBACK_FOLLOW_MS = 50;
/** The Analyzer's « Source du son », written so that it opens on its Fichier tab */
const ANALYZER_SOURCE_KEY = 'synthway.analyzer.source.v1';

const MODELS: { value: SeparationModel; label: string; title: string }[] = [
  { value: 'htdemucs', label: '4 pistes', title: 'htdemucs : batterie, basse, voix, autres. Le plus rapide.' },
  {
    value: 'htdemucs_ft',
    label: '4 pistes, affiné',
    title: 'htdemucs_ft : les mêmes pistes, un peu plus propres, environ 4 fois plus lent.',
  },
  {
    value: 'htdemucs_6s',
    label: '6 pistes',
    title: 'htdemucs_6s : ajoute guitare et piano. Le piano déborde beaucoup sur les autres pistes, selon l’auteur.',
  },
];

const STEMS: Record<string, { label: string; color: string }> = {
  drums: { label: 'Batterie', color: 'var(--neon-pink)' },
  bass: { label: 'Basse', color: 'var(--neon-blue)' },
  vocals: { label: 'Voix', color: 'var(--neon-violet)' },
  other: { label: 'Autres', color: 'var(--neon-cyan)' },
  guitar: { label: 'Guitare', color: 'var(--neon-orange)' },
  piano: { label: 'Piano', color: 'var(--neon-yellow)' },
};

const STAGES: Record<NonNullable<SeparationStatus['job']['stage']>, string> = {
  starting: 'Démarrage de Demucs…',
  loading: 'Chargement du modèle (téléchargé à sa première utilisation)…',
  reading: 'Lecture du morceau…',
  separating: 'Séparation…',
  saving: 'Écriture des pistes…',
};

function stemInfo(name: string) {
  return STEMS[name] ?? { label: name, color: 'var(--neon-green)' };
}

function describe(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'le serveur ne répond pas';
  }
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${String(Math.round(seconds % 60)).padStart(2, '0')} s` : `${seconds.toFixed(1)} s`;
}

function formatSize(bytes: number): string {
  return bytes >= 2 ** 20 ? `${(bytes / 2 ** 20).toFixed(1)} Mo` : `${Math.ceil(bytes / 2 ** 10)} Ko`;
}

function deviceLabel(device: string | null): string {
  if (device === 'cuda') return 'carte graphique (CUDA)';
  if (device === 'cpu') return 'processeur';
  return device ?? '';
}

/**
 * One track plays at a time, in the browser, from the server's file (it
 * answers Range requests, so the browser can start anywhere). A track is a key
 * and its address; the address changes with each new piece or separation, so
 * that no cache serves the previous one.
 */
function useTrackPlayer(onError: (error: string) => void) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [track, setTrack] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'auto';
    audioRef.current = audio;
    audio.addEventListener('play', () => setPlaying(true));
    audio.addEventListener('pause', () => setPlaying(false));
    audio.addEventListener('ended', () => setTime(audio.duration || 0));
    audio.addEventListener('error', () => {
      if (audio.getAttribute('src')) onError('La lecture a échoué.');
    });
    const tick = window.setInterval(() => {
      if (!audio.paused) setTime(audio.currentTime);
    }, PLAYBACK_FOLLOW_MS);
    return () => {
      window.clearInterval(tick);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audioRef.current = null;
    };
  }, [onError]);

  /** Plays the track from `from` (where it is, when omitted), or pauses it when it plays and no `from` is given */
  const play = useCallback(
    (key: string, url: string, from?: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      if (key === track && !audio.paused && from === undefined) {
        audio.pause();
        return;
      }
      if (key !== track || !audio.getAttribute('src')) {
        audio.src = url;
        setTrack(key);
      }
      if (from !== undefined) audio.currentTime = from;
      else if (audio.ended) audio.currentTime = 0;
      setTime(audio.currentTime);
      audio.play().catch((error: unknown) => {
        // AbortError: paused or replaced before it could start
        if (!(error instanceof DOMException && error.name === 'AbortError')) onError(`Lecture impossible : ${describe(error)}`);
      });
    },
    [track, onError],
  );

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setTrack(null);
    setTime(0);
  }, []);

  return { track, playing, time, play, stop };
}

/** A stem's waveform from its peaks, with the playback cursor; a click plays from there */
function StemWave({
  peaks,
  scale,
  color,
  cursor,
  label,
  onSeek,
}: {
  peaks: number[];
  /** The highest peak of all the stems: their heights compare */
  scale: number;
  color: string;
  /** Share of the stem played, null when it is not the track loaded */
  cursor: number | null;
  label: string;
  onSeek: (fraction: number) => void;
}) {
  const count = Math.max(1, peaks.length);
  const height = (peak: number) => Math.min(1, peak / Math.max(scale, 1e-6)) * 46;
  const top = peaks.map((peak, i) => `${i === 0 ? 'M' : 'L'}${i} ${(50 - height(peak)).toFixed(1)}`).join('');
  const bottom = peaks
    .map((peak, i) => [i, peak] as const)
    .reverse()
    .map(([i, peak]) => `L${i} ${(50 + height(peak)).toFixed(1)}`)
    .join('');
  const seek = (event: MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)));
  };
  return (
    <svg
      className={styles.wave}
      viewBox={`0 0 ${count - 1 || 1} 100`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      onClick={seek}
    >
      <path d="M0 50H100000" className={styles.waveAxis} vectorEffect="non-scaling-stroke" />
      <path d={`${top}${bottom}Z`} style={{ fill: color, stroke: color }} className={styles.waveShape} vectorEffect="non-scaling-stroke" />
      {cursor !== null && (
        <path
          d={`M${(cursor * (count - 1)).toFixed(2)} 0V100`}
          className={styles.waveCursor}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

export function AINalyzer({ onOpenAnalyzer }: { onOpenAnalyzer: () => void }) {
  const server = useSynthServer();
  const online = server.connection === 'online';
  const [status, setStatus] = useState<SeparationStatus | null>(null);
  const [model, setModel] = usePersistentState<SeparationModel>('synthway.ainalyzer.model.v1', () => 'htdemucs');
  const [uploading, setUploading] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { track, playing, time, play, stop } = useTrackPlayer(setError);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.separation());
    } catch (failure) {
      setError(`État de la décomposition indisponible : ${describe(failure)}`);
    }
  }, []);

  useEffect(() => {
    if (online) void refresh();
  }, [online, refresh]);

  const job = status?.job;
  const running = job?.state === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, refresh]);

  // A new piece or a new separation: what was playing is gone
  const source = status?.source ?? null;
  const result = status?.result ?? null;
  const sourceStamp = source ? `${source.name}:${source.size}` : '';
  const resultStamp = result ? `${result.model}:${result.seconds}:${result.duration}` : '';
  useEffect(() => stop(), [sourceStamp, resultStamp, stop]);

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      setStatus(await api.uploadSeparationSource(file));
    } catch (failure) {
      setError(`${file.name} : ${describe(failure)}`);
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropping(false);
    const file = event.dataTransfer.files[0];
    if (file && online && !uploading && !running) void upload(file);
  };

  const decompose = async () => {
    setError(null);
    try {
      setStatus(await api.runSeparation(model));
    } catch (failure) {
      setError(`Décomposition impossible : ${describe(failure)}`);
    }
  };

  const cancel = async () => {
    try {
      setStatus(await api.cancelSeparation());
    } catch (failure) {
      setError(`Annulation impossible : ${describe(failure)}`);
    }
  };

  /** The stem becomes the Analyzer's file, which opens on it */
  const analyze = async (name: string) => {
    setBusy(name);
    setError(null);
    try {
      await api.stemToAnalyzer(name);
      saveJson(ANALYZER_SOURCE_KEY, 'file');
      onOpenAnalyzer();
    } catch (failure) {
      setError(`${stemInfo(name).label} : envoi à l’Analyzer impossible (${describe(failure)})`);
      setBusy(null);
    }
  };

  /** The server sends it as an attachment, named after the piece and the stem */
  const download = (name: string) => {
    const link = document.createElement('a');
    link.href = separationStemUrl(name, true);
    link.download = '';
    link.click();
  };

  const available = status?.available ?? false;
  const canChange = online && available && !uploading && !running;
  const scale = result ? Math.max(...result.stems.flatMap((stem) => stem.peaks), 1e-6) : 1;
  const percent = Math.round((job?.progress ?? 0) * 100);

  return (
    <div className={layout.screen}>
      <ScreenHeader
        index="05"
        eyebrow="Séparation de sources"
        title="AI-nalyzer"
        subtitle="Décompose un morceau en ses pistes (batterie, basse, voix, autres…), puis analyse celle qui t’intéresse."
      >
        <aside className={styles.credit} aria-label="Outil tiers utilisé">
          <span className={styles.creditEyebrow}>Powered by</span>
          <a className={styles.creditName} href="https://github.com/adefossez/demucs" target="_blank" rel="noreferrer">
            Demucs v4
            <ExternalLink size={13} />
          </a>
          <span className={styles.creditNote}>
            Outil tiers open source, licence MIT ·{' '}
            <a href="https://github.com/facebookresearch/demucs" target="_blank" rel="noreferrer">
              version d’origine (Meta)
            </a>
          </span>
        </aside>
      </ScreenHeader>

      <div className={styles.body}>
        <Panel className={styles.panel}>
          <Section
            title="Morceau"
            badge={source ? <Badge>{source.name}</Badge> : undefined}
            actions={
              <>
                {source && (
                  <Button
                    size="small"
                    disabled={!online}
                    onClick={() => play('source', `${SEPARATION_SOURCE_URL}?v=${encodeURIComponent(sourceStamp)}`)}
                    title={track === 'source' && playing ? 'Met la lecture en pause' : 'Lit le morceau entier'}
                  >
                    {track === 'source' && playing ? <Pause size={13} /> : <Play size={13} />}
                    {track === 'source' && playing ? 'Pause' : 'Lire'}
                  </Button>
                )}
                <Button size="small" variant={source ? 'default' : 'primary'} disabled={!canChange} onClick={() => fileInput.current?.click()}>
                  <Upload size={13} />
                  {uploading ? 'Envoi…' : 'Importer un morceau'}
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
              {source ? (
                <div className={styles.sourceRow}>
                  <FileAudio size={26} />
                  <div className={styles.sourceText}>
                    <span className={styles.sourceName}>{source.name}</span>
                    <span className={styles.note}>
                      {formatSize(source.size)}
                      {result ? ` · ${formatDuration(result.duration)}` : ''} · dépose un autre fichier ici pour le remplacer
                    </span>
                  </div>
                </div>
              ) : (
                <div className={styles.dropHint}>
                  <FileAudio size={28} />
                  <span>Dépose un morceau WAV, FLAC, MP3 ou OGG ici, ou clique sur « Importer un morceau ».</span>
                  <span className={styles.note}>Il est envoyé entier au serveur, qui le garde. Rien n’est joué.</span>
                </div>
              )}
            </div>

            <div className={styles.controls}>
              <Segmented label="Modèle de Demucs" value={model} onChange={setModel} options={MODELS} disabled={running} />
              {running ? (
                <Button onClick={() => void cancel()}>
                  <Square size={14} />
                  Annuler
                </Button>
              ) : (
                <Button variant="primary" disabled={!canChange || !source} onClick={() => void decompose()}>
                  <AudioLines size={15} />
                  Decompose
                </Button>
              )}
            </div>
            <p className={styles.note}>{MODELS.find((option) => option.value === model)?.title}</p>

            {running && job && (
              <div className={styles.progress} role="status">
                <div className={styles.progressBar}>
                  <div
                    className={styles.progressFill}
                    style={{ width: `${job.stage === 'separating' || job.stage === 'saving' ? percent : 2}%` }}
                  />
                </div>
                <span className={styles.note}>
                  {job.stage ? STAGES[job.stage] : 'Décomposition…'}
                  {job.stage === 'separating' ? ` ${percent} %` : ''}
                  {job.device ? ` · sur le ${deviceLabel(job.device)}` : ''}
                </span>
              </div>
            )}

            {status && !available && <p className={styles.warning}>{status.reason}</p>}
            {!online && <p className={styles.note}>Le serveur n’est pas connecté (voir les Réglages).</p>}
            {job?.state === 'error' && job.error && <p className={styles.error}>Demucs a échoué : {job.error}</p>}
            {job?.state === 'idle' && job.error && <p className={styles.note}>{job.error}.</p>}
            {error && <p className={styles.error}>{error}</p>}
          </Section>
        </Panel>

        <Panel className={styles.panel}>
          <Section
            title="Pistes"
            badge={result ? <Badge>{result.stems.length} pistes</Badge> : undefined}
          >
            {result ? (
              <>
                <div className={styles.stems}>
                  {result.stems.map((stem) => {
                    const info = stemInfo(stem.name);
                    const url = `${separationStemUrl(stem.name)}?v=${encodeURIComponent(resultStamp)}`;
                    const loaded = track === stem.name;
                    return (
                      <div key={stem.name} className={styles.stem}>
                        <div className={styles.stemName}>
                          <span className={styles.stemDot} style={{ background: info.color, boxShadow: `0 0 8px ${info.color}` }} />
                          <span>{info.label}</span>
                        </div>
                        <StemWave
                          peaks={stem.peaks}
                          scale={scale}
                          color={info.color}
                          cursor={loaded ? Math.min(1, time / Math.max(result.duration, 1e-6)) : null}
                          label={`Forme d’onde : ${info.label}`}
                          onSeek={(fraction) => play(stem.name, url, fraction * result.duration)}
                        />
                        <div className={styles.stemActions}>
                          <Button
                            size="small"
                            iconOnly
                            disabled={!online}
                            onClick={() => play(stem.name, url)}
                            title={loaded && playing ? 'Met la lecture en pause' : `Lit la piste « ${info.label} »`}
                            aria-label={loaded && playing ? 'Pause' : `Lire ${info.label}`}
                          >
                            {loaded && playing ? <Pause size={14} /> : <Play size={14} />}
                          </Button>
                          <Button
                            size="small"
                            iconOnly
                            disabled={!online}
                            onClick={() => download(stem.name)}
                            title={`Télécharge la piste « ${info.label} » en WAV (stéréo, 16 bits)`}
                            aria-label={`Télécharger ${info.label}`}
                          >
                            <Download size={14} />
                          </Button>
                          <Button
                            size="small"
                            disabled={!online || !server.coreLoaded || busy !== null}
                            onClick={() => void analyze(stem.name)}
                            title="Charge cette piste dans l’Analyzer (onglet Fichier), à la place de son fichier"
                          >
                            {busy === stem.name ? 'Envoi…' : 'Analyser'}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className={styles.note}>
                  {MODELS.find((option) => option.value === result.model)?.label ?? result.model} ({result.model}) ·{' '}
                  {(result.sample_rate / 1000).toFixed(1)} kHz · séparé en {formatDuration(result.seconds)} sur le{' '}
                  {deviceLabel(result.device)}. Un clic sur une piste la lit à partir de là.
                </p>
              </>
            ) : (
              <div className={styles.empty}>
                <AudioLines size={26} />
                <span>
                  {running
                    ? 'Les pistes apparaîtront ici à la fin de la décomposition.'
                    : `${source ? 'Clique' : 'Importe un morceau puis clique'} sur « Decompose » : chaque instrument arrivera sur sa propre piste.`}
                </span>
              </div>
            )}
          </Section>
        </Panel>
      </div>
    </div>
  );
}
