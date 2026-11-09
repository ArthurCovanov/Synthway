import { useI18n } from '../i18n';
import { HUE_HEX, PARTIAL_HUES } from '../lib/neon';
import { useElementSize } from '../lib/useElementSize';
import type { Analysis } from '../types';
import styles from './AnalysisSpectrum.module.css';

const PAD = { left: 40, right: 14, top: 22, bottom: 24 };
/** Vertical range, in dBFS */
const TOP_DB = 0;
const BOTTOM_DB = -100;
const FREQUENCY_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const DB_TICKS = [-20, -40, -60, -80];
/** Partials labelled with their ratio, the strongest first, at least LABEL_GAP pixels apart */
const LABELLED_PARTIALS = 12;
const LABEL_GAP = 34;

/** Colour of the partial at this place in the list, as in the partials table */
export function partialColor(index: number): string {
  return HUE_HEX[PARTIAL_HUES[index % PARTIAL_HUES.length]];
}

function formatHz(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

/**
 * The spectrum measured by the analyzer, on a logarithmic frequency scale:
 * the partials found are marked in their colour (ratio to the note above the
 * strongest ones), the harmonics of the note dotted. With a noise gate, what
 * lies under its line is shaded: the analyzer ignores it.
 */
export function AnalysisSpectrum({ analysis, noiseGateDb }: { analysis: Analysis | null; noiseGateDb?: number }) {
  const { t } = useI18n();
  const [boxRef, { width, height }] = useElementSize<HTMLDivElement>();
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const minHz = analysis?.spectrum_min_hz ?? 20;
  const maxHz = analysis?.spectrum_max_hz ?? 20000;
  const span = Math.log(maxHz / minHz);
  const x = (hz: number) => PAD.left + (Math.log(hz / minHz) / span) * plotW;
  const y = (db: number) => PAD.top + ((TOP_DB - Math.max(BOTTOM_DB, Math.min(TOP_DB, db))) / (TOP_DB - BOTTOM_DB)) * plotH;
  const bottom = PAD.top + plotH;

  const points = analysis?.spectrum_db ?? [];
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;
  const line = points.map((db, i) => `${i === 0 ? 'M' : 'L'}${(PAD.left + i * step).toFixed(1)} ${y(db).toFixed(1)}`).join('');
  const area = points.length ? `${line}L${PAD.left + plotW} ${bottom}L${PAD.left} ${bottom}Z` : '';

  /** Spectrum level at a frequency, between its two nearest points */
  const levelAt = (hz: number) => {
    if (!points.length) return BOTTOM_DB;
    const position = Math.max(0, Math.min(points.length - 1, (Math.log(hz / minHz) / span) * (points.length - 1)));
    const i = Math.floor(position);
    const next = points[Math.min(points.length - 1, i + 1)];
    return points[i] + (next - points[i]) * (position - i);
  };

  const fundamental = analysis?.frequency ?? 0;
  const harmonics: number[] = [];
  if (fundamental > 0) {
    for (let n = 1; n * fundamental <= maxHz && harmonics.length < 64; n += 1) {
      const hz = n * fundamental;
      if (hz >= minHz && (n === 1 || x(hz) - x((n - 1) * fundamental) >= 5)) harmonics.push(hz);
    }
  }

  const partials = analysis?.partials ?? [];
  const labelled = new Set<number>();
  const labelX: number[] = [];
  for (const { index } of partials
    .map((partial, i) => ({ index: i, amplitude: partial.amplitude }))
    .sort((a, b) => b.amplitude - a.amplitude)) {
    if (labelled.size === LABELLED_PARTIALS) break;
    const px = x(partials[index].frequency);
    if (labelX.every((placed) => Math.abs(placed - px) >= LABEL_GAP)) {
      labelled.add(index);
      labelX.push(px);
    }
  }

  return (
    <div ref={boxRef} className={styles.box}>
      {width > 0 && (
        <svg width={width} height={height} className={styles.svg} role="img" aria-label={t('analyzer.spectrumChart.label')}>
          <defs>
            <linearGradient id="analysis-spectrum-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#a31cff" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#2e4dff" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {DB_TICKS.map((db) => (
            <g key={db}>
              <line className={styles.gridLine} x1={PAD.left} x2={PAD.left + plotW} y1={y(db)} y2={y(db)} />
              <text className={styles.tick} x={PAD.left - 6} y={y(db) + 3} textAnchor="end">
                {db}
              </text>
            </g>
          ))}
          {FREQUENCY_TICKS.filter((hz) => hz >= minHz && hz <= maxHz).map((hz) => (
            <g key={hz}>
              <line className={styles.gridLine} x1={x(hz)} x2={x(hz)} y1={PAD.top} y2={bottom} />
              <text className={styles.tick} x={x(hz)} y={bottom + 15} textAnchor="middle">
                {formatHz(hz)}
              </text>
            </g>
          ))}
          <text className={styles.unit} x={PAD.left - 6} y={PAD.top - 8} textAnchor="end">
            dB
          </text>
          <text className={styles.unit} x={PAD.left + plotW} y={PAD.top - 8} textAnchor="end">
            Hz
          </text>

          {harmonics.map((hz) => (
            <line key={hz} className={styles.harmonic} x1={x(hz)} x2={x(hz)} y1={PAD.top} y2={bottom} />
          ))}

          {area && <path className={styles.area} d={area} />}
          {line && <path className={styles.line} d={line} />}

          {noiseGateDb !== undefined && noiseGateDb > BOTTOM_DB && (
            <g>
              <rect className={styles.gated} x={PAD.left} y={y(noiseGateDb)} width={plotW} height={bottom - y(noiseGateDb)} />
              <line className={styles.gateLine} x1={PAD.left} x2={PAD.left + plotW} y1={y(noiseGateDb)} y2={y(noiseGateDb)} />
              <text className={styles.gateLabel} x={PAD.left + plotW - 4} y={y(noiseGateDb) - 5} textAnchor="end">
                {t('analyzer.spectrumChart.gate', {
                  level: noiseGateDb < -0.05 ? `−${Number((-noiseGateDb).toFixed(1))}` : '0',
                })}
              </text>
            </g>
          )}

          {partials.map((partial, index) => {
            const px = x(partial.frequency);
            const py = y(levelAt(partial.frequency));
            const color = partialColor(index);
            return (
              <g key={index} style={{ color }}>
                <line className={styles.partialLine} x1={px} x2={px} y1={bottom} y2={py} stroke={color} />
                <circle className={styles.partialDot} cx={px} cy={py} r={3.5} fill={color} />
                {labelled.has(index) && partial.ratio > 0 && (
                  <text className={styles.partialLabel} x={px} y={Math.max(PAD.top + 8, py - 8)} textAnchor="middle" fill={color}>
                    ×{partial.ratio < 10 ? partial.ratio.toFixed(2) : partial.ratio.toFixed(1)}
                  </text>
                )}
              </g>
            );
          })}

          {!analysis && (
            <text className={styles.empty} x={PAD.left + plotW / 2} y={PAD.top + plotH / 2} textAnchor="middle">
              {t('analyzer.spectrumChart.empty')}
            </text>
          )}
        </svg>
      )}
    </div>
  );
}
