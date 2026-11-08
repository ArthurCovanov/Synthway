#ifndef SW_SYNTH_SYNTH_H
#define SW_SYNTH_SYNTH_H

/* The synth layer only computes samples: no thread, no device, no file, no
   allocation and no lock. It knows nothing about the engine or miniaudio. */

#include "synthway/types.h"
#include "synth/envelope.h"
#include "synth/oscillator.h"
#include "synth/reverb.h"

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
    float reverb_mix;                /* in [0, 1], 0: no reverb */
    uint32_t unison_voices;          /* oscillators per partial of the timbre, 1: no unison */
    float unison_detune_cents;       /* the outermost voices are this far below and above the partial */
    float unison_spread;             /* in [0, 1]: how far apart in the stereo field */
    const synthway_timbre_t* timbre; /* NULL: the single oscillator plays (waveform, envelope); valid for the whole block */
} sw_synth_params;

/* State of one partial of the timbre: one oscillator per unison voice, one envelope */
typedef struct sw_synth_partial {
    sw_oscillator oscillators[SYNTHWAY_MAX_UNISON_VOICES];
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
    sw_filter_state high_pass[2];    /* left, right */
    sw_filter_state low_pass[2];
    sw_synth_partial partials[SYNTHWAY_MAX_PARTIALS]; /* timbre, by partial index */
    sw_reverb reverb;                /* last: its delay lines are large */
} sw_synth;

/* Silent voice whose smoothing starts from frequency_hz and volume */
void sw_synth_init(sw_synth* synth, float frequency_hz, float volume);

/* Renders frame_count interleaved frames into out, the same sample on every
   channel until a spread unison or the reverb makes left (even channels) and
   right (odd channels) differ; a single channel gets their mean */
void sw_synth_render(
    sw_synth* synth,
    const sw_synth_params* params,
    uint32_t sample_rate,
    uint32_t channels,
    float* out,
    uint32_t frame_count
);

#endif /* SW_SYNTH_SYNTH_H */
