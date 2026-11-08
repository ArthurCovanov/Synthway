#include "io/audio_writer.h"
#include "io/wav_file.h"
#include "synthway/engine.h"
#include <vorbis/vorbisenc.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

/* Frames clipped and handed to the encoder at a time */
#define SW_WRITER_BLOCK_FRAMES 1024u

/* An audio file being written (offline only: allocates and does file I/O) */
struct synthway_audio_writer {
    synthway_audio_file_format_t format;
    uint32_t channels;
    uint32_t sample_rate;
    synthway_audio_writer_stats_t stats;
    bool failed;                   /* a write failed: the file is unusable, close reports it */
    float* block;                  /* SW_WRITER_BLOCK_FRAMES frames, gained and clipped */

    sw_wav_file wav;               /* SYNTHWAY_AUDIO_FILE_WAV */

    FILE* file;                    /* SYNTHWAY_AUDIO_FILE_OGG */
    ogg_stream_state stream;
    vorbis_info info;
    vorbis_comment comment;
    vorbis_dsp_state dsp;
    vorbis_block vorbis_block;
};

/* ---------- Ogg Vorbis ---------- */

/* Writes the Ogg pages that are ready; flush: also the last one, even when not full */
static synthway_result_t sw_ogg_write_pages(synthway_audio_writer_t* writer, bool flush) {
    ogg_page page;
    while (flush ? ogg_stream_flush(&writer->stream, &page) : ogg_stream_pageout(&writer->stream, &page)) {
        if (fwrite(page.header, 1, (size_t)page.header_len, writer->file) != (size_t)page.header_len ||
            fwrite(page.body, 1, (size_t)page.body_len, writer->file) != (size_t)page.body_len) {
            return SYNTHWAY_IO_ERROR;
        }
    }
    return SYNTHWAY_OK;
}

/* Encodes what the analysis buffer holds into packets, and writes the pages they fill */
static synthway_result_t sw_ogg_encode(synthway_audio_writer_t* writer) {
    ogg_packet packet;
    while (vorbis_analysis_blockout(&writer->dsp, &writer->vorbis_block) == 1) {
        vorbis_analysis(&writer->vorbis_block, NULL);
        vorbis_bitrate_addblock(&writer->vorbis_block);
        while (vorbis_bitrate_flushpacket(&writer->dsp, &packet)) {
            ogg_stream_packetin(&writer->stream, &packet);
            synthway_result_t result = sw_ogg_write_pages(writer, false);
            if (result != SYNTHWAY_OK) {
                return result;
            }
        }
    }
    return SYNTHWAY_OK;
}

/* Frees the encoder's state, in the order libvorbis asks (vorbis_info last) */
static void sw_ogg_clear(synthway_audio_writer_t* writer) {
    ogg_stream_clear(&writer->stream);
    vorbis_block_clear(&writer->vorbis_block);
    vorbis_dsp_clear(&writer->dsp);
    vorbis_comment_clear(&writer->comment);
    vorbis_info_clear(&writer->info);
}

static synthway_result_t sw_ogg_open(synthway_audio_writer_t* writer, const char* path, float quality) {
    writer->file = fopen(path, "wb");
    if (!writer->file) {
        return SYNTHWAY_IO_ERROR;
    }

    vorbis_info_init(&writer->info);
    if (vorbis_encode_init_vbr(&writer->info, (long)writer->channels, (long)writer->sample_rate, quality) != 0) {
        vorbis_info_clear(&writer->info);
        fclose(writer->file);
        remove(path);
        return SYNTHWAY_INVALID_PARAM;
    }
    vorbis_comment_init(&writer->comment);
    vorbis_comment_add_tag(&writer->comment, "ENCODER", "Synthway");
    vorbis_analysis_init(&writer->dsp, &writer->info);
    vorbis_block_init(&writer->dsp, &writer->vorbis_block);
    /* Any serial number: it tells this stream apart from others chained in the same file */
    ogg_stream_init(&writer->stream, (int)((uint32_t)time(NULL) ^ (uint32_t)(uintptr_t)writer));

    ogg_packet identification, comments, codebooks;
    vorbis_analysis_headerout(&writer->dsp, &writer->comment, &identification, &comments, &codebooks);
    ogg_stream_packetin(&writer->stream, &identification);
    ogg_stream_packetin(&writer->stream, &comments);
    ogg_stream_packetin(&writer->stream, &codebooks);

    /* The audio starts on a page of its own, as the Vorbis specification asks */
    synthway_result_t result = sw_ogg_write_pages(writer, true);
    if (result != SYNTHWAY_OK) {
        sw_ogg_clear(writer);
        fclose(writer->file);
        remove(path);
    }
    return result;
}

static synthway_result_t sw_ogg_write(synthway_audio_writer_t* writer, const float* block, uint32_t frames) {
    /* Vorbis takes one buffer per channel */
    float** buffer = vorbis_analysis_buffer(&writer->dsp, (int)frames);
    for (uint32_t i = 0; i < frames; i++) {
        for (uint32_t c = 0; c < writer->channels; c++) {
            buffer[c][i] = block[(size_t)i * writer->channels + c];
        }
    }
    vorbis_analysis_wrote(&writer->dsp, (int)frames);
    return sw_ogg_encode(writer);
}

/* Last packets, with the end of stream, then the last page */
static synthway_result_t sw_ogg_finish(synthway_audio_writer_t* writer) {
    vorbis_analysis_wrote(&writer->dsp, 0);
    synthway_result_t result = sw_ogg_encode(writer);
    if (result == SYNTHWAY_OK) {
        result = sw_ogg_write_pages(writer, true);
    }
    return result;
}

/* ---------- Writer ---------- */

synthway_result_t sw_audio_writer_check(const synthway_audio_writer_t* writer, uint32_t channels, uint32_t sample_rate) {
    return writer->channels == channels && writer->sample_rate == sample_rate ? SYNTHWAY_OK : SYNTHWAY_INVALID_PARAM;
}

void sw_audio_writer_begin(synthway_audio_writer_t* writer) {
    writer->stats.last_peak = 0.0f;
}

synthway_result_t sw_audio_writer_put(
    synthway_audio_writer_t* writer,
    const float* samples,
    uint32_t frame_count,
    float gain_start,
    float gain_end
) {
    if (writer->failed) {
        return SYNTHWAY_IO_ERROR;
    }

    const uint32_t channels = writer->channels;
    const float slope = frame_count > 0 ? (gain_end - gain_start) / (float)frame_count : 0.0f;
    synthway_audio_writer_stats_t* stats = &writer->stats;

    for (uint32_t done = 0; done < frame_count; ) {
        uint32_t frames = frame_count - done < SW_WRITER_BLOCK_FRAMES ? frame_count - done : SW_WRITER_BLOCK_FRAMES;
        for (uint32_t i = 0; i < frames; i++) {
            const float gain = gain_start + slope * (float)(done + i);
            for (uint32_t c = 0; c < channels; c++) {
                const size_t index = (size_t)i * channels + c;
                float value = samples[(size_t)done * channels + index] * gain;
                if (value != value) {
                    value = 0.0f; /* NaN: silence rather than noise */
                }
                const float magnitude = fabsf(value);
                if (magnitude > stats->peak) {
                    stats->peak = magnitude;
                }
                if (magnitude > stats->last_peak) {
                    stats->last_peak = magnitude;
                }
                /* As the sound card would play it */
                if (value > 1.0f) {
                    value = 1.0f;
                    stats->clipped_samples++;
                } else if (value < -1.0f) {
                    value = -1.0f;
                    stats->clipped_samples++;
                }
                writer->block[index] = value;
            }
        }

        synthway_result_t result = writer->format == SYNTHWAY_AUDIO_FILE_WAV
            ? sw_wav_file_write(&writer->wav, writer->block, frames)
            : sw_ogg_write(writer, writer->block, frames);
        if (result != SYNTHWAY_OK) {
            writer->failed = true;
            return result;
        }
        stats->frames += frames;
        done += frames;
    }
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_audio_writer_open(
    synthway_audio_writer_t** out_writer,
    const char* path,
    synthway_audio_file_format_t format,
    uint32_t channels,
    uint32_t sample_rate,
    float quality
) {
    if (!out_writer) {
        return SYNTHWAY_INVALID_PARAM;
    }
    *out_writer = NULL;
    if (!path || channels < 1 || channels > 2 || sample_rate < 8000 || sample_rate > 192000) {
        return SYNTHWAY_INVALID_PARAM;
    }
    if (format != SYNTHWAY_AUDIO_FILE_WAV && format != SYNTHWAY_AUDIO_FILE_OGG) {
        return SYNTHWAY_INVALID_PARAM;
    }
    /* Written so that NaN is refused too */
    if (format == SYNTHWAY_AUDIO_FILE_OGG && !(quality >= -0.1f && quality <= 1.0f)) {
        return SYNTHWAY_INVALID_PARAM;
    }

    synthway_audio_writer_t* writer = (synthway_audio_writer_t*)calloc(1, sizeof(synthway_audio_writer_t));
    if (!writer) {
        return SYNTHWAY_ERROR;
    }
    writer->format = format;
    writer->channels = channels;
    writer->sample_rate = sample_rate;
    writer->block = (float*)malloc(sizeof(float) * SW_WRITER_BLOCK_FRAMES * channels);
    if (!writer->block) {
        free(writer);
        return SYNTHWAY_ERROR;
    }

    synthway_result_t result = format == SYNTHWAY_AUDIO_FILE_WAV
        ? sw_wav_file_open(&writer->wav, path, channels, sample_rate, SW_WRITER_BLOCK_FRAMES)
        : sw_ogg_open(writer, path, quality);
    if (result != SYNTHWAY_OK) {
        free(writer->block);
        free(writer);
        return result;
    }

    *out_writer = writer;
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_audio_writer_write(
    synthway_audio_writer_t* writer,
    const float* samples,
    uint32_t frame_count
) {
    if (!writer || (!samples && frame_count > 0)) {
        return SYNTHWAY_INVALID_PARAM;
    }
    sw_audio_writer_begin(writer);
    return sw_audio_writer_put(writer, samples, frame_count, 1.0f, 1.0f);
}

SYNTHWAY_API synthway_result_t synthway_audio_writer_get_stats(
    const synthway_audio_writer_t* writer,
    synthway_audio_writer_stats_t* out_stats
) {
    if (!writer || !out_stats) {
        return SYNTHWAY_INVALID_PARAM;
    }
    *out_stats = writer->stats;
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_audio_writer_close(synthway_audio_writer_t* writer) {
    if (!writer) {
        return SYNTHWAY_INVALID_PARAM;
    }

    synthway_result_t result = writer->failed ? SYNTHWAY_IO_ERROR : SYNTHWAY_OK;
    if (writer->format == SYNTHWAY_AUDIO_FILE_WAV) {
        /* Writes the sizes into the header */
        sw_wav_file_close(&writer->wav);
    } else {
        if (result == SYNTHWAY_OK) {
            result = sw_ogg_finish(writer);
        }
        sw_ogg_clear(writer);
        if (fclose(writer->file) != 0 && result == SYNTHWAY_OK) {
            result = SYNTHWAY_IO_ERROR;
        }
    }

    free(writer->block);
    free(writer);
    return result;
}
