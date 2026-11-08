import { Power, RefreshCw } from 'lucide-react';
import logo from '../assets/brand/logo-640.png';
import layout from '../components/layout.module.css';
import { ScreenHeader } from '../components/ScreenHeader';
import { Badge, Button, Field, Panel, Section, SoonBadge, Toggle, selectClass } from '../components/ui';
import { SERVER_HOST, SERVER_PORT } from '../lib/api';
import { useAppearance } from '../lib/appearance';
import { useSynthServer } from '../lib/SynthServer';
import styles from './Settings.module.css';

const SAMPLE_RATES = [44100, 48000, 96000];

const CREDITS: [name: string, role: string, license: string][] = [
  ['miniaudio', 'Entrées/sorties audio du core', 'Domaine public / MIT-0'],
  ['RtMidi', 'Ports MIDI du core', 'Type MIT'],
  ['React', 'Interface', 'MIT'],
  ['Lucide', 'Icônes', 'ISC'],
  ['Michroma, Inter, JetBrains Mono', 'Polices', 'SIL OFL 1.1'],
];

function ServerCard() {
  const server = useSynthServer();
  const { connection, coreLoaded, coreVersion, socketOpen, error } = server;

  let state: 'ok' | 'pending' | 'error' = 'error';
  let title = 'Serveur hors ligne';
  let hint = `Aucune réponse de synthway-server sur le port ${SERVER_PORT}.`;
  if (connection === 'connecting') {
    state = 'pending';
    title = 'Connexion…';
    hint = 'Recherche de synthway-server.';
  } else if (connection === 'foreign') {
    title = `Port ${SERVER_PORT} occupé`;
    hint = `Un autre programme répond sur le port ${SERVER_PORT} : ce n’est pas synthway-server.`;
  } else if (connection === 'online' && !coreLoaded) {
    state = 'pending';
    title = 'Serveur connecté, core absent';
    hint = 'Le serveur n’a pas pu charger la bibliothèque synthway-core.';
  } else if (connection === 'online') {
    state = 'ok';
    title = 'Serveur connecté';
    hint = socketOpen ? 'Canal temps réel ouvert.' : 'Ouverture du canal temps réel…';
  }

  return (
    <Panel className={styles.card}>
      <Section
        title="Serveur"
        actions={
          <Button size="small" onClick={server.refresh}>
            <RefreshCw size={13} />
            Actualiser
          </Button>
        }
      >
        <div className={styles.statusRow}>
          <span className={styles.statusDot} data-state={state} />
          <div className={styles.statusText}>
            <span className={styles.statusTitle}>{title}</span>
            <span className={styles.statusHint}>{hint}</span>
          </div>
        </div>
        <dl className={styles.facts}>
          <dt>API</dt>
          <dd>/api, /health → {SERVER_HOST}</dd>
          <dt>Temps réel</dt>
          <dd>/ws/synth {socketOpen ? '(ouvert)' : '(fermé)'}</dd>
          <dt>Version du core</dt>
          <dd>{coreVersion ?? '—'}</dd>
        </dl>
        {(connection === 'offline' || connection === 'foreign') && (
          <>
            <p className={styles.note}>
              {connection === 'foreign'
                ? `Libère le port ${SERVER_PORT}, puis lance synthway-server :`
                : 'Pour lancer synthway-server :'}
            </p>
            <code className={styles.code}>cd synthway-server/src{'\n'}uvicorn main:app --port {SERVER_PORT}</code>
          </>
        )}
        {connection === 'online' && !coreLoaded && (
          <p className={styles.note}>Compile synthway-core (skill core-build), puis relance le serveur.</p>
        )}
        {error && <p className={styles.error}>{error}</p>}
      </Section>
    </Panel>
  );
}

function AudioCard() {
  const server = useSynthServer();
  const { devices, audioConfig, setAudioConfig, engine, busy } = server;
  const online = server.connection === 'online' && server.coreLoaded;

  return (
    <Panel className={styles.card}>
      <Section title="Audio" badge={engine.running ? <Badge tone="live">Actif</Badge> : <Badge>Coupé</Badge>}>
        <div className={styles.row2}>
          <Field label="Sortie">
            <select
              className={selectClass}
              value={audioConfig.deviceIndex}
              disabled={!devices}
              onChange={(event) => setAudioConfig({ ...audioConfig, deviceIndex: Number(event.target.value) })}
            >
              <option value={-1}>Sortie par défaut du système</option>
              {devices?.playback_devices.map((device) => (
                <option key={device.index} value={device.index}>
                  {device.name}
                  {device.is_default ? ' (défaut)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Échantillonnage">
            <select
              className={selectClass}
              value={audioConfig.sampleRate}
              onChange={(event) => setAudioConfig({ ...audioConfig, sampleRate: Number(event.target.value) })}
            >
              {SAMPLE_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {(rate / 1000).toFixed(1)} kHz
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className={styles.note}>
          {devices
            ? 'Ces choix s’appliquent au prochain démarrage de l’audio.'
            : 'La liste des sorties s’affiche quand le serveur est connecté.'}
        </p>
        <div className={styles.engineRow}>
          <span className={styles.note}>
            {engine.running ? 'Le moteur audio tourne.' : 'Le moteur audio est arrêté.'}
          </span>
          <Button
            variant={engine.running ? 'default' : 'primary'}
            disabled={!online || busy}
            onClick={() => void (engine.running ? server.stopAudio() : server.startAudio())}
          >
            <Power size={15} />
            {engine.running ? 'Couper l’audio' : 'Activer l’audio'}
          </Button>
        </div>
      </Section>
      {devices && devices.capture_devices.length > 0 && (
        <Section title="Entrées détectées">
          <ul className={styles.deviceList}>
            {devices.capture_devices.map((device) => (
              <li key={device.index}>
                <span>{device.name}</span>
                <span className={styles.deviceMeta}>
                  {device.channels} canaux · {(device.sample_rate / 1000).toFixed(1)} kHz
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </Panel>
  );
}

function MidiCard() {
  return (
    <Panel className={styles.card}>
      <Section title="MIDI" badge={<SoonBadge />}>
        <p className={styles.note}>
          synthway-core sait déjà lister les ports MIDI grâce à RtMidi (<code>synthway_cli --midi</code>), mais
          l’API du serveur ne les expose pas encore. Le choix du clavier MIDI d’entrée arrivera ici.
        </p>
      </Section>
    </Panel>
  );
}

function AppearanceCard() {
  const { glow, motion, setGlow, setMotion } = useAppearance();
  return (
    <Panel className={styles.card}>
      <Section title="Apparence">
        <div className={styles.toggles}>
          <Toggle
            label="Lueurs néon"
            hint="Halos lumineux autour des éléments actifs."
            checked={glow}
            onChange={setGlow}
          />
          <Toggle
            label="Animations"
            hint="Oscilloscope animé et transitions. Désactivées aussi si le système demande moins de mouvement."
            checked={motion}
            onChange={setMotion}
          />
        </div>
      </Section>
    </Panel>
  );
}

function AboutCard() {
  const { coreVersion } = useSynthServer();
  return (
    <Panel className={`${styles.card} ${styles.wide}`}>
      <Section title="À propos">
        <div className={styles.about}>
          <img className={styles.aboutLogo} src={logo} alt="Synthway" />
          <div className={styles.toggles}>
            <dl className={styles.facts}>
              <dt>Interface</dt>
              <dd>{__SYNTHWAY_VERSION__}</dd>
              <dt>Core</dt>
              <dd>{coreVersion ?? 'non connecté'}</dd>
            </dl>
            <dl className={styles.credits}>
              {CREDITS.map(([name, role, license]) => (
                <div key={name} style={{ display: 'contents' }}>
                  <dt>{name}</dt>
                  <dd>{role}</dd>
                  <dd className={styles.license}>{license}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Section>
    </Panel>
  );
}

export function Settings() {
  return (
    <div className={layout.screen}>
      <ScreenHeader
        index="04"
        eyebrow="Système"
        title="Réglages"
        subtitle="Connexion au serveur, sortie audio et apparence."
      />
      <div className={styles.body}>
        <div className={styles.grid}>
          <ServerCard />
          <AudioCard />
          <MidiCard />
          <AppearanceCard />
          <AboutCard />
        </div>
      </div>
    </div>
  );
}
