#include "analysis/analysis.h"
#include "analysis/pitch.h"
#include "analysis/spectrum.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

#define WINDOW_SECONDS 0.17

/* Partials of two moments of a zone are the same within this share of their
   ratio (1 %, 17 cents): far finer than the gap between harmonics 64 and 65 */
#define MATCH_TOLERANCE 0.01f

/* A moment's note is trusted from this clarity on: below, an attack or noise */
#define NOTE_CLARITY 0.5f
/* A note is the reference's, in whatever octave, within this many semitones */
#define REFERENCE_SEMITONES 1.5
/* Without a reference given, a zone's is the note this share of its clear
   moments lie below (its low end, see sw_analysis_combine) */
#define REFERENCE_PERCENTILE 0.2f
/* Without a reference given, a zone has a note when at least this share of
   its moments are on it */
#define MIN_ON_NOTE_SHARE 0.25f

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

uint32_t sw_analysis_frames_for(double seconds, uint32_t sample_rate) {
    const double wanted = seconds * sample_rate + 0.5;
    if (!(wanted >= SW_ANALYSIS_MIN_WINDOW)) {
        return SW_ANALYSIS_MIN_WINDOW;
    }
    return wanted >= SW_ANALYSIS_MAX_WINDOW ? SW_ANALYSIS_MAX_WINDOW : (uint32_t)wanted;
}

uint32_t sw_analysis_fft_size(uint32_t frames) {
    uint32_t fft_size = SW_ANALYSIS_MIN_WINDOW;
    while (fft_size < frames) {
        fft_size <<= 1;
    }
    return fft_size;
}

/* Samples the note is taken on, in the middle of a window of frames: its
   central half, but at least half the usual window when the window allows it */
static uint32_t sw_analysis_pitch_frames(uint32_t frames, uint32_t sample_rate) {
    const uint32_t usual_half = (uint32_t)(WINDOW_SECONDS / 2.0 * sample_rate);
    uint32_t n = frames / 2;
    if (n < usual_half) {
        n = frames < usual_half ? frames : usual_half;
    }
    return n > SW_ANALYSIS_MAX_WINDOW / 2 ? SW_ANALYSIS_MAX_WINDOW / 2 : n;
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
    uint32_t frames,
    uint32_t sample_rate,
    sw_analysis_workspace* workspace,
    float* out_frequency_hz,
    float* out_clarity,
    float* out_level_db
) {
    const uint32_t n = sw_analysis_pitch_frames(frames, sample_rate);
    const float* centre = window + (frames - n) / 2;
    *out_level_db = rms_db(centre, n);
    *out_frequency_hz = sw_pitch_detect(
        centre, n, (float)sample_rate, workspace->re, workspace->im, workspace->nsdf, out_clarity
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
    uint32_t frames,
    uint32_t sample_rate,
    float noise_gate_db,
    sw_analysis_workspace* workspace,
    synthway_analysis_t* out
) {
    memset(out, 0, sizeof(*out));
    out->sample_rate = sample_rate;
    float frequency;
    sw_analysis_run_pitch(window, frames, sample_rate, workspace, &frequency, &out->clarity, &out->level_db);

    /* The spectrum of the whole window, padded with silence up to a power of two */
    const uint32_t fft_size = sw_analysis_fft_size(frames);
    sw_spectrum_compute(window, frames, fft_size, workspace->re, workspace->im, workspace->mag_db);
    sw_spectrum_find_partials(workspace->mag_db, frames, fft_size, (float)sample_rate, noise_gate_db, out);
    sw_spectrum_display(workspace->mag_db, fft_size, (float)sample_rate, out);

    /* Gated and nothing above the gate: only ambient noise is left, whatever
       period it may have (a fan's hum) */
    if (noise_gate_db > SW_SPECTRUM_FLOOR_DB && out->partial_count == 0) {
        frequency = 0.0f;
        out->clarity = 0.0f;
    }

    out->frequency_hz = sw_analysis_settle_fundamental(
        out, frequency, workspace->nsdf, sw_analysis_pitch_frames(frames, sample_rate)
    );
    for (uint32_t i = 0; i < out->partial_count; ++i) {
        out->partials[i].ratio = out->frequency_hz > 0.0f ? out->partials[i].frequency_hz / out->frequency_hz : 0.0f;
    }
}

/* --------------------------------------------------------------------------
   A zone: the medians of the analyses of its moments
   -------------------------------------------------------------------------- */
static int sw_compare_floats(const void* a, const void* b) {
    const float x = *(const float*)a, y = *(const float*)b;
    return (x > y) - (x < y);
}

static int sw_compare_peaks(const void* a, const void* b) {
    const float x = ((const sw_analysis_peak*)a)->key, y = ((const sw_analysis_peak*)b)->key;
    return (x > y) - (x < y);
}

/* Median of n values (they get sorted), 0 for none */
static float sw_median(float* values, uint32_t n) {
    if (n == 0) {
        return 0.0f;
    }
    qsort(values, n, sizeof(float), sw_compare_floats);
    return n % 2 ? values[n / 2] : 0.5f * (values[n / 2 - 1] + values[n / 2]);
}

/* The frequency moved by whole octaves next to reference, when it lies
   within REFERENCE_SEMITONES of one of reference's octaves; 0 otherwise */
static float sw_analysis_fold(float frequency, float reference) {
    if (frequency <= 0.0f || reference <= 0.0f) {
        return 0.0f;
    }
    const double octaves = log2((double)reference / frequency);
    const double whole = floor(octaves + 0.5);
    if (fabs(octaves - whole) * 12.0 > REFERENCE_SEMITONES) {
        return 0.0f;
    }
    return (float)(frequency * pow(2.0, whole));
}

/* Keeps the partials within harmonic_cents of a whole ratio (1, 2, 3…), the
   strongest one of each harmonic only, with amplitudes relative to the
   strongest kept; harmonic_cents 0 keeps them all. A weak peak a few tens of
   Hz from a high harmonic (a side of it, or another instrument) is no second
   partial: playing both makes them beat. */
static void sw_analysis_keep_harmonics(synthway_analysis_t* out, float harmonic_cents) {
    if (harmonic_cents <= 0.0f || out->frequency_hz <= 0.0f) {
        return;
    }
    uint32_t kept = 0;
    for (uint32_t i = 0; i < out->partial_count; ++i) {
        const float ratio = out->partials[i].ratio;
        const long n = lroundf(ratio);
        if (n < 1 || fabs(1200.0 * log2((double)ratio / n)) > harmonic_cents) {
            continue;
        }
        /* Sorted by frequency: another partial of this harmonic is the last one kept */
        if (kept > 0 && lroundf(out->partials[kept - 1].ratio) == n) {
            if (out->partials[i].amplitude > out->partials[kept - 1].amplitude) out->partials[kept - 1] = out->partials[i];
        } else {
            out->partials[kept++] = out->partials[i];
        }
    }
    float strongest = 0.0f;
    for (uint32_t i = 0; i < kept; ++i) {
        if (out->partials[i].amplitude > strongest) strongest = out->partials[i].amplitude;
    }
    for (uint32_t i = 0; i < kept && strongest > 0.0f; ++i) {
        out->partials[i].amplitude /= strongest;
    }
    out->partial_count = kept;
}

void sw_analysis_relate(synthway_analysis_t* out, float reference_hz, float harmonic_cents) {
    if (reference_hz > 0.0f) {
        /* The note heard, moved to the reference's octave, keeps the ratios
           true to its tuning; a note too far from it, or none, gives way */
        const float folded = out->clarity >= NOTE_CLARITY ? sw_analysis_fold(out->frequency_hz, reference_hz) : 0.0f;
        out->frequency_hz = folded > 0.0f ? folded : reference_hz;
        for (uint32_t i = 0; i < out->partial_count; ++i) {
            out->partials[i].ratio = out->partials[i].frequency_hz / out->frequency_hz;
        }
    }
    sw_analysis_keep_harmonics(out, harmonic_cents);
}

void sw_analysis_combine(
    const synthway_analysis_t* moments,
    uint32_t count,
    float reference_hz,
    float harmonic_cents,
    sw_analysis_peak* peaks,
    float* values,
    float* references,
    uint32_t* marks,
    synthway_analysis_t* out
) {
    memset(out, 0, sizeof(*out));
    out->sample_rate = moments[0].sample_rate;
    out->spectrum_min_hz = moments[0].spectrum_min_hz;
    out->spectrum_max_hz = moments[0].spectrum_max_hz;

    /* Level, clarity and spectrum: over every moment */
    for (uint32_t i = 0; i < count; ++i) values[i] = moments[i].level_db;
    out->level_db = sw_median(values, count);
    for (uint32_t i = 0; i < count; ++i) values[i] = moments[i].clarity;
    out->clarity = sw_median(values, count);
    for (uint32_t p = 0; p < SYNTHWAY_ANALYSIS_SPECTRUM_POINTS; ++p) {
        for (uint32_t i = 0; i < count; ++i) values[i] = moments[i].spectrum_db[p];
        out->spectrum_db[p] = sw_median(values, count);
    }

    /* The reference: the one given, or the low end of the clear notes heard,
       so that moments read an octave too high (a fundamental that fades
       first) do not lift it. Attacks and noise, unclear, have no say. */
    uint32_t notes = 0;
    for (uint32_t i = 0; i < count; ++i) {
        if (moments[i].frequency_hz > 0.0f && moments[i].clarity >= NOTE_CLARITY) {
            values[notes++] = log2f(moments[i].frequency_hz);
        }
    }
    float reference = reference_hz;
    if (reference <= 0.0f && notes > 0) {
        qsort(values, notes, sizeof(float), sw_compare_floats);
        reference = exp2f(values[(uint32_t)(REFERENCE_PERCENTILE * (notes - 1))]);
    }

    /* Each moment's own note, moved to the reference's octave: its partials
       are taken to it, so that vibrato and octave errors leave their ratios
       unchanged. A moment on another note, an attack or noise counts out. */
    uint32_t on_note = 0;
    for (uint32_t i = 0; i < count; ++i) {
        references[i] = moments[i].clarity >= NOTE_CLARITY ? sw_analysis_fold(moments[i].frequency_hz, reference) : 0.0f;
        if (references[i] > 0.0f) values[on_note++] = references[i];
    }
    bool by_ratio = on_note > 0 && (reference_hz > 0.0f || on_note >= MIN_ON_NOTE_SHARE * count);
    if (by_ratio) {
        out->frequency_hz = sw_median(values, on_note);
    } else if (reference_hz > 0.0f) {
        /* Given, but heard nowhere: every moment is taken to it as it is */
        for (uint32_t i = 0; i < count; ++i) references[i] = reference_hz;
        on_note = count;
        out->frequency_hz = reference_hz;
        by_ratio = true;
    }
    const uint32_t counted = by_ratio ? on_note : count;

    /* Every partial of the moments that count, by ratio (or frequency) */
    uint32_t peak_count = 0;
    for (uint32_t i = 0; i < count; ++i) {
        marks[i] = UINT32_MAX;
        if (by_ratio && references[i] <= 0.0f) {
            continue;
        }
        for (uint32_t j = 0; j < moments[i].partial_count; ++j) {
            const synthway_analysis_partial_t* partial = &moments[i].partials[j];
            peaks[peak_count].key = by_ratio ? partial->frequency_hz / references[i] : partial->frequency_hz;
            peaks[peak_count].amplitude = partial->amplitude;
            peaks[peak_count].moment = i;
            peak_count++;
        }
    }
    qsort(peaks, peak_count, sizeof(sw_analysis_peak), sw_compare_peaks);

    /* A group of keys, each within MATCH_TOLERANCE of the group's median as it
       grows (so a partial smeared by vibrato, spread around its ratio, stays
       one, while a run of scattered noise peaks cannot grow far), is one
       partial, kept when found in at least half the moments that count */
    uint32_t kept = 0;
    for (uint32_t first = 0; first < peak_count;) {
        uint32_t end = first + 1;
        while (end < peak_count && peaks[end].key <= peaks[(first + end) / 2].key * (1.0f + MATCH_TOLERANCE)) {
            end++;
        }
        uint32_t found_in = 0;
        for (uint32_t k = first; k < end; ++k) {
            if (marks[peaks[k].moment] != first) {
                marks[peaks[k].moment] = first;
                found_in++;
            }
        }
        if (2 * found_in >= counted) {
            for (uint32_t k = first; k < end; ++k) values[k - first] = peaks[k].key;
            const float key = sw_median(values, end - first);
            for (uint32_t k = first; k < end; ++k) values[k - first] = peaks[k].amplitude;
            const float amplitude = sw_median(values, end - first);

            uint32_t slot = kept;
            if (kept == SYNTHWAY_ANALYSIS_MAX_PARTIALS) {
                /* Full: replaces the weakest, if weaker than this one */
                slot = 0;
                for (uint32_t i = 1; i < kept; ++i) {
                    if (out->partials[i].amplitude < out->partials[slot].amplitude) slot = i;
                }
                if (out->partials[slot].amplitude >= amplitude) slot = UINT32_MAX;
            } else {
                kept++;
            }
            if (slot != UINT32_MAX) {
                out->partials[slot].ratio = by_ratio ? key : 0.0f;
                out->partials[slot].frequency_hz = by_ratio ? key * out->frequency_hz : key;
                out->partials[slot].amplitude = amplitude;
            }
        }
        first = end;
    }

    /* By frequency, relative to the strongest */
    float strongest = 0.0f;
    for (uint32_t i = 0; i < kept; ++i) {
        const synthway_analysis_partial_t partial = out->partials[i];
        uint32_t j = i;
        for (; j > 0 && out->partials[j - 1].frequency_hz > partial.frequency_hz; --j) {
            out->partials[j] = out->partials[j - 1];
        }
        out->partials[j] = partial;
        if (partial.amplitude > strongest) strongest = partial.amplitude;
    }
    for (uint32_t i = 0; i < kept && strongest > 0.0f; ++i) {
        out->partials[i].amplitude /= strongest;
    }
    out->partial_count = kept;
    sw_analysis_keep_harmonics(out, harmonic_cents);
}

/* --------------------------------------------------------------------------
   The envelope of a partial over a note
   -------------------------------------------------------------------------- */
/* The attack starts where the level comes within this of the peak */
#define ENVELOPE_ONSET_DB 20.0f
/* This far below its peak, a partial has faded out */
#define ENVELOPE_FLOOR_DB 60.0f
/* A rise of this over the lowest level since the peak: the next note */
#define ENVELOPE_NEW_NOTE_DB 6.0f
/* Falling slower than this, a partial is held */
#define ENVELOPE_HELD_DB_PER_S 3.0f
/* Release of a note let go, which a note cut by the next one gives no hint of:
   this at most, as a damper stops a string (a partial fading faster keeps its speed) */
#define ENVELOPE_RELEASE_S 0.3f
#define ENVELOPE_MAX_S 10.0f
#define ENVELOPE_MIN_ATTACK_S 0.002f

float sw_analysis_tone_amplitude(
    const float* x,
    const float* weights,
    uint32_t n,
    double weights_sum,
    double frequency,
    double sample_rate
) {
    const double coefficient = 2.0 * cos(6.283185307179586 * frequency / sample_rate);
    double s1 = 0.0, s2 = 0.0;
    for (uint32_t i = 0; i < n; ++i) {
        const double s0 = x[i] * weights[i] + coefficient * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const double power = s1 * s1 + s2 * s2 - coefficient * s1 * s2;
    return power > 0.0 ? (float)(2.0 * sqrt(power) / weights_sum) : 0.0f;
}

/* Least-squares slope of levels[first..end), in dB per second */
static double sw_slope(const float* levels, uint32_t first, uint32_t end, double step_s) {
    const double n = end - first;
    double sum_t = 0.0, sum_y = 0.0, sum_tt = 0.0, sum_ty = 0.0;
    for (uint32_t i = first; i < end; ++i) {
        const double t = (i - first) * step_s, y = levels[i];
        sum_t += t;
        sum_y += y;
        sum_tt += t * t;
        sum_ty += t * y;
    }
    const double spread = n * sum_tt - sum_t * sum_t;
    return spread > 0.0 ? (n * sum_ty - sum_t * sum_y) / spread : 0.0;
}

static float sw_clamp_seconds(double seconds, float lowest) {
    return (float)(seconds < lowest ? lowest : (seconds > ENVELOPE_MAX_S ? ENVELOPE_MAX_S : seconds));
}

void sw_analysis_fit_envelope(
    const float* levels_db,
    uint32_t count,
    double step_s,
    double window_s,
    synthway_envelope_t* out,
    float* out_peak_db
) {
    out->attack_s = ENVELOPE_MIN_ATTACK_S;
    out->decay_s = 0.0f;
    out->sustain_level = 1.0f;
    out->release_s = ENVELOPE_RELEASE_S;
    out->curve = SYNTHWAY_ENVELOPE_EXPONENTIAL;
    out->attack_curve = SYNTHWAY_ATTACK_LINEAR;
    out->release_curve = SYNTHWAY_ENVELOPE_EXPONENTIAL;
    *out_peak_db = SW_SPECTRUM_FLOOR_DB;
    if (count == 0) {
        return;
    }

    uint32_t peak = 0;
    for (uint32_t i = 1; i < count; ++i) {
        if (levels_db[i] > levels_db[peak]) peak = i;
    }
    const float top = levels_db[peak];
    *out_peak_db = top;

    /* The attack: from where the level comes within ENVELOPE_ONSET_DB of the
       peak, less half the window, which smears an instant rise */
    uint32_t onset = peak;
    while (onset > 0 && levels_db[onset - 1] >= top - ENVELOPE_ONSET_DB) onset--;
    out->attack_s = sw_clamp_seconds((peak - onset) * step_s - 0.5 * window_s, ENVELOPE_MIN_ATTACK_S);

    /* After the peak: until the partial fades out or the next note rises */
    uint32_t end = peak + 1;
    float lowest = top;
    while (end < count) {
        const float level = levels_db[end];
        if (level < top - ENVELOPE_FLOOR_DB || (end > peak + 2 && level > lowest + ENVELOPE_NEW_NOTE_DB)) break;
        if (level < lowest) lowest = level;
        end++;
    }
    const uint32_t length = end - peak;
    if (length < 4) {
        return; /* too short to tell: held */
    }
    const double slope = sw_slope(levels_db, peak, end, step_s);
    if (slope > -ENVELOPE_HELD_DB_PER_S) {
        return; /* held */
    }

    const uint32_t third = length / 3;
    const double early = sw_slope(levels_db, peak, peak + length / 2, step_s);
    const double late = third >= 3 ? sw_slope(levels_db, end - third, end, step_s) : slope;
    if (third >= 3 && late > -ENVELOPE_HELD_DB_PER_S && early < -2.0 * ENVELOPE_HELD_DB_PER_S) {
        /* It levels off: a decay to the level of its last third */
        enum { TAIL_MAX = 256 }; /* a third of the longest track, 400 levels */
        float tail[TAIL_MAX];
        uint32_t taken = 0;
        for (uint32_t i = end - third; i < end && taken < TAIL_MAX; ++i) tail[taken++] = levels_db[i];
        const float held = sw_median(tail, taken);
        const float sustain = powf(10.0f, (held - top) / 20.0f);
        out->sustain_level = sustain;
        /* The decay is the fall of the part above that level (as the engine
           plays it), followed while it stands out: above 3 % of its start */
        enum { EXCESS_MAX = 512 };
        float excess[EXCESS_MAX];
        uint32_t points = 0;
        for (uint32_t i = peak; i < end && points < EXCESS_MAX && sustain < 0.99f; ++i) {
            const float above = (powf(10.0f, (levels_db[i] - top) / 20.0f) - sustain) / (1.0f - sustain);
            if (above <= 0.03f) break;
            excess[points++] = (float)(20.0 * log10(above));
        }
        const double fall = points >= 3 ? sw_slope(excess, 0, points, step_s) : early;
        out->decay_s = sw_clamp_seconds(fall < 0.0 ? 60.0 / -fall : ENVELOPE_MAX_S, 0.01f);
    } else {
        out->sustain_level = 0.0f;
        out->decay_s = sw_clamp_seconds(60.0 / -slope, 0.01f);
        out->release_s = out->decay_s < ENVELOPE_RELEASE_S ? out->decay_s : ENVELOPE_RELEASE_S;
    }
}
