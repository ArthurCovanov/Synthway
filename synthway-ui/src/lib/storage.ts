import { useEffect, useState } from 'react';

// localStorage only keeps per-browser conveniences (instrument drafts, layout
// preferences). It can be unavailable or throw: the UI must work without it.

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the value only lives in memory
  }
}

/**
 * useState that is restored from, and saved to, localStorage. `migrate` turns
 * what an older version of the UI saved under the same key into the current shape.
 */
export function usePersistentState<T>(key: string, initial: () => T, migrate?: (saved: unknown) => T) {
  const [value, setValue] = useState<T>(() => {
    const saved = loadJson<unknown>(key, undefined);
    if (saved === undefined) return initial();
    return migrate ? migrate(saved) : (saved as T);
  });

  useEffect(() => {
    saveJson(key, value);
  }, [key, value]);

  return [value, setValue] as const;
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
