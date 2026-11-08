import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import type { TimbrePartial } from '../lib/instruments';
import { HUE_HEX } from '../lib/neon';
import { activePartials, formatRatio, MAX_RATIO, MIN_RATIO, waveformHarmonics } from '../lib/partials';
import { useElementSize } from '../lib/useElementSize';
import styles from './SpectrumGraph.module.css';

const PAD = { left: 38, right: 16, top: 24, bottom: 24 };
/** Distance, in pixels, under which a dragged partial snaps to a whole ratio */
const MAGNET_PX = 9;
/** Ratio steps for the axis labels, the first one leaving enough room is used */
const LABEL_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500];

/** Right end of the ratio axis: a little past the highest partial, at least ×8 */
function axisMax(partials: TimbrePartial[]): number {
  const highest = Math.max(0, ...partials.map((partial) => partial.ratio));
  return Math.min(MAX_RATIO, Math.max(8, Math.ceil(highest * 1.12 + 0.5)));
}

/**
 * Spectrum of an instrument: one bar per partial, at its ratio to the note
 * (horizontal) and its amplitude (vertical), in its colour. Bars are dragged
 * to move partials; the harmonics a non-sine waveform already contains are
 * drawn dotted, inactive partials faded. Visual only: the engine gets the
 * partials from the parent.
 */
export function SpectrumGraph({
  partials,
  selectedId,
  aliasing,
  magnet,
  locked,
  onSelect,
  onMove,
  onAdd,
}: {
  partials: TimbrePartial[];
  selectedId: string | null;
  /** Partials that go above half the sample rate on high notes */
  aliasing: Set<string>;
  magnet: boolean;
  /** The whole instrument is locked: a click only selects, nothing is moved or added */
  locked: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, ratio: number, amplitude: number) => void;
  onAdd: (ratio: number, amplitude: number) => void;
}) {
  const [boxRef, { width, height }] = useElementSize<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  // The axis keeps its scale while a bar is dragged, so the bar stays under the pointer
  const [drag, setDrag] = useState<{ id: string; xMax: number } | null>(null);

  const xMax = drag?.xMax ?? axisMax(partials);
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const unit = plotW / xMax; // pixels per ratio unit
  const x = (ratio: number) => PAD.left + ratio * unit;
  const y = (amplitude: number) => PAD.top + (1 - amplitude) * plotH;
  const bottom = y(0);

  /** Ratio and amplitude under the pointer, with the magnet towards whole ratios */
  const pointToPartial = (event: MouseEvent<SVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let ratio = Math.min(xMax, Math.max(MIN_RATIO, (px - PAD.left) / unit));
    const whole = Math.round(ratio);
    if (magnet && !event.altKey && whole >= 1 && Math.abs(whole - ratio) * unit <= MAGNET_PX) ratio = whole;
    const amplitude = Math.min(1, Math.max(0, 1 - (py - PAD.top) / plotH));
    return { ratio: Number(ratio.toFixed(3)), amplitude: Number(amplitude.toFixed(2)) };
  };

  const startDrag = (event: PointerEvent<SVGGElement>, partial: TimbrePartial) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelect(partial.id);
    if (locked || partial.locked) return;
    svgRef.current?.setPointerCapture(event.pointerId);
    setDrag({ id: partial.id, xMax });
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const { ratio, amplitude } = pointToPartial(event);
    onMove(drag.id, ratio, amplitude);
  };

  const endDrag = () => setDrag(null);

  const onKeyDown = (event: KeyboardEvent<SVGGElement>, partial: TimbrePartial) => {
    const big = event.shiftKey;
    const moves: Record<string, [number, number]> = {
      ArrowUp: [0, big ? 0.1 : 0.01],
      ArrowDown: [0, big ? -0.1 : -0.01],
      ArrowRight: [big ? 1 : 0.01, 0],
      ArrowLeft: [big ? -1 : -0.01, 0],
    };
    const move = moves[event.key];
    if (!move || locked || partial.locked) return;
    event.preventDefault();
    const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, Number((partial.ratio + move[0]).toFixed(3))));
    const amplitude = Math.min(1, Math.max(0, Number((partial.amplitude + move[1]).toFixed(2))));
    onMove(partial.id, ratio, amplitude);
  };

  // Axis labels every `step` ratio units, grid lines on every whole ratio while they stay apart
  const step = LABEL_STEPS.find((candidate) => candidate * unit >= 30) ?? 1000;
  const wholeLines = unit >= 7 ? Math.floor(xMax) : 0;
  const ordered = [...partials].sort((a, b) => (a.id === selectedId ? 1 : b.id === selectedId ? -1 : 0));
  const selected = partials.find((partial) => partial.id === selectedId);

  return (
    <div ref={boxRef} className={styles.box}>
      {width > 0 && (
        <svg
          ref={svgRef}
          width={width}
          height={height}
          className={styles.svg}
          data-dragging={drag ? 'true' : undefined}
          data-locked={locked ? 'true' : undefined}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={(event) => {
            if (locked) return;
            if (event.target === event.currentTarget || (event.target as Element).classList.contains(styles.plot)) {
              const { ratio, amplitude } = pointToPartial(event);
              onAdd(ratio, Math.max(0.05, amplitude));
            }
          }}
          role="group"
          aria-label={
            locked
              ? 'Spectre de l’instrument verrouillé : un clic choisit un partiel sans le déplacer'
              : 'Spectre de l’instrument : glisse un partiel pour changer son rapport et son amplitude'
          }
        >
          <rect className={styles.plot} x={PAD.left} y={PAD.top} width={plotW} height={plotH} />

          {/* Grid */}
          {[0.25, 0.5, 0.75, 1].map((level) => (
            <line key={level} className={styles.gridLine} x1={PAD.left} x2={PAD.left + plotW} y1={y(level)} y2={y(level)} />
          ))}
          {Array.from({ length: wholeLines }, (_, i) => i + 1).map((ratio) => (
            <line key={ratio} className={styles.harmonicLine} x1={x(ratio)} x2={x(ratio)} y1={PAD.top} y2={bottom} />
          ))}
          <line className={styles.axis} x1={PAD.left} x2={PAD.left + plotW} y1={bottom} y2={bottom} />
          {Array.from({ length: Math.floor(xMax / step) }, (_, i) => (i + 1) * step).map((ratio) => (
            <text key={ratio} className={styles.tick} x={x(ratio)} y={bottom + 15} textAnchor="middle">
              ×{ratio}
            </text>
          ))}
          {[0.5, 1].map((level) => (
            <text key={level} className={styles.tick} x={PAD.left - 6} y={y(level) + 3} textAnchor="end">
              {level * 100}%
            </text>
          ))}

          {/* Harmonics hidden in non-sine waveforms */}
          {activePartials(partials).map((partial) =>
            waveformHarmonics(partial.waveform, Math.floor(xMax / partial.ratio)).map(([multiple, relative]) => {
              const level = partial.amplitude * relative;
              if (level < 0.004) return null;
              return (
                <line
                  key={`${partial.id}-${multiple}`}
                  className={styles.hidden}
                  x1={x(partial.ratio * multiple)}
                  x2={x(partial.ratio * multiple)}
                  y1={bottom}
                  y2={y(level)}
                  stroke={HUE_HEX[partial.hue]}
                  opacity={partial.id === selectedId ? 0.75 : 0.4}
                />
              );
            }),
          )}

          {/* Partials, the selected one on top */}
          {ordered.map((partial) => {
            const px = x(partial.ratio);
            const py = y(partial.amplitude);
            const color = HUE_HEX[partial.hue];
            const isSelected = partial.id === selectedId;
            return (
              <g
                key={partial.id}
                className={styles.partial}
                data-selected={isSelected ? 'true' : undefined}
                data-muted={partial.muted ? 'true' : undefined}
                data-locked={partial.locked ? 'true' : undefined}
                tabIndex={0}
                role="button"
                aria-label={`Partiel ${partials.indexOf(partial) + 1}${partial.muted ? ' (inactif)' : ''}${partial.locked ? ' (verrouillé)' : ''} : rapport ${formatRatio(partial.ratio)}, amplitude ${Math.round(partial.amplitude * 100)} %`}
                aria-pressed={isSelected}
                onPointerDown={(event) => startDrag(event, partial)}
                onFocus={() => onSelect(partial.id)}
                onKeyDown={(event) => onKeyDown(event, partial)}
                style={{ color }}
              >
                <line className={styles.hit} x1={px} x2={px} y1={bottom} y2={py} />
                <line className={styles.bar} x1={px} x2={px} y1={bottom} y2={py} stroke={color} />
                {aliasing.has(partial.id) && <circle className={styles.alias} cx={px} cy={py} r={isSelected ? 12 : 10} />}
                <circle className={styles.handle} cx={px} cy={py} r={isSelected ? 7 : 5} fill={color} />
                {partial.locked && (
                  <g className={styles.lockMark} transform={`translate(${px + (isSelected ? 10 : 8)} ${py - 4})`}>
                    <path d="M1.5 4V2.6a2 2 0 0 1 4 0V4" />
                    <rect x={0} y={4} width={7} height={5.5} rx={1} />
                  </g>
                )}
              </g>
            );
          })}

          {selected && (
            <text
              className={styles.label}
              x={Math.min(PAD.left + plotW - 40, Math.max(PAD.left + 40, x(selected.ratio)))}
              y={y(selected.amplitude) < PAD.top + 14 ? y(selected.amplitude) + 24 : y(selected.amplitude) - 13}
              textAnchor="middle"
              fill={HUE_HEX[selected.hue]}
            >
              {formatRatio(selected.ratio)} · {Math.round(selected.amplitude * 100)} %
            </text>
          )}
        </svg>
      )}
    </div>
  );
}
