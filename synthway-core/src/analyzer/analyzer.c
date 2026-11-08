#include "synthway/synthway.h"
#include "analysis/analysis.h"
#include "io/audio_file.h"
#include "io/audio_input.h"
#include <stdlib.h>
#include <string.h>

#define MIN_SAMPLE_RATE 8000
#define MAX_SAMPLE_RATE 384000

/* The analyzer composes its layers: a microphone and a file from io/, and the
   computation of analysis/, with the memory it needs. Independent of the engine. */
struct synthway_analyzer {
    sw_audio_input input;
    sw_audio_clip clip;
    float noise_gate_db;                   /* SYNTHWAY_ANALYZER_NOISE_GATE_OFF: none */
    float window[SW_ANALYSIS_MAX_WINDOW];  /* the samples being analyzed */
    sw_analysis_workspace workspace;
};

/* Copies the window centred on frame centre of samples (count frames) into
   analyzer->window; what falls outside is silence */
static uint32_t sw_analyzer_fill_window(
    synthway_analyzer_t* analyzer,
    const float* samples,
    uint64_t count,
    int64_t centre,
    uint32_t sample_rate
) {
    const uint32_t n = sw_analysis_window_frames(sample_rate);
    const int64_t start = centre - (int64_t)(n / 2);
    for (uint32_t i = 0; i < n; ++i) {
        const int64_t frame = start + (int64_t)i;
        analyzer->window[i] = frame >= 0 && (uint64_t)frame < count ? samples[frame] : 0.0f;
    }
    return n;
}

SYNTHWAY_API synthway_analyzer_t* synthway_analyzer_create(void) {
    synthway_analyzer_t* analyzer = (synthway_analyzer_t*)calloc(1, sizeof(synthway_analyzer_t));
    if (analyzer) {
        analyzer->noise_gate_db = SYNTHWAY_ANALYZER_NOISE_GATE_OFF;
    }
    return analyzer;
}

SYNTHWAY_API void synthway_analyzer_destroy(synthway_analyzer_t* analyzer) {
    if (!analyzer) {
        return;
    }
    sw_audio_input_close(&analyzer->input);
    sw_audio_clip_free(&analyzer->clip);
    free(analyzer);
}

SYNTHWAY_API uint32_t synthway_analysis_get_size(void) {
    return (uint32_t)sizeof(synthway_analysis_t);
}

SYNTHWAY_API synthway_result_t synthway_analyzer_set_noise_gate(synthway_analyzer_t* analyzer, float threshold_db) {
    /* Written this way round, a NaN is refused too */
    if (!analyzer || !(threshold_db >= SYNTHWAY_ANALYZER_NOISE_GATE_OFF && threshold_db <= 0.0f)) {
        return SYNTHWAY_INVALID_PARAM;
    }
    analyzer->noise_gate_db = threshold_db;
    return SYNTHWAY_OK;
}

SYNTHWAY_API float synthway_analyzer_get_noise_gate(const synthway_analyzer_t* analyzer) {
    return analyzer ? analyzer->noise_gate_db : SYNTHWAY_ANALYZER_NOISE_GATE_OFF;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_analyze_samples(
    synthway_analyzer_t* analyzer,
    const float* samples,
    uint32_t frame_count,
    uint32_t sample_rate,
    synthway_analysis_t* out_analysis
) {
    if (!analyzer || !samples || !out_analysis
        || sample_rate < MIN_SAMPLE_RATE || sample_rate > MAX_SAMPLE_RATE) {
        return SYNTHWAY_INVALID_PARAM;
    }
    sw_analyzer_fill_window(analyzer, samples, frame_count, (int64_t)(frame_count / 2), sample_rate);
    sw_analysis_run(analyzer->window, sample_rate, analyzer->noise_gate_db, &analyzer->workspace, out_analysis);
    return SYNTHWAY_OK;
}

/* --------------------------------------------------------------------------
   Microphone
   -------------------------------------------------------------------------- */
SYNTHWAY_API synthway_result_t synthway_analyzer_open_input(
    synthway_analyzer_t* analyzer,
    int device_index,
    uint32_t sample_rate
) {
    if (!analyzer || (sample_rate != 0 && (sample_rate < MIN_SAMPLE_RATE || sample_rate > MAX_SAMPLE_RATE))) {
        return SYNTHWAY_INVALID_PARAM;
    }
    sw_audio_input_close(&analyzer->input);

    /* Exclusive first, to hear the sound without the system's audio effects;
       shared when the device, the backend or another application refuses it */
    synthway_result_t result = SYNTHWAY_ERROR;
    for (int exclusive = 1; exclusive >= 0; --exclusive) {
        result = sw_audio_input_open(&analyzer->input, device_index, sample_rate, exclusive != 0);
        if (result == SYNTHWAY_OK
            && (analyzer->input.sample_rate < MIN_SAMPLE_RATE || analyzer->input.sample_rate > MAX_SAMPLE_RATE)) {
            sw_audio_input_close(&analyzer->input);
            result = SYNTHWAY_BACKEND_ERROR;
        }
        if (result == SYNTHWAY_OK || result == SYNTHWAY_DEVICE_NOT_FOUND) {
            break;
        }
    }
    return result;
}

SYNTHWAY_API bool synthway_analyzer_is_input_exclusive(const synthway_analyzer_t* analyzer) {
    return analyzer ? analyzer->input.exclusive : false;
}

SYNTHWAY_API void synthway_analyzer_close_input(synthway_analyzer_t* analyzer) {
    if (analyzer) {
        sw_audio_input_close(&analyzer->input);
    }
}

SYNTHWAY_API bool synthway_analyzer_is_input_open(const synthway_analyzer_t* analyzer) {
    return analyzer ? sw_audio_input_is_open(&analyzer->input) : false;
}

SYNTHWAY_API uint32_t synthway_analyzer_get_input_sample_rate(const synthway_analyzer_t* analyzer) {
    return analyzer ? analyzer->input.sample_rate : 0;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_analyze_input(
    synthway_analyzer_t* analyzer,
    synthway_analysis_t* out_analysis
) {
    if (!analyzer || !out_analysis || !sw_audio_input_is_open(&analyzer->input)) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const uint32_t sample_rate = analyzer->input.sample_rate;
    const uint32_t n = sw_analysis_window_frames(sample_rate);
    sw_audio_input_read_latest(&analyzer->input, analyzer->window, n);
    sw_analysis_run(analyzer->window, sample_rate, analyzer->noise_gate_db, &analyzer->workspace, out_analysis);
    return SYNTHWAY_OK;
}

/* --------------------------------------------------------------------------
   Audio file
   -------------------------------------------------------------------------- */
/* Keeps a newly decoded clip if its sample rate can be analyzed */
static synthway_result_t sw_analyzer_keep_clip(synthway_analyzer_t* analyzer, synthway_result_t result) {
    if (result == SYNTHWAY_OK
        && (analyzer->clip.sample_rate < MIN_SAMPLE_RATE || analyzer->clip.sample_rate > MAX_SAMPLE_RATE)) {
        sw_audio_clip_free(&analyzer->clip);
        return SYNTHWAY_FORMAT_ERROR;
    }
    return result;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_load_clip(
    synthway_analyzer_t* analyzer,
    const char* path
) {
    if (!analyzer || !path) {
        return SYNTHWAY_INVALID_PARAM;
    }
    sw_audio_clip_free(&analyzer->clip);
    return sw_analyzer_keep_clip(
        analyzer, sw_audio_clip_decode_file(&analyzer->clip, path, SYNTHWAY_ANALYZER_MAX_CLIP_SECONDS)
    );
}

SYNTHWAY_API synthway_result_t synthway_analyzer_load_clip_memory(
    synthway_analyzer_t* analyzer,
    const void* data,
    size_t size
) {
    if (!analyzer || !data || size == 0) {
        return SYNTHWAY_INVALID_PARAM;
    }
    sw_audio_clip_free(&analyzer->clip);
    return sw_analyzer_keep_clip(
        analyzer, sw_audio_clip_decode_memory(&analyzer->clip, data, size, SYNTHWAY_ANALYZER_MAX_CLIP_SECONDS)
    );
}

SYNTHWAY_API synthway_result_t synthway_analyzer_get_clip_info(
    const synthway_analyzer_t* analyzer,
    uint64_t* out_frame_count,
    uint32_t* out_sample_rate
) {
    if (!analyzer || !out_frame_count || !out_sample_rate) {
        return SYNTHWAY_INVALID_PARAM;
    }
    *out_frame_count = analyzer->clip.frame_count;
    *out_sample_rate = analyzer->clip.sample_rate;
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_analyze_clip(
    synthway_analyzer_t* analyzer,
    double time_s,
    synthway_analysis_t* out_analysis
) {
    if (!analyzer || !out_analysis || !analyzer->clip.samples) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_audio_clip* clip = &analyzer->clip;
    sw_analyzer_fill_window(
        analyzer, clip->samples, clip->frame_count, (int64_t)(time_s * clip->sample_rate), clip->sample_rate
    );
    sw_analysis_run(analyzer->window, clip->sample_rate, analyzer->noise_gate_db, &analyzer->workspace, out_analysis);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_get_clip_overview(
    const synthway_analyzer_t* analyzer,
    float* out_peaks,
    uint32_t count
) {
    if (!analyzer || !out_peaks || count == 0 || !analyzer->clip.samples) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_audio_clip* clip = &analyzer->clip;
    for (uint32_t i = 0; i < count; ++i) {
        const uint64_t first = clip->frame_count * i / count;
        uint64_t end = clip->frame_count * (i + 1) / count;
        if (end == first && first < clip->frame_count) {
            end = first + 1; /* more parts than samples */
        }
        float peak = 0.0f;
        for (uint64_t f = first; f < end; ++f) {
            const float v = clip->samples[f] < 0.0f ? -clip->samples[f] : clip->samples[f];
            if (v > peak) peak = v;
        }
        out_peaks[i] = peak;
    }
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_get_clip_track(
    synthway_analyzer_t* analyzer,
    uint32_t count,
    float* out_frequency_hz,
    float* out_clarity,
    float* out_level_db
) {
    if (!analyzer || count == 0 || !analyzer->clip.samples) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_audio_clip* clip = &analyzer->clip;
    for (uint32_t i = 0; i < count; ++i) {
        const int64_t centre = (int64_t)((clip->frame_count * (2 * (uint64_t)i + 1)) / (2 * (uint64_t)count));
        sw_analyzer_fill_window(analyzer, clip->samples, clip->frame_count, centre, clip->sample_rate);
        float frequency, clarity, level;
        sw_analysis_run_pitch(analyzer->window, clip->sample_rate, &analyzer->workspace, &frequency, &clarity, &level);
        if (out_frequency_hz) out_frequency_hz[i] = frequency;
        if (out_clarity) out_clarity[i] = clarity;
        if (out_level_db) out_level_db[i] = level;
    }
    return SYNTHWAY_OK;
}
