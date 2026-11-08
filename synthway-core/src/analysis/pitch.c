#include "analysis/pitch.h"
#include "analysis/fft.h"
#include <math.h>
#include <string.h>

/* A peak of the NSDF is kept if it reaches this share of the highest one: the
   first such peak is the period, the higher ones its multiples (octaves below) */
#define KEY_MAXIMUM_THRESHOLD 0.9f

/* Most positive regions of the NSDF examined (one per candidate period) */
#define MAX_KEY_MAXIMA 128

/* Top of the parabola through nsdf[lag] and its neighbours: between two
   samples. Returns its height, clamped to [0, 1], and its offset from lag.
   When lag is no real peak (a neighbour is higher, at the edge of the search
   range), the parabola's top would fall outside the two neighbours, possibly
   far away: lag itself is kept. */
static float peak_top(const float* nsdf, uint32_t lag, float* out_offset) {
    const float left = nsdf[lag - 1], top = nsdf[lag], right = nsdf[lag + 1];
    const float curvature = left - 2.0f * top + right;
    float value = top;
    *out_offset = 0.0f;
    if (curvature < 0.0f) {
        const float offset = 0.5f * (left - right) / curvature;
        if (offset >= -0.5f && offset <= 0.5f) {
            *out_offset = offset;
            value = top - 0.25f * (left - right) * offset;
        }
    }
    return value < 0.0f ? 0.0f : (value > 1.0f ? 1.0f : value);
}

float sw_pitch_detect(
    const float* x,
    uint32_t n,
    float sample_rate,
    float* re,
    float* im,
    float* nsdf,
    float* out_clarity
) {
    *out_clarity = 0.0f;
    uint32_t fft_size = 2;
    while (fft_size < 2 * n) {
        fft_size <<= 1;
    }
    const uint32_t max_lag = n / 2;

    /* Without its mean, so that an offset does not look like a period */
    double mean = 0.0;
    for (uint32_t i = 0; i < n; ++i) {
        mean += x[i];
    }
    mean /= n;

    double energy = 0.0;
    for (uint32_t i = 0; i < n; ++i) {
        re[i] = (float)(x[i] - mean);
        energy += (double)re[i] * re[i];
    }
    if (energy < 1e-12 * n) {
        return 0.0f;
    }
    memset(re + n, 0, sizeof(float) * (fft_size - n));
    memset(im, 0, sizeof(float) * fft_size);

    /* Autocorrelation r(lag) through the power spectrum; the zero padding
       keeps the correlation linear (no wrap around) */
    sw_fft(re, im, fft_size, false);
    for (uint32_t k = 0; k < fft_size; ++k) {
        re[k] = re[k] * re[k] + im[k] * im[k];
        im[k] = 0.0f;
    }
    sw_fft(re, im, fft_size, true);

    /* Normalized square difference function: nsdf(lag) = 2 r(lag) / m(lag),
       with m(lag) the energy of both overlapping parts. Its peaks are in [-1, 1],
       1 for a signal that repeats itself exactly. re[] now holds fft_size * r. */
    double m = 2.0 * energy;
    float* centered = im; /* the signal again, without its mean: im is free */
    for (uint32_t i = 0; i < n; ++i) {
        centered[i] = (float)(x[i] - mean);
    }
    for (uint32_t lag = 0; lag <= max_lag; ++lag) {
        if (lag > 0) {
            const double a = centered[lag - 1], b = centered[n - lag];
            m -= a * a + b * b;
        }
        nsdf[lag] = m > 0.0 ? (float)(2.0 * re[lag] / fft_size / m) : 0.0f;
    }

    /* Key maxima: the highest point of each positive region, after the first
       one (the lobe around lag 0) and above the highest pitch searched */
    uint32_t min_lag = (uint32_t)(sample_rate / SW_PITCH_MAX_HZ);
    if (min_lag < 2) {
        min_lag = 2;
    }
    uint32_t lag = 1;
    while (lag < max_lag && nsdf[lag] > 0.0f) {
        ++lag;
    }

    uint32_t key_lags[MAX_KEY_MAXIMA];
    uint32_t key_count = 0;
    uint32_t best = 0;
    for (; lag < max_lag && key_count < MAX_KEY_MAXIMA; ++lag) {
        if (nsdf[lag] <= 0.0f) {
            if (best) {
                key_lags[key_count++] = best;
                best = 0;
            }
            continue;
        }
        if (lag >= min_lag && (!best || nsdf[lag] > nsdf[best])) {
            best = lag;
        }
    }
    /* A region still open at the end of the window: keep it only if its
       maximum is a real peak, not the edge of the search range */
    if (best && key_count < MAX_KEY_MAXIMA && best < max_lag - 1) {
        key_lags[key_count++] = best;
    }
    if (key_count == 0) {
        return 0.0f;
    }
    float highest = 0.0f;
    for (uint32_t i = 0; i < key_count; ++i) {
        if (nsdf[key_lags[i]] > highest) {
            highest = nsdf[key_lags[i]];
        }
    }

    uint32_t period = 0;
    for (uint32_t i = 0; i < key_count; ++i) {
        if (nsdf[key_lags[i]] >= KEY_MAXIMUM_THRESHOLD * highest) {
            period = key_lags[i];
            break;
        }
    }

    float offset;
    *out_clarity = peak_top(nsdf, period, &offset);
    return sample_rate / ((float)period + offset);
}

float sw_pitch_clarity_at(const float* nsdf, uint32_t n, float period) {
    const uint32_t max_lag = n / 2;
    long centre = lroundf(period);
    if (centre < 3) centre = 3;
    if (centre > (long)max_lag - 3) centre = (long)max_lag - 3;
    if (centre < 3) {
        return 0.0f;
    }
    uint32_t best = (uint32_t)centre - 2;
    for (uint32_t lag = best + 1; lag <= (uint32_t)centre + 2; ++lag) {
        if (nsdf[lag] > nsdf[best]) best = lag;
    }
    float offset;
    return peak_top(nsdf, best, &offset);
}
