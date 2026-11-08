#include "analysis/waveform.h"
#include "analysis/spectrum.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define PI 3.14159265358979323846

/* The band of a harmonic: within BAND_CENTS of it, at least MIN_BAND_BINS
   on each side (the half width of the Blackman main lobe), at most
   MAX_BAND_SHARE of the gap between two harmonics */
#define BAND_CENTS 40.0
#define MIN_BAND_BINS 3.0
#define MAX_BAND_SHARE 0.3

/* The background: bins between harmonics, GUARD_BINS clear of their bands;
   with fewer than MIN_BACKGROUND_BINS of them, the median of the whole range */
#define GUARD_BINS 3.0
#define MIN_BACKGROUND_BINS 4

/* Another note's harmonic this close to one of the note's (or within its
   band) shares it, if it is among its first SHARED_MAX_RANK and its expected
   amplitude (the note's strength / its rank) reaches SHARED_SHARE of the
   harmonic's own */
#define SHARED_CENTS 35.0
#define SHARED_MAX_RANK 8.0
#define SHARED_SHARE 0.3

/* Equivalent noise bandwidth of the Blackman window of sw_spectrum_compute,
   in bins of an unpadded spectrum: a sine's power spreads over that many */
#define BLACKMAN_ENBW 1.7268

/* Fit: a harmonic both measured and predicted below its background plus
   this tells nothing; a gap counts for MAX_GAP_DB at most (one odd harmonic
   does not outweigh the others) */
#define UNHEARD_MARGIN_DB 3.0
#define MAX_GAP_DB 30.0
#define MISSING_DB -200.0

/* Cutoffs tried for the low-pass: CUTOFF_STEPS_PER_OCTAVE per octave, from
   the note (at least LOWEST_CUTOFF_HZ) to the highest harmonic measured */
#define CUTOFF_STEPS_PER_OCTAVE 6
#define LOWEST_CUTOFF_HZ 40.0
#define MAX_CUTOFFS 80

/* A shape is taken without filter or resonance unless they bring it this
   much closer, and a pulse (one setting more) must beat the others by this */
#define FILTER_PENALTY_DB 0.1
#define RESONANCE_PENALTY_DB 1.0   /* per unit of resonance */
#define PULSE_PENALTY_DB 0.3

static const float RESONANCES[] = { 0.0f, 0.05f, 0.1f, 0.15f, 0.2f, 0.3f };
#define RESONANCE_COUNT (sizeof(RESONANCES) / sizeof(RESONANCES[0]))

/* Pulses tried, as the share of the period they are high (d and 1 - d sound the same) */
static const float DUTIES[] = {
    0.05f, 0.075f, 0.1f, 0.125f, 0.15f, 0.175f, 0.2f, 0.225f, 0.25f,
    0.275f, 0.3f, 0.3333333f, 0.35f, 0.375f, 0.4f, 0.425f, 0.45f,
};
#define DUTY_COUNT (sizeof(DUTIES) / sizeof(DUTIES[0]))

uint32_t sw_waveform_harmonic_count(float note_hz, float sample_rate) {
    if (!(note_hz > 0.0f) || !(sample_rate > 0.0f)) {
        return 0;
    }
    double highest = 0.45 * sample_rate;
    if (highest > SW_WAVEFORM_HIGHEST_HZ) highest = SW_WAVEFORM_HIGHEST_HZ;
    double count = floor(highest / note_hz);
    if (count > SYNTHWAY_WAVEFORM_FIT_HARMONICS) count = SYNTHWAY_WAVEFORM_FIT_HARMONICS;
    return count < 1.0 ? 0 : (uint32_t)count;
}

static float power_to_db(double power) {
    if (!(power > 1e-12)) {
        return SW_SPECTRUM_FLOOR_DB;
    }
    return (float)(10.0 * log10(power));
}

/* Median of mag_db over the bins of [first, last] whose distance to every
   harmonic centre (centre + j * spacing) exceeds clear, to 0.25 dB, from a
   histogram; NAN with fewer than MIN_BACKGROUND_BINS such bins */
static double background_median(
    const float* mag_db,
    long first,
    long last,
    double centre,
    double spacing,
    double clear
) {
    enum { BUCKETS = 561 }; /* -120 dB to +20 dB, every 0.25 dB */
    static const double LOWEST = -120.0, STEP = 0.25;
    uint32_t histogram[BUCKETS];
    memset(histogram, 0, sizeof(histogram));
    uint32_t total = 0;
    for (long b = first; b <= last; ++b) {
        const double offset = (b - centre) / spacing;
        const double nearest = fabs(offset - floor(offset + 0.5)) * spacing;
        if (nearest <= clear) {
            continue;
        }
        long bucket = lround((mag_db[b] - LOWEST) / STEP);
        if (bucket < 0) bucket = 0;
        if (bucket >= BUCKETS) bucket = BUCKETS - 1;
        histogram[bucket]++;
        total++;
    }
    if (total < MIN_BACKGROUND_BINS) {
        return NAN;
    }
    uint32_t seen = 0;
    for (uint32_t bucket = 0; bucket < BUCKETS; ++bucket) {
        seen += histogram[bucket];
        if (2 * seen >= total) {
            return LOWEST + STEP * bucket;
        }
    }
    return LOWEST;
}

void sw_waveform_measure(
    const float* mag_db,
    uint32_t frames,
    uint32_t fft_size,
    float sample_rate,
    float note_hz,
    const float* others_hz,
    const float* others_strength,
    uint32_t other_count,
    uint32_t count,
    float* level_db,
    float* background_db,
    uint8_t* shared
) {
    const double bin_hz = (double)sample_rate / fft_size;
    const double enbw = BLACKMAN_ENBW * fft_size / frames;
    const long last_bin = (long)(fft_size / 2);
    const double spacing = note_hz / bin_hz;   /* bins between two harmonics */
    const double band_ratio = pow(2.0, BAND_CENTS / 1200.0) - 1.0;
    const double shared_ratio = pow(2.0, SHARED_CENTS / 1200.0) - 1.0;

    /* Fallback background: the median between all the harmonics measured */
    double overall = NAN;
    double top = SW_SPECTRUM_FLOOR_DB;
    double halves[SYNTHWAY_WAVEFORM_FIT_HARMONICS];

    for (uint32_t k = 0; k < count; ++k) {
        const double harmonic = (k + 1.0) * note_hz;
        const double centre = harmonic / bin_hz;
        double half = centre * band_ratio;
        if (half < MIN_BAND_BINS) half = MIN_BAND_BINS;
        if (half > MAX_BAND_SHARE * spacing) half = MAX_BAND_SHARE * spacing;
        if (half < 1.0) half = 1.0;
        long low = lround(centre - half), high = lround(centre + half);
        if (low < 1) low = 1;
        if (high > last_bin) high = last_bin;

        double power = 0.0;
        for (long b = low; b <= high; ++b) {
            power += pow(10.0, mag_db[b] / 10.0);
        }
        level_db[k] = power_to_db(power / enbw);
        if (level_db[k] > top) top = level_db[k];
        halves[k] = half;

        /* The background as this band would read it: the median power per bin, times the band's bins */
        long first = lround(centre - 0.5 * spacing), last = lround(centre + 0.5 * spacing);
        if (first < 1) first = 1;
        if (last > last_bin) last = last_bin;
        double median = background_median(mag_db, first, last, centre, spacing, half + GUARD_BINS);
        if (isnan(median)) {
            if (isnan(overall)) {
                /* Harmonics too close together to leave bins between them (a very
                   low note in a short window): every bin of their range */
                long top = lround((count + 0.5) * spacing);
                if (top > last_bin) top = last_bin;
                overall = background_median(mag_db, lround(0.5 * spacing), top, centre, spacing, -1.0);
                if (isnan(overall)) overall = SW_SPECTRUM_FLOOR_DB;
            }
            median = overall;
        }
        background_db[k] = power_to_db(pow(10.0, median / 10.0) * (double)(high - low + 1) / enbw);
    }

    /* Shared with another note: one of its first harmonics, within SHARED_CENTS
       or the band, loud enough next to this one */
    for (uint32_t k = 0; k < count; ++k) {
        const double harmonic = (k + 1.0) * note_hz;
        const double amplitude = pow(10.0, (level_db[k] - top) / 20.0);
        double tolerance = harmonic * shared_ratio;
        if (tolerance < halves[k] * bin_hz) tolerance = halves[k] * bin_hz;
        uint8_t is_shared = 0;
        for (uint32_t o = 0; o < other_count && !is_shared; ++o) {
            const double other = others_hz[o];
            if (!(other > 0.0)) continue;
            const double rank = floor(harmonic / other + 0.5);
            is_shared = rank >= 1.0 && rank <= SHARED_MAX_RANK && fabs(harmonic - rank * other) < tolerance
                        && others_strength[o] / rank >= SHARED_SHARE * amplitude;
        }
        shared[k] = is_shared;
    }
}

float sw_waveform_shape_db(uint32_t shape, float duty, uint32_t n) {
    const double k = n;
    switch (shape) {
        case SYNTHWAY_SHAPE_SINE:
            return n == 1 ? 0.0f : (float)MISSING_DB;
        case SYNTHWAY_SHAPE_SQUARE:
            return n % 2 ? (float)(-20.0 * log10(k)) : (float)MISSING_DB;
        case SYNTHWAY_SHAPE_TRIANGLE:
            return n % 2 ? (float)(-40.0 * log10(k)) : (float)MISSING_DB;
        case SYNTHWAY_SHAPE_SAWTOOTH:
            return (float)(-20.0 * log10(k));
        case SYNTHWAY_SHAPE_PULSE: {
            const double first = fabs(sin(PI * duty));
            const double amplitude = fabs(sin(PI * k * duty)) / k;
            if (!(first > 0.0) || amplitude < first * 1e-10) {
                return (float)MISSING_DB;
            }
            return (float)(20.0 * log10(amplitude / first));
        }
        default:
            return (float)MISSING_DB;
    }
}

/* Response in dB of the engine's low-pass (an RBJ biquad, the bilinear
   transform of 1 / (s² + s/q + 1), warped at the cutoff) at frequency */
static double lowpass_db(double frequency, double cutoff, double q, double sample_rate) {
    const double x = tan(PI * frequency / sample_rate) / tan(PI * cutoff / sample_rate);
    const double a = 1.0 - x * x, b = x / q;
    return -10.0 * log10(a * a + b * b);
}

/* What a fit compares: the harmonics measured, weighed */
typedef struct sw_fit_target {
    uint32_t count;
    double level[SYNTHWAY_WAVEFORM_FIT_HARMONICS];
    double background[SYNTHWAY_WAVEFORM_FIT_HARMONICS];
    double background_power[SYNTHWAY_WAVEFORM_FIT_HARMONICS];
    double weight[SYNTHWAY_WAVEFORM_FIT_HARMONICS];   /* 0: left out */
} sw_fit_target;

/* Mean gap (dB) between the harmonics measured and a model (dB, relative)
   raised by gain: the model's harmonics add to the background, as they would
   in the sound */
static double fit_error(const sw_fit_target* target, const double* model_db, double gain) {
    double sum = 0.0, weights = 0.0;
    for (uint32_t k = 0; k < target->count; ++k) {
        if (target->weight[k] <= 0.0) continue;
        const double predicted = 10.0 * log10(pow(10.0, (model_db[k] + gain) / 10.0) + target->background_power[k]);
        const double floor_db = target->background[k] + UNHEARD_MARGIN_DB;
        if (target->level[k] <= floor_db && predicted <= floor_db) continue;
        double gap = fabs(target->level[k] - predicted);
        if (gap > MAX_GAP_DB) gap = MAX_GAP_DB;
        sum += target->weight[k] * gap;
        weights += target->weight[k];
    }
    return weights > 0.0 ? sum / weights : 1e9;
}

static int compare_doubles(const void* a, const void* b) {
    const double x = *(const double*)a, y = *(const double*)b;
    return (x > y) - (x < y);
}

/* The model's level that brings it closest: from the median gap over the
   harmonics heard, then by halving steps. Returns its error. */
static double fit_gain(const sw_fit_target* target, const double* model_db) {
    double gaps[SYNTHWAY_WAVEFORM_FIT_HARMONICS];
    uint32_t n = 0;
    for (uint32_t k = 0; k < target->count; ++k) {
        if (target->weight[k] > 0.0 && model_db[k] > MISSING_DB / 2.0
            && target->level[k] > target->background[k] + UNHEARD_MARGIN_DB) {
            gaps[n++] = target->level[k] - model_db[k];
        }
    }
    double gain = 0.0;
    if (n > 0) {
        qsort(gaps, n, sizeof(double), compare_doubles);
        gain = n % 2 ? gaps[n / 2] : 0.5 * (gaps[n / 2 - 1] + gaps[n / 2]);
    }
    double best = fit_error(target, model_db, gain);
    for (double step = 4.0; step >= 0.25; step *= 0.5) {
        for (int direction = -1; direction <= 1; direction += 2) {
            const double error = fit_error(target, model_db, gain + direction * step);
            if (error < best) {
                best = error;
                gain += direction * step;
            }
        }
    }
    return best;
}

/* Best fit of one shape at one duty: no filter, then every cutoff, then the
   resonances around the best cutoff */
static void fit_shape(
    const sw_fit_target* target,
    uint32_t shape,
    float duty,
    float note_hz,
    float sample_rate,
    const double* cutoffs,
    uint32_t cutoff_count,
    synthway_shape_fit_t* best,
    double* best_score
) {
    double base[SYNTHWAY_WAVEFORM_FIT_HARMONICS], model[SYNTHWAY_WAVEFORM_FIT_HARMONICS];
    for (uint32_t k = 0; k < target->count; ++k) {
        base[k] = sw_waveform_shape_db(shape, duty, k + 1);
    }
    const double plain = fit_gain(target, base);
    if (plain < *best_score) {
        *best_score = plain;
        best->shape = shape;
        best->duty = duty;
        best->cutoff_hz = 0.0f;
        best->resonance = 0.0f;
        best->error_db = (float)plain;
    }

    uint32_t best_cutoff = 0;
    double best_filtered = 1e18;
    for (uint32_t r = 0; r < RESONANCE_COUNT; ++r) {
        /* Without resonance, every cutoff; with it, around the best one */
        uint32_t from = 0, to = cutoff_count;
        if (r > 0) {
            from = best_cutoff >= 2 ? best_cutoff - 2 : 0;
            to = best_cutoff + 3 < cutoff_count ? best_cutoff + 3 : cutoff_count;
        }
        const double q = 0.70710678 + RESONANCES[r] * 9.29289322;
        for (uint32_t c = from; c < to; ++c) {
            for (uint32_t k = 0; k < target->count; ++k) {
                model[k] = base[k] + lowpass_db((k + 1.0) * note_hz, cutoffs[c], q, sample_rate);
            }
            const double error = fit_gain(target, model);
            const double score = error + FILTER_PENALTY_DB + RESONANCE_PENALTY_DB * RESONANCES[r];
            if (r == 0 && score < best_filtered) {
                best_filtered = score;
                best_cutoff = c;
            }
            if (score < *best_score) {
                *best_score = score;
                best->shape = shape;
                best->duty = duty;
                best->cutoff_hz = (float)cutoffs[c];
                best->resonance = RESONANCES[r];
                best->error_db = (float)error;
            }
        }
    }
}

static int compare_fits(const void* a, const void* b) {
    const synthway_shape_fit_t* x = (const synthway_shape_fit_t*)a;
    const synthway_shape_fit_t* y = (const synthway_shape_fit_t*)b;
    const double sx = x->error_db + (x->shape == SYNTHWAY_SHAPE_PULSE ? PULSE_PENALTY_DB : 0.0);
    const double sy = y->error_db + (y->shape == SYNTHWAY_SHAPE_PULSE ? PULSE_PENALTY_DB : 0.0);
    if (sx != sy) return sx < sy ? -1 : 1;
    return (x->shape > y->shape) - (x->shape < y->shape);
}

void sw_waveform_fit(float sample_rate, synthway_waveform_fit_t* out) {
    out->even_db = 0.0f;
    out->even_count = 0;
    out->slope_db_per_octave = 0.0f;
    out->fit_count = 0;
    const uint32_t count = out->harmonic_count < SYNTHWAY_WAVEFORM_FIT_HARMONICS ? out->harmonic_count
                                                                                 : SYNTHWAY_WAVEFORM_FIT_HARMONICS;
    const float note_hz = out->frequency_hz;

    sw_fit_target target;
    memset(&target, 0, sizeof(target));
    target.count = count;
    uint32_t heard = 0;
    for (uint32_t k = 0; k < count; ++k) {
        target.level[k] = out->harmonic_db[k];
        target.background[k] = out->background_db[k];
        target.background_power[k] = pow(10.0, out->background_db[k] / 10.0);
        if (out->harmonic_state[k] != SYNTHWAY_HARMONIC_SHARED) {
            /* The higher harmonics weigh less: the ear, and a unison that blurs them */
            target.weight[k] = 1.0 / sqrt(k + 1.0);
        }
        if (out->harmonic_state[k] == SYNTHWAY_HARMONIC_HEARD) heard++;
    }
    if (heard == 0 || !(note_hz > 0.0f)) {
        return;
    }

    /* Even harmonics against their odd neighbours, up to the 16th */
    double evens[SYNTHWAY_WAVEFORM_FIT_HARMONICS];
    uint32_t even_count = 0;
    for (uint32_t n = 2; n + 1 <= count && n <= 16; n += 2) {
        const uint8_t below = out->harmonic_state[n - 2], at = out->harmonic_state[n - 1], above = out->harmonic_state[n];
        if (below == SYNTHWAY_HARMONIC_SHARED || at == SYNTHWAY_HARMONIC_SHARED || above == SYNTHWAY_HARMONIC_SHARED) continue;
        if (below != SYNTHWAY_HARMONIC_HEARD && at != SYNTHWAY_HARMONIC_HEARD && above != SYNTHWAY_HARMONIC_HEARD) continue;
        evens[even_count++] = out->harmonic_db[n - 1] - 0.5 * (out->harmonic_db[n - 2] + out->harmonic_db[n]);
    }
    if (even_count > 0) {
        qsort(evens, even_count, sizeof(double), compare_doubles);
        out->even_db = (float)(even_count % 2 ? evens[even_count / 2] : 0.5 * (evens[even_count / 2 - 1] + evens[even_count / 2]));
        out->even_count = even_count;
    }

    /* Slope: least squares, over their octave, of the strongest heard
       harmonic of each octave (1, 2-3, 4-7…), so that the gaps of a square or
       a pulse do not count as a fall */
    double sx = 0.0, sy = 0.0, sxx = 0.0, sxy = 0.0;
    uint32_t points = 0;
    for (uint32_t first = 1; first <= count; first *= 2) {
        int strongest = -1;
        for (uint32_t n = first; n < 2 * first && n <= count; ++n) {
            if (out->harmonic_state[n - 1] == SYNTHWAY_HARMONIC_HEARD
                && (strongest < 0 || out->harmonic_db[n - 1] > out->harmonic_db[strongest - 1])) {
                strongest = (int)n;
            }
        }
        if (strongest < 0) continue;
        const double x = log2((double)strongest), y = out->harmonic_db[strongest - 1];
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
        points++;
    }
    const double spread = points * sxx - sx * sx;
    if (points >= 2 && spread > 1e-9) {
        out->slope_db_per_octave = (float)((points * sxy - sx * sy) / spread);
    }

    /* Cutoffs tried: from the note up to the highest harmonic measured */
    double cutoffs[MAX_CUTOFFS];
    uint32_t cutoff_count = 0;
    const double lowest = note_hz > LOWEST_CUTOFF_HZ ? note_hz : LOWEST_CUTOFF_HZ;
    const double highest = (double)count * note_hz;
    for (double cutoff = lowest; cutoff <= highest * 1.0001 && cutoff_count < MAX_CUTOFFS;
         cutoff *= pow(2.0, 1.0 / CUTOFF_STEPS_PER_OCTAVE)) {
        cutoffs[cutoff_count++] = cutoff;
    }

    for (uint32_t shape = 0; shape < SYNTHWAY_SHAPE_COUNT; ++shape) {
        synthway_shape_fit_t* fit = &out->fits[shape];
        memset(fit, 0, sizeof(*fit));
        fit->shape = shape;
        fit->error_db = 1e9f;
        double score = 1e18;
        if (shape == SYNTHWAY_SHAPE_PULSE) {
            for (uint32_t d = 0; d < DUTY_COUNT; ++d) {
                fit_shape(&target, shape, DUTIES[d], note_hz, sample_rate, cutoffs, cutoff_count, fit, &score);
            }
        } else {
            const float duty = shape == SYNTHWAY_SHAPE_SQUARE ? 0.5f : 0.0f;
            fit_shape(&target, shape, duty, note_hz, sample_rate, cutoffs, cutoff_count, fit, &score);
        }
    }
    qsort(out->fits, SYNTHWAY_SHAPE_COUNT, sizeof(synthway_shape_fit_t), compare_fits);
    out->fit_count = SYNTHWAY_SHAPE_COUNT;
}
