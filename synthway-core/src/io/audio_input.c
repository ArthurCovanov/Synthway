#include "io/audio_input.h"
#include "io/ma_result.h"
#include <string.h>

void sw_audio_input_write(sw_audio_input* input, const float* samples, uint32_t count) {
    uint64_t written = atomic_load_explicit(&input->written, memory_order_relaxed);
    for (uint32_t i = 0; i < count; ++i) {
        input->ring[(written + i) & (SW_AUDIO_INPUT_RING_FRAMES - 1)] = samples[i];
    }
    /* Release: the reader that sees the new count also sees the samples */
    atomic_store_explicit(&input->written, written + count, memory_order_release);
}

/* Data callback, called by miniaudio's real-time capture thread: only copies */
static void sw_audio_input_callback(
    ma_device* device,
    void* out,
    const void* in,
    ma_uint32 frame_count
) {
    sw_audio_input* input = (sw_audio_input*)device->pUserData;
    (void)out;

    if (!input || !in) {
        return;
    }
    sw_audio_input_write(input, (const float*)in, frame_count);
}

synthway_result_t sw_audio_input_open(sw_audio_input* input, int device_index, uint32_t sample_rate, bool exclusive) {
    atomic_store_explicit(&input->written, 0, memory_order_relaxed);
    input->exclusive = false;

    if (ma_context_init(NULL, 0, NULL, &input->context) != MA_SUCCESS) {
        return SYNTHWAY_BACKEND_ERROR;
    }
    input->context_initialized = true;

    ma_device_id* device_id = NULL;
    if (device_index >= 0) {
        ma_device_info* capture_infos = NULL;
        ma_uint32 capture_count = 0;
        ma_result result = ma_context_get_devices(&input->context, NULL, NULL, &capture_infos, &capture_count);
        if (result == MA_SUCCESS && (uint32_t)device_index < capture_count) {
            device_id = &capture_infos[device_index].id;
        } else {
            sw_audio_input_close(input);
            return SYNTHWAY_DEVICE_NOT_FOUND;
        }
    }

    /* Mono: miniaudio mixes the device's channels down. In exclusive mode it
       opens the device at its native format and converts it. */
    ma_device_config config = ma_device_config_init(ma_device_type_capture);
    config.capture.pDeviceID = device_id;
    config.capture.format = ma_format_f32;
    config.capture.channels = 1;
    config.capture.shareMode = exclusive ? ma_share_mode_exclusive : ma_share_mode_shared;
    config.sampleRate = sample_rate;
    config.dataCallback = sw_audio_input_callback;
    config.pUserData = input;

    ma_result result = ma_device_init(&input->context, &config, &input->device);
    if (result != MA_SUCCESS) {
        sw_audio_input_close(input);
        return sw_result_from_ma(result);
    }
    input->device_initialized = true;
    input->exclusive = exclusive;
    input->sample_rate = input->device.sampleRate;

    result = ma_device_start(&input->device);
    if (result != MA_SUCCESS) {
        sw_audio_input_close(input);
        return sw_result_from_ma(result);
    }
    return SYNTHWAY_OK;
}

void sw_audio_input_open_virtual(sw_audio_input* input, uint32_t sample_rate) {
    atomic_store_explicit(&input->written, 0, memory_order_relaxed);
    input->exclusive = false;
    input->sample_rate = sample_rate;
    input->is_virtual = true;
}

bool sw_audio_input_is_open(const sw_audio_input* input) {
    return input->device_initialized || input->is_virtual;
}

uint64_t sw_audio_input_written(sw_audio_input* input) {
    return atomic_load_explicit(&input->written, memory_order_acquire);
}

void sw_audio_input_read(const sw_audio_input* input, uint64_t first, float* out, uint32_t count) {
    for (uint32_t i = 0; i < count; ++i) {
        out[i] = input->ring[(first + i) & (SW_AUDIO_INPUT_RING_FRAMES - 1)];
    }
}

void sw_audio_input_read_latest(sw_audio_input* input, float* out, uint32_t count) {
    if (count > SW_AUDIO_INPUT_RING_FRAMES) {
        count = SW_AUDIO_INPUT_RING_FRAMES;
    }
    /* The audio thread keeps writing during the copy, but it would need to
       write the whole rest of the ring (several seconds) to reach the frames
       being copied. */
    const uint64_t written = sw_audio_input_written(input);
    uint32_t missing = 0;
    if (written < count) {
        missing = count - (uint32_t)written;
        memset(out, 0, sizeof(float) * missing);
    }
    sw_audio_input_read(input, written - (count - missing), out + missing, count - missing);
}

void sw_audio_input_close(sw_audio_input* input) {
    if (input->device_initialized) {
        ma_device_uninit(&input->device);
        input->device_initialized = false;
    }

    if (input->context_initialized) {
        ma_context_uninit(&input->context);
        input->context_initialized = false;
    }
    input->is_virtual = false;
    input->exclusive = false;
    input->sample_rate = 0;
}
