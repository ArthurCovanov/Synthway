import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useI18n } from '../i18n';
import styles from './Notice.module.css';

export type NoticeTone = 'success' | 'info' | 'warning' | 'error';

/** A message to the user after an action: what happened, and the details that matter */
export interface NoticeMessage {
  tone: NoticeTone;
  title: string;
  details?: string[];
}

/** Only a success goes away by itself: a warning or an error stays until it is closed */
const SUCCESS_MS = 5000;

/** The notice shown on a screen, and how to show another one (null: none) */
export function useNotice() {
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((message: NoticeMessage | null) => {
    window.clearTimeout(timer.current);
    setNotice(message);
    if (message?.tone === 'success') timer.current = window.setTimeout(() => setNotice(null), SUCCESS_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [notice, show] as const;
}

const ICONS = { success: CheckCircle2, info: Info, warning: AlertTriangle, error: XCircle };
const COLORS: Record<NoticeTone, string> = {
  success: 'var(--ok)',
  info: 'var(--neon-cyan)',
  warning: 'var(--warn)',
  error: 'var(--danger)',
};

/**
 * Floats at the bottom right of the screen, just above its dock, whatever its height: placed in the
 * screen right before the dock, it takes no room and moves nothing.
 */
export function Notice({ notice, onClose }: { notice: NoticeMessage | null; onClose: () => void }) {
  const { t } = useI18n();
  if (!notice) return null;
  const Icon = ICONS[notice.tone];
  const urgent = notice.tone === 'warning' || notice.tone === 'error';
  return (
    <div className={styles.anchor}>
      <div
        className={styles.notice}
        role={urgent ? 'alert' : 'status'}
        style={{ '--tone': COLORS[notice.tone] } as CSSProperties}
      >
        <Icon size={17} className={styles.icon} aria-hidden="true" />
        <div className={styles.text}>
          <p className={styles.title}>{notice.title}</p>
          {notice.details && notice.details.length > 0 && (
            <ul className={styles.details}>
              {notice.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" className={styles.close} aria-label={t('ui.notice.close')} title={t('common.close')} onClick={onClose}>
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
