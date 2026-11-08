#ifndef SYNTHWAY_ANALYZER_H
#define SYNTHWAY_ANALYZER_H

/* The sound analyzer: finds the note played and the partials of a sound,
   heard from a microphone, read from an audio file, or given as samples.
   Independent of the engine: it plays nothing, and records the microphone
   only when asked (synthway_analyzer_start_recording).
   Implemented in src/analyzer/ (the computation in src/analysis/).
   Include "synthway/synthway.h" rather than this file.

   An analyzer is not thread-safe: call it from one thread at a time (use one
   analyzer per thread). Only its microphone runs on a thread of its own. */

#include <stddef.h>
#include "synthway/types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Longest audio file an analyzer loads, in seconds */
#define SYNTHWAY_ANALYZER_MAX_CLIP_SECONDS 600

/* --------------------------------------------------------------------------
   Analyzer Lifecycle
   -------------------------------------------------------------------------- */
/**
 * Allocates a new analyzer (about 1.7 MB), without microphone or file.
 * Returns NULL when memory runs out.
 */
SYNTHWAY_API synthway_analyzer_t* synthway_analyzer_create(void);

/**
 * Closes the microphone, frees the loaded file and the analyzer.
 */
SYNTHWAY_API void synthway_analyzer_destroy(synthway_analyzer_t* analyzer);

/**
 * sizeof(synthway_analysis_t), for callers that copy the structure, such as
 * the Python bridge, to check that they agree with this build.
 */
SYNTHWAY_API uint32_t synthway_analysis_get_size(void);

/* --------------------------------------------------------------------------
   Noise Gate (optional)
   -------------------------------------------------------------------------- */

/* Gate off: the default, every analysis as measured */
#define SYNTHWAY_ANALYZER_NOISE_GATE_OFF -120.0f

/**
 * Ignores weak ambient noise (a fan, breath, the room): peaks of the spectrum
 * below threshold_db (dBFS, on the scale of spectrum_db) are not partials, and
 * when no partial is left, there is no note either. The level and the spectrum
 * stay as measured. From SYNTHWAY_ANALYZER_NOISE_GATE_OFF (-120, nothing is
 * ignored: the default) to 0; otherwise SYNTHWAY_INVALID_PARAM, and the gate
 * in place is kept. Applies to every analysis of this analyzer (samples,
 * microphone, file), but not to the note track of a file.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_set_noise_gate(synthway_analyzer_t* analyzer, float threshold_db);

SYNTHWAY_API float synthway_analyzer_get_noise_gate(const synthway_analyzer_t* analyzer);

/* --------------------------------------------------------------------------
   Analysis of Samples
   -------------------------------------------------------------------------- */
/**
 * Analyzes frame_count mono samples at sample_rate (8000 to 384000 Hz) around
 * their middle: the note, its partials and the spectrum. The window is about
 * 170 ms long (8192 samples at 48 kHz); shorter buffers are padded with silence.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_analyze_samples(
    synthway_analyzer_t* analyzer,
    const float* samples,
    uint32_t frame_count,
    uint32_t sample_rate,
    synthway_analysis_t* out_analysis
);

/* --------------------------------------------------------------------------
   Microphone (live analysis)
   -------------------------------------------------------------------------- */
/**
 * Opens a capture device (index in the capture list of synthway_get_device_info,
 * -1 for the system default) and starts listening, in mono. sample_rate 0 takes
 * the device's own rate. The latest seconds are kept in memory for the
 * analysis, and saved only while recording. Opening again closes the previous
 * device first (and stops a recording, see synthway_analyzer_stop_recording).
 * The device is opened in exclusive mode when possible: on Windows, the sound
 * then comes without the system's audio effects (noise suppression, automatic
 * gain), which fade a held note; meanwhile no other application can use it.
 * Otherwise, in shared mode (see synthway_analyzer_is_input_exclusive).
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_open_input(
    synthway_analyzer_t* analyzer,
    int device_index,
    uint32_t sample_rate
);

/**
 * Opens an input fed by the caller instead of a capture device, in place of
 * the microphone, at sample_rate (8000 to 384000 Hz): the caller then plays
 * the part of the capture thread with synthway_analyzer_write_input.
 * Everything else works as with a microphone (analyze_input, recording).
 * For tests without a microphone, or for a sound the caller captures itself.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_open_virtual_input(
    synthway_analyzer_t* analyzer,
    uint32_t sample_rate
);

/**
 * Feeds frame_count mono samples to the virtual input, as the capture thread
 * would. Call it from one thread at a time, which may differ from the thread
 * using the analyzer. SYNTHWAY_INVALID_PARAM when no virtual input is open.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_write_input(
    synthway_analyzer_t* analyzer,
    const float* samples,
    uint32_t frame_count
);

/**
 * Stops listening and releases the capture device (or the virtual input).
 * A recording in progress stops first and becomes the clip.
 */
SYNTHWAY_API void synthway_analyzer_close_input(synthway_analyzer_t* analyzer);

SYNTHWAY_API bool synthway_analyzer_is_input_open(const synthway_analyzer_t* analyzer);

/**
 * true when the capture device was opened in exclusive mode, false in shared
 * mode (the system's audio effects then apply) or when closed.
 */
SYNTHWAY_API bool synthway_analyzer_is_input_exclusive(const synthway_analyzer_t* analyzer);

/**
 * Sample rate the capture device actually uses, 0 when closed.
 */
SYNTHWAY_API uint32_t synthway_analyzer_get_input_sample_rate(const synthway_analyzer_t* analyzer);

/**
 * Analyzes what the microphone heard last (the latest window, about 170 ms).
 * While recording, first takes the new samples for the recording.
 * Returns SYNTHWAY_INVALID_PARAM when the microphone is closed.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_analyze_input(
    synthway_analyzer_t* analyzer,
    synthway_analysis_t* out_analysis
);

/* --------------------------------------------------------------------------
   Recording the Microphone
   -------------------------------------------------------------------------- */
/**
 * Starts recording what the microphone hears from now on, in memory, with no
 * time limit (about 11 MB a minute at 48 kHz). The microphone must be open,
 * otherwise SYNTHWAY_NOT_RUNNING. A recording in progress is dropped.
 * The capture thread only fills the microphone's ring buffer (about 5 s at
 * 48 kHz); the recording takes the new samples from it whenever the analyzer
 * is called (analyze_input or get_recording_info): call one of them at least
 * every second. Samples overwritten before that are replaced by silence and
 * counted as lost.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_start_recording(synthway_analyzer_t* analyzer);

/**
 * Stops recording, and makes the recording the analyzer's clip, in place of
 * the loaded file: analyze_clip, get_clip_overview, get_clip_track and
 * save_clip_wav then work on it (the 10-minute limit of files does not apply).
 * The microphone stays open. Returns SYNTHWAY_NOT_RUNNING, and keeps the
 * clip, when nothing is being recorded or not a single sample was captured.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_stop_recording(synthway_analyzer_t* analyzer);

SYNTHWAY_API bool synthway_analyzer_is_recording(const synthway_analyzer_t* analyzer);

/**
 * Frames of the recording in progress, or of the last one, at the
 * microphone's sample rate, and how many of them are silence standing for
 * lost samples. While recording, first takes the new samples from the
 * microphone. 0 and 0 before any recording.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_get_recording_info(
    synthway_analyzer_t* analyzer,
    uint64_t* out_frame_count,
    uint64_t* out_lost_frames
);

/* --------------------------------------------------------------------------
   Audio File (clip)
   -------------------------------------------------------------------------- */
/**
 * Loads a WAV, FLAC or MP3 file, decoded in memory as stereo (mono files are
 * duplicated to both channels) and analyzed as a mono mix, in
 * place of the previous one. Returns SYNTHWAY_IO_ERROR when the file cannot be
 * read, SYNTHWAY_FORMAT_ERROR when it is not audio, SYNTHWAY_INVALID_PARAM when
 * it is longer than SYNTHWAY_ANALYZER_MAX_CLIP_SECONDS. On failure, the
 * previous file is unloaded.
 * The path goes to fopen(): ANSI code page on Windows, UTF-8 elsewhere.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_load_clip(
    synthway_analyzer_t* analyzer,
    const char* path
);

/**
 * Same as synthway_analyzer_load_clip, from a file held in memory (size bytes).
 * The data is decoded at once: it can be freed when the call returns.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_load_clip_memory(
    synthway_analyzer_t* analyzer,
    const void* data,
    size_t size
);

/**
 * Length and sample rate of the loaded file (0 and 0 when none).
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_get_clip_info(
    const synthway_analyzer_t* analyzer,
    uint64_t* out_frame_count,
    uint32_t* out_sample_rate
);

/**
 * Analyzes the loaded file around time_s (seconds from its start): the note,
 * its partials and the spectrum. Before the start or past the end counts as
 * silence. Returns SYNTHWAY_INVALID_PARAM when no file is loaded.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_analyze_clip(
    synthway_analyzer_t* analyzer,
    double time_s,
    synthway_analysis_t* out_analysis
);

/* Analysis window of synthway_analyzer_analyze_clip_range: the usual one
   (about 170 ms, a power of two), or a length in seconds from MIN to MAX, at
   most 32768 samples (341 ms at 96 kHz) */
#define SYNTHWAY_ANALYZER_WINDOW_AUTO 0.0
#define SYNTHWAY_ANALYZER_MIN_WINDOW_S 0.01
#define SYNTHWAY_ANALYZER_MAX_WINDOW_S 0.5

/* Reference note of synthway_analyzer_analyze_clip_range: found by the
   analysis, or given, in Hz, from MIN to MAX (C0 to above the piano's top) */
#define SYNTHWAY_ANALYZER_REFERENCE_AUTO 0.0f
#define SYNTHWAY_ANALYZER_MIN_REFERENCE_HZ 16.0f
#define SYNTHWAY_ANALYZER_MAX_REFERENCE_HZ 5000.0f

/* Partials kept by synthway_analyzer_analyze_clip_range: all of them, or only
   the harmonics, within up to MAX cents of a whole ratio */
#define SYNTHWAY_ANALYZER_ALL_PARTIALS 0.0f
#define SYNTHWAY_ANALYZER_MAX_HARMONIC_CENTS 100.0f

/**
 * Analyzes a zone of the loaded file, from start_s to end_s (seconds), with
 * windows of window_s seconds (SYNTHWAY_ANALYZER_WINDOW_AUTO: the usual one).
 * A zone no longer than a window is analyzed in one window around its middle:
 * the zone [t - window_s / 2, t + window_s / 2] is the moment t seen through a
 * window of that size. A longer zone is analyzed at up to 100 moments, at
 * least 10 ms apart, from its start to its end, and the result is their
 * median: the note, and each partial, matched from one moment to the next by
 * its ratio to the note, kept if found in at least half the moments, with the
 * median of its ratio and amplitude; the level, clarity and spectrum point by
 * point.
 * reference_hz: the note the ratios are taken to. SYNTHWAY_ANALYZER_REFERENCE_AUTO:
 * the note heard (for a zone, the low end of its clear notes, so that a
 * fundamental fading first, which makes later moments read an octave higher,
 * does not lift it). Each clear moment on the reference's note, in whatever
 * octave (within 1.5 semitones), has its own note moved to the reference's
 * octave, and its ratios are taken to it: vibrato, an imperfect pitch and
 * octave errors leave them unchanged. Attacks (unclear moments) and other
 * notes are left out of the medians of the partials; the result's note is the
 * median of the moments kept.
 * harmonic_cents: SYNTHWAY_ANALYZER_ALL_PARTIALS keeps every partial; above 0,
 * only those within that many cents of a whole ratio (1, 2, 3…), and the
 * strongest one of each harmonic, which leaves out most of the other
 * instruments of a mix (amplitudes relative to the strongest kept).
 * SYNTHWAY_INVALID_PARAM without a file, when end_s <= start_s, or for a
 * window, reference or tolerance out of range; SYNTHWAY_ERROR when memory runs out.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_analyze_clip_range(
    synthway_analyzer_t* analyzer,
    double start_s,
    double end_s,
    double window_s,
    float reference_hz,
    float harmonic_cents,
    synthway_analysis_t* out_analysis
);

/**
 * The envelope of each partial over a zone that holds one note, from its
 * attack to the next note: finds the partials as synthway_analyzer_analyze_clip_range
 * does (same parameters), then follows each one's level every 5 ms at its
 * frequency, over a window of 6 periods of the note (20 to 100 ms), and fits
 * an exponential envelope to it (SYNTHWAY_ENVELOPE_EXPONENTIAL): the attack
 * is the rise to its peak; the decay its steady fall after it, until it fades
 * out or the next note rises (decay_s: the time to fall 60 dB at that speed);
 * a partial that falls slower than 3 dB/s is held (sustain 1); one whose fall
 * levels off settles at that level; otherwise it decays to silence
 * (sustain 0). The release lasts 0.3 s, as a damper stops a string, or less
 * for a partial that fades faster: a note cut by the next one tells nothing of it.
 * out_envelopes gets one envelope per partial of out_analysis, in the same
 * order (room for SYNTHWAY_ANALYSIS_MAX_PARTIALS); the partials' amplitudes
 * become their peaks, relative to the strongest. Very short attacks read
 * longer than they are: a few milliseconds become about 10 ms.
 * Returns what synthway_analyzer_analyze_clip_range returns, and
 * SYNTHWAY_INVALID_PARAM without out_envelopes.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_measure_envelopes(
    synthway_analyzer_t* analyzer,
    double start_s,
    double end_s,
    double window_s,
    float reference_hz,
    float harmonic_cents,
    synthway_analysis_t* out_analysis,
    synthway_envelope_t* out_envelopes
);

/* A note heard in a zone, and when (synthway_analyzer_find_notes) */
typedef struct synthway_note_span {
    double start_s;            /* seconds from the start of the file */
    double end_s;
    float frequency_hz;        /* its fundamental, the geometric mean over its moments */
    float strength;            /* in (0, 1]: 1 for the strongest note of the zone */
} synthway_note_span_t;

/* Most notes heard at once, at one moment */
#define SYNTHWAY_ANALYZER_MAX_NOTES_AT_ONCE 4

/**
 * The notes heard in a zone of the loaded file, even several at once (a chord,
 * a melody over a held note), and when each starts and ends. The zone is
 * analyzed at the same moments as synthway_analyzer_analyze_clip_range (same
 * window_s). At each moment, the note whose harmonics explain the most of the
 * partials is found first (each harmonic weighed down when it stands far above
 * its neighbours, and a note whose own fundamental is much weaker than its
 * other harmonics weighed down too: the 3rd and 4th harmonics of D4 are A5 and
 * D6, which a missing D4 would explain as well as A5 and D6 played together);
 * its harmonics are taken out, and the next note is looked for in what is
 * left, up to SYNTHWAY_ANALYZER_MAX_NOTES_AT_ONCE, while it stays above a fifth
 * of the first. A note followed from moment to moment (within half a
 * semitone, up to 3 missing moments in a row) becomes a span; one heard for
 * less than 60 ms is dropped, unless the zone is shorter. out_notes gets up to capacity spans, by start
 * then by frequency; out_count the number written. SYNTHWAY_INVALID_PARAM as
 * synthway_analyzer_analyze_clip_range, or without out_notes or out_count.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_find_notes(
    synthway_analyzer_t* analyzer,
    double start_s,
    double end_s,
    double window_s,
    synthway_note_span_t* out_notes,
    uint32_t capacity,
    uint32_t* out_count
);

/* Shapes a note's harmonics are compared with (synthway_analyzer_fit_waveform):
   the engine's waveforms, with the values of synthway_waveform_t, and a pulse */
typedef enum synthway_wave_shape {
    SYNTHWAY_SHAPE_SINE = 0,       /* the fundamental alone */
    SYNTHWAY_SHAPE_SQUARE = 1,     /* odd harmonics, in 1/n */
    SYNTHWAY_SHAPE_TRIANGLE = 2,   /* odd harmonics, in 1/n² */
    SYNTHWAY_SHAPE_SAWTOOTH = 3,   /* every harmonic, in 1/n */
    SYNTHWAY_SHAPE_PULSE = 4       /* every harmonic, in |sin(π n duty)| / n: a gap every 1/duty harmonics */
} synthway_wave_shape_t;
#define SYNTHWAY_SHAPE_COUNT 5

/* Most harmonics a waveform fit measures, from the 1st */
#define SYNTHWAY_WAVEFORM_FIT_HARMONICS 64

/* What one harmonic of the note is, in a waveform fit */
#define SYNTHWAY_HARMONIC_HEARD 0    /* stands above the background around it */
#define SYNTHWAY_HARMONIC_FAINT 1    /* does not: missing, or too weak to tell */
#define SYNTHWAY_HARMONIC_SHARED 2   /* also a harmonic of another note heard with it: left out of the fit */

/* One shape, with the low-pass and the level that bring it closest to the harmonics measured */
typedef struct synthway_shape_fit {
    uint32_t shape;            /* synthway_wave_shape_t */
    float duty;                /* share of the period a pulse is high, in (0, 0.5); 0.5 for the square, 0 for the others */
    float cutoff_hz;           /* the engine's low-pass (12 dB per octave, synthway_engine_set_filter) that fits best; 0: none */
    float resonance;           /* of that low-pass, in [0, 1] as synthway_engine_set_filter */
    float error_db;            /* mean gap between the harmonics measured and the shape's, through that low-pass */
} synthway_shape_fit_t;

/* The harmonics of a note, and the waveforms closest to them (synthway_analyzer_fit_waveform) */
typedef struct synthway_waveform_fit {
    float frequency_hz;        /* the note whose harmonics are measured; 0: no note */
    uint32_t moment_count;     /* moments of the zone where that note is heard (0: none, then no fit) */
    uint32_t harmonic_count;   /* harmonics measured, from the 1st: below 16 kHz and 45 % of the sample rate */
    float harmonic_db[SYNTHWAY_WAVEFORM_FIT_HARMONICS];   /* level of each, dB relative to the strongest heard (0) */
    float background_db[SYNTHWAY_WAVEFORM_FIT_HARMONICS]; /* level of the background around each, on the same scale */
    uint8_t harmonic_state[SYNTHWAY_WAVEFORM_FIT_HARMONICS]; /* SYNTHWAY_HARMONIC_* */
    float even_db;             /* even harmonics against the mean of their odd neighbours, in dB: a sawtooth about -1, a square far below */
    uint32_t even_count;       /* even harmonics compared (0: even_db tells nothing) */
    float slope_db_per_octave; /* how fast the heard harmonics fall: -6 for a sawtooth or a square, -12 for a triangle */
    uint32_t fit_count;        /* SYNTHWAY_SHAPE_COUNT; 0 without a note, a note never heard alone, or no harmonic heard */
    synthway_shape_fit_t fits[SYNTHWAY_SHAPE_COUNT]; /* one per shape, closest first */
} synthway_waveform_fit_t;

/**
 * Which waveform a note of the loaded file is closest to: sawtooth, square,
 * triangle, pulse or sine, each through the low-pass of the engine that fits
 * best, since a synthesizer's sound is seldom heard unfiltered (a filtered
 * sawtooth falls as fast as a triangle; its even harmonics tell them apart).
 * The note is the one synthway_analyzer_analyze_clip_range finds in the zone
 * (keeping only harmonics, within 30 cents), or reference_hz when given. At
 * each moment of the zone (the same moments, same window_s) where that note
 * is heard (synthway_analyzer_find_notes would find it), the level of each
 * of its harmonics is measured, even a missing one: the power within 40
 * cents of it (or 3 bins), so that a unison spread over a few cents counts
 * whole, against the background between harmonics. A harmonic that is also a
 * harmonic of another note heard at that moment is left out there (A5 x 4 is
 * D6 x 3). The medians over the moments are compared with each shape, its
 * level and low-pass (cutoff, resonance) set to come closest; the gap is
 * weighed down for higher harmonics (by the square root of their rank), and
 * a shape's harmonics below the background count as the background.
 * Ratios are not phases: two waveforms with the same harmonics read the same.
 * With no note, or a note never heard alone (a chord on its missing
 * fundamental), out_fit has no fit (fit_count 0), and SYNTHWAY_OK.
 * SYNTHWAY_INVALID_PARAM as synthway_analyzer_analyze_clip_range, or without
 * out_fit; SYNTHWAY_ERROR when memory runs out.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_fit_waveform(
    synthway_analyzer_t* analyzer,
    double start_s,
    double end_s,
    double window_s,
    float reference_hz,
    synthway_waveform_fit_t* out_fit
);

/**
 * Waveform of the whole file, for display: cuts it into count equal parts and
 * writes the peak (largest absolute sample) of each into out_peaks.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_get_clip_overview(
    const synthway_analyzer_t* analyzer,
    float* out_peaks,
    uint32_t count
);

/**
 * Stereo waveform of the loaded file: writes each channel's peak in each of
 * count equal parts. Mono recordings are duplicated to both output channels.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_get_clip_stereo_overview(
    const synthway_analyzer_t* analyzer,
    float* out_left_peaks,
    float* out_right_peaks,
    uint32_t count
);

/**
 * Waveform of a part of the clip, to draw it at any zoom: cuts the frame_count
 * frames from first_frame into count equal parts and writes, for each part,
 * the lowest and the highest sample of each channel (a mono clip gives the
 * same values to both). With count equal to frame_count, each part is one
 * sample, both its lowest and its highest. A range running past the end of
 * the clip stops there. SYNTHWAY_INVALID_PARAM without a clip, when count or
 * frame_count is 0, or when first_frame is past the end.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_get_clip_waveform(
    const synthway_analyzer_t* analyzer,
    uint64_t first_frame,
    uint64_t frame_count,
    uint32_t count,
    float* out_left_low,
    float* out_left_high,
    float* out_right_low,
    float* out_right_high
);

/**
 * The note along the whole file: analyzes count moments, evenly spread (the
 * middle of each of count equal parts), and writes for each its fundamental
 * (0 when none), clarity and level, as in synthway_analysis_t. Any output
 * pointer may be NULL. Cheaper than analyze_clip: no partials, no spectrum.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_get_clip_track(
    synthway_analyzer_t* analyzer,
    uint32_t count,
    float* out_frequency_hz,
    float* out_clarity,
    float* out_level_db
);

/**
 * Writes the clip (the loaded file or the last recording) to path as a mono
 * 16-bit WAV file at its own sample rate, creating or overwriting it.
 * SYNTHWAY_INVALID_PARAM without a clip, SYNTHWAY_IO_ERROR when the file
 * cannot be written. The path goes to fopen(), as for load_clip.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_save_clip_wav(
    const synthway_analyzer_t* analyzer,
    const char* path
);

#ifdef __cplusplus
}
#endif

#endif /* SYNTHWAY_ANALYZER_H */
