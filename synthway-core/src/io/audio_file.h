#ifndef SW_IO_AUDIO_FILE_H
#define SW_IO_AUDIO_FILE_H

#include "synthway/types.h"
#include <stddef.h>

/* A whole audio file decoded in memory: mono float samples in [-1, 1], at the
   file's own sample rate (never from the audio thread: it allocates) */
typedef struct sw_audio_clip {
    float* samples;            /* allocated, NULL when empty */
    uint64_t frame_count;
    uint32_t sample_rate;
} sw_audio_clip;

/* Decodes a WAV, FLAC or MP3 file held in memory (data, size bytes), mixed
   down to mono. Refuses files longer than max_seconds (SYNTHWAY_INVALID_PARAM).
   On failure, clip is left empty. */
synthway_result_t sw_audio_clip_decode_memory(sw_audio_clip* clip, const void* data, size_t size, double max_seconds);

/* Same, from a file. The path goes to fopen(): ANSI code page on Windows,
   UTF-8 elsewhere. */
synthway_result_t sw_audio_clip_decode_file(sw_audio_clip* clip, const char* path, double max_seconds);

void sw_audio_clip_free(sw_audio_clip* clip);

#endif /* SW_IO_AUDIO_FILE_H */
