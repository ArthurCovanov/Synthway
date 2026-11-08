import { useRef } from 'react';
import { formatCents, frequencyToNote, type NoteReading } from '../lib/music';
import type { Analysis } from '../types';
import styles from './Tuner.module.css';

/** Below this clarity no note is shown, below RELIABLE it is shown as uncertain */
const MIN_CLARITY = 0.5;
const RELIABLE_CLARITY = 0.8;
/** Quieter than this, the sound is taken as silence. Low on purpose: a microphone
    without the system's effects (exclusive mode) can be quiet, and clarity
    already tells a note from noise */
const SILENCE_DB = -80;
/** How long the last note stays (faded) once the sound stops, in live mode */
const HOLD_MS = 1200;
/** Within this many cents, the note is in tune */
const IN_TUNE_CENTS = 5;

/** Gauge geometry: -50 to +50 cents over ±60° */
const GAUGE = { cx: 130, cy: 128, r: 104, spread: 60 };

function polar(cents: number, radius: number) {
  const angle = ((cents / 50) * GAUGE.spread * Math.PI) / 180;
  return { x: GAUGE.cx + radius * Math.sin(angle), y: GAUGE.cy - radius * Math.cos(angle) };
}

function arc(from: number, to: number, radius: number): string {
  const a = polar(from, radius);
  const b = polar(to, radius);
  return `M${a.x.toFixed(2)} ${a.y.toFixed(2)} A${radius} ${radius} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

interface Shown {
  note: NoteReading;
  frequency: number;
  uncertain: boolean;
  held: boolean;
}

/**
 * Tuner: the note heard, its gap to the equal-tempered note on a gauge, its
 * frequency, and how reliable it is. With `hold`, the last note stays a moment
 * once the sound stops, so it can be read.
 */
export function Tuner({ analysis, a4, hold }: { analysis: Analysis | null; a4: number; hold: boolean }) {
  const last = useRef<{ shown: Shown; time: number } | null>(null);

  let shown: Shown | null = null;
  const note = analysis ? frequencyToNote(analysis.frequency, a4) : null;
  const silent = !analysis || analysis.level_db < SILENCE_DB;
  if (analysis && note && !silent && analysis.clarity >= MIN_CLARITY) {
    shown = { note, frequency: analysis.frequency, uncertain: analysis.clarity < RELIABLE_CLARITY, held: false };
    if (!shown.uncertain) last.current = { shown, time: performance.now() };
  } else if (hold && last.current && performance.now() - last.current.time < HOLD_MS) {
    shown = { ...last.current.shown, held: true };
  }

  const cents = shown ? Math.max(-50, Math.min(50, shown.note.cents)) : 0;
  const tone = !shown ? 'idle' : Math.abs(cents) <= IN_TUNE_CENTS ? 'tune' : Math.abs(cents) <= 15 ? 'near' : 'off';
  const needleAngle = (cents / 50) * GAUGE.spread;

  let status = 'En attente d’un son';
  if (analysis && silent && !shown) status = 'Silence';
  else if (analysis && !shown) status = 'Pas de note nette (bruit, accord ?)';
  else if (shown?.held) status = 'Dernière note entendue';
  else if (shown?.uncertain) status = 'Note incertaine';
  else if (shown) status = tone === 'tune' ? 'Juste' : cents > 0 ? 'Trop haut' : 'Trop bas';

  return (
    <div className={styles.tuner} data-tone={tone} data-dim={shown && (shown.uncertain || shown.held) ? 'true' : undefined}>
      <svg className={styles.gauge} viewBox="0 0 260 150" role="img" aria-label={shown ? `Écart : ${formatCents(cents)} cents` : 'Aucune note'}>
        <path className={styles.track} d={arc(-50, 50, GAUGE.r)} />
        <path className={styles.inTune} d={arc(-IN_TUNE_CENTS, IN_TUNE_CENTS, GAUGE.r)} />
        {[-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50].map((tick) => {
          const outer = polar(tick, GAUGE.r + 6);
          const inner = polar(tick, GAUGE.r - (tick % 50 === 0 ? 12 : 7));
          return (
            <line key={tick} className={tick === 0 ? styles.tickZero : styles.tick} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />
          );
        })}
        {[-50, -25, 25, 50].map((tick) => {
          const at = polar(tick, GAUGE.r + 17);
          return (
            <text key={tick} className={styles.tickLabel} x={at.x} y={at.y + 3} textAnchor="middle">
              {tick > 0 ? `+${tick}` : `−${-tick}`}
            </text>
          );
        })}
        {shown && (
          <line
            className={styles.needle}
            x1={GAUGE.cx}
            y1={GAUGE.cy}
            x2={GAUGE.cx}
            y2={GAUGE.cy - GAUGE.r + 10}
            style={{ transform: `rotate(${needleAngle}deg)` }}
          />
        )}
        <circle className={styles.hub} cx={GAUGE.cx} cy={GAUGE.cy} r={5} />
      </svg>

      <div className={styles.reading}>
        <div className={styles.note}>
          {shown ? (
            <>
              {shown.note.name}
              <span className={styles.octave}>{shown.note.octave}</span>
            </>
          ) : (
            '—'
          )}
        </div>
        <div className={styles.solfege}>{shown ? `${shown.note.solfege} ${shown.note.octave}` : ' '}</div>
        <div className={styles.facts}>
          <span>{shown ? `${formatCents(shown.note.cents)} cents` : '— cents'}</span>
          <span>{shown ? `${shown.frequency.toFixed(2)} Hz` : '— Hz'}</span>
        </div>
        <div className={styles.status}>{status}</div>
      </div>

      <dl className={styles.meters}>
        <dt>Netteté</dt>
        <dd>
          <span className={styles.meter}>
            <span style={{ width: `${Math.round((analysis?.clarity ?? 0) * 100)}%` }} />
          </span>
          <span className={styles.meterValue}>{analysis ? analysis.clarity.toFixed(2) : '—'}</span>
        </dd>
        <dt>Niveau</dt>
        <dd>
          <span className={styles.meter} data-kind="level">
            <span style={{ width: `${Math.max(0, Math.min(100, ((analysis?.level_db ?? -120) + 80) * 1.25))}%` }} />
          </span>
          <span className={styles.meterValue}>{analysis ? `${analysis.level_db.toFixed(0)} dB` : '—'}</span>
        </dd>
      </dl>
    </div>
  );
}
