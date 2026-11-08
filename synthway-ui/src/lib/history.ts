import { useCallback, useEffect, useState } from 'react';
import { loadJson, saveJson } from './storage';

/** Most changes that can be undone in a row */
export const HISTORY_LIMIT = 200;

export interface ChangeOptions {
  /** What the change does, shown on the undo and redo buttons ("Déplacer la note") */
  label?: string;
  /**
   * Changes of the same group in a row make a single step: a whole drag, a name typed.
   * Each gesture takes a new group at its start, from `newGroup`.
   */
  group?: string;
  /** Kept and saved, but not a step: a view setting, that undoing leaves as it is */
  untracked?: boolean;
}

/** A value of the history, and the change that left it (undo) or that brings it back (redo) */
export interface HistoryStep<T> {
  value: T;
  label: string;
}

interface History<T> {
  past: HistoryStep<T>[];
  present: T;
  future: HistoryStep<T>[];
  /** Group of the last change: the next change of the same group joins its step */
  group: string | null;
}

let groupCount = 0;

/** A group never used before (one per gesture) */
export function newGroup(kind: string): string {
  groupCount += 1;
  return `${kind}#${groupCount}`;
}

// Kept while the page lives: a screen left and opened again can still undo. A reload starts empty.
const histories = new Map<string, History<unknown>>();

/** Same content. Parts that are the same object are not looked into: an unchanged part costs nothing */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => Object.prototype.hasOwnProperty.call(b, key) && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * useState with undo and redo, restored from and saved to localStorage like `usePersistentState`
 * (only the value is saved, not its history). A change that leaves the same content is not a step.
 * `keep(restored, current)` gives the value an undo or a redo restores: it puts back into it
 * the untracked parts of the current value. It must not change between renders.
 */
export function useUndoablePersistentState<T>(key: string, initial: () => T, keep?: (restored: T, current: T) => T) {
  const [history, setHistory] = useState<History<T>>(() => {
    const kept = histories.get(key) as History<T> | undefined;
    if (kept) return kept;
    const saved = loadJson<T | undefined>(key, undefined);
    return { past: [], present: saved === undefined ? initial() : saved, future: [], group: null };
  });

  useEffect(() => {
    histories.set(key, history);
  }, [key, history]);

  useEffect(() => {
    saveJson(key, history.present);
  }, [key, history.present]);

  const set = useCallback((update: T | ((current: T) => T), options: ChangeOptions = {}) => {
    setHistory((current) => {
      const present = typeof update === 'function' ? (update as (value: T) => T)(current.present) : update;
      if (sameValue(present, current.present)) return current;
      if (options.untracked) return { ...current, present };
      const joins = options.group !== undefined && options.group === current.group;
      const base = current.past[current.past.length - 1];
      if (joins && base && sameValue(present, base.value)) {
        // Back to where the gesture started (a note dragged back, a name typed then undone in its
        // field): no step. If the gesture goes on, it makes a new one.
        return { past: current.past.slice(0, -1), present: base.value, future: current.future, group: null };
      }
      return {
        past: joins
          ? current.past
          : [...current.past, { value: current.present, label: options.label ?? 'Modification' }].slice(-HISTORY_LIMIT),
        present,
        future: [],
        group: options.group ?? null,
      };
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((current) => {
      const step = current.past[current.past.length - 1];
      if (!step) return current;
      return {
        past: current.past.slice(0, -1),
        present: keep ? keep(step.value, current.present) : step.value,
        future: [{ value: current.present, label: step.label }, ...current.future],
        group: null,
      };
    });
  }, [keep]);

  const redo = useCallback(() => {
    setHistory((current) => {
      const step = current.future[0];
      if (!step) return current;
      return {
        past: [...current.past, { value: current.present, label: step.label }],
        present: keep ? keep(step.value, current.present) : step.value,
        future: current.future.slice(1),
        group: null,
      };
    });
  }, [keep]);

  return {
    value: history.present,
    set,
    undo,
    redo,
    /** What an undo would restore, and the change it would undo */
    undoStep: history.past[history.past.length - 1] as HistoryStep<T> | undefined,
    /** What a redo would restore, and the change it would make again */
    redoStep: history.future[0] as HistoryStep<T> | undefined,
  };
}
