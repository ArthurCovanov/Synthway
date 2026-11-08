#include "synthway/synthway.h"
#include "analysis/analysis.h"
#include "analysis/notes.h"
#include "analysis/spectrum.h"
#include "analysis/waveform.h"
#include "io/audio_file.h"
#include "io/audio_input.h"
#include "io/wav_file.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define MIN_SAMPLE_RATE 8000
#define MAX_SAMPLE_RATE 384000

/* Frames of the microphone's ring left to its writer when a recording takes
   samples out: the capture thread keeps writing during the copy */
#define RECORDING_MARGIN_FRAMES (SW_AUDIO_INPUT_RING_FRAMES / 4)

/* A recording of the microphone, growing in memory outside the audio thread */
typedef struct sw_analyzer_recording {
    bool active;
    uint64_t position;        /* next frame of the input to take, counted since it opened */
    float* samples;           /* allocated, NULL when empty; handed to the clip at the end */
    uint64_t frame_count;
    uint64_t capacity;
    uint64_t lost_frames;     /* silence standing for samples overwritten before being taken */
} sw_analyzer_recording;

/* The analyzer composes its layers: a microphone and a file from io/, and the
   computation of analysis/, with the memory it needs. Independent of the engine. */
struct synthway_analyzer {
    sw_audio_input input;
    sw_audio_clip clip;                    /* a loaded file, or the last recording */
    sw_analyzer_recording recording;
    float noise_gate_db;                   /* SYNTHWAY_ANALYZER_NOISE_GATE_OFF: none */
    float window[SW_ANALYSIS_MAX_WINDOW];  /* the samples being analyzed */
    sw_analysis_workspace workspace;
};

/* Most moments analyzed in a zone, and the shortest step between two */
#define MAX_ZONE_MOMENTS 100
#define MIN_ZONE_STEP_SECONDS 0.01

/* Envelopes: each partial's level every ENVELOPE_STEP_SECONDS (further apart
   when the zone would need more than MAX_ENVELOPE_STEPS), measured over
   ENVELOPE_PERIODS periods of the note, to keep its neighbours out */
#define ENVELOPE_STEP_SECONDS 0.005
#define MAX_ENVELOPE_STEPS 400
#define ENVELOPE_PERIODS 6.0
#define MIN_ENVELOPE_WINDOW_SECONDS 0.02
#define MAX_ENVELOPE_WINDOW_SECONDS 0.1

/* Copies the window of n frames centred on frame centre of samples (count
   frames) into analyzer->window; what falls outside is silence */
static void sw_analyzer_fill_window(
    synthway_analyzer_t* analyzer,
    const float* samples,
    uint64_t count,
    int64_t centre,
    uint32_t n
) {
    const int64_t start = centre - (int64_t)(n / 2);
    for (uint32_t i = 0; i < n; ++i) {
        const int64_t frame = start + (int64_t)i;
        analyzer->window[i] = frame >= 0 && (uint64_t)frame < count ? samples[frame] : 0.0f;
    }
}

/* Fills the analysis window (n frames) with a mono mix of the interleaved clip. */
static void sw_analyzer_fill_clip_window(
    synthway_analyzer_t* analyzer,
    const sw_audio_clip* clip,
    int64_t centre,
    uint32_t n
) {
    const int64_t start = centre - (int64_t)(n / 2);
    for (uint32_t i = 0; i < n; ++i) {
        const int64_t frame = start + (int64_t)i;
        if (frame < 0 || (uint64_t)frame >= clip->frame_count) {
            analyzer->window[i] = 0.0f;
        } else if (clip->channels > 1) {
            const float* samples = clip->samples + (uint64_t)frame * clip->channels;
            analyzer->window[i] = (samples[0] + samples[1]) * 0.5f;
        } else {
            analyzer->window[i] = clip->samples[frame];
        }
    }
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
    free(analyzer->recording.samples);
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
    const uint32_t n = sw_analysis_window_frames(sample_rate);
    sw_analyzer_fill_window(analyzer, samples, frame_count, (int64_t)(frame_count / 2), n);
    sw_analysis_run(analyzer->window, n, sample_rate, analyzer->noise_gate_db, &analyzer->workspace, out_analysis);
    return SYNTHWAY_OK;
}

/* --------------------------------------------------------------------------
   Recording
   -------------------------------------------------------------------------- */
/* Makes room for count more frames; false when memory runs out */
static bool sw_analyzer_recording_reserve(sw_analyzer_recording* recording, uint64_t count, uint32_t sample_rate) {
    if (recording->capacity - recording->frame_count >= count) {
        return true;
    }
    uint64_t capacity = recording->capacity > 0 ? recording->capacity : (uint64_t)sample_rate * 10;
    while (capacity - recording->frame_count < count) {
        capacity *= 2;
    }
    float* grown = (float*)realloc(recording->samples, sizeof(float) * capacity);
    if (!grown) {
        return false;
    }
    recording->samples = grown;
    recording->capacity = capacity;
    return true;
}

/* Moves the samples captured since the last call from the microphone's ring
   into the recording */
static void sw_analyzer_take_recorded(synthway_analyzer_t* analyzer) {
    sw_analyzer_recording* recording = &analyzer->recording;
    if (!recording->active) {
        return;
    }
    const uint64_t written = sw_audio_input_written(&analyzer->input);
    uint64_t available = written - recording->position;
    uint64_t lost = 0;
    if (available > SW_AUDIO_INPUT_RING_FRAMES - RECORDING_MARGIN_FRAMES) {
        /* Overwritten, or about to be: silence keeps the timing of what follows */
        lost = available - (SW_AUDIO_INPUT_RING_FRAMES - RECORDING_MARGIN_FRAMES);
        available -= lost;
    }
    if (sw_analyzer_recording_reserve(recording, lost + available, analyzer->input.sample_rate)) {
        memset(recording->samples + recording->frame_count, 0, sizeof(float) * lost);
        sw_audio_input_read(&analyzer->input, recording->position + lost,
                            recording->samples + recording->frame_count + lost, (uint32_t)available);
        recording->frame_count += lost + available;
        recording->lost_frames += lost;
    } /* else out of memory: these samples are dropped */
    recording->position = written;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_start_recording(synthway_analyzer_t* analyzer) {
    if (!analyzer) {
        return SYNTHWAY_INVALID_PARAM;
    }
    if (!sw_audio_input_is_open(&analyzer->input)) {
        return SYNTHWAY_NOT_RUNNING;
    }
    sw_analyzer_recording* recording = &analyzer->recording;
    free(recording->samples);
    memset(recording, 0, sizeof(*recording));
    recording->position = sw_audio_input_written(&analyzer->input);
    recording->active = true;
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_stop_recording(synthway_analyzer_t* analyzer) {
    if (!analyzer) {
        return SYNTHWAY_INVALID_PARAM;
    }
    sw_analyzer_recording* recording = &analyzer->recording;
    if (!recording->active) {
        return SYNTHWAY_NOT_RUNNING;
    }
    sw_analyzer_take_recorded(analyzer);
    recording->active = false;
    if (recording->frame_count == 0) {
        free(recording->samples);
        recording->samples = NULL;
        recording->capacity = 0;
        return SYNTHWAY_NOT_RUNNING;
    }

    /* The clip takes the samples over, trimmed to their length */
    sw_audio_clip_free(&analyzer->clip);
    float* trimmed = (float*)realloc(recording->samples, sizeof(float) * recording->frame_count);
    analyzer->clip.samples = trimmed ? trimmed : recording->samples;
    analyzer->clip.frame_count = recording->frame_count;
    analyzer->clip.sample_rate = analyzer->input.sample_rate;
    analyzer->clip.channels = 1;
    recording->samples = NULL;
    recording->capacity = 0;
    return SYNTHWAY_OK;
}

SYNTHWAY_API bool synthway_analyzer_is_recording(const synthway_analyzer_t* analyzer) {
    return analyzer ? analyzer->recording.active : false;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_get_recording_info(
    synthway_analyzer_t* analyzer,
    uint64_t* out_frame_count,
    uint64_t* out_lost_frames
) {
    if (!analyzer || !out_frame_count || !out_lost_frames) {
        return SYNTHWAY_INVALID_PARAM;
    }
    sw_analyzer_take_recorded(analyzer);
    *out_frame_count = analyzer->recording.frame_count;
    *out_lost_frames = analyzer->recording.lost_frames;
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
    synthway_analyzer_close_input(analyzer);

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

SYNTHWAY_API synthway_result_t synthway_analyzer_open_virtual_input(
    synthway_analyzer_t* analyzer,
    uint32_t sample_rate
) {
    if (!analyzer || sample_rate < MIN_SAMPLE_RATE || sample_rate > MAX_SAMPLE_RATE) {
        return SYNTHWAY_INVALID_PARAM;
    }
    synthway_analyzer_close_input(analyzer);
    sw_audio_input_open_virtual(&analyzer->input, sample_rate);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_write_input(
    synthway_analyzer_t* analyzer,
    const float* samples,
    uint32_t frame_count
) {
    if (!analyzer || !samples || !analyzer->input.is_virtual) {
        return SYNTHWAY_INVALID_PARAM;
    }
    sw_audio_input_write(&analyzer->input, samples, frame_count);
    return SYNTHWAY_OK;
}

SYNTHWAY_API void synthway_analyzer_close_input(synthway_analyzer_t* analyzer) {
    if (analyzer) {
        synthway_analyzer_stop_recording(analyzer);
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
    sw_analyzer_take_recorded(analyzer);
    const uint32_t sample_rate = analyzer->input.sample_rate;
    const uint32_t n = sw_analysis_window_frames(sample_rate);
    sw_audio_input_read_latest(&analyzer->input, analyzer->window, n);
    sw_analysis_run(analyzer->window, n, sample_rate, analyzer->noise_gate_db, &analyzer->workspace, out_analysis);
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
    const uint32_t n = sw_analysis_window_frames(clip->sample_rate);
    sw_analyzer_fill_clip_window(analyzer, clip, (int64_t)(time_s * clip->sample_rate), n);
    sw_analysis_run(analyzer->window, n, clip->sample_rate, analyzer->noise_gate_db, &analyzer->workspace, out_analysis);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_analyze_clip_range(
    synthway_analyzer_t* analyzer,
    double start_s,
    double end_s,
    double window_s,
    float reference_hz,
    float harmonic_cents,
    synthway_analysis_t* out_analysis
) {
    /* Written this way round, NaNs are refused too */
    if (!analyzer || !out_analysis || !analyzer->clip.samples || !(end_s > start_s)
        || !(window_s == SYNTHWAY_ANALYZER_WINDOW_AUTO
             || (window_s >= SYNTHWAY_ANALYZER_MIN_WINDOW_S && window_s <= SYNTHWAY_ANALYZER_MAX_WINDOW_S))
        || !(reference_hz == SYNTHWAY_ANALYZER_REFERENCE_AUTO
             || (reference_hz >= SYNTHWAY_ANALYZER_MIN_REFERENCE_HZ && reference_hz <= SYNTHWAY_ANALYZER_MAX_REFERENCE_HZ))
        || !(harmonic_cents == SYNTHWAY_ANALYZER_ALL_PARTIALS
             || (harmonic_cents > 0.0f && harmonic_cents <= SYNTHWAY_ANALYZER_MAX_HARMONIC_CENTS))) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_audio_clip* clip = &analyzer->clip;
    const uint32_t rate = clip->sample_rate;
    const uint32_t n = window_s == SYNTHWAY_ANALYZER_WINDOW_AUTO ? sw_analysis_window_frames(rate)
                                                                 : sw_analysis_frames_for(window_s, rate);

    /* Centres of the first and last windows that stay inside the zone */
    const double first_centre = start_s * rate + n / 2.0;
    const double last_centre = end_s * rate - n / 2.0;
    if (last_centre <= first_centre + 1.0) {
        /* The zone fits in one window: the window around its middle (the cursor's moment) */
        sw_analyzer_fill_clip_window(analyzer, clip, (int64_t)((start_s + end_s) / 2.0 * rate), n);
        sw_analysis_run(analyzer->window, n, rate, analyzer->noise_gate_db, &analyzer->workspace, out_analysis);
        sw_analysis_relate(out_analysis, reference_hz, harmonic_cents);
        return SYNTHWAY_OK;
    }

    /* Moments evenly spread from the first window to the last, at least
       MIN_ZONE_STEP_SECONDS apart, at most MAX_ZONE_MOMENTS of them */
    double gaps = floor((last_centre - first_centre) / (MIN_ZONE_STEP_SECONDS * rate));
    if (gaps < 1.0) gaps = 1.0;
    if (gaps > MAX_ZONE_MOMENTS - 1) gaps = MAX_ZONE_MOMENTS - 1;
    const uint32_t count = (uint32_t)gaps + 1;
    synthway_analysis_t* moments = (synthway_analysis_t*)malloc(sizeof(synthway_analysis_t) * count);
    sw_analysis_peak* peaks = (sw_analysis_peak*)malloc(sizeof(sw_analysis_peak) * count * SYNTHWAY_ANALYSIS_MAX_PARTIALS);
    float* values = (float*)malloc(sizeof(float) * count * SYNTHWAY_ANALYSIS_MAX_PARTIALS);
    float* references = (float*)malloc(sizeof(float) * count);
    uint32_t* marks = (uint32_t*)malloc(sizeof(uint32_t) * count);
    synthway_result_t result = SYNTHWAY_ERROR;
    if (moments && peaks && values && references && marks) {
        for (uint32_t i = 0; i < count; ++i) {
            const double centre = first_centre + (last_centre - first_centre) * i / (count - 1);
            sw_analyzer_fill_clip_window(analyzer, clip, (int64_t)centre, n);
            sw_analysis_run(analyzer->window, n, rate, analyzer->noise_gate_db, &analyzer->workspace, &moments[i]);
        }
        sw_analysis_combine(moments, count, reference_hz, harmonic_cents, peaks, values, references, marks, out_analysis);
        result = SYNTHWAY_OK;
    }
    free(moments);
    free(peaks);
    free(values);
    free(references);
    free(marks);
    return result;
}

/* The moments of synthway_analyzer_analyze_clip_range in a zone, for windows
   of n frames: one around its middle when it fits in a window, else evenly
   spread. Returns their count; out_first_centre gets the first one's centre
   (in frames), out_step the frames between two. */
static uint32_t sw_analyzer_zone_moments(
    double start_s,
    double end_s,
    uint32_t n,
    uint32_t rate,
    double* out_first_centre,
    double* out_step
) {
    const double first_centre = start_s * rate + n / 2.0;
    const double last_centre = end_s * rate - n / 2.0;
    if (last_centre <= first_centre + 1.0) {
        *out_first_centre = (start_s + end_s) / 2.0 * rate;
        *out_step = 0.0;
        return 1;
    }
    double gaps = floor((last_centre - first_centre) / (MIN_ZONE_STEP_SECONDS * rate));
    if (gaps < 1.0) gaps = 1.0;
    if (gaps > MAX_ZONE_MOMENTS - 1) gaps = MAX_ZONE_MOMENTS - 1;
    *out_first_centre = first_centre;
    *out_step = (last_centre - first_centre) / gaps;
    return (uint32_t)gaps + 1;
}

/* Notes looked for, from a low B0 to C8 */
#define NOTES_MIN_HZ 30.0f
#define NOTES_MAX_HZ 4200.0f
/* A note missing at up to this many moments in a row goes on; one heard for
   less than NOTES_MIN_SECONDS is dropped (unless the zone is shorter) */
#define NOTES_MAX_GAP_MOMENTS 3
#define NOTES_MIN_SECONDS 0.06

/* A note followed from moment to moment */
typedef struct sw_note_track {
    float midi;                /* of its first moment */
    double log2_sum;           /* of its frequencies, for their geometric mean */
    double salience_sum;
    uint32_t moments;
    uint32_t first, last;      /* moment indices */
} sw_note_track;

static int sw_compare_spans(const void* a, const void* b) {
    const synthway_note_span_t* x = (const synthway_note_span_t*)a;
    const synthway_note_span_t* y = (const synthway_note_span_t*)b;
    if (x->start_s != y->start_s) return x->start_s < y->start_s ? -1 : 1;
    return (x->frequency_hz > y->frequency_hz) - (x->frequency_hz < y->frequency_hz);
}

SYNTHWAY_API synthway_result_t synthway_analyzer_find_notes(
    synthway_analyzer_t* analyzer,
    double start_s,
    double end_s,
    double window_s,
    synthway_note_span_t* out_notes,
    uint32_t capacity,
    uint32_t* out_count
) {
    if (!analyzer || !out_notes || !out_count || !analyzer->clip.samples || !(end_s > start_s)
        || !(window_s == SYNTHWAY_ANALYZER_WINDOW_AUTO
             || (window_s >= SYNTHWAY_ANALYZER_MIN_WINDOW_S && window_s <= SYNTHWAY_ANALYZER_MAX_WINDOW_S))) {
        return SYNTHWAY_INVALID_PARAM;
    }
    *out_count = 0;
    const sw_audio_clip* clip = &analyzer->clip;
    const uint32_t rate = clip->sample_rate;
    const uint32_t n = window_s == SYNTHWAY_ANALYZER_WINDOW_AUTO ? sw_analysis_window_frames(rate)
                                                                 : sw_analysis_frames_for(window_s, rate);
    double first_centre, step;
    const uint32_t count = sw_analyzer_zone_moments(start_s, end_s, n, rate, &first_centre, &step);

    sw_note* notes = (sw_note*)malloc(sizeof(sw_note) * count * SYNTHWAY_ANALYZER_MAX_NOTES_AT_ONCE);
    uint32_t* found = (uint32_t*)malloc(sizeof(uint32_t) * count);
    sw_note_track* tracks = (sw_note_track*)malloc(sizeof(sw_note_track) * count * SYNTHWAY_ANALYZER_MAX_NOTES_AT_ONCE);
    synthway_note_span_t* spans = (synthway_note_span_t*)malloc(sizeof(synthway_note_span_t) * count * SYNTHWAY_ANALYZER_MAX_NOTES_AT_ONCE);
    if (!notes || !found || !tracks || !spans) {
        free(notes);
        free(found);
        free(tracks);
        free(spans);
        return SYNTHWAY_ERROR;
    }

    synthway_analysis_t moment;
    uint32_t track_count = 0;
    for (uint32_t i = 0; i < count; ++i) {
        sw_analyzer_fill_clip_window(analyzer, clip, (int64_t)(first_centre + step * i), n);
        sw_analysis_run(analyzer->window, n, rate, analyzer->noise_gate_db, &analyzer->workspace, &moment);
        sw_note* at = notes + (size_t)i * SYNTHWAY_ANALYZER_MAX_NOTES_AT_ONCE;
        found[i] = sw_notes_find(&moment, NOTES_MIN_HZ, NOTES_MAX_HZ, at, SYNTHWAY_ANALYZER_MAX_NOTES_AT_ONCE);
        /* Each note continues a track on its semitone heard a few moments ago, or starts one */
        for (uint32_t k = 0; k < found[i]; ++k) {
            const float midi = 69.0f + 12.0f * log2f(at[k].frequency_hz / 440.0f);
            sw_note_track* track = NULL;
            for (uint32_t t = 0; t < track_count && !track; ++t) {
                if (fabsf(tracks[t].midi - midi) < 0.5f && tracks[t].last < i && tracks[t].last + NOTES_MAX_GAP_MOMENTS + 1 >= i) {
                    track = &tracks[t];
                }
            }
            if (!track) {
                track = &tracks[track_count++];
                memset(track, 0, sizeof(*track));
                track->midi = midi;
                track->first = i;
            }
            track->log2_sum += log2((double)at[k].frequency_hz);
            track->salience_sum += at[k].salience;
            track->moments++;
            track->last = i;
        }
    }

    /* Tracks heard long enough become spans; strengths relative to the strongest */
    uint32_t min_moments = step > 0.0 ? (uint32_t)ceil(NOTES_MIN_SECONDS * rate / step) : 1;
    if (min_moments > count) min_moments = count;
    double strongest = 0.0;
    for (uint32_t t = 0; t < track_count; ++t) {
        if (tracks[t].moments >= min_moments && tracks[t].salience_sum / tracks[t].moments > strongest) {
            strongest = tracks[t].salience_sum / tracks[t].moments;
        }
    }
    uint32_t span_count = 0;
    for (uint32_t t = 0; t < track_count; ++t) {
        const sw_note_track* track = &tracks[t];
        if (track->moments < min_moments) continue;
        synthway_note_span_t* span = &spans[span_count++];
        /* From halfway between moments; the first and last moments reach the zone's ends */
        span->start_s = track->first == 0 ? start_s : (first_centre + step * (track->first - 0.5)) / rate;
        span->end_s = track->last == count - 1 ? end_s : (first_centre + step * (track->last + 0.5)) / rate;
        span->frequency_hz = (float)exp2(track->log2_sum / track->moments);
        span->strength = strongest > 0.0 ? (float)(track->salience_sum / track->moments / strongest) : 0.0f;
    }
    qsort(spans, span_count, sizeof(synthway_note_span_t), sw_compare_spans);
    *out_count = span_count < capacity ? span_count : capacity;
    memcpy(out_notes, spans, sizeof(synthway_note_span_t) * *out_count);

    free(notes);
    free(found);
    free(tracks);
    free(spans);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_measure_envelopes(
    synthway_analyzer_t* analyzer,
    double start_s,
    double end_s,
    double window_s,
    float reference_hz,
    float harmonic_cents,
    synthway_analysis_t* out_analysis,
    synthway_envelope_t* out_envelopes
) {
    if (!out_envelopes) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const synthway_result_t found = synthway_analyzer_analyze_clip_range(
        analyzer, start_s, end_s, window_s, reference_hz, harmonic_cents, out_analysis
    );
    const uint32_t count = found == SYNTHWAY_OK ? out_analysis->partial_count : 0;
    if (count == 0) {
        return found;
    }

    /* A window of a few periods of the note (else of the lowest partial), with
       its Hann weights in the workspace's spare buffer */
    const sw_audio_clip* clip = &analyzer->clip;
    const double rate = clip->sample_rate;
    const double base = out_analysis->frequency_hz > 0.0f ? out_analysis->frequency_hz : out_analysis->partials[0].frequency_hz;
    double seconds = ENVELOPE_PERIODS / base;
    if (seconds < MIN_ENVELOPE_WINDOW_SECONDS) seconds = MIN_ENVELOPE_WINDOW_SECONDS;
    if (seconds > MAX_ENVELOPE_WINDOW_SECONDS) seconds = MAX_ENVELOPE_WINDOW_SECONDS;
    const uint32_t n = sw_analysis_frames_for(seconds, clip->sample_rate);
    float* weights = analyzer->workspace.re;
    double weights_sum = 0.0;
    for (uint32_t i = 0; i < n; ++i) {
        weights[i] = (float)(0.5 - 0.5 * cos(6.283185307179586 * i / (n - 1)));
        weights_sum += weights[i];
    }

    /* Only windows wholly inside the file: one that runs past its end would
       read a fall that is not in the sound */
    const double half = 0.5 * n / rate, duration = clip->frame_count / rate;
    const double first = start_s > half ? start_s : half;
    const double last = end_s < duration - half ? end_s : duration - half;
    if (!(last > first)) {
        /* Too short to follow anything: every partial held */
        for (uint32_t k = 0; k < count; ++k) {
            float peak;
            sw_analysis_fit_envelope(NULL, 0, 0.0, 0.0, &out_envelopes[k], &peak);
        }
        return SYNTHWAY_OK;
    }
    double step = ENVELOPE_STEP_SECONDS;
    if ((last - first) / step > MAX_ENVELOPE_STEPS - 1) step = (last - first) / (MAX_ENVELOPE_STEPS - 1);
    const uint32_t steps = (uint32_t)((last - first) / step) + 1;
    float* levels = (float*)malloc(sizeof(float) * count * steps);
    if (!levels) {
        return SYNTHWAY_ERROR;
    }
    for (uint32_t s = 0; s < steps; ++s) {
        sw_analyzer_fill_clip_window(analyzer, clip, (int64_t)((first + s * step) * rate), n);
        for (uint32_t k = 0; k < count; ++k) {
            const float amplitude = sw_analysis_tone_amplitude(
                analyzer->window, weights, n, weights_sum, out_analysis->partials[k].frequency_hz, rate
            );
            levels[k * steps + s] = amplitude > 1e-6f ? (float)(20.0 * log10(amplitude)) : -120.0f;
        }
    }

    /* Each partial's envelope; its amplitude becomes its peak, relative to the strongest */
    float strongest = -120.0f;
    for (uint32_t k = 0; k < count; ++k) {
        float peak;
        sw_analysis_fit_envelope(levels + k * steps, steps, step, (double)n / rate, &out_envelopes[k], &peak);
        out_analysis->partials[k].amplitude = peak; /* in dB until the strongest is known */
        if (peak > strongest) strongest = peak;
    }
    for (uint32_t k = 0; k < count; ++k) {
        out_analysis->partials[k].amplitude = powf(10.0f, (out_analysis->partials[k].amplitude - strongest) / 20.0f);
    }
    free(levels);
    return SYNTHWAY_OK;
}

/* Waveform fit: the note is the zone's, its partials kept within
   FIT_HARMONIC_CENTS of a whole ratio; a note found at a moment within
   FIT_SAME_NOTE_CENTS of it (or of one of its harmonics) is that note; a harmonic is heard when its median
   stands FIT_HEARD_DB above its background; one shared with another note at
   more than two thirds of the moments is left out */
#define FIT_HARMONIC_CENTS 30.0f
#define FIT_SAME_NOTE_CENTS 50.0
#define FIT_HEARD_DB 6.0f
#define FIT_MIN_CLEAR_SHARE (1.0 / 3.0)

static int sw_compare_floats(const void* a, const void* b) {
    const float x = *(const float*)a, y = *(const float*)b;
    return (x > y) - (x < y);
}

/* Median of n values (they get sorted) */
static float sw_median_of(float* values, uint32_t n) {
    qsort(values, n, sizeof(float), sw_compare_floats);
    return n % 2 ? values[n / 2] : 0.5f * (values[n / 2 - 1] + values[n / 2]);
}

SYNTHWAY_API synthway_result_t synthway_analyzer_fit_waveform(
    synthway_analyzer_t* analyzer,
    double start_s,
    double end_s,
    double window_s,
    float reference_hz,
    synthway_waveform_fit_t* out_fit
) {
    if (!out_fit) {
        return SYNTHWAY_INVALID_PARAM;
    }
    memset(out_fit, 0, sizeof(*out_fit));

    /* The note: the zone's, as its analysis finds it (or the reference given) */
    synthway_analysis_t* zone = (synthway_analysis_t*)malloc(sizeof(synthway_analysis_t));
    if (!zone) {
        return SYNTHWAY_ERROR;
    }
    const synthway_result_t found = synthway_analyzer_analyze_clip_range(
        analyzer, start_s, end_s, window_s, reference_hz, FIT_HARMONIC_CENTS, zone
    );
    const float note = found == SYNTHWAY_OK ? zone->frequency_hz : 0.0f;
    free(zone);
    if (found != SYNTHWAY_OK) {
        return found;
    }
    const sw_audio_clip* clip = &analyzer->clip;
    const uint32_t rate = clip->sample_rate;
    const uint32_t harmonics = sw_waveform_harmonic_count(note, (float)rate);
    if (!(note > 0.0f) || harmonics == 0) {
        return SYNTHWAY_OK;
    }
    out_fit->frequency_hz = note;

    const uint32_t n = window_s == SYNTHWAY_ANALYZER_WINDOW_AUTO ? sw_analysis_window_frames(rate)
                                                                 : sw_analysis_frames_for(window_s, rate);
    const uint32_t fft_size = sw_analysis_fft_size(n);
    double first_centre, step;
    const uint32_t count = sw_analyzer_zone_moments(start_s, end_s, n, rate, &first_centre, &step);
    float* levels = (float*)malloc(sizeof(float) * count * harmonics);
    float* backgrounds = (float*)malloc(sizeof(float) * count * harmonics);
    uint8_t* shared = (uint8_t*)malloc(count * harmonics);
    float* values = (float*)malloc(sizeof(float) * count);
    if (!levels || !backgrounds || !shared || !values) {
        free(levels);
        free(backgrounds);
        free(shared);
        free(values);
        return SYNTHWAY_ERROR;
    }

    /* At each moment where the note is heard: its harmonics, relative to the
       strongest one clear of other notes (the level of a note pumped by a
       kick then counts out) */
    synthway_analysis_t moment;
    sw_note notes[SYNTHWAY_ANALYZER_MAX_NOTES_AT_ONCE];
    float others[SYNTHWAY_ANALYZER_MAX_NOTES_AT_ONCE], strengths[SYNTHWAY_ANALYZER_MAX_NOTES_AT_ONCE];
    uint32_t used = 0;
    for (uint32_t i = 0; i < count; ++i) {
        sw_analyzer_fill_clip_window(analyzer, clip, (int64_t)(first_centre + step * i), n);
        sw_analysis_run(analyzer->window, n, rate, analyzer->noise_gate_db, &analyzer->workspace, &moment);
        const uint32_t found_notes = sw_notes_find(&moment, NOTES_MIN_HZ, NOTES_MAX_HZ, notes, SYNTHWAY_ANALYZER_MAX_NOTES_AT_ONCE);
        int heard = -1;
        double closest = FIT_SAME_NOTE_CENTS;
        for (uint32_t k = 0; k < found_notes; ++k) {
            const double cents = fabs(1200.0 * log2((double)notes[k].frequency_hz / note));
            if (cents < closest) {
                closest = cents;
                heard = (int)k;
            }
        }
        if (heard < 0 || !(notes[heard].salience > 0.0f)) {
            continue;
        }
        const float heard_hz = notes[heard].frequency_hz;
        /* The other notes, with their strength next to the note's; a weaker one
           on a harmonic of the note (the strong 3rd of a square reads as a note
           of its own) cannot be told from it: it is the note */
        uint32_t other_count = 0;
        for (uint32_t k = 0; k < found_notes; ++k) {
            if ((int)k == heard) continue;
            const float strength = notes[k].salience / notes[heard].salience;
            const double multiple = floor((double)notes[k].frequency_hz / heard_hz + 0.5);
            const bool harmonic = multiple >= 2.0 && strength < 1.0f
                                  && fabs(1200.0 * log2((double)notes[k].frequency_hz / (multiple * heard_hz))) < FIT_SAME_NOTE_CENTS;
            if (harmonic) continue;
            others[other_count] = notes[k].frequency_hz;
            strengths[other_count] = strength;
            other_count++;
        }
        float* level = levels + (size_t)used * harmonics;
        float* background = backgrounds + (size_t)used * harmonics;
        uint8_t* mark = shared + (size_t)used * harmonics;
        sw_waveform_measure(analyzer->workspace.mag_db, n, fft_size, (float)rate, heard_hz, others, strengths,
                            other_count, harmonics, level, background, mark);
        float top = SW_SPECTRUM_FLOOR_DB;
        int clear = 0;
        for (uint32_t k = 0; k < harmonics; ++k) {
            if (!mark[k] && level[k] > top) top = level[k];
            clear |= !mark[k];
        }
        if (!clear) {
            continue;
        }
        for (uint32_t k = 0; k < harmonics; ++k) {
            level[k] -= top;
            background[k] -= top;
        }
        used++;
    }
    out_fit->moment_count = used;

    if (used > 0) {
        /* Each harmonic: the medians of the moments where it is clear of other notes */
        float strongest = SW_SPECTRUM_FLOOR_DB;
        for (uint32_t k = 0; k < harmonics; ++k) {
            uint32_t clear = 0;
            for (uint32_t m = 0; m < used; ++m) {
                if (!shared[(size_t)m * harmonics + k]) values[clear++] = levels[(size_t)m * harmonics + k];
            }
            const bool kept = clear > 0 && clear >= FIT_MIN_CLEAR_SHARE * used;
            const uint32_t taken = kept ? clear : used;
            if (!kept) {
                for (uint32_t m = 0; m < used; ++m) values[m] = levels[(size_t)m * harmonics + k];
            }
            out_fit->harmonic_db[k] = sw_median_of(values, taken);
            uint32_t b = 0;
            for (uint32_t m = 0; m < used; ++m) {
                if (!kept || !shared[(size_t)m * harmonics + k]) values[b++] = backgrounds[(size_t)m * harmonics + k];
            }
            out_fit->background_db[k] = sw_median_of(values, b);
            out_fit->harmonic_state[k] = !kept ? SYNTHWAY_HARMONIC_SHARED
                                         : out_fit->harmonic_db[k] >= out_fit->background_db[k] + FIT_HEARD_DB ? SYNTHWAY_HARMONIC_HEARD
                                                                                                               : SYNTHWAY_HARMONIC_FAINT;
            if (out_fit->harmonic_state[k] == SYNTHWAY_HARMONIC_HEARD && out_fit->harmonic_db[k] > strongest) {
                strongest = out_fit->harmonic_db[k];
            }
        }
        /* The strongest heard harmonic reads 0 dB */
        if (strongest > SW_SPECTRUM_FLOOR_DB) {
            for (uint32_t k = 0; k < harmonics; ++k) {
                out_fit->harmonic_db[k] -= strongest;
                out_fit->background_db[k] -= strongest;
            }
        }
        out_fit->harmonic_count = harmonics;
        sw_waveform_fit((float)rate, out_fit);
    }

    free(levels);
    free(backgrounds);
    free(shared);
    free(values);
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
            const float mixed = clip->channels > 1
                ? (clip->samples[f * clip->channels] + clip->samples[f * clip->channels + 1]) * 0.5f
                : clip->samples[f];
            const float v = mixed < 0.0f ? -mixed : mixed;
            if (v > peak) peak = v;
        }
        out_peaks[i] = peak;
    }
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_get_clip_stereo_overview(
    const synthway_analyzer_t* analyzer,
    float* out_left_peaks,
    float* out_right_peaks,
    uint32_t count
) {
    if (!analyzer || !out_left_peaks || !out_right_peaks || count == 0 || !analyzer->clip.samples) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_audio_clip* clip = &analyzer->clip;
    for (uint32_t i = 0; i < count; ++i) {
        const uint64_t first = clip->frame_count * i / count;
        uint64_t end = clip->frame_count * (i + 1) / count;
        if (end == first && first < clip->frame_count) end = first + 1;
        float left_peak = 0.0f;
        float right_peak = 0.0f;
        for (uint64_t frame = first; frame < end; ++frame) {
            const float left = clip->samples[frame * clip->channels];
            const float right = clip->channels > 1 ? clip->samples[frame * clip->channels + 1] : left;
            const float left_abs = left < 0.0f ? -left : left;
            const float right_abs = right < 0.0f ? -right : right;
            if (left_abs > left_peak) left_peak = left_abs;
            if (right_abs > right_peak) right_peak = right_abs;
        }
        out_left_peaks[i] = left_peak;
        out_right_peaks[i] = right_peak;
    }
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_get_clip_waveform(
    const synthway_analyzer_t* analyzer,
    uint64_t first_frame,
    uint64_t frame_count,
    uint32_t count,
    float* out_left_low,
    float* out_left_high,
    float* out_right_low,
    float* out_right_high
) {
    if (!analyzer || !out_left_low || !out_left_high || !out_right_low || !out_right_high
        || count == 0 || frame_count == 0 || !analyzer->clip.samples
        || first_frame >= analyzer->clip.frame_count) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_audio_clip* clip = &analyzer->clip;
    if (frame_count > clip->frame_count - first_frame) {
        frame_count = clip->frame_count - first_frame;
    }
    for (uint32_t i = 0; i < count; ++i) {
        const uint64_t first = first_frame + frame_count * i / count;
        uint64_t end = first_frame + frame_count * (i + 1) / count;
        if (end == first) end = first + 1; /* more parts than samples */
        const float* samples = clip->samples + first * clip->channels;
        float left_low = samples[0];
        float right_low = clip->channels > 1 ? samples[1] : samples[0];
        float left_high = left_low;
        float right_high = right_low;
        for (uint64_t frame = first + 1; frame < end; ++frame) {
            samples = clip->samples + frame * clip->channels;
            const float left = samples[0];
            const float right = clip->channels > 1 ? samples[1] : left;
            if (left < left_low) left_low = left;
            if (left > left_high) left_high = left;
            if (right < right_low) right_low = right;
            if (right > right_high) right_high = right;
        }
        out_left_low[i] = left_low;
        out_left_high[i] = left_high;
        out_right_low[i] = right_low;
        out_right_high[i] = right_high;
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
    const uint32_t n = sw_analysis_window_frames(clip->sample_rate);
    for (uint32_t i = 0; i < count; ++i) {
        const int64_t centre = (int64_t)((clip->frame_count * (2 * (uint64_t)i + 1)) / (2 * (uint64_t)count));
        sw_analyzer_fill_clip_window(analyzer, clip, centre, n);
        float frequency, clarity, level;
        sw_analysis_run_pitch(analyzer->window, n, clip->sample_rate, &analyzer->workspace, &frequency, &clarity, &level);
        if (out_frequency_hz) out_frequency_hz[i] = frequency;
        if (out_clarity) out_clarity[i] = clarity;
        if (out_level_db) out_level_db[i] = level;
    }
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_analyzer_save_clip_wav(
    const synthway_analyzer_t* analyzer,
    const char* path
) {
    enum { BLOCK_FRAMES = 4096 };

    if (!analyzer || !path || !analyzer->clip.samples) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_audio_clip* clip = &analyzer->clip;
    sw_wav_file file;
    synthway_result_t result = sw_wav_file_open(&file, path, 1, clip->sample_rate, BLOCK_FRAMES);
    if (result != SYNTHWAY_OK) {
        return result;
    }
    float mono[BLOCK_FRAMES];
    for (uint64_t done = 0; result == SYNTHWAY_OK && done < clip->frame_count;) {
        const uint64_t left = clip->frame_count - done;
        const uint32_t frames = left < BLOCK_FRAMES ? (uint32_t)left : BLOCK_FRAMES;
        for (uint32_t i = 0; i < frames; ++i) {
            const uint64_t frame = done + i;
            mono[i] = clip->channels > 1
                ? (clip->samples[frame * clip->channels] + clip->samples[frame * clip->channels + 1]) * 0.5f
                : clip->samples[frame];
        }
        result = sw_wav_file_write(&file, mono, frames);
        done += frames;
    }
    sw_wav_file_close(&file);
    return result;
}
