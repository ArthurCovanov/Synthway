#include "analysis/notes.h"
#include <math.h>
#include <string.h>

/* A partial is a note's harmonic within this many cents of it */
#define TOLERANCE_CENTS 30.0f
#define MAX_HARMONIC 16
/* Harmonics above this are left out: the analysis rarely finds them reliably */
#define HIGHEST_HARMONIC_HZ 16000.0f
/* Candidates: the strongest remaining partials, as harmonics 1 to SUBHARMONICS of a note */
#define CANDIDATE_PARTIALS 12
#define SUBHARMONICS 4
/* A partial left with less than this (relative to the strongest) gives no candidate */
#define MIN_REMAINING 0.05f
/* A further note must reach this share of the first one's salience */
#define MIN_SHARE 0.2f
/* The weight of a weak fundamental never falls below this */
#define MIN_FUNDAMENTAL_WEIGHT 0.25f
/* A new note this close to one already found is the same */
#define SAME_NOTE_CENTS 50.0f

/* The salience of a note at f0 among the partials, with what each partial left
   (remaining); harmonic k's partial index goes to index[k] (-1: none) and the
   amount it explains to explained[k] */
static float sw_notes_salience(
    const synthway_analysis_t* analysis,
    const float* remaining,
    float f0,
    int* index,
    float* explained,
    uint32_t* out_harmonics
) {
    uint32_t harmonics = (uint32_t)(HIGHEST_HARMONIC_HZ / f0);
    if (harmonics > MAX_HARMONIC) harmonics = MAX_HARMONIC;
    float amplitude[MAX_HARMONIC + 2] = {0};
    float peak = 0.0f;
    for (uint32_t k = 1; k <= harmonics; ++k) {
        index[k] = -1;
        const float target = f0 * (float)k;
        for (uint32_t i = 0; i < analysis->partial_count; ++i) {
            const float f = analysis->partials[i].frequency_hz;
            if (fabsf(1200.0f * log2f(f / target)) <= TOLERANCE_CENTS && remaining[i] > amplitude[k]) {
                amplitude[k] = remaining[i];
                index[k] = (int)i;
            }
        }
        if (amplitude[k] > peak) peak = amplitude[k];
    }
    *out_harmonics = harmonics;
    if (peak <= 0.0f) {
        return 0.0f;
    }
    float salience = 0.0f;
    for (uint32_t k = 1; k <= harmonics; ++k) {
        /* No more than the mean of itself and its neighbours */
        float sum = amplitude[k], n = 1.0f;
        if (k > 1) { sum += amplitude[k - 1]; n += 1.0f; }
        if (k < harmonics) { sum += amplitude[k + 1]; n += 1.0f; }
        explained[k] = fminf(amplitude[k], sum / n);
        salience += explained[k] / (float)sqrt((double)k);
    }
    /* sqrt in double, not sqrtf: glibc 2.43 gave sqrtf a new symbol version (see sw_envelope_next) */
    float weight = (float)sqrt((double)amplitude[1] / (double)peak);
    if (weight < MIN_FUNDAMENTAL_WEIGHT) weight = MIN_FUNDAMENTAL_WEIGHT;
    return salience * weight;
}

uint32_t sw_notes_find(
    const synthway_analysis_t* analysis,
    float min_hz,
    float max_hz,
    sw_note* out,
    uint32_t capacity
) {
    float remaining[SYNTHWAY_ANALYSIS_MAX_PARTIALS];
    for (uint32_t i = 0; i < analysis->partial_count; ++i) {
        remaining[i] = analysis->partials[i].amplitude;
    }

    uint32_t found = 0;
    while (found < capacity) {
        /* Candidates from the strongest partials still unexplained */
        uint32_t order[SYNTHWAY_ANALYSIS_MAX_PARTIALS];
        uint32_t strong = 0;
        for (uint32_t i = 0; i < analysis->partial_count; ++i) {
            if (remaining[i] >= MIN_REMAINING) order[strong++] = i;
        }
        for (uint32_t a = 1; a < strong; ++a) {
            const uint32_t item = order[a];
            uint32_t b = a;
            for (; b > 0 && remaining[order[b - 1]] < remaining[item]; --b) order[b] = order[b - 1];
            order[b] = item;
        }
        if (strong > CANDIDATE_PARTIALS) strong = CANDIDATE_PARTIALS;

        float best_salience = 0.0f, best_f0 = 0.0f;
        for (uint32_t c = 0; c < strong; ++c) {
            for (uint32_t h = 1; h <= SUBHARMONICS; ++h) {
                const float f0 = analysis->partials[order[c]].frequency_hz / (float)h;
                if (f0 < min_hz || f0 > max_hz) continue;
                bool known = false;
                for (uint32_t n = 0; n < found && !known; ++n) {
                    known = fabsf(1200.0f * log2f(f0 / out[n].frequency_hz)) < SAME_NOTE_CENTS;
                }
                if (known) continue;
                int index[MAX_HARMONIC + 2];
                float explained[MAX_HARMONIC + 2];
                uint32_t harmonics;
                const float salience = sw_notes_salience(analysis, remaining, f0, index, explained, &harmonics);
                if (salience > best_salience) {
                    best_salience = salience;
                    best_f0 = f0;
                }
            }
        }
        if (best_salience <= 0.0f || (found > 0 && best_salience < MIN_SHARE * out[0].salience)) {
            break;
        }

        /* Its harmonics, more precisely: weighed by amplitude, each read as k × f0 */
        int index[MAX_HARMONIC + 2];
        float explained[MAX_HARMONIC + 2];
        uint32_t harmonics;
        sw_notes_salience(analysis, remaining, best_f0, index, explained, &harmonics);
        double sum = 0.0, weight = 0.0;
        for (uint32_t k = 1; k <= harmonics && k <= 6; ++k) {
            if (index[k] < 0) continue;
            sum += explained[k] * analysis->partials[index[k]].frequency_hz / k;
            weight += explained[k];
        }
        out[found].frequency_hz = weight > 0.0 ? (float)(sum / weight) : best_f0;
        out[found].salience = best_salience;
        found++;

        /* What it explains is taken out: a harmonic shared with another note keeps the rest */
        for (uint32_t k = 1; k <= harmonics; ++k) {
            if (index[k] < 0) continue;
            remaining[index[k]] -= explained[k];
            if (remaining[index[k]] < 0.0f) remaining[index[k]] = 0.0f;
        }
    }
    return found;
}
