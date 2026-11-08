/*
 * Offline rendering test: checks what the engine actually produces, without
 * any audio device (nothing is played). Exit code 0 when every check passes.
 *
 * Usage: synthway_render_test [path/to/output.wav]
 */
#include "synthway/synthway.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SAMPLE_RATE 48000
#define WARMUP_FRAMES 2400 /* 50 ms: lets frequency/volume smoothing settle */

static int failures = 0;

static void check(int ok, const char* name, const char* detail) {
    printf("[%s] %s (%s)\n", ok ? "PASS" : "FAIL", name, detail);
    if (!ok) {
        failures++;
    }
}

static synthway_engine_t* offline_engine(uint32_t channels) {
    synthway_engine_t* engine = synthway_engine_create();
    synthway_engine_config_t config;
    memset(&config, 0, sizeof(config));
    config.sample_rate = SAMPLE_RATE;
    config.channels = channels;
    if (!engine || synthway_engine_init_offline(engine, &config) != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Cannot create an offline engine\n");
        exit(2);
    }
    return engine;
}

static float* render(synthway_engine_t* engine, uint32_t frames) {
    float* samples = (float*)malloc(sizeof(float) * frames * synthway_engine_get_channels(engine));
    if (!samples || synthway_engine_render(engine, samples, frames) != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Rendering failed\n");
        exit(2);
    }
    return samples;
}

/* Frequency from positive-going zero crossings, interpolated between samples */
static double measure_frequency(const float* x, uint32_t count, uint32_t stride) {
    double first = -1.0, last = -1.0;
    int crossings = 0;
    for (uint32_t i = 1; i < count; ++i) {
        float a = x[(i - 1) * stride], b = x[i * stride];
        if (a < 0.0f && b >= 0.0f) {
            double t = (double)(i - 1) + (double)a / (double)(a - b);
            if (first < 0.0) first = t;
            last = t;
            crossings++;
        }
    }
    return crossings < 2 ? 0.0 : (crossings - 1) * (double)SAMPLE_RATE / (last - first);
}

static double measure_peak(const float* x, uint32_t count, uint32_t stride) {
    double peak = 0.0;
    for (uint32_t i = 0; i < count; ++i) {
        double v = fabs((double)x[i * stride]);
        if (v > peak) peak = v;
    }
    return peak;
}

static double measure_rms(const float* x, uint32_t count, uint32_t stride) {
    double sum = 0.0;
    for (uint32_t i = 0; i < count; ++i) {
        sum += (double)x[i * stride] * (double)x[i * stride];
    }
    return sqrt(sum / count);
}

static void test_silence_when_tone_disabled(void) {
    synthway_engine_t* engine = offline_engine(1);
    synthway_engine_set_tone_enabled(engine, false);
    float* x = render(engine, SAMPLE_RATE / 10);
    double peak = measure_peak(x, SAMPLE_RATE / 10, 1);
    char detail[64];
    snprintf(detail, sizeof(detail), "peak %.6f", peak);
    check(peak == 0.0, "tone disabled renders exact silence", detail);
    free(x);
    synthway_engine_destroy(engine);
}

static void test_waveforms(void) {
    static const struct {
        synthway_waveform_t waveform;
        const char* name;
        double rms_ratio; /* RMS / amplitude of the ideal waveform */
    } cases[] = {
        { SYNTHWAY_WAVEFORM_SINE, "sine", 0.70710678 },
        { SYNTHWAY_WAVEFORM_SQUARE, "square", 1.0 },
        { SYNTHWAY_WAVEFORM_TRIANGLE, "triangle", 0.57735027 },
        { SYNTHWAY_WAVEFORM_SAWTOOTH, "sawtooth", 0.57735027 },
    };
    const double volume = 0.5;

    for (size_t c = 0; c < sizeof(cases) / sizeof(cases[0]); ++c) {
        synthway_engine_t* engine = offline_engine(1);
        synthway_engine_set_waveform(engine, cases[c].waveform);
        synthway_engine_set_frequency(engine, 440.0f);
        synthway_engine_set_volume(engine, (float)volume);
        synthway_engine_set_tone_enabled(engine, true);

        float* x = render(engine, SAMPLE_RATE);
        const float* steady = x + WARMUP_FRAMES;
        uint32_t n = SAMPLE_RATE - WARMUP_FRAMES;
        double freq = measure_frequency(steady, n, 1);
        double peak = measure_peak(steady, n, 1);
        double rms = measure_rms(steady, n, 1);

        char name[64], detail[96];
        snprintf(name, sizeof(name), "%s at 440 Hz", cases[c].name);
        snprintf(detail, sizeof(detail), "%.3f Hz, peak %.4f, rms %.4f", freq, peak, rms);
        check(fabs(freq - 440.0) < 0.5
                  && fabs(peak - volume) < 0.01
                  && fabs(rms - volume * cases[c].rms_ratio) < 0.02 * volume,
              name, detail);
        free(x);
        synthway_engine_destroy(engine);
    }
}

static void test_frequency_and_volume_changes(void) {
    synthway_engine_t* engine = offline_engine(1);
    synthway_engine_set_volume(engine, 0.5f);
    synthway_engine_set_tone_enabled(engine, true);
    free(render(engine, SAMPLE_RATE / 10));

    synthway_engine_set_frequency(engine, 880.0f);
    float* x = render(engine, SAMPLE_RATE / 2);
    double freq = measure_frequency(x + WARMUP_FRAMES, SAMPLE_RATE / 2 - WARMUP_FRAMES, 1);
    char detail[64];
    snprintf(detail, sizeof(detail), "%.3f Hz", freq);
    check(fabs(freq - 880.0) < 1.0, "frequency change follows the new note", detail);
    free(x);

    synthway_engine_set_volume(engine, 0.0f);
    x = render(engine, SAMPLE_RATE / 5);
    double peak = measure_peak(x + WARMUP_FRAMES, SAMPLE_RATE / 5 - WARMUP_FRAMES, 1);
    snprintf(detail, sizeof(detail), "peak %.6f after fade", peak);
    check(peak == 0.0, "volume 0 fades to silence", detail);
    free(x);
    synthway_engine_destroy(engine);
}

/* With a square wave, |sample| is exactly volume * envelope level */
static double level_at(const float* x, double seconds) {
    return fabs((double)x[(uint32_t)(seconds * SAMPLE_RATE)]);
}

static int near(double value, double expected) {
    return fabs(value - expected) < 0.005;
}

static synthway_engine_t* square_engine(float attack, float decay, float sustain, float release) {
    synthway_engine_t* engine = offline_engine(1);
    synthway_engine_set_waveform(engine, SYNTHWAY_WAVEFORM_SQUARE);
    synthway_engine_set_volume(engine, 0.5f);
    synthway_engine_set_envelope(engine, attack, decay, sustain, release);
    return engine;
}

static void test_envelope_shape(void) {
    /* 100 ms attack, 100 ms decay to 50 %, 200 ms release; volume 0.5 */
    synthway_engine_t* engine = square_engine(0.1f, 0.1f, 0.5f, 0.2f);
    synthway_engine_set_tone_enabled(engine, true);
    float* held = render(engine, SAMPLE_RATE / 2);
    double mid_attack = level_at(held, 0.05);
    double top = measure_peak(held, SAMPLE_RATE / 5, 1);
    double mid_decay = level_at(held, 0.15);
    double sustained = level_at(held, 0.4);

    synthway_engine_set_tone_enabled(engine, false);
    float* released = render(engine, (uint32_t)(SAMPLE_RATE * 0.3));
    double mid_release = level_at(released, 0.1);
    double tail = measure_peak(released + (uint32_t)(SAMPLE_RATE * 0.21), (uint32_t)(SAMPLE_RATE * 0.09), 1);

    char detail[160];
    snprintf(detail, sizeof(detail), "attack %.3f, peak %.3f, decay %.3f, sustain %.3f, release %.3f, tail %.3f",
             mid_attack, top, mid_decay, sustained, mid_release, tail);
    check(near(mid_attack, 0.25) && near(top, 0.5) && near(mid_decay, 0.375) && near(sustained, 0.25)
              && near(mid_release, 0.125) && tail == 0.0,
          "ADSR envelope shape", detail);
    free(held);
    free(released);
    synthway_engine_destroy(engine);
}

static void test_envelope_legato_and_retrigger(void) {
    synthway_engine_t* engine = square_engine(0.1f, 0.0f, 0.6f, 0.1f);
    synthway_engine_set_tone_enabled(engine, true);
    free(render(engine, (uint32_t)(SAMPLE_RATE * 0.3)));

    /* New note while the gate is open: no new attack */
    synthway_engine_set_frequency(engine, 880.0f);
    synthway_engine_set_tone_enabled(engine, true);
    float* legato = render(engine, SAMPLE_RATE / 20);
    double legato_peak = measure_peak(legato, SAMPLE_RATE / 20, 1);
    char detail[96];
    snprintf(detail, sizeof(detail), "peak %.3f, sustain level 0.300", legato_peak);
    check(near(legato_peak, 0.3), "legato note keeps the sustain level", detail);
    free(legato);

    /* Note on during the release: the new attack starts where the release is */
    synthway_engine_set_tone_enabled(engine, false);
    float* releasing = render(engine, SAMPLE_RATE / 20);
    double before = fabs((double)releasing[SAMPLE_RATE / 20 - 1]);
    synthway_engine_set_tone_enabled(engine, true);
    float* retriggered = render(engine, SAMPLE_RATE / 20);
    double after = fabs((double)retriggered[0]);
    snprintf(detail, sizeof(detail), "%.4f -> %.4f", before, after);
    check(before > 0.1 && fabs(after - before) < 0.01, "retrigger continues from the current level", detail);
    free(releasing);
    free(retriggered);
    synthway_engine_destroy(engine);
}

static void test_default_note_off_is_click_free(void) {
    synthway_engine_t* engine = offline_engine(1);
    synthway_engine_set_waveform(engine, SYNTHWAY_WAVEFORM_SQUARE);
    synthway_engine_set_volume(engine, 0.5f);
    synthway_engine_set_tone_enabled(engine, true);
    free(render(engine, SAMPLE_RATE / 10));

    synthway_engine_set_tone_enabled(engine, false);
    float* x = render(engine, SAMPLE_RATE / 20);
    double first = fabs((double)x[0]);
    double tail = measure_peak(x + SAMPLE_RATE / 80, SAMPLE_RATE / 20 - SAMPLE_RATE / 80, 1);
    char detail[96];
    snprintf(detail, sizeof(detail), "first sample %.3f, after 12.5 ms %.3f", first, tail);
    check(first > 0.45 && tail == 0.0, "note off fades out instead of cutting", detail);
    free(x);
    synthway_engine_destroy(engine);
}

static void test_envelope_validation(void) {
    synthway_engine_t* engine = offline_engine(1);
    float a = 0.0f, d = 0.0f, s = 0.0f, r = 0.0f;
    int refused = synthway_engine_set_envelope(engine, -0.1f, 0.0f, 1.0f, 0.0f) == SYNTHWAY_INVALID_PARAM
               && synthway_engine_set_envelope(engine, 0.0f, 0.0f, 1.5f, 0.0f) == SYNTHWAY_INVALID_PARAM
               && synthway_engine_set_envelope(engine, 0.0f, 11.0f, 1.0f, 0.0f) == SYNTHWAY_INVALID_PARAM;
    synthway_engine_get_envelope(engine, &a, &d, &s, &r);
    char detail[96];
    snprintf(detail, sizeof(detail), "kept %.3f / %.3f / %.2f / %.3f", a, d, s, r);
    check(refused && a == 0.005f && d == 0.0f && s == 1.0f && r == 0.01f, "invalid envelope refused, default kept", detail);
    synthway_engine_destroy(engine);
}

static void test_stereo_channels_match(void) {
    synthway_engine_t* engine = offline_engine(2);
    synthway_engine_set_tone_enabled(engine, true);
    float* x = render(engine, SAMPLE_RATE / 10);
    int same = 1;
    for (uint32_t i = 0; i < SAMPLE_RATE / 10; ++i) {
        same &= x[2 * i] == x[2 * i + 1];
    }
    check(same, "stereo channels are identical", "2 channels");
    free(x);
    synthway_engine_destroy(engine);
}

static void test_guards(void) {
    float sample = 0.0f;
    synthway_engine_t* engine = synthway_engine_create();
    check(synthway_engine_render(engine, &sample, 1) == SYNTHWAY_INVALID_PARAM,
          "render refused without offline init", "no device engine");
    synthway_engine_destroy(engine);

    engine = offline_engine(1);
    check(synthway_engine_init(engine, NULL) == SYNTHWAY_INVALID_PARAM,
          "device init refused on an offline engine", "offline engine");
    synthway_engine_destroy(engine);
}

/* ---------- Timbre (additive synthesis) ---------- */

/* Amplitude of the component at hz (one DFT bin): exact when count holds a
   whole number of its periods */
static double measure_amplitude(const float* x, uint32_t count, double hz) {
    const double w = 2.0 * 3.14159265358979323846 * hz / SAMPLE_RATE;
    double re = 0.0, im = 0.0;
    for (uint32_t i = 0; i < count; ++i) {
        re += x[i] * cos(w * i);
        im -= x[i] * sin(w * i);
    }
    return 2.0 * sqrt(re * re + im * im) / count;
}

/* Sine partial with the engine's default envelope (5 ms attack, full sustain, 10 ms release) */
static synthway_partial_t sine_partial(float ratio, float amplitude) {
    synthway_partial_t partial;
    memset(&partial, 0, sizeof(partial));
    partial.ratio = ratio;
    partial.amplitude = amplitude;
    partial.waveform = SYNTHWAY_WAVEFORM_SINE;
    partial.envelope.attack_s = 0.005f;
    partial.envelope.sustain_level = 1.0f;
    partial.envelope.release_s = 0.01f;
    return partial;
}

static synthway_timbre_t timbre_of(uint32_t count, const synthway_partial_t* partials) {
    synthway_timbre_t timbre;
    memset(&timbre, 0, sizeof(timbre));
    timbre.partial_count = count;
    memcpy(timbre.partials, partials, sizeof(synthway_partial_t) * count);
    return timbre;
}

/* Note held at frequency, volume 1: the samples are the sum of the partials */
static synthway_engine_t* timbre_engine(float frequency, const synthway_timbre_t* timbre) {
    synthway_engine_t* engine = offline_engine(1);
    synthway_engine_set_frequency(engine, frequency);
    synthway_engine_set_volume(engine, 1.0f);
    synthway_engine_set_timbre(engine, timbre);
    synthway_engine_set_tone_enabled(engine, true);
    return engine;
}

static void test_timbre_partials(void) {
    /* 200 Hz note: 0.5 s after the warm-up holds whole periods of every partial */
    const uint32_t n = SAMPLE_RATE / 2;
    const synthway_partial_t partials[] = { sine_partial(1.0f, 0.5f), sine_partial(3.0f, 0.25f), sine_partial(2.76f, 0.3f) };
    synthway_timbre_t timbre = timbre_of(3, partials);
    synthway_engine_t* engine = timbre_engine(200.0f, &timbre);
    float* x = render(engine, WARMUP_FRAMES + n);
    const float* steady = x + WARMUP_FRAMES;
    double a1 = measure_amplitude(steady, n, 200.0);
    double a3 = measure_amplitude(steady, n, 600.0);
    double a276 = measure_amplitude(steady, n, 552.0);
    double a2 = measure_amplitude(steady, n, 400.0);

    char detail[128];
    snprintf(detail, sizeof(detail), "x1 %.4f, x3 %.4f, x2.76 %.4f, x2 (absent) %.5f", a1, a3, a276, a2);
    check(fabs(a1 - 0.5) < 0.005 && fabs(a3 - 0.25) < 0.005 && fabs(a276 - 0.3) < 0.005 && a2 < 0.001,
          "timbre: harmonic and inharmonic partials at their ratios", detail);
    free(x);
    synthway_engine_destroy(engine);
}

static void test_timbre_envelopes(void) {
    /* 440 Hz, the engine's starting frequency: no glide. The octave fades out
       in 100 ms, the fundamental is held. */
    synthway_partial_t partials[] = { sine_partial(1.0f, 0.5f), sine_partial(2.0f, 0.5f) };
    partials[1].envelope.decay_s = 0.1f;
    partials[1].envelope.sustain_level = 0.0f;
    synthway_timbre_t timbre = timbre_of(2, partials);
    synthway_engine_t* engine = timbre_engine(440.0f, &timbre);
    float* x = render(engine, SAMPLE_RATE / 2);
    const uint32_t start = SAMPLE_RATE / 20, late = SAMPLE_RATE / 4;
    double octave_start = measure_amplitude(x, start, 880.0);
    double octave_late = measure_amplitude(x + late, SAMPLE_RATE / 4, 880.0);
    double fundamental_late = measure_amplitude(x + late, SAMPLE_RATE / 4, 440.0);

    char detail[128];
    snprintf(detail, sizeof(detail), "octave %.3f then %.5f, fundamental %.4f", octave_start, octave_late, fundamental_late);
    check(octave_start > 0.1 && octave_late < 0.001 && fabs(fundamental_late - 0.5) < 0.005,
          "timbre: each partial follows its own envelope", detail);
    free(x);
    synthway_engine_destroy(engine);
}

static void test_timbre_single_partial_matches_oscillator(void) {
    const uint32_t held = SAMPLE_RATE / 5, released = SAMPLE_RATE / 20;
    synthway_engine_t* oscillator = offline_engine(1);
    synthway_engine_set_volume(oscillator, 0.5f);
    synthway_engine_set_tone_enabled(oscillator, true);

    const synthway_partial_t partial = sine_partial(1.0f, 1.0f);
    synthway_timbre_t timbre = timbre_of(1, &partial);
    synthway_engine_t* additive = offline_engine(1);
    synthway_engine_set_volume(additive, 0.5f);
    synthway_engine_set_timbre(additive, &timbre);
    synthway_engine_set_tone_enabled(additive, true);

    float* a = render(oscillator, held);
    float* b = render(additive, held);
    synthway_engine_set_tone_enabled(oscillator, false);
    synthway_engine_set_tone_enabled(additive, false);
    float* a_end = render(oscillator, released);
    float* b_end = render(additive, released);
    double diff = 0.0;
    for (uint32_t i = 0; i < held; ++i) diff = fmax(diff, fabs((double)a[i] - b[i]));
    for (uint32_t i = 0; i < released; ++i) diff = fmax(diff, fabs((double)a_end[i] - b_end[i]));

    char detail[64];
    snprintf(detail, sizeof(detail), "largest difference %.2e", diff);
    check(diff < 1e-6, "timbre: one sine partial plays like the single oscillator", detail);
    free(a);
    free(b);
    free(a_end);
    free(b_end);
    synthway_engine_destroy(oscillator);
    synthway_engine_destroy(additive);
}

static void test_timbre_live_changes(void) {
    synthway_partial_t partials[] = { sine_partial(1.0f, 0.5f), sine_partial(2.0f, 0.5f) };
    synthway_timbre_t timbre = timbre_of(1, partials);
    synthway_engine_t* engine = timbre_engine(440.0f, &timbre);
    free(render(engine, SAMPLE_RATE / 10));

    /* A partial added while the note is held starts at once */
    timbre = timbre_of(2, partials);
    synthway_engine_set_timbre(engine, &timbre);
    float* x = render(engine, SAMPLE_RATE / 4);
    double added = measure_amplitude(x + SAMPLE_RATE / 20, SAMPLE_RATE / 5, 880.0);
    free(x);

    /* Back to the single oscillator (square), still during the note */
    synthway_engine_set_timbre(engine, NULL);
    synthway_engine_set_waveform(engine, SYNTHWAY_WAVEFORM_SQUARE);
    synthway_engine_set_volume(engine, 0.5f);
    x = render(engine, SAMPLE_RATE / 5);
    double peak = measure_peak(x + WARMUP_FRAMES, SAMPLE_RATE / 5 - WARMUP_FRAMES, 1);
    double rms = measure_rms(x + WARMUP_FRAMES, SAMPLE_RATE / 5 - WARMUP_FRAMES, 1);
    free(x);
    bool back = !synthway_engine_has_timbre(engine);

    /* A timbre without partials is silent */
    timbre.partial_count = 0;
    synthway_engine_set_timbre(engine, &timbre);
    x = render(engine, SAMPLE_RATE / 10);
    double silent = measure_peak(x, SAMPLE_RATE / 10, 1);
    free(x);

    char detail[160];
    snprintf(detail, sizeof(detail), "added partial %.4f, single square peak %.4f rms %.4f, empty timbre peak %.6f",
             added, peak, rms, silent);
    check(fabs(added - 0.5) < 0.005 && back && fabs(peak - 0.5) < 0.001 && fabs(rms - 0.5) < 0.001 && silent == 0.0,
          "timbre: live changes (added partial, back to the oscillator, no partial)", detail);
    synthway_engine_destroy(engine);
}

static void test_timbre_partial_above_sample_rate(void) {
    /* 440 kHz sawtooth, far above the sample rate: folds back, but stays in [-1, 1] */
    synthway_partial_t partial = sine_partial(1000.0f, 1.0f);
    partial.waveform = SYNTHWAY_WAVEFORM_SAWTOOTH;
    synthway_timbre_t timbre = timbre_of(1, &partial);
    synthway_engine_t* engine = timbre_engine(440.0f, &timbre);
    float* x = render(engine, SAMPLE_RATE / 5);
    double peak = measure_peak(x, SAMPLE_RATE / 5, 1);
    char detail[64];
    snprintf(detail, sizeof(detail), "peak %.4f", peak);
    check(peak <= 1.0, "timbre: a partial above the sample rate stays bounded", detail);
    free(x);
    synthway_engine_destroy(engine);
}

static void test_timbre_validation(void) {
    synthway_engine_t* engine = offline_engine(1);
    const synthway_partial_t valid[] = { sine_partial(1.0f, 0.8f), sine_partial(2.76f, 0.4f) };
    synthway_timbre_t timbre = timbre_of(2, valid);
    int set = synthway_engine_set_timbre(engine, &timbre) == SYNTHWAY_OK;

    synthway_timbre_t bad = timbre;
    int refused = synthway_engine_set_timbre(NULL, &timbre) == SYNTHWAY_INVALID_PARAM;
    bad.partial_count = SYNTHWAY_MAX_PARTIALS + 1;
    refused &= synthway_engine_set_timbre(engine, &bad) == SYNTHWAY_INVALID_PARAM;
    const float bad_ratios[] = { 0.0f, -1.0f, 1001.0f, NAN };
    for (size_t i = 0; i < sizeof(bad_ratios) / sizeof(bad_ratios[0]); ++i) {
        bad = timbre;
        bad.partials[1].ratio = bad_ratios[i];
        refused &= synthway_engine_set_timbre(engine, &bad) == SYNTHWAY_INVALID_PARAM;
    }
    bad = timbre;
    bad.partials[1].amplitude = 1.5f;
    refused &= synthway_engine_set_timbre(engine, &bad) == SYNTHWAY_INVALID_PARAM;
    bad = timbre;
    bad.partials[1].waveform = (synthway_waveform_t)7;
    refused &= synthway_engine_set_timbre(engine, &bad) == SYNTHWAY_INVALID_PARAM;
    bad = timbre;
    bad.partials[0].envelope.sustain_level = 2.0f;
    refused &= synthway_engine_set_timbre(engine, &bad) == SYNTHWAY_INVALID_PARAM;

    synthway_timbre_t kept;
    synthway_engine_get_timbre(engine, &kept);
    int unchanged = synthway_engine_has_timbre(engine) && kept.partial_count == 2
                 && kept.partials[1].ratio == 2.76f && kept.partials[0].amplitude == 0.8f;

    synthway_timbre_t full;
    memset(&full, 0, sizeof(full));
    full.partial_count = synthway_get_max_partials();
    for (uint32_t i = 0; i < full.partial_count; ++i) full.partials[i] = sine_partial((float)(i + 1), 0.01f);
    int full_ok = full.partial_count == 64 && synthway_engine_set_timbre(engine, &full) == SYNTHWAY_OK;

    char detail[96];
    snprintf(detail, sizeof(detail), "set %d, refused %d, kept %d, %u partials accepted %d",
             set, refused, unchanged, full.partial_count, full_ok);
    check(set && refused && unchanged && full_ok, "timbre: invalid values refused, timbre kept", detail);
    synthway_engine_destroy(engine);
}

static void test_wav_export(const char* path) {
    const uint32_t frames = SAMPLE_RATE / 2;
    synthway_engine_t* engine = offline_engine(2);
    synthway_engine_set_volume(engine, 0.5f);
    synthway_engine_set_tone_enabled(engine, true);
    synthway_result_t res = synthway_engine_render_to_wav(engine, path, frames);
    synthway_engine_destroy(engine);
    check(res == SYNTHWAY_OK, "WAV export", synthway_result_to_string(res));
    if (res != SYNTHWAY_OK) return;

    /* Read it back: find the data chunk, then measure the left channel */
    FILE* file = fopen(path, "rb");
    unsigned char* bytes = NULL;
    long size = 0;
    if (file) {
        fseek(file, 0, SEEK_END);
        size = ftell(file);
        fseek(file, 0, SEEK_SET);
        bytes = (unsigned char*)malloc((size_t)size);
        if (bytes && fread(bytes, 1, (size_t)size, file) != (size_t)size) size = 0;
        fclose(file);
    }

    long data = -1;
    for (long i = 12; bytes && i + 8 <= size; ++i) {
        if (memcmp(bytes + i, "data", 4) == 0) {
            data = i + 8;
            break;
        }
    }
    uint32_t count = data < 0 ? 0 : (uint32_t)((size - data) / 4); /* stereo 16-bit frames */
    float* left = (float*)malloc(sizeof(float) * (count ? count : 1));
    for (uint32_t i = 0; i < count; ++i) {
        int16_t v = (int16_t)(bytes[data + 4 * i] | (bytes[data + 4 * i + 1] << 8));
        left[i] = (float)v / 32768.0f;
    }
    double freq = count > WARMUP_FRAMES ? measure_frequency(left + WARMUP_FRAMES, count - WARMUP_FRAMES, 1) : 0.0;
    char detail[320];
    snprintf(detail, sizeof(detail), "%u frames, %.3f Hz in %.256s", count, freq, path);
    check(count == frames && fabs(freq - 440.0) < 0.5, "WAV content", detail);
    free(left);
    free(bytes);
}

/* Default WAV path in the system temp directory, never in the current one */
static const char* default_wav_path(char* buffer, size_t size) {
    const char* dir = getenv("TMPDIR");
    if (!dir) dir = getenv("TEMP");
    if (!dir) dir = getenv("TMP");
#if defined(_WIN32)
    if (!dir) dir = ".";
#else
    if (!dir) dir = "/tmp";
#endif
    snprintf(buffer, size, "%s/synthway_render_test.wav", dir);
    return buffer;
}

int main(int argc, char* argv[]) {
    char default_path[1024];
    const char* wav_path = argc > 1 ? argv[1] : default_wav_path(default_path, sizeof(default_path));

    printf("Synthway offline render test (core %s, no audio device)\n", synthway_get_version());
    test_silence_when_tone_disabled();
    test_waveforms();
    test_frequency_and_volume_changes();
    test_envelope_shape();
    test_envelope_legato_and_retrigger();
    test_default_note_off_is_click_free();
    test_envelope_validation();
    test_stereo_channels_match();
    test_guards();
    test_timbre_partials();
    test_timbre_envelopes();
    test_timbre_single_partial_matches_oscillator();
    test_timbre_live_changes();
    test_timbre_partial_above_sample_rate();
    test_timbre_validation();
    test_wav_export(wav_path);

    printf("%s: %d failure(s)\n", failures ? "FAILED" : "OK", failures);
    return failures ? 1 : 0;
}
