import { useEffect, useMemo, useRef } from 'react';
import type { InstrumentParams, ToneParams } from '../types';
import { unisonOf, type Instrument } from './instruments';
import { toTimbre } from './partials';
import { useSynthServer } from './SynthServer';

/** The sound of an instrument, for an instrument slot: partials, band-pass filter, reverb and unison.
    A note's volume is given when it starts. */
export function instrumentSound(instrument: Instrument, maxPartials: number): InstrumentParams {
  return {
    timbre: toTimbre(instrument.partials, maxPartials),
    low_cutoff: instrument.filter.lowCutoff,
    cutoff: instrument.filter.cutoff,
    resonance: instrument.filter.resonance,
    reverb: instrument.reverb ?? 0,
    unison: unisonOf(instrument),
  };
}

/** What the engine plays of an instrument on instrument 0: its sound, and the single note's volume */
export function instrumentParams(instrument: Instrument, maxPartials: number): ToneParams {
  return { volume: instrument.volume, ...instrumentSound(instrument, maxPartials) };
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
