import { Minus, Plus, Power } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Instrument } from '../lib/instruments';
import { midiToFrequency, midiToName } from '../lib/music';
import { toTimbre } from '../lib/partials';
import { playBlocker, useSynthServer } from '../lib/SynthServer';
import layout from './layout.module.css';
import { PianoKeyboard } from './PianoKeyboard';
import { Button, Panel, cx } from './ui';
import styles from './KeyboardDock.module.css';

// Physical key positions (KeyboardEvent.code): the same keys play the same
// notes on AZERTY and QWERTY layouts
const KEY_OFFSETS: [code: string, offset: number][] = [
  ['KeyA', 0],
  ['KeyW', 1],
  ['KeyS', 2],
  ['KeyE', 3],
  ['KeyD', 4],
  ['KeyF', 5],
  ['KeyT', 6],
  ['KeyG', 7],
  ['KeyY', 8],
  ['KeyH', 9],
  ['KeyU', 10],
  ['KeyJ', 11],
  ['KeyK', 12],
  ['KeyO', 13],
  ['KeyL', 14],
  ['KeyP', 15],
  ['Semicolon', 16],
];
const OFFSET_BY_CODE = new Map(KEY_OFFSETS);
const OCTAVE_DOWN = 'KeyZ';
const OCTAVE_UP = 'KeyX';
const MIN_OCTAVE = 1;
const MAX_OCTAVE = 6;
/** Two octaves from the highest octave, plus the final C: C8 */
export const HIGHEST_MIDI = (MAX_OCTAVE + 1) * 12 + 24;

interface KeyboardLayoutMap {
  get(code: string): string | undefined;
}

/** Label printed on each physical key, from the user's layout when the browser exposes it */
function useKeyLabel(): (code: string) => string {
  const [layoutMap, setLayoutMap] = useState<KeyboardLayoutMap | null>(null);

  useEffect(() => {
    const keyboard = (
      navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<KeyboardLayoutMap> } }
    ).keyboard;
    keyboard
      ?.getLayoutMap?.()
      .then(setLayoutMap)
      .catch(() => undefined);
  }, []);

  return useCallback(
    (code: string) => (layoutMap?.get(code) ?? (code.startsWith('Key') ? code.slice(3) : ';')).toUpperCase(),
    [layoutMap],
  );
}

function isTyping(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) {
    return !['range', 'checkbox', 'radio', 'button'].includes(target.type);
  }
  return target instanceof HTMLElement && (target.isContentEditable || ['SELECT', 'TEXTAREA'].includes(target.tagName));
}

/** Bottom dock of the Instrument Creator: audio power, note readout, keyboard */
export function KeyboardDock({ instrument }: { instrument: Instrument }) {
  const server = useSynthServer();
  const { canPlay, noteOn, noteOff, engine, busy } = server;
  const blocker = playBlocker(server);
  const keyLabel = useKeyLabel();

  const [octave, setOctave] = useState(4);
  const [held, setHeld] = useState<number[]>([]);
  const heldRef = useRef<number[]>([]);
  const notesByCode = useRef(new Map<string, number>());
  const volumeRef = useRef(instrument.volume);
  volumeRef.current = instrument.volume;

  const startMidi = (octave + 1) * 12;

  const setHeldNotes = useCallback((next: number[]) => {
    heldRef.current = next;
    setHeld(next);
  }, []);

  const press = useCallback(
    (midi: number) => {
      if (!canPlay || heldRef.current.includes(midi)) return;
      setHeldNotes([...heldRef.current, midi]);
      noteOn(midiToFrequency(midi), volumeRef.current);
    },
    [canPlay, noteOn, setHeldNotes],
  );

  const release = useCallback(
    (midi: number) => {
      if (!heldRef.current.includes(midi)) return;
      const next = heldRef.current.filter((note) => note !== midi);
      setHeldNotes(next);
      // Monophonic engine: fall back to the last key still held
      const last = next[next.length - 1];
      if (last === undefined) noteOff();
      else noteOn(midiToFrequency(last), volumeRef.current);
    },
    [noteOn, noteOff, setHeldNotes],
  );

  // Losing the audio releases every key
  useEffect(() => {
    if (!canPlay && heldRef.current.length > 0) {
      setHeldNotes([]);
      notesByCode.current.clear();
    }
  }, [canPlay, setHeldNotes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if (event.code === OCTAVE_DOWN) {
        setOctave((current) => Math.max(MIN_OCTAVE, current - 1));
        return;
      }
      if (event.code === OCTAVE_UP) {
        setOctave((current) => Math.min(MAX_OCTAVE, current + 1));
        return;
      }
      const offset = OFFSET_BY_CODE.get(event.code);
      if (offset === undefined) return;
      event.preventDefault();
      const midi = startMidi + offset;
      notesByCode.current.set(event.code, midi);
      press(midi);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const midi = notesByCode.current.get(event.code);
      if (midi === undefined) return;
      notesByCode.current.delete(event.code);
      release(midi);
    };
    const onBlur = () => {
      notesByCode.current.forEach((midi) => release(midi));
      notesByCode.current.clear();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [startMidi, press, release]);

  const keyLabels = useMemo(
    () => new Map(KEY_OFFSETS.map(([code, offset]) => [startMidi + offset, keyLabel(code)])),
    [startMidi, keyLabel],
  );

  const current = held[held.length - 1];
  const online = server.connection === 'online' && server.coreLoaded;
  const powerTitle = !online
    ? 'Le serveur Synthway doit être connecté'
    : engine.running
      ? 'Couper l’audio'
      : 'Activer l’audio (démarre le moteur sur la sortie choisie dans les réglages)';

  return (
    <Panel as="div" className={cx(layout.dock, styles.dock)}>
      <div className={styles.powerGroup}>
        <button
          type="button"
          className={cx(styles.power, engine.running && styles.powerOn)}
          disabled={!online || busy}
          aria-pressed={engine.running}
          aria-label={engine.running ? 'Couper l’audio' : 'Activer l’audio'}
          title={powerTitle}
          onClick={() =>
            engine.running
              ? void server.stopAudio()
              : void server.startAudio({
                  volume: instrument.volume,
                  timbre: toTimbre(instrument.partials, engine.maxPartials),
                  low_cutoff: instrument.filter.lowCutoff,
                  cutoff: instrument.filter.cutoff,
                  resonance: instrument.filter.resonance,
                })
          }
        >
          <Power size={20} strokeWidth={2} />
        </button>
        <div className={styles.powerText}>
          <span className={styles.powerLabel}>Audio</span>
          <span className={cx(styles.powerState, engine.running && styles.powerStateOn)}>
            {busy ? '…' : engine.running ? 'Actif' : 'Coupé'}
          </span>
        </div>
      </div>

      <div className={styles.readout} aria-live="polite">
        <span className={cx(styles.readoutNote, current === undefined && styles.readoutIdle)}>
          {current === undefined ? '—' : midiToName(current)}
        </span>
        <span className={styles.readoutFreq}>
          {current === undefined ? '0.00 Hz' : `${midiToFrequency(current).toFixed(2)} Hz`}
        </span>
      </div>

      <div className={styles.keys}>
        <PianoKeyboard
          startMidi={startMidi}
          octaves={2}
          activeNotes={held}
          keyLabels={keyLabels}
          disabled={!canPlay}
          onNoteDown={press}
          onNoteUp={release}
        />
        {blocker && <div className={styles.blocker}>{blocker}</div>}
      </div>

      <div className={styles.octave}>
        <div className={styles.octaveRow}>
          <Button
            size="small"
            iconOnly
            aria-label="Octave inférieure"
            disabled={octave <= MIN_OCTAVE}
            onClick={() => setOctave(octave - 1)}
          >
            <Minus size={14} />
          </Button>
          <span className={styles.octaveValue}>Oct {octave}</span>
          <Button
            size="small"
            iconOnly
            aria-label="Octave supérieure"
            disabled={octave >= MAX_OCTAVE}
            onClick={() => setOctave(octave + 1)}
          >
            <Plus size={14} />
          </Button>
        </div>
        <span className={styles.octaveHint}>
          {keyLabel(OCTAVE_DOWN)} / {keyLabel(OCTAVE_UP)}
        </span>
      </div>
    </Panel>
  );
}
