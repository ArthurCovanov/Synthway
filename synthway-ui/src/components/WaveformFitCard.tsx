import { selectClass } from './ui';
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
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toLocaleString('fr-FR', { maximumFractionDigits: digits })}`;
}

/** The harmonics measured as bars, the shape's levels as dots over them */
function HarmonicChart({ fit, model }: { fit: WaveformFit; model: number[] | null }) {
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
      aria-label="Niveau de chaque harmonique mesurée, et celui de la forme choisie"
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
              {`Harmonique ${k + 1} : ${formatDb(harmonic.level)} dB (fond ${formatDb(harmonic.background)} dB)${
                harmonic.state === HARMONIC_STATE.Shared
                  ? ', partagée avec une autre note : écartée'
                  : harmonic.state === HARMONIC_STATE.Faint
                    ? ', pas au-dessus du fond'
                    : ''
              }${model && model[k] > -CHART_RANGE_DB ? ` ; la forme : ${formatDb(model[k])} dB` : ''}`}
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
  const best = fit?.fits[0] ?? null;
  const shown = chosenFit(fit, buildFrom === 'measured' ? 'auto' : buildFrom);
  const model = fit && shown ? fitLevels(fit, shown) : null;
  const shared = fit ? fit.harmonics.filter((harmonic) => harmonic.state === HARMONIC_STATE.Shared).length : 0;
  const quality = best === null ? null : best.error_db < GAP_GOOD_DB ? 'good' : best.error_db < GAP_POOR_DB ? 'fair' : 'poor';

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.title}>Forme d’onde</span>
        {fit && fit.frequency > 0 && fit.moments > 0 && (
          <span className={styles.meta}>
            {noteName(fit.frequency)} · {fit.moments} moment{fit.moments > 1 ? 's' : ''} · {fit.harmonics.length} harmonique
            {fit.harmonics.length > 1 ? 's' : ''}
            {shared > 0 ? ` (${shared} partagée${shared > 1 ? 's' : ''})` : ''}
          </span>
        )}
        {loading && <span className={styles.meta}>Mesure…</span>}
        <label className={styles.buildFrom}>
          <span>Essai fait de</span>
          <select
            className={selectClass}
            value={buildFrom}
            onChange={(event) => onBuildFrom(event.target.value as BuildFrom)}
            title="Ce dont « Essayer l’instrument » fait l’instrument : les partiels mesurés, ou les harmoniques d’une forme d’onde, avec son passe-bas"
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
        !loading && <p className={styles.note}>Place le curseur ou choisis une zone sur un son : la forme d’onde de sa note s’affiche ici.</p>
      ) : fit.frequency <= 0 ? (
        <p className={styles.note}>Pas de note dans cette sélection.</p>
      ) : fit.moments === 0 || fit.fits.length === 0 ? (
        <p className={styles.warning}>
          {noteName(fit.frequency)} n’est jamais entendue seule ici : sans doute un accord sur sa fondamentale absente.
          Choisis une note dans les puces pour la forme d’onde de chacune.
        </p>
      ) : (
        <>
          {weakNote && (
            <p className={styles.warning}>
              La note mesurée, {noteName(fit.frequency)}, est faible dans la zone ({Math.round(weakNote.strength * 100)} % de la
              plus forte){weakNote.strong.length ? ` : les notes fortes sont ${weakNote.strong.join(', ')}` : ''}. Choisis-en une
              dans les puces.
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
                  title={`${SHAPE_LABELS[candidate.shape]} : ${SHAPE_HINTS[candidate.shape]}. Écart moyen de ${candidate.error_db.toLocaleString(
                    'fr-FR',
                    { maximumFractionDigits: 1 },
                  )} dB avec les harmoniques mesurées${candidate.cutoff > 0 ? ', à travers ce passe-bas' : ''}. Un clic : l’essai en est fait.`}
                >
                  <span className={styles.fitName}>{describeShape(candidate)}</span>
                  <span className={styles.fitGap}>
                    {candidate.error_db.toLocaleString('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} dB
                  </span>
                </button>
              );
            })}
          </div>
          <p className={styles.descriptors}>
            <span>
              Harmoniques paires :{' '}
              {fit.even_count === 0
                ? 'pas mesurables ici'
                : fit.even_db > -6
                  ? `présentes (${formatDb(fit.even_db)} dB face aux impaires voisines)`
                  : fit.even_db > -20
                    ? `affaiblies (${formatDb(fit.even_db)} dB face aux impaires voisines)`
                    : `absentes (${formatDb(fit.even_db, 0)} dB face aux impaires voisines)`}
            </span>
            <span>Pente : {formatDb(fit.slope)} dB par octave</span>
          </p>
          <HarmonicChart fit={fit} model={model} />
          <p className={styles.legend}>
            Barres : les harmoniques mesurées (grises : partagées avec une autre note, écartées ; pâles : pas au-dessus du
            fond). Points : {shown ? describeShape(shown) : 'la forme'}. L’écart est la moyenne, en dB, entre les deux ; la phase
            ne s’entend pas sur une note tenue et n’est pas mesurée.
          </p>
          {quality === 'poor' ? (
            <p className={styles.warning}>
              Aucune forme ne colle vraiment (la plus proche à {best?.error_db.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} dB) : les partiels mesurés restent plus fidèles.
            </p>
          ) : quality === 'fair' ? (
            <p className={styles.note}>Approchant : compare à l’oreille avec les partiels mesurés.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
