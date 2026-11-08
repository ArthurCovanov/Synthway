import type { ReactNode } from 'react';
import styles from './layout.module.css';

export function ScreenHeader({
  index,
  eyebrow,
  title,
  subtitle,
  children,
}: {
  index: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.headerText}>
        <div className={styles.eyebrow}>
          <span className={styles.eyebrowIndex}>{index}</span>
          <span>{eyebrow}</span>
        </div>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.subtitle}>{subtitle}</p>
      </div>
      {children && <div className={styles.headerActions}>{children}</div>}
    </header>
  );
}
