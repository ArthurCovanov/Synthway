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

typedef struct sw_engine_params {
    _Atomic bool tone_enabled;
    _Atomic synthway_waveform_t waveform;
    _Atomic float target_frequency;
    _Atomic float target_volume;
    _Atomic float env_attack;   /* seconds */
    _Atomic float env_decay;    /* seconds */
    _Atomic float env_sustain;  /* level in [0, 1] */
    _Atomic float env_release;  /* seconds */
    _Atomic float filter_low_cutoff;
    _Atomic float filter_high_cutoff;
    _Atomic float filter_resonance;
    sw_timbre_exchange timbre;
} sw_engine_params;

/* Default sound, tone enabled, with a short envelope that does not click */
void sw_engine_params_init(sw_engine_params* params);

/* Reads every parameter once, into the plain values the next block is rendered with.
   Called by the audio thread only: the timbre it points to stays valid until its next call. */
void sw_engine_params_snapshot(sw_engine_params* params, sw_synth_params* out);

#endif /* SW_ENGINE_PARAMS_H */
