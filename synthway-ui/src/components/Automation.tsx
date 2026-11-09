/**
 * The Composer's automation: a card under the tracks (which setting of the selected track is
 * edited, mono or stereo, the value of the selected point) and a lane under the piano roll, on the
 * same time axis, where its curve is drawn and edited. Black and orange-yellow neon, apart from the notes.
 */
import { Trash2 } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type WheelEvent,
} from 'react';
import { useI18n, type MessageKey } from '../i18n';
import {
  AUTOMATION_SPECS,
  automationSpec,
  clampValue,
  fromUnit,
  isStereo,
  MAX_AUTOMATION_POINTS,
  toUnit,
  valueAt,
  withUnit,
  type AutomationSpec,
  type LaneSide,
} from '../lib/automation';
import type { AutomationLane, AutomationParam, AutomationPoint, Track } from '../lib/composition';
import { newGroup, type ChangeOptions } from '../lib/history';
import { cx } from './ui';
import styles from './Automation.module.css';

/** The point selected: its side and its index among that side's points */
export interface AutomationSelection {
  side: LaneSide;
  index: number;
}

/** Changes the lane of the edited setting (undefined: removes it, the instrument's setting comes back) */
export type LaneChange = (lane: AutomationLane | undefined, options: ChangeOptions) => void;

const SIDE_COLOR: Record<LaneSide, string> = { left: 'var(--neon-orange)', right: 'var(--neon-yellow)' };
/** Texts of each side: its name, and its initial (L or R) */
const SIDE_NAME: Record<LaneSide, MessageKey> = { left: 'automation.sideName.left', right: 'automation.sideName.right' };
const SIDE_SHORT: Record<LaneSide, MessageKey> = { left: 'automation.sideShort.left', right: 'automation.sideShort.right' };

const sidePoints = (lane: AutomationLane | undefined, side: LaneSide) =>
  (side === 'right' ? lane?.right : lane?.points) ?? [];

/** The lane with one side's points replaced */
const withSide = (lane: AutomationLane, side: LaneSide, points: AutomationPoint[]): AutomationLane =>
  side === 'right' ? { ...lane, right: points } : { ...lane, points };

/** The selected point, when it still exists (an undo can take it away) */
export function selectedPoint(lane: AutomationLane | undefined, selection: AutomationSelection | null) {
  if (!lane || !selection || (selection.side === 'right' && !lane.right)) return null;
  return sidePoints(lane, selection.side)[selection.index] ?? null;
}

/** A value rounded to what the point's field shows, so that a drag never leaves 0.30000000000000004 */
function rounded(spec: AutomationSpec, value: number): number {
  const factor = 10 ** spec.inputDecimals;
  return clampValue(spec, spec.fromInput(Math.round(spec.toInput(value) * factor) / factor));
}

/** The lane without a point; removing a curve's last point removes the whole setting's curve */
function withoutPoint(lane: AutomationLane, side: LaneSide, index: number): AutomationLane | undefined {
  const points = sidePoints(lane, side).filter((_, i) => i !== index);
  if (points.length === 0) return undefined;
  return withSide(lane, side, points);
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function AutomationCard({
  track,
  hue,
  param,
  onParamChange,
  base,
  unisonVoices,
  locked,
  selection,
  onSelect,
  onLaneChange,
  stepLabel,
}: {
  track: Track;
  /** CSS colour of the track */
  hue: string;
  param: AutomationParam;
  onParamChange: (param: AutomationParam) => void;
  /** The instrument's own value of the setting */
  base: number;
  /** Voices of the instrument's unison: the detune is only heard with 2 or more */
  unisonVoices: number;
  locked: boolean;
  selection: AutomationSelection | null;
  onSelect: (selection: AutomationSelection | null) => void;
  onLaneChange: LaneChange;
  stepLabel: (step: number) => string;
}) {
  const { t, formatNumber } = useI18n();
  const spec = automationSpec(param);
  const lane = track.automation?.[param];
  const stereo = isStereo(spec, lane);
  const point = selectedPoint(stereo ? lane : lane && { points: lane.points }, selection);

  // The field shows the point's value; what is typed waits for Enter or for the focus to leave
  const shown = point ? Number(spec.toInput(point.value).toFixed(spec.inputDecimals)) : null;
  const [draft, setDraft] = useState('');
  useEffect(() => {
    setDraft(shown === null ? '' : formatNumber(shown, { maximumFractionDigits: spec.inputDecimals, useGrouping: false }));
  }, [shown, spec.inputDecimals, formatNumber]);

  const commit = () => {
    if (!lane || !selection || !point || locked) return;
    const typed = Number(draft.replace(',', '.').replace(/\s/g, ''));
    if (draft.trim() === '' || !Number.isFinite(typed)) {
      setDraft(String(shown ?? ''));
      return;
    }
    const value = clampValue(spec, spec.fromInput(typed));
    if (value === point.value) {
      setDraft(String(shown ?? ''));
      return;
    }
    const points = sidePoints(lane, selection.side).map((item, i) => (i === selection.index ? { ...item, value } : item));
    onLaneChange(withSide(lane, selection.side, points), { label: t('automation.undo.setValue') });
  };

  const setStereo = (wanted: boolean) => {
    if (!lane || wanted === stereo || locked) return;
    if (wanted) {
      // The right side starts as a copy of the left one
      onLaneChange({ points: lane.points, right: lane.points.map((item) => ({ ...item })) }, { label: t('automation.undo.stereo') });
    } else {
      onLaneChange({ points: lane.points }, { label: t('automation.undo.mono') });
      if (selection?.side === 'right') onSelect(null);
    }
  };

  const hint = locked
    ? t('automation.hint.locked')
    : param === 'detune' && unisonVoices < 2
      ? t('automation.hint.noUnison')
      : lane
        ? t('automation.hint.selectPoint')
        : t('automation.hint.addPoint', { value: spec.format(base) });

  return (
    <div className={cx(styles.card, locked && styles.cardLocked)} style={{ '--hue': hue } as CSSProperties}>
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>{t('automation.title')}</span>
        <span className={styles.cardTrack} title={t('automation.selectedTrack', { name: track.name })}>
          <span className={styles.dot} />
          <span className={styles.cardTrackName}>{track.name}</span>
        </span>
      </div>

      <select
        className={styles.select}
        aria-label={t('automation.param')}
        title={t('automation.paramTitle')}
        value={param}
        onChange={(event) => {
          onParamChange(event.target.value as AutomationParam);
          onSelect(null);
        }}
      >
        {AUTOMATION_SPECS.map((item) => (
          <option key={item.id} value={item.id}>
            {track.automation?.[item.id] ? '● ' : ''}
            {item.label}
          </option>
        ))}
      </select>

      <div className={styles.row}>
        <div className={styles.segmented} role="group" aria-label={t('automation.monoOrStereo')}>
          {([false, true] as const).map((wanted) => (
            <button
              key={String(wanted)}
              type="button"
              className={styles.segment}
              aria-pressed={stereo === wanted}
              disabled={locked || !lane || !spec.stereo}
              title={
                !spec.stereo
                  ? t('automation.monoOnly', { param: spec.label })
                  : wanted
                    ? t('automation.stereoTitle')
                    : t('automation.monoTitle')
              }
              onClick={() => setStereo(wanted)}
            >
              {wanted ? t('automation.stereo') : t('automation.mono')}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={t('automation.clear')}
          title={t('automation.clearTitle', { param: spec.label.toLowerCase(), value: spec.format(base) })}
          disabled={locked || !lane}
          onClick={() => {
            onLaneChange(undefined, { label: t('automation.undo.clear') });
            onSelect(null);
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className={styles.point}>
        {point && selection ? (
          <>
            <span className={styles.pointWhere} title={t('automation.pointWhere')}>
              {stereo ? `${t(SIDE_SHORT[selection.side])} · ` : ''}
              {stepLabel(Math.floor(point.at))}
              {point.at % 1 ? `+${Math.round((point.at % 1) * 100)}%` : ''}
            </span>
            <input
              className={styles.input}
              inputMode="decimal"
              aria-label={t('automation.pointValue', { help: spec.help })}
              title={t('automation.pointRange', {
                min: spec.toInput(spec.min),
                max: withUnit(spec.toInput(spec.max), spec.unit),
              })}
              value={draft}
              disabled={locked}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commit();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setDraft(String(shown ?? ''));
                  event.currentTarget.blur();
                }
              }}
            />
            <span className={cx(styles.unit, spec.unitLines && styles.unitLines)} title={spec.help}>
              {spec.unitLines ? spec.unitLines.map((line) => <span key={line}>{line}</span>) : spec.unit}
            </span>
          </>
        ) : (
          <span className={styles.hint}>{hint}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lane
// ---------------------------------------------------------------------------

/** Space above and below the curve, in px */
const PAD = 9;

interface PointDrag {
  pointerId: number;
  side: LaneSide;
  index: number;
  x: number;
  y: number;
  moved: boolean;
  group: string;
}

export function AutomationLaneView({
  track,
  param,
  base,
  locked,
  cell,
  totalSteps,
  stepsPerBar,
  stepsPerBeat,
  playStep,
  loop,
  rollScrollRef,
  selection,
  onSelect,
  onLaneChange,
  stepLabel,
}: {
  track: Track;
  param: AutomationParam;
  /** The instrument's own value of the setting: where the line stays without a curve, where a new curve starts */
  base: number;
  locked: boolean;
  /** Px per step, as in the piano roll */
  cell: number;
  totalSteps: number;
  stepsPerBar: number;
  stepsPerBeat: number;
  playStep: number;
  loop: { start: number; end: number } | null;
  /** The piano roll's scroller: the lane follows its horizontal scroll */
  rollScrollRef: RefObject<HTMLDivElement | null>;
  selection: AutomationSelection | null;
  onSelect: (selection: AutomationSelection | null) => void;
  onLaneChange: LaneChange;
  stepLabel: (step: number) => string;
}) {
  const { t } = useI18n();
  const spec = automationSpec(param);
  const lane = track.automation?.[param];
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<PointDrag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [height, setHeight] = useState(120);
  /** Step under the pointer, for the readout */
  const [hover, setHover] = useState<number | null>(null);
  const width = Math.max(1, totalSteps * cell);

  // Follows the piano roll's horizontal scroll, without rendering again
  useLayoutEffect(() => {
    const roll = rollScrollRef.current;
    const content = contentRef.current;
    if (!roll || !content) return undefined;
    const sync = () => {
      content.style.transform = `translateX(${-roll.scrollLeft}px)`;
    };
    sync();
    roll.addEventListener('scroll', sync, { passive: true });
    return () => roll.removeEventListener('scroll', sync);
  }, [rollScrollRef, cell, totalSteps]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const observer = new ResizeObserver(() => setHeight(Math.max(40, viewport.clientHeight)));
    observer.observe(viewport);
    setHeight(Math.max(40, viewport.clientHeight));
    return () => observer.disconnect();
  }, []);

  const yOf = (value: number) => PAD + (1 - toUnit(spec, value)) * (height - 2 * PAD);
  const xOf = (at: number) => at * cell;

  /** Step and value under the pointer; free (hundredths of a step) with Shift, else whole steps */
  const pointerAt = (clientX: number, clientY: number, free: boolean) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return { at: 0, value: base };
    const raw = Math.min(totalSteps, Math.max(0, (clientX - box.left) / cell));
    const at = free ? Math.round(raw * 100) / 100 : Math.round(raw);
    const unit = 1 - (clientY - box.top - PAD) / (height - 2 * PAD);
    return { at, value: rounded(spec, fromUnit(spec, unit)) };
  };

  const stereo = isStereo(spec, lane);
  const sides: LaneSide[] = stereo ? ['left', 'right'] : lane ? ['left'] : [];

  /** The side whose curve passes closest to y at this step */
  const nearestSide = (at: number, y: number): LaneSide => {
    if (!lane || !stereo) return 'left';
    const distance = (side: LaneSide) => Math.abs(yOf(valueAt(spec, sidePoints(lane, side), at)) - y);
    return distance('right') < distance('left') ? 'right' : 'left';
  };

  const addPoint = (clientX: number, clientY: number, free: boolean) => {
    if (locked) return;
    const { at, value } = pointerAt(clientX, clientY, free);
    if (!lane) {
      // A new curve starts at the instrument's own value, at the score's start
      const points = at > 0 ? [{ at: 0, value: rounded(spec, base) }, { at, value }] : [{ at: 0, value }];
      onLaneChange({ points }, { label: t('automation.undo.addCurve', { param: spec.label.toLowerCase() }) });
      onSelect({ side: 'left', index: points.length - 1 });
      return;
    }
    const box = svgRef.current?.getBoundingClientRect();
    const side = nearestSide(at, box ? clientY - box.top : 0);
    const points = sidePoints(lane, side);
    if (points.length >= MAX_AUTOMATION_POINTS) return;
    // After the points at the same step: a second point there makes a jump
    const after = points.findIndex((point) => point.at > at);
    const index = after < 0 ? points.length : after;
    const next = [...points.slice(0, index), { at, value }, ...points.slice(index)];
    onLaneChange(withSide(lane, side, next), { label: t('automation.undo.addPoint') });
    onSelect({ side, index });
  };

  const removePoint = (side: LaneSide, index: number) => {
    if (!lane || locked) return;
    onLaneChange(withoutPoint(lane, side, index), { label: t('automation.undo.removePoint') });
    onSelect(null);
  };

  const onHandlePointerDown = (event: PointerEvent<SVGCircleElement>, side: LaneSide, index: number) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    svgRef.current?.focus({ preventScroll: true });
    onSelect({ side, index });
    if (locked) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, side, index, x: event.clientX, y: event.clientY, moved: false, group: newGroup('automation') };
  };

  const onHandlePointerMove = (event: PointerEvent<SVGCircleElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !lane) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
    if (!drag.moved) {
      drag.moved = true;
      setDragging(true);
    }
    const points = sidePoints(lane, drag.side);
    const { at, value } = pointerAt(event.clientX, event.clientY, event.shiftKey);
    // Between its neighbours: the points stay in order
    const low = drag.index > 0 ? points[drag.index - 1].at : 0;
    const high = drag.index < points.length - 1 ? points[drag.index + 1].at : totalSteps;
    const moved = { at: Math.min(high, Math.max(low, at)), value };
    const current = points[drag.index];
    if (!current || (current.at === moved.at && current.value === moved.value)) return;
    const next = points.map((point, i) => (i === drag.index ? moved : point));
    onLaneChange(withSide(lane, drag.side, next), { label: t('automation.undo.movePoint'), group: drag.group });
  };

  const onHandlePointerUp = (event: PointerEvent<SVGCircleElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!selection) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removePoint(selection.side, selection.index);
    } else if (event.key === 'Escape') {
      onSelect(null);
    }
  };

  // The vertical wheel scrolls the piano roll sideways (the lane has nothing to scroll up and down)
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const roll = rollScrollRef.current;
    if (!roll || event.ctrlKey) return;
    roll.scrollLeft += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  };

  /** A curve's line, held at its first value from the score's start and at its last to the end */
  const curvePath = (points: AutomationPoint[]) => {
    if (points.length === 0) return '';
    const coords = [
      [0, yOf(points[0].value)],
      ...points.map((point) => [xOf(point.at), yOf(point.value)]),
      [width, yOf(points[points.length - 1].value)],
    ];
    // Cutoffs are drawn on a logarithmic scale, where the engine's ramps are straight lines
    return coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  };

  const beatLines = [];
  for (let step = 0; step <= totalSteps; step += stepsPerBeat) {
    beatLines.push(
      <line
        key={step}
        x1={xOf(step)}
        x2={xOf(step)}
        y1={0}
        y2={height}
        stroke={step % stepsPerBar === 0 ? 'rgba(255, 155, 47, 0.22)' : 'rgba(255, 155, 47, 0.07)'}
      />,
    );
  }

  const readout =
    hover === null
      ? null
      : `${stepLabel(Math.min(totalSteps - 1, Math.floor(hover)))} · ${
          lane
            ? sides
                .map((side) => `${stereo ? `${t(SIDE_SHORT[side])} ` : ''}${spec.format(valueAt(spec, sidePoints(lane, side), hover))}`)
                .join('  ')
            : spec.format(base)
        }`;

  return (
    <div className={styles.lane}>
      <div className={styles.gutter} aria-hidden="true">
        <span>{spec.id === 'pan' ? t(SIDE_SHORT.right) : spec.format(spec.max)}</span>
        <span className={styles.gutterName}>{spec.label}</span>
        <span>{spec.id === 'pan' ? t(SIDE_SHORT.left) : spec.format(spec.min)}</span>
      </div>
      <div className={styles.viewport} ref={viewportRef} onWheel={onWheel}>
        <div className={styles.content} ref={contentRef} style={{ width }}>
          <svg
            ref={svgRef}
            className={cx(styles.svg, locked && styles.svgLocked)}
            width={width}
            height={height}
            tabIndex={0}
            role="application"
            aria-label={t('automation.laneLabel', { param: spec.label, track: track.name })}
            onKeyDown={onKeyDown}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.focus({ preventScroll: true });
              onSelect(null);
            }}
            onDoubleClick={(event) => addPoint(event.clientX, event.clientY, event.shiftKey)}
            onPointerMove={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setHover(Math.min(totalSteps, Math.max(0, (event.clientX - box.left) / cell)));
            }}
            onPointerLeave={() => setHover(null)}
          >
            {loop && (
              <rect x={xOf(loop.start)} y={0} width={xOf(loop.end - loop.start)} height={height} fill="rgba(255, 26, 168, 0.08)" />
            )}
            {beatLines}
            <line x1={0} x2={width} y1={yOf(base)} y2={yOf(base)} stroke="rgba(255, 155, 47, 0.35)" strokeDasharray="5 6" />
            {sides.map((side) => {
              const points = sidePoints(lane, side);
              const d = curvePath(points);
              const color = SIDE_COLOR[side];
              return (
                <g key={side}>
                  {!stereo && <path d={`${d} L${width} ${height} L0 ${height} Z`} fill={color} opacity={0.07} />}
                  <path d={d} fill="none" stroke={color} strokeWidth={7} opacity={0.2} strokeLinejoin="round" />
                  <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
                  {points.map((point, index) => {
                    const chosen = selection?.side === side && selection.index === index;
                    return (
                      <circle
                        key={index}
                        className={cx(styles.handle, dragging && chosen && styles.handleDragging)}
                        cx={xOf(point.at)}
                        cy={yOf(point.value)}
                        r={chosen ? 6 : 4.5}
                        fill={chosen ? color : '#000'}
                        stroke={color}
                        strokeWidth={2}
                        onPointerDown={(event) => onHandlePointerDown(event, side, index)}
                        onPointerMove={onHandlePointerMove}
                        onPointerUp={onHandlePointerUp}
                        onPointerCancel={onHandlePointerUp}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          removePoint(side, index);
                        }}
                      >
                        <title>
                          {`${stereo ? `${t(SIDE_NAME[side])} · ` : ''}${stepLabel(Math.floor(point.at))} · ${spec.format(point.value)}`}
                          {locked ? '' : `\n${t('automation.pointHelp')}`}
                        </title>
                      </circle>
                    );
                  })}
                </g>
              );
            })}
            <line x1={xOf(playStep)} x2={xOf(playStep)} y1={0} y2={height} stroke="#fff6e8" strokeWidth={1.5} opacity={0.75} />
          </svg>
        </div>
        {readout && <span className={styles.readout}>{readout}</span>}
        {!lane && !locked && (
          <span className={styles.empty}>{t('automation.emptyLane', { param: spec.label, value: spec.format(base) })}</span>
        )}
      </div>
    </div>
  );
}
