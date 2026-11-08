#include "synth/envelope.h"
#include <math.h>

/* An exponential segment ends 60 dB down: a factor of 1/1000 */
#define SW_EXPONENTIAL_END 0.001f

void sw_envelope_reset(sw_envelope* envelope) {
    envelope->stage = SW_ENVELOPE_IDLE;
    envelope->level = 0.0f;
    envelope->release_step = 0.0f;
}

/* Per-sample factor that takes a level 60 dB down in samples samples */
static float sw_envelope_factor(float samples) {
    return powf(SW_EXPONENTIAL_END, 1.0f / samples);
}

sw_envelope_steps sw_envelope_steps_for(const sw_envelope_settings* settings, float sample_rate) {
    /* Segment lengths in samples (at least one, so a 0 s segment is a step) */
    const float attack_samples = fmaxf(1.0f, settings->attack_s * sample_rate);
    const float decay_samples = fmaxf(1.0f, settings->decay_s * sample_rate);

    sw_envelope_steps steps;
    steps.attack = 1.0f / attack_samples;
    steps.sustain_level = settings->sustain_level;
    steps.release_samples = fmaxf(1.0f, settings->release_s * sample_rate);
    steps.exponential = settings->curve == SYNTHWAY_ENVELOPE_EXPONENTIAL;
    if (steps.exponential) {
        steps.decay = sw_envelope_factor(decay_samples);
        steps.release_factor = sw_envelope_factor(steps.release_samples);
    } else {
        steps.decay = (1.0f - settings->sustain_level) / decay_samples;
        steps.release_factor = 0.0f;
    }
    return steps;
}

void sw_envelope_trigger(sw_envelope* envelope) {
    envelope->stage = SW_ENVELOPE_ATTACK;
}

void sw_envelope_release(sw_envelope* envelope, const sw_envelope_steps* steps) {
    if (envelope->stage != SW_ENVELOPE_IDLE) {
        envelope->stage = SW_ENVELOPE_RELEASE;
        envelope->release_step = steps->exponential ? envelope->level * SW_EXPONENTIAL_END
                                                    : envelope->level / steps->release_samples;
    }
}

float sw_envelope_next(sw_envelope* envelope, const sw_envelope_steps* steps) {
    switch (envelope->stage) {
        case SW_ENVELOPE_ATTACK:
            envelope->level += steps->attack;
            if (envelope->level >= 1.0f) {
                envelope->level = 1.0f;
                envelope->stage = SW_ENVELOPE_DECAY;
            }
            break;
        case SW_ENVELOPE_DECAY:
            if (steps->exponential) {
                /* The level above the sustain shrinks by the same factor each sample */
                const float above = (envelope->level - steps->sustain_level) * steps->decay;
                envelope->level = steps->sustain_level + above;
                if (above <= (1.0f - steps->sustain_level) * SW_EXPONENTIAL_END) {
                    envelope->level = steps->sustain_level;
                    envelope->stage = SW_ENVELOPE_SUSTAIN;
                }
            } else {
                envelope->level -= steps->decay;
                if (envelope->level <= steps->sustain_level) {
                    envelope->level = steps->sustain_level;
                    envelope->stage = SW_ENVELOPE_SUSTAIN;
                }
            }
            break;
        case SW_ENVELOPE_SUSTAIN:
            envelope->level = steps->sustain_level; /* follows live sustain changes */
            break;
        case SW_ENVELOPE_RELEASE:
            if (steps->exponential) {
                envelope->level *= steps->release_factor;
                if (envelope->level <= envelope->release_step) {
                    envelope->level = 0.0f;
                    envelope->stage = SW_ENVELOPE_IDLE;
                }
            } else {
                envelope->level -= envelope->release_step;
                if (envelope->level <= 0.0f) {
                    envelope->level = 0.0f;
                    envelope->stage = SW_ENVELOPE_IDLE;
                }
            }
            break;
        default:
            break;
    }
    return envelope->level;
}

bool sw_envelope_is_active(const sw_envelope* envelope) {
    return envelope->stage != SW_ENVELOPE_IDLE;
}
