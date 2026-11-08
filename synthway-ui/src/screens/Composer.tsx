import { Crosshair, Eraser, GripVertical, Lock, LockOpen, Pause, Play, Plus, Repeat, Square, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from 'react';
import layout from '../components/layout.module.css';
import { ScreenHeader } from '../components/ScreenHeader';
import { Badge, Button, Panel, Segmented, cx, inputClass, selectClass } from '../components/ui';
import {
  createTrack,
  DEFAULT_BASE_PITCH,
  defaultComposition,
  STEPS_PER_BEAT,
  type Composition,
  type Note,
  type Track,
} from '../lib/composition';
import type { Instrument } from '../lib/instruments';
import { isBlackKey, midiToFrequency, midiToName } from '../lib/music';
import { toTimbre } from '../lib/partials';
import { HUE_VAR, HUES } from '../lib/neon';
import { newId, usePersistentState } from '../lib/storage';
import { useSynthServer } from '../lib/SynthServer';
import styles from './Composer.module.css';

const CELL = 22; // px per step (sixteenth note)
const ROW = 16; // px per semitone
const AUDITION_MS = 180;
const INITIAL_PITCH_ROWS = 240;
const PITCH_WINDOW_CENTER = Math.floor(INITIAL_PITCH_ROWS / 2);
const PITCH_EXTEND_ROWS = 48;
const PITCH_EXTEND_EDGE = 48;
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
  const solo = tracks.filter((track) => track.solo);
  return solo.length > 0 ? solo : tracks.filter((track) => !track.muted);
}

export function Composer({ instruments }: { instruments: Instrument[] }) {
  const { canPlay, noteOn, noteOff, setParams, engine, startAudio, busy, connection, coreLoaded, socketOpen } = useSynthServer();
  const [composition, setComposition] = usePersistentState<Composition>('synthway.composition.v1', defaultComposition);
  const [selectedTrackId, setSelectedTrackId] = useState(() => composition.tracks[0]?.id ?? '');
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
  const [playStep, setPlayStep] = useState(0);
  const playClock = useRef<{ startedAt: number; startStep: number } | null>(null);
  const lastAudioStep = useRef(-1);
  const lastAudioSignature = useRef<string | null>(null);
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
  const initialVerticalCenter = useRef(false);

  const { tracks, bpm, beatsPerBar, bars } = composition;
  const track = tracks.find((item) => item.id === selectedTrackId) ?? tracks[0];
  const stepsPerBar = beatsPerBar * STEPS_PER_BEAT;
  const totalSteps = bars * stepsPerBar;
  const pitches = Array.from(
    { length: highestVisiblePitch - lowestVisiblePitch + 1 },
    (_, i) => highestVisiblePitch - i,
  );
  const selectedBasePitch = track?.basePitch ?? DEFAULT_BASE_PITCH;
  const cell = CELL * horizontalZoom;
  const row = ROW;

  const instrumentOf = (item: Track) => instruments.find((instrument) => instrument.id === item.instrumentId);
  const hueOf = (item: Track) => instrumentOf(item)?.hue ?? item.hue;

  useEffect(() => () => window.clearTimeout(auditionTimer.current), []);
  useEffect(() => () => noteOff(), [noteOff]);

  useEffect(() => {
    setBaseNoteDraft(midiToName(selectedBasePitch));
  }, [track?.id, selectedBasePitch]);

  useEffect(() => {
    if (initialVerticalCenter.current || !rollScrollRef.current) return;
    initialVerticalCenter.current = true;
    const scroller = rollScrollRef.current;
    scroller.scrollTop = RULER_HEIGHT + PITCH_WINDOW_CENTER * ROW - scroller.clientHeight / 2;
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const clock = playClock.current;
      if (!clock) return;
      const stepSeconds = 60 / bpm / STEPS_PER_BEAT;
      const nextStep = Math.min(totalSteps, clock.startStep + (performance.now() - clock.startedAt) / 1000 / stepSeconds);
      setPlayStep(nextStep);
      if (nextStep >= totalSteps) {
        setPlaying(false);
        noteOff();
      }
    }, 16);
    return () => window.clearInterval(timer);
  }, [playing, bpm, totalSteps, noteOff]);

  useEffect(() => {
    if (!playing) return;
    const step = Math.floor(playStep);
    if (step === lastAudioStep.current) return;
    lastAudioStep.current = step;
    const active = audibleTracks(tracks).flatMap((item) => {
      const instrument = instrumentOf(item);
      if (!instrument) return [];
      return item.notes.filter((note) => note.start <= step && step < note.start + note.length).map((note) => ({ note, item, instrument }));
    });
    if (!active.length) {
      if (lastAudioSignature.current !== null) noteOff();
      lastAudioSignature.current = null;
      return;
    }
    const baseFrequency = midiToFrequency(Math.max(...active.map(({ note }) => note.pitch)));
    const partials = active.flatMap(({ note, instrument }) =>
      instrument.partials.filter((partial) => !partial.muted).map((partial) => ({
        ratio: (midiToFrequency(note.pitch) / baseFrequency) * partial.ratio,
        amplitude: (partial.amplitude * instrument.volume) / active.length,
        waveform: partial.waveform,
        envelope: { attack: partial.envelope.attack, decay: partial.envelope.decay, sustain: partial.envelope.sustain, release: partial.envelope.release },
      })),
    ).slice(0, engine.maxPartials);
    const signature = JSON.stringify([baseFrequency, partials]);
    if (signature === lastAudioSignature.current) return;
    lastAudioSignature.current = signature;
    setParams({ timbre: { partials } });
    noteOn(baseFrequency, 1);
  }, [playing, playStep, tracks, instruments, engine.maxPartials, noteOff, noteOn, setParams]);

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
    setTracks((list) => list.map((item) => (item.id === id && !lockedTracks[id] ? { ...item, ...patch } : item)));

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
    setHighestVisiblePitch(pitch + PITCH_WINDOW_CENTER);
    setLowestVisiblePitch(pitch + PITCH_WINDOW_CENTER - INITIAL_PITCH_ROWS + 1);
    requestAnimationFrame(() => {
      const scroller = rollScrollRef.current;
      if (scroller) scroller.scrollTop = RULER_HEIGHT + PITCH_WINDOW_CENTER * ROW - scroller.clientHeight / 2;
    });
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
    setSelectedTrackId(created.id);
  };

  const removeTrack = (id: string) => {
    if (tracks.length <= 1 || lockedTracks[id]) return;
    const next = tracks.filter((item) => item.id !== id);
    setTracks(() => next);
    if (id === track.id) setSelectedTrackId(next[0].id);
  };

  /** Short preview of a note, only when the audio is already on */
  const audition = (pitch: number) => {
    if (!canPlay) return;
    const instrument = instrumentOf(track);
    if (instrument) setParams({ timbre: toTimbre(instrument.partials, engine.maxPartials) });
    noteOn(midiToFrequency(pitch), instrument?.volume ?? 0.3);
    window.clearTimeout(auditionTimer.current);
    auditionTimer.current = window.setTimeout(noteOff, AUDITION_MS);
  };

  const onLanePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !track || lockedTracks[track.id]) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const step = Math.floor((event.clientX - rect.left) / cell);
    const pitch = highestVisiblePitch - Math.floor((event.clientY - rect.top) / row);
    if (step < 0 || step >= totalSteps || !Number.isSafeInteger(pitch)) return;

    // Never overlap the next note on the same pitch
    const nextStart = Math.min(
      totalSteps,
      ...track.notes.filter((note) => note.pitch === pitch && note.start > step).map((note) => note.start),
    );
    const covered = track.notes.some((note) => note.pitch === pitch && step >= note.start && step < note.start + note.length);
    if (covered) return;

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
    audition(draw.pitch);
  };

  const removeNote = (event: PointerEvent, note: Note) => {
    event.stopPropagation();
    if (lockedTracks[track.id]) return;
    updateTrack(track.id, { notes: track.notes.filter((item) => item.id !== note.id) });
  };

  const onRollWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.altKey) return;
    event.preventDefault();
    if (event.deltaY === 0) return;
    const nextZoom = Math.max(0.55, Math.min(2.4, horizontalZoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
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

  const seekFromRuler = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const nextStep = Math.max(0, Math.min(totalSteps, Math.floor((event.clientX - rect.left) / cell)));
    setPlayStep(nextStep);
    playClock.current = { startedAt: performance.now(), startStep: nextStep };
    lastAudioStep.current = -1;
    lastAudioSignature.current = null;
  };

  const startPlayback = async () => {
    const performers = audibleTracks(tracks).filter((item) => item.notes.length > 0);
    if (!performers.length || busy || connection !== 'online' || !coreLoaded || !socketOpen) return;
    if (!canPlay) {
      const instrument = instrumentOf(performers[0]);
      const started = await startAudio(instrument ? { timbre: toTimbre(instrument.partials, engine.maxPartials) } : {});
      if (!started) return;
    }
    const startStep = playStep >= totalSteps ? 0 : playStep;
    setPlayStep(startStep);
    lastAudioStep.current = -1;
    lastAudioSignature.current = null;
    playClock.current = { startedAt: performance.now(), startStep };
    setPlaying(true);
  };

  const pausePlayback = () => {
    setPlaying(false);
    noteOff();
    lastAudioSignature.current = null;
  };

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
        index="02"
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
          onClick={() => updateTrack(track.id, { notes: [] })}
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
                  onClick={() => setSelectedTrackId(item.id)}
                  onKeyDown={(event) => {
                    if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault();
                      setSelectedTrackId(item.id);
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
                      title="Muet"
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
                      className={styles.ms}
                      data-kind="solo"
                      aria-pressed={item.solo}
                      title="Solo"
                      disabled={!!lockedTracks[item.id]}
                      onClick={(event) => {
                        event.stopPropagation();
                        updateTrack(item.id, { solo: !item.solo });
                      }}
                    >
                      S
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
              Molette : défiler · Alt + molette : zoom horizontal · clic milieu : déplacer · clic : ajouter une note · clic sur une note : supprimer
              {lockedTracks[track?.id ?? ''] ? ' · piste verrouillée' : ''}
              {canPlay ? ' · aperçu sonore actif' : ''}
            </span>
          </div>
          <div
            className={styles.rollScroll}
            ref={rollScrollRef}
            onScroll={onPitchScroll}
            onWheel={onRollWheel}
            onPointerDown={onRollPointerDown}
            onPointerMove={onRollPointerMove}
            onPointerUp={() => { panRef.current = null; }}
            onPointerCancel={() => { panRef.current = null; }}
          >
            <div className={styles.rollGrid} style={gridStyle}>
              <div className={styles.corner} />
              <div className={styles.ruler} onPointerDown={seekFromRuler} title="Cliquer pour choisir le point de départ">
                {Array.from({ length: bars }, (_, bar) => (
                  <div key={bar} className={styles.rulerBar} style={{ width: cell * stepsPerBar }}>
                    {bar + 1}
                  </div>
                ))}
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
                {track.notes
                  .filter((note) => note.start < totalSteps && note.pitch >= lowestVisiblePitch && note.pitch <= highestVisiblePitch)
                  .map((note) => (
                    <div
                      key={note.id}
                      className={styles.note}
                      title={`${midiToName(note.pitch)} : clic pour supprimer`}
                      style={
                        {
                          '--hue': HUE_VAR[hueOf(track)],
                          left: note.start * cell + 1,
                          top: (highestVisiblePitch - note.pitch) * row,
                          width: note.length * cell - 2,
                        } as CSSProperties
                      }
                      onPointerDown={(event) => removeNote(event, note)}
                    />
                  ))}
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
            title={playing ? 'Mettre en pause' : canPlay ? 'Lire la partition' : 'Démarrer l’audio et lire la partition'}
            onClick={playing ? pausePlayback : startPlayback}
          >
            {playing ? <Pause size={18} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>
          <Button iconOnly disabled={!playing && playStep === 0} aria-label="Stop" title="Revenir au début" onClick={() => { pausePlayback(); setPlayStep(0); }}>
            <Square size={14} />
          </Button>
          <Button iconOnly disabled aria-label="Boucle" title="Boucle">
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
