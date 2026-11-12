import { Languages, Power, RefreshCw } from 'lucide-react';
import logo from '../assets/brand/logo-640.png';
import layout from '@theme/components/layout.module.css';
import { ScreenHeader } from '../components/ScreenHeader';
import { Badge, Button, Field, Panel, Section, Segmented, SoonBadge, Toggle, selectClass } from '../components/ui';
import { LANGUAGES, useI18n, type MessageKey } from '../i18n';
import { SERVER_HOST, SERVER_PORT } from '../lib/api';
import { useAppearance } from '../lib/appearance';
import { useSynthServer } from '../lib/SynthServer';
import { DEFAULT_THEME, listThemes, themeName } from '../lib/themes';
import styles from '@theme/screens/Settings.module.css';

const SAMPLE_RATES = [44100, 48000, 96000];

const CREDITS: [name: string, role: MessageKey, license: string | MessageKey][] = [
  ['miniaudio', 'settings.about.credits.miniaudio', 'settings.about.credits.publicDomain'],
  ['RtMidi', 'settings.about.credits.rtmidi', 'settings.about.credits.mitLike'],
  ['React', 'settings.about.credits.react', 'MIT'],
  ['Lucide', 'settings.about.credits.lucide', 'ISC'],
  ['Michroma, Inter, JetBrains Mono', 'settings.about.credits.fonts', 'SIL OFL 1.1'],
];

function LanguageCard() {
  const { t, language, setLanguage } = useI18n();
  return (
    <Panel className={styles.card}>
      <Section title={t('settings.language.title')} badge={<Languages size={15} className={styles.titleIcon} />}>
        <Segmented
          label={t('settings.language.label')}
          options={LANGUAGES.map(({ id, name }) => ({ value: id, label: name }))}
          value={language}
          onChange={setLanguage}
        />
        <p className={styles.note}>{t('settings.language.hint')}</p>
      </Section>
    </Panel>
  );
}

function ServerCard() {
  const server = useSynthServer();
  const { t } = useI18n();
  const { connection, coreLoaded, coreVersion, socketOpen, error } = server;
  const port = { port: SERVER_PORT };

  let state: 'ok' | 'pending' | 'error' = 'error';
  let title = t('settings.server.offline');
  let hint = t('settings.server.offlineHint', port);
  if (connection === 'connecting') {
    state = 'pending';
    title = t('settings.server.connecting');
    hint = t('settings.server.connectingHint');
  } else if (connection === 'foreign') {
    title = t('settings.server.foreign', port);
    hint = t('settings.server.foreignHint', port);
  } else if (connection === 'online' && !coreLoaded) {
    state = 'pending';
    title = t('settings.server.noCore');
    hint = t('settings.server.noCoreHint');
  } else if (connection === 'online') {
    state = 'ok';
    title = t('settings.server.online');
    hint = socketOpen ? t('settings.server.socketOpen') : t('settings.server.socketOpening');
  }

  return (
    <Panel className={styles.card}>
      <Section
        title={t('settings.server.title')}
        actions={
          <Button size="small" onClick={server.refresh}>
            <RefreshCw size={13} />
            {t('settings.server.refresh')}
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
          <dt>{t('settings.server.realTime')}</dt>
          <dd>
            /ws/synth{' '}
            {t('settings.server.socketState', {
              state: socketOpen ? t('settings.server.opened') : t('settings.server.closed'),
            })}
          </dd>
          <dt>{t('settings.server.coreVersion')}</dt>
          <dd>{coreVersion ?? '—'}</dd>
        </dl>
        {(connection === 'offline' || connection === 'foreign') && (
          <>
            <p className={styles.note}>
              {connection === 'foreign' ? t('settings.server.freePort', port) : t('settings.server.howToStart')}
            </p>
            <code className={styles.code}>cd synthway-server/src{'\n'}uvicorn main:app --port {SERVER_PORT}</code>
          </>
        )}
        {connection === 'online' && !coreLoaded && <p className={styles.note}>{t('settings.server.buildCore')}</p>}
        {error && <p className={styles.error}>{error}</p>}
      </Section>
    </Panel>
  );
}

function AudioCard() {
  const server = useSynthServer();
  const { t } = useI18n();
  const { devices, audioConfig, setAudioConfig, engine, busy } = server;
  const online = server.connection === 'online' && server.coreLoaded;

  return (
    <Panel className={styles.card}>
      <Section
        title={t('settings.audio.title')}
        badge={
          engine.running ? (
            <Badge tone="live">{t('settings.audio.active')}</Badge>
          ) : (
            <Badge>{t('settings.audio.stopped')}</Badge>
          )
        }
      >
        <div className={styles.row2}>
          <Field label={t('settings.audio.output')}>
            <select
              className={selectClass}
              value={audioConfig.deviceIndex}
              disabled={!devices}
              onChange={(event) => setAudioConfig({ ...audioConfig, deviceIndex: Number(event.target.value) })}
            >
              <option value={-1}>{t('settings.audio.defaultOutput')}</option>
              {devices?.playback_devices.map((device) => (
                <option key={device.index} value={device.index}>
                  {device.name}
                  {device.is_default ? t('settings.audio.defaultSuffix') : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('settings.audio.sampleRate')}>
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
          {devices ? t('settings.audio.appliesNextStart') : t('settings.audio.devicesWhenOnline')}
        </p>
        <div className={styles.engineRow}>
          <span className={styles.note}>
            {engine.running ? t('settings.audio.engineRunning') : t('settings.audio.engineStopped')}
          </span>
          <Button
            variant={engine.running ? 'default' : 'primary'}
            disabled={!online || busy}
            onClick={() => void (engine.running ? server.stopAudio() : server.startAudio())}
          >
            <Power size={15} />
            {engine.running ? t('common.disableAudio') : t('common.enableAudio')}
          </Button>
        </div>
      </Section>
      {devices && devices.capture_devices.length > 0 && (
        <Section title={t('settings.audio.inputs')}>
          <ul className={styles.deviceList}>
            {devices.capture_devices.map((device) => (
              <li key={device.index}>
                <span>{device.name}</span>
                <span className={styles.deviceMeta}>
                  {t('settings.audio.channels', { count: device.channels })} ·{' '}
                  {(device.sample_rate / 1000).toFixed(1)} kHz
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
  const { tr } = useI18n();
  return (
    <Panel className={styles.card}>
      <Section title="MIDI" badge={<SoonBadge />}>
        <p className={styles.note}>{tr('settings.midi.note', { command: <code>synthway_cli --midi</code> })}</p>
      </Section>
    </Panel>
  );
}

function AppearanceCard() {
  const { glow, motion, setGlow, setMotion, theme, setTheme } = useAppearance();
  const { t, tr } = useI18n();
  return (
    <Panel className={styles.card}>
      <Section title={t('settings.appearance.title')}>
        <Field label={t('settings.appearance.theme')}>
          <select className={selectClass} value={theme} onChange={(event) => setTheme(event.target.value)}>
            {listThemes().map((id) => (
              <option key={id} value={id}>
                {id === DEFAULT_THEME ? t('settings.appearance.defaultTheme') : themeName(id)}
              </option>
            ))}
          </select>
        </Field>
        <p className={styles.note}>
          {tr('settings.appearance.themeHint', { folder: <code>synthway-ui/src/themes</code> })}
        </p>
        <div className={styles.toggles}>
          <Toggle
            label={t('settings.appearance.glow')}
            hint={t('settings.appearance.glowHint')}
            checked={glow}
            onChange={setGlow}
          />
          <Toggle
            label={t('settings.appearance.motion')}
            hint={t('settings.appearance.motionHint')}
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
  const { t } = useI18n();
  return (
    <Panel className={`${styles.card} ${styles.wide}`}>
      <Section title={t('settings.about.title')}>
        <div className={styles.about}>
          <img className={styles.aboutLogo} src={logo} alt="Synthway" />
          <div className={styles.toggles}>
            <dl className={styles.facts}>
              <dt>{t('settings.about.interface')}</dt>
              <dd>{__SYNTHWAY_VERSION__}</dd>
              <dt>{t('settings.about.core')}</dt>
              <dd>{coreVersion ?? t('settings.about.notConnected')}</dd>
            </dl>
            <dl className={styles.credits}>
              {CREDITS.map(([name, role, license]) => (
                <div key={name} style={{ display: 'contents' }}>
                  <dt>{name}</dt>
                  <dd>{t(role)}</dd>
                  <dd className={styles.license}>
                    {license.startsWith('settings.') ? t(license as MessageKey) : license}
                  </dd>
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
  const { t } = useI18n();
  return (
    <div className={layout.screen}>
      <ScreenHeader
        index="04"
        eyebrow={t('settings.eyebrow')}
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
      />
      <div className={styles.body}>
        <div className={styles.grid}>
          <LanguageCard />
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
