#ifndef SW_IO_AUDIO_WRITER_H
#define SW_IO_AUDIO_WRITER_H

#include "synthway/types.h"

/* The audio writer's side used by offline rendering (engine_offline.c).
   The writer itself, WAV or Ogg Vorbis, is private to audio_writer.c. */

/* SYNTHWAY_OK when the writer takes frames of channels channels at sample_rate */
synthway_result_t sw_audio_writer_check(const synthway_audio_writer_t* writer, uint32_t channels, uint32_t sample_rate);

/* Starts the measure of last_peak: called once by each public write or render */
void sw_audio_writer_begin(synthway_audio_writer_t* writer);

/* Appends frame_count interleaved frames, gain going in a straight line from
   gain_start (first frame) to gain_end (after the last one), clipped to [-1, 1] */
synthway_result_t sw_audio_writer_put(
    synthway_audio_writer_t* writer,
    const float* samples,
    uint32_t frame_count,
    float gain_start,
    float gain_end
);

#endif /* SW_IO_AUDIO_WRITER_H */
