#include "io/wav_file.h"
#include <stdlib.h>

synthway_result_t sw_wav_file_open(
    sw_wav_file* file,
    const char* path,
    uint32_t channels,
    uint32_t sample_rate,
    uint32_t block_frames
) {
    file->channels = channels;
    file->block_frames = block_frames;
    file->pcm = (ma_int16*)malloc(sizeof(ma_int16) * block_frames * channels);
    if (!file->pcm) {
        return SYNTHWAY_ERROR;
    }

    ma_encoder_config config = ma_encoder_config_init(ma_encoding_format_wav, ma_format_s16, channels, sample_rate);
    if (ma_encoder_init_file(path, &config, &file->encoder) != MA_SUCCESS) {
        free(file->pcm);
        file->pcm = NULL;
        return SYNTHWAY_IO_ERROR;
    }

    return SYNTHWAY_OK;
}

synthway_result_t sw_wav_file_write(sw_wav_file* file, const float* samples, uint32_t frame_count) {
    while (frame_count > 0) {
        uint32_t frames = frame_count < file->block_frames ? frame_count : file->block_frames;
        ma_pcm_f32_to_s16(file->pcm, samples, (ma_uint64)frames * file->channels, ma_dither_mode_none);
        if (ma_encoder_write_pcm_frames(&file->encoder, file->pcm, frames, NULL) != MA_SUCCESS) {
            return SYNTHWAY_IO_ERROR;
        }
        samples += (size_t)frames * file->channels;
        frame_count -= frames;
    }
    return SYNTHWAY_OK;
}

void sw_wav_file_close(sw_wav_file* file) {
    ma_encoder_uninit(&file->encoder);
    free(file->pcm);
    file->pcm = NULL;
}
