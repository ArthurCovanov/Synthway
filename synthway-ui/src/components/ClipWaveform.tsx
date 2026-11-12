import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useI18n } from '../i18n';
import { frequencyToNote } from '../lib/music';
import { useElementSize } from '../lib/useElementSize';
import type { ClipInfo, ClipWaveformPart } from '../types';
import styles from '@theme/components/ClipWaveform.module.css';

const PAD = { left: 12, right: 44, top: 18, bottom: 22 };
/** Track points shown: those clear enough to name a note */
const TRACK_CLARITY = 0.5;
/** The note lane spans at least this many semitones, so that a held note is a flat line */
const MIN_SPAN_SEMITONES = 6;
/** A press that moves farther than this selects a zone; otherwise it is a click */
const SELECT_THRESHOLD_PX = 4;
/** Zoomed in all the way, the view still shows this many samples (and at least ×64) */
const MIN_VIEW_FRAMES = 32;
/** The detailed waveform is asked at most this often while zooming or panning */
const WAVEFORM_THROTTLE_MS = 50;
/** As the server: parts of one detailed waveform */
const WAVEFORM_MAX_PARTS = 8192;
/** Samples get a dot once they are this far apart */
const SAMPLE_DOT_SPACING_PX = 6;
/** Zoom of one notch of a mouse wheel (100 px); a touchpad's small steps zoom as much over the same distance */
const WHEEL_NOTCH_ZOOM = 1.25;
const WHEEL_NOTCH_PX = 100;
/** A wheel event counted in lines or pages (Firefox), in pixels */
const WHEEL_LINE_PX = 33;
const WHEEL_PAGE_PX = 800;

/** A zone of a clip, in seconds (start < end) */
export interface ClipSelection {
  start: number;
  end: number;
}

/** Frames of the clip a detailed waveform covers, and how many per part */
interface WaveformRange {
  clip: ClipInfo;
  first: number;
  end: number;
  perPart: number;
}

function formatTime(seconds: number, decimals = 2): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(decimals).padStart(decimals + 3, '0')}`;
}

/** Time axis step, in seconds: about one label every 80 px */
function timeStep(duration: number, width: number): number {
  const wanted = (duration * 80) / Math.max(1, width);
  const steps = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  return steps.find((step) => step >= wanted) ?? 300;
}

/**
 * Waveform of a loaded file or a recording, with the note found along it
 * (dots, higher when higher, brighter when clearer) and a cursor: click to
 * choose the moment analyzed, arrows to nudge it (Shift: ten times more).
 * Dragging selects a zone with onSelect (a click or Escape removes it), and
 * moves the cursor without it. zoomable: it can also zoom and pan
 * horizontally (the wheel, plain or with Ctrl, zooms around the pointer: it
 * neither scrolls the page nor zooms the browser; a middle-button drag pans),
 * and while playing, the view follows the cursor. time null: no
 * cursor yet. loadWaveform: asks the server for the waveform of the part in
 * view, drawn like an audio editor does (lowest to highest sample of each
 * pixel column, then the samples themselves); without it, or until it comes,
 * the clip's overview is drawn. stereo false: the clip is mono, its left
 * channel is drawn. windowSeconds: without a zone, the analysis window around
 * the cursor, drawn as green bounds |—|—|.
 */
export function ClipWaveform({
  clip,
  time,
  a4,
  onSeek,
  selection = null,
  onSelect,
  zoomable = false,
  stereo = false,
  playing = false,
  loadWaveform,
  windowSeconds,
  label,
}: {
  clip: ClipInfo;
  time: number | null;
  a4: number;
  onSeek: (time: number) => void;
  selection?: ClipSelection | null;
  onSelect?: (selection: ClipSelection | null) => void;
  zoomable?: boolean;
  stereo?: boolean;
  playing?: boolean;
  /** Must be stable */
  loadWaveform?: (first: number, frames: number, count: number) => Promise<ClipWaveformPart>;
  windowSeconds?: number;
  /** Accessible name of the waveform; by default, the moment analyzed in the file */
  label?: string;
}) {
  const { t } = useI18n();
  const [boxRef, { width, height }] = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const clipPathId = `clip-waveform-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [dragging, setDragging] = useState(false);
  /** The left button's press: where, and whether it has become a selection */
  const press = useRef<{ x: number; time: number; selecting: boolean } | null>(null);
  const [panning, setPanning] = useState(false);
  const panPointer = useRef<{ pointerId: number; lastX: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewStart, setViewStart] = useState(0);
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const viewDuration = clip.duration / (zoomable ? zoom : 1);
  const viewEnd = viewStart + viewDuration;
  const x = (seconds: number) => PAD.left + ((seconds - viewStart) / viewDuration) * plotW;
  const maxZoom = Math.max(64, clip.frame_count / MIN_VIEW_FRAMES);

  useEffect(() => {
    setZoom(1);
    setViewStart(0);
  }, [clip, zoomable]);

  useEffect(() => {
    if (!zoomable || !playing || time === null || (time >= viewStart && time <= viewEnd)) return;
    setViewStart(Math.max(0, Math.min(clip.duration - viewDuration, time - viewDuration * 0.15)));
  }, [clip.duration, playing, time, viewDuration, viewEnd, viewStart, zoomable]);

  // Detailed waveform of the view, asked again once the view leaves it or its resolution no longer fits
  const rate = clip.sample_rate;
  const viewFirst = Math.max(0, Math.floor(viewStart * rate));
  const viewLast = Math.min(clip.frame_count, Math.ceil(viewEnd * rate));
  const framesPerPixel = (viewLast - viewFirst) / plotW;
  /** Frames per part, at least one: then each part is a sample */
  const wantedPerPart = Math.max(1, framesPerPixel);
  const [detail, setDetail] = useState<{ range: WaveformRange; part: ClipWaveformPart } | null>(null);
  /** The last waveform asked, not asked again while on its way */
  const asked = useRef<(WaveformRange & { seq: number }) | null>(null);
  const lastSeq = useRef(0);
  const shownSeq = useRef(0);
  const lastAskedAt = useRef(0);
  const covers = (range: WaveformRange | null | undefined): range is WaveformRange =>
    !!range && range.clip === clip && range.first <= viewFirst && range.end >= viewLast;
  // Fewer samples than pixels: the samples themselves, to join them
  const suits = (range: WaveformRange | null | undefined) =>
    covers(range) &&
    (framesPerPixel <= 1 ? range.perPart === 1 : range.perPart <= wantedPerPart * 1.5 && range.perPart >= wantedPerPart / 3);

  useEffect(() => {
    if (!loadWaveform || width <= 0 || viewLast <= viewFirst) return undefined;
    if (suits(detail?.range) || suits(asked.current)) return undefined;
    const timer = window.setTimeout(() => {
      // The view and as much again on each side: a short pan or zoom out needs nothing new
      const viewFrames = viewLast - viewFirst;
      const margin = Math.min(viewFrames, Math.max(0, Math.floor((WAVEFORM_MAX_PARTS * wantedPerPart - viewFrames) / 2)));
      const first = Math.max(0, viewFirst - margin);
      const end = Math.min(clip.frame_count, viewLast + margin);
      const count = Math.max(1, Math.min(WAVEFORM_MAX_PARTS, end - first, Math.round((end - first) / wantedPerPart)));
      lastSeq.current += 1;
      const request = { clip, first, end, perPart: (end - first) / count, seq: lastSeq.current };
      asked.current = request;
      lastAskedAt.current = performance.now();
      loadWaveform(first, end - first, count)
        .then((part) => {
          if (asked.current === request) asked.current = null;
          if (request.seq < shownSeq.current || part.left_low.length === 0) return; // a later one is shown
          shownSeq.current = request.seq;
          const range = { clip, first: part.first_frame, end: part.first_frame + part.frame_count, perPart: part.frame_count / part.left_low.length };
          setDetail({ range, part });
        })
        .catch(() => {
          // The overview stays: asked again when the view changes
          if (asked.current === request) asked.current = null;
        });
    }, Math.max(0, WAVEFORM_THROTTLE_MS - (performance.now() - lastAskedAt.current)));
    return () => window.clearTimeout(timer);
  }, [clip, detail, framesPerPixel, loadWaveform, viewFirst, viewLast, wantedPerPart, width]);

  const leftPeaks = stereo ? clip.overview_left ?? clip.overview : clip.overview;
  const rightPeaks = stereo ? clip.overview_right ?? clip.overview : clip.overview;
  const loudest = Math.max(1e-6, ...(stereo ? [...leftPeaks, ...rightPeaks] : clip.overview));
  const shown = detail && covers(detail.range) ? detail.part : null;
  const samplesShown = shown !== null && shown.frame_count === shown.left_low.length;
  const sampleDots = samplesShown && plotW / (viewDuration * rate) >= SAMPLE_DOT_SPACING_PX;

  /** A channel from the clip's overview: its peaks, mirrored */
  const drawOverview = (peaks: number[], laneTop: number, laneHeight: number) => {
    const n = peaks.length;
    const mid = laneTop + laneHeight / 2;
    const scale = (laneHeight / 2 - 2) / loudest;
    const from = Math.max(0, Math.floor((viewStart / clip.duration) * n) - 1);
    const to = Math.min(n - 1, Math.ceil((viewEnd / clip.duration) * n) + 1);
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = from; i <= to; i += 1) {
      const px = x(((i + 0.5) / n) * clip.duration).toFixed(1);
      const half = Math.max(0.5, peaks[i] * scale);
      top.push(`${i === from ? 'M' : 'L'}${px} ${(mid - half).toFixed(1)}`);
      bottom.push(`L${px} ${(mid + half).toFixed(1)}`);
    }
    return top.length ? `${top.join('')}${bottom.reverse().join('')}Z` : '';
  };

  /**
   * A channel from the detailed waveform: from its lowest to its highest
   * sample, part by part, or the samples themselves joined (dots when far apart)
   */
  const drawDetail = (part: ClipWaveformPart, low: number[], high: number[], laneTop: number, laneHeight: number) => {
    const n = low.length;
    const perPart = part.frame_count / n;
    const mid = laneTop + laneHeight / 2;
    const half = laneHeight / 2 - 2;
    const y = (value: number) => mid - Math.max(-1, Math.min(1, value / loudest)) * half;
    // A part at its middle, a sample at its own moment
    const px = (i: number) => x((part.first_frame + (perPart > 1 ? (i + 0.5) * perPart : i)) / rate);
    const from = Math.max(0, Math.floor((viewStart * rate - part.first_frame) / perPart) - 1);
    const to = Math.min(n - 1, Math.ceil((viewEnd * rate - part.first_frame) / perPart) + 1);
    const top: string[] = [];
    const dots: Array<[number, number]> = [];
    for (let i = from; i <= to; i += 1) {
      top.push(`${i === from ? 'M' : 'L'}${px(i).toFixed(1)} ${y(high[i]).toFixed(1)}`);
      if (sampleDots) dots.push([px(i), y(high[i])]);
    }
    if (perPart <= 1 || !top.length) return { path: top.join(''), dots };
    const bottom: string[] = [];
    for (let i = to; i >= from; i -= 1) bottom.push(`L${px(i).toFixed(1)} ${y(low[i]).toFixed(1)}`);
    return { path: `${top.join('')}${bottom.join('')}Z`, dots };
  };

  const lanes = stereo
    ? [
        { top: PAD.top, height: plotH / 2, peaks: leftPeaks, low: shown?.left_low, high: shown?.left_high },
        { top: PAD.top + plotH / 2, height: plotH / 2, peaks: rightPeaks, low: shown?.right_low, high: shown?.right_high },
      ]
    : [{ top: PAD.top, height: plotH, peaks: clip.overview, low: shown?.left_low, high: shown?.left_high }];
  const drawn = lanes.map((lane) =>
    shown && lane.low && lane.high
      ? drawDetail(shown, lane.low, lane.high, lane.top, lane.height)
      : { path: drawOverview(lane.peaks, lane.top, lane.height), dots: [] as Array<[number, number]> },
  );
  const wave = drawn.map((lane) => lane.path).join('');
  const dots = drawn.flatMap((lane) => lane.dots);

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

  const timeAt = (clientX: number): number | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const seconds = viewStart + ((clientX - rect.left - PAD.left) / plotW) * viewDuration;
    return Math.max(0, Math.min(clip.duration, seconds));
  };

  /** The wheel zooms around the pointer, plain or with Ctrl (a touchpad pinch is a Ctrl + wheel) */
  const handleWheel = (event: WheelEvent) => {
    if (!zoomable || event.deltaY === 0) return;
    // Taken: the page does not scroll, the browser does not zoom (the listener is not passive)
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_PAGE_PX : 1);
    const factor = Math.max(0.5, Math.min(2, WHEEL_NOTCH_ZOOM ** (-pixels / WHEEL_NOTCH_PX)));
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - PAD.left) / plotW));
    const anchorTime = viewStart + fraction * viewDuration;
    const nextZoom = Math.max(1, Math.min(maxZoom, zoom * factor));
    const nextDuration = clip.duration / nextZoom;
    const nextStart = Math.max(0, Math.min(clip.duration - nextDuration, anchorTime - fraction * nextDuration));
    setZoom(nextZoom);
    setViewStart(nextStart);
  };
  // React's wheel listeners are passive and cannot stop the page: a native one, calling the latest handler
  const wheelRef = useRef(handleWheel);
  wheelRef.current = handleWheel;
  const svgShown = width > 0;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svgShown || !svg) return undefined;
    const listener = (event: WheelEvent) => wheelRef.current(event);
    svg.addEventListener('wheel', listener, { passive: false });
    return () => svg.removeEventListener('wheel', listener);
  }, [svgShown]);

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (zoomable && event.button === 1) {
      event.preventDefault();
      svgRef.current?.setPointerCapture(event.pointerId);
      panPointer.current = { pointerId: event.pointerId, lastX: event.clientX };
      setPanning(true);
      return;
    }
    if (event.button !== 0) return;
    const pressed = timeAt(event.clientX);
    if (pressed === null) return;
    svgRef.current?.setPointerCapture(event.pointerId);
    setDragging(true);
    press.current = { x: event.clientX, time: pressed, selecting: false };
    onSeek(pressed);
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const pan = panPointer.current;
    if (pan?.pointerId === event.pointerId) {
      const deltaX = event.clientX - pan.lastX;
      pan.lastX = event.clientX;
      setViewStart((current) => Math.max(0, Math.min(clip.duration - viewDuration, current - (deltaX / plotW) * viewDuration)));
      return;
    }
    const pressed = press.current;
    if (!pressed) return;
    const now = timeAt(event.clientX);
    if (now === null) return;
    if (!onSelect) {
      onSeek(now);
      return;
    }
    if (!pressed.selecting && Math.abs(event.clientX - pressed.x) < SELECT_THRESHOLD_PX) return;
    pressed.selecting = true;
    // The cursor goes to the start of the zone
    const zone = { start: Math.min(pressed.time, now), end: Math.max(pressed.time, now) };
    onSelect(zone);
    onSeek(zone.start);
  };

  const finishPointer = (event: PointerEvent<SVGSVGElement>) => {
    // A click, not a drag: it removes the zone
    if (event.type === 'pointerup' && press.current && !press.current.selecting) onSelect?.(null);
    press.current = null;
    panPointer.current = null;
    setDragging(false);
    setPanning(false);
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === 'Escape' && selection) {
      onSelect?.(null);
      return;
    }
    const step = event.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, number> = { ArrowRight: step, ArrowLeft: -step, Home: -Infinity, End: Infinity };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    onSeek(Math.max(0, Math.min(clip.duration, (time ?? 0) + move)));
  };

  const tick = timeStep(viewDuration, plotW);
  const tickDecimals = tick >= 0.01 ? 2 : tick >= 0.001 ? 3 : 4;
  const firstTick = Math.ceil(viewStart / tick) * tick;
  const tickCount = Math.floor((viewEnd - firstTick) / tick) + 1;
  const cursor = time === null || time < viewStart || time > viewEnd ? null : x(time);
  const shownZone =
    selection && selection.end > viewStart && selection.start < viewEnd
      ? { left: x(Math.max(selection.start, viewStart)), right: x(Math.min(selection.end, viewEnd)) }
      : null;
  const zoomText = zoom < 10 ? zoom.toFixed(1).replace(/\.0$/, '') : String(Math.round(zoom));
  // The analysis window around the cursor, cut to the view: only without a zone, which is analyzed instead
  const analysisWindow =
    !selection && time !== null && windowSeconds && time + windowSeconds / 2 > viewStart && time - windowSeconds / 2 < viewEnd
      ? {
          left: x(Math.max(viewStart, time - windowSeconds / 2)),
          right: x(Math.min(viewEnd, time + windowSeconds / 2)),
          leftEdge: time - windowSeconds / 2 >= viewStart,
          rightEdge: time + windowSeconds / 2 <= viewEnd,
        }
      : null;
  const boundsY = PAD.top + 7;

  return (
    <div ref={boxRef} className={styles.box}>
      {zoomable && (
        <span className={styles.zoomIndicator} title={t('clipWaveform.zoomTitle')}>
          {t('clipWaveform.zoomIndicator', { zoom: zoomText })}
        </span>
      )}
      {width > 0 && (
        <svg
          ref={svgRef}
          width={width}
          height={height}
          className={styles.svg}
          data-dragging={dragging ? 'true' : undefined}
          data-panning={panning ? 'true' : undefined}
          tabIndex={0}
          role="slider"
          aria-label={label ?? t('clipWaveform.label')}
          aria-valuemin={0}
          aria-valuemax={Number(clip.duration.toFixed(2))}
          aria-valuenow={time === null ? undefined : Number(time.toFixed(2))}
          aria-valuetext={time === null ? t('clipWaveform.noMoment') : formatTime(time)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishPointer}
          onPointerCancel={finishPointer}
          onKeyDown={onKeyDown}
          aria-description={zoomable ? t('clipWaveform.zoomDescription', { zoom: zoomText }) : undefined}
        >
          <defs>
            <clipPath id={clipPathId}>
              <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} />
            </clipPath>
          </defs>
          <rect className={styles.plot} x={PAD.left} y={PAD.top} width={plotW} height={plotH} rx={6} />
          {shownZone && (
            <rect
              className={styles.selection}
              x={shownZone.left}
              y={PAD.top}
              width={Math.max(1, shownZone.right - shownZone.left)}
              height={plotH}
            />
          )}
          {stereo && (
            <line className={styles.channelDivider} x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH / 2} y2={PAD.top + plotH / 2} />
          )}
          {Array.from({ length: tickCount }, (_, i) => firstTick + i * tick).map((seconds) => (
            <g key={seconds}>
              <line className={styles.gridLine} x1={x(seconds)} x2={x(seconds)} y1={PAD.top} y2={PAD.top + plotH} />
              <text className={styles.tick} x={x(seconds)} y={PAD.top + plotH + 15} textAnchor="middle">
                {seconds < 60 ? `${Number(seconds.toFixed(tickDecimals))} s` : formatTime(seconds, tickDecimals)}
              </text>
            </g>
          ))}
          <g clipPath={`url(#${clipPathId})`}>
            <path className={samplesShown ? styles.waveLine : styles.wave} d={wave} />
            {dots.map(([cx, cy], i) => (
              <circle key={i} className={styles.sample} cx={cx} cy={cy} r={2} />
            ))}
          </g>
          {stereo && (
            <>
              <text className={styles.channelLabel} x={PAD.left + 4} y={PAD.top + plotH * 0.25 + 3}>L</text>
              <text className={styles.channelLabel} x={PAD.left + 4} y={PAD.top + plotH * 0.75 + 3}>R</text>
            </>
          )}

          {clear.map((point, n) => (
            <circle
              key={point.i}
              className={styles.notePoint}
              cx={x(((point.i + 0.5) / points) * clip.duration)}
              cy={noteY(semitones[n])}
              r={1.8}
              opacity={0.25 + 0.75 * point.clarity}
              style={{ display: (point.i + 0.5) / points * clip.duration < viewStart || (point.i + 0.5) / points * clip.duration > viewEnd ? 'none' : undefined }}
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

          {analysisWindow && (
            <g className={styles.analysisWindow}>
              <rect className={styles.analysisBand} x={analysisWindow.left} y={PAD.top} width={Math.max(1, analysisWindow.right - analysisWindow.left)} height={plotH} />
              <line x1={analysisWindow.left} x2={analysisWindow.right} y1={boundsY} y2={boundsY} />
              {analysisWindow.leftEdge && <line x1={analysisWindow.left} x2={analysisWindow.left} y1={boundsY - 5} y2={boundsY + 5} />}
              {analysisWindow.rightEdge && <line x1={analysisWindow.right} x2={analysisWindow.right} y1={boundsY - 5} y2={boundsY + 5} />}
              {cursor !== null && <line x1={cursor} x2={cursor} y1={boundsY - 3} y2={boundsY + 3} />}
            </g>
          )}

          {time !== null && cursor !== null && (
            <>
              <line className={styles.cursor} x1={cursor} x2={cursor} y1={PAD.top - 4} y2={PAD.top + plotH} />
              <text className={styles.cursorLabel} x={Math.min(PAD.left + plotW - 24, Math.max(PAD.left + 24, cursor))} y={PAD.top - 6} textAnchor="middle">
                {formatTime(time, tickDecimals)}
              </text>
            </>
          )}
        </svg>
      )}
    </div>
  );
}
