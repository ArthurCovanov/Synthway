import { AlertTriangle, Copy, Download, GripVertical, Lock, LockOpen, Magnet, Plus, Search, Trash2, Upload } from 'lucide-react';
import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { EnvelopeGraph } from '../components/EnvelopeGraph';
import { EnvelopesGraph } from '../components/EnvelopesGraph';
import { SpectrumGlyph, WaveGlyph } from '../components/icons';
import { HIGHEST_MIDI, KeyboardDock } from '../components/KeyboardDock';
import layout from '../components/layout.module.css';
import { Notice, useNotice } from '../components/Notice';
import { ScreenHeader } from '../components/ScreenHeader';
import { SpectrumGraph } from '../components/SpectrumGraph';
import {
  Button,
  LiveBadge,
  Panel,
  RangeSlider,
  Section,
  Segmented,
  Slider,
  cx,
  inputClass,
  selectClass,
  type ValueEdit,
} from '../components/ui';
import { WaveScope } from '../components/WaveScope';
import { useAppearance } from '../lib/appearance';
import { chooseFiles, FileFormatError, fileNameOf, saveTextFile } from '../lib/files';
import {
  importInstruments,
  INSTRUMENT_FILE,
  INSTRUMENT_FILE_ACCEPT,
  instrumentFileText,
  parseInstrumentFile,
} from '../lib/instrumentFile';
import { useInstrumentSound } from '../lib/instrumentSound';
import {
  CATEGORY_LABEL,
  createInstrument,
  duplicateInstrument,
  type Envelope,
  type FilterSettings,
  type Instrument,
  type InstrumentCategory,
  releaseCurveOf,
  type TimbrePartial,
  unisonOf,
} from '../lib/instruments';
import { midiToName, WAVEFORM_OPTIONS } from '../lib/music';
import { HUE_HEX, HUE_LABEL, HUE_VAR, HUES, PARTIAL_HUES, type NeonHue } from '../lib/neon';
import {
  activePartials,
  aliasingFrom,
  formatRatio,
  harmonicSeries,
  MAX_RATIO,
  MIN_RATIO,
  newPartial,
  peakSum,
} from '../lib/partials';
import { usePersistentState } from '../lib/storage';
import { useSynthServer } from '../lib/SynthServer';
import {
  ATTACK_CURVE,
  ENVELOPE_CURVE,
  MAX_UNISON_DETUNE_CENTS,
  MAX_UNISON_VOICES,
  WAVEFORM,
  type UnisonParams,
  type Waveform,
} from '../types';
import styles from './InstrumentCreator.module.css';

function formatSeconds(seconds: number): string {
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`;
}

function formatHertz(hz: number): string {
  return hz < 1000 ? `${Math.round(hz)} Hz` : `${(hz / 1000).toFixed(1)} kHz`;
}

const percent = (value: number) => `${Math.round(value * 100)} %`;

/** A value in [0, 1], typed as a percentage */
const percentEdit = (value: number, onChange: (value: number) => void): ValueEdit => ({
  value: value * 100,
  min: 0,
  max: 100,
  unit: '%',
  decimals: 1,
  onCommit: (typed) => onChange(Number((typed / 100).toFixed(4))),
});

/** End of the unison detune slider, in cents: typing goes up to MAX_UNISON_DETUNE_CENTS */
const UNISON_DETUNE_SLIDER_MAX = 50;

/** Longest envelope time synthway-server accepts; the sliders stop before it */
const ENVELOPE_MAX_SECONDS = 10;

/** Times use a quadratic scale, so that short attacks stay easy to set */
function TimeSlider({
  label,
  value,
  max,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (seconds: number) => void;
  disabled?: boolean;
}) {
  return (
    <Slider
      label={label}
      value={Math.min(1, Math.sqrt(value / max))}
      min={0}
      max={1}
      step={0.001}
      disabled={disabled}
      format={() => formatSeconds(value)}
      onChange={(position) => onChange(Math.max(0.001, Number((position * position * max).toFixed(3))))}
      edit={{
        value: value * 1000,
        min: 0,
        max: ENVELOPE_MAX_SECONDS * 1000,
        unit: 'ms',
        decimals: 1,
        onCommit: (ms) => onChange(Number((ms / 1000).toFixed(5))),
      }}
    />
  );
}

/** Fastest and slowest exponential falls the sliders reach: 60 dB in 10 ms, and in 10 s */
const FALL_RATE_MAX = 6000;
const FALL_RATE_MIN = 6;

function formatRate(dbPerSecond: number): string {
  return `${dbPerSecond < 100 ? dbPerSecond.toFixed(1) : Math.round(dbPerSecond)} dB/s`;
}

/**
 * A decay or a release: a time in seconds when it is a straight ramp; a speed
 * in dB per second when it is exponential (the engine's time to fall 60 dB,
 * shown as how fast it falls), on a logarithmic bar
 */
function FallSlider({
  label,
  seconds,
  exponential,
  onChange,
  disabled,
}: {
  label: string;
  seconds: number;
  exponential: boolean;
  onChange: (seconds: number) => void;
  disabled?: boolean;
}) {
  if (!exponential) {
    return <TimeSlider label={label} value={seconds} max={4} disabled={disabled} onChange={onChange} />;
  }
  const rate = 60 / Math.max(seconds, 60 / FALL_RATE_MAX / 10);
  const span = Math.log(FALL_RATE_MAX / FALL_RATE_MIN);
  const toSeconds = (dbPerSecond: number) => Number((60 / dbPerSecond).toFixed(5));
  return (
    <Slider
      label={label}
      value={Math.min(1, Math.max(0, Math.log(rate / FALL_RATE_MIN) / span))}
      min={0}
      max={1}
      step={0.001}
      disabled={disabled}
      format={() => `${formatRate(rate)} · −60 dB en ${formatSeconds(seconds)}`}
      onChange={(position) => onChange(toSeconds(FALL_RATE_MIN * Math.exp(position * span)))}
      edit={{
        value: rate,
        min: 60 / ENVELOPE_MAX_SECONDS,
        max: FALL_RATE_MAX * 10,
        unit: 'dB/s',
        decimals: 1,
        onCommit: (typed) => onChange(toSeconds(typed)),
      }}
    />
  );
}

const ATTACK_CURVE_OPTIONS = [
  { value: ATTACK_CURVE.Linear, label: 'Linéaire', title: 'Le niveau monte en ligne droite jusqu’au sommet' },
  {
    value: ATTACK_CURVE.Convex,
    label: 'Exponentielle',
    title: 'Lente au début, puis de plus en plus rapide (le carré d’une rampe droite) : une montée qu’on entend exponentielle',
  },
];

const FALL_CURVE_OPTIONS = [
  { value: ENVELOPE_CURVE.Linear, label: 'Linéaire', title: 'Une rampe droite, réglée par sa durée' },
  {
    value: ENVELOPE_CURVE.Exponential,
    label: 'Exponentielle',
    title: 'Le niveau perd autant de dB chaque seconde, comme une corde pincée : réglée par cette vitesse, en dB/s',
  },
];

/**
 * Band-pass bounds on one logarithmic bar, from 20 Hz to 20 kHz. At its ends a
 * bound filters nothing (the core skips that section): the lower one then
 * reads 0 Hz, and both ends together mean no filter.
 */
const CUTOFF_MIN = 20;
const CUTOFF_MAX = 20000;
/** The upper bound stays at least this ratio above the lower one */
const BAND_MIN_RATIO = 1.05;
const cutoffPosition = (hz: number) => Math.log(hz / CUTOFF_MIN) / Math.log(CUTOFF_MAX / CUTOFF_MIN);
const cutoffAt = (position: number) => CUTOFF_MIN * Math.pow(CUTOFF_MAX / CUTOFF_MIN, position);
const formatLowCutoff = (hz: number) => (hz <= CUTOFF_MIN ? '0 Hz' : formatHertz(hz));

/** Ratio slider on a logarithmic scale, from ×0.25 to ×32 (typing goes further) */
const RATIO_SLIDER_MIN = 0.25;
const RATIO_SLIDER_RANGE = 128;

/** Harmonics generated by "Générer depuis une forme" */
const GENERATED_PARTIALS = 16;

/** Partials named in the aliasing warning, the others are only marked in the list */
const ALIASING_LISTED = 6;

const GENERATORS: { waveform: Waveform; label: string }[] = [
  { waveform: WAVEFORM.Sawtooth, label: 'Dent de scie : toutes les harmoniques, en 1/n' },
  { waveform: WAVEFORM.Square, label: 'Carré : harmoniques impaires, en 1/n' },
  { waveform: WAVEFORM.Triangle, label: 'Triangle : harmoniques impaires, en 1/n²' },
];

/** Octave and harmonic shortcuts, under the typed ratio */
function RatioShortcuts({ ratio, onChange }: { ratio: number; onChange: (ratio: number) => void }) {
  return (
    <div className={styles.ratioButtons}>
      <Button
        size="small"
        title="Une octave plus bas"
        disabled={ratio / 2 < MIN_RATIO}
        onClick={() => onChange(Number((ratio / 2).toFixed(3)))}
      >
        ÷2
      </Button>
      <Button
        size="small"
        title="Une octave plus haut"
        disabled={ratio * 2 > MAX_RATIO}
        onClick={() => onChange(Number((ratio * 2).toFixed(3)))}
      >
        ×2
      </Button>
      <Button
        size="small"
        title="Arrondir à l’harmonique la plus proche"
        disabled={Number.isInteger(ratio)}
        onClick={() => onChange(Math.max(1, Math.round(ratio)))}
      >
        Harmoniser
      </Button>
    </div>
  );
}

/** Active / inactive: an inactive partial stays in the list but is neither played nor summed */
function PartialSwitch({
  partial,
  number,
  disabled,
  onToggle,
}: {
  partial: TimbrePartial;
  number: number;
  disabled: boolean;
  onToggle: () => void;
}) {
  const state = partial.muted ? 'Inactif' : 'Actif';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!partial.muted}
      aria-label={`Partiel ${number} actif`}
      className={styles.partialSwitch}
      disabled={disabled}
      title={
        disabled
          ? `${state} (verrouillé)`
          : partial.muted
            ? 'Inactif : cliquer pour l’ajouter de nouveau au son'
            : 'Actif : cliquer pour le retirer du son sans le supprimer'
      }
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    />
  );
}

function InstrumentCard({
  instrument,
  selected,
  canDelete,
  dragging,
  dropIndicator,
  disabledReorder,
  onSelect,
  onDuplicate,
  onDelete,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragCancel,
}: {
  instrument: Instrument;
  selected: boolean;
  canDelete: boolean;
  dragging?: boolean;
  dropIndicator?: 'before' | 'after' | null;
  disabledReorder?: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDragStart?: (event: React.PointerEvent<HTMLElement>, id: string) => void;
  onDragMove?: (event: React.PointerEvent<HTMLElement>) => void;
  onDragEnd?: (event: React.PointerEvent<HTMLElement>) => void;
  onDragCancel?: () => void;
}) {
  const count = instrument.partials.length;
  const active = activePartials(instrument.partials);
  const only = active.length === 1 ? active[0] : null;
  return (
    <div
      role="button"
      tabIndex={0}
      data-instrument-id={instrument.id}
      aria-pressed={selected}
      className={cx(
        styles.card,
        selected && styles.cardSelected,
        dragging && styles.cardDragging,
        Boolean(dropIndicator) && styles.cardDropTarget,
      )}
      style={{ '--hue': HUE_VAR[instrument.hue] } as CSSProperties}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
          } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowLeft')) {
            event.preventDefault();
            onMoveUp?.();
          } else if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowRight')) {
            event.preventDefault();
            onMoveDown?.();
          }
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || disabledReorder) return;
        if ((event.target as HTMLElement).closest('button')) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        onDragStart?.(event, instrument.id);
      }}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragCancel}
    >
      {dropIndicator === 'before' && <div className={cx(styles.dropBar, styles.dropBarBefore)} />}
      {dropIndicator === 'after' && <div className={cx(styles.dropBar, styles.dropBarAfter)} />}
      <div className={styles.cardTop}>
        <div className={styles.cardTopLeft}>
          <button
            type="button"
            className={styles.dragHandle}
            aria-label={`Déplacer ${instrument.name}`}
            title={
              disabledReorder
                ? 'Un seul instrument chargé'
                : 'Glisser pour réordonner les instruments (ou Alt+↑ / Alt+↓)'
            }
            disabled={disabledReorder}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => {
              if (event.button !== 0 || disabledReorder) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              onDragStart?.(event, instrument.id);
            }}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragCancel}
          >
            <GripVertical size={14} />
          </button>
          {only && only.ratio === 1 ? (
            <WaveGlyph waveform={only.waveform} width={34} height={16} className={styles.cardGlyph} />
          ) : (
            <SpectrumGlyph
              partials={active.map((partial) => ({
                ratio: partial.ratio,
                amplitude: partial.amplitude,
                color: HUE_HEX[partial.hue],
              }))}
              width={34}
              height={16}
            />
          )}
        </div>
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.miniBtn}
            title="Dupliquer"
            aria-label={`Dupliquer ${instrument.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onDuplicate();
            }}
          >
            <Copy size={13} />
          </button>
          <button
            type="button"
            className={styles.miniBtn}
            title={
              instrument.locked
                ? 'Instrument verrouillé : déverrouille-le pour le supprimer'
                : canDelete
                  ? 'Supprimer'
                  : 'Il faut garder au moins un instrument'
            }
            aria-label={`Supprimer ${instrument.name}`}
            disabled={!canDelete}
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      <div className={styles.cardName}>{instrument.name}</div>
      <p className={styles.cardDesc}>{instrument.description}</p>
      <div className={styles.tags}>
        <span className={cx(styles.tag, styles.tagHue)}>{CATEGORY_LABEL[instrument.category]}</span>
        <span className={styles.tag}>
          {count} partiel{count > 1 ? 's' : ''}
        </span>
        {instrument.locked && (
          <span className={cx(styles.tag, styles.tagLock)} title="Instrument verrouillé">
            <Lock size={10} aria-label="Verrouillé" />
          </span>
        )}
      </div>
    </div>
  );
}

export function InstrumentCreator({
  instruments,
  setInstruments,
  selectedId,
  setSelectedId,
}: {
  instruments: Instrument[];
  setInstruments: Dispatch<SetStateAction<Instrument[]>>;
  selectedId: string;
  setSelectedId: (id: string) => void;
}) {
  const { animate } = useAppearance();
  const { engine, audioConfig } = useSynthServer();
  const [query, setQuery] = useState('');
  const [magnet, setMagnet] = usePersistentState<boolean>('synthway.spectrum-magnet.v1', () => true);
  const [selectedPartialId, setSelectedPartialId] = useState<string | null>(null);
  const [notice, showNotice] = useNotice();
  const [draggedInstrumentId, setDraggedInstrumentId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const instrumentDragRef = useRef<{
    id: string;
    pointerId: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);

  const selected = instruments.find((instrument) => instrument.id === selectedId) ?? instruments[0];
  const partials = selected.partials;
  const active = useMemo(() => activePartials(partials), [partials]);
  const partial = partials.find((item) => item.id === selectedPartialId) ?? partials[0] ?? null;
  // A locked instrument is read only; a locked partial too, inside an unlocked instrument
  const locked = !!selected.locked;
  const frozen = (item: TimbrePartial) => locked || !!item.locked;
  const partialFrozen = partial ? frozen(partial) : true;
  // Exponential decay and release are times to fall 60 dB, which can last much longer
  const decayExponential = partial?.envelope.curve === ENVELOPE_CURVE.Exponential;
  const releaseExponential = partial ? releaseCurveOf(partial.envelope) === ENVELOPE_CURVE.Exponential : false;
  const maxPartials = engine.maxPartials;
  const sampleRate = engine.sampleRate ?? audioConfig.sampleRate;

  // Volume, partials, filter, reverb and unison drive the engine live while the audio is on
  useInstrumentSound(selected);
  const reverb = selected.reverb ?? 0;
  const { voices, detune, spread } = unisonOf(selected);

  // Warnings: active partials above half the sample rate on the keyboard's notes, possible clipping
  const aliasing = useMemo(() => {
    const from = new Map<string, number>();
    for (const item of active) {
      const midi = aliasingFrom(item.ratio, sampleRate, HIGHEST_MIDI);
      if (midi !== null) from.set(item.id, midi);
    }
    return from;
  }, [active, sampleRate]);
  const aliasingIds = useMemo(() => new Set(aliasing.keys()), [aliasing]);
  const peak = peakSum(partials) * selected.volume;
  // The reverb raises the peaks, measured on held notes up to about 1 + 2 × its mix
  const reverbPeak = peak * (1 + 2 * reverb);
  // Unison voices are each scaled by 1 / √voices: when they happen to line up, the peaks reach √voices times
  const unisonPeak = reverbPeak * Math.sqrt(voices);
  const atLimit = partials.length >= maxPartials;
  // A partial is named by its place in the list (1, 2, 3…), which does not move with its ratio
  const partialNumber = (id: string) => partials.findIndex((item) => item.id === id) + 1;

  // Every change goes through these, which leave a locked instrument or partial as it is
  const update = (patch: Partial<Instrument>) =>
    setInstruments((list) =>
      list.map((item) => (item.id === selected.id && !item.locked ? { ...item, ...patch } : item)),
    );
  const updateUnison = (patch: Partial<UnisonParams>) => update({ unison: { ...unisonOf(selected), ...patch } });
  // The bound that moves stops at the other one, and both stay between 20 Hz and 20 kHz
  const updateFilter = (patch: Partial<FilterSettings>) => {
    const filter = { ...selected.filter, ...patch };
    if ('lowCutoff' in patch) {
      filter.lowCutoff = Math.min(Math.max(filter.lowCutoff, CUTOFF_MIN), filter.cutoff / BAND_MIN_RATIO);
    }
    if ('cutoff' in patch) {
      filter.cutoff = Math.max(Math.min(filter.cutoff, CUTOFF_MAX), filter.lowCutoff * BAND_MIN_RATIO);
    }
    update({ filter });
  };
  const setInstrumentLocked = (value: boolean) =>
    setInstruments((list) => list.map((item) => (item.id === selected.id ? { ...item, locked: value } : item)));

  const setPartials = (change: (list: TimbrePartial[]) => TimbrePartial[]) =>
    setInstruments((list) =>
      list.map((item) => (item.id === selected.id && !item.locked ? { ...item, partials: change(item.partials) } : item)),
    );
  const changePartial = (id: string, change: (item: TimbrePartial) => TimbrePartial) =>
    setPartials((list) => list.map((item) => (item.id === id && !item.locked ? change(item) : item)));
  const updatePartial = (id: string, patch: Partial<TimbrePartial>) => changePartial(id, (item) => ({ ...item, ...patch }));
  const updatePartialEnvelope = (id: string, patch: Partial<Envelope>) =>
    changePartial(id, (item) => ({ ...item, envelope: { ...item.envelope, ...patch } }));
  const togglePartial = (id: string) => changePartial(id, (item) => ({ ...item, muted: !item.muted }));
  const togglePartialLock = (id: string) =>
    setPartials((list) => list.map((item) => (item.id === id ? { ...item, locked: !item.locked } : item)));

  const addPartial = (at?: { ratio: number; amplitude: number }) => {
    if (atLimit) return;
    const created = newPartial(partials, partial ?? undefined, at);
    setPartials((list) => [...list, created]);
    setSelectedPartialId(created.id);
  };

  const duplicatePartial = (source: TimbrePartial) => {
    if (atLimit) return;
    const created = { ...newPartial(partials, source), ratio: source.ratio, amplitude: source.amplitude, waveform: source.waveform };
    setPartials((list) => [...list, created]);
    setSelectedPartialId(created.id);
  };

  const removePartial = (id: string) => {
    const index = partials.findIndex((item) => item.id === id);
    if (index < 0 || frozen(partials[index])) return;
    const neighbour = partials[index + 1] ?? partials[index - 1] ?? null;
    setPartials((list) => list.filter((item) => item.id !== id || item.locked));
    setSelectedPartialId(neighbour?.id ?? null);
  };

  /** Replaces the unlocked partials; the locked ones stay, at the top of the list */
  const generate = (waveform: Waveform) => {
    const kept = partials.filter((item) => item.locked);
    const count = Math.min(GENERATED_PARTIALS, maxPartials - kept.length);
    if (count <= 0) return;
    const question = kept.length
      ? 'Remplacer les partiels non verrouillés de cet instrument par les harmoniques générées ? Les partiels verrouillés restent.'
      : 'Remplacer les partiels de cet instrument par les harmoniques générées ?';
    if (partials.length - kept.length > 1 && !window.confirm(question)) {
      return;
    }
    const series = harmonicSeries(waveform, count, partial?.envelope ?? {
      attack: 0.02,
      decay: 0.2,
      sustain: 0.7,
      release: 0.3,
    });
    setPartials((list) => [...list.filter((item) => item.locked), ...series]);
    setSelectedPartialId(series[0].id);
  };

  const add = (instrument: Instrument, after?: string) => {
    setInstruments((list) => {
      const index = after ? list.findIndex((item) => item.id === after) : list.length - 1;
      return [...list.slice(0, index + 1), instrument, ...list.slice(index + 1)];
    });
    setSelectedId(instrument.id);
  };

  const remove = (id: string) => {
    if (instruments.length <= 1 || instruments.find((item) => item.id === id)?.locked) return;
    const index = instruments.findIndex((item) => item.id === id);
    const next = instruments.filter((item) => item.id !== id);
    setInstruments(next);
    if (id === selected.id) {
      setSelectedId(next[Math.min(index, next.length - 1)].id);
    }
  };

  const reorderInstrument = (sourceId: string, targetId: string, position: 'before' | 'after') => {
    if (sourceId === targetId) return;
    setInstruments((list) => {
      const from = list.findIndex((item) => item.id === sourceId);
      if (from < 0) return list;
      const next = [...list];
      const [moved] = next.splice(from, 1);
      const to = next.findIndex((item) => item.id === targetId);
      if (to < 0) return list;
      const insertIndex = position === 'after' ? to + 1 : to;
      next.splice(insertIndex, 0, moved);
      return next;
    });
  };

  const moveInstrumentInView = (id: string, delta: -1 | 1) => {
    const visibleIndex = visible.findIndex((item) => item.id === id);
    if (visibleIndex < 0) return;
    const target = visible[visibleIndex + delta];
    if (!target) return;
    reorderInstrument(id, target.id, delta < 0 ? 'before' : 'after');
  };

  const handleDragStart = (event: React.PointerEvent<HTMLElement>, id: string) => {
    instrumentDragRef.current = {
      id,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  };

  const handleDragMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = instrumentDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      setDraggedInstrumentId(drag.id);
    }
    let target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-instrument-id]');
    if (!target) {
      target =
        document.elementFromPoint(event.clientX, event.clientY - 7)?.closest<HTMLElement>('[data-instrument-id]') ??
        document.elementFromPoint(event.clientX, event.clientY + 7)?.closest<HTMLElement>('[data-instrument-id]');
    }
    const targetId = target?.dataset.instrumentId ?? null;
    if (target && targetId && targetId !== drag.id) {
      const rect = target.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const position = event.clientY < midY ? 'before' : 'after';
      setDropTarget({ id: targetId, position });
    } else {
      setDropTarget(null);
    }
  };

  const handleDragEnd = (event: React.PointerEvent<HTMLElement>) => {
    const drag = instrumentDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      if (dropTarget && dropTarget.id !== drag.id) {
        reorderInstrument(drag.id, dropTarget.id, dropTarget.position);
      }
      setSelectedId(drag.id);
    }
    instrumentDragRef.current = null;
    setDraggedInstrumentId(null);
    setDropTarget(null);
  };

  const handleDragCancel = () => {
    instrumentDragRef.current = null;
    setDraggedInstrumentId(null);
    setDropTarget(null);
  };

  /** Saves the selected instrument in a file of its own, to share it or keep it apart */
  const exportSelected = async () => {
    const instrument = selected;
    try {
      const result = await saveTextFile(
        instrumentFileText(instrument),
        INSTRUMENT_FILE,
        fileNameOf(instrument.name, INSTRUMENT_FILE.extension, 'Instrument'),
      );
      if (!result.saved) return;
      showNotice({
        tone: 'success',
        title: `« ${instrument.name} » ${result.handle ? 'exporté dans' : 'téléchargé :'} « ${result.name} ».`,
      });
    } catch (error) {
      showNotice({
        tone: 'error',
        title: `« ${instrument.name} » n’a pas pu être exporté.`,
        details: [error instanceof Error ? error.message : String(error)],
      });
    }
  };

  /**
   * Adds the instruments of the files chosen at the end of the library, each locked: the user unlocks it
   * to change it. Under its own id when it is free (compositions using it find it again), as a copy
   * otherwise; one already there, the same, is only selected.
   */
  const importFromFiles = async () => {
    const files = await chooseFiles(INSTRUMENT_FILE_ACCEPT, true);
    if (!files.length) return;
    const read: Instrument[] = [];
    const failures: string[] = [];
    for (const file of files) {
      try {
        read.push(parseInstrumentFile(await file.text()));
      } catch (error) {
        if (!(error instanceof FileFormatError)) console.error(error);
        failures.push(`« ${file.name} » n’a pas pu être importé : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const outcomes = importInstruments(instruments, read);
    const added = outcomes.filter((outcome) => outcome.kind !== 'present').map((outcome) => outcome.instrument);
    if (added.length) setInstruments((list) => [...list, ...added]);
    const last = outcomes[outcomes.length - 1];
    if (last) setSelectedId(last.instrument.id);

    const details: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.kind === 'copied') {
        details.push(
          `Une autre version de « ${outcome.existing.name} » est déjà dans ta bibliothèque : celle du fichier est ajoutée à côté, sous le nom « ${outcome.instrument.name} ».`,
        );
      } else if (outcome.kind === 'present') {
        details.push(`« ${outcome.instrument.name} » était déjà dans ta bibliothèque, à l’identique : rien n’est ajouté.`);
      }
    }
    details.push(...failures);
    const title =
      added.length === 0
        ? failures.length
          ? 'Aucun instrument importé.'
          : 'Rien de nouveau à importer.'
        : added.length === 1
          ? `« ${added[0].name} » importé, verrouillé : déverrouille-le pour le modifier.`
          : `${added.length} instruments importés, verrouillés : déverrouille-les pour les modifier.`;
    showNotice({
      tone: failures.length ? (added.length ? 'warning' : 'error') : details.length ? 'info' : 'success',
      title,
      details,
    });
  };

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? instruments.filter((item) =>
        [item.name, item.description, CATEGORY_LABEL[item.category]].some((text) => text.toLowerCase().includes(needle)),
      )
    : instruments;

  const aliasingList = partials.filter((item) => aliasing.has(item.id));

  return (
    <div className={layout.screen}>
      <ScreenHeader
        index="01"
        eyebrow="Création sonore"
        title="Instrument Creator"
        subtitle="Assemble les partiels de tes instruments, puis joue-les au clavier."
      />

      <div className={styles.body}>
        <Panel className={styles.library}>
          <div className={styles.libraryHead}>
            <h2 className={styles.panelTitle}>
              Bibliothèque <span className={styles.count}>{instruments.length}</span>
            </h2>
            <div className={styles.search}>
              <Search size={14} />
              <input
                className={inputClass}
                type="search"
                placeholder="Rechercher"
                aria-label="Rechercher un instrument"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <div className={styles.libraryActions}>
            <Button variant="primary" size="small" onClick={() => add(createInstrument())}>
              <Plus size={15} />
              Nouvel instrument
            </Button>
            <Button
              size="small"
              title={`Importer des instruments (${INSTRUMENT_FILE.extension}) : ils arrivent verrouillés`}
              onClick={() => void importFromFiles()}
            >
              <Upload size={14} />
              Importer
            </Button>
            <Button
              size="small"
              title={`Exporter « ${selected.name} » dans un fichier ${INSTRUMENT_FILE.extension}`}
              onClick={() => void exportSelected()}
            >
              <Download size={14} />
              Exporter
            </Button>
          </div>
          <div className={styles.grid} data-dragging={draggedInstrumentId ? 'true' : undefined}>
            {visible.map((instrument) => (
              <InstrumentCard
                key={instrument.id}
                instrument={instrument}
                selected={instrument.id === selected.id}
                canDelete={instruments.length > 1 && !instrument.locked}
                dragging={draggedInstrumentId === instrument.id}
                dropIndicator={dropTarget?.id === instrument.id ? dropTarget.position : null}
                disabledReorder={instruments.length <= 1}
                onSelect={() => setSelectedId(instrument.id)}
                onDuplicate={() => add(duplicateInstrument(instrument), instrument.id)}
                onDelete={() => remove(instrument.id)}
                onMoveUp={() => moveInstrumentInView(instrument.id, -1)}
                onMoveDown={() => moveInstrumentInView(instrument.id, 1)}
                onDragStart={handleDragStart}
                onDragMove={handleDragMove}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
              />
            ))}
            {visible.length === 0 && <p className={styles.empty}>Aucun instrument ne correspond à « {query} ».</p>}
          </div>
        </Panel>

        <Panel className={styles.editor}>
          <div className={styles.editorHead}>
            <input
              className={styles.nameInput}
              value={selected.name}
              maxLength={40}
              aria-label="Nom de l’instrument"
              readOnly={locked}
              onChange={(event) => update({ name: event.target.value })}
            />
            <select
              className={selectClass}
              value={selected.category}
              aria-label="Catégorie"
              disabled={locked}
              onChange={(event) => update({ category: event.target.value as InstrumentCategory })}
            >
              {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={cx(styles.chipButton, styles.lockChip)}
              aria-pressed={locked}
              title={
                locked
                  ? 'Instrument verrouillé : rien n’est modifiable. Cliquer pour le déverrouiller.'
                  : 'Verrouiller tout l’instrument, comme une sauvegarde : il se joue toujours, mais plus rien ne se modifie.'
              }
              onClick={() => setInstrumentLocked(!locked)}
            >
              {locked ? <Lock size={13} /> : <LockOpen size={13} />}
              {locked ? 'Verrouillé' : 'Déverrouillé'}
            </button>
          </div>
          <input
            className={cx(inputClass, styles.descInput)}
            value={selected.description}
            maxLength={120}
            placeholder="Décris son caractère…"
            aria-label="Description"
            readOnly={locked}
            onChange={(event) => update({ description: event.target.value })}
          />
          {locked && (
            <div className={styles.lockNote}>
              <Lock size={13} />
              <span>
                Instrument verrouillé : il se joue toujours, mais rien n’est modifiable. Déverrouille-le pour le modifier,
                ou duplique-le pour en faire une variante.
              </span>
              <Button size="small" className={styles.lockNoteAction} onClick={() => setInstrumentLocked(false)}>
                <LockOpen size={13} />
                Déverrouiller
              </Button>
            </div>
          )}

          <Section
            title="Spectre"
            badge={<LiveBadge />}
            actions={
              <>
                <span
                  className={cx(styles.chip, atLimit && styles.chipWarn)}
                  title={`Limite du moteur (synthway-core) : ${maxPartials} partiels par instrument`}
                >
                  {partials.length} / {maxPartials} partiels
                </span>
                <button
                  type="button"
                  className={styles.chipButton}
                  aria-pressed={magnet}
                  disabled={locked}
                  title="Aimant : un partiel glissé près d’un rapport entier s’y accroche (Alt pour l’ignorer)"
                  onClick={() => setMagnet(!magnet)}
                >
                  <Magnet size={13} />
                  Aimant
                </button>
              </>
            }
          >
            <div className={styles.spectrum}>
              <SpectrumGraph
                partials={partials}
                selectedId={partial?.id ?? null}
                aliasing={aliasingIds}
                magnet={magnet}
                locked={locked}
                onSelect={setSelectedPartialId}
                onMove={(id, ratio, amplitude) => updatePartial(id, { ratio, amplitude })}
                onAdd={(ratio, amplitude) => addPartial({ ratio, amplitude })}
              />
              {partials.length === 0 && (
                <p className={styles.spectrumEmpty}>
                  Aucun partiel : l’instrument est muet.{' '}
                  {locked ? 'Déverrouille l’instrument pour en placer un.' : 'Double-clique pour en placer un.'}
                </p>
              )}
            </div>
            <p className={styles.hint}>
              {locked
                ? 'Instrument verrouillé : un clic choisit un partiel sans le déplacer.'
                : 'Glisse un partiel : à droite pour monter son rapport à la note jouée, en haut pour son amplitude. Double-clic : nouveau partiel. Un partiel verrouillé (cadenas) ne bouge pas.'}{' '}
              Les pointillés sont les harmoniques déjà contenues dans une onde non sinusoïdale ; un partiel inactif est
              estompé.
            </p>

            {(atLimit || aliasingList.length > 0 || unisonPeak > 1) && (
              <ul className={styles.warnings}>
                {atLimit && (
                  <li>
                    <AlertTriangle size={14} />
                    <span>
                      Limite du moteur atteinte : {maxPartials} partiels au plus par instrument.
                    </span>
                  </li>
                )}
                {aliasingList.length > 0 && (
                  <li>
                    <AlertTriangle size={14} />
                    <span>
                      Au-delà de la moitié de la fréquence d’échantillonnage ({formatHertz(sampleRate / 2)}), un partiel se
                      replie en une autre fréquence :{' '}
                      {aliasingList
                        .slice(0, ALIASING_LISTED)
                        .map(
                          (item) =>
                            `partiel ${partialNumber(item.id)} (${formatRatio(item.ratio)}) dès ${midiToName(aliasing.get(item.id) ?? 0)}`,
                        )
                        .join(', ')}
                      {aliasingList.length > ALIASING_LISTED
                        ? `, et ${aliasingList.length - ALIASING_LISTED} autres (marqués dans la liste des partiels).`
                        : '.'}
                    </span>
                  </li>
                )}
                {peak > 1 && (
                  <li>
                    <AlertTriangle size={14} />
                    <span>
                      Saturation possible : la somme des amplitudes × le volume atteint {percent(peak)}. Si les partiels
                      culminent ensemble, le son dépasse 100 % et sera écrêté.
                    </span>
                  </li>
                )}
                {peak <= 1 && reverbPeak > 1 && (
                  <li>
                    <AlertTriangle size={14} />
                    <span>
                      Saturation possible avec la réverbération : elle peut porter les crêtes vers {percent(reverbPeak)}.
                      Baisse le volume si le son est écrêté.
                    </span>
                  </li>
                )}
                {reverbPeak <= 1 && unisonPeak > 1 && (
                  <li>
                    <AlertTriangle size={14} />
                    <span>
                      Saturation possible avec l’unisson : quand ses {voices} voix se retrouvent en phase, les crêtes
                      peuvent monter vers {percent(unisonPeak)}. Baisse le volume si le son est écrêté.
                    </span>
                  </li>
                )}
              </ul>
            )}
          </Section>

          <div className={styles.views}>
            <Section title="Enveloppes">
              <div className={styles.envelopes}>
                <EnvelopesGraph partials={active} selectedId={partial?.id ?? null} />
              </div>
            </Section>
            <Section title="Onde résultante">
              <div className={styles.scope}>
                <WaveScope voices={active} hue={selected.hue} animate={animate} />
                <div className={styles.scopeLabel}>
                  <span>Somme des partiels</span>
                  {engine.running && <span className={styles.scopeLive}>● Moteur actif</span>}
                </div>
              </div>
            </Section>
          </div>

          <div className={styles.sections}>
            <Section title="Volume" badge={<LiveBadge />}>
              <Slider
                label="Volume de l’instrument"
                value={selected.volume}
                min={0}
                max={1}
                step={0.01}
                format={percent}
                disabled={locked}
                onChange={(volume) => update({ volume })}
                edit={percentEdit(selected.volume, (volume) => update({ volume }))}
              />
            </Section>

            <Section title="Filtre" badge={<LiveBadge />}>
              <RangeSlider
                label={
                  selected.filter.lowCutoff <= CUTOFF_MIN && selected.filter.cutoff >= CUTOFF_MAX
                    ? 'Bande passante (aucun filtre)'
                    : 'Bande passante'
                }
                step={0.001}
                disabled={locked}
                low={{
                  label: 'Borne basse',
                  position: cutoffPosition(selected.filter.lowCutoff),
                  display: formatLowCutoff(selected.filter.lowCutoff),
                  onChange: (position) => updateFilter({ lowCutoff: Math.floor(cutoffAt(position)) }),
                  // Typing under 20 Hz filters nothing, like 0 Hz
                  edit: {
                    value: selected.filter.lowCutoff <= CUTOFF_MIN ? 0 : selected.filter.lowCutoff,
                    min: 0,
                    max: Math.floor(selected.filter.cutoff / BAND_MIN_RATIO),
                    unit: 'Hz',
                    decimals: 0,
                    onCommit: (lowCutoff) => updateFilter({ lowCutoff: Math.floor(lowCutoff) }),
                  },
                }}
                high={{
                  label: 'Borne haute',
                  position: cutoffPosition(selected.filter.cutoff),
                  display: formatHertz(selected.filter.cutoff),
                  onChange: (position) => updateFilter({ cutoff: Math.round(cutoffAt(position)) }),
                  edit: {
                    value: selected.filter.cutoff,
                    min: Math.ceil(selected.filter.lowCutoff * BAND_MIN_RATIO),
                    max: CUTOFF_MAX,
                    unit: 'Hz',
                    decimals: 0,
                    onCommit: (cutoff) => updateFilter({ cutoff: Math.round(cutoff) }),
                  },
                }}
              />
              <Slider
                label="Résonance"
                value={selected.filter.resonance}
                min={0}
                max={1}
                step={0.01}
                format={percent}
                disabled={locked}
                onChange={(resonance) => updateFilter({ resonance })}
                edit={percentEdit(selected.filter.resonance, (resonance) => updateFilter({ resonance }))}
              />
            </Section>

            <Section title="Réverbération" badge={<LiveBadge />}>
              <Slider
                label={reverb > 0 ? 'Son réverbéré' : 'Son réverbéré (aucune réverbération)'}
                value={reverb}
                min={0}
                max={1}
                step={0.01}
                format={percent}
                disabled={locked}
                onChange={(value) => update({ reverb: value })}
                edit={percentEdit(reverb, (value) => update({ reverb: value }))}
              />
              <p className={styles.hint}>
                Une salle d’environ 2 s, qui continue de sonner après la note. À 100 %, seule la réverbération reste.
              </p>
            </Section>

            <Section title="Unisson" badge={<LiveBadge />}>
              <Slider
                label={voices > 1 ? 'Voix par partiel' : 'Voix par partiel (pas d’unisson)'}
                value={voices}
                min={1}
                max={MAX_UNISON_VOICES}
                step={1}
                format={(value) => `${value}`}
                disabled={locked}
                onChange={(value) => updateUnison({ voices: Math.round(value) })}
              />
              <Slider
                label="Désaccord"
                value={Math.min(detune, UNISON_DETUNE_SLIDER_MAX)}
                min={0}
                max={UNISON_DETUNE_SLIDER_MAX}
                step={0.5}
                format={() => `±${detune} cents`}
                disabled={locked || voices < 2}
                onChange={(value) => updateUnison({ detune: value })}
                edit={{
                  value: detune,
                  min: 0,
                  max: MAX_UNISON_DETUNE_CENTS,
                  prefix: '±',
                  unit: 'cents',
                  decimals: 1,
                  onCommit: (value) => updateUnison({ detune: Number(value.toFixed(1)) }),
                }}
              />
              <Slider
                label="Largeur stéréo"
                value={spread}
                min={0}
                max={1}
                step={0.01}
                format={percent}
                disabled={locked || voices < 2}
                onChange={(value) => updateUnison({ spread: value })}
                edit={percentEdit(spread, (value) => updateUnison({ spread: value }))}
              />
              <p className={styles.hint}>
                Chaque partiel est joué par plusieurs oscillateurs un peu désaccordés, qui battent entre eux : le son
                s’épaissit, comme une « supersaw ». 5 à 7 voix à ±10–20 cents donnent l’épaisseur classique ; la largeur
                les répartit entre gauche et droite.
              </p>
            </Section>

            <Section title="Couleur de l'instrument">
              <Swatches
                hues={HUES}
                value={selected.hue}
                label="Couleur de l'instrument"
                disabled={locked}
                onChange={(hue) => update({ hue })}
              />
            </Section>
          </div>
        </Panel>

        <Panel className={styles.partialsPanel}>
          <div className={styles.partialsHead}>
            <h2 className={styles.panelTitle}>
              Partiels{' '}
              <span className={styles.count}>
                {partials.length}/{maxPartials}
              </span>
            </h2>
            <Button
              size="small"
              onClick={() => addPartial()}
              disabled={atLimit || locked}
              title={
                locked
                  ? 'Instrument verrouillé'
                  : atLimit
                    ? `Limite du moteur atteinte : ${maxPartials} partiels`
                    : 'Ajouter un partiel sur la prochaine harmonique libre'
              }
            >
              <Plus size={14} />
              Ajouter
            </Button>
          </div>
          <select
            className={cx(selectClass, styles.generator)}
            value=""
            aria-label="Remplacer les partiels non verrouillés par les harmoniques d’une forme d’onde"
            disabled={locked}
            onChange={(event) => generate(Number(event.target.value) as Waveform)}
          >
            <option value="" disabled>
              Générer depuis une forme d’onde…
            </option>
            {GENERATORS.map((generator) => (
              <option key={generator.waveform} value={generator.waveform}>
                {generator.label}
              </option>
            ))}
          </select>

          <div className={styles.partialList}>
            {partials.map((item, index) => (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                className={styles.partialRow}
                aria-pressed={item.id === partial?.id}
                data-muted={item.muted ? 'true' : undefined}
                style={{ '--hue': HUE_VAR[item.hue] } as CSSProperties}
                onClick={() => setSelectedPartialId(item.id)}
                onKeyDown={(event) => {
                  if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    setSelectedPartialId(item.id);
                  }
                }}
              >
                <PartialSwitch
                  partial={item}
                  number={index + 1}
                  disabled={frozen(item)}
                  onToggle={() => togglePartial(item.id)}
                />
                <span className={styles.partialNumber}>
                  {item.locked && <Lock size={10} className={styles.partialLockIcon} aria-label="verrouillé" />}
                  {index + 1}
                </span>
                <span className={styles.partialRatio} title="Rapport à la note jouée">
                  {formatRatio(item.ratio)}
                </span>
                <span className={styles.partialMeter}>
                  <span style={{ width: `${item.amplitude * 100}%` }} />
                </span>
                <span className={styles.partialPercent}>{percent(item.amplitude)}</span>
                <span className={styles.partialWave}>
                  {WAVEFORM_OPTIONS.find((option) => option.value === item.waveform)?.short}
                </span>
                {aliasing.has(item.id) ? (
                  <AlertTriangle size={13} className={styles.partialWarn} aria-label="Repliement sur les notes aiguës" />
                ) : (
                  <span className={styles.partialWarnSpace} />
                )}
              </div>
            ))}
            {partials.length === 0 && <p className={styles.empty}>Aucun partiel : l’instrument est muet.</p>}
          </div>

          {partial && (
            <div className={styles.partialEditor} style={{ '--hue': HUE_VAR[partial.hue] } as CSSProperties}>
              <div className={styles.partialEditorHead}>
                <PartialSwitch
                  partial={partial}
                  number={partialNumber(partial.id)}
                  disabled={partialFrozen}
                  onToggle={() => togglePartial(partial.id)}
                />
                <h3 className={styles.partialTitle}>
                  Partiel {partialNumber(partial.id)}
                  {partial.muted && <span className={styles.partialMuted}> · inactif</span>}
                </h3>
                <button
                  type="button"
                  className={styles.partialLock}
                  aria-pressed={!!partial.locked}
                  aria-label={`Verrouiller le partiel ${partialNumber(partial.id)}`}
                  disabled={locked}
                  title={
                    locked
                      ? 'Instrument verrouillé'
                      : partial.locked
                        ? 'Partiel verrouillé : cliquer pour pouvoir le modifier de nouveau'
                        : 'Verrouiller ce partiel : plus rien ne le modifie, ni le spectre, ni les réglages'
                  }
                  onClick={() => togglePartialLock(partial.id)}
                >
                  {partial.locked ? <Lock size={14} /> : <LockOpen size={14} />}
                </button>
                <div className={styles.partialActions}>
                  <Button
                    size="small"
                    iconOnly
                    title="Dupliquer ce partiel"
                    aria-label="Dupliquer ce partiel"
                    disabled={atLimit || locked}
                    onClick={() => duplicatePartial(partial)}
                  >
                    <Copy size={14} />
                  </Button>
                  <Button
                    size="small"
                    iconOnly
                    title={partialFrozen ? 'Verrouillé : impossible de le supprimer' : 'Supprimer ce partiel'}
                    aria-label="Supprimer ce partiel"
                    disabled={partialFrozen}
                    onClick={() => removePartial(partial.id)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
              {partial.locked && !locked && (
                <p className={styles.lockNote}>
                  <Lock size={13} />
                  Partiel verrouillé : clique sur le cadenas à côté de son nom pour le modifier.
                </p>
              )}

              <Slider
                label="Rapport à la note"
                value={Math.min(1, Math.max(0, Math.log(partial.ratio / RATIO_SLIDER_MIN) / Math.log(RATIO_SLIDER_RANGE)))}
                min={0}
                max={1}
                step={0.001}
                disabled={partialFrozen}
                format={() => formatRatio(partial.ratio)}
                onChange={(position) =>
                  updatePartial(partial.id, {
                    ratio: Number((RATIO_SLIDER_MIN * Math.pow(RATIO_SLIDER_RANGE, position)).toFixed(3)),
                  })
                }
                edit={{
                  value: partial.ratio,
                  min: MIN_RATIO,
                  max: MAX_RATIO,
                  prefix: '×',
                  decimals: 4,
                  onCommit: (ratio) => updatePartial(partial.id, { ratio }),
                  extra: (
                    <RatioShortcuts ratio={partial.ratio} onChange={(ratio) => updatePartial(partial.id, { ratio })} />
                  ),
                }}
              />
              <Slider
                label="Amplitude"
                value={partial.amplitude}
                min={0}
                max={1}
                step={0.01}
                format={percent}
                disabled={partialFrozen}
                onChange={(amplitude) => updatePartial(partial.id, { amplitude })}
                edit={percentEdit(partial.amplitude, (amplitude) => updatePartial(partial.id, { amplitude }))}
              />
              <Segmented
                label="Forme d’onde"
                options={WAVEFORM_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.short,
                  title: option.label,
                  icon: <WaveGlyph waveform={option.value} width={26} height={12} />,
                }))}
                value={partial.waveform}
                disabled={partialFrozen}
                onChange={(waveform) => updatePartial(partial.id, { waveform })}
              />
              {partial.waveform !== WAVEFORM.Sine && (
                <p className={styles.note}>
                  Une onde non sinusoïdale contient déjà ses propres harmoniques : elles apparaissent en pointillés sur le
                  spectre.
                </p>
              )}
              {aliasing.has(partial.id) && (
                <p className={styles.partialAlias}>
                  <AlertTriangle size={13} />
                  Dépasse {formatHertz(sampleRate / 2)} dès la note {midiToName(aliasing.get(partial.id) ?? 0)} : il se
                  replie en une autre fréquence.
                </p>
              )}

              <Section
                title="Enveloppe du partiel"
                actions={
                  <Button
                    size="small"
                    title="Donner cette enveloppe à tous les partiels non verrouillés"
                    disabled={locked || !partials.some((item) => item.id !== partial.id && !item.locked)}
                    onClick={() =>
                      setPartials((list) =>
                        list.map((item) => (item.locked ? item : { ...item, envelope: { ...partial.envelope } })),
                      )
                    }
                  >
                    À tous
                  </Button>
                }
              >
                <div className={styles.envelopeGraph}>
                  <EnvelopeGraph envelope={partial.envelope} />
                </div>
                <div className={styles.segments}>
                  <div className={styles.segment}>
                    <TimeSlider
                      label="Attaque"
                      value={partial.envelope.attack}
                      max={2}
                      disabled={partialFrozen}
                      onChange={(attack) => updatePartialEnvelope(partial.id, { attack })}
                    />
                    <Segmented
                      compact
                      label="Courbe de l’attaque"
                      options={ATTACK_CURVE_OPTIONS}
                      value={partial.envelope.attack_curve ?? ATTACK_CURVE.Linear}
                      disabled={partialFrozen}
                      onChange={(attack_curve) => updatePartialEnvelope(partial.id, { attack_curve })}
                    />
                  </div>
                  <div className={styles.segment}>
                    <FallSlider
                      label="Déclin"
                      seconds={partial.envelope.decay}
                      exponential={decayExponential}
                      disabled={partialFrozen}
                      onChange={(decay) => updatePartialEnvelope(partial.id, { decay })}
                    />
                    <Segmented
                      compact
                      label="Courbe du déclin"
                      options={FALL_CURVE_OPTIONS}
                      value={partial.envelope.curve ?? ENVELOPE_CURVE.Linear}
                      disabled={partialFrozen}
                      // The release keeps its curve: saved without one, it followed the decay's
                      onChange={(curve) =>
                        updatePartialEnvelope(partial.id, { curve, release_curve: releaseCurveOf(partial.envelope) })
                      }
                    />
                  </div>
                  <div className={styles.segment}>
                    <Slider
                      label="Maintien"
                      value={partial.envelope.sustain}
                      min={0}
                      max={1}
                      step={0.01}
                      format={percent}
                      disabled={partialFrozen}
                      onChange={(sustain) => updatePartialEnvelope(partial.id, { sustain })}
                      edit={percentEdit(partial.envelope.sustain, (sustain) => updatePartialEnvelope(partial.id, { sustain }))}
                    />
                  </div>
                  <div className={styles.segment}>
                    <FallSlider
                      label="Relâchement"
                      seconds={partial.envelope.release}
                      exponential={releaseExponential}
                      disabled={partialFrozen}
                      onChange={(release) => updatePartialEnvelope(partial.id, { release })}
                    />
                    <Segmented
                      compact
                      label="Courbe du relâchement"
                      options={FALL_CURVE_OPTIONS}
                      value={releaseCurveOf(partial.envelope)}
                      disabled={partialFrozen}
                      onChange={(release_curve) => updatePartialEnvelope(partial.id, { release_curve })}
                    />
                  </div>
                </div>
              </Section>

              <Section title="Couleur du partiel">
                <Swatches
                  hues={PARTIAL_HUES}
                  value={partial.hue}
                  label="Couleur du partiel"
                  disabled={partialFrozen}
                  onChange={(hue) => updatePartial(partial.id, { hue })}
                />
              </Section>
            </div>
          )}
        </Panel>
      </div>

      <Notice notice={notice} onClose={() => showNotice(null)} />
      <KeyboardDock instrument={selected} onOctaveChange={(octave) => update({ octave })} />
    </div>
  );
}

function Swatches({
  hues,
  value,
  label,
  disabled,
  onChange,
}: {
  hues: NeonHue[];
  value: NeonHue;
  label: string;
  disabled?: boolean;
  onChange: (hue: NeonHue) => void;
}) {
  return (
    <div className={styles.swatches} role="group" aria-label={label}>
      {hues.map((hue) => (
        <button
          key={hue}
          type="button"
          className={styles.swatch}
          style={{ '--hue': HUE_VAR[hue] } as CSSProperties}
          aria-pressed={value === hue}
          aria-label={HUE_LABEL[hue]}
          title={HUE_LABEL[hue]}
          disabled={disabled}
          onClick={() => onChange(hue)}
        />
      ))}
    </div>
  );
}
