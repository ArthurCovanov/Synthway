/**
 * Files the user saves and opens (compositions, instruments). Saved through the browser's save dialog
 * when it has one (Chrome, Edge: the File System Access API), else downloaded; opened through a file
 * input, in every browser. The formats themselves are in compositionFile.ts and instrumentFile.ts.
 */

/** A kind of file the UI writes */
export interface FileKind {
  /** Shown in the dialog's list of types: "Morceau Synthway" */
  description: string;
  /** With its dot: ".swsong" */
  extension: string;
  /** The save dialog opens in the folder last used for this id */
  pickerId: string;
  /** Media type of its content; absent: JSON */
  mime?: string;
}

/** A file written once, that can be written again without a dialog (File System Access API) */
export interface SavedFileHandle {
  readonly name: string;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  /** Chrome only: deletes the file */
  remove?(): Promise<void>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  id?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}

type SaveFilePicker = (options: SaveFilePickerOptions) => Promise<SavedFileHandle>;

/** The browser's save dialog, when it has one (not in TypeScript's DOM types) */
function saveFilePicker(): SaveFilePicker | null {
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof picker === 'function' ? picker.bind(window) : null;
}

/** True when saving lets the user choose the name and folder; false: the file is downloaded */
export function canChooseSaveLocation(): boolean {
  return saveFilePicker() !== null;
}

export type SaveResult =
  /** `handle`: the file, to write again without a dialog; null when it was downloaded */
  | { saved: true; name: string; handle: SavedFileHandle | null }
  | { saved: false };

async function write(handle: SavedFileHandle, blob: Blob): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * Saves text in a file. `handle`: the file saved last time, written again without a dialog.
 * Otherwise the save dialog, proposing `suggestedName`, or, without one (Firefox, Safari), a
 * download of that name. Called from a click or a key press: the dialog needs one.
 * Throws when the file cannot be written.
 */
export function saveTextFile(
  text: string,
  kind: FileKind,
  suggestedName: string,
  handle: SavedFileHandle | null = null,
): Promise<SaveResult> {
  return saveFile(kind, suggestedName, async () => new Blob([text], { type: kind.mime ?? 'application/json' }), handle);
}

/**
 * Saves in a file what `content` makes, which can take long (an audio render): the place is chosen
 * first, while the click that asked is recent enough for the browser to open its dialog, then the
 * content is made and written. Same dialog, download and `handle` as saveTextFile. Throws when the
 * content cannot be made or the file cannot be written (a file just chosen is then deleted, where
 * the browser allows it).
 */
export async function saveFile(
  kind: FileKind,
  suggestedName: string,
  content: () => Promise<Blob>,
  handle: SavedFileHandle | null = null,
): Promise<SaveResult> {
  if (handle) {
    await write(handle, await content());
    return { saved: true, name: handle.name, handle };
  }
  const picker = saveFilePicker();
  if (picker) {
    let chosen: SavedFileHandle;
    try {
      chosen = await picker({
        suggestedName,
        id: kind.pickerId,
        types: [{ description: kind.description, accept: { [kind.mime ?? 'application/json']: [kind.extension] } }],
      });
    } catch (error) {
      // The dialog closed without a choice
      if (error instanceof DOMException && error.name === 'AbortError') return { saved: false };
      throw error;
    }
    try {
      await write(chosen, await content());
    } catch (error) {
      await chosen.remove?.().catch(() => undefined);
      throw error;
    }
    return { saved: true, name: chosen.name, handle: chosen };
  }
  const blob = await content();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = suggestedName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { saved: true, name: suggestedName, handle: null };
}

/**
 * Lets the user choose files to open, among `accept` (".swsong,.json"). Resolves with none when the
 * dialog is closed without a choice. Called from a click or a key press: the dialog needs one.
 */
export function chooseFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}

/** A file's name without its extension: "Ma démo.swsong" → "Ma démo" */
export function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * A file name every system accepts, from a name typed in the UI: without / \ : * ? " < > |,
 * control characters, nor dots or spaces at the end. `fallback` when nothing is left.
 */
export function fileNameOf(name: string, extension: string, fallback: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return `${(cleaned || fallback).slice(0, 120)}${extension}`;
}

/** A file that cannot be read as what it should be: `message` says why, in French, for the user */
export class FileFormatError extends Error {}

/** The object a file holds, or a FileFormatError */
export function parseJsonObject(text: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FileFormatError('le fichier n’est pas lisible (ce n’est pas du JSON).');
  }
  if (!isRecord(data)) throw new FileFormatError('le fichier n’est pas lisible (pas d’objet JSON).');
  return data;
}

/**
 * The version of a format a file was written in: a whole number from 1 to `current`.
 * A later one comes from a newer Synthway, that this one cannot read.
 */
export function formatVersion(data: Record<string, unknown>, current: number): number {
  const { version } = data;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new FileFormatError('le fichier n’indique pas la version de son format.');
  }
  if (version > current) {
    throw new FileFormatError(
      `il a été écrit par une version plus récente de Synthway (format ${version}, celle-ci lit jusqu’au ${current}). Mets l’interface à jour pour l’ouvrir.`,
    );
  }
  return version;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A number of the file, kept between min and max; `fallback` when it is not a number */
export function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** A text of the file, cut at maxLength; `fallback` when it is not a text */
export function textOf(value: unknown, maxLength: number, fallback: string): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : fallback;
}

/** A value of the file among `options`; `fallback` when it is not one of them */
export function oneOf<T>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}
