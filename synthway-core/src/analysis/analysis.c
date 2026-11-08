#include "analysis/analysis.h"
#include "analysis/pitch.h"
#include "analysis/spectrum.h"
#include <math.h>
#include <string.h>

#define WINDOW_SECONDS 0.17

/* Lowest partial worth naming a note after: at most 20 dB below the strongest */
#define AUDIBLE_PARTIAL 0.1f

/* A note below its lowest audible partial (a missing fundamental) is kept only
   if that partial is at most this harmonic of it, and if its first audible
   partials all lie within HARMONIC_TOLERANCE × the note of a harmonic */
#define MAX_FIRST_HARMONIC 3.5f
#define CHECKED_PARTIALS 3
#define HARMONIC_TOLERANCE 0.1f

/* Harmonics that refine the note, and how far from n × the note they may be
   (3 %, half a semitone): the first ones, the least out of tune on real strings */
#define REFINE_HARMONICS 6
#define REFINE_TOLERANCE 0.03f

uint32_t sw_analysis_window_frames(uint32_t sample_rate) {
    const double wanted = WINDOW_SECONDS * sample_rate;
    uint32_t frames = 1024;
    while (frames < wanted && frames < SW_ANALYSIS_MAX_WINDOW) {
        frames <<= 1;
    }
    return frames;
}

static float rms_db(const float* x, uint32_t n) {
    double sum = 0.0;
    for (uint32_t i = 0; i < n; ++i) {
        sum += (double)x[i] * x[i];
    }
    const double rms = sqrt(sum / n);
    if (rms <= 0.0) {
        return SW_SPECTRUM_FLOOR_DB;
    }
    const float db = (float)(20.0 * log10(rms));
    return db < SW_SPECTRUM_FLOOR_DB ? SW_SPECTRUM_FLOOR_DB : db;
}

void sw_analysis_run_pitch(
    const float* window,
    uint32_t sample_rate,
    sw_analysis_workspace* workspace,
    float* out_frequency_hz,
    float* out_clarity,
    float* out_level_db
) {
    const uint32_t n = sw_analysis_window_frames(sample_rate);
    const float* centre = window + n / 4;
    *out_level_db = rms_db(centre, n / 2);
    *out_frequency_hz = sw_pitch_detect(
        centre, n / 2, (float)sample_rate, workspace->re, workspace->im, workspace->nsdf, out_clarity
    );
}

/* True when a note below its lowest audible partial is a missing fundamental:
   the partials are its harmonics (2, 3, 4…), the note itself is absent */
static bool sw_analysis_is_missing_fundamental(const synthway_analysis_t* out, uint32_t lowest, float frequency) {
    if (out->partials[lowest].frequency_hz > MAX_FIRST_HARMONIC * frequency) {
        return false;
    }
    uint32_t checked = 0;
    for (uint32_t i = lowest; i < out->partial_count && checked < CHECKED_PARTIALS; ++i) {
        if (out->partials[i].amplitude < AUDIBLE_PARTIAL) {
            continue;
        }
        const float harmonic = out->partials[i].frequency_hz / frequency;
        if (fabsf(harmonic - roundf(harmonic)) > HARMONIC_TOLERANCE) {
            return false;
        }
        checked++;
    }
    return true;
}

/* Checks the note found by its period against the partials found by the
   spectrum, which measures each frequency more precisely:
   - a note below the lowest audible partial must be a missing fundamental
     (partials 2, 3, 4 of the note, the note itself absent). Otherwise the
     partials of an inharmonic sound happened to line up, every 3 or 4 periods
     for instance, which is not what the ear hears: the note becomes that partial.
   - the note is then refined by its first harmonics found among the partials. */
static float sw_analysis_settle_fundamental(
    synthway_analysis_t* out,
    float frequency,
    const float* nsdf,
    uint32_t pitch_frames
) {
    if (frequency <= 0.0f || out->partial_count == 0) {
        return frequency;
    }

    for (uint32_t i = 0; i < out->partial_count; ++i) {
        if (out->partials[i].amplitude < AUDIBLE_PARTIAL) {
            continue;
        }
        if (out->partials[i].frequency_hz > (1.0f + REFINE_TOLERANCE) * frequency
            && !sw_analysis_is_missing_fundamental(out, i, frequency)) {
            frequency = out->partials[i].frequency_hz;
            out->clarity = sw_pitch_clarity_at(nsdf, pitch_frames, (float)out->sample_rate / frequency);
        }
        break;
    }

    double sum = 0.0, weight = 0.0;
    for (uint32_t i = 0; i < out->partial_count; ++i) {
        const synthway_analysis_partial_t* partial = &out->partials[i];
        const long harmonic = lroundf(partial->frequency_hz / frequency);
        if (harmonic >= 1 && harmonic <= REFINE_HARMONICS
            && fabsf(partial->frequency_hz / (harmonic * frequency) - 1.0f) <= REFINE_TOLERANCE) {
            sum += partial->amplitude * partial->frequency_hz / harmonic;
            weight += partial->amplitude;
        }
    }
    return weight > 0.0 ? (float)(sum / weight) : frequency;
}

void sw_analysis_run(
    const float* window,
    uint32_t sample_rate,
    float noise_gate_db,
    sw_analysis_workspace* workspace,
    synthway_analysis_t* out
) {
    memset(out, 0, sizeof(*out));
    out->sample_rate = sample_rate;
    float frequency;
    sw_analysis_run_pitch(window, sample_rate, workspace, &frequency, &out->clarity, &out->level_db);

    const uint32_t n = sw_analysis_window_frames(sample_rate);
    sw_spectrum_compute(window, n, workspace->re, workspace->im, workspace->mag_db);
    sw_spectrum_find_partials(workspace->mag_db, n, (float)sample_rate, noise_gate_db, out);
    sw_spectrum_display(workspace->mag_db, n, (float)sample_rate, out);

    /* Gated and nothing above the gate: only ambient noise is left, whatever
       period it may have (a fan's hum) */
    if (noise_gate_db > SW_SPECTRUM_FLOOR_DB && out->partial_count == 0) {
        frequency = 0.0f;
        out->clarity = 0.0f;
    }

    out->frequency_hz = sw_analysis_settle_fundamental(out, frequency, workspace->nsdf, n / 2);
    for (uint32_t i = 0; i < out->partial_count; ++i) {
        out->partials[i].ratio = out->frequency_hz > 0.0f ? out->partials[i].frequency_hz / out->frequency_hz : 0.0f;
    }
}
