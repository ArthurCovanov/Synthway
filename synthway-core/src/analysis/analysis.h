#ifndef SW_ANALYSIS_ANALYSIS_H
#define SW_ANALYSIS_ANALYSIS_H

#include "synthway/types.h"

/* Longest analysis window, in samples (reached from 96 kHz upwards) */
#define SW_ANALYSIS_MAX_WINDOW 16384

/* Scratch memory of an analysis: about 200 KB, too big for the stack.
   The caller owns it; the analysis never allocates. */
typedef struct sw_analysis_workspace {
    float re[SW_ANALYSIS_MAX_WINDOW];
    float im[SW_ANALYSIS_MAX_WINDOW];
    float mag_db[SW_ANALYSIS_MAX_WINDOW / 2 + 1];
    float nsdf[SW_ANALYSIS_MAX_WINDOW / 4 + 1];  /* of the note's window, half the analysis window */
} sw_analysis_workspace;

/* Samples in an analysis window at this sample rate: the power of two that
   covers about 170 ms (8192 at 44.1 and 48 kHz), at most SW_ANALYSIS_MAX_WINDOW.
   The partials are measured on the whole window; the note on its central half,
   which holds two periods down to sample_rate / (window / 4) Hz (23 Hz at 48 kHz). */
uint32_t sw_analysis_window_frames(uint32_t sample_rate);

/* Analyzes window (sw_analysis_window_frames(sample_rate) mono samples):
   level and note from its central half, partials and spectrum from all of it.
   The note is then checked against the partials: refined by its first
   harmonics, or replaced by the lowest audible partial when it falls far below
   it (an inharmonic sound that happens to repeat itself, like a bell).
   noise_gate_db: peaks below it are no partials, and with no partial left there
   is no note either (ambient noise); SW_SPECTRUM_FLOOR_DB changes nothing.
   The level and the spectrum are always the measured ones. */
void sw_analysis_run(
    const float* window,
    uint32_t sample_rate,
    float noise_gate_db,
    sw_analysis_workspace* workspace,
    synthway_analysis_t* out
);

/* The note and level only, without the spectrum (so without the checks of
   sw_analysis_run): cheaper, to follow a whole file */
void sw_analysis_run_pitch(
    const float* window,
    uint32_t sample_rate,
    sw_analysis_workspace* workspace,
    float* out_frequency_hz,
    float* out_clarity,
    float* out_level_db
);

#endif /* SW_ANALYSIS_ANALYSIS_H */
