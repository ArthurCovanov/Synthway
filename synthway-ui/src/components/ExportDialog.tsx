import { AlertTriangle, FileAudio, Loader2, X } from 'lucide-react';
import { useEffect, useRef, type FormEvent } from 'react';
import { useI18n, type MessageKey } from '../i18n';
import {
  MAX_EXPORT_SECONDS,
  MAX_EXPORT_SILENCE,
  type AudioExportFormat,
  type AudioExportSettings,
  type ExportSummary,
} from '../lib/audioExport';
import { FALLBACK_INSTRUMENT } from '../lib/instruments';
import styles from '@theme/components/ExportDialog.module.css';
import { Button, Segmented, inputClass } from './ui';

/** The formats offered, with the keys of their tooltip and of the hint under them */
const FORMATS: { value: AudioExportFormat; label: string; title: MessageKey; hint: MessageKey }[] = [
  { value: 'wav', label: 'WAV', title: 'exportDialog.formats.wavTitle', hint: 'exportDialog.formats.wavHint' },
  { value: 'ogg', label: 'OGG', title: 'exportDialog.formats.oggTitle', hint: 'exportDialog.formats.oggHint' },
];

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
  const { t, tr, formatNumber } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const seconds = (value: number) => `${formatNumber(value, { maximumFractionDigits: 1 })} s`;
  const quoted = (tracks: { name: string }[]) => tracks.map((track) => t('exportDialog.quoted', { name: track.name })).join(', ');
  const format = FORMATS.find((item) => item.value === settings.format) ?? FORMATS[0];

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
            <h2 id="export-dialog-title" className={styles.title}>{t('exportDialog.title')}</h2>
            <p className={styles.subtitle}>{t('exportDialog.subtitle', { name: documentName })}</p>
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label={t('common.close')}
            title={t('exportDialog.closeTitle')}
            disabled={busy}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>

        <div className={styles.row}>
          <span className={styles.label}>{t('exportDialog.format')}</span>
          <div className={styles.field}>
            <Segmented
              label={t('exportDialog.fileFormat')}
              options={FORMATS.map((item) => ({ value: item.value, label: item.label, title: t(item.title) }))}
              value={settings.format}
              disabled={busy}
              onChange={(value) => update({ format: value })}
            />
            <p className={styles.hint}>{t(format.hint)}</p>
          </div>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>{t('exportDialog.before')}</span>
          <div className={styles.field}>
            <div className={styles.inline}>
              <SecondsField label={t('exportDialog.leadInLabel')} value={settings.leadIn} disabled={busy} onChange={(leadIn) => update({ leadIn })} />
              <span>{t('exportDialog.leadInUnit')}</span>
            </div>
          </div>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>{t('exportDialog.after')}</span>
          <div className={styles.field}>
            <p className={styles.hint}>{t('exportDialog.tailHint')}</p>
            <div className={styles.inline}>
              <SecondsField label={t('exportDialog.tailLabel')} value={settings.tailMargin} disabled={busy} onChange={(tailMargin) => update({ tailMargin })} />
              <span>{t('exportDialog.tailUnit')}</span>
            </div>
          </div>
        </div>

        <div className={styles.summary}>
          <p>
            {tr('exportDialog.length', {
              strong: (inner) => <strong>{inner}</strong>,
              score: seconds(summary.seconds),
              leadIn: seconds(settings.leadIn),
              tail: seconds(settings.tailMargin),
              rate: formatNumber(sampleRate / 1000),
            })}
          </p>
          <p>
            {t('exportDialog.tracks', { count: summary.heard.length, total: summary.heard.length + summary.muted.length })},{' '}
            {t('exportDialog.notes', { count: summary.notes })}
            {summary.muted.length > 0 &&
              ` · ${t('exportDialog.mutedLeftOut', { count: summary.muted.length, names: quoted(summary.muted) })}`}
          </p>
          {summary.fallback.length > 0 && (
            <p className={styles.warning}>
              <AlertTriangle size={13} aria-hidden="true" />
              {t('exportDialog.fallback', {
                count: summary.fallback.length,
                names: quoted(summary.fallback),
                fallback: FALLBACK_INSTRUMENT.name,
              })}
            </p>
          )}
          {tooLong && (
            <p className={styles.warning}>
              <AlertTriangle size={13} aria-hidden="true" />
              {t('exportDialog.tooLong')}
            </p>
          )}
          {nothingHeard && (
            <p className={styles.warning}>
              <AlertTriangle size={13} aria-hidden="true" />
              {t('exportDialog.nothingHeard')}
            </p>
          )}
        </div>

        {error && (
          <p className={styles.error} role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            {t('exportDialog.failed', { error })}
          </p>
        )}

        <footer className={styles.actions}>
          <Button type="button" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || tooLong} aria-busy={busy}>
            {busy ? <Loader2 size={15} className={styles.spin} aria-hidden="true" /> : <FileAudio size={15} aria-hidden="true" />}
            {busy ? t('exportDialog.rendering') : t('exportDialog.exportAs', { format: settings.format.toUpperCase() })}
          </Button>
        </footer>
      </form>
    </dialog>
  );
}
