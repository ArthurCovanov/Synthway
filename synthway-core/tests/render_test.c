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

static void test_filter_cutoff_and_resonance(void) {
    const uint32_t frames = WARMUP_FRAMES + SAMPLE_RATE;
    synthway_engine_t* open = offline_engine(1);
    synthway_engine_t* filtered = offline_engine(1);
    synthway_engine_t* corner = offline_engine(1);
    synthway_engine_t* resonant = offline_engine(1);
    synthway_engine_t* low_open = offline_engine(1);
    synthway_engine_t* high_passed = offline_engine(1);
    synthway_engine_t* engines[] = { open, filtered, corner, resonant, low_open, high_passed };
    const float frequencies[] = { 6000.0f, 6000.0f, 1000.0f, 1000.0f, 100.0f, 100.0f };
    for (unsigned i = 0; i < 6; ++i) {
        synthway_engine_set_frequency(engines[i], frequencies[i]);
        synthway_engine_set_volume(engines[i], 0.2f);
        synthway_engine_set_tone_enabled(engines[i], true);
    }
    check(synthway_engine_set_filter(open, 20.0f, 20000.0f, 0.0f) == SYNTHWAY_OK
        && synthway_engine_set_filter(filtered, 20.0f, 1000.0f, 0.0f) == SYNTHWAY_OK
        && synthway_engine_set_filter(corner, 20.0f, 20000.0f, 0.0f) == SYNTHWAY_OK
        && synthway_engine_set_filter(resonant, 20.0f, 1000.0f, 0.5f) == SYNTHWAY_OK
        && synthway_engine_set_filter(low_open, 20.0f, 20000.0f, 0.0f) == SYNTHWAY_OK
        && synthway_engine_set_filter(high_passed, 1000.0f, 20000.0f, 0.0f) == SYNTHWAY_OK,
        "filter parameters accepted", "open, cutoff, resonance");
    float* open_samples = render(open, frames);
    float* filtered_samples = render(filtered, frames);
    float* corner_samples = render(corner, frames);
    float* resonant_samples = render(resonant, frames);
    float* low_open_samples = render(low_open, frames);
    float* high_passed_samples = render(high_passed, frames);
    const double open_high = measure_amplitude(open_samples + WARMUP_FRAMES, SAMPLE_RATE, 6000.0);
    const double filtered_high = measure_amplitude(filtered_samples + WARMUP_FRAMES, SAMPLE_RATE, 6000.0);
    const double unresonant_corner = measure_amplitude(corner_samples + WARMUP_FRAMES, SAMPLE_RATE, 1000.0);
    const double resonant_corner = measure_amplitude(resonant_samples + WARMUP_FRAMES, SAMPLE_RATE, 1000.0);
    const double open_low = measure_amplitude(low_open_samples + WARMUP_FRAMES, SAMPLE_RATE, 100.0);
    const double filtered_low = measure_amplitude(high_passed_samples + WARMUP_FRAMES, SAMPLE_RATE, 100.0);
    char detail[160];
    snprintf(detail, sizeof(detail), "6 kHz %.4f to %.4f; 100 Hz %.4f to %.4f; resonance at 1 kHz %.4f to %.4f",
        open_high, filtered_high, open_low, filtered_low, unresonant_corner, resonant_corner);
    check(filtered_high < open_high * 0.2 && filtered_low < open_low * 0.2
        && resonant_corner > unresonant_corner * 2.0,
        "band-pass bounds attenuate outside frequencies and resonance boosts the cutoff", detail);
    free(open_samples);
    free(filtered_samples);
    free(corner_samples);
    free(resonant_samples);
    free(low_open_samples);
    free(high_passed_samples);
}

/* Square note at 220 Hz, volume 0.2, stereo, held for held_frames then released */
static float* render_reverb(float mix, uint32_t held_frames, uint32_t after_frames) {
    synthway_engine_t* engine = offline_engine(2);
    synthway_engine_set_frequency(engine, 220.0f);
    synthway_engine_set_volume(engine, 0.2f);
    synthway_engine_set_waveform(engine, SYNTHWAY_WAVEFORM_SQUARE);
    synthway_engine_set_reverb(engine, mix);
    float* samples = (float*)malloc(sizeof(float) * 2 * (held_frames + after_frames));
    if (!samples) exit(2);
    synthway_engine_render(engine, samples, held_frames);
    synthway_engine_set_tone_enabled(engine, false);
    synthway_engine_render(engine, samples + 2 * held_frames, after_frames);
    synthway_engine_destroy(engine);
    return samples;
}

static void test_reverb(void) {
    synthway_engine_t* engine = offline_engine(1);
    const float default_mix = synthway_engine_get_reverb(engine);
    check(default_mix == 0.0f
        && synthway_engine_set_reverb(engine, -0.1f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_set_reverb(engine, 1.1f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_set_reverb(engine, NAN) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_set_reverb(engine, 0.4f) == SYNTHWAY_OK
        && synthway_engine_get_reverb(engine) == 0.4f,
        "reverb mix validated", "off by default, 0 to 1");
    synthway_engine_destroy(engine);

    /* Held 1 s, then 3.5 s of tail */
    const uint32_t held = SAMPLE_RATE, after = SAMPLE_RATE * 7 / 2, window = SAMPLE_RATE / 5;
    float* dry = render_reverb(0.0f, held, after);
    float* half = render_reverb(0.5f, held, after);
    float* full = render_reverb(1.0f, held, after);
    const float* held_dry = dry + 2 * (held - window);
    const double dry_rms = measure_rms(held_dry, window, 2);
    const double full_rms = measure_rms(full + 2 * (held - window), window, 2);
    const double early_tail = measure_rms(half + 2 * (held + SAMPLE_RATE / 10), window, 2);
    const double late_tail = measure_rms(half + 2 * (held + 3 * SAMPLE_RATE), window, 2);
    const double dry_tail = measure_peak(dry + 2 * (held + SAMPLE_RATE / 10), window, 2);
    double cross = 0.0, left = 0.0, right = 0.0;
    const float* held_half = half + 2 * (held - window);
    for (uint32_t i = 0; i < window; ++i) {
        cross += (double)held_half[2 * i] * held_half[2 * i + 1];
        left += (double)held_half[2 * i] * held_half[2 * i];
        right += (double)held_half[2 * i + 1] * held_half[2 * i + 1];
    }
    const double correlation = cross / sqrt(left * right);
    const double peak = measure_peak(full, held + after, 2);
    char detail[200];
    snprintf(detail, sizeof(detail),
        "held RMS dry %.4f, full mix %.4f; tail at 0.1 s %.4f, at 3 s %.6f, dry %.4f; L/R correlation %.3f; peak %.3f",
        dry_rms, full_rms, early_tail, late_tail, dry_tail, correlation, peak);
    check(full_rms > dry_rms * 0.7 && full_rms < dry_rms * 1.4
        && early_tail > dry_rms * 0.03 && late_tail < dry_rms * 0.001 && dry_tail == 0.0
        && correlation < 0.9 && isfinite(peak) && peak < 0.2 * 4.0,
        "reverb keeps the level, rings after the note, decays, and is stereo", detail);
    free(dry);
    free(half);
    free(full);

    /* Back at 0, it fades out within a block, then the output is again exactly
       the dry one (mono: the mean of both sides while it plays) */
    synthway_engine_t* plain = offline_engine(1);
    synthway_engine_t* turned_off = offline_engine(1);
    synthway_engine_set_reverb(turned_off, 0.5f);
    float* before = render(turned_off, SAMPLE_RATE / 10);
    synthway_engine_set_reverb(turned_off, 0.0f);
    float* fading = render(turned_off, SAMPLE_RATE / 50);
    float* off_samples = render(turned_off, SAMPLE_RATE / 10);
    float* plain_samples = render(plain, SAMPLE_RATE / 10 + SAMPLE_RATE / 50 + SAMPLE_RATE / 10);
    const float* plain_after = plain_samples + SAMPLE_RATE / 10 + SAMPLE_RATE / 50;
    int same = 1;
    for (uint32_t i = 0; i < SAMPLE_RATE / 10; ++i) {
        same &= off_samples[i] == plain_after[i];
    }
    snprintf(detail, sizeof(detail), "mono, after a 20 ms block back at 0; peak with reverb %.4f",
        measure_peak(before, SAMPLE_RATE / 10, 1));
    check(same, "reverb back at 0 leaves the sound untouched", detail);
    free(before);
    free(fading);
    free(plain_samples);
    free(off_samples);
    synthway_engine_destroy(plain);
    synthway_engine_destroy(turned_off);
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

static void test_timbre_exponential_envelope(void) {
    /* A 440 Hz partial with no attack and an exponential decay of 1 s to
       silence falls 60 dB per second: 0.25 s and 0.5 s are 15 and 30 dB down.
       Another, held, then released with an exponential release of 0.4 s:
       0.1 s and 0.2 s after the note off, 15 and 30 dB down. Each level is
       measured over 25 ms (11 periods), centred on the moment. */
    const uint32_t span = SAMPLE_RATE / 40;
    synthway_partial_t decaying = sine_partial(1.0f, 0.5f);
    decaying.envelope.attack_s = 0.0f;
    decaying.envelope.decay_s = 1.0f;
    decaying.envelope.sustain_level = 0.0f;
    decaying.envelope.curve = SYNTHWAY_ENVELOPE_EXPONENTIAL;
    synthway_timbre_t timbre = timbre_of(1, &decaying);
    synthway_engine_t* engine = timbre_engine(440.0f, &timbre);
    float* x = render(engine, SAMPLE_RATE * 6 / 10);
    const double at_quarter = measure_amplitude(x + SAMPLE_RATE / 4 - span / 2, span, 440.0);
    const double at_half = measure_amplitude(x + SAMPLE_RATE / 2 - span / 2, span, 440.0);
    free(x);
    synthway_engine_destroy(engine);

    synthway_partial_t held = sine_partial(1.0f, 0.5f);
    held.envelope.release_s = 0.4f;
    held.envelope.release_curve = SYNTHWAY_ENVELOPE_EXPONENTIAL;
    timbre = timbre_of(1, &held);
    engine = timbre_engine(440.0f, &timbre);
    float* before = render(engine, SAMPLE_RATE / 5);
    synthway_engine_set_tone_enabled(engine, false);
    float* after = render(engine, SAMPLE_RATE / 2);
    const double released_100 = measure_amplitude(after + SAMPLE_RATE / 10 - span / 2, span, 440.0);
    const double released_200 = measure_amplitude(after + SAMPLE_RATE / 5 - span / 2, span, 440.0);
    const double released_end = measure_amplitude(after + SAMPLE_RATE / 2 - span, span, 440.0); /* past the 0.4 s */
    free(before);
    free(after);
    synthway_engine_destroy(engine);

    const double db = 20.0 * log10(at_half / at_quarter);
    const double release_db = 20.0 * log10(released_200 / released_100);
    char detail[200];
    snprintf(detail, sizeof(detail), "decay 0.25 s %.4f, 0.5 s %.4f (%.2f dB); release +0.1 s %.4f, +0.2 s %.4f (%.2f dB), end %.6f",
             at_quarter, at_half, db, released_100, released_200, release_db, released_end);
    check(fabs(at_quarter - 0.5 * pow(10.0, -0.75)) < 0.004 && fabs(db + 15.0) < 0.5
              && fabs(released_100 - 0.5 * pow(10.0, -0.75)) < 0.004 && fabs(release_db + 15.0) < 0.5 && released_end < 0.001,
          "timbre: exponential decay and release fall 60 dB in their time", detail);
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
    bad = timbre;
    bad.partials[0].envelope.curve = (synthway_envelope_curve_t)5;
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

static void test_decay_and_release_curves_apart(void) {
    /* One square partial (|sample| = volume × level), volume 0.5: an exponential decay of 1 s down
       to a sustain of 0 is 15 dB down after 0.25 s, then a linear release of 0.2 s from wherever it
       is halves the level after 0.1 s. Before, both shared one curve. */
    synthway_partial_t partial = sine_partial(1.0f, 1.0f);
    partial.waveform = SYNTHWAY_WAVEFORM_SQUARE;
    partial.envelope.attack_s = 0.0f;
    partial.envelope.decay_s = 1.0f;
    partial.envelope.sustain_level = 0.0f;
    partial.envelope.release_s = 0.2f;
    partial.envelope.curve = SYNTHWAY_ENVELOPE_EXPONENTIAL;
    partial.envelope.release_curve = SYNTHWAY_ENVELOPE_LINEAR;
    synthway_timbre_t timbre = timbre_of(1, &partial);
    synthway_engine_t* engine = timbre_engine(440.0f, &timbre);
    synthway_engine_set_volume(engine, 0.5f);
    free(render(engine, WARMUP_FRAMES)); /* the volume settles while the tone is off */
    synthway_engine_set_tone_enabled(engine, false);
    free(render(engine, SAMPLE_RATE / 2));
    synthway_engine_set_tone_enabled(engine, true);
    float* held = render(engine, SAMPLE_RATE / 4);
    const double before = level_at(held, 0.25 - 1.0 / SAMPLE_RATE);
    synthway_engine_set_tone_enabled(engine, false);
    float* released = render(engine, SAMPLE_RATE / 4);
    const double halfway = level_at(released, 0.1);
    const double after = level_at(released, 0.21);
    free(held);
    free(released);
    synthway_engine_destroy(engine);
    char detail[160];
    snprintf(detail, sizeof(detail), "decay to %.4f (%.4f expected), release halfway %.4f, after %.4f",
             before, 0.5 * pow(10.0, -0.75), halfway, after);
    check(fabs(before - 0.5 * pow(10.0, -0.75)) < 0.003 && fabs(halfway - 0.5 * before) < 0.003 && after == 0.0,
          "exponential decay, then a linear release: each segment has its own curve", detail);
}

static void test_convex_attack(void) {
    /* One square partial (|sample| = volume × level), 100 ms attack, volume
       0.5: halfway, a straight attack is at 0.25, a convex one at 0.125 (the
       square of one half); both reach 0.5 at the end */
    synthway_partial_t partial = sine_partial(1.0f, 1.0f);
    partial.waveform = SYNTHWAY_WAVEFORM_SQUARE;
    partial.envelope.attack_s = 0.1f;
    double halfway[2], quarter[2], top[2];
    for (int convex = 0; convex < 2; ++convex) {
        partial.envelope.attack_curve = convex ? SYNTHWAY_ATTACK_CONVEX : SYNTHWAY_ATTACK_LINEAR;
        synthway_timbre_t timbre = timbre_of(1, &partial);
        synthway_engine_t* engine = timbre_engine(440.0f, &timbre);
        synthway_engine_set_volume(engine, 0.5f);
        free(render(engine, WARMUP_FRAMES)); /* the volume settles while the tone is off */
        synthway_engine_set_tone_enabled(engine, false);
        free(render(engine, SAMPLE_RATE / 10));
        synthway_engine_set_tone_enabled(engine, true);
        float* x = render(engine, SAMPLE_RATE / 5);
        quarter[convex] = level_at(x, 0.025);
        halfway[convex] = level_at(x, 0.05);
        top[convex] = level_at(x, 0.15);
        free(x);
        synthway_engine_destroy(engine);
    }
    char detail[160];
    snprintf(detail, sizeof(detail), "straight %.4f / %.4f / %.4f, convex %.4f / %.4f / %.4f (at 25, 50, 150 ms)",
             quarter[0], halfway[0], top[0], quarter[1], halfway[1], top[1]);
    check(near(quarter[0], 0.125) && near(halfway[0], 0.25) && near(top[0], 0.5)
              && near(quarter[1], 0.03125) && near(halfway[1], 0.125) && near(top[1], 0.5),
          "convex attack follows the square of the straight one", detail);
}

/* A held note of timbre, volume 1, rendered on channels channels with this unison */
static float* render_unison(const synthway_timbre_t* timbre, uint32_t channels, uint32_t voices,
                            float detune, float spread, uint32_t frames, synthway_result_t* result) {
    synthway_engine_t* engine = offline_engine(channels);
    synthway_engine_set_frequency(engine, 440.0f);
    synthway_engine_set_volume(engine, 1.0f);
    synthway_engine_set_timbre(engine, timbre);
    *result = synthway_engine_set_unison(engine, voices, detune, spread);
    synthway_engine_set_tone_enabled(engine, true);
    float* x = render(engine, frames);
    synthway_engine_destroy(engine);
    return x;
}

static void test_unison(void) {
    const synthway_partial_t partials[] = { sine_partial(1.0f, 0.5f), sine_partial(2.0f, 0.25f) };
    const synthway_timbre_t timbre = timbre_of(2, partials);
    /* 4 s: frequency resolution fine enough to tell voices 1.7 Hz apart */
    const uint32_t frames = SAMPLE_RATE * 4;
    synthway_result_t result;

    /* Off by default; one voice is exactly the timbre without unison, whatever the detune and spread */
    synthway_engine_t* engine = offline_engine(2);
    uint32_t voices = 0;
    float detune = -1.0f, spread = -1.0f;
    synthway_engine_get_unison(engine, &voices, &detune, &spread);
    const int refused = synthway_engine_set_unison(engine, 0, 10.0f, 0.5f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_set_unison(engine, SYNTHWAY_MAX_UNISON_VOICES + 1, 10.0f, 0.5f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_set_unison(engine, 4, -1.0f, 0.5f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_set_unison(engine, 4, 101.0f, 0.5f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_set_unison(engine, 4, NAN, 0.5f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_set_unison(engine, 4, 10.0f, 1.1f) == SYNTHWAY_INVALID_PARAM;
    uint32_t kept_voices = 0;
    synthway_engine_get_unison(engine, &kept_voices, &detune, &spread);
    synthway_engine_destroy(engine);
    char detail[240];
    snprintf(detail, sizeof(detail), "default %u voice(s), out-of-range values refused, kept %u / %.1f / %.1f",
             voices, kept_voices, detune, spread);
    check(voices == 1 && refused && kept_voices == 1 && detune == 0.0f && spread == 0.0f,
          "unison off by default, validated", detail);

    float* plain = render_unison(&timbre, 2, 1, 0.0f, 0.0f, frames, &result);
    float* single = render_unison(&timbre, 2, 1, 30.0f, 1.0f, frames, &result);
    check(memcmp(plain, single, sizeof(float) * frames * 2) == 0, "one unison voice leaves the sound untouched",
          "1 voice, 30 cents, spread 1");

    /* 7 voices, 20 cents apart at most, spread wide: the voices of the
       fundamental sit at 440 Hz and up to 20 cents on each side, each at
       0.5 / sqrt(7) in mono; they beat, and left and right differ */
    float* wide = render_unison(&timbre, 2, 7, 20.0f, 1.0f, frames, &result);
    float* mono = render_unison(&timbre, 1, 7, 20.0f, 0.0f, frames, &result);
    const uint32_t settled = SAMPLE_RATE / 10, span = frames - settled;
    const double centre = measure_amplitude(mono + settled, span, 440.0);
    const double outer = measure_amplitude(mono + settled, span, 440.0 * pow(2.0, 20.0 / 1200.0));
    const double voice = 0.5 / sqrt(7.0);
    double sum_lr = 0.0, sum_ll = 0.0, sum_rr = 0.0;
    for (uint32_t i = settled; i < frames; ++i) {
        const double l = wide[2 * i], r = wide[2 * i + 1];
        sum_lr += l * r;
        sum_ll += l * l;
        sum_rr += r * r;
    }
    const double correlation = sum_lr / sqrt(sum_ll * sum_rr);
    /* Beating: the level over 50 ms windows rises and falls */
    double lowest = 1e9, highest = 0.0;
    for (uint32_t start = settled; start + SAMPLE_RATE / 20 <= frames; start += SAMPLE_RATE / 20) {
        const double rms = measure_rms(mono + start, SAMPLE_RATE / 20, 1);
        lowest = fmin(lowest, rms);
        highest = fmax(highest, rms);
    }
    const double plain_rms = measure_rms(plain + 2 * settled, span, 2);
    const double mono_rms = measure_rms(mono + settled, span, 1);
    snprintf(detail, sizeof(detail),
             "voice at 440 Hz %.4f and +20 cents %.4f (each %.4f expected); left/right correlation %.2f; "
             "level %.4f to %.4f over 50 ms; RMS %.4f vs %.4f without unison",
             centre, outer, voice, correlation, lowest, highest, mono_rms, plain_rms);
    check(result == SYNTHWAY_OK && fabs(centre - voice) < 0.03 && fabs(outer - voice) < 0.03 && correlation < 0.9
              && highest > 1.5 * lowest && fabs(20.0 * log10(mono_rms / plain_rms)) < 3.0,
          "unison: detuned voices beat, spread across left and right, at about the same loudness", detail);

    free(plain);
    free(single);
    free(wide);
    free(mono);
}

/* ---------------------------------------------------------------------------
   Polyphony: notes on instruments, each with its own envelopes
   --------------------------------------------------------------------------- */

/* One sine partial at full amplitude with this envelope, band open, no reverb */
static synthway_instrument_t sine_instrument(float attack, float decay, float sustain, float release) {
    synthway_instrument_t instrument;
    memset(&instrument, 0, sizeof(instrument));
    instrument.waveform = SYNTHWAY_WAVEFORM_SINE;
    instrument.envelope.attack_s = 0.005f;
    instrument.envelope.sustain_level = 1.0f;
    instrument.envelope.release_s = 0.01f;
    instrument.filter_low_cutoff_hz = 20.0f;
    instrument.filter_high_cutoff_hz = 20000.0f;
    instrument.unison_voices = 1;
    synthway_partial_t partial = sine_partial(1.0f, 1.0f);
    partial.envelope.attack_s = attack;
    partial.envelope.decay_s = decay;
    partial.envelope.sustain_level = sustain;
    partial.envelope.release_s = release;
    instrument.has_timbre = true;
    instrument.timbre = timbre_of(1, &partial);
    return instrument;
}

/* Mono offline engine with the single-note API silent */
static synthway_engine_t* poly_engine(void) {
    synthway_engine_t* engine = offline_engine(1);
    synthway_engine_set_tone_enabled(engine, false);
    return engine;
}

static void test_poly_overlapping_notes(void) {
    synthway_engine_t* engine = poly_engine();
    const synthway_instrument_t sine = sine_instrument(0.005f, 0.0f, 1.0f, 0.01f);
    const synthway_result_t set = synthway_engine_set_instrument(engine, 1, &sine);
    synthway_engine_note_on(engine, 1, 1, 440.0f, 0.4f);
    free(render(engine, SAMPLE_RATE / 5));
    synthway_engine_note_on(engine, 2, 1, 660.0f, 0.3f);
    /* 0.5 s after the second note: whole periods of both */
    float* both = render(engine, WARMUP_FRAMES + SAMPLE_RATE / 2);
    const double both_440 = measure_amplitude(both + WARMUP_FRAMES, SAMPLE_RATE / 2, 440.0);
    const double both_660 = measure_amplitude(both + WARMUP_FRAMES, SAMPLE_RATE / 2, 660.0);
    const uint32_t sounding_both = synthway_engine_get_sounding_notes(engine);

    synthway_engine_note_off(engine, 1);
    float* after = render(engine, WARMUP_FRAMES + SAMPLE_RATE / 20);
    const double after_440 = measure_amplitude(after + WARMUP_FRAMES, SAMPLE_RATE / 20, 440.0);
    const double after_660 = measure_amplitude(after + WARMUP_FRAMES, SAMPLE_RATE / 20, 660.0);
    const uint32_t sounding_after = synthway_engine_get_sounding_notes(engine);

    char detail[192];
    snprintf(detail, sizeof(detail), "together 440 Hz %.4f, 660 Hz %.4f, %u note(s); first released: %.5f and %.4f, %u note(s)",
             both_440, both_660, sounding_both, after_440, after_660, sounding_after);
    check(set == SYNTHWAY_OK && fabs(both_440 - 0.4) < 0.005 && fabs(both_660 - 0.3) < 0.005 && sounding_both == 2
              && after_440 < 0.001 && fabs(after_660 - 0.3) < 0.005 && sounding_after == 1,
          "polyphony: a second note plays along the first, each released apart", detail);
    free(both);
    free(after);
    synthway_engine_destroy(engine);
}

/* A pluck: up in 5 ms, then down to silence in 0.2 s while held */
static void test_poly_each_note_attacks(void) {
    synthway_engine_t* engine = poly_engine();
    const synthway_instrument_t pluck = sine_instrument(0.005f, 0.2f, 0.0f, 0.01f);
    synthway_engine_set_instrument(engine, 1, &pluck);
    synthway_engine_note_on(engine, 1, 1, 220.0f, 0.5f);
    float* first = render(engine, SAMPLE_RATE / 2);
    const double first_end = measure_peak(first + SAMPLE_RATE / 2 - SAMPLE_RATE / 20, SAMPLE_RATE / 20, 1);

    /* Another note while the first is held but faded out: its own attack */
    synthway_engine_note_on(engine, 2, 1, 330.0f, 0.5f);
    float* second = render(engine, SAMPLE_RATE / 2);
    const double second_peak = measure_peak(second, SAMPLE_RATE / 50, 1);

    /* The same note struck again: a new attack too */
    synthway_engine_note_on(engine, 1, 1, 220.0f, 0.5f);
    float* again = render(engine, SAMPLE_RATE / 50);
    const double again_peak = measure_peak(again, SAMPLE_RATE / 50, 1);
    const uint32_t sounding = synthway_engine_get_sounding_notes(engine);

    char detail[160];
    snprintf(detail, sizeof(detail), "first note faded to %.5f; second note peak %.3f; first struck again %.3f; %u note(s) held",
             first_end, second_peak, again_peak, sounding);
    check(first_end < 0.001 && second_peak > 0.44 && again_peak > 0.44 && sounding == 2,
          "polyphony: each note starts with its own attack, even struck again", detail);
    free(first);
    free(second);
    free(again);
    synthway_engine_destroy(engine);
}

static void test_poly_instruments_apart(void) {
    synthway_engine_t* engine = poly_engine();
    synthway_instrument_t muffled = sine_instrument(0.005f, 0.0f, 1.0f, 0.01f);
    muffled.filter_high_cutoff_hz = 300.0f;
    const synthway_instrument_t open = sine_instrument(0.005f, 0.0f, 1.0f, 0.01f);
    synthway_engine_set_instrument(engine, 1, &muffled);
    synthway_engine_set_instrument(engine, 2, &open);
    synthway_engine_note_on(engine, 10, 1, 3000.0f, 0.5f);
    synthway_engine_note_on(engine, 20, 2, 2000.0f, 0.5f);
    float* x = render(engine, WARMUP_FRAMES + SAMPLE_RATE / 4);
    const double muffled_3000 = measure_amplitude(x + WARMUP_FRAMES, SAMPLE_RATE / 4, 3000.0);
    const double open_2000 = measure_amplitude(x + WARMUP_FRAMES, SAMPLE_RATE / 4, 2000.0);

    /* The single-note API plays along, on instrument 0 */
    synthway_engine_set_frequency(engine, 440.0f);
    synthway_engine_set_volume(engine, 0.25f);
    synthway_engine_set_tone_enabled(engine, true);
    float* y = render(engine, WARMUP_FRAMES + SAMPLE_RATE / 4);
    const double single_440 = measure_amplitude(y + WARMUP_FRAMES, SAMPLE_RATE / 4, 440.0);
    const double still_2000 = measure_amplitude(y + WARMUP_FRAMES, SAMPLE_RATE / 4, 2000.0);

    char detail[192];
    snprintf(detail, sizeof(detail), "3000 Hz through a 300 Hz low-pass %.4f, 2000 Hz open %.4f; single note 440 Hz %.4f along 2000 Hz %.4f",
             muffled_3000, open_2000, single_440, still_2000);
    check(muffled_3000 < 0.01 && fabs(open_2000 - 0.5) < 0.005 && fabs(single_440 - 0.25) < 0.005 && fabs(still_2000 - 0.5) < 0.005,
          "polyphony: each instrument filters its own notes, the single note plays along", detail);
    free(x);
    free(y);
    synthway_engine_destroy(engine);
}

static void test_poly_reverb_per_instrument(void) {
    double tails[2];
    for (int wet = 0; wet < 2; ++wet) {
        synthway_engine_t* engine = poly_engine();
        synthway_instrument_t instrument = sine_instrument(0.005f, 0.0f, 1.0f, 0.01f);
        const synthway_instrument_t dry = instrument;
        instrument.reverb_mix = wet ? 0.6f : 0.0f;
        synthway_engine_set_instrument(engine, 1, &instrument);
        synthway_engine_set_instrument(engine, 2, &dry);
        synthway_engine_note_on(engine, 1, 1, 440.0f, 0.5f);
        synthway_engine_note_on(engine, 2, 2, 660.0f, 0.5f);
        free(render(engine, SAMPLE_RATE / 4));
        synthway_engine_all_notes_off(engine);
        float* x = render(engine, SAMPLE_RATE / 2);
        tails[wet] = measure_rms(x + SAMPLE_RATE / 10, SAMPLE_RATE / 5, 1);
        free(x);
        synthway_engine_destroy(engine);
    }
    char detail[128];
    snprintf(detail, sizeof(detail), "0.1 to 0.3 s after the notes: dry %.6f, one instrument with reverb %.4f", tails[0], tails[1]);
    check(tails[0] == 0.0 && tails[1] > 0.01, "polyphony: only the instrument with reverb rings on", detail);
}

static void test_poly_voice_limit(void) {
    synthway_engine_t* engine = poly_engine();
    const synthway_instrument_t sine = sine_instrument(0.005f, 0.0f, 1.0f, 0.01f);
    synthway_engine_set_instrument(engine, 1, &sine);
    /* One more than the engine holds: the oldest, at 200 Hz, makes way */
    for (uint32_t k = 0; k <= SYNTHWAY_MAX_NOTES; ++k) {
        synthway_engine_note_on(engine, 100 + k, 1, 200.0f + 10.0f * (float)k, 0.02f);
    }
    float* x = render(engine, SAMPLE_RATE / 5);
    const float* window = x + SAMPLE_RATE / 10; /* 0.1 s: whole periods of every 10 Hz */
    const double oldest = measure_amplitude(window, SAMPLE_RATE / 10, 200.0);
    const double second = measure_amplitude(window, SAMPLE_RATE / 10, 210.0);
    const double newest = measure_amplitude(window, SAMPLE_RATE / 10, 200.0 + 10.0 * SYNTHWAY_MAX_NOTES);
    const uint32_t full = synthway_engine_get_sounding_notes(engine);

    synthway_engine_all_notes_off(engine);
    float* y = render(engine, SAMPLE_RATE / 10);
    const double tail = measure_peak(y + SAMPLE_RATE / 20, SAMPLE_RATE / 20, 1);
    const uint32_t left = synthway_engine_get_sounding_notes(engine);

    char detail[160];
    snprintf(detail, sizeof(detail), "%u notes asked, %u sound; oldest %.5f, second %.4f, newest %.4f; all off: peak %.6f, %u left",
             SYNTHWAY_MAX_NOTES + 1, full, oldest, second, newest, tail, left);
    check(full == SYNTHWAY_MAX_NOTES && oldest < 0.0005 && fabs(second - 0.02) < 0.001 && fabs(newest - 0.02) < 0.001
              && tail == 0.0 && left == 0,
          "polyphony: beyond the limit the oldest note makes way; all notes off", detail);
    free(x);
    free(y);
    synthway_engine_destroy(engine);
}

static void test_poly_validation(void) {
    synthway_engine_t* engine = poly_engine();
    synthway_instrument_t good = sine_instrument(0.005f, 0.0f, 1.0f, 0.01f);
    good.reverb_mix = 0.25f;
    synthway_instrument_t bad_band = good;
    bad_band.filter_low_cutoff_hz = 5000.0f;
    bad_band.filter_high_cutoff_hz = 1000.0f;
    synthway_instrument_t bad_partial = good;
    bad_partial.timbre.partials[0].amplitude = 2.0f;
    synthway_instrument_t bad_unison = good;
    bad_unison.unison_voices = 0;

    const int set = synthway_engine_set_instrument(engine, 3, &good) == SYNTHWAY_OK;
    const int refused = synthway_engine_set_instrument(engine, SYNTHWAY_MAX_INSTRUMENTS, &good) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_set_instrument(engine, 3, &bad_band) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_set_instrument(engine, 3, &bad_partial) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_set_instrument(engine, 3, &bad_unison) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_set_instrument(engine, 3, NULL) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_note_on(engine, 1, SYNTHWAY_MAX_INSTRUMENTS, 440.0f, 0.5f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_note_on(engine, 1, 0, 0.0f, 0.5f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_note_on(engine, 1, 0, NAN, 0.5f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_note_on(engine, 1, 0, 440.0f, 1.5f) == SYNTHWAY_INVALID_PARAM;

    synthway_instrument_t kept;
    synthway_engine_get_instrument(engine, 3, &kept);
    const int unchanged = kept.reverb_mix == 0.25f && kept.filter_high_cutoff_hz == 20000.0f && kept.has_timbre
        && kept.timbre.partial_count == 1 && kept.timbre.partials[0].amplitude == 1.0f;

    /* Instrument 0 is the one the single-note API's setters set */
    synthway_engine_set_reverb(engine, 0.3f);
    synthway_instrument_t first;
    synthway_engine_get_instrument(engine, 0, &first);
    synthway_engine_set_instrument(engine, 0, &good);
    const int shared = first.reverb_mix == 0.3f && !first.has_timbre && synthway_engine_get_reverb(engine) == 0.25f
        && synthway_engine_has_timbre(engine);

    /* Too many notes waiting for an audio thread that does not run */
    int accepted = 1;
    for (uint32_t k = 0; k < 1024; ++k) {
        accepted = accepted && synthway_engine_note_off(engine, k) == SYNTHWAY_OK;
    }
    const int full = synthway_engine_note_off(engine, 0) == SYNTHWAY_ERROR;
    free(render(engine, 1));
    const int room_again = synthway_engine_note_off(engine, 0) == SYNTHWAY_OK;

    char detail[160];
    snprintf(detail, sizeof(detail), "set %d, refused %d, kept %d, instrument 0 shared %d, queue 1024 %d then full %d, room after a block %d",
             set, refused, unchanged, shared, accepted, full, room_again);
    check(set && refused && unchanged && shared && accepted && full && room_again,
          "polyphony: invalid instruments and notes refused, instrument 0 shared, queue bounded", detail);
    synthway_engine_destroy(engine);
}

/* ---------------------------------------------------------------------------
   Glides: a note's frequency on a straight line in semitones
   --------------------------------------------------------------------------- */

/* Frequency over 40 ms centred on seconds */
static double frequency_at(const float* x, double seconds) {
    const uint32_t window = SAMPLE_RATE / 25;
    return measure_frequency(x + (uint32_t)(seconds * SAMPLE_RATE) - window / 2, window, 1);
}

static int within(double value, double expected, double share) {
    return fabs(value - expected) <= expected * share;
}

static void test_glide_follows_semitones(void) {
    synthway_engine_t* engine = poly_engine();
    const synthway_instrument_t sine = sine_instrument(0.005f, 0.0f, 1.0f, 0.01f);
    synthway_engine_set_instrument(engine, 1, &sine);
    synthway_engine_note_on(engine, 1, 1, 220.0f, 0.5f);
    /* An octave up in 1 s, held 0.5 s, then down a fourth in 0.25 s */
    const int queued = synthway_engine_note_glide(engine, 1, 440.0f, 1.0f) == SYNTHWAY_OK
        && synthway_engine_note_glide(engine, 1, 440.0f, 0.5f) == SYNTHWAY_OK
        && synthway_engine_note_glide(engine, 1, 330.0f, 0.25f) == SYNTHWAY_OK;
    float* x = render(engine, 2 * SAMPLE_RATE);
    const double up_quarter = frequency_at(x, 0.25), up_half = frequency_at(x, 0.5), up_three = frequency_at(x, 0.75);
    const double held = frequency_at(x, 1.25), down_half = frequency_at(x, 1.625), after = frequency_at(x, 1.9);

    char detail[192];
    snprintf(detail, sizeof(detail), "%.1f / %.1f / %.1f Hz up (261.6 / 311.1 / 370.0), held %.1f, down %.1f (381.1), after %.1f",
             up_quarter, up_half, up_three, held, down_half, after);
    check(queued && within(up_quarter, 220.0 * pow(2.0, 0.25), 0.003) && within(up_half, 220.0 * sqrt(2.0), 0.003)
              && within(up_three, 220.0 * pow(2.0, 0.75), 0.003) && within(held, 440.0, 0.002)
              && within(down_half, 440.0 * sqrt(0.75), 0.003) && within(after, 330.0, 0.002),
          "glide: a straight line in semitones, chained, a glide to the same note holds it", detail);
    free(x);
    synthway_engine_destroy(engine);
}

static void test_glide_jump_and_release(void) {
    synthway_engine_t* engine = poly_engine();
    const synthway_instrument_t sine = sine_instrument(0.005f, 0.0f, 1.0f, 0.5f);
    synthway_engine_set_instrument(engine, 1, &sine);
    synthway_engine_note_on(engine, 2, 1, 440.0f, 0.5f);
    synthway_engine_note_glide(engine, 2, 660.0f, 0.0f); /* a jump */
    float* held = render(engine, SAMPLE_RATE / 5);
    const double jumped = frequency_at(held, 0.1);

    /* Released, it keeps gliding while it fades out */
    synthway_engine_note_off(engine, 2);
    synthway_engine_note_glide(engine, 2, 330.0f, 0.1f);
    float* fading = render(engine, SAMPLE_RATE / 4);
    const double released = frequency_at(fading, 0.2);
    const double level = measure_peak(fading + SAMPLE_RATE / 5 - SAMPLE_RATE / 50, SAMPLE_RATE / 50, 1);

    char detail[128];
    snprintf(detail, sizeof(detail), "jump to %.1f Hz; released, glided to %.1f Hz at level %.3f", jumped, released, level);
    check(within(jumped, 660.0, 0.002) && within(released, 330.0, 0.002) && level > 0.05,
          "glide: 0 s is a jump, and a released note keeps gliding", detail);
    free(held);
    free(fading);
    synthway_engine_destroy(engine);
}

static void test_glide_limits(void) {
    synthway_engine_t* engine = poly_engine();
    const synthway_instrument_t sine = sine_instrument(0.005f, 0.0f, 1.0f, 0.01f);
    synthway_engine_set_instrument(engine, 1, &sine);

    /* note_on drops the glides still to come */
    synthway_engine_note_on(engine, 3, 1, 440.0f, 0.5f);
    synthway_engine_note_glide(engine, 3, 880.0f, 1.0f);
    free(render(engine, SAMPLE_RATE / 10));
    synthway_engine_note_on(engine, 3, 1, 440.0f, 0.5f);
    float* again = render(engine, SAMPLE_RATE / 2);
    const double restruck = frequency_at(again, 0.4);

    /* SYNTHWAY_MAX_GLIDES wait; the one after is ignored, as is a glide of a note that does not sound */
    synthway_engine_note_on(engine, 4, 1, 330.0f, 0.5f);
    for (uint32_t k = 0; k < SYNTHWAY_MAX_GLIDES; ++k) {
        synthway_engine_note_glide(engine, 4, 330.0f, 0.005f);
    }
    synthway_engine_note_glide(engine, 4, 990.0f, 0.0f);
    const int unknown = synthway_engine_note_glide(engine, 99, 990.0f, 0.0f) == SYNTHWAY_OK;
    float* full = render(engine, SAMPLE_RATE / 2);
    /* 0.3 to 0.5 s: past the glides, whole periods of 330, 440 (note 3) and 990 Hz */
    const double kept = measure_amplitude(full + 3 * SAMPLE_RATE / 10, SAMPLE_RATE / 5, 330.0);
    const double ignored = measure_amplitude(full + 3 * SAMPLE_RATE / 10, SAMPLE_RATE / 5, 990.0);

    const int refused = synthway_engine_note_glide(engine, 4, 0.0f, 1.0f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_note_glide(engine, 4, NAN, 1.0f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_note_glide(engine, 4, 30000.0f, 1.0f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_note_glide(engine, 4, 440.0f, -0.1f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_note_glide(engine, 4, 440.0f, SYNTHWAY_MAX_GLIDE_SECONDS + 1.0f) == SYNTHWAY_INVALID_PARAM
        && synthway_engine_note_glide(NULL, 4, 440.0f, 1.0f) == SYNTHWAY_INVALID_PARAM;

    char detail[192];
    snprintf(detail, sizeof(detail), "struck again: %.1f Hz; %u glides kept 330 Hz %.3f, the next one ignored (990 Hz %.4f), unknown note %d, refused %d",
             restruck, SYNTHWAY_MAX_GLIDES, kept, ignored, unknown, refused);
    check(within(restruck, 440.0, 0.002) && fabs(kept - 0.5) < 0.005 && ignored < 0.001 && unknown && refused,
          "glide: dropped by note_on, bounded queue, invalid values refused", detail);
    free(again);
    free(full);
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
    test_filter_cutoff_and_resonance();
    test_reverb();
    test_timbre_partials();
    test_timbre_envelopes();
    test_timbre_exponential_envelope();
    test_timbre_single_partial_matches_oscillator();
    test_timbre_live_changes();
    test_timbre_partial_above_sample_rate();
    test_timbre_validation();
    test_decay_and_release_curves_apart();
    test_convex_attack();
    test_unison();
    test_poly_overlapping_notes();
    test_poly_each_note_attacks();
    test_poly_instruments_apart();
    test_poly_reverb_per_instrument();
    test_poly_voice_limit();
    test_poly_validation();
    test_glide_follows_semitones();
    test_glide_jump_and_release();
    test_glide_limits();
    test_wav_export(wav_path);

    printf("%s: %d failure(s)\n", failures ? "FAILED" : "OK", failures);
    return failures ? 1 : 0;
}
