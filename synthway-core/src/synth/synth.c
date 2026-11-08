#include "synth/synth.h"
#include <math.h>
#include <string.h>

/* Per-sample smoothing of frequency and volume (exponential moving average),
   which hides parameter jumps between blocks */
#define SW_SMOOTHING 0.02f

void sw_synth_init(sw_synth* synth, float frequency_hz, float volume) {
    synth->current_frequency = frequency_hz;
    synth->current_volume = volume;
    synth->gate = false;
    sw_oscillator_reset(&synth->oscillator);
    sw_envelope_reset(&synth->envelope);
    for (uint32_t i = 0; i < SYNTHWAY_MAX_PARTIALS; ++i) {
        sw_oscillator_reset(&synth->partials[i].oscillator);
        sw_envelope_reset(&synth->partials[i].envelope);
    }
}

/* Starts an envelope on a gate edge, or when the gate is held and the
   envelope is silent (a partial added during a note, or a switch between the
   single oscillator and a timbre). Returns true when it starts from silence. */
static bool sw_synth_gate(sw_envelope* envelope, const sw_envelope_steps* steps, bool gate, bool opened, bool closed) {
    if (closed) {
        sw_envelope_release(envelope, steps);
    } else if (opened || (gate && !sw_envelope_is_active(envelope))) {
        const bool from_silence = !sw_envelope_is_active(envelope);
        sw_envelope_trigger(envelope);
        return from_silence;
    }
    return false;
}

/* The single oscillator: one waveform, one envelope */
static void sw_synth_render_oscillator(
    sw_synth* synth,
    const sw_synth_params* params,
    const sw_envelope_steps* steps,
    float rate,
    uint32_t channels,
    float* out,
    uint32_t frame_count
) {
    for (uint32_t frame = 0; frame < frame_count; ++frame) {
        synth->current_frequency += (params->frequency_hz - synth->current_frequency) * SW_SMOOTHING;
        synth->current_volume += (params->volume - synth->current_volume) * SW_SMOOTHING;
        const float level = sw_envelope_next(&synth->envelope, steps);

        float sample = 0.0f;
        if (sw_envelope_is_active(&synth->envelope) && synth->current_volume > 0.0001f) {
            sample = sw_oscillator_sample(&synth->oscillator, params->waveform);
            sample *= synth->current_volume * level;
            sw_oscillator_advance(&synth->oscillator, synth->current_frequency, rate);
        }

        for (uint32_t ch = 0; ch < channels; ++ch) {
            *out++ = sample;
        }
    }
}

/* The timbre: the sum of its partials, each at ratio × the note's frequency */
static void sw_synth_render_timbre(
    sw_synth* synth,
    const sw_synth_params* params,
    const sw_envelope_steps* steps,
    float rate,
    uint32_t channels,
    float* out,
    uint32_t frame_count
) {
    const synthway_timbre_t* timbre = params->timbre;

    for (uint32_t frame = 0; frame < frame_count; ++frame) {
        synth->current_frequency += (params->frequency_hz - synth->current_frequency) * SW_SMOOTHING;
        synth->current_volume += (params->volume - synth->current_volume) * SW_SMOOTHING;

        float sum = 0.0f;
        for (uint32_t i = 0; i < timbre->partial_count; ++i) {
            sw_synth_partial* state = &synth->partials[i];
            const synthway_partial_t* partial = &timbre->partials[i];
            const float level = sw_envelope_next(&state->envelope, &steps[i]);
            if (sw_envelope_is_active(&state->envelope)) {
                sum += sw_oscillator_sample(&state->oscillator, partial->waveform) * partial->amplitude * level;
                sw_oscillator_advance(&state->oscillator, synth->current_frequency * partial->ratio, rate);
            }
        }

        const float sample = sum * synth->current_volume;
        for (uint32_t ch = 0; ch < channels; ++ch) {
            *out++ = sample;
        }
    }
}

static float sw_filter_process(float input, sw_filter_state* state,
    float b0, float b1, float b2, float a1, float a2) {
    const float output = b0 * input + b1 * state->x1 + b2 * state->x2
        - a1 * state->y1 - a2 * state->y2;
    state->x2 = state->x1;
    state->x1 = input;
    state->y2 = state->y1;
    state->y1 = output;
    return output;
}

void sw_synth_render(
    sw_synth* synth,
    const sw_synth_params* params,
    uint32_t sample_rate,
    uint32_t channels,
    float* out,
    uint32_t frame_count
) {
    float* const block = out;
    const float rate = (float)sample_rate;
    const sw_envelope_steps steps = sw_envelope_steps_for(&params->envelope, rate);
    sw_envelope_steps partial_steps[SYNTHWAY_MAX_PARTIALS];
    const uint32_t partial_count = params->timbre ? params->timbre->partial_count : 0;

    /* Gate edges, seen once per block like the other parameters */
    const bool opened = params->gate && !synth->gate;
    const bool closed = !params->gate && synth->gate;
    synth->gate = params->gate;

    /* The source that does not play stays silent, so that switching to it
       never brings back an old note */
    if (params->timbre) {
        sw_envelope_reset(&synth->envelope);
    } else {
        sw_synth_gate(&synth->envelope, &steps, params->gate, opened, closed);
    }

    for (uint32_t i = 0; i < SYNTHWAY_MAX_PARTIALS; ++i) {
        sw_synth_partial* state = &synth->partials[i];
        if (i >= partial_count) {
            sw_envelope_reset(&state->envelope); /* removed partial: silent at once */
            continue;
        }
        partial_steps[i] = sw_envelope_steps_for(&params->timbre->partials[i].envelope, rate);
        /* A partial that starts from silence starts at phase 0, so that a
           timbre always begins with the same waveform */
        if (sw_synth_gate(&state->envelope, &partial_steps[i], params->gate, opened, closed)) {
            sw_oscillator_reset(&state->oscillator);
        }
    }

    if (params->timbre) {
        sw_synth_render_timbre(synth, params, partial_steps, rate, channels, out, frame_count);
    } else {
        sw_synth_render_oscillator(synth, params, &steps, rate, channels, out, frame_count);
    }

    /* Bypass the fully open band exactly, preserving the engine's default sound. */
    if (params->filter_low_cutoff_hz <= 20.0f && params->filter_high_cutoff_hz >= 20000.0f
        && params->filter_resonance == 0.0f) {
        memset(&synth->high_pass, 0, sizeof(synth->high_pass));
        memset(&synth->low_pass, 0, sizeof(synth->low_pass));
        return;
    }

    /* Resonant RBJ high-pass and low-pass sections form a band-pass. */
    const float q = 0.70710678f + params->filter_resonance * 9.29289322f;
    const bool high_pass_enabled = params->filter_low_cutoff_hz > 20.0f;
    const bool low_pass_enabled = params->filter_high_cutoff_hz < 20000.0f;
    float hp_b0 = 1.0f, hp_b1 = 0.0f, hp_b2 = 0.0f, hp_a1 = 0.0f, hp_a2 = 0.0f;
    float lp_b0 = 1.0f, lp_b1 = 0.0f, lp_b2 = 0.0f, lp_a1 = 0.0f, lp_a2 = 0.0f;
    if (high_pass_enabled) {
        float cutoff = fminf(params->filter_low_cutoff_hz, rate * 0.49f);
        const float omega = 6.28318530718f * cutoff / rate;
        const float cosine = cosf(omega), alpha = sinf(omega) / (2.0f * q);
        const float a0 = 1.0f + alpha;
        hp_b0 = ((1.0f + cosine) * 0.5f) / a0;
        hp_b1 = -(1.0f + cosine) / a0;
        hp_b2 = hp_b0;
        hp_a1 = (-2.0f * cosine) / a0;
        hp_a2 = (1.0f - alpha) / a0;
    } else {
        memset(&synth->high_pass, 0, sizeof(synth->high_pass));
    }
    if (low_pass_enabled) {
        float cutoff = fminf(params->filter_high_cutoff_hz, rate * 0.49f);
        const float omega = 6.28318530718f * cutoff / rate;
        const float cosine = cosf(omega), alpha = sinf(omega) / (2.0f * q);
        const float a0 = 1.0f + alpha;
        lp_b0 = ((1.0f - cosine) * 0.5f) / a0;
        lp_b1 = (1.0f - cosine) / a0;
        lp_b2 = lp_b0;
        lp_a1 = (-2.0f * cosine) / a0;
        lp_a2 = (1.0f - alpha) / a0;
    } else {
        memset(&synth->low_pass, 0, sizeof(synth->low_pass));
    }
    /* The synthesizer source is mono duplicated to all channels, so filter once per frame. */
    for (uint32_t frame = 0; frame < frame_count; ++frame) {
        float output = block[frame * channels];
        if (high_pass_enabled) output = sw_filter_process(output, &synth->high_pass, hp_b0, hp_b1, hp_b2, hp_a1, hp_a2);
        if (low_pass_enabled) output = sw_filter_process(output, &synth->low_pass, lp_b0, lp_b1, lp_b2, lp_a1, lp_a2);
        for (uint32_t ch = 0; ch < channels; ++ch) block[frame * channels + ch] = output;
    }
}
