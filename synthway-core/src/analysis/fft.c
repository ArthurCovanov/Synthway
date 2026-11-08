#include "analysis/fft.h"
#include <math.h>

#define TWO_PI 6.28318530717958647692

void sw_fft(float* re, float* im, uint32_t n, bool inverse) {
    /* Bit-reversal permutation */
    for (uint32_t i = 1, j = 0; i < n; ++i) {
        uint32_t bit = n >> 1;
        for (; j & bit; bit >>= 1) {
            j ^= bit;
        }
        j ^= bit;
        if (i < j) {
            float t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }

    /* Butterflies. The twiddle factor is advanced by complex multiplication,
       in double precision so that it does not drift over 16384 points. */
    for (uint32_t len = 2; len <= n; len <<= 1) {
        const double angle = (inverse ? TWO_PI : -TWO_PI) / (double)len;
        const double step_re = cos(angle), step_im = sin(angle);
        const uint32_t half = len >> 1;
        double w_re = 1.0, w_im = 0.0;
        for (uint32_t k = 0; k < half; ++k) {
            const float wr = (float)w_re, wi = (float)w_im;
            for (uint32_t start = 0; start < n; start += len) {
                const uint32_t a = start + k, b = a + half;
                const float br = re[b] * wr - im[b] * wi;
                const float bi = re[b] * wi + im[b] * wr;
                re[b] = re[a] - br;
                im[b] = im[a] - bi;
                re[a] += br;
                im[a] += bi;
            }
            const double next = w_re * step_re - w_im * step_im;
            w_im = w_re * step_im + w_im * step_re;
            w_re = next;
        }
    }
}
