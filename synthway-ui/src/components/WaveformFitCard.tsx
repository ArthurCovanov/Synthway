import { selectClass } from './ui';
import { formatNumber, useI18n } from '../i18n';
import { HARMONIC_STATE, type WaveformFit } from '../types';
import {
  BUILD_FROM_OPTIONS,
  BUILD_FROM_SHAPE,
  chosenFit,
  describeShape,
  fitLevels,
  GAP_GOOD_DB,
  GAP_POOR_DB,
  SHAPE_HINTS,
  SHAPE_LABELS,
  type BuildFrom,
} from '../lib/waveShapes';
import styles from './WaveformFitCard.module.css';

/** Harmonics drawn, and the depth of the drawing in dB */
const CHART_HARMONICS = 32;
const CHART_RANGE_DB = 60;

function formatDb(db: number, digits = 1): string {
  const value = Number(db.toFixed(digits));
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatNumber(Math.abs(value), { maximumFractionDigits: digits })}`;
}

/** The harmonics measured as bars, the shape's levels as dots over them */
function HarmonicChart({ fit, model }: { fit: WaveformFit; model: number[] | null }) {
  const { t } = useI18n();
  const count = Math.min(fit.harmonics.length, CHART_HARMONICS);
  const width = 640;
  const height = 96;
  const step = width / count;
  const y = (db: number) => (Math.min(0, Math.max(-CHART_RANGE_DB, db)) / -CHART_RANGE_DB) * height;
  const points = model
    ? model
        .slice(0, count)
        .map((db, k) => (db > -CHART_RANGE_DB ? `${(k + 0.5) * step},${y(db)}` : null))
        .filter((point): point is string => point !== null)
    : [];
  return (
    <svg
      className={styles.chart}
      viewBox={`0 0 ${width} ${height + 14}`}
      role="img"
      aria-label={t('waveFit.chartLabel')}
    >
      {[-20, -40].map((db) => (
        <line key={db} x1={0} x2={width} y1={y(db)} y2={y(db)} className={styles.gridLine} />
      ))}
      {fit.harmonics.slice(0, count).map((harmonic, k) => (
        <g key={k}>
          <rect
            x={k * step + step * 0.18}
            width={step * 0.64}
            y={y(harmonic.level)}
            height={Math.max(1, height - y(harmonic.level))}
            className={styles.bar}
            data-state={harmonic.state}
          >
            <title>
              {`${t('waveFit.barTitle', {
                number: k + 1,
                level: formatDb(harmonic.level),
                background: formatDb(harmonic.background),
              })}${
                harmonic.state === HARMONIC_STATE.Shared
                  ? t('waveFit.barShared')
                  : harmonic.state === HARMONIC_STATE.Faint
                    ? t('waveFit.barFaint')
                    : ''
              }${model && model[k] > -CHART_RANGE_DB ? t('waveFit.barModel', { level: formatDb(model[k]) }) : ''}`}
            </title>
          </rect>
          {(k === 0 || (k + 1) % 4 === 0) && (
            <text x={(k + 0.5) * step} y={height + 11} className={styles.axis}>
              {k + 1}
            </text>
          )}
        </g>
      ))}
      {points.length > 1 && <polyline points={points.join(' ')} className={styles.modelLine} />}
      {points.map((point) => {
        const [cx, cy] = point.split(',').map(Number);
        return <circle key={point} cx={cx} cy={cy} r={2.6} className={styles.modelDot} />;
      })}
    </svg>
  );
}

/**
 * Which waveform the note analyzed is closest to (synthway_analyzer_fit_waveform),
 * and what the trial instrument is made of: the partials measured, the closest
 * shape, or a shape chosen here.
 */
export function WaveformFitCard({
  fit,
  loading,
  error,
  noteName,
  weakNote,
  buildFrom,
  onBuildFrom,
}: {
  fit: WaveformFit | null;
  loading: boolean;
  error: string | null;
  /** Name of a frequency (« La5 ») */
  noteName: (frequency: number) => string;
  /** The note measured is a weak one of the zone: its strength, and the strong notes' names */
  weakNote: { strength: number; strong: string[] } | null;
  buildFrom: BuildFrom;
  onBuildFrom: (value: BuildFrom) => void;
}) {
  const { t, formatNumber } = useI18n();
  const best = fit?.fits[0] ?? null;
  const shown = chosenFit(fit, buildFrom === 'measured' ? 'auto' : buildFrom);
  const model = fit && shown ? fitLevels(fit, shown) : null;
  const shared = fit ? fit.harmonics.filter((harmonic) => harmonic.state === HARMONIC_STATE.Shared).length : 0;
  const quality = best === null ? null : best.error_db < GAP_GOOD_DB ? 'good' : best.error_db < GAP_POOR_DB ? 'fair' : 'poor';

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.title}>{t('waveFit.title')}</span>
        {fit && fit.frequency > 0 && fit.moments > 0 && (
          <span className={styles.meta}>
            {noteName(fit.frequency)} · {t('waveFit.moments', { count: fit.moments })} ·{' '}
            {t('waveFit.harmonics', { count: fit.harmonics.length })}
            {shared > 0 ? ` (${t('waveFit.shared', { count: shared })})` : ''}
          </span>
        )}
        {loading && <span className={styles.meta}>{t('waveFit.measuring')}</span>}
        <label className={styles.buildFrom}>
          <span>{t('waveFit.buildFrom')}</span>
          <select
            className={selectClass}
            value={buildFrom}
            onChange={(event) => onBuildFrom(event.target.value as BuildFrom)}
            title={t('waveFit.buildFromTitle')}
          >
            {BUILD_FROM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <p className={styles.warning}>{error}</p>
      ) : !fit ? (
        !loading && <p className={styles.note}>{t('waveFit.empty')}</p>
      ) : fit.frequency <= 0 ? (
        <p className={styles.note}>{t('waveFit.noNote')}</p>
      ) : fit.moments === 0 || fit.fits.length === 0 ? (
        <p className={styles.warning}>{t('waveFit.neverAlone', { note: noteName(fit.frequency) })}</p>
      ) : (
        <>
          {weakNote && (
            <p className={styles.warning}>
              {weakNote.strong.length
                ? t('waveFit.weakNoteStrong', {
                    note: noteName(fit.frequency),
                    percent: Math.round(weakNote.strength * 100),
                    notes: weakNote.strong.join(', '),
                  })
                : t('waveFit.weakNote', { note: noteName(fit.frequency), percent: Math.round(weakNote.strength * 100) })}
            </p>
          )}
          <div className={styles.fits}>
            {fit.fits.map((candidate, index) => {
              const value = (Object.keys(BUILD_FROM_SHAPE) as (keyof typeof BUILD_FROM_SHAPE)[]).find(
                (key) => BUILD_FROM_SHAPE[key] === candidate.shape,
              );
              const selected =
                buildFrom !== 'measured' && (buildFrom === 'auto' ? index === 0 : value === buildFrom);
              return (
                <button
                  key={candidate.shape}
                  type="button"
                  className={styles.fit}
                  data-best={index === 0 ? 'true' : undefined}
                  aria-pressed={selected}
                  onClick={() => value && onBuildFrom(value)}
                  title={t(candidate.cutoff > 0 ? 'waveFit.fitTitleLowpass' : 'waveFit.fitTitle', {
                    shape: SHAPE_LABELS[candidate.shape],
                    hint: SHAPE_HINTS[candidate.shape],
                    gap: formatNumber(candidate.error_db, { maximumFractionDigits: 1 }),
                  })}
                >
                  <span className={styles.fitName}>{describeShape(candidate)}</span>
                  <span className={styles.fitGap}>
                    {formatNumber(candidate.error_db, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} dB
                  </span>
                </button>
              );
            })}
          </div>
          <p className={styles.descriptors}>
            <span>
              {t('waveFit.evenHarmonics', {
                value:
                  fit.even_count === 0
                    ? t('waveFit.evenUnmeasurable')
                    : fit.even_db > -6
                      ? t('waveFit.evenPresent', { db: formatDb(fit.even_db) })
                      : fit.even_db > -20
                        ? t('waveFit.evenWeakened', { db: formatDb(fit.even_db) })
                        : t('waveFit.evenAbsent', { db: formatDb(fit.even_db, 0) }),
              })}
            </span>
            <span>{t('waveFit.slope', { db: formatDb(fit.slope) })}</span>
          </p>
          <HarmonicChart fit={fit} model={model} />
          <p className={styles.legend}>
            {t('waveFit.legend', { shape: shown ? describeShape(shown) : t('waveFit.legendShape') })}
          </p>
          {quality === 'poor' ? (
            <p className={styles.warning}>
              {t('waveFit.poor', { gap: formatNumber(best?.error_db ?? 0, { maximumFractionDigits: 1 }) })}
            </p>
          ) : quality === 'fair' ? (
            <p className={styles.note}>{t('waveFit.fair')}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
