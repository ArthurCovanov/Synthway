#include "synthway/synthway.h"
#include "io/ma_result.h"
#include <stdio.h>
#include <string.h>

SYNTHWAY_API synthway_result_t synthway_get_device_count(
    synthway_device_type_t type,
    uint32_t* out_count
) {
    if (!out_count) {
        return SYNTHWAY_INVALID_PARAM;
    }

    *out_count = 0;

    ma_context context;
    if (ma_context_init(NULL, 0, NULL, &context) != MA_SUCCESS) {
        return SYNTHWAY_BACKEND_ERROR;
    }

    ma_device_info* pPlaybackInfos = NULL;
    ma_uint32 playbackCount = 0;
    ma_device_info* pCaptureInfos = NULL;
    ma_uint32 captureCount = 0;

    ma_result result = ma_context_get_devices(
        &context,
        &pPlaybackInfos,
        &playbackCount,
        &pCaptureInfos,
        &captureCount
    );

    if (result == MA_SUCCESS) {
        if (type == SYNTHWAY_DEVICE_PLAYBACK) {
            *out_count = (uint32_t)playbackCount;
        } else {
            *out_count = (uint32_t)captureCount;
        }
    }

    ma_context_uninit(&context);
    return sw_result_from_ma(result);
}

SYNTHWAY_API synthway_result_t synthway_get_device_info(
    synthway_device_type_t type,
    uint32_t index,
    synthway_device_info_t* out_info
) {
    if (!out_info) {
        return SYNTHWAY_INVALID_PARAM;
    }

    memset(out_info, 0, sizeof(synthway_device_info_t));
    out_info->type = type;

    ma_context context;
    if (ma_context_init(NULL, 0, NULL, &context) != MA_SUCCESS) {
        return SYNTHWAY_BACKEND_ERROR;
    }

    ma_device_info* pPlaybackInfos = NULL;
    ma_uint32 playbackCount = 0;
    ma_device_info* pCaptureInfos = NULL;
    ma_uint32 captureCount = 0;

    ma_result result = ma_context_get_devices(
        &context,
        &pPlaybackInfos,
        &playbackCount,
        &pCaptureInfos,
        &captureCount
    );

    if (result != MA_SUCCESS) {
        ma_context_uninit(&context);
        return sw_result_from_ma(result);
    }

    const ma_device_info* target_info = NULL;

    if (type == SYNTHWAY_DEVICE_PLAYBACK) {
        if (index >= playbackCount) {
            ma_context_uninit(&context);
            return SYNTHWAY_DEVICE_NOT_FOUND;
        }
        target_info = &pPlaybackInfos[index];
    } else {
        if (index >= captureCount) {
            ma_context_uninit(&context);
            return SYNTHWAY_DEVICE_NOT_FOUND;
        }
        target_info = &pCaptureInfos[index];
    }

    snprintf(out_info->name, sizeof(out_info->name), "%s", target_info->name);
    out_info->is_default = (bool)target_info->isDefault;

    /* Device ID representation */
    snprintf(out_info->id, sizeof(out_info->id), "%u", index);

    /* Pick first native data format details if available */
    if (target_info->nativeDataFormatCount > 0) {
        out_info->sample_rate = target_info->nativeDataFormats[0].sampleRate;
        out_info->channels = target_info->nativeDataFormats[0].channels;
    } else {
        out_info->sample_rate = 48000;
        out_info->channels = 2;
    }

    ma_context_uninit(&context);
    return SYNTHWAY_OK;
}

SYNTHWAY_API void synthway_print_devices(void) {
    uint32_t playback_count = 0;
    uint32_t capture_count = 0;

    synthway_get_device_count(SYNTHWAY_DEVICE_PLAYBACK, &playback_count);
    synthway_get_device_count(SYNTHWAY_DEVICE_CAPTURE, &capture_count);

    printf("\n=======================================================\n");
    printf("              SYNTHWAY AUDIO DEVICES\n");
    printf("=======================================================\n\n");

    printf("--- [ PLAYBACK DEVICES (Outputs) : %u ] ---\n", playback_count);
    if (playback_count == 0) {
        printf("  (No playback devices found)\n");
    }
    for (uint32_t i = 0; i < playback_count; ++i) {
        synthway_device_info_t info;
        if (synthway_get_device_info(SYNTHWAY_DEVICE_PLAYBACK, i, &info) == SYNTHWAY_OK) {
            printf("  [%u] %s%s\n",
                i,
                info.name,
                info.is_default ? "  [DEFAULT]" : "");
            printf("      Channels: %u | Native Sample Rate: %u Hz\n",
                info.channels ? info.channels : 2,
                info.sample_rate ? info.sample_rate : 48000);
        }
    }

    printf("\n--- [ CAPTURE DEVICES (Inputs) : %u ] ---\n", capture_count);
    if (capture_count == 0) {
        printf("  (No capture devices found)\n");
    }
    for (uint32_t i = 0; i < capture_count; ++i) {
        synthway_device_info_t info;
        if (synthway_get_device_info(SYNTHWAY_DEVICE_CAPTURE, i, &info) == SYNTHWAY_OK) {
            printf("  [%u] %s%s\n",
                i,
                info.name,
                info.is_default ? "  [DEFAULT]" : "");
            printf("      Channels: %u | Native Sample Rate: %u Hz\n",
                info.channels ? info.channels : 1,
                info.sample_rate ? info.sample_rate : 48000);
        }
    }
    printf("\n=======================================================\n\n");
}
