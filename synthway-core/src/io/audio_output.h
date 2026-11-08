#ifndef SW_IO_AUDIO_OUTPUT_H
#define SW_IO_AUDIO_OUTPUT_H

#include "synthway/types.h"
#include "io/miniaudio_config.h"

/* Fills out with frame_count interleaved frames. Called by the real-time audio
   thread: no allocation, no lock, no I/O. */
typedef void (*sw_render_fn)(void* user_data, float* out, uint32_t frame_count);

/* A playback device opened with miniaudio. It knows nothing about the engine:
   its audio thread calls the render function it was opened with. */
typedef struct sw_audio_output {
    ma_context context;
    ma_device device;
    bool context_initialized;
    bool device_initialized;
    sw_render_fn render;
    void* user_data;
} sw_audio_output;

/* Opens the playback device (device_index -1: system default). miniaudio
   creates the audio thread here, asleep until sw_audio_output_start.
   sample_rate and channels are requested, then replaced by the values the
   driver actually uses. */
synthway_result_t sw_audio_output_open(
    sw_audio_output* output,
    int device_index,
    uint32_t* sample_rate,
    uint32_t* channels,
    sw_render_fn render,
    void* user_data
);

bool sw_audio_output_is_open(const sw_audio_output* output);

/* Wakes the audio thread up: render is called from now on */
synthway_result_t sw_audio_output_start(sw_audio_output* output);

/* Puts the audio thread back to sleep */
synthway_result_t sw_audio_output_stop(sw_audio_output* output);

/* Releases the device and its threads; does nothing if not open */
void sw_audio_output_close(sw_audio_output* output);

#endif /* SW_IO_AUDIO_OUTPUT_H */
