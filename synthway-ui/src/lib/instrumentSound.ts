import { useEffect, useMemo, useRef } from 'react';
import type { ToneParams } from '../types';
import { unisonOf, type Instrument } from './instruments';
import { toTimbre } from './partials';
import { useSynthServer } from './SynthServer';

/** What the engine plays of an instrument: its volume, partials, band-pass filter, reverb and unison */
export function instrumentParams(instrument: Instrument, maxPartials: number): ToneParams {
  return {
    volume: instrument.volume,
    timbre: toTimbre(instrument.partials, maxPartials),
    low_cutoff: instrument.filter.lowCutoff,
    cutoff: instrument.filter.cutoff,
    resonance: instrument.filter.resonance,
    reverb: instrument.reverb ?? 0,
    unison: unisonOf(instrument),
  };
}

/**
 * While the audio is on, the engine plays this instrument and follows its
 * changes. Only a change of what it plays is sent (not its name, say).
 * null: the engine keeps what it has.
 */
export function useInstrumentSound(instrument: Instrument | null): void {
  const { engine, setParams } = useSynthServer();
  const params = useMemo(
    () => (instrument ? instrumentParams(instrument, engine.maxPartials) : null),
    [instrument, engine.maxPartials],
  );
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const key = params ? JSON.stringify(params) : '';
  useEffect(() => {
    if (engine.running && paramsRef.current) setParams(paramsRef.current);
  }, [engine.running, key, setParams]);
}
