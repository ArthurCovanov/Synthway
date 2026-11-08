import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { frequencyToNote } from '../lib/music';
import { useElementSize } from '../lib/useElementSize';
import type { ClipInfo } from '../types';
import styles from './ClipWaveform.module.css';

const PAD = { left: 12, right: 44, top: 18, bottom: 22 };
/** Track points shown: those clear enough to name a note */
const TRACK_CLARITY = 0.5;
/** The note lane spans at least this many semitones, so that a held note is a flat line */
const MIN_SPAN_SEMITONES = 6;

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}

/** Time axis step, in seconds: about one label every 80 px */
function timeStep(duration: number, width: number): number {
  const wanted = (duration * 80) / Math.max(1, width);
  return [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((step) => step >= wanted) ?? 300;
}

/**
 * Waveform of a loaded file, with the note found along it (dots, higher
 * when higher, brighter when clearer) and a cursor: click or drag to choose
 * the moment analyzed, arrows to nudge it (Shift: ten times more).
 */
export function ClipWaveform({
  clip,
  time,
  a4,
  onSeek,
}: {
  clip: ClipInfo;
  time: number;
  a4: number;
  onSeek: (time: number) => void;
}) {
  const [boxRef, { width, height }] = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState(false);
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const mid = PAD.top + plotH / 2;
  const x = (seconds: number) => PAD.left + (seconds / clip.duration) * plotW;

  const loudest = Math.max(1e-6, ...clip.overview);
  const columns = clip.overview.length;
  const wave = clip.overview
    .map((peak, i) => {
      const px = PAD.left + ((i + 0.5) / columns) * plotW;
      const half = Math.max(0.5, (peak / loudest) * (plotH / 2 - 2));
      return `M${px.toFixed(1)} ${(mid - half).toFixed(1)}V${(mid + half).toFixed(1)}`;
    })
    .join('');

  // Note lane, in semitones
  const track = clip.track;
  const points = track.frequency.length;
  const clear = track.frequency
    .map((frequency, i) => ({ i, frequency, clarity: track.clarity[i] }))
    .filter((point) => point.frequency > 0 && point.clarity >= TRACK_CLARITY);
  const semitones = clear.map((point) => 12 * Math.log2(point.frequency / a4));
  let low = Math.min(...semitones);
  let high = Math.max(...semitones);
  if (clear.length && high - low < MIN_SPAN_SEMITONES) {
    const centre = (low + high) / 2;
    low = centre - MIN_SPAN_SEMITONES / 2;
    high = centre + MIN_SPAN_SEMITONES / 2;
  }
  const noteY = (semitone: number) => PAD.top + 6 + (1 - (semitone - low) / (high - low)) * (plotH - 12);
  const noteLabel = (semitone: number) => {
    const note = frequencyToNote(a4 * Math.pow(2, semitone / 12), a4);
    return note ? `${note.name}${note.octave}` : '';
  };

  const seekAt = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const seconds = ((clientX - rect.left - PAD.left) / plotW) * clip.duration;
    onSeek(Math.max(0, Math.min(clip.duration, seconds)));
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    svgRef.current?.setPointerCapture(event.pointerId);
    setDragging(true);
    seekAt(event.clientX);
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, number> = { ArrowRight: step, ArrowLeft: -step, Home: -Infinity, End: Infinity };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    onSeek(Math.max(0, Math.min(clip.duration, time + move)));
  };

  const tick = timeStep(clip.duration, plotW);
  const cursor = x(time);

  return (
    <div ref={boxRef} className={styles.box}>
      {width > 0 && (
        <svg
          ref={svgRef}
          width={width}
          height={height}
          className={styles.svg}
          data-dragging={dragging ? 'true' : undefined}
          tabIndex={0}
          role="slider"
          aria-label="Moment analysé dans le fichier"
          aria-valuemin={0}
          aria-valuemax={Number(clip.duration.toFixed(2))}
          aria-valuenow={Number(time.toFixed(2))}
          aria-valuetext={formatTime(time)}
          onPointerDown={onPointerDown}
          onPointerMove={(event) => dragging && seekAt(event.clientX)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onKeyDown={onKeyDown}
        >
          <rect className={styles.plot} x={PAD.left} y={PAD.top} width={plotW} height={plotH} rx={6} />
          {Array.from({ length: Math.floor(clip.duration / tick) + 1 }, (_, i) => i * tick).map((seconds) => (
            <g key={seconds}>
              <line className={styles.gridLine} x1={x(seconds)} x2={x(seconds)} y1={PAD.top} y2={PAD.top + plotH} />
              <text className={styles.tick} x={x(seconds)} y={PAD.top + plotH + 15} textAnchor="middle">
                {seconds < 60 ? `${Number(seconds.toFixed(2))} s` : formatTime(seconds)}
              </text>
            </g>
          ))}
          <path className={styles.wave} d={wave} />

          {clear.map((point, n) => (
            <circle
              key={point.i}
              className={styles.notePoint}
              cx={PAD.left + ((point.i + 0.5) / points) * plotW}
              cy={noteY(semitones[n])}
              r={1.8}
              opacity={0.25 + 0.75 * point.clarity}
            />
          ))}
          {clear.length > 0 && (
            <>
              <text className={styles.noteTick} x={PAD.left + plotW + 6} y={noteY(high) + 4}>
                {noteLabel(high)}
              </text>
              <text className={styles.noteTick} x={PAD.left + plotW + 6} y={noteY(low) + 4}>
                {noteLabel(low)}
              </text>
            </>
          )}

          <line className={styles.cursor} x1={cursor} x2={cursor} y1={PAD.top - 4} y2={PAD.top + plotH} />
          <text className={styles.cursorLabel} x={Math.min(PAD.left + plotW - 24, Math.max(PAD.left + 24, cursor))} y={PAD.top - 6} textAnchor="middle">
            {formatTime(time)}
          </text>
        </svg>
      )}
    </div>
  );
}
