#include "io/audio_output.h"
#include "io/ma_result.h"

/* Data callback, called by miniaudio's real-time audio thread */
static void sw_audio_output_callback(
    ma_device* device,
    void* out,
    const void* in,
    ma_uint32 frame_count
) {
    sw_audio_output* output = (sw_audio_output*)device->pUserData;
    (void)in;

    if (!output || !out) {
        return;
    }

    output->render(output->user_data, (float*)out, frame_count);
}

synthway_result_t sw_audio_output_open(
    sw_audio_output* output,
    int device_index,
    uint32_t* sample_rate,
    uint32_t* channels,
    sw_render_fn render,
    void* user_data
) {
    output->render = render;
    output->user_data = user_data;

    if (ma_context_init(NULL, 0, NULL, &output->context) != MA_SUCCESS) {
        return SYNTHWAY_BACKEND_ERROR;
    }
    output->context_initialized = true;

    ma_device_id* device_id = NULL;
    if (device_index >= 0) {
        ma_device_info* playback_infos = NULL;
        ma_uint32 playback_count = 0;
        ma_result result = ma_context_get_devices(&output->context, &playback_infos, &playback_count, NULL, NULL);
        if (result == MA_SUCCESS && (uint32_t)device_index < playback_count) {
            device_id = &playback_infos[device_index].id;
        } else {
            ma_context_uninit(&output->context);
            output->context_initialized = false;
            return SYNTHWAY_DEVICE_NOT_FOUND;
        }
    }

    ma_device_config config = ma_device_config_init(ma_device_type_playback);
    config.playback.pDeviceID = device_id;
    config.playback.format = ma_format_f32;
    config.playback.channels = *channels;
    config.sampleRate = *sample_rate;
    config.dataCallback = sw_audio_output_callback;
    config.pUserData = output;

    ma_result init_result = ma_device_init(&output->context, &config, &output->device);
    if (init_result != MA_SUCCESS) {
        ma_context_uninit(&output->context);
        output->context_initialized = false;
        return sw_result_from_ma(init_result);
    }
    output->device_initialized = true;

    /* Read back the actual sample rate and channels if adjusted by the driver */
    *sample_rate = output->device.sampleRate;
    *channels = output->device.playback.channels;

    return SYNTHWAY_OK;
}

bool sw_audio_output_is_open(const sw_audio_output* output) {
    return output->device_initialized;
}

synthway_result_t sw_audio_output_start(sw_audio_output* output) {
    return sw_result_from_ma(ma_device_start(&output->device));
}

synthway_result_t sw_audio_output_stop(sw_audio_output* output) {
    return sw_result_from_ma(ma_device_stop(&output->device));
}

void sw_audio_output_close(sw_audio_output* output) {
    if (output->device_initialized) {
        ma_device_uninit(&output->device);
        output->device_initialized = false;
    }

    if (output->context_initialized) {
        ma_context_uninit(&output->context);
        output->context_initialized = false;
    }
}
