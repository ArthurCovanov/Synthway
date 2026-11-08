#ifndef SYNTHWAY_ANALYZER_H
#define SYNTHWAY_ANALYZER_H

/* The sound analyzer: finds the note played and the partials of a sound,
   heard from a microphone, read from an audio file, or given as samples.
   Independent of the engine: it neither plays nor records anything.
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
 * Allocates a new analyzer (about 600 KB), without microphone or file.
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
 * the device's own rate. The latest second or so is kept in memory for the
 * analysis, never saved. Opening again closes the previous device first.
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
 * Stops listening and releases the capture device.
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
 * Returns SYNTHWAY_INVALID_PARAM when the microphone is closed.
 */
SYNTHWAY_API synthway_result_t synthway_analyzer_analyze_input(
    synthway_analyzer_t* analyzer,
    synthway_analysis_t* out_analysis
);

/* --------------------------------------------------------------------------
   Audio File (clip)
   -------------------------------------------------------------------------- */
/**
 * Loads a WAV, FLAC or MP3 file, decoded in memory and mixed down to mono, in
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

#ifdef __cplusplus
}
#endif

#endif /* SYNTHWAY_ANALYZER_H */
