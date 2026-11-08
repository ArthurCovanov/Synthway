#ifndef SW_SYNTH_SYNTH_H
#define SW_SYNTH_SYNTH_H

/* The synth layer only computes samples: no thread, no device, no file, no
   allocation and no lock. It knows nothing about the engine or miniaudio. */

#include "synthway/types.h"
#include "synth/envelope.h"
#include "synth/oscillator.h"

/* Everything a block is rendered with: plain values, read once per block */
typedef struct sw_synth_params {
    float frequency_hz;
    float volume;                    /* in [0, 1] */
    synthway_waveform_t waveform;
    bool gate;                       /* note held: opening it starts the attack, closing it the release */
    sw_envelope_settings envelope;
    float filter_low_cutoff_hz;
    float filter_high_cutoff_hz;
    float filter_resonance;
    const synthway_timbre_t* timbre; /* NULL: the single oscillator plays (waveform, envelope); valid for the whole block */
} sw_synth_params;

/* State of one partial of the timbre */
typedef struct sw_synth_partial {
    sw_oscillator oscillator;
    sw_envelope envelope;
} sw_synth_partial;

typedef struct sw_filter_state {
    float x1, x2, y1, y2;
} sw_filter_state;

/* One voice, owned by the thread that renders it */
typedef struct sw_synth {
    float current_frequency;         /* smoothed towards sw_synth_params.frequency_hz */
    float current_volume;            /* smoothed towards sw_synth_params.volume */
    bool gate;                       /* gate as seen by the previous block */
    sw_oscillator oscillator;        /* single oscillator */
    sw_envelope envelope;
    sw_filter_state high_pass;
    sw_filter_state low_pass;
    sw_synth_partial partials[SYNTHWAY_MAX_PARTIALS]; /* timbre, by partial index */
} sw_synth;

/* Silent voice whose smoothing starts from frequency_hz and volume */
void sw_synth_init(sw_synth* synth, float frequency_hz, float volume);

/* Renders frame_count interleaved frames into out, the same sample on every channel */
void sw_synth_render(
    sw_synth* synth,
    const sw_synth_params* params,
    uint32_t sample_rate,
    uint32_t channels,
    float* out,
    uint32_t frame_count
);

#endif /* SW_SYNTH_SYNTH_H */
