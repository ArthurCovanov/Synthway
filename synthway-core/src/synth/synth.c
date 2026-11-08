#include "synth/synth.h"
#include <math.h>
#include <string.h>

/* Per-sample smoothing of frequency and volume (exponential moving average),
   which hides parameter jumps between blocks */
#define SW_SMOOTHING 0.02f

#define SW_TWO_PI 6.28318530717958647692
/* Unison voice v starts at the point v × this share of the note's period
   (the golden ratio's fractional part): starting points as spread out as
   possible, whatever the number of voices, so that they never start in phase */
#define SW_UNISON_PHASE_STEP 0.61803398874989484820

void sw_synth_init(sw_synth* synth, float frequency_hz, float volume) {
    synth->current_frequency = frequency_hz;
    synth->current_volume = volume;
    synth->gate = false;
    sw_oscillator_reset(&synth->oscillator);
    sw_envelope_reset(&synth->envelope);
    for (uint32_t i = 0; i < SYNTHWAY_MAX_PARTIALS; ++i) {
        for (uint32_t v = 0; v < SYNTHWAY_MAX_UNISON_VOICES; ++v) {
            sw_oscillator_reset(&synth->partials[i].oscillators[v]);
        }
        sw_envelope_reset(&synth->partials[i].envelope);
    }
    sw_reverb_init(&synth->reverb);
}

/* A partial that starts from silence: voice 0 at phase 0, so that a timbre
   always begins with the same waveform; voice v as if started v × the golden
   ratio's fraction of the note's period earlier (each partial at ratio × that
   angle: the voice's waveform is the same, shifted in time) */
static void sw_synth_start_partial(sw_synth_partial* state, float ratio) {
    for (uint32_t v = 0; v < SYNTHWAY_MAX_UNISON_VOICES; ++v) {
        const double share = fmod(v * SW_UNISON_PHASE_STEP, 1.0);
        state->oscillators[v].phase = fmod(share * SW_TWO_PI * (double)ratio, SW_TWO_PI);
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
                sum += sw_oscillator_sample(&state->oscillators[0], partial->waveform) * partial->amplitude * level;
                sw_oscillator_advance(&state->oscillators[0], synth->current_frequency * partial->ratio, rate);
            }
        }

        const float sample = sum * synth->current_volume;
        for (uint32_t ch = 0; ch < channels; ++ch) {
            *out++ = sample;
        }
    }
}

/* The timbre in unison: each partial played by several detuned voices, placed
   alternately left and right. Left goes to even channels, right to odd ones,
   their mean to a single channel. */
static void sw_synth_render_unison(
    sw_synth* synth,
    const sw_synth_params* params,
    const sw_envelope_steps* steps,
    float rate,
    uint32_t channels,
    float* out,
    uint32_t frame_count
) {
    const synthway_timbre_t* timbre = params->timbre;
    const uint32_t voices = params->unison_voices > SYNTHWAY_MAX_UNISON_VOICES ? SYNTHWAY_MAX_UNISON_VOICES : params->unison_voices;

    /* Voice v sits at x from -1 to 1, evenly. It is detuned by |x|^1.5 × the
       detune (with the sign of x): closer together near the note, so that the
       gaps differ and the voices never all come back in phase at regular
       intervals, which would pulse. It is panned by ± x × the spread (the sign
       alternates, so that each side gets low and high voices); panning keeps
       the middle at full level on both sides. */
    float detune[SYNTHWAY_MAX_UNISON_VOICES], left[SYNTHWAY_MAX_UNISON_VOICES], right[SYNTHWAY_MAX_UNISON_VOICES];
    const float scale = (float)(1.0 / sqrt((double)voices)); /* not sqrtf: see sw_envelope_next */
    for (uint32_t v = 0; v < voices; ++v) {
        const float x = 2.0f * (float)v / (float)(voices - 1) - 1.0f;
        const float pan = params->unison_spread * ((v & 1) ? -x : x);
        detune[v] = exp2f(params->unison_detune_cents * copysignf(powf(fabsf(x), 1.5f), x) / 1200.0f);
        left[v] = fminf(1.0f, 1.0f - pan) * scale;
        right[v] = fminf(1.0f, 1.0f + pan) * scale;
    }

    for (uint32_t frame = 0; frame < frame_count; ++frame) {
        synth->current_frequency += (params->frequency_hz - synth->current_frequency) * SW_SMOOTHING;
        synth->current_volume += (params->volume - synth->current_volume) * SW_SMOOTHING;

        float sum_left = 0.0f, sum_right = 0.0f;
        for (uint32_t i = 0; i < timbre->partial_count; ++i) {
            sw_synth_partial* state = &synth->partials[i];
            const synthway_partial_t* partial = &timbre->partials[i];
            const float level = sw_envelope_next(&state->envelope, &steps[i]);
            if (!sw_envelope_is_active(&state->envelope)) {
                continue;
            }
            const float gain = partial->amplitude * level;
            const float frequency = synth->current_frequency * partial->ratio;
            for (uint32_t v = 0; v < voices; ++v) {
                const float sample = sw_oscillator_sample(&state->oscillators[v], partial->waveform) * gain;
                sum_left += sample * left[v];
                sum_right += sample * right[v];
                sw_oscillator_advance(&state->oscillators[v], frequency * detune[v], rate);
            }
        }

        const float l = sum_left * synth->current_volume;
        const float r = sum_right * synth->current_volume;
        if (channels == 1) {
            *out++ = 0.5f * (l + r);
        } else {
            for (uint32_t ch = 0; ch < channels; ++ch) {
                *out++ = (ch & 1) ? r : l;
            }
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

/* The band-pass, on the sum of the oscillators */
static void sw_synth_filter(
    sw_synth* synth,
    const sw_synth_params* params,
    float rate,
    uint32_t channels,
    float* block,
    uint32_t frame_count
) {
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
    /* Left (channel 0) and right (channel 1) apart, since a spread unison makes
       them differ; the other channels repeat them (even: left, odd: right) */
    const uint32_t sides = channels < 2 ? channels : 2;
    for (uint32_t frame = 0; frame < frame_count; ++frame) {
        float* frame_out = block + (size_t)frame * channels;
        float output[2];
        for (uint32_t side = 0; side < sides; ++side) {
            output[side] = frame_out[side];
            if (high_pass_enabled) output[side] = sw_filter_process(output[side], &synth->high_pass[side], hp_b0, hp_b1, hp_b2, hp_a1, hp_a2);
            if (low_pass_enabled) output[side] = sw_filter_process(output[side], &synth->low_pass[side], lp_b0, lp_b1, lp_b2, lp_a1, lp_a2);
        }
        for (uint32_t ch = 0; ch < channels; ++ch) frame_out[ch] = output[ch & (sides - 1)];
    }
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
        if (sw_synth_gate(&state->envelope, &partial_steps[i], params->gate, opened, closed)) {
            sw_synth_start_partial(state, params->timbre->partials[i].ratio);
        }
    }

    if (params->timbre && params->unison_voices > 1) {
        sw_synth_render_unison(synth, params, partial_steps, rate, channels, out, frame_count);
    } else if (params->timbre) {
        sw_synth_render_timbre(synth, params, partial_steps, rate, channels, out, frame_count);
    } else {
        sw_synth_render_oscillator(synth, params, &steps, rate, channels, out, frame_count);
    }

    sw_synth_filter(synth, params, rate, channels, block, frame_count);
    sw_reverb_process(&synth->reverb, params->reverb_mix, sample_rate, channels, block, frame_count);
}
