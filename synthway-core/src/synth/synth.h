#ifndef SW_SYNTH_SYNTH_H
#define SW_SYNTH_SYNTH_H

/* The synth layer only computes samples: no thread, no device, no file, no
   allocation and no lock. It knows nothing about the engine or miniaudio. */

#include "synthway/types.h"
#include "synth/envelope.h"
#include "synth/oscillator.h"
#include "synth/reverb.h"

/* The sound of an instrument: plain values, read once per block */
typedef struct sw_instrument_sound {
    synthway_waveform_t waveform;
    sw_envelope_settings envelope;   /* of the single oscillator */
    float filter_low_cutoff_hz;
    float filter_high_cutoff_hz;
    float filter_resonance;
    float reverb_mix;                /* in [0, 1], 0: no reverb */
    uint32_t unison_voices;          /* oscillators per partial of the timbre, 1: no unison */
    float unison_detune_cents;       /* the outermost voices are this far below and above the partial */
    float unison_spread;             /* in [0, 1]: how far apart in the stereo field */
    const synthway_timbre_t* timbre; /* NULL: the single oscillator plays (waveform, envelope); valid for the whole block */
} sw_instrument_sound;

/* Everything a block is rendered with */
typedef struct sw_synth_params {
    /* The note of the single-note API, always played by voice 0 on instrument 0 */
    float frequency_hz;
    float volume;                    /* in [0, 1] */
    bool gate;                       /* note held: opening it starts the attack, closing it the release */
    sw_instrument_sound instruments[SYNTHWAY_MAX_INSTRUMENTS];
} sw_synth_params;

/* State of one partial of the timbre: one oscillator per unison voice, one envelope */
typedef struct sw_synth_partial {
    sw_oscillator oscillators[SYNTHWAY_MAX_UNISON_VOICES];
    sw_envelope envelope;
} sw_synth_partial;

typedef struct sw_filter_state {
    float x1, x2, y1, y2;
} sw_filter_state;

/* A glide waiting: to this frequency, in this time */
typedef struct sw_glide {
    float frequency_hz;
    float seconds;
} sw_glide;

/* One note being played. Voice 0 belongs to the single-note API; the others
   are given out by sw_synth_note_on. */
typedef struct sw_voice {
    float frequency_hz;              /* targets of the smoothing; frequency_hz follows the running glide */
    float volume;
    sw_glide glides[SYNTHWAY_MAX_GLIDES]; /* waiting, in a ring from glide_head */
    uint32_t glide_head;
    uint32_t glide_count;
    uint32_t glide_left;             /* samples left in the running glide, 0: none runs */
    double glide_frequency;          /* where the running glide is, in double so that it does not drift */
    double glide_factor;             /* by which glide_frequency grows at each sample */
    float glide_target;              /* where the running glide ends, exactly */
    float current_frequency;         /* smoothed towards frequency_hz */
    float current_volume;            /* smoothed towards volume */
    bool gate;                       /* held, as last asked */
    bool gate_seen;                  /* gate as seen by the previous block */
    bool trigger;                    /* a note_on to start at the next block, even when the gate stays held */
    bool sounding;                   /* held or still fading out, as of the end of the previous block */
    uint32_t note_id;
    uint32_t instrument;
    uint64_t started;                /* order of its note_on, to take the oldest one back */
    sw_oscillator oscillator;        /* single oscillator */
    sw_envelope envelope;
    sw_synth_partial partials[SYNTHWAY_MAX_PARTIALS]; /* timbre, by partial index */
} sw_voice;

/* What every note of an instrument goes through, in this order: the filter,
   then the reverb. Both are linear: filtering the sum of the notes is the
   same as filtering each of them. */
typedef struct sw_instrument_bus {
    sw_filter_state high_pass[2];    /* left, right */
    sw_filter_state low_pass[2];
    bool active;                     /* processed by the previous block */
    sw_reverb reverb;                /* last: its delay lines are large */
} sw_instrument_bus;

/* Floats of the buffer an instrument's notes are summed into, all channels:
   blocks are rendered in chunks that fit */
#define SW_SYNTH_MIX_SAMPLES 4096

/* Every voice and every instrument, owned by the thread that renders them */
typedef struct sw_synth {
    sw_voice voices[1 + SYNTHWAY_MAX_NOTES];
    uint64_t note_count;             /* note_on calls so far */
    float mix[SW_SYNTH_MIX_SAMPLES];
    sw_envelope_steps steps[SYNTHWAY_MAX_INSTRUMENTS][1 + SYNTHWAY_MAX_PARTIALS]; /* single oscillator, then partials */
    sw_instrument_bus buses[SYNTHWAY_MAX_INSTRUMENTS]; /* last: their reverbs are large */
} sw_synth;

/* Silent synth; voice 0 smooths from frequency_hz and volume */
void sw_synth_init(sw_synth* synth, float frequency_hz, float volume);

/* Starts a note on a free voice, or the one note_id already plays (it starts
   again from its current level), or else the oldest one: first among those
   fading out, then among those held. Takes effect at the next block. */
void sw_synth_note_on(sw_synth* synth, uint32_t note_id, uint32_t instrument, float frequency_hz, float volume);

/* Releases the voice that holds note_id; nothing when none does */
void sw_synth_note_off(sw_synth* synth, uint32_t note_id);

/* Queues a glide of the voice that plays note_id (held or fading out): see
   synthway_engine_note_glide. Nothing when none does, or its queue is full. */
void sw_synth_note_glide(sw_synth* synth, uint32_t note_id, float frequency_hz, float seconds);

/* Releases every voice but voice 0 */
void sw_synth_all_notes_off(sw_synth* synth);

/* Voices but voice 0 that are held, about to start or still fading out */
uint32_t sw_synth_sounding_notes(const sw_synth* synth);

/* Renders frame_count interleaved frames into out: the sum of every
   instrument, each the sum of its voices, then filtered and reverberated.
   The same sample goes on every channel until a spread unison or the reverb
   makes left (even channels) and right (odd channels) differ; a single
   channel gets their mean. */
void sw_synth_render(
    sw_synth* synth,
    const sw_synth_params* params,
    uint32_t sample_rate,
    uint32_t channels,
    float* out,
    uint32_t frame_count
);

#endif /* SW_SYNTH_SYNTH_H */
