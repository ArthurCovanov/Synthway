import { useEffect, useState } from 'react';
import { NeonDefs } from './components/icons';
import { Sidebar, type ScreenId } from './components/Sidebar';
import { AppearanceProvider } from './lib/appearance';
import { migrateInstruments, PRESET_INSTRUMENTS, type Instrument } from './lib/instruments';
import { usePersistentState } from './lib/storage';
import { SynthServerProvider } from './lib/SynthServer';
import { Analyzer } from './screens/Analyzer';
import { Composer } from './screens/Composer';
import { InstrumentCreator } from './screens/InstrumentCreator';
import { Settings } from './screens/Settings';
import styles from './App.module.css';

const SCREENS: ScreenId[] = ['instruments', 'composer', 'analyzer', 'settings'];

/** The current screen lives in the URL hash, so that a reload keeps it */
function screenFromHash(): ScreenId {
  const id = window.location.hash.replace(/^#\/?/, '');
  return SCREENS.includes(id as ScreenId) ? (id as ScreenId) : 'instruments';
}

export function App() {
  const [screen, setScreen] = useState<ScreenId>(screenFromHash);
  const [instruments, setInstruments] = usePersistentState<Instrument[]>(
    'synthway.instruments.v1',
    () => PRESET_INSTRUMENTS.map((instrument) => ({ ...instrument })),
    migrateInstruments,
  );
  const [selectedInstrumentId, setSelectedInstrumentId] = usePersistentState<string>(
    'synthway.selected-instrument.v1',
    () => PRESET_INSTRUMENTS[0].id,
  );

  useEffect(() => {
    const onHashChange = () => setScreen(screenFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = (id: ScreenId) => {
    window.location.hash = `/${id}`;
    setScreen(id);
  };

  return (
    <AppearanceProvider>
      <SynthServerProvider>
        <NeonDefs />
        <div className={styles.app}>
          <Sidebar current={screen} onNavigate={navigate} />
          <main className={styles.main}>
            {screen === 'instruments' && (
              <InstrumentCreator
                instruments={instruments}
                setInstruments={setInstruments}
                selectedId={selectedInstrumentId}
                setSelectedId={setSelectedInstrumentId}
              />
            )}
            {screen === 'composer' && <Composer instruments={instruments} />}
            {screen === 'analyzer' && <Analyzer />}
            {screen === 'settings' && <Settings />}
          </main>
        </div>
      </SynthServerProvider>
    </AppearanceProvider>
  );
}
