#ifndef SW_ANALYSIS_ANALYSIS_H
#define SW_ANALYSIS_ANALYSIS_H

#include "synthway/types.h"

/* Shortest and longest analysis windows, in samples (the longest is reached
   by the usual window from 192 kHz upwards) */
#define SW_ANALYSIS_MIN_WINDOW 256
#define SW_ANALYSIS_MAX_WINDOW 32768

/* Scratch memory of an analysis: about 400 KB, too big for the stack.
   The caller owns it; the analysis never allocates. */
typedef struct sw_analysis_workspace {
    float re[SW_ANALYSIS_MAX_WINDOW];
    float im[SW_ANALYSIS_MAX_WINDOW];
    float mag_db[SW_ANALYSIS_MAX_WINDOW / 2 + 1];
    float nsdf[SW_ANALYSIS_MAX_WINDOW / 4 + 1];  /* of the note's window, at most half the longest one */
} sw_analysis_workspace;

/* Samples in the usual analysis window at this sample rate: the power of two
   that covers about 170 ms (8192 at 44.1 and 48 kHz), at most SW_ANALYSIS_MAX_WINDOW.
   The partials are measured on the whole window; the note on its central half,
   which holds two periods down to sample_rate / (window / 4) Hz (23 Hz at 48 kHz). */
uint32_t sw_analysis_window_frames(uint32_t sample_rate);

/* Samples in a window of about `seconds`, from SW_ANALYSIS_MIN_WINDOW to SW_ANALYSIS_MAX_WINDOW */
uint32_t sw_analysis_frames_for(double seconds, uint32_t sample_rate);

/* Analyzes window (frames mono samples, SW_ANALYSIS_MIN_WINDOW to
   SW_ANALYSIS_MAX_WINDOW; any count, the spectrum pads it with silence up to a
   power of two): level and note from its centre, partials and spectrum from
   all of it. The note is taken on the central half, or on more of the window
   when that half is shorter than half the usual window, so that short windows
   still find low notes (two periods must fit).
   The note is then checked against the partials: refined by its first
   harmonics, or replaced by the lowest audible partial when it falls far below
   it (an inharmonic sound that happens to repeat itself, like a bell).
   noise_gate_db: peaks below it are no partials, and with no partial left there
   is no note either (ambient noise); SW_SPECTRUM_FLOOR_DB changes nothing.
   The level and the spectrum are always the measured ones. */
void sw_analysis_run(
    const float* window,
    uint32_t frames,
    uint32_t sample_rate,
    float noise_gate_db,
    sw_analysis_workspace* workspace,
    synthway_analysis_t* out
);

/* The note and level only, without the spectrum (so without the checks of
   sw_analysis_run): cheaper, to follow a whole file */
void sw_analysis_run_pitch(
    const float* window,
    uint32_t frames,
    uint32_t sample_rate,
    sw_analysis_workspace* workspace,
    float* out_frequency_hz,
    float* out_clarity,
    float* out_level_db
);

/* One partial of one analysis, while sw_analysis_combine matches them */
typedef struct sw_analysis_peak {
    float key;                 /* ratio to the note, or frequency without a note */
    float amplitude;
    uint32_t moment;           /* index of its analysis */
} sw_analysis_peak;

/* Takes the partials of one analysis to reference_hz (0: its own note): the
   note becomes the one heard moved to the reference's octave when it is near
   it (within 1.5 semitones of one of its octaves, and clear), else the
   reference itself, and every ratio is to that note. harmonic_cents > 0 then
   keeps only the partials within that many cents of a whole ratio (1, 2, 3…),
   amplitudes relative to the strongest kept. */
void sw_analysis_relate(synthway_analysis_t* out, float reference_hz, float harmonic_cents);

/* Combines the analyses of count moments of a zone (count >= 1) into one, by
   medians: level, clarity and each point of the spectrum over every moment.
   The note is referred to reference_hz, or without it (0) to the low end of
   the clear notes heard (a fundamental that fades first makes later moments
   read an octave higher). Each clear moment on that note, in whatever octave,
   has its own note moved to the reference's octave, and its partials are
   matched from one moment to the next by their ratio to it, which vibrato,
   an imperfect pitch and octave errors leave unchanged; attacks, noise and
   other notes count out. The note is the median of those moments'. Without a
   reference given and with fewer than a quarter of the moments on the note,
   there is no note, and partials are matched by frequency. A partial found in
   at least half the moments that count is kept, with the median of its ratio
   and of its amplitude; the strongest SYNTHWAY_ANALYSIS_MAX_PARTIALS,
   amplitudes relative to the strongest one, and with harmonic_cents > 0 only
   the harmonics (see sw_analysis_relate).
   Scratch memory from the caller: peaks and values of count *
   SYNTHWAY_ANALYSIS_MAX_PARTIALS entries, references and marks of count entries. */
void sw_analysis_combine(
    const synthway_analysis_t* moments,
    uint32_t count,
    float reference_hz,
    float harmonic_cents,
    sw_analysis_peak* peaks,
    float* values,
    float* references,
    uint32_t* marks,
    synthway_analysis_t* out
);

#endif /* SW_ANALYSIS_ANALYSIS_H */
