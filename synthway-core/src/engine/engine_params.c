#include "engine/engine_internal.h"

#define MAX_ENVELOPE_SECONDS 10.0f
#define MAX_PARTIAL_RATIO 1000.0f
#define MAX_FREQUENCY 24000.0f

/* Set in sw_timbre_exchange.shared when its slot holds a timbre the reader has not taken */
#define SW_TIMBRE_FRESH 4u

static void sw_timbre_exchange_init(sw_timbre_exchange* exchange) {
    exchange->writer_slot = 0;
    atomic_init(&exchange->shared, 1u);
    exchange->reader_slot = 2;
    for (unsigned i = 0; i < 3; ++i) {
        exchange->slots[i].enabled = false;
        exchange->slots[i].timbre.partial_count = 0;
    }
    exchange->latest = exchange->slots[0];
    atomic_flag_clear(&exchange->writer_lock);
}

static void sw_spin_lock(atomic_flag* lock) {
    while (atomic_flag_test_and_set_explicit(lock, memory_order_acquire)) {
        /* Held by another API thread for the time of one copy: spin */
    }
}

static void sw_spin_unlock(atomic_flag* lock) {
    atomic_flag_clear_explicit(lock, memory_order_release);
}

static void sw_timbre_write(sw_timbre_exchange* exchange, const synthway_timbre_t* timbre) {
    sw_spin_lock(&exchange->writer_lock);
    sw_timbre_slot* slot = &exchange->slots[exchange->writer_slot];
    slot->enabled = timbre != NULL;
    slot->timbre.partial_count = 0;
    if (timbre) {
        slot->timbre = *timbre;
    }
    exchange->latest = *slot;
    /* Publishes the slot (release) and takes back the previous shared one (acquire) */
    exchange->writer_slot = atomic_exchange_explicit(
        &exchange->shared, exchange->writer_slot | SW_TIMBRE_FRESH, memory_order_acq_rel) & ~SW_TIMBRE_FRESH;
    sw_spin_unlock(&exchange->writer_lock);
}

/* Audio thread: takes the newest timbre if there is one, never waits */
static const synthway_timbre_t* sw_timbre_read(sw_timbre_exchange* exchange) {
    if (atomic_load_explicit(&exchange->shared, memory_order_relaxed) & SW_TIMBRE_FRESH) {
        exchange->reader_slot = atomic_exchange_explicit(
            &exchange->shared, exchange->reader_slot, memory_order_acq_rel) & ~SW_TIMBRE_FRESH;
    }
    const sw_timbre_slot* slot = &exchange->slots[exchange->reader_slot];
    return slot->enabled ? &slot->timbre : NULL;
}

/* The last timbre written (enabled false: none), for the getters */
static sw_timbre_slot sw_timbre_latest(const sw_timbre_exchange* exchange) {
    /* Cast away const for the writer lock, as for the atomic loads below */
    sw_timbre_exchange* shared = (sw_timbre_exchange*)exchange;
    sw_spin_lock(&shared->writer_lock);
    const sw_timbre_slot latest = shared->latest;
    sw_spin_unlock(&shared->writer_lock);
    return latest;
}

static void sw_instrument_params_init(sw_instrument_params* instrument) {
    atomic_init(&instrument->waveform, SYNTHWAY_WAVEFORM_SINE);
    atomic_init(&instrument->env_attack, 0.005f);   /* Short enough to feel instant, long enough not to click */
    atomic_init(&instrument->env_decay, 0.0f);
    atomic_init(&instrument->env_sustain, 1.0f);
    atomic_init(&instrument->env_release, 0.01f);
    atomic_init(&instrument->filter_low_cutoff, 20.0f);
    atomic_init(&instrument->filter_high_cutoff, 20000.0f);
    atomic_init(&instrument->filter_resonance, 0.0f);
    atomic_init(&instrument->reverb_mix, 0.0f);
    atomic_init(&instrument->unison_voices, 1u);
    atomic_init(&instrument->unison_detune_cents, 0.0f);
    atomic_init(&instrument->unison_spread, 0.0f);
    sw_timbre_exchange_init(&instrument->timbre);
}

void sw_engine_params_init(sw_engine_params* params) {
    atomic_init(&params->target_frequency, SW_DEFAULT_FREQUENCY);
    atomic_init(&params->target_volume, SW_DEFAULT_VOLUME);
    atomic_init(&params->tone_enabled, true);
    for (uint32_t i = 0; i < SYNTHWAY_MAX_INSTRUMENTS; ++i) {
        sw_instrument_params_init(&params->instruments[i]);
    }
    atomic_init(&params->notes.head, 0u);
    atomic_init(&params->notes.tail, 0u);
    atomic_flag_clear(&params->notes.writer_lock);
    atomic_init(&params->sounding_notes, 0u);
}

static void sw_instrument_snapshot(sw_instrument_params* instrument, sw_instrument_sound* out) {
    out->timbre = sw_timbre_read(&instrument->timbre);
    out->waveform = atomic_load_explicit(&instrument->waveform, memory_order_relaxed);
    out->envelope.attack_s = atomic_load_explicit(&instrument->env_attack, memory_order_relaxed);
    out->envelope.decay_s = atomic_load_explicit(&instrument->env_decay, memory_order_relaxed);
    out->envelope.sustain_level = atomic_load_explicit(&instrument->env_sustain, memory_order_relaxed);
    out->envelope.release_s = atomic_load_explicit(&instrument->env_release, memory_order_relaxed);
    out->envelope.curve = SYNTHWAY_ENVELOPE_LINEAR; /* the single oscillator's envelope is always linear */
    out->envelope.attack_curve = SYNTHWAY_ATTACK_LINEAR;
    out->envelope.release_curve = SYNTHWAY_ENVELOPE_LINEAR;
    out->filter_low_cutoff_hz = atomic_load_explicit(&instrument->filter_low_cutoff, memory_order_relaxed);
    out->filter_high_cutoff_hz = atomic_load_explicit(&instrument->filter_high_cutoff, memory_order_relaxed);
    out->filter_resonance = atomic_load_explicit(&instrument->filter_resonance, memory_order_relaxed);
    out->reverb_mix = atomic_load_explicit(&instrument->reverb_mix, memory_order_relaxed);
    out->unison_voices = atomic_load_explicit(&instrument->unison_voices, memory_order_relaxed);
    out->unison_detune_cents = atomic_load_explicit(&instrument->unison_detune_cents, memory_order_relaxed);
    out->unison_spread = atomic_load_explicit(&instrument->unison_spread, memory_order_relaxed);
}

void sw_engine_params_snapshot(sw_engine_params* params, sw_synth_params* out) {
    out->frequency_hz = atomic_load_explicit(&params->target_frequency, memory_order_relaxed);
    out->volume = atomic_load_explicit(&params->target_volume, memory_order_relaxed);
    out->gate = atomic_load_explicit(&params->tone_enabled, memory_order_relaxed);
    for (uint32_t i = 0; i < SYNTHWAY_MAX_INSTRUMENTS; ++i) {
        sw_instrument_snapshot(&params->instruments[i], &out->instruments[i]);
    }
}

void sw_engine_params_take_notes(sw_engine_params* params, sw_synth* synth) {
    sw_note_queue* queue = &params->notes;
    const uint32_t head = atomic_load_explicit(&queue->head, memory_order_acquire);
    uint32_t tail = atomic_load_explicit(&queue->tail, memory_order_relaxed);
    for (; tail != head; ++tail) {
        const sw_note_event* event = &queue->events[tail & (SW_NOTE_QUEUE_CAPACITY - 1u)];
        switch (event->type) {
            case SW_NOTE_EVENT_ON:
                sw_synth_note_on(synth, event->note_id, event->instrument, event->frequency_hz, event->volume);
                break;
            case SW_NOTE_EVENT_OFF:
                sw_synth_note_off(synth, event->note_id);
                break;
            case SW_NOTE_EVENT_ALL_OFF:
                sw_synth_all_notes_off(synth);
                break;
            case SW_NOTE_EVENT_GLIDE:
                sw_synth_note_glide(synth, event->note_id, event->frequency_hz, event->seconds);
                break;
            case SW_NOTE_EVENT_AUTOMATE:
                sw_synth_automate(synth, event->instrument, event->param, event->side, event->value, event->seconds);
                break;
            case SW_NOTE_EVENT_CLEAR_AUTOMATION:
                sw_synth_clear_automation(synth, event->instrument);
                break;
        }
    }
    /* The slots read are free again (release: after they were read) */
    atomic_store_explicit(&queue->tail, tail, memory_order_release);
}

/* Appends an event, or returns false when the queue is full */
static bool sw_note_queue_push(sw_note_queue* queue, const sw_note_event* event) {
    sw_spin_lock(&queue->writer_lock);
    const uint32_t head = atomic_load_explicit(&queue->head, memory_order_relaxed);
    const uint32_t tail = atomic_load_explicit(&queue->tail, memory_order_acquire);
    const bool room = head - tail < SW_NOTE_QUEUE_CAPACITY;
    if (room) {
        queue->events[head & (SW_NOTE_QUEUE_CAPACITY - 1u)] = *event;
        atomic_store_explicit(&queue->head, head + 1u, memory_order_release);
    }
    sw_spin_unlock(&queue->writer_lock);
    return room;
}

/* ---------------------------------------------------------------------------
   Validation, shared by the setters of instrument 0 and set_instrument
   --------------------------------------------------------------------------- */

static bool sw_valid_seconds(float seconds) {
    return seconds >= 0.0f && seconds <= MAX_ENVELOPE_SECONDS; /* also false for NaN */
}

static bool sw_valid_envelope(float attack_s, float decay_s, float sustain_level, float release_s) {
    return sw_valid_seconds(attack_s)
        && sw_valid_seconds(decay_s)
        && sw_valid_seconds(release_s)
        && sustain_level >= 0.0f && sustain_level <= 1.0f;
}

static bool sw_valid_filter(float low_cutoff_hz, float high_cutoff_hz, float resonance) {
    return low_cutoff_hz >= 20.0f && low_cutoff_hz < high_cutoff_hz && high_cutoff_hz <= 20000.0f
        && resonance >= 0.0f && resonance <= 1.0f;
}

static bool sw_valid_unison(uint32_t voices, float detune_cents, float spread) {
    return voices >= 1 && voices <= SYNTHWAY_MAX_UNISON_VOICES
        && detune_cents >= 0.0f && detune_cents <= SYNTHWAY_MAX_UNISON_DETUNE_CENTS /* also false for NaN */
        && spread >= 0.0f && spread <= 1.0f;
}

static bool sw_valid_partial(const synthway_partial_t* partial) {
    const synthway_envelope_t* envelope = &partial->envelope;
    return partial->ratio > 0.0f && partial->ratio <= MAX_PARTIAL_RATIO /* also false for NaN */
        && partial->amplitude >= 0.0f && partial->amplitude <= 1.0f
        && (unsigned)partial->waveform <= SYNTHWAY_WAVEFORM_SAWTOOTH /* negative values wrap above */
        && sw_valid_envelope(envelope->attack_s, envelope->decay_s, envelope->sustain_level, envelope->release_s)
        && (unsigned)envelope->curve <= SYNTHWAY_ENVELOPE_EXPONENTIAL
        && (unsigned)envelope->attack_curve <= SYNTHWAY_ATTACK_CONVEX
        && (unsigned)envelope->release_curve <= SYNTHWAY_ENVELOPE_EXPONENTIAL;
}

static bool sw_valid_timbre(const synthway_timbre_t* timbre) {
    if (timbre->partial_count > SYNTHWAY_MAX_PARTIALS) {
        return false;
    }
    for (uint32_t i = 0; i < timbre->partial_count; ++i) {
        if (!sw_valid_partial(&timbre->partials[i])) {
            return false;
        }
    }
    return true;
}

/* The single-note API's setters below act on instrument 0 */
static sw_instrument_params* sw_first_instrument(synthway_engine_t* engine) {
    return &engine->params.instruments[0];
}

static const sw_instrument_params* sw_first_instrument_const(const synthway_engine_t* engine) {
    return &engine->params.instruments[0];
}

/* ---------------------------------------------------------------------------
   Instrument 0
   --------------------------------------------------------------------------- */

static void sw_store_filter(sw_instrument_params* instrument, float low_cutoff_hz, float high_cutoff_hz, float resonance) {
    atomic_store_explicit(&instrument->filter_low_cutoff, low_cutoff_hz, memory_order_relaxed);
    atomic_store_explicit(&instrument->filter_high_cutoff, high_cutoff_hz, memory_order_relaxed);
    atomic_store_explicit(&instrument->filter_resonance, resonance, memory_order_relaxed);
}

SYNTHWAY_API synthway_result_t synthway_engine_set_filter(synthway_engine_t* engine, float low_cutoff_hz, float high_cutoff_hz, float resonance) {
    if (!engine || !sw_valid_filter(low_cutoff_hz, high_cutoff_hz, resonance)) return SYNTHWAY_INVALID_PARAM;
    sw_store_filter(sw_first_instrument(engine), low_cutoff_hz, high_cutoff_hz, resonance);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_get_filter(const synthway_engine_t* engine, float* out_low_cutoff_hz, float* out_high_cutoff_hz, float* out_resonance) {
    if (!engine || !out_low_cutoff_hz || !out_high_cutoff_hz || !out_resonance) return SYNTHWAY_INVALID_PARAM;
    const sw_instrument_params* instrument = sw_first_instrument_const(engine);
    *out_low_cutoff_hz = atomic_load_explicit((_Atomic float*)&instrument->filter_low_cutoff, memory_order_relaxed);
    *out_high_cutoff_hz = atomic_load_explicit((_Atomic float*)&instrument->filter_high_cutoff, memory_order_relaxed);
    *out_resonance = atomic_load_explicit((_Atomic float*)&instrument->filter_resonance, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_set_reverb(synthway_engine_t* engine, float mix) {
    if (!engine || !(mix >= 0.0f && mix <= 1.0f)) {
        return SYNTHWAY_INVALID_PARAM;
    }
    atomic_store_explicit(&sw_first_instrument(engine)->reverb_mix, mix, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API float synthway_engine_get_reverb(const synthway_engine_t* engine) {
    return engine ? atomic_load_explicit((_Atomic float*)&sw_first_instrument_const(engine)->reverb_mix, memory_order_relaxed) : 0.0f;
}

static void sw_store_unison(sw_instrument_params* instrument, uint32_t voices, float detune_cents, float spread) {
    atomic_store_explicit(&instrument->unison_voices, voices, memory_order_relaxed);
    atomic_store_explicit(&instrument->unison_detune_cents, detune_cents, memory_order_relaxed);
    atomic_store_explicit(&instrument->unison_spread, spread, memory_order_relaxed);
}

SYNTHWAY_API synthway_result_t synthway_engine_set_unison(synthway_engine_t* engine, uint32_t voices, float detune_cents, float spread) {
    if (!engine || !sw_valid_unison(voices, detune_cents, spread)) {
        return SYNTHWAY_INVALID_PARAM;
    }
    sw_store_unison(sw_first_instrument(engine), voices, detune_cents, spread);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_get_unison(const synthway_engine_t* engine, uint32_t* out_voices, float* out_detune_cents, float* out_spread) {
    if (!engine || !out_voices || !out_detune_cents || !out_spread) return SYNTHWAY_INVALID_PARAM;
    const sw_instrument_params* instrument = sw_first_instrument_const(engine);
    *out_voices = atomic_load_explicit((_Atomic uint32_t*)&instrument->unison_voices, memory_order_relaxed);
    *out_detune_cents = atomic_load_explicit((_Atomic float*)&instrument->unison_detune_cents, memory_order_relaxed);
    *out_spread = atomic_load_explicit((_Atomic float*)&instrument->unison_spread, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_set_frequency(synthway_engine_t* engine, float frequency_hz) {
    if (!engine || frequency_hz <= 0.0f || frequency_hz > MAX_FREQUENCY) {
        return SYNTHWAY_INVALID_PARAM;
    }
    atomic_store_explicit(&engine->params.target_frequency, frequency_hz, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API float synthway_engine_get_frequency(const synthway_engine_t* engine) {
    /* Cast away const: atomic_load_explicit needs a pointer to _Atomic, but
       the load is logically const.  This is safe and standard practice. */
    return engine ? atomic_load_explicit((_Atomic float*)&engine->params.target_frequency, memory_order_relaxed) : 0.0f;
}

SYNTHWAY_API synthway_result_t synthway_engine_set_volume(synthway_engine_t* engine, float volume) {
    if (!engine || volume < 0.0f || volume > 1.0f) {
        return SYNTHWAY_INVALID_PARAM;
    }
    atomic_store_explicit(&engine->params.target_volume, volume, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API float synthway_engine_get_volume(const synthway_engine_t* engine) {
    return engine ? atomic_load_explicit((_Atomic float*)&engine->params.target_volume, memory_order_relaxed) : 0.0f;
}

SYNTHWAY_API synthway_result_t synthway_engine_set_waveform(synthway_engine_t* engine, synthway_waveform_t waveform) {
    if (!engine) {
        return SYNTHWAY_INVALID_PARAM;
    }
    atomic_store_explicit(&sw_first_instrument(engine)->waveform, waveform, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_waveform_t synthway_engine_get_waveform(const synthway_engine_t* engine) {
    return engine ? atomic_load_explicit((_Atomic synthway_waveform_t*)&sw_first_instrument_const(engine)->waveform, memory_order_relaxed) : SYNTHWAY_WAVEFORM_SINE;
}

SYNTHWAY_API synthway_result_t synthway_engine_set_tone_enabled(synthway_engine_t* engine, bool enabled) {
    if (!engine) {
        return SYNTHWAY_INVALID_PARAM;
    }
    atomic_store_explicit(&engine->params.tone_enabled, enabled, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API bool synthway_engine_is_tone_enabled(const synthway_engine_t* engine) {
    return engine ? atomic_load_explicit((_Atomic bool*)&engine->params.tone_enabled, memory_order_relaxed) : false;
}

static void sw_store_envelope(sw_instrument_params* instrument, float attack_s, float decay_s, float sustain_level, float release_s) {
    atomic_store_explicit(&instrument->env_attack, attack_s, memory_order_relaxed);
    atomic_store_explicit(&instrument->env_decay, decay_s, memory_order_relaxed);
    atomic_store_explicit(&instrument->env_sustain, sustain_level, memory_order_relaxed);
    atomic_store_explicit(&instrument->env_release, release_s, memory_order_relaxed);
}

SYNTHWAY_API synthway_result_t synthway_engine_set_envelope(
    synthway_engine_t* engine,
    float attack_s,
    float decay_s,
    float sustain_level,
    float release_s
) {
    if (!engine || !sw_valid_envelope(attack_s, decay_s, sustain_level, release_s)) {
        return SYNTHWAY_INVALID_PARAM;
    }
    sw_store_envelope(sw_first_instrument(engine), attack_s, decay_s, sustain_level, release_s);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_get_envelope(
    const synthway_engine_t* engine,
    float* out_attack_s,
    float* out_decay_s,
    float* out_sustain_level,
    float* out_release_s
) {
    if (!engine || !out_attack_s || !out_decay_s || !out_sustain_level || !out_release_s) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_instrument_params* instrument = sw_first_instrument_const(engine);
    *out_attack_s = atomic_load_explicit((_Atomic float*)&instrument->env_attack, memory_order_relaxed);
    *out_decay_s = atomic_load_explicit((_Atomic float*)&instrument->env_decay, memory_order_relaxed);
    *out_sustain_level = atomic_load_explicit((_Atomic float*)&instrument->env_sustain, memory_order_relaxed);
    *out_release_s = atomic_load_explicit((_Atomic float*)&instrument->env_release, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_set_timbre(
    synthway_engine_t* engine,
    const synthway_timbre_t* timbre
) {
    if (!engine || (timbre && !sw_valid_timbre(timbre))) {
        return SYNTHWAY_INVALID_PARAM;
    }
    sw_timbre_write(&sw_first_instrument(engine)->timbre, timbre);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_get_timbre(
    const synthway_engine_t* engine,
    synthway_timbre_t* out_timbre
) {
    if (!engine || !out_timbre) {
        return SYNTHWAY_INVALID_PARAM;
    }
    *out_timbre = sw_timbre_latest(&sw_first_instrument_const(engine)->timbre).timbre;
    return SYNTHWAY_OK;
}

SYNTHWAY_API bool synthway_engine_has_timbre(const synthway_engine_t* engine) {
    if (!engine) {
        return false;
    }
    return sw_timbre_latest(&sw_first_instrument_const(engine)->timbre).enabled;
}

SYNTHWAY_API uint32_t synthway_get_max_partials(void) {
    return SYNTHWAY_MAX_PARTIALS;
}

/* ---------------------------------------------------------------------------
   Polyphony
   --------------------------------------------------------------------------- */

SYNTHWAY_API synthway_result_t synthway_engine_set_instrument(
    synthway_engine_t* engine,
    uint32_t slot,
    const synthway_instrument_t* instrument
) {
    if (!engine || slot >= SYNTHWAY_MAX_INSTRUMENTS || !instrument) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const synthway_envelope_t* envelope = &instrument->envelope;
    if ((unsigned)instrument->waveform > SYNTHWAY_WAVEFORM_SAWTOOTH /* negative values wrap above */
        || !sw_valid_envelope(envelope->attack_s, envelope->decay_s, envelope->sustain_level, envelope->release_s)
        || !sw_valid_filter(instrument->filter_low_cutoff_hz, instrument->filter_high_cutoff_hz, instrument->filter_resonance)
        || !(instrument->reverb_mix >= 0.0f && instrument->reverb_mix <= 1.0f)
        || !sw_valid_unison(instrument->unison_voices, instrument->unison_detune_cents, instrument->unison_spread)
        || (instrument->has_timbre && !sw_valid_timbre(&instrument->timbre))) {
        return SYNTHWAY_INVALID_PARAM;
    }

    sw_instrument_params* target = &engine->params.instruments[slot];
    atomic_store_explicit(&target->waveform, instrument->waveform, memory_order_relaxed);
    sw_store_envelope(target, envelope->attack_s, envelope->decay_s, envelope->sustain_level, envelope->release_s);
    sw_store_filter(target, instrument->filter_low_cutoff_hz, instrument->filter_high_cutoff_hz, instrument->filter_resonance);
    atomic_store_explicit(&target->reverb_mix, instrument->reverb_mix, memory_order_relaxed);
    sw_store_unison(target, instrument->unison_voices, instrument->unison_detune_cents, instrument->unison_spread);
    sw_timbre_write(&target->timbre, instrument->has_timbre ? &instrument->timbre : NULL);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_get_instrument(
    const synthway_engine_t* engine,
    uint32_t slot,
    synthway_instrument_t* out_instrument
) {
    if (!engine || slot >= SYNTHWAY_MAX_INSTRUMENTS || !out_instrument) {
        return SYNTHWAY_INVALID_PARAM;
    }
    /* Cast away const: see synthway_engine_get_frequency */
    sw_instrument_params* source = (sw_instrument_params*)&engine->params.instruments[slot];
    const sw_timbre_slot timbre = sw_timbre_latest(&source->timbre);
    out_instrument->waveform = atomic_load_explicit(&source->waveform, memory_order_relaxed);
    out_instrument->envelope.attack_s = atomic_load_explicit(&source->env_attack, memory_order_relaxed);
    out_instrument->envelope.decay_s = atomic_load_explicit(&source->env_decay, memory_order_relaxed);
    out_instrument->envelope.sustain_level = atomic_load_explicit(&source->env_sustain, memory_order_relaxed);
    out_instrument->envelope.release_s = atomic_load_explicit(&source->env_release, memory_order_relaxed);
    out_instrument->envelope.curve = SYNTHWAY_ENVELOPE_LINEAR;
    out_instrument->envelope.attack_curve = SYNTHWAY_ATTACK_LINEAR;
    out_instrument->envelope.release_curve = SYNTHWAY_ENVELOPE_LINEAR;
    out_instrument->filter_low_cutoff_hz = atomic_load_explicit(&source->filter_low_cutoff, memory_order_relaxed);
    out_instrument->filter_high_cutoff_hz = atomic_load_explicit(&source->filter_high_cutoff, memory_order_relaxed);
    out_instrument->filter_resonance = atomic_load_explicit(&source->filter_resonance, memory_order_relaxed);
    out_instrument->reverb_mix = atomic_load_explicit(&source->reverb_mix, memory_order_relaxed);
    out_instrument->unison_voices = atomic_load_explicit(&source->unison_voices, memory_order_relaxed);
    out_instrument->unison_detune_cents = atomic_load_explicit(&source->unison_detune_cents, memory_order_relaxed);
    out_instrument->unison_spread = atomic_load_explicit(&source->unison_spread, memory_order_relaxed);
    out_instrument->has_timbre = timbre.enabled;
    out_instrument->timbre = timbre.timbre;
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_note_on(
    synthway_engine_t* engine,
    uint32_t note_id,
    uint32_t slot,
    float frequency_hz,
    float volume
) {
    if (!engine || slot >= SYNTHWAY_MAX_INSTRUMENTS
        || !(frequency_hz > 0.0f && frequency_hz <= MAX_FREQUENCY) /* also false for NaN */
        || !(volume >= 0.0f && volume <= 1.0f)) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_note_event event = { SW_NOTE_EVENT_ON, note_id, slot, frequency_hz, volume, 0.0f };
    return sw_note_queue_push(&engine->params.notes, &event) ? SYNTHWAY_OK : SYNTHWAY_ERROR;
}

SYNTHWAY_API synthway_result_t synthway_engine_note_glide(
    synthway_engine_t* engine,
    uint32_t note_id,
    float frequency_hz,
    float seconds
) {
    if (!engine
        || !(frequency_hz > 0.0f && frequency_hz <= MAX_FREQUENCY) /* also false for NaN */
        || !(seconds >= 0.0f && seconds <= SYNTHWAY_MAX_GLIDE_SECONDS)) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_note_event event = { SW_NOTE_EVENT_GLIDE, note_id, 0, frequency_hz, 0.0f, seconds };
    return sw_note_queue_push(&engine->params.notes, &event) ? SYNTHWAY_OK : SYNTHWAY_ERROR;
}

SYNTHWAY_API synthway_result_t synthway_engine_note_off(synthway_engine_t* engine, uint32_t note_id) {
    if (!engine) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_note_event event = { SW_NOTE_EVENT_OFF, note_id, 0, 0.0f, 0.0f, 0.0f };
    return sw_note_queue_push(&engine->params.notes, &event) ? SYNTHWAY_OK : SYNTHWAY_ERROR;
}

SYNTHWAY_API synthway_result_t synthway_engine_all_notes_off(synthway_engine_t* engine) {
    if (!engine) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_note_event event = { SW_NOTE_EVENT_ALL_OFF, 0, 0, 0.0f, 0.0f, 0.0f };
    return sw_note_queue_push(&engine->params.notes, &event) ? SYNTHWAY_OK : SYNTHWAY_ERROR;
}

/* ---------------------------------------------------------------------------
   Automation
   --------------------------------------------------------------------------- */

/* The values a ramp of param accepts */
static bool sw_valid_automation(synthway_automation_param_t param, synthway_side_t side, float value) {
    if ((unsigned)side > SYNTHWAY_SIDE_RIGHT) { /* negative values wrap above */
        return false;
    }
    switch (param) {
        case SYNTHWAY_AUTOMATION_GAIN:
        case SYNTHWAY_AUTOMATION_RESONANCE:
        case SYNTHWAY_AUTOMATION_REVERB:
            return value >= 0.0f && value <= 1.0f; /* also false for NaN */
        case SYNTHWAY_AUTOMATION_PAN:
            return side == SYNTHWAY_SIDE_BOTH && value >= -1.0f && value <= 1.0f;
        case SYNTHWAY_AUTOMATION_LOW_CUTOFF:
        case SYNTHWAY_AUTOMATION_HIGH_CUTOFF:
            return value >= 20.0f && value <= 20000.0f;
        case SYNTHWAY_AUTOMATION_DETUNE:
            return side == SYNTHWAY_SIDE_BOTH && value >= 0.0f && value <= SYNTHWAY_MAX_UNISON_DETUNE_CENTS;
        default:
            return false;
    }
}

SYNTHWAY_API synthway_result_t synthway_engine_automate(
    synthway_engine_t* engine,
    uint32_t slot,
    synthway_automation_param_t param,
    synthway_side_t side,
    float value,
    float seconds
) {
    if (!engine || slot >= SYNTHWAY_MAX_INSTRUMENTS
        || !sw_valid_automation(param, side, value)
        || !(seconds >= 0.0f && seconds <= SYNTHWAY_MAX_AUTOMATION_SECONDS)) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_note_event event = {
        SW_NOTE_EVENT_AUTOMATE, 0, slot, 0.0f, 0.0f, seconds, (uint32_t)param, (uint32_t)side, value
    };
    return sw_note_queue_push(&engine->params.notes, &event) ? SYNTHWAY_OK : SYNTHWAY_ERROR;
}

SYNTHWAY_API synthway_result_t synthway_engine_clear_automation(synthway_engine_t* engine, uint32_t slot) {
    if (!engine || slot > SYNTHWAY_MAX_INSTRUMENTS) {
        return SYNTHWAY_INVALID_PARAM;
    }
    const sw_note_event event = { SW_NOTE_EVENT_CLEAR_AUTOMATION, 0, slot, 0.0f, 0.0f, 0.0f, 0, 0, 0.0f };
    return sw_note_queue_push(&engine->params.notes, &event) ? SYNTHWAY_OK : SYNTHWAY_ERROR;
}

SYNTHWAY_API uint32_t synthway_engine_get_sounding_notes(const synthway_engine_t* engine) {
    return engine ? atomic_load_explicit((_Atomic uint32_t*)&engine->params.sounding_notes, memory_order_relaxed) : 0u;
}
