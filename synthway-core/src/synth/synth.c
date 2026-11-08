#include "synth/synth.h"

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

void sw_synth_render(
    sw_synth* synth,
    const sw_synth_params* params,
    uint32_t sample_rate,
    uint32_t channels,
    float* out,
    uint32_t frame_count
) {
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
}
