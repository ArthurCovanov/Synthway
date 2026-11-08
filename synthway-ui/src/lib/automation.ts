/**
 * Automation: settings of a track that vary over the score (volume, pan, filter, reverb, detune),
 * drawn as curves under the piano roll and played by the engine's ramps (synthway_engine_automate).
 * A curve goes in straight lines between its points: in octaves for the cutoffs, as the engine
 * ramps them, so that what is drawn (on a logarithmic scale) is what is heard.
 */
import { AUTOMATION_PARAM, SIDE, type AutomationParamCode, type AutomationRamp, type ScoreRamp, type Side } from '../types';
import type { AutomationLane, AutomationParam, AutomationPoint, Track } from './composition';
import type { Instrument } from './instruments';

/** Most points of one side of a curve */
export const MAX_AUTOMATION_POINTS = 256;

/** Longest ramp the engine takes (SYNTHWAY_MAX_AUTOMATION_SECONDS) */
const MAX_RAMP_SECONDS = 600;

export interface AutomationSpec {
  id: AutomationParam;
  label: string;
  /** Lowest and highest values, in the setting's unit */
  min: number;
  max: number;
  /** Drawn and ramped on a logarithmic scale: each octave takes the same height and the same time */
  log?: boolean;
  /** Left and right can differ */
  stereo: boolean;
  /** The engine's setting */
  engine: AutomationParamCode;
  /** The instrument's own value, where a new curve starts */
  base: (instrument: Instrument) => number;
  /** A value as shown */
  format: (value: number) => string;
  /** What the point's field takes: its unit, and a value of the setting in it and back */
  unit: string;
  toInput: (value: number) => number;
  fromInput: (input: number) => number;
  /** Decimals kept in the field */
  inputDecimals: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const fr = (value: number, digits = 0) => value.toLocaleString('fr-FR', { maximumFractionDigits: digits });
const percent = (value: number) => `${fr(value * 100)} %`;
const hertz = (value: number) => (value >= 1000 ? `${fr(value / 1000, 2)} kHz` : `${fr(value)} Hz`);
const cutoff = (value: number) => clamp(value, 20, 20000);

/** The settings, in the order of the selector */
export const AUTOMATION_SPECS: AutomationSpec[] = [
  {
    id: 'volume',
    label: 'Volume',
    min: 0,
    max: 1,
    stereo: true,
    engine: AUTOMATION_PARAM.Gain,
    base: () => 1,
    format: percent,
    unit: '%',
    toInput: (value) => value * 100,
    fromInput: (input) => input / 100,
    inputDecimals: 1,
  },
  {
    id: 'pan',
    label: 'Panoramique',
    min: -1,
    max: 1,
    stereo: false,
    engine: AUTOMATION_PARAM.Pan,
    base: () => 0,
    format: (value) => {
      const share = Math.round(value * 100);
      return share === 0 ? 'centre' : `${share < 0 ? 'gauche' : 'droite'} ${Math.abs(share)} %`;
    },
    unit: '% (− gauche, + droite)',
    toInput: (value) => value * 100,
    fromInput: (input) => input / 100,
    inputDecimals: 1,
  },
  {
    id: 'lowPass',
    label: 'Passe-bas',
    min: 20,
    max: 20000,
    log: true,
    stereo: true,
    engine: AUTOMATION_PARAM.HighCutoff,
    base: (instrument) => cutoff(instrument.filter.cutoff),
    format: hertz,
    unit: 'Hz',
    toInput: (value) => value,
    fromInput: (input) => input,
    inputDecimals: 0,
  },
  {
    id: 'highPass',
    label: 'Passe-haut',
    min: 20,
    max: 20000,
    log: true,
    stereo: true,
    engine: AUTOMATION_PARAM.LowCutoff,
    base: (instrument) => cutoff(instrument.filter.lowCutoff),
    format: hertz,
    unit: 'Hz',
    toInput: (value) => value,
    fromInput: (input) => input,
    inputDecimals: 0,
  },
  {
    id: 'resonance',
    label: 'Résonance',
    min: 0,
    max: 1,
    stereo: true,
    engine: AUTOMATION_PARAM.Resonance,
    base: (instrument) => clamp(instrument.filter.resonance, 0, 1),
    format: percent,
    unit: '%',
    toInput: (value) => value * 100,
    fromInput: (input) => input / 100,
    inputDecimals: 1,
  },
  {
    id: 'reverb',
    label: 'Réverbe',
    min: 0,
    max: 1,
    stereo: true,
    engine: AUTOMATION_PARAM.Reverb,
    base: (instrument) => clamp(instrument.reverb ?? 0, 0, 1),
    format: percent,
    unit: '%',
    toInput: (value) => value * 100,
    fromInput: (input) => input / 100,
    inputDecimals: 1,
  },
  {
    id: 'detune',
    label: 'Désaccord',
    min: 0,
    max: 100,
    stereo: false,
    engine: AUTOMATION_PARAM.Detune,
    base: (instrument) => clamp(instrument.unison?.detune ?? 0, 0, 100),
    format: (value) => `${fr(value, 1)} cents`,
    unit: 'cents',
    toInput: (value) => value,
    fromInput: (input) => input,
    inputDecimals: 1,
  },
];

export const AUTOMATION_PARAMS = AUTOMATION_SPECS.map((spec) => spec.id);

export function automationSpec(id: AutomationParam): AutomationSpec {
  return AUTOMATION_SPECS.find((spec) => spec.id === id) ?? AUTOMATION_SPECS[0];
}

/** A value brought within the setting's range */
export function clampValue(spec: AutomationSpec, value: number): number {
  return clamp(Number.isFinite(value) ? value : spec.min, spec.min, spec.max);
}

/** Where a value sits on the curve's scale: 0 at the bottom, 1 at the top */
export function toUnit(spec: AutomationSpec, value: number): number {
  const v = clampValue(spec, value);
  return spec.log ? Math.log(v / spec.min) / Math.log(spec.max / spec.min) : (v - spec.min) / (spec.max - spec.min);
}

export function fromUnit(spec: AutomationSpec, unit: number): number {
  const u = clamp(unit, 0, 1);
  return spec.log ? spec.min * Math.pow(spec.max / spec.min, u) : spec.min + u * (spec.max - spec.min);
}

/** The curve's value `at` steps from the score's start: held before its first point and after its last */
export function valueAt(spec: AutomationSpec, points: AutomationPoint[], at: number): number {
  if (points.length === 0) return spec.min;
  if (at <= points[0].at) return points[0].value;
  for (let i = 1; i < points.length; i += 1) {
    const [a, b] = [points[i - 1], points[i]];
    if (at < b.at) {
      const share = (at - a.at) / (b.at - a.at);
      return fromUnit(spec, toUnit(spec, a.value) + share * (toUnit(spec, b.value) - toUnit(spec, a.value)));
    }
  }
  return points[points.length - 1].value;
}

export type LaneSide = 'left' | 'right';

/** Whether a lane plays its sides apart: a right side, for a setting that has one */
export function isStereo(spec: AutomationSpec, lane: AutomationLane | undefined): boolean {
  return Boolean(spec.stereo && lane?.right);
}

/** The curves of a lane, as the engine takes them: one for both sides, or the left and the right one */
export function laneSides(spec: AutomationSpec, lane: AutomationLane): { side: Side; key: LaneSide; points: AutomationPoint[] }[] {
  return isStereo(spec, lane) && lane.right
    ? [
        { side: SIDE.Left, key: 'left', points: lane.points },
        { side: SIDE.Right, key: 'right', points: lane.right },
      ]
    : [{ side: SIDE.Both, key: 'left', points: lane.points }];
}

/** Points sorted by time (stable: two points at the same time make a jump, in their order) */
export function sortedPoints(points: AutomationPoint[]): AutomationPoint[] {
  return points
    .map((point, index) => ({ point, index }))
    .sort((a, b) => a.point.at - b.point.at || a.index - b.index)
    .map(({ point }) => point);
}

/** The curves of a track, in the order of the selector */
export function trackLanes(track: Track): { spec: AutomationSpec; lane: AutomationLane }[] {
  const automation = track.automation;
  if (!automation) return [];
  return AUTOMATION_SPECS.flatMap((spec) => {
    const lane = automation[spec.id];
    return lane && lane.points.length > 0 ? [{ spec, lane }] : [];
  });
}

/** One curve of the playback: its engine slot and side, and its points */
export interface PlayedCurve {
  /** Names the curve from one tick to the next */
  key: string;
  slot: number;
  spec: AutomationSpec;
  side: Side;
  points: AutomationPoint[];
}

/**
 * What playback sends for a curve at `step` (fractional), given the stretch of it last sent
 * (`previous`: undefined when nothing was sent since playback started or moved): the ramps that
 * make the engine follow the curve from there to its next point, and the stretch they cover.
 * The ramps of a stretch are sent once, when playback enters it: the engine goes on alone.
 * (A jump followed by a ramp before the engine's next block: the ramp starts from the jump.)
 */
export function curveRamps(
  curve: PlayedCurve,
  step: number,
  secondsPerStep: number,
  previous: string | undefined,
): { stretch: string; ramps: AutomationRamp[] } {
  const { slot, spec, side, points } = curve;
  const next = points.findIndex((point) => point.at > step);
  const target = next >= 0 ? points[next] : null;
  const before = next > 0 ? points[next - 1] : null;
  // The points the stretch runs between, values included: an edit of either one sends it again
  const stretch = target
    ? `${next}:${target.at}:${target.value}:${before ? `${before.at}:${before.value}` : '-'}`
    : `end:${points[points.length - 1]?.value}`;
  if (stretch === previous) return { stretch, ramps: [] };
  // First to where the curve is now: playback starting or moved, a jump between two points at the
  // same time, an edit under the playhead, and the few milliseconds the clock lags behind the engine
  const ramps: AutomationRamp[] = [
    { slot, param: spec.engine, side, value: clampValue(spec, valueAt(spec, points, step)), seconds: 0 },
  ];
  // Then, between two points, on to the next one (before the first point or after the last one, the curve holds)
  if (target && before) {
    ramps.push({
      slot,
      param: spec.engine,
      side,
      value: clampValue(spec, target.value),
      seconds: Math.min(MAX_RAMP_SECONDS, Math.max(0, (target.at - step) * secondsPerStep)),
    });
  }
  return { stretch, ramps };
}

/**
 * The ramps of a whole curve from the score's start, for an export (/api/render/score): to its first
 * value at once, then from each point to the next, starting at the point, so that the engine draws
 * the same lines as playback. Ramps from `duration` seconds on are left out.
 */
export function scoreCurveRamps(curve: PlayedCurve, secondsPerStep: number, duration: number): ScoreRamp[] {
  const { slot, spec, side, points } = curve;
  if (points.length === 0) return [];
  const ramps: ScoreRamp[] = [{ at: 0, slot, param: spec.engine, side, value: clampValue(spec, points[0].value), seconds: 0 }];
  for (let i = 1; i < points.length; i += 1) {
    const [a, b] = [points[i - 1], points[i]];
    const at = a.at * secondsPerStep;
    if (at >= duration) break;
    ramps.push({
      at,
      slot,
      param: spec.engine,
      side,
      value: clampValue(spec, b.value),
      seconds: Math.min(MAX_RAMP_SECONDS, (b.at - a.at) * secondsPerStep),
    });
  }
  return ramps;
}

/** The curves of a track, as they play on its engine slot */
export function playedCurves(track: Track, slot: number): PlayedCurve[] {
  return trackLanes(track).flatMap(({ spec, lane }) =>
    laneSides(spec, lane).map(({ side, points }) => ({ key: `${slot}:${spec.id}:${side}`, slot, spec, side, points })),
  );
}
