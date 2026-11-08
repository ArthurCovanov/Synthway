import { useEffect, useRef, type PointerEvent } from 'react';
import { isBlackKey, midiToName } from '../lib/music';
import { cx } from './ui';
import styles from './PianoKeyboard.module.css';

/**
 * On-screen keyboard from `startMidi` over `octaves` octaves (plus the final C).
 * Mouse glissando is supported: dragging across keys moves the played note.
 * markedNote gets a dot on its key, and markedTitle as its tooltip.
 */
export function PianoKeyboard({
  startMidi,
  octaves,
  activeNotes,
  keyLabels,
  disabled,
  onNoteDown,
  onNoteUp,
  markedNote,
  markedTitle,
}: {
  startMidi: number;
  octaves: number;
  activeNotes: number[];
  keyLabels: Map<number, string>;
  disabled: boolean;
  onNoteDown: (midi: number) => void;
  onNoteUp: (midi: number) => void;
  markedNote?: number;
  markedTitle?: string;
}) {
  const pointerNote = useRef<number | null>(null);

  const notes = Array.from({ length: octaves * 12 + 1 }, (_, i) => startMidi + i);
  const whites = notes.filter((midi) => !isBlackKey(midi));
  const whiteWidth = 100 / whites.length;

  // Release the mouse-held note wherever the pointer is released
  useEffect(() => {
    const release = () => {
      if (pointerNote.current !== null) {
        onNoteUp(pointerNote.current);
        pointerNote.current = null;
      }
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('blur', release);
    };
  }, [onNoteUp]);

  const press = (midi: number) => {
    if (disabled) return;
    pointerNote.current = midi;
    onNoteDown(midi);
  };

  const slideTo = (midi: number) => {
    if (pointerNote.current === null || pointerNote.current === midi) return;
    onNoteUp(pointerNote.current);
    pointerNote.current = midi;
    onNoteDown(midi);
  };

  const keyProps = (midi: number) => ({
    'data-midi': midi,
    'data-marked': midi === markedNote ? 'true' : undefined,
    title: midi === markedNote && markedTitle ? markedTitle : midiToName(midi),
    onPointerDown: (event: PointerEvent) => {
      event.preventDefault();
      press(midi);
    },
    onPointerEnter: () => slideTo(midi),
  });

  let whiteIndex = 0;
  return (
    <div className={styles.keyboard} aria-disabled={disabled} role="group" aria-label="Clavier">
      {notes.map((midi) => {
        const active = activeNotes.includes(midi);
        const label = keyLabels.get(midi);
        if (isBlackKey(midi)) {
          const left = whiteIndex * whiteWidth - whiteWidth * 0.32;
          return (
            <div
              key={midi}
              className={cx(styles.black, active && styles.active)}
              style={{ left: `${left}%`, width: `${whiteWidth * 0.64}%` }}
              {...keyProps(midi)}
            >
              {label}
            </div>
          );
        }
        whiteIndex += 1;
        return (
          <div
            key={midi}
            className={cx(styles.white, active && styles.active)}
            {...keyProps(midi)}
          >
            {label && <span>{label}</span>}
            {midi % 12 === 0 && <span className={styles.noteName}>{midiToName(midi)}</span>}
          </div>
        );
      })}
    </div>
  );
}
