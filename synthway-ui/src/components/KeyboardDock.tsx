import { Minus, Plus, Power } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { instrumentParams } from '../lib/instrumentSound';
import { keyboardOctave, MAX_OCTAVE, MIN_OCTAVE, type Instrument } from '../lib/instruments';
import { isTyping } from '../lib/keyboard';
import { midiToFrequency, midiToName } from '../lib/music';
import { playBlocker, useSynthServer } from '../lib/SynthServer';
import layout from '@theme/components/layout.module.css';
import { PianoKeyboard } from './PianoKeyboard';
import { Button, Panel, cx } from './ui';
import styles from '@theme/components/KeyboardDock.module.css';

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

/**
 * Bottom dock of the Instrument Creator, and of the Analyzer's trial
 * instrument: audio power, note readout, keyboard. The keyboard starts at the
 * octave the instrument keeps; onOctaveChange gets every change, to keep it (a
 * locked instrument keeps its own: the change then lasts until another
 * instrument is chosen). markedNote, if on the keyboard, is marked on its key.
 */
export function KeyboardDock({
  instrument,
  onOctaveChange,
  markedNote,
  markedTitle,
}: {
  instrument: Instrument;
  onOctaveChange?: (octave: number) => void;
  markedNote?: number;
  /** Tooltip of the marked key */
  markedTitle?: string;
}) {
  const { t } = useI18n();
  const server = useSynthServer();
  const { canPlay, startNote, releaseNote, engine, busy } = server;
  const blocker = playBlocker(server);
  const keyLabel = useKeyLabel();

  const savedOctave = keyboardOctave(instrument.octave);
  const [octave, setOctave] = useState(savedOctave);
  // Another instrument, or its octave changed: the keyboard follows it
  useEffect(() => setOctave(savedOctave), [instrument.id, savedOctave]);
  const onOctaveChangeRef = useRef(onOctaveChange);
  onOctaveChangeRef.current = onOctaveChange;
  const changeOctave = useCallback(
    (delta: number) => {
      const next = keyboardOctave(octave + delta);
      if (next === octave) return;
      setOctave(next);
      onOctaveChangeRef.current?.(next);
    },
    [octave],
  );
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

  // Each key is a note of its own, named by its MIDI number, on instrument 0 (the one useInstrumentSound sets):
  // a chord sounds whole, and a key pressed while others are held gets its own attack
  const press = useCallback(
    (midi: number) => {
      if (!canPlay || heldRef.current.includes(midi)) return;
      setHeldNotes([...heldRef.current, midi]);
      startNote(midi, 0, midiToFrequency(midi), volumeRef.current);
    },
    [canPlay, startNote, setHeldNotes],
  );

  const release = useCallback(
    (midi: number) => {
      if (!heldRef.current.includes(midi)) return;
      setHeldNotes(heldRef.current.filter((note) => note !== midi));
      releaseNote(midi);
    },
    [releaseNote, setHeldNotes],
  );

  // Losing the audio releases every key
  useEffect(() => {
    if (!canPlay && heldRef.current.length > 0) {
      setHeldNotes([]);
      notesByCode.current.clear();
    }
  }, [canPlay, setHeldNotes]);

  // The dock closing (another screen, a trial instrument dropped) releases the notes still held
  const releaseNoteRef = useRef(releaseNote);
  releaseNoteRef.current = releaseNote;
  useEffect(
    () => () => {
      for (const midi of heldRef.current) releaseNoteRef.current(midi);
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if (event.code === OCTAVE_DOWN || event.code === OCTAVE_UP) {
        changeOctave(event.code === OCTAVE_UP ? 1 : -1);
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
  }, [startMidi, press, release, changeOctave]);

  const keyLabels = useMemo(
    () => new Map(KEY_OFFSETS.map(([code, offset]) => [startMidi + offset, keyLabel(code)])),
    [startMidi, keyLabel],
  );

  const current = held[held.length - 1];
  const online = server.connection === 'online' && server.coreLoaded;
  const powerTitle = !online
    ? t('keyboard.serverNeeded')
    : engine.running
      ? t('common.disableAudio')
      : t('keyboard.enableAudioTitle');

  return (
    <Panel as="div" className={cx(layout.dock, styles.dock)}>
      <div className={styles.powerGroup}>
        <button
          type="button"
          className={cx(styles.power, engine.running && styles.powerOn)}
          disabled={!online || busy}
          aria-pressed={engine.running}
          aria-label={engine.running ? t('common.disableAudio') : t('common.enableAudio')}
          title={powerTitle}
          onClick={() =>
            engine.running
              ? void server.stopAudio()
              : void server.startAudio(instrumentParams(instrument, engine.maxPartials))
          }
        >
          <Power size={20} strokeWidth={2} />
        </button>
        <div className={styles.powerText}>
          <span className={styles.powerLabel}>{t('keyboard.audio')}</span>
          <span className={cx(styles.powerState, engine.running && styles.powerStateOn)}>
            {busy ? '…' : engine.running ? t('keyboard.audioOn') : t('keyboard.audioOff')}
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
          markedNote={markedNote}
          markedTitle={markedTitle}
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
            aria-label={t('keyboard.octaveDown')}
            disabled={octave <= MIN_OCTAVE}
            onClick={() => changeOctave(-1)}
          >
            <Minus size={14} />
          </Button>
          <span className={styles.octaveValue}>{t('keyboard.octave', { octave })}</span>
          <Button
            size="small"
            iconOnly
            aria-label={t('keyboard.octaveUp')}
            disabled={octave >= MAX_OCTAVE}
            onClick={() => changeOctave(1)}
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
