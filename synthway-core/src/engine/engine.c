#include "engine/engine_internal.h"
#include <stdlib.h>

/* Shared by the real-time device callback and offline rendering, so both
   produce the same samples.

   THREADING NOTE (for future contributors):
   The shared parameters are read once per call (sw_engine_params_snapshot),
   into the plain values the synth renders the whole block with.  Reading them
   once per callback invocation (typically every 256–1024 frames ≈ 5–21 ms at
   48 kHz) keeps the hot loop free of atomic operations while still picking up
   parameter changes fast enough to be perceptually instant.  The per-sample
   smoothing in the synth hides any inter-field timing mismatch. */
void sw_engine_render(synthway_engine_t* engine, float* out, uint32_t frame_count) {
    sw_synth_params params;
    sw_engine_params_snapshot(&engine->params, &params);
    sw_synth_render(&engine->synth, &params, engine->sample_rate, engine->channels, out, frame_count);
}

/* Render function given to the sound card, called by its real-time audio thread */
static void sw_engine_render_callback(void* user_data, float* out, uint32_t frame_count) {
    sw_engine_render((synthway_engine_t*)user_data, out, frame_count);
}

SYNTHWAY_API synthway_engine_t* synthway_engine_create(void) {
    synthway_engine_t* engine = (synthway_engine_t*)calloc(1, sizeof(synthway_engine_t));
    if (!engine) {
        return NULL;
    }

    sw_engine_params_init(&engine->params);
    sw_synth_init(&engine->synth, SW_DEFAULT_FREQUENCY, SW_DEFAULT_VOLUME);
    engine->sample_rate = 48000;
    engine->channels = 2;
    engine->playback_device_index = -1;

    return engine;
}

SYNTHWAY_API synthway_result_t synthway_engine_init(
    synthway_engine_t* engine,
    const synthway_engine_config_t* config
) {
    if (!engine || engine->offline) {
        return SYNTHWAY_INVALID_PARAM;
    }

    if (config) {
        if (config->sample_rate > 0) {
            engine->sample_rate = config->sample_rate;
        }
        if (config->channels > 0) {
            engine->channels = config->channels;
        }
        engine->playback_device_index = config->playback_device_index;
    }

    return sw_audio_output_open(
        &engine->output,
        engine->playback_device_index,
        &engine->sample_rate,
        &engine->channels,
        sw_engine_render_callback,
        engine
    );
}

SYNTHWAY_API synthway_result_t synthway_engine_start(synthway_engine_t* engine) {
    if (!engine || !sw_audio_output_is_open(&engine->output)) {
        return SYNTHWAY_INVALID_PARAM;
    }
    if (engine->is_running) {
        return SYNTHWAY_ALREADY_RUNNING;
    }

    synthway_result_t result = sw_audio_output_start(&engine->output);
    if (result != SYNTHWAY_OK) {
        return result;
    }

    engine->is_running = true;
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_stop(synthway_engine_t* engine) {
    if (!engine || !sw_audio_output_is_open(&engine->output)) {
        return SYNTHWAY_INVALID_PARAM;
    }
    if (!engine->is_running) {
        return SYNTHWAY_NOT_RUNNING;
    }

    synthway_result_t result = sw_audio_output_stop(&engine->output);
    if (result != SYNTHWAY_OK) {
        return result;
    }

    engine->is_running = false;
    return SYNTHWAY_OK;
}

SYNTHWAY_API void synthway_engine_destroy(synthway_engine_t* engine) {
    if (!engine) {
        return;
    }

    if (engine->is_running) {
        synthway_engine_stop(engine);
    }

    sw_audio_output_close(&engine->output);
    free(engine);
}

SYNTHWAY_API bool synthway_engine_is_running(const synthway_engine_t* engine) {
    return engine ? engine->is_running : false;
}

SYNTHWAY_API uint32_t synthway_engine_get_sample_rate(const synthway_engine_t* engine) {
    return engine ? engine->sample_rate : 0;
}

SYNTHWAY_API uint32_t synthway_engine_get_channels(const synthway_engine_t* engine) {
    return engine ? engine->channels : 0;
}
