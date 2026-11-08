#include "engine/engine_internal.h"

#define MAX_ENVELOPE_SECONDS 10.0f
#define MAX_PARTIAL_RATIO 1000.0f

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

static void sw_timbre_lock(sw_timbre_exchange* exchange) {
    while (atomic_flag_test_and_set_explicit(&exchange->writer_lock, memory_order_acquire)) {
        /* Held by another API thread for the time of one copy: spin */
    }
}

static void sw_timbre_unlock(sw_timbre_exchange* exchange) {
    atomic_flag_clear_explicit(&exchange->writer_lock, memory_order_release);
}

static void sw_timbre_write(sw_timbre_exchange* exchange, const synthway_timbre_t* timbre) {
    sw_timbre_lock(exchange);
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
    sw_timbre_unlock(exchange);
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

void sw_engine_params_init(sw_engine_params* params) {
    atomic_init(&params->target_frequency, SW_DEFAULT_FREQUENCY);
    atomic_init(&params->target_volume, SW_DEFAULT_VOLUME);
    atomic_init(&params->waveform, SYNTHWAY_WAVEFORM_SINE);
    atomic_init(&params->tone_enabled, true);
    atomic_init(&params->env_attack, 0.005f);   /* Short enough to feel instant, long enough not to click */
    atomic_init(&params->env_decay, 0.0f);
    atomic_init(&params->env_sustain, 1.0f);
    atomic_init(&params->env_release, 0.01f);
    atomic_init(&params->filter_low_cutoff, 20.0f);
    atomic_init(&params->filter_high_cutoff, 20000.0f);
    atomic_init(&params->filter_resonance, 0.0f);
    atomic_init(&params->reverb_mix, 0.0f);
    atomic_init(&params->unison_voices, 1u);
    atomic_init(&params->unison_detune_cents, 0.0f);
    atomic_init(&params->unison_spread, 0.0f);
    sw_timbre_exchange_init(&params->timbre);
}

void sw_engine_params_snapshot(sw_engine_params* params, sw_synth_params* out) {
    out->timbre = sw_timbre_read(&params->timbre);
    out->frequency_hz = atomic_load_explicit(&params->target_frequency, memory_order_relaxed);
    out->volume = atomic_load_explicit(&params->target_volume, memory_order_relaxed);
    out->gate = atomic_load_explicit(&params->tone_enabled, memory_order_relaxed);
    out->waveform = atomic_load_explicit(&params->waveform, memory_order_relaxed);
    out->envelope.attack_s = atomic_load_explicit(&params->env_attack, memory_order_relaxed);
    out->envelope.decay_s = atomic_load_explicit(&params->env_decay, memory_order_relaxed);
    out->envelope.sustain_level = atomic_load_explicit(&params->env_sustain, memory_order_relaxed);
    out->envelope.release_s = atomic_load_explicit(&params->env_release, memory_order_relaxed);
    out->envelope.curve = SYNTHWAY_ENVELOPE_LINEAR; /* the single oscillator's envelope is always linear */
    out->envelope.attack_curve = SYNTHWAY_ATTACK_LINEAR;
    out->envelope.release_curve = SYNTHWAY_ENVELOPE_LINEAR;
    out->filter_low_cutoff_hz = atomic_load_explicit(&params->filter_low_cutoff, memory_order_relaxed);
    out->filter_high_cutoff_hz = atomic_load_explicit(&params->filter_high_cutoff, memory_order_relaxed);
    out->filter_resonance = atomic_load_explicit(&params->filter_resonance, memory_order_relaxed);
    out->reverb_mix = atomic_load_explicit(&params->reverb_mix, memory_order_relaxed);
    out->unison_voices = atomic_load_explicit(&params->unison_voices, memory_order_relaxed);
    out->unison_detune_cents = atomic_load_explicit(&params->unison_detune_cents, memory_order_relaxed);
    out->unison_spread = atomic_load_explicit(&params->unison_spread, memory_order_relaxed);
}

SYNTHWAY_API synthway_result_t synthway_engine_set_filter(synthway_engine_t* engine, float low_cutoff_hz, float high_cutoff_hz, float resonance) {
    if (!engine || !(low_cutoff_hz >= 20.0f && low_cutoff_hz < high_cutoff_hz && high_cutoff_hz <= 20000.0f)
        || !(resonance >= 0.0f && resonance <= 1.0f)) return SYNTHWAY_INVALID_PARAM;
    atomic_store_explicit(&engine->params.filter_low_cutoff, low_cutoff_hz, memory_order_relaxed);
    atomic_store_explicit(&engine->params.filter_high_cutoff, high_cutoff_hz, memory_order_relaxed);
    atomic_store_explicit(&engine->params.filter_resonance, resonance, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_get_filter(const synthway_engine_t* engine, float* out_low_cutoff_hz, float* out_high_cutoff_hz, float* out_resonance) {
    if (!engine || !out_low_cutoff_hz || !out_high_cutoff_hz || !out_resonance) return SYNTHWAY_INVALID_PARAM;
    *out_low_cutoff_hz = atomic_load_explicit((_Atomic float*)&engine->params.filter_low_cutoff, memory_order_relaxed);
    *out_high_cutoff_hz = atomic_load_explicit((_Atomic float*)&engine->params.filter_high_cutoff, memory_order_relaxed);
    *out_resonance = atomic_load_explicit((_Atomic float*)&engine->params.filter_resonance, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_set_reverb(synthway_engine_t* engine, float mix) {
    if (!engine || !(mix >= 0.0f && mix <= 1.0f)) {
        return SYNTHWAY_INVALID_PARAM;
    }
    atomic_store_explicit(&engine->params.reverb_mix, mix, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API float synthway_engine_get_reverb(const synthway_engine_t* engine) {
    return engine ? atomic_load_explicit((_Atomic float*)&engine->params.reverb_mix, memory_order_relaxed) : 0.0f;
}

SYNTHWAY_API synthway_result_t synthway_engine_set_unison(synthway_engine_t* engine, uint32_t voices, float detune_cents, float spread) {
    if (!engine || voices < 1 || voices > SYNTHWAY_MAX_UNISON_VOICES
        || !(detune_cents >= 0.0f && detune_cents <= SYNTHWAY_MAX_UNISON_DETUNE_CENTS) /* also false for NaN */
        || !(spread >= 0.0f && spread <= 1.0f)) {
        return SYNTHWAY_INVALID_PARAM;
    }
    atomic_store_explicit(&engine->params.unison_voices, voices, memory_order_relaxed);
    atomic_store_explicit(&engine->params.unison_detune_cents, detune_cents, memory_order_relaxed);
    atomic_store_explicit(&engine->params.unison_spread, spread, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_get_unison(const synthway_engine_t* engine, uint32_t* out_voices, float* out_detune_cents, float* out_spread) {
    if (!engine || !out_voices || !out_detune_cents || !out_spread) return SYNTHWAY_INVALID_PARAM;
    *out_voices = atomic_load_explicit((_Atomic uint32_t*)&engine->params.unison_voices, memory_order_relaxed);
    *out_detune_cents = atomic_load_explicit((_Atomic float*)&engine->params.unison_detune_cents, memory_order_relaxed);
    *out_spread = atomic_load_explicit((_Atomic float*)&engine->params.unison_spread, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_set_frequency(synthway_engine_t* engine, float frequency_hz) {
    if (!engine || frequency_hz <= 0.0f || frequency_hz > 24000.0f) {
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
    atomic_store_explicit(&engine->params.waveform, waveform, memory_order_relaxed);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_waveform_t synthway_engine_get_waveform(const synthway_engine_t* engine) {
    return engine ? atomic_load_explicit((_Atomic synthway_waveform_t*)&engine->params.waveform, memory_order_relaxed) : SYNTHWAY_WAVEFORM_SINE;
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

static bool sw_valid_seconds(float seconds) {
    return seconds >= 0.0f && seconds <= MAX_ENVELOPE_SECONDS; /* also false for NaN */
}

static bool sw_valid_envelope(float attack_s, float decay_s, float sustain_level, float release_s) {
    return sw_valid_seconds(attack_s)
        && sw_valid_seconds(decay_s)
        && sw_valid_seconds(release_s)
        && sustain_level >= 0.0f && sustain_level <= 1.0f;
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
    atomic_store_explicit(&engine->params.env_attack, attack_s, memory_order_relaxed);
    atomic_store_explicit(&engine->params.env_decay, decay_s, memory_order_relaxed);
    atomic_store_explicit(&engine->params.env_sustain, sustain_level, memory_order_relaxed);
    atomic_store_explicit(&engine->params.env_release, release_s, memory_order_relaxed);
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
    *out_attack_s = atomic_load_explicit((_Atomic float*)&engine->params.env_attack, memory_order_relaxed);
    *out_decay_s = atomic_load_explicit((_Atomic float*)&engine->params.env_decay, memory_order_relaxed);
    *out_sustain_level = atomic_load_explicit((_Atomic float*)&engine->params.env_sustain, memory_order_relaxed);
    *out_release_s = atomic_load_explicit((_Atomic float*)&engine->params.env_release, memory_order_relaxed);
    return SYNTHWAY_OK;
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

SYNTHWAY_API synthway_result_t synthway_engine_set_timbre(
    synthway_engine_t* engine,
    const synthway_timbre_t* timbre
) {
    if (!engine) {
        return SYNTHWAY_INVALID_PARAM;
    }
    if (timbre) {
        if (timbre->partial_count > SYNTHWAY_MAX_PARTIALS) {
            return SYNTHWAY_INVALID_PARAM;
        }
        for (uint32_t i = 0; i < timbre->partial_count; ++i) {
            if (!sw_valid_partial(&timbre->partials[i])) {
                return SYNTHWAY_INVALID_PARAM;
            }
        }
    }
    sw_timbre_write(&engine->params.timbre, timbre);
    return SYNTHWAY_OK;
}

SYNTHWAY_API synthway_result_t synthway_engine_get_timbre(
    const synthway_engine_t* engine,
    synthway_timbre_t* out_timbre
) {
    if (!engine || !out_timbre) {
        return SYNTHWAY_INVALID_PARAM;
    }
    /* Cast away const for the writer lock, as for the atomic loads above */
    sw_timbre_exchange* exchange = (sw_timbre_exchange*)&engine->params.timbre;
    sw_timbre_lock(exchange);
    *out_timbre = exchange->latest.timbre;
    sw_timbre_unlock(exchange);
    return SYNTHWAY_OK;
}

SYNTHWAY_API bool synthway_engine_has_timbre(const synthway_engine_t* engine) {
    if (!engine) {
        return false;
    }
    sw_timbre_exchange* exchange = (sw_timbre_exchange*)&engine->params.timbre;
    sw_timbre_lock(exchange);
    const bool enabled = exchange->latest.enabled;
    sw_timbre_unlock(exchange);
    return enabled;
}

SYNTHWAY_API uint32_t synthway_get_max_partials(void) {
    return SYNTHWAY_MAX_PARTIALS;
}
