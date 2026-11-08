import { Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import emblem from '../assets/brand/emblem-256.png';
import { SERVER_PORT } from '../lib/api';
import { useSynthServer, type Connection } from '../lib/SynthServer';
import { AnalyzerIcon, ComposerIcon, DecomposerIcon, InstrumentIcon } from './icons';
import styles from './Sidebar.module.css';

export type ScreenId = 'instruments' | 'composer' | 'analyzer' | 'decomposer' | 'settings';

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: 'Connexion au serveur…',
  online: 'Serveur connecté',
  offline: 'Serveur hors ligne',
  foreign: `Port ${SERVER_PORT} occupé par un autre service`,
};

function NavItem({
  id,
  label,
  icon,
  current,
  onNavigate,
}: {
  id: ScreenId;
  label: string;
  icon: ReactNode;
  current: ScreenId;
  onNavigate: (id: ScreenId) => void;
}) {
  return (
    <button
      type="button"
      className={styles.item}
      aria-label={label}
      aria-current={current === id ? 'page' : undefined}
      onClick={() => onNavigate(id)}
    >
      {icon}
      <span className={styles.tip}>{label}</span>
    </button>
  );
}

export function Sidebar({ current, onNavigate }: { current: ScreenId; onNavigate: (id: ScreenId) => void }) {
  const { connection, coreLoaded } = useSynthServer();
  const statusLabel =
    connection === 'online' && !coreLoaded ? 'Serveur connecté, core non chargé' : CONNECTION_LABEL[connection];

  return (
    <nav className={styles.sidebar} aria-label="Navigation principale">
      <button type="button" className={styles.logo} onClick={() => onNavigate('instruments')} title="Synthway">
        <img src={emblem} alt="Synthway" />
      </button>

      <div className={styles.nav}>
        <NavItem
          id="instruments"
          label="Instrument Creator"
          icon={<InstrumentIcon size={23} />}
          current={current}
          onNavigate={onNavigate}
        />
        <NavItem
          id="analyzer"
          label="Analyzer"
          icon={<AnalyzerIcon size={23} />}
          current={current}
          onNavigate={onNavigate}
        />
        <NavItem
          id="decomposer"
          label="Decomposer"
          icon={<DecomposerIcon size={23} />}
          current={current}
          onNavigate={onNavigate}
        />
        <NavItem
          id="composer"
          label="Composer"
          icon={<ComposerIcon size={23} />}
          current={current}
          onNavigate={onNavigate}
        />
      </div>

      <div className={styles.spacer} />

      <NavItem
        id="settings"
        label="Réglages"
        icon={<Settings size={21} strokeWidth={1.8} />}
        current={current}
        onNavigate={onNavigate}
      />

      <div className={styles.status} role="status" aria-label={statusLabel}>
        <span className={styles.dot} data-state={connection === 'online' && !coreLoaded ? 'foreign' : connection} />
        <span className={styles.tip}>{statusLabel}</span>
      </div>
      <span className={styles.version}>v0.2</span>
    </nav>
  );
}
