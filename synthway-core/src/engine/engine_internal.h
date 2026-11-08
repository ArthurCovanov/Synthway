#ifndef SW_ENGINE_INTERNAL_H
#define SW_ENGINE_INTERNAL_H

#include "synthway/synthway.h"
#include "engine/engine_params.h"
#include "io/audio_output.h"
#include "synth/synth.h"

/* The engine composes the layers: the parameters shared between threads, the
   synth that renders them, and the sound card it renders to. */
struct synthway_engine {
    sw_audio_output output;    /* unused when offline */
    bool offline;              /* initialized by synthway_engine_init_offline: no device */
    bool is_running;

    sw_engine_params params;   /* thread boundary, see engine_params.h */

    /* Owned exclusively by the audio thread (or offline render) — no
       synchronization needed. */
    sw_synth synth;

    uint32_t sample_rate;
    uint32_t channels;
    int playback_device_index;
};

/* Renders frame_count interleaved frames, exactly what the sound card
   receives. Called by the audio thread, or by the offline renderer. */
void sw_engine_render(synthway_engine_t* engine, float* out, uint32_t frame_count);

#endif /* SW_ENGINE_INTERNAL_H */
