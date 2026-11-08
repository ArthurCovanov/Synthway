#ifndef SW_SYNTH_OSCILLATOR_H
#define SW_SYNTH_OSCILLATOR_H

#include "synthway/types.h"

/* Phase-accumulator oscillator. The phase is in radians, in [0, 2π), and kept
   in double precision so that it does not drift over long notes. */
typedef struct sw_oscillator {
    double phase;
} sw_oscillator;

void sw_oscillator_reset(sw_oscillator* oscillator);

/* Sample in [-1, 1] of the waveform at the current phase */
float sw_oscillator_sample(const sw_oscillator* oscillator, synthway_waveform_t waveform);

/* Moves the phase forward by one sample at frequency_hz */
void sw_oscillator_advance(sw_oscillator* oscillator, float frequency_hz, float sample_rate);

#endif /* SW_SYNTH_OSCILLATOR_H */
