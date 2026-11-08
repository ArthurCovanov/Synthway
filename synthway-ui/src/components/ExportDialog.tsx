import { AlertTriangle, FileAudio, Loader2, X } from 'lucide-react';
import { useEffect, useRef, type FormEvent } from 'react';
import {
  MAX_EXPORT_SECONDS,
  MAX_EXPORT_SILENCE,
  type AudioExportFormat,
  type AudioExportSettings,
  type ExportSummary,
} from '../lib/audioExport';
import { FALLBACK_INSTRUMENT } from '../lib/instruments';
import styles from './ExportDialog.module.css';
import { Button, Segmented, inputClass } from './ui';

const FORMATS: { value: AudioExportFormat; label: string; title: string }[] = [
  { value: 'wav', label: 'WAV', title: 'Sans perte, 16 bits : le plus fidèle, et le plus lourd' },
  { value: 'ogg', label: 'OGG', title: 'Ogg Vorbis, compressé : environ 7 fois plus léger, presque impossible à distinguer' },
];

const FORMAT_HINT: Record<AudioExportFormat, string> = {
  wav: 'Sans perte (16 bits) : pour garder, retravailler ou graver. Environ 10 Mo par minute.',
  ogg: 'Ogg Vorbis (~190 kbit/s) : pour partager, ou pour un jeu. Environ 1,4 Mo par minute.',
};

const seconds = (value: number) => `${value.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;
const quoted = (tracks: { name: string }[]) => tracks.map((track) => `« ${track.name} »`).join(', ');

/** A number of seconds typed, kept between 0 and MAX_EXPORT_SILENCE */
function SecondsField({ label, value, onChange, disabled }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  return (
    <input
      className={`${inputClass} ${styles.seconds}`}
      type="number"
      min={0}
      max={MAX_EXPORT_SILENCE}
      step={0.1}
      value={value}
      aria-label={label}
      disabled={disabled}
      onChange={(event) => {
        const typed = Number(event.target.value);
        if (event.target.value !== '' && Number.isFinite(typed)) onChange(Math.min(MAX_EXPORT_SILENCE, Math.max(0, typed)));
      }}
    />
  );
}

/**
 * The score exported to an audio file: its format, the silence before it, and after its sound has died
 * out. A modal dialog (Esc or Cancel closes it, but not while rendering).
 */
export function ExportDialog({
  open,
  documentName,
  settings,
  onSettingsChange,
  summary,
  sampleRate,
  busy,
  error,
  onExport,
  onClose,
}: {
  open: boolean;
  documentName: string;
  settings: AudioExportSettings;
  onSettingsChange: (settings: AudioExportSettings) => void;
  summary: ExportSummary;
  sampleRate: number;
  busy: boolean;
  /** Why the last export failed */
  error: string | null;
  onExport: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const update = (patch: Partial<AudioExportSettings>) => onSettingsChange({ ...settings, ...patch });
  // The server would refuse it: better said before the file is chosen
  const tooLong = summary.seconds > MAX_EXPORT_SECONDS;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && !tooLong) onExport();
  };
  const nothingHeard = summary.notes === 0;

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="export-dialog-title"
      onCancel={(event) => {
        // Esc: closes, unless the file is being rendered
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form className={styles.form} onSubmit={submit}>
        <header className={styles.head}>
          <FileAudio size={18} className={styles.headIcon} aria-hidden="true" />
          <div className={styles.headText}>
            <h2 id="export-dialog-title" className={styles.title}>Exporter en audio</h2>
            <p className={styles.subtitle}>« {documentName} », tel que la lecture le joue</p>
          </div>
          <button type="button" className={styles.close} aria-label="Fermer" title="Fermer (Échap)" disabled={busy} onClick={onClose}>
            <X size={15} />
          </button>
        </header>

        <div className={styles.row}>
          <span className={styles.label}>Format</span>
          <div className={styles.field}>
            <Segmented
              label="Format du fichier"
              options={FORMATS}
              value={settings.format}
              disabled={busy}
              onChange={(format) => update({ format })}
            />
            <p className={styles.hint}>{FORMAT_HINT[settings.format]}</p>
          </div>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Avant</span>
          <div className={styles.field}>
            <div className={styles.inline}>
              <SecondsField label="Secondes de silence avant le morceau" value={settings.leadIn} disabled={busy} onChange={(leadIn) => update({ leadIn })} />
              <span>s de silence avant le premier temps</span>
            </div>
          </div>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Après</span>
          <div className={styles.field}>
            <p className={styles.hint}>
              Le son continue après la dernière mesure jusqu’à ce que les dernières notes et leur réverbération se soient
              éteintes, puis :
            </p>
            <div className={styles.inline}>
              <SecondsField label="Secondes de silence après la fin du son" value={settings.tailMargin} disabled={busy} onChange={(tailMargin) => update({ tailMargin })} />
              <span>s de silence, en fondu</span>
            </div>
          </div>
        </div>

        <div className={styles.summary}>
          <p>
            <strong>{seconds(summary.seconds)}</strong> de partition, plus {seconds(settings.leadIn)} avant, la fin du son et{' '}
            {seconds(settings.tailMargin)} après · {(sampleRate / 1000).toLocaleString('fr-FR')} kHz, stéréo
          </p>
          <p>
            {summary.heard.length} piste{summary.heard.length > 1 ? 's' : ''} sur {summary.heard.length + summary.muted.length},{' '}
            {summary.notes} note{summary.notes > 1 ? 's' : ''}
            {summary.muted.length > 0 &&
              ` · ${summary.muted.length > 1 ? 'muettes, laissées de côté' : 'muette, laissée de côté'} : ${quoted(summary.muted)}`}
          </p>
          {summary.fallback.length > 0 && (
            <p className={styles.warning}>
              <AlertTriangle size={13} aria-hidden="true" />
              {quoted(summary.fallback)} : instrument introuvable, joué{summary.fallback.length > 1 ? 'es' : 'e'} avec{' '}
              {FALLBACK_INSTRUMENT.name}, comme à la lecture
            </p>
          )}
          {tooLong && (
            <p className={styles.warning}>
              <AlertTriangle size={13} aria-hidden="true" />
              Le serveur n’exporte pas plus d’une heure de partition : retire des mesures ou accélère le tempo.
            </p>
          )}
          {nothingHeard && (
            <p className={styles.warning}>
              <AlertTriangle size={13} aria-hidden="true" />
              Aucune note à entendre : le fichier ne contiendra que du silence.
            </p>
          )}
        </div>

        {error && (
          <p className={styles.error} role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            L’export a échoué : {error}
          </p>
        )}

        <footer className={styles.actions}>
          <Button type="button" disabled={busy} onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" variant="primary" disabled={busy || tooLong} aria-busy={busy}>
            {busy ? <Loader2 size={15} className={styles.spin} aria-hidden="true" /> : <FileAudio size={15} aria-hidden="true" />}
            {busy ? 'Rendu en cours…' : `Exporter en ${settings.format.toUpperCase()}`}
          </Button>
        </footer>
      </form>
    </dialog>
  );
}
