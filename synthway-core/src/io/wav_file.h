#ifndef SW_IO_WAV_FILE_H
#define SW_IO_WAV_FILE_H

#include "synthway/types.h"
#include "io/miniaudio_config.h"

/* 16-bit PCM WAV file, written block by block (offline rendering only: it
   allocates and does file I/O, never use it from the audio thread) */
typedef struct sw_wav_file {
    ma_encoder encoder;
    ma_int16* pcm;             /* conversion buffer of block_frames frames */
    uint32_t channels;
    uint32_t block_frames;
} sw_wav_file;

/* Creates or overwrites path. The path goes to fopen(): ANSI code page on
   Windows, UTF-8 elsewhere. */
synthway_result_t sw_wav_file_open(
    sw_wav_file* file,
    const char* path,
    uint32_t channels,
    uint32_t sample_rate,
    uint32_t block_frames
);

/* Appends frame_count interleaved float frames in [-1, 1], converted to 16 bits */
synthway_result_t sw_wav_file_write(sw_wav_file* file, const float* samples, uint32_t frame_count);

void sw_wav_file_close(sw_wav_file* file);

#endif /* SW_IO_WAV_FILE_H */
