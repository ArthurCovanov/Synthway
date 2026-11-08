#ifndef SW_ANALYSIS_SPECTRUM_H
#define SW_ANALYSIS_SPECTRUM_H

#include "synthway/types.h"

/* Floor of every level in dB: what silence reads */
#define SW_SPECTRUM_FLOOR_DB -120.0f

/* Range of the partials, relative to the strongest one: weaker peaks are ignored */
#define SW_SPECTRUM_PARTIAL_RANGE_DB 60.0f

/* Magnitude spectrum of x (n samples, n a power of two) through a Blackman
   window, in dBFS: a sine of amplitude A reads 20 log10(A) at its frequency.
   mag_db gets n / 2 + 1 values, one every sample_rate / n Hz.
   re and im are scratch buffers of n floats. */
void sw_spectrum_compute(const float* x, uint32_t n, float* re, float* im, float* mag_db);

/* The peaks of the spectrum, as partials (their ratio is left at 0). A peak
   counts when it stands out from its neighbours, from the noise floor, is at
   most SW_SPECTRUM_PARTIAL_RANGE_DB below the strongest one, and reaches
   gate_db (SW_SPECTRUM_FLOOR_DB: no gate). Fills out->partial_count and
   out->partials, sorted by frequency. */
void sw_spectrum_find_partials(
    const float* mag_db,
    uint32_t n,
    float sample_rate,
    float gate_db,
    synthway_analysis_t* out
);

/* Resamples the spectrum on SYNTHWAY_ANALYSIS_SPECTRUM_POINTS logarithmic
   frequencies, for display. Fills out->spectrum_min_hz, spectrum_max_hz and
   spectrum_db. */
void sw_spectrum_display(const float* mag_db, uint32_t n, float sample_rate, synthway_analysis_t* out);

#endif /* SW_ANALYSIS_SPECTRUM_H */
