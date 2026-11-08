#ifndef SW_ANALYSIS_SPECTRUM_H
#define SW_ANALYSIS_SPECTRUM_H

#include "synthway/types.h"

/* Floor of every level in dB: what silence reads */
#define SW_SPECTRUM_FLOOR_DB -120.0f

/* Range of the partials, relative to the strongest one: weaker peaks are ignored */
#define SW_SPECTRUM_PARTIAL_RANGE_DB 60.0f

/* Magnitude spectrum of x (n samples) through a Blackman window, padded with
   silence up to fft_size (a power of two, at least n), in dBFS: a sine of
   amplitude A reads 20 log10(A) at its frequency. mag_db gets fft_size / 2 + 1
   values, one every sample_rate / fft_size Hz.
   re and im are scratch buffers of fft_size floats. */
void sw_spectrum_compute(const float* x, uint32_t n, uint32_t fft_size, float* re, float* im, float* mag_db);

/* The peaks of a spectrum from sw_spectrum_compute (window_frames samples
   padded to fft_size), as partials (their ratio is left at 0). A peak counts
   when it stands out from its neighbours, from the noise floor, is at most
   SW_SPECTRUM_PARTIAL_RANGE_DB below the strongest one, and reaches gate_db
   (SW_SPECTRUM_FLOOR_DB: no gate). Fills out->partial_count and
   out->partials, sorted by frequency. */
void sw_spectrum_find_partials(
    const float* mag_db,
    uint32_t window_frames,
    uint32_t fft_size,
    float sample_rate,
    float gate_db,
    synthway_analysis_t* out
);

/* Resamples the spectrum (of fft_size points) on SYNTHWAY_ANALYSIS_SPECTRUM_POINTS
   logarithmic frequencies, for display. Fills out->spectrum_min_hz,
   spectrum_max_hz and spectrum_db. */
void sw_spectrum_display(const float* mag_db, uint32_t fft_size, float sample_rate, synthway_analysis_t* out);

#endif /* SW_ANALYSIS_SPECTRUM_H */
