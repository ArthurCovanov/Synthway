#ifndef SW_ANALYSIS_WAVEFORM_H
#define SW_ANALYSIS_WAVEFORM_H

#include "synthway/synthway.h"

/* Highest harmonic measured, in Hz (and below 45 % of the sample rate) */
#define SW_WAVEFORM_HIGHEST_HZ 16000.0

/* Harmonics of a note at note_hz measured on one spectrum, at most
   SYNTHWAY_WAVEFORM_FIT_HARMONICS */
uint32_t sw_waveform_harmonic_count(float note_hz, float sample_rate);

/* The level of the first count harmonics of note_hz in one spectrum from
   sw_spectrum_compute (frames samples, padded to fft_size), as amplitudes in
   dB (a sine of amplitude A reads 20 log10(A)): the power within 40 cents of
   each harmonic, at least 3 bins, so that a unison spread over a few cents
   counts whole. background_db: the background between harmonics around each
   one, as the same band would read it. shared: 1 for a harmonic that one of
   the other notes (others_hz, other_count of them, others_strength their
   strength relative to the note's) also plays, loud enough to change it: one
   of its first 8 harmonics, its strength divided by its rank (as a sawtooth
   falls) reaching 30 % of the harmonic's amplitude. A weak note under it
   (D4 under A5, whose harmonics are all D4's) leaves its strong harmonics alone. */
void sw_waveform_measure(
    const float* mag_db,
    uint32_t frames,
    uint32_t fft_size,
    float sample_rate,
    float note_hz,
    const float* others_hz,
    const float* others_strength,
    uint32_t other_count,
    uint32_t count,
    float* level_db,
    float* background_db,
    uint8_t* shared
);

/* Level in dB of harmonic n (from 1) of a shape, relative to its 1st, and
   below -150 for a harmonic the shape lacks. duty: for SYNTHWAY_SHAPE_PULSE. */
float sw_waveform_shape_db(uint32_t shape, float duty, uint32_t n);

/* Fills the descriptors and the fits of out from its harmonics
   (harmonic_count, harmonic_db, background_db, harmonic_state), measured on a
   note at out->frequency_hz, sampled at sample_rate. */
void sw_waveform_fit(float sample_rate, synthway_waveform_fit_t* out);

#endif /* SW_ANALYSIS_WAVEFORM_H */
