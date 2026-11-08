/*
 * Analysis test: renders known sounds with the engine, offline, then checks
 * that the analyzer finds their note and their partials back. No audio device
 * is opened, nothing is played; recordings come from a virtual microphone fed
 * by the test. Exit code 0 when every check passes.
 *
 * Usage: synthway_analysis_test [path/to/scratch.wav]
 */
#include "synthway/synthway.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SAMPLE_RATE 48000
#define SECONDS_RENDERED 0.5

static int failures = 0;
static synthway_analyzer_t* analyzer = NULL;

static void check(int ok, const char* name, const char* detail) {
    printf("[%s] %s (%s)\n", ok ? "PASS" : "FAIL", name, detail);
    if (!ok) {
        failures++;
    }
}

static double cents(double frequency, double expected) {
    return frequency > 0.0 ? 1200.0 * log2(frequency / expected) : 1e9;
}

/* Renders frames of a mono note, with the engine's default volume */
static float* render_note(
    float frequency,
    synthway_waveform_t waveform,
    const synthway_timbre_t* timbre,
    uint32_t sample_rate,
    uint32_t frames
) {
    synthway_engine_t* engine = synthway_engine_create();
    synthway_engine_config_t config;
    memset(&config, 0, sizeof(config));
    config.sample_rate = sample_rate;
    config.channels = 1;
    float* samples = (float*)malloc(sizeof(float) * frames);
    if (!engine || !samples || synthway_engine_init_offline(engine, &config) != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Cannot create an offline engine\n");
        exit(2);
    }
    synthway_engine_set_waveform(engine, waveform);
    synthway_engine_set_frequency(engine, frequency);
    synthway_engine_set_volume(engine, 0.5f);
    if (timbre) {
        synthway_engine_set_timbre(engine, timbre);
    }
    synthway_engine_set_tone_enabled(engine, true);
    if (synthway_engine_render(engine, samples, frames) != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Rendering failed\n");
        exit(2);
    }
    synthway_engine_destroy(engine);
    return samples;
}

static synthway_analysis_t analyze_note(
    float frequency,
    synthway_waveform_t waveform,
    const synthway_timbre_t* timbre,
    uint32_t sample_rate
) {
    const uint32_t frames = (uint32_t)(SECONDS_RENDERED * sample_rate);
    float* samples = render_note(frequency, waveform, timbre, sample_rate, frames);
    synthway_analysis_t analysis;
    if (synthway_analyzer_analyze_samples(analyzer, samples, frames, sample_rate, &analysis) != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Analysis failed\n");
        exit(2);
    }
    free(samples);
    return analysis;
}

static synthway_timbre_t sine_timbre(uint32_t count, const float* ratios, const float* amplitudes) {
    synthway_timbre_t timbre;
    memset(&timbre, 0, sizeof(timbre));
    timbre.partial_count = count;
    for (uint32_t i = 0; i < count; ++i) {
        timbre.partials[i].ratio = ratios[i];
        timbre.partials[i].amplitude = amplitudes[i];
        timbre.partials[i].waveform = SYNTHWAY_WAVEFORM_SINE;
        timbre.partials[i].envelope.attack_s = 0.005f;
        timbre.partials[i].envelope.sustain_level = 1.0f;
        timbre.partials[i].envelope.release_s = 0.01f;
    }
    return timbre;
}

/* The partial found closest to frequency, or NULL */
static const synthway_analysis_partial_t* partial_near(const synthway_analysis_t* a, double frequency) {
    const synthway_analysis_partial_t* best = NULL;
    for (uint32_t i = 0; i < a->partial_count; ++i) {
        if (!best || fabs(a->partials[i].frequency_hz - frequency) < fabs(best->frequency_hz - frequency)) {
            best = &a->partials[i];
        }
    }
    return best;
}

static void test_sine_notes(void) {
    static const struct {
        float frequency;
        uint32_t sample_rate;
        const char* name;
    } cases[] = {
        { 440.0f, 48000, "A4 sine at 48 kHz" },
        { 440.0f, 44100, "A4 sine at 44.1 kHz" },
        { 41.2034f, 48000, "E1 sine (lowest bass string)" },
        { 2093.005f, 48000, "C7 sine" },
        { 4186.009f, 48000, "C8 sine (top of the piano)" },
    };
    for (size_t c = 0; c < sizeof(cases) / sizeof(cases[0]); ++c) {
        synthway_analysis_t a = analyze_note(cases[c].frequency, SYNTHWAY_WAVEFORM_SINE, NULL, cases[c].sample_rate);
        const double error = cents(a.frequency_hz, cases[c].frequency);
        const synthway_analysis_partial_t* p = partial_near(&a, cases[c].frequency);
        char detail[160];
        snprintf(detail, sizeof(detail), "%.3f Hz (%+.3f cents), clarity %.3f, %u partial(s), first at %.3f Hz",
                 a.frequency_hz, error, a.clarity, a.partial_count, p ? p->frequency_hz : 0.0f);
        check(fabs(error) < 1.0 && a.clarity > 0.95 && a.partial_count == 1 && p
                  && fabs(cents(p->frequency_hz, cases[c].frequency)) < 2.0 && fabs(p->ratio - 1.0f) < 0.002f,
              cases[c].name, detail);
    }
}

static void test_level(void) {
    /* A sine of amplitude 0.5: RMS 0.354, -9.03 dBFS; it peaks at -6.02 dB in the spectrum */
    synthway_analysis_t a = analyze_note(440.0f, SYNTHWAY_WAVEFORM_SINE, NULL, SAMPLE_RATE);
    const uint32_t points = SYNTHWAY_ANALYSIS_SPECTRUM_POINTS;
    float top = -1000.0f;
    uint32_t top_index = 0;
    for (uint32_t i = 0; i < points; ++i) {
        if (a.spectrum_db[i] > top) {
            top = a.spectrum_db[i];
            top_index = i;
        }
    }
    const double top_hz = a.spectrum_min_hz * pow(a.spectrum_max_hz / a.spectrum_min_hz, (double)top_index / (points - 1));
    char detail[160];
    snprintf(detail, sizeof(detail), "level %.2f dB, spectrum peak %.2f dB at %.0f Hz, range %.0f to %.0f Hz",
             a.level_db, top, top_hz, a.spectrum_min_hz, a.spectrum_max_hz);
    check(fabs(a.level_db + 9.03) < 0.1 && fabs(top + 6.02) < 0.5 && fabs(cents(top_hz, 440.0)) < 50.0
              && a.spectrum_min_hz == 20.0f && a.spectrum_max_hz == 20000.0f,
          "level and display spectrum of a sine", detail);
}

static void test_sawtooth_harmonics(void) {
    /* A sawtooth holds every harmonic n at amplitude 1/n */
    synthway_analysis_t a = analyze_note(220.0f, SYNTHWAY_WAVEFORM_SAWTOOTH, NULL, SAMPLE_RATE);
    double worst_ratio = 0.0, worst_amplitude = 0.0;
    int found = 0;
    for (int n = 1; n <= 12; ++n) {
        const synthway_analysis_partial_t* p = partial_near(&a, 220.0 * n);
        if (!p || fabs(p->frequency_hz - 220.0 * n) > 2.0) {
            continue;
        }
        found++;
        if (fabs(p->ratio - n) > worst_ratio) worst_ratio = fabs(p->ratio - n);
        const double expected = 1.0 / n;
        if (fabs(p->amplitude - expected) / expected > worst_amplitude) {
            worst_amplitude = fabs(p->amplitude - expected) / expected;
        }
    }
    char detail[160];
    snprintf(detail, sizeof(detail), "%.3f Hz, %d/12 harmonics, ratios within %.4f, amplitudes within %.1f %%",
             a.frequency_hz, found, worst_ratio, 100.0 * worst_amplitude);
    check(fabs(cents(a.frequency_hz, 220.0)) < 1.0 && found == 12 && worst_ratio < 0.002 && worst_amplitude < 0.05,
          "sawtooth: harmonics at 1/n", detail);
}

static void test_inharmonic_timbre(void) {
    /* A bell-like timbre, as rendered from an Instrument Creator card */
    static const float ratios[] = { 1.0f, 2.76f, 5.4f, 8.93f };
    static const float amplitudes[] = { 0.6f, 0.3f, 0.15f, 0.08f };
    synthway_timbre_t timbre = sine_timbre(4, ratios, amplitudes);
    synthway_analysis_t a = analyze_note(220.0f, SYNTHWAY_WAVEFORM_SINE, &timbre, SAMPLE_RATE);

    int ok = a.partial_count == 4 && fabs(cents(a.frequency_hz, 220.0)) < 2.0;
    char detail[256];
    int length = snprintf(detail, sizeof(detail), "%.3f Hz, %u partials:", a.frequency_hz, a.partial_count);
    for (uint32_t i = 0; i < a.partial_count && length < (int)sizeof(detail); ++i) {
        length += snprintf(detail + length, sizeof(detail) - length, " %.3f@%.3f", a.partials[i].ratio, a.partials[i].amplitude);
    }
    for (uint32_t i = 0; ok && i < 4; ++i) {
        ok = fabs(a.partials[i].ratio - ratios[i]) < 0.003
             && fabs(a.partials[i].amplitude - amplitudes[i] / amplitudes[0]) < 0.02;
    }
    check(ok, "timbre: inharmonic partials found back", detail);
}

static void test_bell_is_not_a_missing_fundamental(void) {
    /* Partials 1, 2, 2.76 and 5.4 line up every 3 periods (3, 6, 8.28, 16.2 of
       a third of the note), but 8.28 is no harmonic: the note is the first partial */
    static const float ratios[] = { 1.0f, 2.0f, 2.76f, 5.4f };
    static const float amplitudes[] = { 0.6f, 0.3f, 0.25f, 0.12f };
    synthway_timbre_t timbre = sine_timbre(4, ratios, amplitudes);
    synthway_analysis_t a = analyze_note(196.0f, SYNTHWAY_WAVEFORM_SINE, &timbre, SAMPLE_RATE);
    char detail[128];
    snprintf(detail, sizeof(detail), "%.3f Hz, clarity %.3f, ratios %.3f %.3f %.3f %.3f", a.frequency_hz, a.clarity,
             a.partials[0].ratio, a.partials[1].ratio, a.partials[2].ratio, a.partials[3].ratio);
    check(a.partial_count == 4 && fabs(cents(a.frequency_hz, 196.0)) < 2.0 && fabs(a.partials[2].ratio - 2.76f) < 0.003f,
          "bell: partials lining up every 3 periods are no missing fundamental", detail);
}

static void test_missing_fundamental(void) {
    /* Harmonics 2, 3 and 4 of 200 Hz, without 200 Hz itself: the ear hears
       200 Hz, and so must the analyzer */
    static const float ratios[] = { 2.0f, 3.0f, 4.0f };
    static const float amplitudes[] = { 0.5f, 0.4f, 0.3f };
    synthway_timbre_t timbre = sine_timbre(3, ratios, amplitudes);
    synthway_analysis_t a = analyze_note(200.0f, SYNTHWAY_WAVEFORM_SINE, &timbre, SAMPLE_RATE);
    char detail[128];
    snprintf(detail, sizeof(detail), "%.3f Hz, clarity %.3f, first partial ratio %.3f",
             a.frequency_hz, a.clarity, a.partial_count ? a.partials[0].ratio : 0.0f);
    check(fabs(cents(a.frequency_hz, 200.0)) < 2.0 && a.partial_count == 3 && fabs(a.partials[0].ratio - 2.0f) < 0.005f,
          "missing fundamental: the note heard, not the lowest partial", detail);
}

static void test_silence_and_noise(void) {
    const uint32_t frames = SAMPLE_RATE / 2;
    float* x = (float*)calloc(frames, sizeof(float));
    synthway_analysis_t a;
    synthway_analyzer_analyze_samples(analyzer, x, frames, SAMPLE_RATE, &a);
    char detail[128];
    snprintf(detail, sizeof(detail), "%.1f Hz, level %.1f dB, %u partial(s), spectrum %.1f dB",
             a.frequency_hz, a.level_db, a.partial_count, a.spectrum_db[100]);
    check(a.frequency_hz == 0.0f && a.clarity == 0.0f && a.level_db <= -120.0f && a.partial_count == 0
              && a.spectrum_db[100] <= -120.0f,
          "silence: no note, no partial", detail);

    /* White noise from a fixed generator: no period stands out */
    uint32_t state = 12345u;
    for (uint32_t i = 0; i < frames; ++i) {
        state = state * 1664525u + 1013904223u;
        x[i] = 0.3f * ((float)(state >> 8) / 8388608.0f - 1.0f);
    }
    synthway_analyzer_analyze_samples(analyzer, x, frames, SAMPLE_RATE, &a);
    snprintf(detail, sizeof(detail), "clarity %.3f, level %.1f dB", a.clarity, a.level_db);
    check(a.clarity < 0.5f, "white noise: low clarity", detail);

    /* Noise with only high frequencies (each sample minus the previous one):
       its candidate periods sit at the edge of the search range, where the
       interpolation must not run away. The note stays finite: a NaN or an
       infinity would break the JSON sent to the UI. */
    int finite = 1;
    for (int pass = 0; pass < 20 && finite; ++pass) {
        float previous = 0.0f;
        for (uint32_t i = 0; i < frames; ++i) {
            state = state * 1664525u + 1013904223u;
            const float white = (float)(state >> 8) / 8388608.0f - 1.0f;
            x[i] = 0.3f * (white - previous);
            previous = white;
        }
        synthway_analyzer_analyze_samples(analyzer, x, frames, SAMPLE_RATE, &a);
        finite = isfinite(a.frequency_hz) && a.frequency_hz >= 0.0f && isfinite(a.clarity) && isfinite(a.level_db);
        for (uint32_t i = 0; finite && i < a.partial_count; ++i) {
            finite = isfinite(a.partials[i].ratio) && isfinite(a.partials[i].frequency_hz);
        }
    }
    snprintf(detail, sizeof(detail), "20 windows, last %.1f Hz, clarity %.3f", a.frequency_hz, a.clarity);
    check(finite, "high-pitched noise: every value stays finite", detail);
    free(x);
}

static void test_held_note(void) {
    /* A note held for 8 seconds reads the same from start to end: nothing in
       the analysis depends on how long a note lasts */
    const uint32_t frames = 8 * SAMPLE_RATE;
    float* x = render_note(196.0f, SYNTHWAY_WAVEFORM_SAWTOOTH, NULL, SAMPLE_RATE, frames);
    double lowest = 1e9, highest = 0.0, quietest = 0.0;
    for (int second = 1; second < 8; ++second) {
        synthway_analysis_t a;
        synthway_analyzer_analyze_samples(analyzer, x + (second - 1) * SAMPLE_RATE, 2 * SAMPLE_RATE, SAMPLE_RATE, &a);
        if (a.frequency_hz < lowest) lowest = a.frequency_hz;
        if (a.frequency_hz > highest) highest = a.frequency_hz;
        if (a.level_db < quietest) quietest = a.level_db;
    }
    char detail[128];
    snprintf(detail, sizeof(detail), "1 to 7 s: %.3f to %.3f Hz, level down to %.1f dB", lowest, highest, quietest);
    check(fabs(cents(lowest, 196.0)) < 1.0 && fabs(cents(highest, 196.0)) < 1.0 && quietest > -12.0,
          "held note: same reading for 8 seconds", detail);
    free(x);
}

/* Adds a room's noise to x: a soft hiss and a 100 Hz hum, both around -55 dBFS */
static void add_ambient_noise(float* x, uint32_t frames) {
    uint32_t state = 777u;
    for (uint32_t i = 0; i < frames; ++i) {
        state = state * 1664525u + 1013904223u;
        const float hiss = 0.003f * ((float)(state >> 8) / 8388608.0f - 1.0f);
        const float hum = 0.002f * sinf(6.2831853f * 100.0f * (float)i / SAMPLE_RATE);
        x[i] += hiss + hum;
    }
}

static int has_partial_near(const synthway_analysis_t* a, double frequency) {
    const synthway_analysis_partial_t* p = partial_near(a, frequency);
    return p && fabs(p->frequency_hz - frequency) < 3.0;
}

static void test_noise_gate(void) {
    const uint32_t frames = SAMPLE_RATE / 2;
    float* room = (float*)calloc(frames, sizeof(float));
    add_ambient_noise(room, frames);
    float* note = render_note(220.0f, SYNTHWAY_WAVEFORM_SAWTOOTH, NULL, SAMPLE_RATE, frames);
    add_ambient_noise(note, frames);

    /* Gate off (the default): the room's hum is a partial, as measured */
    synthway_analysis_t off, room_off, gated_room, gated_note;
    synthway_analyzer_analyze_samples(analyzer, room, frames, SAMPLE_RATE, &room_off);
    synthway_analyzer_analyze_samples(analyzer, note, frames, SAMPLE_RATE, &off);
    synthway_analyzer_set_noise_gate(analyzer, SYNTHWAY_ANALYZER_NOISE_GATE_OFF);
    synthway_analysis_t off_again;
    synthway_analyzer_analyze_samples(analyzer, note, frames, SAMPLE_RATE, &off_again);
    char detail[160];
    snprintf(detail, sizeof(detail), "room alone: %u partial(s), hum %s", room_off.partial_count,
             has_partial_near(&room_off, 100.0) ? "found" : "missing");
    check(has_partial_near(&room_off, 100.0) && memcmp(&off, &off_again, sizeof(off)) == 0,
          "noise gate off: changes nothing, the hum is heard", detail);

    /* Gate at -40 dBFS: the room alone is silence, the note keeps its harmonics without the hum */
    synthway_result_t set = synthway_analyzer_set_noise_gate(analyzer, -40.0f);
    synthway_analyzer_analyze_samples(analyzer, room, frames, SAMPLE_RATE, &gated_room);
    synthway_analyzer_analyze_samples(analyzer, note, frames, SAMPLE_RATE, &gated_note);
    int harmonics = 0;
    for (int n = 1; n <= 20; ++n) harmonics += has_partial_near(&gated_note, 220.0 * n);
    snprintf(detail, sizeof(detail), "room: %u partial(s), %.1f Hz; note: %.3f Hz, %d/20 harmonics, hum %s, level %.1f dB",
             gated_room.partial_count, gated_room.frequency_hz, gated_note.frequency_hz, harmonics,
             has_partial_near(&gated_note, 100.0) ? "kept" : "gone", gated_room.level_db);
    check(set == SYNTHWAY_OK && gated_room.partial_count == 0 && gated_room.frequency_hz == 0.0f
              && gated_room.level_db == room_off.level_db
              && fabs(cents(gated_note.frequency_hz, 220.0)) < 1.0 && harmonics == 20
              && !has_partial_near(&gated_note, 100.0),
          "noise gate at -40 dBFS: the room is ignored, the note is not", detail);

    /* Out of range: refused, the gate in place is kept */
    const int refused = synthway_analyzer_set_noise_gate(analyzer, 1.0f) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_set_noise_gate(analyzer, -121.0f) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_set_noise_gate(analyzer, NAN) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_set_noise_gate(NULL, -40.0f) == SYNTHWAY_INVALID_PARAM;
    const float kept = synthway_analyzer_get_noise_gate(analyzer);
    synthway_analyzer_set_noise_gate(analyzer, SYNTHWAY_ANALYZER_NOISE_GATE_OFF);
    snprintf(detail, sizeof(detail), "kept %.1f dB", kept);
    check(refused && kept == -40.0f, "noise gate: invalid values refused", detail);
    free(room);
    free(note);
}

static void test_clip(const char* path) {
    /* A one-second sawtooth at 330 Hz, written by the engine */
    synthway_engine_t* engine = synthway_engine_create();
    synthway_engine_config_t config;
    memset(&config, 0, sizeof(config));
    config.sample_rate = SAMPLE_RATE;
    config.channels = 2;
    synthway_engine_init_offline(engine, &config);
    synthway_engine_set_waveform(engine, SYNTHWAY_WAVEFORM_SAWTOOTH);
    synthway_engine_set_frequency(engine, 330.0f);
    synthway_engine_set_volume(engine, 0.5f);
    synthway_engine_set_tone_enabled(engine, true);
    synthway_result_t res = synthway_engine_render_to_wav(engine, path, SAMPLE_RATE);
    synthway_engine_destroy(engine);
    if (res != SYNTHWAY_OK) {
        check(0, "clip: WAV written", synthway_result_to_string(res));
        return;
    }

    res = synthway_analyzer_load_clip(analyzer, path);
    uint64_t frames = 0;
    uint32_t rate = 0;
    synthway_analyzer_get_clip_info(analyzer, &frames, &rate);
    synthway_analysis_t a;
    memset(&a, 0, sizeof(a));
    synthway_analyzer_analyze_clip(analyzer, 0.5, &a);
    char detail[160];
    snprintf(detail, sizeof(detail), "%s, %llu frames at %u Hz, %.3f Hz at 0.5 s",
             synthway_result_to_string(res), (unsigned long long)frames, rate, a.frequency_hz);
    check(res == SYNTHWAY_OK && frames == SAMPLE_RATE && rate == SAMPLE_RATE && fabs(cents(a.frequency_hz, 330.0)) < 1.0,
          "clip: WAV file loaded and analyzed", detail);

    enum { POINTS = 20 };
    float frequency[POINTS], clarity[POINTS], level[POINTS], peaks[POINTS];
    synthway_analyzer_get_clip_track(analyzer, POINTS, frequency, clarity, level);
    synthway_analyzer_get_clip_overview(analyzer, peaks, POINTS);
    int on_note = 0;
    float lowest_peak = 1.0f, highest_peak = 0.0f;
    for (int i = 0; i < POINTS; ++i) {
        on_note += fabs(cents(frequency[i], 330.0)) < 1.0 && clarity[i] > 0.9f;
        if (peaks[i] < lowest_peak) lowest_peak = peaks[i];
        if (peaks[i] > highest_peak) highest_peak = peaks[i];
    }
    snprintf(detail, sizeof(detail), "%d/%d points on the note, peaks %.3f to %.3f", on_note, POINTS, lowest_peak, highest_peak);
    /* The first and last points straddle the edges, half in silence */
    check(on_note >= POINTS - 2 && lowest_peak > 0.45f && highest_peak < 0.51f, "clip: note track and waveform overview", detail);

    /* The waveform of a part: the whole swing of the sawtooth in each of POINTS parts, then
       each of 64 samples, whose lowest and highest are those of the same 64 frames as one part */
    float left_low[POINTS], left_high[POINTS], right_low[POINTS], right_high[POINTS];
    synthway_result_t whole = synthway_analyzer_get_clip_waveform(
        analyzer, 0, frames, POINTS, left_low, left_high, right_low, right_high);
    int swinging = 0, same_channels = 1;
    for (int i = 1; i < POINTS - 1; ++i) {
        swinging += left_low[i] < -0.45f && left_high[i] > 0.45f && left_low[i] > -0.51f && left_high[i] < 0.51f;
    }
    for (int i = 0; i < POINTS; ++i) {
        same_channels &= left_low[i] == right_low[i] && left_high[i] == right_high[i];
    }
    enum { SAMPLES = 64 };
    float sample_low[SAMPLES], sample_high[SAMPLES], unused_low[SAMPLES], unused_high[SAMPLES];
    float part_low, part_high, part_right_low, part_right_high;
    synthway_result_t each = synthway_analyzer_get_clip_waveform(
        analyzer, SAMPLE_RATE / 2, SAMPLES, SAMPLES, sample_low, sample_high, unused_low, unused_high);
    synthway_result_t one = synthway_analyzer_get_clip_waveform(
        analyzer, SAMPLE_RATE / 2, SAMPLES, 1, &part_low, &part_high, &part_right_low, &part_right_high);
    int single = 1;
    float lowest = 1.0f, highest = -1.0f;
    for (int i = 0; i < SAMPLES; ++i) {
        single &= sample_low[i] == sample_high[i];
        if (sample_low[i] < lowest) lowest = sample_low[i];
        if (sample_high[i] > highest) highest = sample_high[i];
    }
    /* Past the end: the range stops there; starting past it or without parts is refused */
    synthway_result_t past = synthway_analyzer_get_clip_waveform(
        analyzer, frames - 8, SAMPLES, SAMPLES, sample_low, sample_high, unused_low, unused_high);
    int refused = synthway_analyzer_get_clip_waveform(analyzer, frames, 1, 1, &part_low, &part_high, &part_right_low, &part_right_high) == SYNTHWAY_INVALID_PARAM
        && synthway_analyzer_get_clip_waveform(analyzer, 0, frames, 0, &part_low, &part_high, &part_right_low, &part_right_high) == SYNTHWAY_INVALID_PARAM;
    snprintf(detail, sizeof(detail), "%d/%d parts swinging, %s, samples %.3f to %.3f, one part %.3f to %.3f",
             swinging, POINTS - 2, same_channels ? "same channels" : "channels differ", lowest, highest, part_low, part_high);
    check(whole == SYNTHWAY_OK && each == SYNTHWAY_OK && one == SYNTHWAY_OK && past == SYNTHWAY_OK && refused
              && swinging == POINTS - 2 && same_channels && single && lowest == part_low && highest == part_high,
          "clip: waveform of a part, down to its samples", detail);

    /* The same file from memory, as the server receives it */
    FILE* file = fopen(path, "rb");
    long size = 0;
    unsigned char* bytes = NULL;
    if (file && fseek(file, 0, SEEK_END) == 0 && (size = ftell(file)) > 0 && fseek(file, 0, SEEK_SET) == 0) {
        bytes = (unsigned char*)malloc((size_t)size);
        if (bytes && fread(bytes, 1, (size_t)size, file) != (size_t)size) {
            free(bytes);
            bytes = NULL;
        }
    }
    if (file) fclose(file);
    res = bytes ? synthway_analyzer_load_clip_memory(analyzer, bytes, (size_t)size) : SYNTHWAY_IO_ERROR;
    free(bytes);
    synthway_analyzer_analyze_clip(analyzer, 0.25, &a);
    snprintf(detail, sizeof(detail), "%s, %.3f Hz at 0.25 s", synthway_result_to_string(res), a.frequency_hz);
    check(res == SYNTHWAY_OK && fabs(cents(a.frequency_hz, 330.0)) < 1.0, "clip: same file from memory", detail);

    /* Not audio: refused, and the previous clip is gone */
    static const char garbage[] = "this is not an audio file, only a sentence long enough to be tried";
    res = synthway_analyzer_load_clip_memory(analyzer, garbage, sizeof(garbage));
    synthway_analyzer_get_clip_info(analyzer, &frames, &rate);
    snprintf(detail, sizeof(detail), "%s, %llu frames left", synthway_result_to_string(res), (unsigned long long)frames);
    check(res == SYNTHWAY_FORMAT_ERROR && frames == 0
              && synthway_analyzer_analyze_clip(analyzer, 0.0, &a) == SYNTHWAY_INVALID_PARAM,
          "clip: a file that is not audio is refused", detail);

    res = synthway_analyzer_load_clip(analyzer, "this/file/does/not/exist.wav");
    check(res == SYNTHWAY_IO_ERROR, "clip: a missing file is an I/O error", synthway_result_to_string(res));
}

static void test_recording(const char* path) {
    /* A virtual microphone hears a 2-second sawtooth at 262 Hz, by blocks of
       480 frames as a capture thread would; the analyzer is called every
       50 ms, as by the server */
    enum { BLOCK = 480 };
    const uint32_t frames = 2 * SAMPLE_RATE;
    float* note = render_note(261.63f, SYNTHWAY_WAVEFORM_SAWTOOTH, NULL, SAMPLE_RATE, frames);
    synthway_analyzer_t* mic = synthway_analyzer_create();
    synthway_analysis_t a;
    char detail[192];

    const int refused = synthway_analyzer_start_recording(mic) == SYNTHWAY_NOT_RUNNING
                        && synthway_analyzer_write_input(mic, note, BLOCK) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_stop_recording(mic) == SYNTHWAY_NOT_RUNNING
                        && synthway_analyzer_save_clip_wav(mic, path) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_open_virtual_input(mic, 1000) == SYNTHWAY_INVALID_PARAM;
    synthway_analyzer_open_virtual_input(mic, SAMPLE_RATE);
    synthway_analyzer_write_input(mic, note, 10 * BLOCK); /* heard before the recording: not kept */
    const synthway_result_t started = synthway_analyzer_start_recording(mic);
    for (uint32_t done = 0; done < frames; done += BLOCK) {
        synthway_analyzer_write_input(mic, note + done, BLOCK);
        if (done % (5 * BLOCK) == 0) {
            synthway_analyzer_analyze_input(mic, &a);
        }
    }
    uint64_t recorded = 0, lost = 1;
    synthway_analyzer_get_recording_info(mic, &recorded, &lost);
    const int was_recording = synthway_analyzer_is_recording(mic);
    synthway_result_t stopped = synthway_analyzer_stop_recording(mic);

    uint64_t clip_frames = 0;
    uint32_t clip_rate = 0;
    synthway_analyzer_get_clip_info(mic, &clip_frames, &clip_rate);
    /* One overview part per frame: the size of every sample, which must be the one heard */
    float* sizes = (float*)malloc(sizeof(float) * frames);
    int same = clip_frames == frames && synthway_analyzer_get_clip_overview(mic, sizes, frames) == SYNTHWAY_OK;
    for (uint32_t i = 0; same && i < frames; ++i) {
        same = sizes[i] == fabsf(note[i]);
    }
    memset(&a, 0, sizeof(a));
    synthway_analyzer_analyze_clip(mic, 1.0, &a);
    snprintf(detail, sizeof(detail), "%llu frames recorded, %llu lost, clip of %llu frames at %u Hz, %s, %.3f Hz at 1 s",
             (unsigned long long)recorded, (unsigned long long)lost, (unsigned long long)clip_frames, clip_rate,
             same ? "samples identical" : "samples differ", a.frequency_hz);
    check(refused && started == SYNTHWAY_OK && was_recording && stopped == SYNTHWAY_OK
              && !synthway_analyzer_is_recording(mic) && synthway_analyzer_is_input_open(mic)
              && recorded == frames && lost == 0 && clip_rate == SAMPLE_RATE && same
              && fabs(cents(a.frequency_hz, 261.63)) < 1.0,
          "recording: what the microphone hears becomes the clip", detail);

    /* Saved as WAV, then loaded like any file */
    synthway_result_t saved = synthway_analyzer_save_clip_wav(mic, path);
    synthway_result_t loaded = synthway_analyzer_load_clip(analyzer, path);
    synthway_analyzer_get_clip_info(analyzer, &clip_frames, &clip_rate);
    memset(&a, 0, sizeof(a));
    synthway_analyzer_analyze_clip(analyzer, 1.0, &a);
    snprintf(detail, sizeof(detail), "saved: %s, loaded: %s, %llu frames at %u Hz, %.3f Hz at 1 s",
             synthway_result_to_string(saved), synthway_result_to_string(loaded),
             (unsigned long long)clip_frames, clip_rate, a.frequency_hz);
    check(saved == SYNTHWAY_OK && loaded == SYNTHWAY_OK && clip_frames == frames && clip_rate == SAMPLE_RATE
              && fabs(cents(a.frequency_hz, 261.63)) < 1.0,
          "recording: saved as a WAV file", detail);

    /* Nobody takes the samples for 16 s: the oldest are overwritten, silence
       stands for them, and the recording keeps its length */
    const uint32_t long_frames = 16 * SAMPLE_RATE;
    float* steady = (float*)malloc(sizeof(float) * long_frames);
    for (uint32_t i = 0; i < long_frames; ++i) {
        steady[i] = 0.25f;
    }
    synthway_analyzer_start_recording(mic);
    for (uint32_t done = 0; done < long_frames; done += BLOCK) {
        synthway_analyzer_write_input(mic, steady + done, BLOCK);
    }
    stopped = synthway_analyzer_stop_recording(mic);
    synthway_analyzer_get_recording_info(mic, &recorded, &lost);
    float ends[16];
    synthway_analyzer_get_clip_overview(mic, ends, 16);
    snprintf(detail, sizeof(detail), "%llu frames, %llu lost; first second %.2f, last %.2f",
             (unsigned long long)recorded, (unsigned long long)lost, ends[0], ends[15]);
    check(stopped == SYNTHWAY_OK && recorded == long_frames && lost > 0 && lost < long_frames
              && ends[0] == 0.0f && ends[15] == 0.25f,
          "recording: samples lost when not taken in time are silence", detail);

    /* Closing the microphone during a recording keeps it */
    synthway_analyzer_start_recording(mic);
    synthway_analyzer_write_input(mic, note, 10 * BLOCK);
    synthway_analyzer_close_input(mic);
    synthway_analyzer_get_clip_info(mic, &clip_frames, &clip_rate);
    snprintf(detail, sizeof(detail), "clip of %llu frames", (unsigned long long)clip_frames);
    check(clip_frames == 10 * BLOCK && !synthway_analyzer_is_recording(mic) && !synthway_analyzer_is_input_open(mic)
              && synthway_analyzer_write_input(mic, note, BLOCK) == SYNTHWAY_INVALID_PARAM,
          "recording: closing the microphone stops and keeps it", detail);

    synthway_analyzer_destroy(mic);
    free(steady);
    free(sizes);
    free(note);
}

/* An analyzer whose clip is these samples: a virtual microphone, recorded whole */
static synthway_analyzer_t* clip_of(const float* samples, uint32_t frames) {
    enum { BLOCK = 4800 };
    synthway_analyzer_t* clip = synthway_analyzer_create();
    synthway_analyzer_open_virtual_input(clip, SAMPLE_RATE);
    synthway_analyzer_start_recording(clip);
    for (uint32_t done = 0; done < frames; done += BLOCK) {
        synthway_analyzer_write_input(clip, samples + done, frames - done < BLOCK ? frames - done : BLOCK);
        uint64_t recorded, lost;
        synthway_analyzer_get_recording_info(clip, &recorded, &lost);
    }
    synthway_analyzer_stop_recording(clip);
    return clip;
}

static void test_window_sizes(void) {
    /* A held sawtooth at 220 Hz, seen at 1 s through windows of 20 to 320 ms */
    const uint32_t frames = 2 * SAMPLE_RATE;
    float* x = render_note(220.0f, SYNTHWAY_WAVEFORM_SAWTOOTH, NULL, SAMPLE_RATE, frames);
    synthway_analyzer_t* clip = clip_of(x, frames);
    static const double windows[] = { 0.02, 0.05, 0.17, 0.32 };
    char detail[256];
    int length = 0, ok = 1;
    for (size_t w = 0; w < sizeof(windows) / sizeof(windows[0]); ++w) {
        synthway_analysis_t a;
        memset(&a, 0, sizeof(a));
        const synthway_result_t res = synthway_analyzer_analyze_clip_range(
            clip, 1.0 - windows[w] / 2.0, 1.0 + windows[w] / 2.0, windows[w], 0.0f, 0.0f, &a);
        int harmonics = 0;
        for (int n = 1; n <= 12; ++n) {
            const synthway_analysis_partial_t* p = partial_near(&a, 220.0 * n);
            harmonics += p && fabs(p->ratio - n) < 0.01;
        }
        length += snprintf(detail + length, sizeof(detail) - length, "%s%.0f ms: %.2f Hz, %d/12",
                           w ? "; " : "", 1000.0 * windows[w], a.frequency_hz, harmonics);
        /* The shortest window reads the note more coarsely and cannot part
           every harmonic, the others must */
        ok = ok && res == SYNTHWAY_OK && fabs(cents(a.frequency_hz, 220.0)) < (w == 0 ? 10.0 : 2.0)
             && harmonics >= (w == 0 ? 3 : 12);
    }
    check(ok, "window sizes: the note and its harmonics from 20 to 320 ms", detail);

    /* The usual window around a moment is exactly analyze_clip at that moment */
    synthway_analysis_t usual, zone;
    synthway_analyzer_analyze_clip(clip, 1.0, &usual);
    synthway_analyzer_analyze_clip_range(clip, 0.95, 1.05, SYNTHWAY_ANALYZER_WINDOW_AUTO, 0.0f, 0.0f, &zone);
    snprintf(detail, sizeof(detail), "%.3f Hz and %.3f Hz", usual.frequency_hz, zone.frequency_hz);
    check(memcmp(&usual, &zone, sizeof(usual)) == 0, "window sizes: the usual window is unchanged", detail);

    synthway_analysis_t a;
    const int refused = synthway_analyzer_analyze_clip_range(clip, 1.0, 1.0, 0.17, 0.0f, 0.0f, &a) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_analyze_clip_range(clip, 1.0, 0.5, 0.17, 0.0f, 0.0f, &a) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_analyze_clip_range(clip, 0.9, 1.1, 0.005, 0.0f, 0.0f, &a) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_analyze_clip_range(clip, 0.9, 1.1, 0.6, 0.0f, 0.0f, &a) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_analyze_clip_range(clip, 0.9, NAN, 0.17, 0.0f, 0.0f, &a) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_analyze_clip_range(NULL, 0.9, 1.1, 0.17, 0.0f, 0.0f, &a) == SYNTHWAY_INVALID_PARAM;
    check(refused, "window sizes: invalid zones and windows refused", "empty, reversed, too short, too long, NaN");
    synthway_analyzer_destroy(clip);
    free(x);
}

static void test_zone_with_vibrato(void) {
    /* A sawtooth played around 220 Hz with a vibrato of ±20 cents at 5.5 Hz (a
       violin's): one window reads the note anywhere within the swing, while
       the zone's median finds its centre, and the harmonic ratios stay whole */
    enum { BLOCK = 96 };
    const uint32_t frames = 2 * SAMPLE_RATE;
    float* x = (float*)malloc(sizeof(float) * frames);
    synthway_engine_t* engine = synthway_engine_create();
    synthway_engine_config_t config;
    memset(&config, 0, sizeof(config));
    config.sample_rate = SAMPLE_RATE;
    config.channels = 1;
    synthway_engine_init_offline(engine, &config);
    synthway_engine_set_waveform(engine, SYNTHWAY_WAVEFORM_SAWTOOTH);
    synthway_engine_set_volume(engine, 0.5f);
    synthway_engine_set_tone_enabled(engine, true);
    for (uint32_t done = 0; done < frames; done += BLOCK) {
        const double t = (double)done / SAMPLE_RATE;
        synthway_engine_set_frequency(engine, (float)(220.0 * pow(2.0, 20.0 * sin(6.2831853 * 5.5 * t) / 1200.0)));
        synthway_engine_render(engine, x + done, BLOCK);
    }
    synthway_engine_destroy(engine);
    synthway_analyzer_t* clip = clip_of(x, frames);

    /* Single windows across a vibrato cycle: how far from the centre they read */
    double widest = 0.0;
    for (double t = 0.5; t < 0.7; t += 0.02) {
        synthway_analysis_t moment;
        synthway_analyzer_analyze_clip_range(clip, t - 0.085, t + 0.085, 0.17, 0.0f, 0.0f, &moment);
        if (fabs(cents(moment.frequency_hz, 220.0)) > widest) widest = fabs(cents(moment.frequency_hz, 220.0));
    }

    synthway_analysis_t a;
    memset(&a, 0, sizeof(a));
    const synthway_result_t res = synthway_analyzer_analyze_clip_range(clip, 0.2, 1.8, 0.17, 0.0f, 0.0f, &a);
    /* Each partial a harmonic, within 0.2 % of its whole ratio (3.5 cents);
       harmonics 1 to 10 all there, fading as in a sawtooth */
    int harmonics = 0, stray = 0, fading = 1;
    double worst = 0.0, previous = 2.0;
    for (uint32_t i = 0; i < a.partial_count; ++i) {
        const double ratio = a.partials[i].ratio;
        const long n = lround(ratio);
        const double error = n >= 1 ? fabs(ratio / n - 1.0) : 1.0;
        if (error > 0.002) {
            stray++;
            continue;
        }
        if (error > worst) worst = error;
        if (n <= 10) {
            harmonics++;
            fading = fading && a.partials[i].amplitude < previous;
            previous = a.partials[i].amplitude;
        }
    }
    char detail[224];
    snprintf(detail, sizeof(detail),
             "one window: up to %.1f cents off; zone: %.2f Hz (%+.2f cents), %u partials, %d/10 harmonics, %d stray, "
             "ratios within %.3f %%",
             widest, a.frequency_hz, cents(a.frequency_hz, 220.0), a.partial_count, harmonics, stray, 100.0 * worst);
    check(res == SYNTHWAY_OK && fabs(cents(a.frequency_hz, 220.0)) < 3.0 && harmonics == 10 && stray == 0 && fading,
          "zone: medians through a vibrato keep the note and whole harmonic ratios", detail);
    synthway_analyzer_destroy(clip);
    free(x);
}

/* Lists the first ratios of an analysis into detail, after prefix */
static void describe_ratios(char* detail, size_t size, const char* prefix, const synthway_analysis_t* a) {
    int length = snprintf(detail, size, "%s%.2f Hz, %u partials:", prefix, a->frequency_hz, a->partial_count);
    for (uint32_t i = 0; i < a->partial_count && i < 10 && length < (int)size; ++i) {
        length += snprintf(detail + length, size - length, " %.2f", a->partials[i].ratio);
    }
}

/* Partials within cents of a whole ratio (n >= 1), and whether ratio r is among them */
static int harmonic_partials(const synthway_analysis_t* a, double cents_tolerance, int* has_ratio, int wanted) {
    int count = 0;
    *has_ratio = 0;
    for (uint32_t i = 0; i < a->partial_count; ++i) {
        const long n = lround(a->partials[i].ratio);
        if (n >= 1 && fabs(1200.0 * log2(a->partials[i].ratio / n)) <= cents_tolerance) {
            count++;
            if (n == wanted) *has_ratio = 1;
        }
    }
    return count;
}

static void test_reference_note(void) {
    /* A bass like the one of a synthwave track: a G1 sine plucked every 155 ms,
       gone within 80 ms, under a G2 layer rich in harmonics that fades slowly,
       with a click at each attack. Windows read G1 at first, then G2. */
    const uint32_t frames = SAMPLE_RATE;
    const double note = 49.0, period = 0.155;
    float* x = (float*)malloc(sizeof(float) * frames);
    uint32_t state = 4242u;
    for (uint32_t i = 0; i < frames; ++i) {
        const double t = (double)i / SAMPLE_RATE;
        const double age = fmod(t, period);
        double layer = 0.0;
        for (int n = 1; n <= 30; ++n) layer += sin(6.283185307 * n * 2.0 * note * t) / n;
        state = state * 1664525u + 1013904223u;
        const double click = age < 0.004 ? 0.3 * (1.0 - age / 0.004) * ((double)(state >> 8) / 8388608.0 - 1.0) : 0.0;
        x[i] = (float)(0.5 * exp(-age / 0.0225) * sin(6.283185307 * note * t) + 0.3 * exp(-age / 0.12) * layer + click);
    }
    synthway_analyzer_t* clip = clip_of(x, frames);
    char detail[256];
    int has;

    /* Three notes, with their attacks: the note is G1, the layer's harmonics come out as 2, 4, 6… */
    synthway_analysis_t a;
    memset(&a, 0, sizeof(a));
    synthway_result_t res = synthway_analyzer_analyze_clip_range(clip, period, 4 * period, 0.17, 0.0f, 0.0f, &a);
    int has_one;
    harmonic_partials(&a, 30.0, &has_one, 1);
    const int harmonics = harmonic_partials(&a, 30.0, &has, 2);
    describe_ratios(detail, sizeof(detail), "", &a);
    check(res == SYNTHWAY_OK && fabs(cents(a.frequency_hz, note)) < 15.0 && has_one && has && harmonics >= 10
              && harmonics >= (int)a.partial_count - 2,
          "reference: a zone that reads G1 then G2 keeps G1, whole ratios", detail);

    /* G2 given, harmonics only: the layer alone, as 1, 2, 3…; the sub (0.5) is left out */
    memset(&a, 0, sizeof(a));
    res = synthway_analyzer_analyze_clip_range(clip, period, 4 * period, 0.17, 2.0f * (float)note, 30.0f, &a);
    const int layer = harmonic_partials(&a, 30.0, &has, 1);
    describe_ratios(detail, sizeof(detail), "G2 given: ", &a);
    check(res == SYNTHWAY_OK && fabs(cents(a.frequency_hz, 2.0 * note)) < 15.0 && has && layer == (int)a.partial_count
              && layer >= 10 && a.partials[0].ratio > 0.9f,
          "reference: a note given, harmonics only", detail);

    /* G2 given, every partial: the sub is there, at 0.5 */
    memset(&a, 0, sizeof(a));
    synthway_analyzer_analyze_clip_range(clip, period, 4 * period, 0.17, 2.0f * (float)note, 0.0f, &a);
    describe_ratios(detail, sizeof(detail), "G2 given, every partial: ", &a);
    check(a.partial_count > 0 && fabs(a.partials[0].ratio - 0.5f) < 0.01f, "reference: below the note, the sub stays without the filter", detail);

    /* One window late in a note, read G2 on its own: with G1 given, its note is G1, its partials 2, 4, 6… */
    synthway_analysis_t own;
    const double late = 2 * period + 0.11;
    synthway_analyzer_analyze_clip_range(clip, late - 0.035, late + 0.035, 0.07, 0.0f, 0.0f, &own);
    memset(&a, 0, sizeof(a));
    synthway_analyzer_analyze_clip_range(clip, late - 0.035, late + 0.035, 0.07, (float)note, 30.0f, &a);
    uint32_t strongest = 0;
    for (uint32_t i = 1; i < a.partial_count; ++i) {
        if (a.partials[i].amplitude > a.partials[strongest].amplitude) strongest = i;
    }
    const int even = harmonic_partials(&a, 30.0, &has, 2);
    char own_detail[48];
    snprintf(own_detail, sizeof(own_detail), "on its own %.2f Hz; G1 given: ", own.frequency_hz);
    describe_ratios(detail, sizeof(detail), own_detail, &a);
    check(fabs(cents(a.frequency_hz, note)) < 15.0 && a.partial_count > 0 && fabs(a.partials[strongest].ratio - 2.0f) < 0.02f
              && has && even == (int)a.partial_count,
          "reference: one window, its note moved to the octave given", detail);

    const int refused = synthway_analyzer_analyze_clip_range(clip, 0.2, 0.4, 0.17, 10.0f, 0.0f, &a) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_analyze_clip_range(clip, 0.2, 0.4, 0.17, 6000.0f, 0.0f, &a) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_analyze_clip_range(clip, 0.2, 0.4, 0.17, 0.0f, 150.0f, &a) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_analyze_clip_range(clip, 0.2, 0.4, 0.17, 0.0f, -5.0f, &a) == SYNTHWAY_INVALID_PARAM
                        && synthway_analyzer_analyze_clip_range(clip, 0.2, 0.4, 0.17, NAN, 0.0f, &a) == SYNTHWAY_INVALID_PARAM;
    check(refused, "reference: invalid notes and tolerances refused", "10 Hz, 6000 Hz, 150 cents, -5 cents, NaN");
    synthway_analyzer_destroy(clip);
    free(x);
}

static void test_guards(void) {
    synthway_analysis_t a;
    float x[16] = { 0 };
    int ok = synthway_analysis_get_size() == sizeof(synthway_analysis_t)
             && synthway_analyzer_analyze_samples(NULL, x, 16, SAMPLE_RATE, &a) == SYNTHWAY_INVALID_PARAM
             && synthway_analyzer_analyze_samples(analyzer, x, 16, 1000, &a) == SYNTHWAY_INVALID_PARAM
             && synthway_analyzer_analyze_samples(analyzer, x, 16, SAMPLE_RATE, &a) == SYNTHWAY_OK
             && synthway_analyzer_analyze_input(analyzer, &a) == SYNTHWAY_INVALID_PARAM
             && !synthway_analyzer_is_input_open(analyzer)
             && !synthway_analyzer_is_input_exclusive(analyzer)
             && synthway_analyzer_get_input_sample_rate(analyzer) == 0;
    check(ok, "guards: invalid calls refused, microphone closed", "no device opened");
}

/* Default scratch WAV in the system temp directory, never in the current one */
static const char* default_wav_path(char* buffer, size_t size) {
    const char* dir = getenv("TMPDIR");
    if (!dir) dir = getenv("TEMP");
    if (!dir) dir = getenv("TMP");
#if defined(_WIN32)
    if (!dir) dir = ".";
#else
    if (!dir) dir = "/tmp";
#endif
    snprintf(buffer, size, "%s/synthway_analysis_test.wav", dir);
    return buffer;
}

int main(int argc, char* argv[]) {
    char default_path[1024];
    const char* wav_path = argc > 1 ? argv[1] : default_wav_path(default_path, sizeof(default_path));

    printf("Synthway analysis test (core %s, no audio device)\n", synthway_get_version());
    analyzer = synthway_analyzer_create();
    if (!analyzer) {
        fprintf(stderr, "[!] Cannot create an analyzer\n");
        return 2;
    }

    test_sine_notes();
    test_level();
    test_sawtooth_harmonics();
    test_inharmonic_timbre();
    test_bell_is_not_a_missing_fundamental();
    test_missing_fundamental();
    test_silence_and_noise();
    test_held_note();
    test_noise_gate();
    test_clip(wav_path);
    test_recording(wav_path);
    test_window_sizes();
    test_zone_with_vibrato();
    test_reference_note();
    test_guards();

    synthway_analyzer_destroy(analyzer);
    printf("%s: %d failure(s)\n", failures ? "FAILED" : "OK", failures);
    return failures ? 1 : 0;
}
