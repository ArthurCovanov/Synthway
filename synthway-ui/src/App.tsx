import { useEffect, useState } from 'react';
import { NeonDefs } from './components/icons';
import { Sidebar, type ScreenId } from './components/Sidebar';
import { AppearanceProvider } from './lib/appearance';
import { migrateInstruments, PRESET_INSTRUMENTS, type Instrument } from './lib/instruments';
import { usePersistentState } from './lib/storage';
import { SynthServerProvider } from './lib/SynthServer';
import { AINalyzer } from './screens/AINalyzer';
import { Analyzer } from './screens/Analyzer';
import { Composer } from './screens/Composer';
import { InstrumentCreator } from './screens/InstrumentCreator';
import { Settings } from './screens/Settings';
import styles from './App.module.css';

const SCREENS: ScreenId[] = ['instruments', 'composer', 'analyzer', 'ainalyzer', 'settings'];

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

  useEffect(() => {
    const preventAltWheelScroll = (event: WheelEvent) => {
      if (event.altKey) event.preventDefault();
    };
    window.addEventListener('wheel', preventAltWheelScroll, { capture: true, passive: false });
    return () => window.removeEventListener('wheel', preventAltWheelScroll, true);
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
            {screen === 'analyzer' && (
              <Analyzer
                onCreateInstrument={(instrument) => {
                  // A new card at the end of the library, opened in the Instrument Creator
                  setInstruments((list) => [...list, instrument]);
                  setSelectedInstrumentId(instrument.id);
                  navigate('instruments');
                }}
              />
            )}
            {screen === 'ainalyzer' && <AINalyzer onOpenAnalyzer={() => navigate('analyzer')} />}
            {screen === 'settings' && <Settings />}
          </main>
        </div>
      </SynthServerProvider>
    </AppearanceProvider>
  );
}
