#include "synth/reverb.h"
#include <math.h>
#include <string.h>

/* Freeverb's delays in samples at 44.1 kHz, for the left channel; the right
   one adds SW_REVERB_SPREAD to each */
static const uint32_t SW_REVERB_COMB_TUNING[SW_REVERB_COMBS] = { 1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617 };
static const uint32_t SW_REVERB_ALLPASS_TUNING[SW_REVERB_ALLPASSES] = { 556, 441, 341, 225 };
#define SW_REVERB_SPREAD 23
#define SW_REVERB_TUNING_RATE 44100

/* Comb feedback, the size of the room: the tail takes about 2 s to fall 60 dB */
#define SW_REVERB_FEEDBACK 0.88f
/* Low-pass in the combs' feedback: highs fade sooner, as in a real room */
#define SW_REVERB_DAMPING 0.2f
#define SW_REVERB_ALLPASS_FEEDBACK 0.5f
/* Gain into the combs (Freeverb's 0.015 per input channel, for the two it sums) */
#define SW_REVERB_INPUT_GAIN 0.03f
/* Gain of the reverb at full mix: a held note keeps about its dry level (RMS,
   within 2 dB), but its peaks get two to three times higher */
#define SW_REVERB_WET_GAIN 1.7f
/* Per-sample smoothing of the dry and wet gains, as for the volume */
#define SW_REVERB_SMOOTHING 0.02f
/* Under this, the gains have reached those of mix 0: the reverb turns off */
#define SW_REVERB_SILENT 0.00001f

/* Values too small to hear are set to zero: decaying into the subnormal range,
   they would slow the processor down many times over on x86 */
static inline float sw_reverb_flush(float value) {
    return fabsf(value) < 1e-15f ? 0.0f : value;
}

static uint32_t sw_reverb_delay(uint32_t tuning, uint32_t sample_rate) {
    const uint64_t rate = sample_rate < SW_REVERB_MAX_RATE ? sample_rate : SW_REVERB_MAX_RATE;
    const uint32_t length = (uint32_t)((uint64_t)tuning * rate / SW_REVERB_TUNING_RATE);
    return length > 0 ? length : 1;
}

/* Sizes the delays for sample_rate and empties them */
static void sw_reverb_clear(sw_reverb* reverb, uint32_t sample_rate) {
    for (uint32_t side = 0; side < 2; ++side) {
        sw_reverb_channel* channel = &reverb->channels[side];
        const uint32_t spread = side * SW_REVERB_SPREAD;
        for (uint32_t i = 0; i < SW_REVERB_COMBS; ++i) {
            sw_reverb_comb* comb = &channel->combs[i];
            comb->length = sw_reverb_delay(SW_REVERB_COMB_TUNING[i] + spread, sample_rate);
            comb->index = 0;
            comb->store = 0.0f;
            memset(comb->buffer, 0, comb->length * sizeof(float));
        }
        for (uint32_t i = 0; i < SW_REVERB_ALLPASSES; ++i) {
            sw_reverb_allpass* allpass = &channel->allpasses[i];
            allpass->length = sw_reverb_delay(SW_REVERB_ALLPASS_TUNING[i] + spread, sample_rate);
            allpass->index = 0;
            memset(allpass->buffer, 0, allpass->length * sizeof(float));
        }
    }
    reverb->sample_rate = sample_rate;
}

void sw_reverb_init(sw_reverb* reverb) {
    reverb->sample_rate = 0;
    reverb->dry = 1.0f;
    reverb->wet = 0.0f;
    reverb->active = false;
}

static float sw_reverb_channel_process(sw_reverb_channel* channel, float input) {
    float output = 0.0f;
    for (uint32_t i = 0; i < SW_REVERB_COMBS; ++i) {
        sw_reverb_comb* comb = &channel->combs[i];
        const float delayed = comb->buffer[comb->index];
        comb->store = sw_reverb_flush(delayed * (1.0f - SW_REVERB_DAMPING) + comb->store * SW_REVERB_DAMPING);
        comb->buffer[comb->index] = input + comb->store * SW_REVERB_FEEDBACK;
        if (++comb->index >= comb->length) comb->index = 0;
        output += delayed;
    }
    for (uint32_t i = 0; i < SW_REVERB_ALLPASSES; ++i) {
        sw_reverb_allpass* allpass = &channel->allpasses[i];
        const float delayed = allpass->buffer[allpass->index];
        allpass->buffer[allpass->index] = sw_reverb_flush(output + delayed * SW_REVERB_ALLPASS_FEEDBACK);
        if (++allpass->index >= allpass->length) allpass->index = 0;
        output = delayed - output;
    }
    return output;
}

void sw_reverb_process(
    sw_reverb* reverb,
    float mix,
    uint32_t sample_rate,
    uint32_t channels,
    float* frames,
    uint32_t frame_count
) {
    if (!reverb->active) {
        if (mix <= 0.0f) {
            return;
        }
        /* Turned on: starts from an empty room */
        sw_reverb_clear(reverb, sample_rate);
        reverb->dry = 1.0f;
        reverb->wet = 0.0f;
        reverb->active = true;
    } else if (reverb->sample_rate != sample_rate) {
        sw_reverb_clear(reverb, sample_rate);
    }

    const float angle = mix * 1.57079633f;
    const float dry_target = cosf(angle);
    const float wet_target = sinf(angle) * SW_REVERB_WET_GAIN;

    for (uint32_t frame = 0; frame < frame_count; ++frame) {
        reverb->dry += (dry_target - reverb->dry) * SW_REVERB_SMOOTHING;
        reverb->wet = sw_reverb_flush(reverb->wet + (wet_target - reverb->wet) * SW_REVERB_SMOOTHING);

        float* out = frames + (size_t)frame * channels;
        /* The room is fed the mean of left and right; each channel keeps its own dry sound */
        const float input = channels >= 2 ? 0.5f * (out[0] + out[1]) : out[0];
        const float feed = sw_reverb_flush(input * SW_REVERB_INPUT_GAIN);
        const float left = sw_reverb_channel_process(&reverb->channels[0], feed);
        const float right = sw_reverb_channel_process(&reverb->channels[1], feed);

        if (channels == 1) {
            out[0] = out[0] * reverb->dry + 0.5f * (left + right) * reverb->wet;
        } else {
            for (uint32_t ch = 0; ch < channels; ++ch) {
                out[ch] = out[ch] * reverb->dry + ((ch & 1) ? right : left) * reverb->wet;
            }
        }
    }

    /* Back at mix 0 and faded out: the next blocks pass through untouched */
    if (mix <= 0.0f && reverb->wet < SW_REVERB_SILENT && 1.0f - reverb->dry < SW_REVERB_SILENT) {
        reverb->active = false;
    }
}
