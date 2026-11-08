import type { TimbrePartial } from '../lib/instruments';
import { HUE_HEX } from '../lib/neon';
import styles from './EnvelopesGraph.module.css';

const W = 320;
const H = 110;
const PAD = 6;

function formatSeconds(seconds: number): string {
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(1)} s`;
}

/**
 * Loudness of every partial over one note (amplitude × envelope), in its
 * colour: the note is held until the slowest partial reaches its sustain,
 * then released. The selected partial is drawn on top.
 */
export function EnvelopesGraph({ partials, selectedId }: { partials: TimbrePartial[]; selectedId: string | null }) {
  const attackDecay = Math.max(0.001, ...partials.map((p) => p.envelope.attack + p.envelope.decay));
  const noteOff = attackDecay + Math.max(0.15, attackDecay * 0.3);
  const total = noteOff + Math.max(0.001, ...partials.map((p) => p.envelope.release));
  const x = (t: number) => PAD + (t / total) * (W - 2 * PAD);
  const y = (level: number) => H - PAD - level * (H - 2 * PAD - 2);

  const ordered = [...partials].sort((a, b) => (a.id === selectedId ? 1 : b.id === selectedId ? -1 : 0));

  return (
    <div className={styles.box}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className={styles.svg}
        role="img"
        aria-label="Enveloppes des partiels, chacune dans sa couleur"
      >
        {[0.25, 0.5, 0.75].map((level) => (
          <line key={level} x1={PAD} x2={W - PAD} y1={y(level)} y2={y(level)} className={styles.grid} />
        ))}
        <line x1={x(noteOff)} x2={x(noteOff)} y1={PAD} y2={H - PAD} className={styles.noteOff} />
        {ordered.map((partial) => {
          const { attack, decay, sustain, release } = partial.envelope;
          const a = partial.amplitude;
          const line = [
            `M${x(0)} ${y(0)}`,
            `L${x(attack)} ${y(a)}`,
            `L${x(attack + decay)} ${y(a * sustain)}`,
            `L${x(noteOff)} ${y(a * sustain)}`,
            `L${x(noteOff + release)} ${y(0)}`,
          ].join(' ');
          const isSelected = partial.id === selectedId;
          return (
            <path
              key={partial.id}
              d={line}
              fill="none"
              stroke={HUE_HEX[partial.hue]}
              strokeWidth={isSelected ? 2.4 : 1.4}
              strokeLinejoin="round"
              opacity={isSelected || !selectedId ? 1 : 0.45}
              vectorEffect="non-scaling-stroke"
              style={isSelected ? { filter: `drop-shadow(0 0 4px ${HUE_HEX[partial.hue]})` } : undefined}
            />
          );
        })}
      </svg>
      <span className={styles.noteOffLabel} style={{ left: `${(x(noteOff) / W) * 100}%` }}>
        relâchée
      </span>
      <span className={styles.duration}>{formatSeconds(total)}</span>
    </div>
  );
}
