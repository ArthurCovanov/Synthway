#ifndef SW_ENGINE_PARAMS_H
#define SW_ENGINE_PARAMS_H

#include "synthway/types.h"
#include "synth/synth.h"
#include <stdatomic.h>

/* Sound of a new engine: concert pitch A4, at a safe listening volume */
#define SW_DEFAULT_FREQUENCY 440.0f
#define SW_DEFAULT_VOLUME 0.25f

/* The boundary between threads. Written by the API thread (setters), read by
   the audio thread once per block (sw_engine_params_snapshot) — atomic to
   avoid data races.  memory_order_relaxed is sufficient: the per-sample
   smoothing makes any temporary cross-field inconsistency inaudible, and on
   x86 relaxed atomics compile to plain loads/stores (zero overhead).
   Only engine_params.c touches these fields. A new parameter shared with the
   audio thread follows the same pattern: field here, relaxed store in its
   setter, relaxed load in the snapshot. */

/* A timbre is too large for one atomic, and must never be read half old,
   half new: it goes through a triple buffer. A writer fills a slot of its own,
   then swaps it with the shared one; the audio thread swaps its slot with the
   shared one when that holds a newer timbre. Neither ever waits for the other.
   Writers are serialized by a spin lock that the audio thread never takes. */
typedef struct sw_timbre_slot {
    bool enabled;                  /* false: the single oscillator plays */
    synthway_timbre_t timbre;
} sw_timbre_slot;

typedef struct sw_timbre_exchange {
    sw_timbre_slot slots[3];
    _Atomic unsigned shared;       /* slot between the threads, | SW_TIMBRE_FRESH when the reader has not taken it yet */
    unsigned writer_slot;          /* owned by the writer, under writer_lock */
    unsigned reader_slot;          /* owned by the audio thread (or the offline renderer) */
    sw_timbre_slot latest;         /* last timbre written, for the getters, under writer_lock */
    atomic_flag writer_lock;
} sw_timbre_exchange;

/* The sound of one instrument slot */
typedef struct sw_instrument_params {
    _Atomic synthway_waveform_t waveform;
    _Atomic float env_attack;   /* seconds */
    _Atomic float env_decay;    /* seconds */
    _Atomic float env_sustain;  /* level in [0, 1] */
    _Atomic float env_release;  /* seconds */
    _Atomic float filter_low_cutoff;
    _Atomic float filter_high_cutoff;
    _Atomic float filter_resonance;
    _Atomic float reverb_mix;   /* in [0, 1] */
    _Atomic uint32_t unison_voices;     /* 1 to SYNTHWAY_MAX_UNISON_VOICES */
    _Atomic float unison_detune_cents;
    _Atomic float unison_spread;        /* in [0, 1] */
    sw_timbre_exchange timbre;
} sw_instrument_params;

/* Notes go to the audio thread through a ring of events: writers append
   under a spin lock that the audio thread never takes, and publish the new
   head (release); the audio thread reads up to it (acquire) at the start of
   each block, then publishes the tail it has reached. */
typedef enum sw_note_event_type {
    SW_NOTE_EVENT_ON,
    SW_NOTE_EVENT_OFF,
    SW_NOTE_EVENT_ALL_OFF,
    SW_NOTE_EVENT_GLIDE
} sw_note_event_type;

typedef struct sw_note_event {
    sw_note_event_type type;
    uint32_t note_id;
    uint32_t instrument;
    float frequency_hz;
    float volume;
    float seconds;                 /* of a glide */
} sw_note_event;

/* A power of two, so that the indices can wrap around freely */
#define SW_NOTE_QUEUE_CAPACITY 1024u

typedef struct sw_note_queue {
    sw_note_event events[SW_NOTE_QUEUE_CAPACITY];
    _Atomic uint32_t head;         /* events written: owned by the writers */
    _Atomic uint32_t tail;         /* events read: owned by the audio thread */
    atomic_flag writer_lock;
} sw_note_queue;

typedef struct sw_engine_params {
    /* The single-note API's note */
    _Atomic bool tone_enabled;
    _Atomic float target_frequency;
    _Atomic float target_volume;
    sw_instrument_params instruments[SYNTHWAY_MAX_INSTRUMENTS];
    sw_note_queue notes;
    _Atomic uint32_t sounding_notes; /* written by the audio thread after each block */
} sw_engine_params;

/* Default sound, tone enabled, with a short envelope that does not click */
void sw_engine_params_init(sw_engine_params* params);

/* Reads every parameter once, into the plain values the next block is rendered with.
   Called by the audio thread only: the timbres it points to stay valid until its next call. */
void sw_engine_params_snapshot(sw_engine_params* params, sw_synth_params* out);

/* Hands the notes waiting in the queue to synth, in order. Called by the audio thread only. */
void sw_engine_params_take_notes(sw_engine_params* params, sw_synth* synth);

#endif /* SW_ENGINE_PARAMS_H */
