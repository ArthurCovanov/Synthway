import { useId } from 'react';
import { useI18n } from '../i18n';
import { envelopeLevel, envelopeTimes, type Envelope } from '../lib/instruments';
import { ENVELOPE_CURVE } from '../types';

const W = 320;
const H = 92;
const PAD = 6;
/** Width given to the sustain plateau, in seconds-equivalent */
const HOLD = 0.4;

/** ADSR curve of an instrument, linear or exponential (see synthway_envelope_curve_t) */
export function EnvelopeGraph({ envelope }: { envelope: Envelope }) {
  const { t } = useI18n();
  const id = useId().replace(/:/g, '');
  const noteOff = envelope.attack + envelope.decay + HOLD;
  const total = noteOff + envelope.release;
  const x = (t: number) => PAD + (t / total) * (W - 2 * PAD);
  const top = PAD + 2;
  const bottom = H - PAD;
  const y = (level: number) => bottom - level * (bottom - top);

  const a = envelope.attack;
  const line = envelopeTimes(envelope, noteOff, total)
    .map((t, i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(envelopeLevel(envelope, t, noteOff)).toFixed(1)}`)
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={t(envelope.curve === ENVELOPE_CURVE.Exponential ? 'graphs.envelopeExponential' : 'graphs.envelope', {
        attack: a,
        decay: envelope.decay,
        sustain: Math.round(envelope.sustain * 100),
        release: envelope.release,
      })}
      style={{ display: 'block', width: '100%', height: '100%' }}
    >
      <defs>
        <linearGradient id={`${id}-stroke`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ff1aa8" />
          <stop offset="0.55" stopColor="#c21cff" />
          <stop offset="1" stopColor="#5f78ff" />
        </linearGradient>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c21cff" stopOpacity="0.32" />
          <stop offset="1" stopColor="#2e4dff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((level) => (
        <line
          key={level}
          x1={PAD}
          x2={W - PAD}
          y1={y(level)}
          y2={y(level)}
          stroke="rgba(150,125,255,0.08)"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <path d={`${line} Z`} fill={`url(#${id}-fill)`} />
      <path
        d={line}
        fill="none"
        stroke={`url(#${id}-stroke)`}
        strokeWidth={2}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        style={{ filter: 'drop-shadow(0 0 4px rgba(255, 26, 168, 0.6))' }}
      />
    </svg>
  );
}
