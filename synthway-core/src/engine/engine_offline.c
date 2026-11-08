#include "engine/engine_internal.h"
#include "io/wav_file.h"
#include <stdlib.h>

SYNTHWAY_API synthway_result_t synthway_engine_init_offline(
    synthway_engine_t* engine,
    const synthway_engine_config_t* config
) {
    if (!engine || sw_audio_output_is_open(&engine->output) || engine->offline) {
        return SYNTHWAY_INVALID_PARAM;
    }

    if (config) {
        if (config->sample_rate > 0) {
            engine->sample_rate = config->sample_rate;
        }
        if (config->channels > 0) {
            engine->channels = config->channels;
        }
    }

    engine->offline = true;
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_render(
    synthway_engine_t* engine,
    float* out_samples,
    uint32_t frame_count
) {
    /* Offline engines only: no audio thread can touch the state meanwhile */
    if (!engine || !out_samples || !engine->offline) {
        return SYNTHWAY_INVALID_PARAM;
    }

    sw_engine_render(engine, out_samples, frame_count);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_render_to_wav(
    synthway_engine_t* engine,
    const char* path,
    uint32_t frame_count
) {
    enum { BLOCK_FRAMES = 1024 };

    if (!engine || !path || !engine->offline) {
        return SYNTHWAY_INVALID_PARAM;
    }

    float* samples = (float*)malloc(sizeof(float) * BLOCK_FRAMES * engine->channels);
    if (!samples) {
        return SYNTHWAY_ERROR;
    }

    sw_wav_file wav;
    synthway_result_t result = sw_wav_file_open(&wav, path, engine->channels, engine->sample_rate, BLOCK_FRAMES);
    if (result != SYNTHWAY_OK) {
        free(samples);
        return result;
    }

    for (uint32_t done = 0; done < frame_count; ) {
        uint32_t frames = frame_count - done < BLOCK_FRAMES ? frame_count - done : BLOCK_FRAMES;
        sw_engine_render(engine, samples, frames);
        result = sw_wav_file_write(&wav, samples, frames);
        if (result != SYNTHWAY_OK) {
            break;
        }
        done += frames;
    }

    sw_wav_file_close(&wav);
    free(samples);
    return result;
}
