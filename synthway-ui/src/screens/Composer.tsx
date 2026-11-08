import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  Eraser,
  Eye,
  EyeOff,
  GripVertical,
  Lock,
  LockOpen,
  Pause,
  Play,
  Plus,
  Repeat,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import layout from '../components/layout.module.css';
import { ScreenHeader } from '../components/ScreenHeader';
import { Badge, Button, Panel, Segmented, cx, inputClass, selectClass } from '../components/ui';
import {
  bendAt,
  bendLine,
  createTrack,
  DEFAULT_BASE_PITCH,
  defaultComposition,
  MAX_BEND_POINTS,
  STEPS_PER_BEAT,
  type BendPoint,
  type Composition,
  type Note,
  type Track,
} from '../lib/composition';
import { type Instrument } from '../lib/instruments';
import { instrumentParams, instrumentSound } from '../lib/instrumentSound';
import { isTyping, useSpaceBar } from '../lib/keyboard';
import { isBlackKey, midiToFrequency, midiToName } from '../lib/music';
import { HUE_VAR, HUES } from '../lib/neon';
import { newId, usePersistentState } from '../lib/storage';
import { useSynthServer } from '../lib/SynthServer';
import { MAX_INSTRUMENTS } from '../types';
import styles from './Composer.module.css';

const CELL = 22; // px per step (sixteenth note)
const ROW = 16; // px per semitone
const AUDITION_MS = 180;
/** Engine note ids: the keyboard dock uses MIDI numbers (0 to 127), the audition one id, playback the ids from here up */
const AUDITION_NOTE_ID = 0x8000;
const FIRST_PLAYBACK_NOTE_ID = 0x10000;

/** Instrument slot of the track at index: slot 0 stays the keyboard's and the Instrument Creator's */
function slotOf(trackIndex: number): number {
  return 1 + (trackIndex % (MAX_INSTRUMENTS - 1));
}
const INITIAL_PITCH_ROWS = 240;
const PITCH_WINDOW_CENTER = Math.floor(INITIAL_PITCH_ROWS / 2);
const PITCH_EXTEND_ROWS = 48;
const PITCH_EXTEND_EDGE = 48;
/** Horizontal zoom of the piano roll, and how much one notch of a mouse wheel (100 px) changes it */
const MIN_HORIZONTAL_ZOOM = 0.55;
const MAX_HORIZONTAL_ZOOM = 2.4;
const WHEEL_NOTCH_ZOOM = 1.12;
const WHEEL_NOTCH_PX = 100;
/** A wheel event counted in lines or pages (Firefox), in pixels */
const WHEEL_LINE_PX = 33;
const WHEEL_PAGE_PX = 800;
const RULER_HEIGHT = 24;
const NOTE_NAME_TO_PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function parseNoteName(value: string): number | null {
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(value.trim());
  if (!match) return null;
  const [, letter, accidental, octaveText] = match;
  const octave = Number(octaveText);
  if (!Number.isSafeInteger(octave)) return null;
  const pitchClass = NOTE_NAME_TO_PITCH[letter.toUpperCase()] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0);
  const pitch = (octave + 1) * 12 + pitchClass;
  return Number.isSafeInteger(pitch) ? pitch : null;
}

const NOTE_LENGTHS = [
  { value: 1, label: '1/16', title: 'Double croche' },
  { value: 2, label: '1/8', title: 'Croche' },
  { value: 4, label: '1/4', title: 'Noire' },
  { value: 8, label: '1/2', title: 'Blanche' },
];

function audibleTracks(tracks: Track[]): Track[] {
  return tracks.filter((track) => !track.muted);
}

export function Composer({ instruments }: { instruments: Instrument[] }) {
  const {
    canPlay,
    startNote,
    releaseNote,
    releaseAllNotes,
    setInstrument,
    engine,
    startAudio,
    busy,
    connection,
    coreLoaded,
    socketOpen,
  } = useSynthServer();
  const [composition, setComposition] = usePersistentState<Composition>('synthway.composition.v1', defaultComposition);
  const [selectedTrackId, setSelectedTrackId] = useState(() => composition.tracks[0]?.id ?? '');
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [lockedTracks, setLockedTracks] = usePersistentState<Record<string, boolean>>(
    'synthway.composer-track-locks.v1',
    () => ({}),
  );
  const [baseNoteDraft, setBaseNoteDraft] = useState('C0');
  const initialPitchTop = (composition.tracks[0]?.basePitch ?? DEFAULT_BASE_PITCH) + PITCH_WINDOW_CENTER;
  const [highestVisiblePitch, setHighestVisiblePitch] = useState(initialPitchTop);
  const [lowestVisiblePitch, setLowestVisiblePitch] = useState(initialPitchTop - INITIAL_PITCH_ROWS + 1);
  const [horizontalZoom, setHorizontalZoom] = useState(1);
  const [draggedTrackId, setDraggedTrackId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [noteLength, setNoteLength] = useState(2);
  const [draftNote, setDraftNote] = useState<Note | null>(null);
  const [playing, setPlaying] = useState(false);
  /** `playing`, but changed at once by play, pause and the end of the score, without waiting for a render:
      an effect of a render from before a pause, run after it, must not start notes */
  const playingRef = useRef(false);
  const [playStep, setPlayStep] = useState(0);
  /** The zone played in a loop, in steps (end excluded), chosen by dragging on the ruler */
  const [loop, setLoop] = useState<{ start: number; end: number } | null>(null);
  /** The ruler's press: a click places the playhead, a drag selects the loop */
  const rulerPressRef = useRef<{ pointerId: number; x: number; step: number; selecting: boolean } | null>(null);
  const [rulerSelecting, setRulerSelecting] = useState(false);
  const playClock = useRef<{ startedAt: number; startStep: number } | null>(null);
  const lastAudioStep = useRef(-1);
  /** Score notes sounding in the engine (key: track, note, pitch and start), with their engine note ids */
  const soundingNotes = useRef(new Map<string, number>());
  const nextNoteId = useRef(FIRST_PLAYBACK_NOTE_ID);
  /** The sound last sent to each instrument slot, so that only changes are sent */
  const sentInstruments = useRef(new Map<number, string>());
  const auditionTimer = useRef<number | undefined>(undefined);
  const panRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const trackDragRef = useRef<{ id: string; pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const noteDrawRef = useRef<{
    pointerId: number;
    trackId: string;
    pitch: number;
    start: number;
    length: number;
    maxLength: number;
    x: number;
    moved: boolean;
  } | null>(null);
  const rollScrollRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const noteResizeRef = useRef<{
    pointerId: number;
    noteId: string;
    edge: 'start' | 'end';
    pitch: number;
    originalStart: number;
    originalLength: number;
    minStart: number;
    maxEnd: number;
    startX: number;
    moved: boolean;
    /** The curve at the press: moving the start keeps its points where they are in time */
    originalBend: BendPoint[] | undefined;
  } | null>(null);
  /** A note held and dragged to another time or pitch */
  const noteMoveRef = useRef<{
    pointerId: number;
    noteId: string;
    trackId: string;
    /** Where the note was grabbed: steps and semitones from its start */
    grabStep: number;
    grabPitch: number;
    x: number;
    y: number;
    /** Where the roll was on the page at the press: if the layout above it changes, the roll moves */
    rollLeft: number;
    rollTop: number;
    lastPitch: number;
    moved: boolean;
  } | null>(null);
  const [movingNoteId, setMovingNoteId] = useState<string | null>(null);
  /** A point of a note's pitch curve, dragged */
  const bendDragRef = useRef<{ pointerId: number; noteId: string; index: number; x: number; y: number; moved: boolean; heard: number } | null>(null);

  const { tracks, bpm, beatsPerBar, bars } = composition;
  const track = tracks.find((item) => item.id === selectedTrackId) ?? tracks[0];
  const selectedNote = track?.notes.find((item) => item.id === selectedNoteId) ?? null;
  const noteEditable = selectedNote !== null && !lockedTracks[track.id];
  const stepsPerBar = beatsPerBar * STEPS_PER_BEAT;
  const totalSteps = bars * stepsPerBar;
  const pitches = Array.from(
    { length: highestVisiblePitch - lowestVisiblePitch + 1 },
    (_, i) => highestVisiblePitch - i,
  );
  const selectedBasePitch = track?.basePitch ?? DEFAULT_BASE_PITCH;
  const cell = CELL * horizontalZoom;
  const row = ROW;
  // The loop, cut to the score (fewer bars can leave part of it, or all of it, beyond the end)
  const activeLoop = loop && loop.start < totalSteps ? { start: loop.start, end: Math.min(loop.end, totalSteps) } : null;
  // Read by the playback clock, which is not restarted when the loop changes
  const loopRef = useRef(activeLoop);
  loopRef.current = activeLoop;
  /** A step as bar.beat.step, counted from 1 */
  const stepLabel = (step: number) =>
    `M${Math.floor(step / stepsPerBar) + 1}.${Math.floor((step % stepsPerBar) / STEPS_PER_BEAT) + 1}.${(step % STEPS_PER_BEAT) + 1}`;

  const instrumentOf = (item: Track) => instruments.find((instrument) => instrument.id === item.instrumentId);
  const hueOf = (item: Track) => instrumentOf(item)?.hue ?? item.hue;

  /** Lowest and highest pitch a note goes through */
  const pitchSpan = (note: Note): [number, number] => {
    if (!note.bend?.length) return [note.pitch, note.pitch];
    const reached = bendLine(note).map((point) => note.pitch + point.semitones);
    return [Math.min(...reached), Math.max(...reached)];
  };
  /** A note drawn in the rows shown */
  const inView = (note: Note) => {
    const [lowest, highest] = pitchSpan(note);
    return note.start < totalSteps && highest >= lowestVisiblePitch && lowest <= highestVisiblePitch;
  };
  /** A note with a curve, drawn as a ribbon: its box in the lane, and its line in the box, through the middle of the rows */
  const ribbonOf = (note: Note) => {
    const [lowest, highest] = pitchSpan(note);
    const width = note.length * cell - 2;
    const yOf = (semitones: number) => (highest - note.pitch - semitones) * row + row / 2 - 0.5;
    const points = bendLine(note).map((point) => ({ x: Math.min(width, point.at * cell), y: yOf(point.semitones) }));
    return {
      box: { left: note.start * cell + 1, top: (highestVisiblePitch - highest) * row, width, height: (highest - lowest + 1) * row },
      d: points.map((point, i) => `${i ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' '),
      points,
      yOf,
    };
  };
  /** Semitones of a point of a curve, as shown in its tooltip */
  const formatSemitones = (semitones: number) =>
    `${semitones > 0 ? '+' : semitones < 0 ? '−' : ''}${Math.abs(semitones).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} demi-ton${Math.abs(semitones) >= 2 ? 's' : ''}`;

  /** Releases the score notes sounding: playback paused, ended or moved, or the loop starting again */
  const releasePlaying = useCallback(() => {
    for (const id of soundingNotes.current.values()) releaseNote(id);
    soundingNotes.current.clear();
    lastAudioStep.current = -1;
  }, [releaseNote]);

  /** Sends an instrument's sound to its slot, when it changed since it was last sent there */
  const syncInstrument = (slot: number, instrument: Instrument) => {
    const sound = instrumentSound(instrument, engine.maxPartials);
    const key = JSON.stringify(sound);
    if (sentInstruments.current.get(slot) === key) return;
    sentInstruments.current.set(slot, key);
    setInstrument(slot, sound);
  };

  // Another engine or another connection: the slots are sent again
  useEffect(() => sentInstruments.current.clear(), [engine.running, socketOpen]);

  useEffect(() => () => window.clearTimeout(auditionTimer.current), []);
  useEffect(() => () => releaseAllNotes(), [releaseAllNotes]);

  useEffect(() => {
    setBaseNoteDraft(midiToName(selectedBasePitch));
  }, [track?.id, selectedBasePitch]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const scroller = rollScrollRef.current;
      if (scroller) scroller.scrollTop = RULER_HEIGHT + PITCH_WINDOW_CENTER * ROW - scroller.clientHeight / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const clock = playClock.current;
      if (!clock) return;
      const stepSeconds = 60 / bpm / STEPS_PER_BEAT;
      let nextStep = clock.startStep + (performance.now() - clock.startedAt) / 1000 / stepSeconds;
      const zone = loopRef.current;
      if (zone && clock.startStep < zone.end && nextStep >= zone.end) {
        // Back to the start of the loop, keeping the time run past its end so the tempo holds
        nextStep = zone.start + ((nextStep - zone.start) % (zone.end - zone.start));
        playClock.current = { startedAt: performance.now(), startStep: nextStep };
        // The notes at the start of the loop are struck again, even those still sounding at its end
        releasePlaying();
      }
      nextStep = Math.min(totalSteps, nextStep);
      setPlayStep(nextStep);
      if (nextStep >= totalSteps) {
        playingRef.current = false;
        setPlaying(false);
        releasePlaying();
      }
    }, 16);
    return () => window.clearInterval(timer);
  }, [playing, bpm, totalSteps, releasePlaying]);

  // Once playback stops, nothing of the score sounds, whatever ran between the pause and this render
  useEffect(() => {
    if (!playing) return undefined;
    return () => releasePlaying();
  }, [playing, releasePlaying]);

  // Each score note is a note of the engine, with its own attack: it starts at its first step
  // and is released after its last one, whatever the other notes do
  useEffect(() => {
    // The ref too: React can run this effect of a render made while playing after a pause that
    // has already released everything; it would start the notes again, and nothing would release them
    if (!playing || !playingRef.current) return;
    const step = Math.floor(playStep);
    if (step === lastAudioStep.current) return;
    lastAudioStep.current = step;
    const wanted = new Map<string, { note: Note; slot: number; volume: number }>();
    tracks.forEach((item, index) => {
      const instrument = instrumentOf(item);
      if (item.muted || !instrument) return;
      const slot = slotOf(index);
      syncInstrument(slot, instrument);
      for (const note of item.notes) {
        if (note.start <= step && step < note.start + note.length) {
          // Moved to another pitch or start while playing: another note
          wanted.set(`${item.id}:${note.id}:${note.pitch}:${note.start}`, { note, slot, volume: instrument.volume });
        }
      }
    });
    const sounding = soundingNotes.current;
    // Ended, moved, or on a track muted since: released
    for (const [key, id] of sounding) {
      if (!wanted.has(key)) {
        releaseNote(id);
        sounding.delete(key);
      }
    }
    const stepSeconds = 60 / bpm / STEPS_PER_BEAT;
    for (const [key, { note, slot, volume }] of wanted) {
      if (sounding.has(key)) continue;
      const id = nextNoteId.current++;
      sounding.set(key, id);
      // The rest of its curve leaves with it, and the engine follows it to the sample: from the
      // note's start, like the note itself, or from the playhead when it starts in the middle (a seek, a loop)
      const from = step === note.start ? 0 : Math.max(0, playStep - note.start);
      let at = from;
      const glides = note.bend?.length
        ? bendLine(note)
            .filter((point) => point.at > from)
            .map((point) => {
              const glide = { frequency: midiToFrequency(note.pitch + point.semitones), seconds: (point.at - at) * stepSeconds };
              at = point.at;
              return glide;
            })
        : [];
      startNote(id, slot, midiToFrequency(note.pitch + bendAt(note, from)), volume, glides);
    }
  }, [playing, playStep, tracks, instruments, engine.maxPartials, bpm, releaseNote, startNote, setInstrument]);

  useEffect(() => {
    if (!playing || !rollScrollRef.current) return;
    const scroller = rollScrollRef.current;
    const x = 56 + playStep * cell;
    if (x > scroller.scrollLeft + scroller.clientWidth - 48) {
      scroller.scrollLeft = x - scroller.clientWidth * 0.75;
    }
  }, [playing, playStep, cell]);

  const setTracks = (update: (list: Track[]) => Track[]) =>
    setComposition((current) => ({ ...current, tracks: update(current.tracks) }));

  const updateTrack = (id: string, patch: Partial<Track>) =>
    setTracks((list) =>
      list.map((item) => {
        if (item.id !== id) return item;
        if (lockedTracks[id] && !('hidden' in patch)) return item;
        return { ...item, ...patch };
      }),
    );

  const recenterOnPitch = (pitch: number) => {
    setHighestVisiblePitch(pitch + PITCH_WINDOW_CENTER);
    setLowestVisiblePitch(pitch + PITCH_WINDOW_CENTER - INITIAL_PITCH_ROWS + 1);
    requestAnimationFrame(() => {
      const scroller = rollScrollRef.current;
      if (scroller) scroller.scrollTop = RULER_HEIGHT + PITCH_WINDOW_CENTER * ROW - scroller.clientHeight / 2;
    });
  };

  const selectTrack = (item: Track) => {
    setSelectedTrackId(item.id);
    setSelectedNoteId(null);
    recenterOnPitch(item.basePitch ?? DEFAULT_BASE_PITCH);
  };

  const commitBaseNote = () => {
    const pitch = parseNoteName(baseNoteDraft);
    if (pitch === null) {
      setBaseNoteDraft(midiToName(selectedBasePitch));
      return selectedBasePitch;
    }
    updateTrack(track.id, { basePitch: pitch });
    const canonicalName = midiToName(pitch);
    setBaseNoteDraft(canonicalName);
    return pitch;
  };

  const recenterPitchRoll = () => {
    const pitch = commitBaseNote();
    recenterOnPitch(pitch);
  };

  const onPitchScroll = () => {
    const scroller = rollScrollRef.current;
    if (!scroller) return;
    const extensionHeight = PITCH_EXTEND_ROWS * ROW;
    if (scroller.scrollTop < PITCH_EXTEND_EDGE * ROW) {
      // Grow above the current pitches and compensate the scroll so the visible rows stay fixed.
      setHighestVisiblePitch((pitch) => pitch + PITCH_EXTEND_ROWS);
      scroller.scrollTop += extensionHeight;
      if (panRef.current) panRef.current.top += extensionHeight;
    } else if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - PITCH_EXTEND_EDGE * ROW) {
      // Grow below the current pitches. Existing rows keep their absolute vertical positions.
      setLowestVisiblePitch((pitch) => pitch - PITCH_EXTEND_ROWS);
    }
  };

  const reorderTrack = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setTracks((list) => {
      const from = list.findIndex((item) => item.id === sourceId);
      const to = list.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return list;
      const next = [...list];
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  };

  const addTrack = () => {
    const instrument = instruments[tracks.length % instruments.length];
    const created = createTrack(tracks.length + 1, instrument.id, HUES[tracks.length % HUES.length]);
    setTracks((list) => [...list, created]);
    selectTrack(created);
  };

  const removeTrack = (id: string) => {
    if (tracks.length <= 1 || lockedTracks[id]) return;
    const next = tracks.filter((item) => item.id !== id);
    setTracks(() => next);
    setSelectedNoteId(null);
    if (id === track.id) selectTrack(next[0]);
  };

  /** Short preview of a note on its track's instrument, alongside playback, only when the audio is already on */
  const audition = (pitch: number) => {
    if (!canPlay) return;
    const instrument = instrumentOf(track);
    const slot = slotOf(tracks.indexOf(track));
    if (instrument) syncInstrument(slot, instrument);
    // Always the same id: a new preview strikes the previous one again instead of piling up
    startNote(AUDITION_NOTE_ID, slot, midiToFrequency(pitch), instrument?.volume ?? 0.3);
    window.clearTimeout(auditionTimer.current);
    auditionTimer.current = window.setTimeout(() => releaseNote(AUDITION_NOTE_ID), AUDITION_MS);
  };

  const deleteSelectedNote = () => {
    if (!selectedNote || !track || lockedTracks[track.id]) return;
    updateTrack(track.id, { notes: track.notes.filter((item) => item.id !== selectedNote.id) });
    setSelectedNoteId(null);
  };

  const updateSelectedNote = (patch: Partial<Note>) => {
    if (!selectedNote || !track || lockedTracks[track.id]) return;
    const nextPitch = patch.pitch !== undefined ? Math.max(0, Math.min(127, patch.pitch)) : selectedNote.pitch;
    let nextStart = patch.start !== undefined ? Math.max(0, Math.min(totalSteps - 1, patch.start)) : selectedNote.start;
    let nextLength = patch.length !== undefined ? Math.max(1, patch.length) : selectedNote.length;

    if (nextStart + nextLength > totalSteps) {
      if (patch.start !== undefined) {
        nextStart = Math.max(0, totalSteps - nextLength);
      } else {
        nextLength = Math.max(1, totalSteps - nextStart);
      }
    }

    const otherNotesOnPitch = track.notes.filter((n) => n.id !== selectedNote.id && n.pitch === nextPitch);
    const nextNoteOnPitch = otherNotesOnPitch
      .filter((n) => n.start >= nextStart)
      .sort((a, b) => a.start - b.start)[0];
    if (nextNoteOnPitch && nextStart + nextLength > nextNoteOnPitch.start) {
      const availableLength = nextNoteOnPitch.start - nextStart;
      if (availableLength > 0) {
        nextLength = availableLength;
      } else {
        return;
      }
    }

    const prevNoteOnPitch = otherNotesOnPitch.find((n) => n.start < nextStart && n.start + n.length > nextStart);
    if (prevNoteOnPitch) {
      return;
    }

    const updated: Note = {
      ...selectedNote,
      pitch: nextPitch,
      start: nextStart,
      length: nextLength,
    };

    updateTrack(track.id, {
      notes: track.notes.map((n) => (n.id === selectedNote.id ? updated : n)),
    });

    if (patch.pitch !== undefined && patch.pitch !== selectedNote.pitch) {
      audition(nextPitch);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedNoteId && track && !lockedTracks[track.id]) {
          event.preventDefault();
          deleteSelectedNote();
        }
      } else if (event.key === 'Escape') {
        // First the selected note, then the loop
        if (selectedNoteId) {
          event.preventDefault();
          setSelectedNoteId(null);
        } else if (loop) {
          event.preventDefault();
          setLoop(null);
        }
      } else if (selectedNote && track && !lockedTracks[track.id]) {
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          updateSelectedNote({ pitch: selectedNote.pitch + (event.shiftKey ? 12 : 1) });
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          updateSelectedNote({ pitch: selectedNote.pitch - (event.shiftKey ? 12 : 1) });
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          updateSelectedNote({ start: selectedNote.start - (event.shiftKey ? STEPS_PER_BEAT : 1) });
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          updateSelectedNote({ start: selectedNote.start + (event.shiftKey ? STEPS_PER_BEAT : 1) });
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedNoteId, selectedNote, track, lockedTracks, deleteSelectedNote, updateSelectedNote, loop]);

  const onLanePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !track || lockedTracks[track.id]) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const step = Math.floor((event.clientX - rect.left) / cell);
    const pitch = highestVisiblePitch - Math.floor((event.clientY - rect.top) / row);
    if (step < 0 || step >= totalSteps || !Number.isSafeInteger(pitch)) return;

    // Si on clique sur une case déjà occupée par une note de cette piste : la sélectionner
    const covered = track.notes.find((note) => note.pitch === pitch && step >= note.start && step < note.start + note.length);
    if (covered) {
      setSelectedNoteId(covered.id);
      audition(covered.pitch);
      return;
    }

    // Never overlap the next note on the same pitch
    const nextStart = Math.min(
      totalSteps,
      ...track.notes.filter((note) => note.pitch === pitch && note.start > step).map((note) => note.start),
    );

    const maxLength = nextStart - step;
    const initialLength = Math.min(noteLength, maxLength);
    noteDrawRef.current = {
      pointerId: event.pointerId,
      trackId: track.id,
      pitch,
      start: step,
      length: initialLength,
      maxLength,
      x: event.clientX,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftNote({ id: 'draft-note', pitch, start: step, length: initialLength });
  };

  const onLanePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const draw = noteDrawRef.current;
    if (!draw || draw.pointerId !== event.pointerId) return;
    if (!draw.moved && Math.abs(event.clientX - draw.x) < 5) return;
    draw.moved = true;
    const rect = event.currentTarget.getBoundingClientRect();
    const endStep = Math.floor((event.clientX - rect.left) / cell);
    draw.length = Math.max(1, Math.min(draw.maxLength, endStep - draw.start + 1));
    setDraftNote({ id: 'draft-note', pitch: draw.pitch, start: draw.start, length: draw.length });
  };

  const onLanePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const draw = noteDrawRef.current;
    if (!draw || draw.pointerId !== event.pointerId) return;
    const length = draw.moved ? draw.length : Math.min(noteLength, draw.maxLength);
    const note: Note = { id: newId(), pitch: draw.pitch, start: draw.start, length };
    updateTrack(draw.trackId, { notes: [...track.notes, note] });
    noteDrawRef.current = null;
    setDraftNote(null);
    setSelectedNoteId(note.id);
    audition(draw.pitch);
  };

  /** Step and pitch under the pointer; `shiftX` / `shiftY`, how far the whole roll moved on the page, are cancelled */
  const laneCellAt = (lane: HTMLDivElement, clientX: number, clientY: number, shiftX = 0, shiftY = 0) => {
    const rect = lane.getBoundingClientRect();
    return {
      step: Math.floor((clientX + shiftX - rect.left) / cell),
      pitch: highestVisiblePitch - Math.floor((clientY + shiftY - rect.top) / row),
    };
  };

  const onNotePointerDown = (event: PointerEvent<Element>, note: Note) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    setSelectedNoteId(note.id);
    audition(note.pitch);
    if (!track || lockedTracks[track.id] || !laneRef.current || !rollScrollRef.current) return;
    // Held and dragged, the note follows the pointer
    event.currentTarget.setPointerCapture(event.pointerId);
    const grabbed = laneCellAt(laneRef.current, event.clientX, event.clientY);
    const roll = rollScrollRef.current.getBoundingClientRect();
    noteMoveRef.current = {
      pointerId: event.pointerId,
      noteId: note.id,
      trackId: track.id,
      grabStep: grabbed.step - note.start,
      grabPitch: grabbed.pitch - note.pitch,
      x: event.clientX,
      y: event.clientY,
      rollLeft: roll.left,
      rollTop: roll.top,
      lastPitch: note.pitch,
      moved: false,
    };
  };

  const onNotePointerMove = (event: PointerEvent<Element>) => {
    const move = noteMoveRef.current;
    if (!move || move.pointerId !== event.pointerId || !laneRef.current || !rollScrollRef.current) return;
    if (!move.moved && Math.hypot(event.clientX - move.x, event.clientY - move.y) < 4) return;
    if (!move.moved) {
      move.moved = true;
      setMovingNoteId(move.noteId);
    }
    const note = track?.id === move.trackId ? track.notes.find((item) => item.id === move.noteId) : undefined;
    if (!note) return;
    // A move of the whole roll on the page is not a move of the pointer
    const roll = rollScrollRef.current.getBoundingClientRect();
    const target = laneCellAt(laneRef.current, event.clientX, event.clientY, roll.left - move.rollLeft, roll.top - move.rollTop);
    const start = Math.max(0, Math.min(totalSteps - note.length, target.step - move.grabStep));
    const pitch = Math.max(0, lowestVisiblePitch, Math.min(127, highestVisiblePitch, target.pitch - move.grabPitch));
    if (start === note.start && pitch === note.pitch) return;
    // Never over another note of the same pitch: the note waits at its last free place
    const overlaps = track.notes.some(
      (other) => other.id !== note.id && other.pitch === pitch && other.start < start + note.length && start < other.start + other.length,
    );
    if (overlaps) return;
    updateTrack(track.id, { notes: track.notes.map((item) => (item.id === note.id ? { ...item, start, pitch } : item)) });
    if (pitch !== move.lastPitch) {
      move.lastPitch = pitch;
      audition(pitch);
    }
  };

  const endNoteMove = (event: PointerEvent<Element>) => {
    const move = noteMoveRef.current;
    if (!move || move.pointerId !== event.pointerId) return;
    noteMoveRef.current = null;
    setMovingNoteId(null);
  };

  /** Replaces the curve of a note of the selected track */
  const setBend = (noteId: string, bend: BendPoint[]) => {
    updateTrack(track.id, { notes: track.notes.map((item) => (item.id === noteId ? { ...item, bend } : item)) });
  };

  /** Steps and pitch (fractions included, the middle of a row being its whole pitch) under the pointer */
  const lanePositionAt = (clientX: number, clientY: number) => {
    const rect = laneRef.current!.getBoundingClientRect();
    return { step: (clientX - rect.left) / cell, pitch: highestVisiblePitch + 0.5 - (clientY - rect.top) / row };
  };

  // A double click on a note adds a point to its curve there, on the line, ready to be dragged
  const onNoteDoubleClick = (event: MouseEvent<Element>, note: Note) => {
    if (!track || lockedTracks[track.id] || !laneRef.current) return;
    const points = note.bend ?? [];
    if (points.length >= MAX_BEND_POINTS) return;
    const raw = lanePositionAt(event.clientX, event.clientY).step - note.start;
    const at = event.shiftKey ? Math.round(raw * 100) / 100 : Math.round(raw * 4) / 4;
    if (at <= 0 || at > note.length || points.some((point) => Math.abs(point.at - at) < 0.01)) return;
    const semitones = Math.round(bendAt(note, at) * 100) / 100;
    setBend(note.id, [...points, { at, semitones }].sort((a, b) => a.at - b.at));
    setSelectedNoteId(note.id);
  };

  const onBendPointerDown = (event: PointerEvent<Element>, note: Note, index: number) => {
    if (event.button !== 0 || !track || lockedTracks[track.id]) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = note.bend![index];
    bendDragRef.current = {
      pointerId: event.pointerId,
      noteId: note.id,
      index,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      heard: point.semitones,
    };
  };

  // A point follows the pointer: by quarter steps and semitones, freely with Shift (like a theremin),
  // never past its neighbours
  const onBendPointerMove = (event: PointerEvent<Element>) => {
    const drag = bendDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !laneRef.current) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
    drag.moved = true;
    const note = track.notes.find((item) => item.id === drag.noteId);
    const points = note?.bend;
    if (!note || !points?.[drag.index]) return;
    const free = event.shiftKey;
    const position = lanePositionAt(event.clientX, event.clientY);
    const gap = free ? 0.01 : 0.25;
    const after = drag.index > 0 ? points[drag.index - 1].at + gap : gap;
    const before = drag.index < points.length - 1 ? points[drag.index + 1].at - gap : note.length;
    const rawAt = position.step - note.start;
    const at = Math.max(after, Math.min(before, free ? Math.round(rawAt * 100) / 100 : Math.round(rawAt * 4) / 4));
    const rawSemitones = position.pitch - note.pitch;
    const semitones = Math.max(
      -note.pitch,
      Math.min(127 - note.pitch, free ? Math.round(rawSemitones * 100) / 100 : Math.round(rawSemitones)),
    );
    const point = points[drag.index];
    if (at === point.at && semitones === point.semitones) return;
    setBend(note.id, points.map((item, i) => (i === drag.index ? { at, semitones } : item)));
    // Heard at every semitone, or every quarter of one when free
    const heard = free ? Math.round(semitones * 4) / 4 : semitones;
    if (heard !== drag.heard) {
      drag.heard = heard;
      audition(note.pitch + semitones);
    }
  };

  const endBendDrag = (event: PointerEvent<Element>) => {
    const drag = bendDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    bendDragRef.current = null;
  };

  // A double click on a point removes it
  const onBendDoubleClick = (event: MouseEvent<Element>, note: Note, index: number) => {
    event.stopPropagation();
    if (!track || lockedTracks[track.id] || !note.bend) return;
    setBend(note.id, note.bend.filter((_, i) => i !== index));
  };

  const onResizePointerDown = (event: PointerEvent<HTMLDivElement>, note: Note, edge: 'start' | 'end') => {
    if (event.button !== 0 || !track || lockedTracks[track.id]) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedNoteId(note.id);

    const otherNotesOnPitch = track.notes.filter((n) => n.id !== note.id && n.pitch === note.pitch);

    const nextNote = otherNotesOnPitch
      .filter((n) => n.start >= note.start + note.length)
      .sort((a, b) => a.start - b.start)[0];
    const maxEnd = nextNote ? nextNote.start : totalSteps;

    const prevNote = otherNotesOnPitch
      .filter((n) => n.start < note.start)
      .sort((a, b) => b.start - a.start)[0];
    const minStart = prevNote ? prevNote.start + prevNote.length : 0;

    noteResizeRef.current = {
      pointerId: event.pointerId,
      noteId: note.id,
      edge,
      pitch: note.pitch,
      originalStart: note.start,
      originalLength: note.length,
      minStart,
      maxEnd,
      startX: event.clientX,
      moved: false,
      originalBend: note.bend,
    };
  };

  const onResizePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const resize = noteResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (!resize.moved && Math.abs(event.clientX - resize.startX) < 4) return;
    resize.moved = true;
    const note = track.notes.find((n) => n.id === resize.noteId);
    if (!note) return;
    // The edge goes to the grid line nearest to where it is dragged, whatever point of the handle was grabbed
    const steps = Math.round((event.clientX - resize.startX) / cell);
    const originalEnd = resize.originalStart + resize.originalLength;
    let start = resize.originalStart;
    let length = resize.originalLength;
    if (resize.edge === 'end') {
      length = Math.max(1, Math.min(resize.maxEnd, originalEnd + steps) - resize.originalStart);
    } else {
      start = Math.max(resize.minStart, Math.min(originalEnd - 1, resize.originalStart + steps));
      length = originalEnd - start;
    }
    if (start === note.start && length === note.length) return;
    // The points keep their time: those the new start passes are dropped
    const shift = start - resize.originalStart;
    const bend = resize.originalBend?.map((point) => ({ ...point, at: point.at - shift })).filter((point) => point.at > 0);
    updateTrack(track.id, {
      notes: track.notes.map((n) => (n.id === resize.noteId ? { ...n, start, length, ...(bend ? { bend } : {}) } : n)),
    });
  };

  const onResizePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const resize = noteResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (resize.moved) {
      audition(resize.pitch);
    }
    noteResizeRef.current = null;
  };

  const onResizePointerCancel = () => {
    noteResizeRef.current = null;
  };

  /** The wheel scrolls the roll; with Ctrl (a touchpad pinch too) or Alt, it zooms horizontally around the pointer */
  const onRollWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.altKey) return;
    // Taken: the browser does not zoom, the roll does not scroll (the listener is not passive)
    event.preventDefault();
    if (event.deltaY === 0) return;
    const pixels = event.deltaY * (event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_PAGE_PX : 1);
    const factor = Math.max(0.5, Math.min(2, WHEEL_NOTCH_ZOOM ** (-pixels / WHEEL_NOTCH_PX)));
    const nextZoom = Math.max(MIN_HORIZONTAL_ZOOM, Math.min(MAX_HORIZONTAL_ZOOM, horizontalZoom * factor));
    const scroller = rollScrollRef.current;
    let targetScrollLeft = 0;
    if (scroller) {
      const bounds = scroller.getBoundingClientRect();
      const anchor = event.clientX - bounds.left + scroller.scrollLeft;
      targetScrollLeft = anchor * (nextZoom / horizontalZoom) - (event.clientX - bounds.left);
    }
    setHorizontalZoom(nextZoom);
    requestAnimationFrame(() => {
      if (rollScrollRef.current) rollScrollRef.current.scrollLeft = targetScrollLeft;
    });
  };
  // React's wheel listeners are passive and cannot stop the browser's zoom: a native one, calling the latest handler
  const rollWheelRef = useRef(onRollWheel);
  rollWheelRef.current = onRollWheel;
  useEffect(() => {
    const scroller = rollScrollRef.current;
    if (!scroller) return undefined;
    const listener = (event: WheelEvent) => rollWheelRef.current(event);
    scroller.addEventListener('wheel', listener, { passive: false });
    return () => scroller.removeEventListener('wheel', listener);
  }, []);

  const onRollPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: event.currentTarget.scrollLeft,
      top: event.currentTarget.scrollTop,
    };
  };

  const onRollPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.currentTarget.scrollLeft = pan.left - (event.clientX - pan.x);
    event.currentTarget.scrollTop = pan.top - (event.clientY - pan.y);
  };

  /** Moves the playhead; while playing, playback goes on from there */
  const seekTo = (step: number) => {
    setPlayStep(step);
    playClock.current = { startedAt: performance.now(), startStep: step };
    releasePlaying();
  };

  const rulerStepAt = (ruler: HTMLDivElement, clientX: number) =>
    Math.max(0, Math.min(totalSteps - 1, Math.floor((clientX - ruler.getBoundingClientRect().left) / cell)));

  // On the ruler, like on the Analyzer's waveform: a click places the playhead and removes the loop, a drag selects the loop
  const onRulerPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const step = rulerStepAt(event.currentTarget, event.clientX);
    rulerPressRef.current = { pointerId: event.pointerId, x: event.clientX, step, selecting: false };
    seekTo(step);
  };

  const onRulerPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const press = rulerPressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    if (!press.selecting && Math.abs(event.clientX - press.x) < 4) return;
    if (!press.selecting) {
      press.selecting = true;
      setRulerSelecting(true);
    }
    // Whole steps, from the one pressed to the one under the pointer
    const step = rulerStepAt(event.currentTarget, event.clientX);
    const zone = { start: Math.min(press.step, step), end: Math.max(press.step, step) + 1 };
    if (zone.start !== loop?.start || zone.end !== loop?.end) setLoop(zone);
    // The playhead goes to the start of the loop
    if (zone.start !== loop?.start) seekTo(zone.start);
  };

  const onRulerPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const press = rulerPressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    // A click, not a drag: it removes the loop
    if (event.type === 'pointerup' && !press.selecting) setLoop(null);
    rulerPressRef.current = null;
    setRulerSelecting(false);
  };

  const startPlayback = async () => {
    const performers = audibleTracks(tracks).filter((item) => item.notes.length > 0);
    if (!performers.length || busy || connection !== 'online' || !coreLoaded || !socketOpen) return;
    if (!canPlay) {
      const instrument = instrumentOf(performers[0]);
      const started = await startAudio(instrument ? instrumentParams(instrument, engine.maxPartials) : {});
      if (!started) return;
    }
    let startStep = playStep >= totalSteps ? 0 : playStep;
    // From outside the loop, playback starts at its start
    if (activeLoop && (startStep < activeLoop.start || startStep >= activeLoop.end)) startStep = activeLoop.start;
    setPlayStep(startStep);
    releasePlaying();
    playClock.current = { startedAt: performance.now(), startStep };
    playingRef.current = true;
    setPlaying(true);
  };

  const pausePlayback = () => {
    playingRef.current = false;
    setPlaying(false);
    releasePlaying();
  };

  // The space bar is the play / pause button: playback goes on from the playhead
  useSpaceBar(() => {
    if (playing) pausePlayback();
    else void startPlayback();
  });

  // Overview: how many audible notes sound on each step
  const density = new Array<number>(totalSteps).fill(0);
  for (const item of audibleTracks(tracks)) {
    for (const note of item.notes) {
      for (let step = note.start; step < Math.min(totalSteps, note.start + note.length); step += 1) {
        density[step] += 1;
      }
    }
  }

  const gridStyle = {
    '--cell': `${cell}px`,
    '--row': `${row}px`,
    '--bar': `${cell * stepsPerBar}px`,
    '--grid-width': `${cell * totalSteps}px`,
    '--grid-height': `${row * pitches.length}px`,
  } as CSSProperties;
  const displayStep = Math.min(playStep, Math.max(0, totalSteps - 1));

  return (
    <div className={layout.screen}>
      <ScreenHeader
        index="04"
        eyebrow="Arrangement"
        title="Composer"
        subtitle="Écris tes motifs piste par piste, chacune jouée par un de tes instruments."
      >
        <Segmented
          compact
          label="Longueur des nouvelles notes"
          options={NOTE_LENGTHS}
          value={noteLength}
          onChange={setNoteLength}
        />
        <label className={styles.rangeField}>
          Note de base
          <input
            className={inputClass}
            aria-label="Note de base de la piste"
            title="Saisir une note comme C0, B10 ou A-3"
            value={baseNoteDraft}
            disabled={!track || !!lockedTracks[track.id]}
            onChange={(event) => setBaseNoteDraft(event.target.value)}
            onBlur={commitBaseNote}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitBaseNote();
                event.currentTarget.blur();
              }
            }}
          />
          <Button size="small" iconOnly aria-label="Recentrer le piano roll sur la note de base" title={`Recentrer sur ${baseNoteDraft || midiToName(selectedBasePitch)}`} onClick={recenterPitchRoll}>
            <Crosshair size={15} />
          </Button>
        </label>
        <label className={styles.bpmField}>
          BPM
          <input
            className={inputClass}
            type="number"
            min={40}
            max={240}
            value={bpm}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (value >= 40 && value <= 240) setComposition((current) => ({ ...current, bpm: value }));
            }}
          />
        </label>
        <select
          className={selectClass}
          aria-label="Nombre de mesures"
          value={bars}
          onChange={(event) => setComposition((current) => ({ ...current, bars: Number(event.target.value) }))}
        >
          {[2, 4, 8, 16].map((count) => (
            <option key={count} value={count}>
              {count} mesures
            </option>
          ))}
        </select>
        <Button
          disabled={!track || track.notes.length === 0 || !!lockedTracks[track?.id ?? '']}
          onClick={() => {
            updateTrack(track.id, { notes: [] });
            setSelectedNoteId(null);
          }}
          title="Effacer toutes les notes de la piste sélectionnée"
        >
          <Eraser size={15} />
          Effacer la piste
        </Button>
      </ScreenHeader>

      <div className={styles.body}>
        <Panel className={styles.tracks}>
          <div className={styles.tracksHead}>
            <h2 className={styles.panelTitle}>
              Pistes <span className={styles.count}>{tracks.length}</span>
            </h2>
            <Button size="small" iconOnly aria-label="Ajouter une piste" title="Ajouter une piste" onClick={addTrack}>
              <Plus size={15} />
            </Button>
          </div>
          <div className={styles.trackList}>
            {tracks.map((item) => {
              const instrument = instrumentOf(item);
              return (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={item.id === track.id}
                  className={cx(
                    styles.track,
                    item.id === track.id && styles.trackSelected,
                    !audibleTracks(tracks).includes(item) && styles.trackMuted,
                    draggedTrackId === item.id && styles.trackDragging,
                    dropTargetId === item.id && draggedTrackId !== item.id && styles.trackDropTarget,
                  )}
                  style={{ '--hue': HUE_VAR[hueOf(item)] } as CSSProperties}
                  data-track-id={item.id}
                  onClick={() => selectTrack(item)}
                  onKeyDown={(event) => {
                    // Not the space bar: it plays and pauses the score
                    if (event.target === event.currentTarget && event.key === 'Enter') {
                      event.preventDefault();
                      selectTrack(item);
                    }
                  }}
                >
                  <div className={styles.trackTop}>
                    <button
                      type="button"
                      className={styles.dragHandle}
                      aria-label={`Déplacer ${item.name}`}
                      title="Glisser pour réordonner les pistes"
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        trackDragRef.current = {
                          id: item.id,
                          pointerId: event.pointerId,
                          x: event.clientX,
                          y: event.clientY,
                          moved: false,
                        };
                      }}
                      onPointerMove={(event) => {
                        const drag = trackDragRef.current;
                        if (!drag || drag.pointerId !== event.pointerId) return;
                        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
                        if (!drag.moved) {
                          drag.moved = true;
                          setDraggedTrackId(drag.id);
                        }
                        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-track-id]');
                        setDropTargetId(target?.dataset.trackId ?? null);
                      }}
                      onPointerUp={(event) => {
                        const drag = trackDragRef.current;
                        if (!drag || drag.pointerId !== event.pointerId) return;
                        if (drag.moved && dropTargetId) reorderTrack(drag.id, dropTargetId);
                        trackDragRef.current = null;
                        setDraggedTrackId(null);
                        setDropTargetId(null);
                      }}
                      onPointerCancel={() => {
                        trackDragRef.current = null;
                        setDraggedTrackId(null);
                        setDropTargetId(null);
                      }}
                    >
                      <GripVertical size={14} />
                    </button>
                    <span className={styles.trackDot} />
                    <input
                      className={styles.trackName}
                      value={item.name}
                      readOnly={!!lockedTracks[item.id]}
                      maxLength={24}
                      aria-label="Nom de la piste"
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateTrack(item.id, { name: event.target.value })}
                    />
                    <button
                      type="button"
                      className={styles.trackLock}
                      aria-label={lockedTracks[item.id] ? `Déverrouiller ${item.name}` : `Verrouiller ${item.name}`}
                      aria-pressed={!!lockedTracks[item.id]}
                      title={lockedTracks[item.id] ? 'Déverrouiller la piste' : 'Verrouiller la piste contre les modifications'}
                      onClick={(event) => {
                        event.stopPropagation();
                        setLockedTracks((current) => ({ ...current, [item.id]: !current[item.id] }));
                      }}
                    >
                      {lockedTracks[item.id] ? <Lock size={13} /> : <LockOpen size={13} />}
                    </button>
                    <button
                      type="button"
                      className={styles.ms}
                      data-kind="mute"
                      aria-pressed={item.muted}
                      title={item.muted ? 'Activer le son de la piste' : 'Couper le son de la piste (Muet)'}
                      disabled={!!lockedTracks[item.id]}
                      onClick={(event) => {
                        event.stopPropagation();
                        updateTrack(item.id, { muted: !item.muted });
                      }}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      className={styles.trackVisibility}
                      aria-label={item.hidden ? `Afficher ${item.name} sur le piano roll` : `Masquer ${item.name} du piano roll`}
                      aria-pressed={!item.hidden}
                      title={item.hidden ? 'Afficher les notes sur le piano roll' : 'Masquer les notes sur le piano roll'}
                      onClick={(event) => {
                        event.stopPropagation();
                        updateTrack(item.id, { hidden: !item.hidden });
                      }}
                    >
                      {item.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                  <select
                    className={cx(selectClass, styles.trackInstrument)}
                    aria-label="Instrument de la piste"
                    value={item.instrumentId}
                    disabled={!!lockedTracks[item.id]}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => updateTrack(item.id, { instrumentId: event.target.value })}
                  >
                    {!instrument && <option value={item.instrumentId}>Instrument supprimé</option>}
                    {instruments.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                  <div className={styles.trackMeta}>
                    <span>
                      {item.notes.length} note{item.notes.length > 1 ? 's' : ''}
                    </span>
                    <button
                      type="button"
                      className={styles.miniBtn}
                      aria-label={`Supprimer ${item.name}`}
                      title={tracks.length > 1 ? 'Supprimer la piste' : 'Il faut garder au moins une piste'}
                      disabled={tracks.length <= 1 || !!lockedTracks[item.id]}
                      onClick={(event) => {
                        event.stopPropagation();
                        removeTrack(item.id);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel className={styles.roll}>
          <div className={styles.rollHead}>
            <h2 className={styles.panelTitle}>
              Piano roll <span className={styles.count}>{track?.name}</span>
            </h2>
            <span className={styles.rollHint}>
              Règle : clic = curseur, glisser = zone en boucle · Molette : défiler · Ctrl + molette : zoom horizontal · clic milieu : déplacer · clic : ajouter une note · glisser une note : la déplacer · bords : redimensionner · double-clic sur une note : point de glissé, à glisser (Maj : librement) · clic sur une note : sélectionner (Suppr pour effacer)
              {lockedTracks[track?.id ?? ''] ? ' · piste verrouillée' : ''}
              {canPlay ? ' · aperçu sonore actif' : ''}
            </span>
          </div>

          {/* Always in place, empty without a selected note: selecting one does not move the roll under the pointer */}
          <div className={cx(styles.noteInspector, !selectedNote && styles.noteInspectorEmpty)}>
            <div className={styles.noteInspectorTitle}>
              <span className={styles.noteInspectorDot} style={{ background: HUE_VAR[hueOf(track)] }} />
              {selectedNote ? (
                <>
                  <span className={styles.noteInspectorPitch}>{midiToName(selectedNote.pitch)}</span>
                  <span className={styles.noteInspectorFreq}>({Math.round(midiToFrequency(selectedNote.pitch) * 10) / 10} Hz)</span>
                </>
              ) : (
                <span className={styles.noteInspectorFreq}>Aucune note</span>
              )}
            </div>

            <div className={styles.noteInspectorGroup}>
              <span className={styles.noteInspectorLabel}>Hauteur</span>
              <Button
                size="small"
                disabled={!noteEditable || selectedNote.pitch <= 11}
                onClick={() => selectedNote && updateSelectedNote({ pitch: selectedNote.pitch - 12 })}
                title="Descendre d'une octave (Maj + Bas)"
              >
                -12
              </Button>
              <Button
                size="small"
                disabled={!noteEditable || selectedNote.pitch <= 0}
                onClick={() => selectedNote && updateSelectedNote({ pitch: selectedNote.pitch - 1 })}
                title="Descendre d'un demi-ton (Bas)"
              >
                -1
              </Button>
              <Button
                size="small"
                disabled={!noteEditable || selectedNote.pitch >= 127}
                onClick={() => selectedNote && updateSelectedNote({ pitch: selectedNote.pitch + 1 })}
                title="Monter d'un demi-ton (Haut)"
              >
                +1
              </Button>
              <Button
                size="small"
                disabled={!noteEditable || selectedNote.pitch >= 116}
                onClick={() => selectedNote && updateSelectedNote({ pitch: selectedNote.pitch + 12 })}
                title="Monter d'une octave (Maj + Haut)"
              >
                +12
              </Button>
            </div>

            <div className={styles.noteInspectorGroup}>
              <span className={styles.noteInspectorLabel}>Durée</span>
              {NOTE_LENGTHS.map((opt) => (
                <Button
                  key={opt.value}
                  size="small"
                  disabled={!noteEditable}
                  variant={selectedNote?.length === opt.value ? 'primary' : undefined}
                  onClick={() => updateSelectedNote({ length: opt.value })}
                  title={`${opt.title} (${opt.value} pas)`}
                >
                  {opt.label}
                </Button>
              ))}
              <span
                className={styles.noteInspectorPosText}
                title={selectedNote ? `${selectedNote.length} double${selectedNote.length > 1 ? 's' : ''} croche${selectedNote.length > 1 ? 's' : ''} (pas)` : undefined}
              >
                {selectedNote ? `${selectedNote.length}/16` : '–'}
              </span>
            </div>

            <div className={styles.noteInspectorGroup}>
              <span className={styles.noteInspectorLabel}>Position</span>
              <Button
                size="small"
                iconOnly
                disabled={!noteEditable || selectedNote.start <= 0}
                onClick={() => selectedNote && updateSelectedNote({ start: selectedNote.start - 1 })}
                title="Reculer d'un pas (Gauche)"
              >
                <ArrowLeft size={13} />
              </Button>
              <span className={styles.noteInspectorPosText}>
                {selectedNote
                  ? `M${Math.floor(selectedNote.start / stepsPerBar) + 1}.${Math.floor((selectedNote.start % stepsPerBar) / STEPS_PER_BEAT) + 1}.${(selectedNote.start % STEPS_PER_BEAT) + 1}`
                  : '–'}
              </span>
              <Button
                size="small"
                iconOnly
                disabled={!noteEditable || selectedNote.start + selectedNote.length >= totalSteps}
                onClick={() => selectedNote && updateSelectedNote({ start: selectedNote.start + 1 })}
                title="Avancer d'un pas (Droite)"
              >
                <ArrowRight size={13} />
              </Button>
            </div>

            <div className={styles.noteInspectorGroup}>
              <span className={styles.noteInspectorLabel}>Glissé</span>
              <span
                className={styles.noteInspectorPosText}
                title="Points de la courbe de hauteur : double-clic sur la note pour en ajouter un, puis le glisser"
              >
                {selectedNote?.bend?.length ? `${selectedNote.bend.length} pt${selectedNote.bend.length > 1 ? 's' : ''}` : '–'}
              </span>
              <Button
                size="small"
                disabled={!noteEditable || !selectedNote.bend?.length}
                onClick={() => selectedNote && setBend(selectedNote.id, [])}
                title="Retirer la courbe : la note reste à sa hauteur de départ"
              >
                Aplatir
              </Button>
            </div>

            <div className={styles.noteInspectorActions}>
              <Button
                size="small"
                disabled={!noteEditable}
                className={styles.deleteNoteBtn}
                onClick={deleteSelectedNote}
                title="Supprimer la note sélectionnée (Touche Suppr ou Retour arrière)"
              >
                <Trash2 size={13} />
                Supprimer
              </Button>
              <Button
                size="small"
                iconOnly
                disabled={!selectedNote}
                onClick={() => setSelectedNoteId(null)}
                title="Désélectionner (Échap)"
              >
                <X size={14} />
              </Button>
            </div>
          </div>

          <div
            className={styles.rollScroll}
            ref={rollScrollRef}
            onScroll={onPitchScroll}
            onPointerDown={onRollPointerDown}
            onPointerMove={onRollPointerMove}
            onPointerUp={() => { panRef.current = null; }}
            onPointerCancel={() => { panRef.current = null; }}
          >
            <div className={styles.rollGrid} style={gridStyle}>
              <div className={styles.corner} />
              <div
                className={cx(styles.ruler, rulerSelecting && styles.rulerSelecting)}
                onPointerDown={onRulerPointerDown}
                onPointerMove={onRulerPointerMove}
                onPointerUp={onRulerPointerUp}
                onPointerCancel={onRulerPointerUp}
                title="Cliquer pour placer le curseur de lecture · glisser pour choisir une zone lue en boucle (un clic ou Échap la retire)"
              >
                {Array.from({ length: bars }, (_, bar) => (
                  <div key={bar} className={styles.rulerBar} style={{ width: cell * stepsPerBar }}>
                    {bar + 1}
                  </div>
                ))}
                {activeLoop && (
                  <div
                    className={styles.loopRuler}
                    style={{ left: activeLoop.start * cell, width: (activeLoop.end - activeLoop.start) * cell }}
                    aria-hidden="true"
                  />
                )}
              </div>
              <div className={styles.keys}>
                {pitches.map((pitch) => (
                  <div
                    key={pitch}
                    className={cx(
                      styles.keyRow,
                      isBlackKey(pitch) && styles.keyRowBlack,
                      pitch % 12 === 0 && styles.keyRowC,
                    )}
                  >
                    {pitch % 12 === 0 ? midiToName(pitch) : ''}
                  </div>
                ))}
              </div>
              <div
                className={styles.lane}
                ref={laneRef}
                onPointerDown={onLanePointerDown}
                onPointerMove={onLanePointerMove}
                onPointerUp={onLanePointerUp}
                onPointerCancel={() => {
                  noteDrawRef.current = null;
                  setDraftNote(null);
                }}
                role="grid"
                aria-label="Grille de notes"
              >
                {pitches.map((pitch) => (
                  <div
                    key={pitch}
                    className={cx(
                      styles.laneRow,
                      isBlackKey(pitch) && styles.laneRowBlack,
                      pitch % 12 === 0 && styles.laneRowC,
                    )}
                  />
                ))}
                {activeLoop && (
                  <div
                    className={styles.loopLane}
                    style={{ left: activeLoop.start * cell, width: (activeLoop.end - activeLoop.start) * cell }}
                    aria-hidden="true"
                  />
                )}
                {/* Ghost notes des autres pistes visibles */}
                {tracks
                  .filter((other) => other.id !== track.id && !other.hidden)
                  .map((other) => {
                    const otherHue = hueOf(other);
                    return other.notes.filter(inView).map((note) => {
                      if (note.bend?.length) {
                        const ribbon = ribbonOf(note);
                        return (
                          <div
                            key={`ghost-${other.id}-${note.id}`}
                            className={cx(styles.bentNote, styles.ghost)}
                            style={{ '--hue': HUE_VAR[otherHue], ...ribbon.box } as CSSProperties}
                            aria-hidden="true"
                          >
                            <svg className={styles.ribbon} width={ribbon.box.width} height={ribbon.box.height}>
                              <path d={ribbon.d} className={styles.ribbonLine} style={{ strokeWidth: row - 3 }} />
                            </svg>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={`ghost-${other.id}-${note.id}`}
                          className={cx(styles.note, styles.ghost)}
                          title={`${other.name} · ${midiToName(note.pitch)}`}
                          style={
                            {
                              '--hue': HUE_VAR[otherHue],
                              left: note.start * cell + 1,
                              top: (highestVisiblePitch - note.pitch) * row,
                              width: note.length * cell - 2,
                            } as CSSProperties
                          }
                          aria-hidden="true"
                        />
                      );
                    });
                  })}
                {/* Notes de la piste sélectionnée actuellement (sur laquelle on travaille) */}
                {track.notes.filter(inView).map((note) => {
                    const isSelected = note.id === selectedNoteId;
                    const locked = Boolean(lockedTracks[track.id]);
                    if (note.bend?.length) {
                      // A note with a curve: a ribbon through the rows, its points to drag when it is selected
                      const ribbon = ribbonOf(note);
                      const first = ribbon.points[0];
                      const last = ribbon.points[ribbon.points.length - 1];
                      const handleHeight = row - 3;
                      return (
                        <div
                          key={note.id}
                          className={cx(
                            styles.bentNote,
                            isSelected && styles.bentNoteSelected,
                            note.id === movingNoteId && styles.noteMoving,
                            locked && styles.noteLocked,
                          )}
                          style={{ '--hue': HUE_VAR[hueOf(track)], ...ribbon.box } as CSSProperties}
                        >
                          <svg className={styles.ribbon} width={ribbon.box.width} height={ribbon.box.height}>
                            {isSelected && <path d={ribbon.d} className={styles.ribbonOutline} style={{ strokeWidth: row + 1 }} />}
                            <path
                              d={ribbon.d}
                              className={styles.ribbonLine}
                              style={{ strokeWidth: row - 3 }}
                              onPointerDown={(event) => onNotePointerDown(event, note)}
                              onPointerMove={onNotePointerMove}
                              onPointerUp={endNoteMove}
                              onPointerCancel={endNoteMove}
                              onDoubleClick={(event) => onNoteDoubleClick(event, note)}
                            >
                              <title>
                                {`${midiToName(note.pitch)} qui glisse (${note.length} pas, ${note.bend.length} point${note.bend.length > 1 ? 's' : ''}) · glisser pour déplacer · double-clic : ajouter un point · Suppr pour effacer`}
                              </title>
                            </path>
                            {isSelected &&
                              !locked &&
                              note.bend.map((point, index) =>
                                point.at > note.length ? null : (
                                  <circle
                                    key={index}
                                    className={styles.bendPoint}
                                    cx={Math.min(ribbon.box.width, point.at * cell)}
                                    cy={ribbon.yOf(point.semitones)}
                                    r={4.5}
                                    onPointerDown={(event) => onBendPointerDown(event, note, index)}
                                    onPointerMove={onBendPointerMove}
                                    onPointerUp={endBendDrag}
                                    onPointerCancel={endBendDrag}
                                    onDoubleClick={(event) => onBendDoubleClick(event, note, index)}
                                  >
                                    <title>{`${formatSemitones(point.semitones)} · glisser pour déplacer (Maj : librement) · double-clic : retirer`}</title>
                                  </circle>
                                ),
                              )}
                          </svg>
                          <div
                            className={cx(styles.resizeHandle, styles.resizeHandleLeft)}
                            style={{ top: first.y - handleHeight / 2, height: handleHeight, bottom: 'auto' }}
                            title="Glisser pour ajuster le début"
                            onPointerDown={(event) => onResizePointerDown(event, note, 'start')}
                            onPointerMove={onResizePointerMove}
                            onPointerUp={onResizePointerUp}
                            onPointerCancel={onResizePointerCancel}
                          />
                          <div
                            className={cx(styles.resizeHandle, styles.resizeHandleRight)}
                            style={{ top: last.y - handleHeight / 2, height: handleHeight, bottom: 'auto' }}
                            title="Glisser pour ajuster la durée"
                            onPointerDown={(event) => onResizePointerDown(event, note, 'end')}
                            onPointerMove={onResizePointerMove}
                            onPointerUp={onResizePointerUp}
                            onPointerCancel={onResizePointerCancel}
                          />
                        </div>
                      );
                    }
                    return (
                      <div
                        key={note.id}
                        className={cx(
                          styles.note,
                          isSelected && styles.noteSelected,
                          note.id === movingNoteId && styles.noteMoving,
                          lockedTracks[track.id] && styles.noteLocked,
                        )}
                        title={`${midiToName(note.pitch)} (${note.length} pas) · glisser pour déplacer · glisser les bords pour redimensionner · double-clic : ajouter un point pour la faire glisser · Suppr pour effacer`}
                        style={
                          {
                            '--hue': HUE_VAR[hueOf(track)],
                            left: note.start * cell + 1,
                            top: (highestVisiblePitch - note.pitch) * row,
                            width: note.length * cell - 2,
                          } as CSSProperties
                        }
                        onPointerDown={(event) => onNotePointerDown(event, note)}
                        onPointerMove={onNotePointerMove}
                        onPointerUp={endNoteMove}
                        onPointerCancel={endNoteMove}
                        onDoubleClick={(event) => onNoteDoubleClick(event, note)}
                      >
                        <div
                          className={cx(styles.resizeHandle, styles.resizeHandleLeft)}
                          title="Glisser pour ajuster le début"
                          onPointerDown={(event) => onResizePointerDown(event, note, 'start')}
                          onPointerMove={onResizePointerMove}
                          onPointerUp={onResizePointerUp}
                          onPointerCancel={onResizePointerCancel}
                        />
                        <div
                          className={cx(styles.resizeHandle, styles.resizeHandleRight)}
                          title="Glisser pour ajuster la durée"
                          onPointerDown={(event) => onResizePointerDown(event, note, 'end')}
                          onPointerMove={onResizePointerMove}
                          onPointerUp={onResizePointerUp}
                          onPointerCancel={onResizePointerCancel}
                        />
                      </div>
                    );
                  })}
                {draftNote && (
                  <div
                    className={cx(styles.note, styles.noteDraft)}
                    aria-hidden="true"
                    style={{
                      '--hue': HUE_VAR[hueOf(track)],
                      left: draftNote.start * cell + 1,
                      top: (highestVisiblePitch - draftNote.pitch) * row,
                      width: draftNote.length * cell - 2,
                    } as CSSProperties}
                  />
                )}
                <div className={styles.playhead} style={{ left: playStep * cell }} aria-hidden="true" />
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <Panel as="div" className={cx(layout.dock, styles.dock)}>
        <div className={styles.transport}>
          <button
            type="button"
            className={styles.play}
          disabled={busy || connection !== 'online' || !coreLoaded || !socketOpen}
            aria-label={playing ? 'Pause' : 'Lecture'}
            title={playing ? 'Mettre en pause (Espace)' : canPlay ? 'Lire la partition depuis la tête de lecture (Espace)' : 'Démarrer l’audio et lire la partition depuis la tête de lecture (Espace)'}
            onClick={playing ? pausePlayback : startPlayback}
          >
            {playing ? <Pause size={18} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>
          <Button iconOnly disabled={!playing && playStep === 0} aria-label="Stop" title="Revenir au début" onClick={() => { pausePlayback(); setPlayStep(0); }}>
            <Square size={14} />
          </Button>
          <Button
            iconOnly
            variant={activeLoop ? 'primary' : undefined}
            disabled={!activeLoop}
            aria-label="Boucle"
            aria-pressed={!!activeLoop}
            title={
              activeLoop
                ? `Lecture en boucle de ${stepLabel(activeLoop.start)} à ${stepLabel(activeLoop.end)} · cliquer pour retirer la boucle (Échap)`
                : 'Glisse sur la règle du piano roll pour choisir une zone lue en boucle'
            }
            onClick={() => setLoop(null)}
          >
            <Repeat size={15} />
          </Button>
        </div>
        <div className={styles.position}>
          <span className={styles.positionValue}>
            {`${String(Math.floor(displayStep / stepsPerBar) + 1).padStart(3, '0')}.${Math.floor((displayStep % stepsPerBar) / STEPS_PER_BEAT) + 1}.${Math.floor(displayStep % STEPS_PER_BEAT) + 1}`}
          </span>
          <span className={styles.positionLabel}>Mesure · temps · pas</span>
        </div>
        <div className={styles.overview} aria-hidden="true">
          {density.map((count, step) => (
            <div
              key={step}
              className={cx(
                styles.overviewStep,
                count > 0 && styles.overviewStepOn,
                step > 0 && step % stepsPerBar === 0 && styles.overviewBar,
              )}
              style={{ height: count > 0 ? `${Math.min(100, 30 + count * 25)}%` : undefined }}
            />
          ))}
        </div>
        <div className={styles.tempo}>
          <span className={styles.tempoValue}>{bpm}</span>
          <span className={styles.positionLabel}>BPM · {beatsPerBar}/4</span>
        </div>
        <Badge tone={canPlay ? 'live' : 'soon'} title={canPlay ? 'Lecture par le moteur Synthway' : 'Active l’audio pour lire'}>
          {canPlay ? 'Lecture disponible' : 'Active l’audio'}
        </Badge>
      </Panel>
    </div>
  );
}
