#include "synth/oscillator.h"
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define TWO_PI 6.28318530717958647692

void sw_oscillator_reset(sw_oscillator* oscillator) {
    oscillator->phase = 0.0;
}

float sw_oscillator_sample(const sw_oscillator* oscillator, synthway_waveform_t waveform) {
    const double phase = oscillator->phase;

    switch (waveform) {
        case SYNTHWAY_WAVEFORM_SINE:
            return sinf((float)phase);
        case SYNTHWAY_WAVEFORM_SQUARE:
            return (phase < M_PI) ? 1.0f : -1.0f;
        case SYNTHWAY_WAVEFORM_TRIANGLE:
            if (phase <= M_PI) {
                return (float)((2.0 / M_PI) * phase - 1.0);
            }
            return (float)(1.0 - (2.0 / M_PI) * (phase - M_PI));
        case SYNTHWAY_WAVEFORM_SAWTOOTH:
            return (float)((phase / M_PI) - 1.0);
        default:
            return sinf((float)phase);
    }
}

void sw_oscillator_advance(sw_oscillator* oscillator, float frequency_hz, float sample_rate) {
    oscillator->phase += (TWO_PI * (double)frequency_hz) / (double)sample_rate;
    if (oscillator->phase >= TWO_PI) {
        /* fmod rather than one subtraction: a partial can run above the
           sample rate. Below it, both give the same exact result. */
        oscillator->phase = fmod(oscillator->phase, TWO_PI);
    }
}
