#include "io/audio_file.h"
#include "io/miniaudio_config.h"
#include <stdlib.h>
#include <string.h>

/* Reads every frame of an opened decoder into clip */
static synthway_result_t sw_audio_clip_read(sw_audio_clip* clip, ma_decoder* decoder, double max_seconds) {
    enum { CHUNK_FRAMES = 4096 };

    const uint32_t sample_rate = decoder->outputSampleRate;
    const uint64_t max_frames = (uint64_t)(max_seconds * sample_rate);
    if (sample_rate == 0) {
        return SYNTHWAY_FORMAT_ERROR;
    }

    /* The length is known for WAV and FLAC, estimated or unknown for MP3:
       the buffer grows as needed */
    ma_uint64 length = 0;
    if (ma_decoder_get_length_in_pcm_frames(decoder, &length) != MA_SUCCESS) {
        length = 0;
    }
    if (length > max_frames) {
        return SYNTHWAY_INVALID_PARAM;
    }
    uint64_t capacity = length > 0 ? length + CHUNK_FRAMES : (uint64_t)sample_rate * 4;
    float* samples = (float*)malloc(sizeof(float) * capacity);
    if (!samples) {
        return SYNTHWAY_ERROR;
    }

    uint64_t frames = 0;
    for (;;) {
        if (capacity - frames < CHUNK_FRAMES) {
            capacity *= 2;
            float* grown = (float*)realloc(samples, sizeof(float) * capacity);
            if (!grown) {
                free(samples);
                return SYNTHWAY_ERROR;
            }
            samples = grown;
        }
        ma_uint64 read = 0;
        ma_result result = ma_decoder_read_pcm_frames(decoder, samples + frames, CHUNK_FRAMES, &read);
        frames += read;
        if (frames > max_frames) {
            free(samples);
            return SYNTHWAY_INVALID_PARAM;
        }
        if (result != MA_SUCCESS || read < CHUNK_FRAMES) {
            break; /* MA_AT_END, or a damaged end: keeps what was decoded */
        }
    }

    if (frames == 0) {
        free(samples);
        return SYNTHWAY_FORMAT_ERROR;
    }
    clip->samples = samples;
    clip->frame_count = frames;
    clip->sample_rate = sample_rate;
    return SYNTHWAY_OK;
}

/* Mono float at the file's own rate */
static ma_decoder_config sw_audio_clip_config(void) {
    return ma_decoder_config_init(ma_format_f32, 1, 0);
}

synthway_result_t sw_audio_clip_decode_memory(sw_audio_clip* clip, const void* data, size_t size, double max_seconds) {
    memset(clip, 0, sizeof(*clip));

    ma_decoder_config config = sw_audio_clip_config();
    ma_decoder decoder;
    if (ma_decoder_init_memory(data, size, &config, &decoder) != MA_SUCCESS) {
        return SYNTHWAY_FORMAT_ERROR;
    }
    synthway_result_t result = sw_audio_clip_read(clip, &decoder, max_seconds);
    ma_decoder_uninit(&decoder);
    return result;
}

synthway_result_t sw_audio_clip_decode_file(sw_audio_clip* clip, const char* path, double max_seconds) {
    memset(clip, 0, sizeof(*clip));

    ma_decoder_config config = sw_audio_clip_config();
    ma_decoder decoder;
    ma_result opened = ma_decoder_init_file(path, &config, &decoder);
    if (opened != MA_SUCCESS) {
        /* A file that cannot be read, or a file that is not audio */
        return opened == MA_DOES_NOT_EXIST || opened == MA_ACCESS_DENIED || opened == MA_INVALID_FILE
                   ? SYNTHWAY_IO_ERROR
                   : SYNTHWAY_FORMAT_ERROR;
    }
    synthway_result_t result = sw_audio_clip_read(clip, &decoder, max_seconds);
    ma_decoder_uninit(&decoder);
    return result;
}

void sw_audio_clip_free(sw_audio_clip* clip) {
    free(clip->samples);
    memset(clip, 0, sizeof(*clip));
}
