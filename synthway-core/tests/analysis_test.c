/*
 * Analysis test: renders known sounds with the engine, offline, then checks
 * that the analyzer finds their note and their partials back. No audio device
 * is opened, nothing is played or recorded. Exit code 0 when every check passes.
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
    test_guards();

    synthway_analyzer_destroy(analyzer);
    printf("%s: %d failure(s)\n", failures ? "FAILED" : "OK", failures);
    return failures ? 1 : 0;
}
