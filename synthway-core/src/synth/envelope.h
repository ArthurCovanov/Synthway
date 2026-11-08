#ifndef SW_SYNTH_ENVELOPE_H
#define SW_SYNTH_ENVELOPE_H

#include <stdbool.h>
#include "synthway/types.h"

/* Linear ADSR envelope. IDLE is 0 so that a zeroed envelope starts silent. */
typedef enum sw_envelope_stage {
    SW_ENVELOPE_IDLE = 0,
    SW_ENVELOPE_ATTACK,
    SW_ENVELOPE_DECAY,
    SW_ENVELOPE_SUSTAIN,
    SW_ENVELOPE_RELEASE
} sw_envelope_stage;

/* Settings, as given to synthway_engine_set_envelope or in a partial */
typedef synthway_envelope_t sw_envelope_settings;

/* Per-sample increments, derived from the settings once per block */
typedef struct sw_envelope_steps {
    float attack;
    float decay;
    float sustain_level;
    float release_samples;
} sw_envelope_steps;

typedef struct sw_envelope {
    sw_envelope_stage stage;
    float level;
    float release_step;    /* per-sample decrement, set when the release starts */
} sw_envelope;

void sw_envelope_reset(sw_envelope* envelope);

sw_envelope_steps sw_envelope_steps_for(const sw_envelope_settings* settings, float sample_rate);

/* Starts the attack from the current level, so that a retrigger does not click */
void sw_envelope_trigger(sw_envelope* envelope);

/* Starts the release from the current level; an idle envelope stays idle */
void sw_envelope_release(sw_envelope* envelope, const sw_envelope_steps* steps);

/* Advances by one sample and returns the new level */
float sw_envelope_next(sw_envelope* envelope, const sw_envelope_steps* steps);

bool sw_envelope_is_active(const sw_envelope* envelope);

#endif /* SW_SYNTH_ENVELOPE_H */
