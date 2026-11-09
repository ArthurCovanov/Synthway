import { AudioLines, Download, ExternalLink, FileAudio, Pause, Play, Square, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import layout from '../components/layout.module.css';
import { ScreenHeader } from '../components/ScreenHeader';
import { Badge, Button, Panel, Section, Segmented } from '../components/ui';
// translateNow: the module t, for messages made by requests, which must not run
// again when the language changes
import { t, t as translateNow, useI18n, type MessageKey } from '../i18n';
import { api, SEPARATION_SOURCE_URL, separationStemUrl } from '../lib/api';
import { useSpaceBar } from '../lib/keyboard';
import { saveJson, usePersistentState } from '../lib/storage';
import { useSynthServer } from '../lib/SynthServer';
import type { SeparationModel, SeparationStatus } from '../types';
import styles from './Decomposer.module.css';

/*
 * Decomposer: decomposes a piece of music into its stems (drums, bass, vocals,
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

// Texts by key: translated when shown, in the language of the moment
const MODELS: { value: SeparationModel; label: MessageKey; title: MessageKey }[] = [
  { value: 'htdemucs', label: 'decomposer.model.fourStems', title: 'decomposer.model.fourStemsTitle' },
  { value: 'htdemucs_ft', label: 'decomposer.model.fourStemsFine', title: 'decomposer.model.fourStemsFineTitle' },
  { value: 'htdemucs_6s', label: 'decomposer.model.sixStems', title: 'decomposer.model.sixStemsTitle' },
];

/** By Demucs id: the name shown, and the colour */
const STEMS: Record<string, { label: MessageKey; color: string }> = {
  drums: { label: 'decomposer.stemName.drums', color: 'var(--neon-pink)' },
  bass: { label: 'decomposer.stemName.bass', color: 'var(--neon-blue)' },
  vocals: { label: 'decomposer.stemName.vocals', color: 'var(--neon-violet)' },
  other: { label: 'decomposer.stemName.other', color: 'var(--neon-cyan)' },
  guitar: { label: 'decomposer.stemName.guitar', color: 'var(--neon-orange)' },
  piano: { label: 'decomposer.stemName.piano', color: 'var(--neon-yellow)' },
};

const STAGES: Record<NonNullable<SeparationStatus['job']['stage']>, MessageKey> = {
  starting: 'decomposer.stage.starting',
  loading: 'decomposer.stage.loading',
  reading: 'decomposer.stage.reading',
  separating: 'decomposer.stage.separating',
  saving: 'decomposer.stage.saving',
};

/** A stem's name in the current language and its colour; a stem Synthway does not know keeps its Demucs id */
function stemInfo(name: string) {
  const stem = STEMS[name];
  return stem ? { label: t(stem.label), color: stem.color } : { label: name, color: 'var(--neon-green)' };
}

/** Why a request failed; the server's own messages are shown as they come (in French) */
function describe(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return t('decomposer.error.noAnswer');
  }
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min ${String(Math.round(seconds % 60)).padStart(2, '0')} s` : `${seconds.toFixed(1)} s`;
}

function formatSize(bytes: number): string {
  return bytes >= 2 ** 20
    ? t('decomposer.size.megabytes', { size: (bytes / 2 ** 20).toFixed(1) })
    : t('decomposer.size.kilobytes', { size: Math.ceil(bytes / 2 ** 10) });
}

function deviceLabel(device: string | null): string {
  if (device === 'cuda') return t('decomposer.device.cuda');
  if (device === 'cpu') return t('decomposer.device.cpu');
  return device ?? '';
}

/**
 * One track plays at a time, in the browser, from the server's file (it
 * answers Range requests, so the browser can start anywhere). A track is a key
 * and its address; the address changes with each new piece or separation, so
 * that no cache serves the previous one. The piece and its stems are in step:
 * one cursor for all of them, and another track starts where it is. Only from
 * the end of a track does playback start again at the start.
 */
function useTrackPlayer(onError: (error: string) => void) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [track, setTrack] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  /** The cursor, for play(): the same as time, without waiting for a render */
  const timeRef = useRef(0);
  const endedRef = useRef(false);

  const follow = useCallback((at: number) => {
    timeRef.current = at;
    setTime(at);
  }, []);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'auto';
    audioRef.current = audio;
    audio.addEventListener('play', () => setPlaying(true));
    audio.addEventListener('pause', () => {
      setPlaying(false);
      if (audio.getAttribute('src') && !audio.ended) follow(audio.currentTime);
    });
    audio.addEventListener('ended', () => {
      endedRef.current = true;
      follow(audio.duration || timeRef.current);
    });
    audio.addEventListener('error', () => {
      if (audio.getAttribute('src')) onError(t('decomposer.error.playbackFailed'));
    });
    const tick = window.setInterval(() => {
      if (!audio.paused) follow(audio.currentTime);
    }, PLAYBACK_FOLLOW_MS);
    return () => {
      window.clearInterval(tick);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audioRef.current = null;
    };
  }, [onError, follow]);

  /** Plays the track from the cursor, or pauses it when it plays */
  const play = useCallback(
    (key: string, url: string) => {
      const audio = audioRef.current;
      if (!audio) return;
      if (key === track && !audio.paused) {
        audio.pause();
        return;
      }
      const start = endedRef.current ? 0 : timeRef.current;
      endedRef.current = false;
      if (key !== track || !audio.getAttribute('src')) {
        audio.src = url;
        setTrack(key);
      }
      // Kept by the browser even before the new track has loaded
      audio.currentTime = start;
      follow(start);
      audio.play().catch((error: unknown) => {
        // AbortError: paused or replaced before it could start
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          onError(t('decomposer.error.cannotPlay', { reason: describe(error) }));
        }
      });
    },
    [track, onError, follow],
  );

  /** Selects the track and places the cursor at `at`, without playing: what plays pauses, ▶ or the space bar go on */
  const select = useCallback(
    (key: string, url: string, at: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      // A new address drops the 'pause' event still to come
      setPlaying(false);
      endedRef.current = false;
      if (key !== track || !audio.getAttribute('src')) {
        audio.src = url;
        setTrack(key);
      }
      audio.currentTime = at;
      follow(at);
    },
    [track, follow],
  );

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setPlaying(false);
    setTrack(null);
    endedRef.current = false;
    follow(0);
  }, [follow]);

  return { track, playing, time, play, select, stop };
}

/** A stem's waveform from its peaks, with the playback cursor; a click selects the stem and places the cursor there */
function StemWave({
  peaks,
  scale,
  color,
  cursor,
  selected,
  label,
  onSeek,
}: {
  peaks: number[];
  /** The highest peak of all the stems: their heights compare */
  scale: number;
  color: string;
  /** Share of the piece played (the same for all the tracks), null when no track has been played */
  cursor: number | null;
  /** The track loaded: its cursor is bright, the others' faint */
  selected: boolean;
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
          data-other={selected ? undefined : 'true'}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

export function Decomposer({ onOpenAnalyzer }: { onOpenAnalyzer: () => void }) {
  // In here, the t of the hook: the screen renders again when the language changes
  const { t, tr } = useI18n();
  const server = useSynthServer();
  const online = server.connection === 'online';
  const [status, setStatus] = useState<SeparationStatus | null>(null);
  const [model, setModel] = usePersistentState<SeparationModel>('synthway.decomposer.model.v1', () => 'htdemucs');
  const [uploading, setUploading] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { track, playing, time, play, select, stop } = useTrackPlayer(setError);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.separation());
    } catch (failure) {
      setError(translateNow('decomposer.error.status', { reason: describe(failure) }));
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
      setError(t('decomposer.error.upload', { name: file.name, reason: describe(failure) }));
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
      setError(t('decomposer.error.decompose', { reason: describe(failure) }));
    }
  };

  const cancel = async () => {
    try {
      setStatus(await api.cancelSeparation());
    } catch (failure) {
      setError(t('decomposer.error.cancel', { reason: describe(failure) }));
    }
  };

  const clear = async () => {
    setError(null);
    stop();
    try {
      setStatus(await api.clearSeparationSource());
    } catch (failure) {
      setError(t('decomposer.error.clear', { reason: describe(failure) }));
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
      setError(t('decomposer.error.toAnalyzer', { stem: stemInfo(name).label, reason: describe(failure) }));
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
  const sourceUrl = `${SEPARATION_SOURCE_URL}?v=${encodeURIComponent(sourceStamp)}`;
  const stemUrl = (name: string) => `${separationStemUrl(name)}?v=${encodeURIComponent(resultStamp)}`;
  const models = MODELS.map((option) => ({ value: option.value, label: t(option.label), title: t(option.title) }));

  // The space bar plays or pauses the track selected (the one played last; none yet: the piece), from the cursor
  useSpaceBar(() => {
    if (!online) return;
    if (track && track !== 'source') play(track, stemUrl(track));
    else if (source) play('source', sourceUrl);
  });

  return (
    <div className={layout.screen}>
      <ScreenHeader
        index="03"
        eyebrow={t('decomposer.eyebrow')}
        title="Decomposer"
        subtitle={t('decomposer.subtitle')}
      >
        <aside className={styles.credit} aria-label={t('decomposer.credit.label')}>
          <span className={styles.creditEyebrow}>{t('decomposer.credit.poweredBy')}</span>
          <a className={styles.creditName} href="https://github.com/adefossez/demucs" target="_blank" rel="noreferrer">
            Demucs v4
            <ExternalLink size={13} />
          </a>
          <span className={styles.creditNote}>
            {tr('decomposer.credit.note', {
              link: (inner) => (
                <a href="https://github.com/facebookresearch/demucs" target="_blank" rel="noreferrer">
                  {inner}
                </a>
              ),
            })}
          </span>
        </aside>
      </ScreenHeader>

      <div className={styles.body}>
        <Panel className={styles.panel}>
          <Section
            title={t('decomposer.source.title')}
            badge={source ? <Badge>{source.name}</Badge> : undefined}
            actions={
              <>
                {source && (
                  <Button
                    size="small"
                    disabled={!online}
                    onClick={() => play('source', sourceUrl)}
                    title={track === 'source' && playing ? t('decomposer.pauseTitle') : t('decomposer.source.playTitle')}
                  >
                    {track === 'source' && playing ? <Pause size={13} /> : <Play size={13} />}
                    {track === 'source' && playing ? t('decomposer.pause') : t('decomposer.source.play')}
                  </Button>
                )}
                {source && (
                  <Button
                    size="small"
                    disabled={!canChange}
                    onClick={() => void clear()}
                    title={t('decomposer.source.removeTitle')}
                  >
                    <Trash2 size={13} />
                    {t('decomposer.source.remove')}
                  </Button>
                )}
                <Button size="small" variant={source ? 'default' : 'primary'} disabled={!canChange} onClick={() => fileInput.current?.click()}>
                  <Upload size={13} />
                  {uploading ? t('decomposer.source.uploading') : t('decomposer.source.import')}
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
                      {result ? ` · ${formatDuration(result.duration)}` : ''} · {t('decomposer.source.replaceHint')}
                    </span>
                  </div>
                </div>
              ) : (
                <div className={styles.dropHint}>
                  <FileAudio size={28} />
                  <span>{t('decomposer.source.dropHint')}</span>
                  <span className={styles.note}>{t('decomposer.source.dropNote')}</span>
                </div>
              )}
            </div>

            <div className={styles.controls}>
              <Segmented label={t('decomposer.model.label')} value={model} onChange={setModel} options={models} disabled={running} />
              {running ? (
                <Button onClick={() => void cancel()}>
                  <Square size={14} />
                  {t('common.cancel')}
                </Button>
              ) : (
                <Button variant="primary" disabled={!canChange || !source} onClick={() => void decompose()}>
                  <AudioLines size={15} />
                  {t('decomposer.decompose')}
                </Button>
              )}
            </div>
            <p className={styles.note}>{models.find((option) => option.value === model)?.title}</p>

            {running && job && (
              <div className={styles.progress} role="status">
                <div className={styles.progressBar}>
                  <div
                    className={styles.progressFill}
                    style={{ width: `${job.stage === 'separating' || job.stage === 'saving' ? percent : 2}%` }}
                  />
                </div>
                <span className={styles.note}>
                  {job.stage ? t(STAGES[job.stage]) : t('decomposer.decomposing')}
                  {job.stage === 'separating' ? ` ${t('decomposer.percent', { percent })}` : ''}
                  {job.device ? ` · ${t('decomposer.onDevice', { device: deviceLabel(job.device) })}` : ''}
                </span>
              </div>
            )}

            {status && !available && <p className={styles.warning}>{status.reason}</p>}
            {!online && <p className={styles.note}>{t('decomposer.offline')}</p>}
            {job?.state === 'error' && job.error && (
              <p className={styles.error}>{t('decomposer.error.demucs', { error: job.error })}</p>
            )}
            {job?.state === 'idle' && job.error && <p className={styles.note}>{job.error}.</p>}
            {error && <p className={styles.error}>{error}</p>}
          </Section>
        </Panel>

        <Panel className={styles.panel}>
          <Section
            title={t('decomposer.stems.title')}
            badge={result ? <Badge>{t('decomposer.stems.count', { count: result.stems.length })}</Badge> : undefined}
          >
            {result ? (
              <>
                <div className={styles.stems}>
                  {result.stems.map((stem) => {
                    const info = stemInfo(stem.name);
                    const url = stemUrl(stem.name);
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
                          cursor={track !== null ? Math.min(1, time / Math.max(result.duration, 1e-6)) : null}
                          selected={loaded}
                          label={t('decomposer.stems.waveform', { stem: info.label })}
                          onSeek={(fraction) => select(stem.name, url, fraction * result.duration)}
                        />
                        <div className={styles.stemActions}>
                          <Button
                            size="small"
                            iconOnly
                            disabled={!online}
                            onClick={() => play(stem.name, url)}
                            title={
                              loaded && playing
                                ? t('decomposer.pauseTitle')
                                : t('decomposer.stems.playTitle', { stem: info.label })
                            }
                            aria-label={loaded && playing ? t('decomposer.pause') : t('decomposer.stems.play', { stem: info.label })}
                          >
                            {loaded && playing ? <Pause size={14} /> : <Play size={14} />}
                          </Button>
                          <Button
                            size="small"
                            iconOnly
                            disabled={!online}
                            onClick={() => download(stem.name)}
                            title={t('decomposer.stems.downloadTitle', { stem: info.label })}
                            aria-label={t('decomposer.stems.download', { stem: info.label })}
                          >
                            <Download size={14} />
                          </Button>
                          <Button
                            size="small"
                            disabled={!online || !server.coreLoaded || busy !== null}
                            onClick={() => void analyze(stem.name)}
                            title={t('decomposer.stems.analyzeTitle')}
                          >
                            {busy === stem.name ? t('decomposer.stems.sending') : t('decomposer.stems.analyze')}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className={styles.note}>
                  {t('decomposer.stems.result', {
                    model: models.find((option) => option.value === result.model)?.label ?? result.model,
                    id: result.model,
                    rate: (result.sample_rate / 1000).toFixed(1),
                    duration: formatDuration(result.seconds),
                    device: deviceLabel(result.device),
                  })}
                </p>
              </>
            ) : (
              <div className={styles.empty}>
                <AudioLines size={26} />
                <span>
                  {running
                    ? t('decomposer.stems.waiting')
                    : t(source ? 'decomposer.stems.emptyReady' : 'decomposer.stems.emptyNoSource')}
                </span>
              </div>
            )}
          </Section>
        </Panel>
      </div>
    </div>
  );
}
