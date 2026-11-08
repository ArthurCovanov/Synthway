#include "analysis/spectrum.h"
#include "analysis/fft.h"
#include <math.h>

#define TWO_PI 6.28318530717958647692

#define DISPLAY_MIN_HZ 20.0f
#define DISPLAY_MAX_HZ 20000.0f

/* Partials are searched from here up to just below half the sample rate */
#define PARTIAL_MIN_HZ 20.0f

/* A peak must be the highest point within this many bins on each side: the
   half width of the Blackman main lobe, so that its side lobes never count */
#define PEAK_NEIGHBOURHOOD 3

/* A peak must stand this far above the noise floor (median of the spectrum) */
#define NOISE_MARGIN_DB 20.0f

static float to_db(double amplitude) {
    if (amplitude <= 0.0) {
        return SW_SPECTRUM_FLOOR_DB;
    }
    const float db = (float)(20.0 * log10(amplitude));
    return db < SW_SPECTRUM_FLOOR_DB ? SW_SPECTRUM_FLOOR_DB : db;
}

void sw_spectrum_compute(const float* x, uint32_t n, uint32_t fft_size, float* re, float* im, float* mag_db) {
    double mean = 0.0;
    for (uint32_t i = 0; i < n; ++i) {
        mean += x[i];
    }
    mean /= n;

    double window_sum = 0.0;
    for (uint32_t i = 0; i < n; ++i) {
        const double phase = TWO_PI * i / n;
        const double w = 0.42 - 0.5 * cos(phase) + 0.08 * cos(2.0 * phase);
        re[i] = (float)((x[i] - mean) * w);
        im[i] = 0.0f;
        window_sum += w;
    }
    for (uint32_t i = n; i < fft_size; ++i) {
        re[i] = 0.0f;
        im[i] = 0.0f;
    }

    sw_fft(re, im, fft_size, false);

    /* A sine of amplitude A peaks at A / 2 * window_sum */
    const double scale = 2.0 / window_sum;
    for (uint32_t k = 0; k <= fft_size / 2; ++k) {
        mag_db[k] = to_db(scale * sqrt((double)re[k] * re[k] + (double)im[k] * im[k]));
    }
}

/* Median of the spectrum between two bins, to 1 dB, from a histogram */
static float noise_floor_db(const float* mag_db, uint32_t first, uint32_t last) {
    enum { BUCKETS = 141 }; /* -120 dB to +20 dB */
    uint32_t histogram[BUCKETS] = { 0 };
    for (uint32_t k = first; k <= last; ++k) {
        int bucket = (int)(mag_db[k] - SW_SPECTRUM_FLOOR_DB);
        if (bucket < 0) bucket = 0;
        if (bucket >= BUCKETS) bucket = BUCKETS - 1;
        histogram[bucket]++;
    }
    const uint32_t half = (last - first + 1) / 2;
    uint32_t seen = 0;
    for (int bucket = 0; bucket < BUCKETS; ++bucket) {
        seen += histogram[bucket];
        if (seen > half) {
            return SW_SPECTRUM_FLOOR_DB + (float)bucket;
        }
    }
    return SW_SPECTRUM_FLOOR_DB;
}

void sw_spectrum_find_partials(
    const float* mag_db,
    uint32_t window_frames,
    uint32_t fft_size,
    float sample_rate,
    float gate_db,
    synthway_analysis_t* out
) {
    out->partial_count = 0;
    const float bin_hz = sample_rate / (float)fft_size;
    const uint32_t half = fft_size / 2;
    /* The main lobe widens with the padding: as many bins more */
    const uint32_t neighbourhood = (PEAK_NEIGHBOURHOOD * fft_size + window_frames - 1) / window_frames;

    uint32_t first = (uint32_t)ceilf(PARTIAL_MIN_HZ / bin_hz);
    uint32_t last = (uint32_t)(0.98f * (float)half);
    if (first < neighbourhood) first = neighbourhood;
    if (last > half - neighbourhood) last = half - neighbourhood;
    if (first >= last) {
        return;
    }

    float strongest = SW_SPECTRUM_FLOOR_DB;
    for (uint32_t k = first; k <= last; ++k) {
        if (mag_db[k] > strongest) strongest = mag_db[k];
    }
    float threshold = strongest - SW_SPECTRUM_PARTIAL_RANGE_DB;
    const float noise = noise_floor_db(mag_db, first, last) + NOISE_MARGIN_DB;
    if (threshold < noise) threshold = noise;
    if (threshold <= SW_SPECTRUM_FLOOR_DB + NOISE_MARGIN_DB) threshold = SW_SPECTRUM_FLOOR_DB + NOISE_MARGIN_DB;
    if (threshold < gate_db) threshold = gate_db;

    /* The strongest peaks, at most SYNTHWAY_ANALYSIS_MAX_PARTIALS, with their level */
    float levels[SYNTHWAY_ANALYSIS_MAX_PARTIALS];
    uint32_t count = 0;

    for (uint32_t k = first; k <= last; ++k) {
        const float v = mag_db[k];
        if (v < threshold) {
            continue;
        }
        /* Strictly above the left side, at least as high as the right side:
           a flat top counts once */
        int is_peak = 1;
        for (uint32_t d = 1; d <= neighbourhood && is_peak; ++d) {
            is_peak = v > mag_db[k - d] && v >= mag_db[k + d];
        }
        if (!is_peak) {
            continue;
        }

        /* Between two bins: the top of the parabola through the peak and its
           neighbours, in dB (nearly exact for the Blackman main lobe) */
        const float left = mag_db[k - 1], right = mag_db[k + 1];
        const float curvature = left - 2.0f * v + right;
        float offset = 0.0f, level = v;
        if (curvature < 0.0f) {
            offset = 0.5f * (left - right) / curvature;
            level = v - 0.25f * (left - right) * offset;
        }

        uint32_t slot = count;
        if (count == SYNTHWAY_ANALYSIS_MAX_PARTIALS) {
            /* Full: replaces the weakest, if weaker than this one */
            slot = 0;
            for (uint32_t i = 1; i < count; ++i) {
                if (levels[i] < levels[slot]) slot = i;
            }
            if (levels[slot] >= level) {
                continue;
            }
        } else {
            count++;
        }
        levels[slot] = level;
        out->partials[slot].frequency_hz = ((float)k + offset) * bin_hz;
    }

    /* By frequency */
    for (uint32_t i = 1; i < count; ++i) {
        const synthway_analysis_partial_t partial = out->partials[i];
        const float level = levels[i];
        uint32_t j = i;
        for (; j > 0 && out->partials[j - 1].frequency_hz > partial.frequency_hz; --j) {
            out->partials[j] = out->partials[j - 1];
            levels[j] = levels[j - 1];
        }
        out->partials[j] = partial;
        levels[j] = level;
    }

    float loudest = SW_SPECTRUM_FLOOR_DB;
    for (uint32_t i = 0; i < count; ++i) {
        if (levels[i] > loudest) loudest = levels[i];
    }
    for (uint32_t i = 0; i < count; ++i) {
        out->partials[i].amplitude = powf(10.0f, (levels[i] - loudest) / 20.0f);
        out->partials[i].ratio = 0.0f;
    }
    out->partial_count = count;
}

void sw_spectrum_display(const float* mag_db, uint32_t n, float sample_rate, synthway_analysis_t* out) {
    const uint32_t points = SYNTHWAY_ANALYSIS_SPECTRUM_POINTS;
    const float bin_hz = sample_rate / (float)n;
    const uint32_t half = n / 2;
    const float max_hz = sample_rate / 2.0f < DISPLAY_MAX_HZ ? sample_rate / 2.0f : DISPLAY_MAX_HZ;

    out->spectrum_min_hz = DISPLAY_MIN_HZ;
    out->spectrum_max_hz = max_hz;

    /* Each point covers the band halfway to its neighbours, on a log scale */
    const double step = pow((double)max_hz / DISPLAY_MIN_HZ, 1.0 / (points - 1));
    const double half_step = sqrt(step);
    for (uint32_t i = 0; i < points; ++i) {
        const double hz = DISPLAY_MIN_HZ * pow(step, (double)i);
        double low_bin = hz / half_step / bin_hz, high_bin = hz * half_step / bin_hz;
        uint32_t k_low = (uint32_t)ceil(low_bin);
        uint32_t k_high = high_bin >= half ? half : (uint32_t)floor(high_bin);

        float value = SW_SPECTRUM_FLOOR_DB;
        if (k_low <= k_high) {
            /* Wide band (high frequencies): its loudest bin, so peaks show */
            for (uint32_t k = k_low; k <= k_high; ++k) {
                if (mag_db[k] > value) value = mag_db[k];
            }
        } else {
            /* Narrower than a bin (low frequencies): between the two nearest bins */
            const double position = hz / bin_hz;
            uint32_t k = (uint32_t)position;
            if (k >= half) {
                value = mag_db[half];
            } else {
                const float t = (float)(position - k);
                value = mag_db[k] + (mag_db[k + 1] - mag_db[k]) * t;
            }
        }
        out->spectrum_db[i] = value;
    }
}
