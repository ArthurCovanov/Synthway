#if !defined(_WIN32)
    #define _DEFAULT_SOURCE /* -std=c11 hides usleep() otherwise */
#endif

#include "synthway/synthway.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
    #include <windows.h>
    #define synthway_sleep_ms(ms) Sleep(ms)
#else
    #include <unistd.h>
    #define synthway_sleep_ms(ms) usleep((ms) * 1000)
#endif

static void print_banner(void) {
    printf("===============================================================\n");
    printf("   ____              _   _                          \n");
    printf("  / ___| _   _ _ __ | |_| |____      ____ _ _   _   \n");
    printf("  \\___ \\| | | | '_ \\| __| '_ \\ \\ /\\ / / _` | | | |  \n");
    printf("   ___) | |_| | | | | |_| | | \\ V  V / (_| | |_| |  \n");
    printf("  |____/ \\__, |_| |_|\\__|_| |_|\\_/\\_/ \\__,_|\\__, |  \n");
    printf("         |___/                              |___/   \n");
    printf("   Synthway Core Audio Engine v%s (miniaudio)\n", synthway_get_version());
    printf("===============================================================\n");
}

static void print_usage(const char* prog) {
    printf("Usage:\n");
    printf("  %s                      : List devices and play a 440Hz test tone\n", prog);
    printf("  %s --list               : List all playback & capture devices\n", prog);
    printf("  %s --midi               : List all MIDI input & output ports\n", prog);
    printf("  %s --tone <freq> [sec]  : Play a tone at <freq> Hz for [sec] seconds (default: 3s)\n", prog);
    printf("  %s --waveform <0-3>     : 0=Sine, 1=Square, 2=Triangle, 3=Sawtooth\n", prog);
    printf("  %s --render <file.wav> [freq] [sec] [wave 0-3] [--partials <ratio:amp[:wave]>,...]\n", prog);
    printf("      Render a tone to a WAV file, offline: no audio device, no sound.\n");
    printf("      --partials plays a timbre instead, e.g. 1:0.5,2:0.25,2.76:0.2:3\n");
    printf("  %s --glide <file.wav> <start_freq> <freq:sec>,... [--partials ...]\n", prog);
    printf("      Render a note that glides from <start_freq> to each freq in sec seconds, in turn,\n");
    printf("      then holds 0.5 s, offline. e.g. --glide out.wav 220 440:1,440:0.5,330:0.25\n");
    printf("  %s --analyze <file> [sec] : Note and partials of a WAV, FLAC or MP3 file at [sec]\n", prog);
    printf("      seconds (default: the clearest moment). Nothing is played.\n");
    printf("  %s --listen [sec] [input] : Note heard by the microphone, live, for [sec] seconds\n", prog);
    printf("      (default: 10), from capture device [input] (default: the system's). Nothing is saved.\n");
    printf("      --analyze and --listen take --gate <dBFS> to ignore ambient noise below that level,\n");
    printf("      e.g. --gate -70 (default: off)\n");
}

/* Takes "--gate <dBFS>" out of the arguments, wherever it is after the mode.
   *out_gate is SYNTHWAY_ANALYZER_NOISE_GATE_OFF without it. Returns 0 on success. */
static int take_noise_gate(int* argc, char* argv[], float* out_gate) {
    *out_gate = SYNTHWAY_ANALYZER_NOISE_GATE_OFF;
    for (int i = 2; i < *argc; ++i) {
        if (strcmp(argv[i], "--gate") != 0) {
            continue;
        }
        char* end = NULL;
        if (i + 1 >= *argc || (*out_gate = strtof(argv[i + 1], &end), end == argv[i + 1])) {
            return 1;
        }
        for (int j = i; j + 2 < *argc; ++j) {
            argv[j] = argv[j + 2];
        }
        *argc -= 2;
        return 0;
    }
    return 0;
}

/* A new analyzer with the noise gate of the arguments, or NULL after an error message */
static synthway_analyzer_t* create_analyzer(int* argc, char* argv[]) {
    float gate;
    if (take_noise_gate(argc, argv, &gate) != 0) {
        fprintf(stderr, "[!] Error: --gate expects a level in dBFS, e.g. --gate -70\n");
        return NULL;
    }
    synthway_analyzer_t* analyzer = synthway_analyzer_create();
    if (!analyzer) {
        fprintf(stderr, "[!] Error: Failed to allocate the analyzer.\n");
        return NULL;
    }
    if (synthway_analyzer_set_noise_gate(analyzer, gate) != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Error: the noise gate goes from %.0f (off) to 0 dBFS\n", SYNTHWAY_ANALYZER_NOISE_GATE_OFF);
        synthway_analyzer_destroy(analyzer);
        return NULL;
    }
    if (gate > SYNTHWAY_ANALYZER_NOISE_GATE_OFF) {
        printf("[*] Noise gate: peaks below %.1f dBFS are ignored\n", gate);
    }
    return analyzer;
}

/* "A4 +3.2 cents" for a frequency, with A4 = 440 Hz */
static void format_note(float frequency, char* out, size_t size) {
    static const char* names[] = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };
    if (frequency <= 0.0f) {
        snprintf(out, size, "--");
        return;
    }
    const double midi = 69.0 + 12.0 * log2(frequency / 440.0);
    const long nearest = lround(midi);
    const double cents = 100.0 * (midi - (double)nearest);
    const long octave = (nearest >= 0 ? nearest : nearest - 11) / 12 - 1;
    snprintf(out, size, "%s%ld %+5.1f cents", names[((nearest % 12) + 12) % 12], octave, cents);
}

static void print_analysis(const synthway_analysis_t* analysis) {
    char note[40];
    format_note(analysis->frequency_hz, note, sizeof(note));
    printf("    Note     : %s (%.2f Hz)\n", note, analysis->frequency_hz);
    printf("    Clarity  : %.2f%s\n", analysis->clarity, analysis->clarity < 0.8f ? " (note unreliable)" : "");
    printf("    Level    : %.1f dBFS\n", analysis->level_db);
    printf("    Partials : %u\n", analysis->partial_count);
    if (analysis->partial_count > 0) {
        printf("      #   frequency     ratio   amplitude\n");
    }
    for (uint32_t i = 0; i < analysis->partial_count; ++i) {
        const synthway_analysis_partial_t* p = &analysis->partials[i];
        printf("    %3u  %9.2f Hz  %7.3f   %5.3f (%5.1f dB)\n",
               i + 1, p->frequency_hz, p->ratio, p->amplitude, 20.0 * log10(p->amplitude));
    }
}

/* Analysis of an audio file: nothing is played */
static int analyze_file(int argc, char* argv[]) {
    enum { TRACK_POINTS = 200 };
    synthway_analyzer_t* analyzer = create_analyzer(&argc, argv);
    if (!analyzer) {
        return 1;
    }
    if (argc < 3) {
        fprintf(stderr, "[!] Usage: %s --analyze <file> [sec] [--gate <dBFS>]\n", argv[0]);
        synthway_analyzer_destroy(analyzer);
        return 1;
    }
    synthway_result_t res = synthway_analyzer_load_clip(analyzer, argv[2]);
    if (res != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Error: Cannot load %s: %s (%d)\n", argv[2], synthway_result_to_string(res), res);
        synthway_analyzer_destroy(analyzer);
        return 1;
    }
    uint64_t frames = 0;
    uint32_t rate = 0;
    synthway_analyzer_get_clip_info(analyzer, &frames, &rate);
    const double duration = (double)frames / rate;

    double at = argc > 3 ? atof(argv[3]) : -1.0;
    if (at < 0.0) {
        /* The clearest moment among the loud ones (within 20 dB of the loudest) */
        float frequency[TRACK_POINTS], clarity[TRACK_POINTS], level[TRACK_POINTS];
        synthway_analyzer_get_clip_track(analyzer, TRACK_POINTS, frequency, clarity, level);
        float loudest = -1000.0f;
        for (int i = 0; i < TRACK_POINTS; ++i) {
            if (level[i] > loudest) loudest = level[i];
        }
        int best = -1;
        for (int i = 0; i < TRACK_POINTS; ++i) {
            if (frequency[i] > 0.0f && level[i] >= loudest - 20.0f && (best < 0 || clarity[i] > clarity[best])) {
                best = i;
            }
        }
        at = ((best < 0 ? TRACK_POINTS / 2 : best) + 0.5) * duration / TRACK_POINTS;
    }

    synthway_analysis_t analysis;
    synthway_analyzer_analyze_clip(analyzer, at, &analysis);
    printf("[+] %s: %.2f s at %u Hz, analyzed at %.3f s (nothing was played)\n", argv[2], duration, rate, at);
    print_analysis(&analysis);
    synthway_analyzer_destroy(analyzer);
    return 0;
}

/* Live note heard by the microphone: nothing is played or saved */
static int listen_to_input(int argc, char* argv[]) {
    synthway_analyzer_t* analyzer = create_analyzer(&argc, argv);
    if (!analyzer) {
        return 1;
    }
    const float seconds = argc > 2 ? (float)atof(argv[2]) : 10.0f;
    const int device = argc > 3 ? atoi(argv[3]) : -1;
    if (seconds <= 0.0f) {
        fprintf(stderr, "[!] Error: invalid duration.\n");
        synthway_analyzer_destroy(analyzer);
        return 1;
    }
    synthway_result_t res = synthway_analyzer_open_input(analyzer, device, 0);
    if (res != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Error: Cannot open the microphone: %s (%d)\n", synthway_result_to_string(res), res);
        synthway_analyzer_destroy(analyzer);
        return 1;
    }
    printf("[>] Listening at %u Hz for %.0f s (nothing is saved)...\n",
           synthway_analyzer_get_input_sample_rate(analyzer), seconds);
    if (synthway_analyzer_is_input_exclusive(analyzer)) {
        printf("    Exclusive mode: the sound comes without the system's audio effects.\n");
    } else {
        printf("    Shared mode: the system's audio effects (noise suppression, automatic gain)\n");
        printf("    may fade a held note. Turning off the microphone's audio enhancements helps.\n");
    }

    const int steps = (int)(seconds * 10.0f);
    for (int i = 0; i < steps; ++i) {
        synthway_sleep_ms(100);
        synthway_analysis_t analysis;
        synthway_analyzer_analyze_input(analyzer, &analysis);
        char note[40];
        format_note(analysis.clarity >= 0.8f ? analysis.frequency_hz : 0.0f, note, sizeof(note));
        printf("\r    %-18s %8.2f Hz  clarity %.2f  level %6.1f dB  %2u partials ",
               note, analysis.frequency_hz, analysis.clarity, analysis.level_db, analysis.partial_count);
        fflush(stdout);
    }
    printf("\n[*] Done.\n");
    synthway_analyzer_destroy(analyzer);
    return 0;
}

/* Parses "ratio:amplitude[:waveform],..." into a timbre; every partial gets the
   default envelope. Returns 0 on success. */
static int parse_partials(const char* spec, synthway_timbre_t* timbre) {
    memset(timbre, 0, sizeof(*timbre));
    const char* cursor = spec;
    while (*cursor) {
        if (timbre->partial_count == SYNTHWAY_MAX_PARTIALS) {
            return 1;
        }
        synthway_partial_t* partial = &timbre->partials[timbre->partial_count++];
        char* end = NULL;
        partial->ratio = strtof(cursor, &end);
        if (end == cursor || *end != ':') {
            return 1;
        }
        cursor = end + 1;
        partial->amplitude = strtof(cursor, &end);
        if (end == cursor) {
            return 1;
        }
        partial->waveform = SYNTHWAY_WAVEFORM_SINE;
        if (*end == ':') {
            cursor = end + 1;
            partial->waveform = (synthway_waveform_t)strtol(cursor, &end, 10);
            if (end == cursor) {
                return 1;
            }
        }
        partial->envelope.attack_s = 0.005f;
        partial->envelope.sustain_level = 1.0f;
        partial->envelope.release_s = 0.01f;
        if (*end == ',') {
            ++end;
        } else if (*end != '\0') {
            return 1;
        }
        cursor = end;
    }
    return timbre->partial_count == 0;
}

/* Offline rendering: writes the tone to a WAV file without opening any device */
static int render_to_file(int argc, char* argv[]) {
    /* Positional arguments stop at --partials */
    const char* partials = NULL;
    for (int i = 3; i < argc; ++i) {
        if (strcmp(argv[i], "--partials") == 0) {
            partials = i + 1 < argc ? argv[i + 1] : "";
            argc = i;
            break;
        }
    }
    if (argc < 3) {
        fprintf(stderr, "[!] Usage: %s --render <file.wav> [freq] [sec] [wave 0-3] [--partials <ratio:amp[:wave]>,...]\n", argv[0]);
        return 1;
    }
    const char* path = argv[2];
    float freq = argc > 3 ? (float)atof(argv[3]) : 440.0f;
    float seconds = argc > 4 ? (float)atof(argv[4]) : 1.0f;
    int wave = argc > 5 ? atoi(argv[5]) : SYNTHWAY_WAVEFORM_SINE;
    if (freq <= 0.0f || seconds <= 0.0f || wave < 0 || wave > 3) {
        fprintf(stderr, "[!] Error: invalid frequency, duration or waveform.\n");
        return 1;
    }
    synthway_timbre_t timbre;
    if (partials && parse_partials(partials, &timbre) != 0) {
        fprintf(stderr, "[!] Error: invalid --partials, expected ratio:amplitude[:waveform],... (at most %u)\n",
                synthway_get_max_partials());
        return 1;
    }

    synthway_engine_t* engine = synthway_engine_create();
    if (!engine) {
        fprintf(stderr, "[!] Error: Failed to allocate synthesizer engine.\n");
        return 1;
    }

    synthway_engine_config_t config;
    memset(&config, 0, sizeof(config));
    config.sample_rate = 48000;
    config.channels = 2;
    synthway_engine_init_offline(engine, &config);
    synthway_engine_set_waveform(engine, (synthway_waveform_t)wave);
    synthway_engine_set_frequency(engine, freq);
    synthway_engine_set_volume(engine, 0.20f); /* Same safe level as live playback */
    if (partials && synthway_engine_set_timbre(engine, &timbre) != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Error: partial out of range (ratio in (0, 1000], amplitude in [0, 1], waveform 0-3)\n");
        synthway_engine_destroy(engine);
        return 1;
    }
    synthway_engine_set_tone_enabled(engine, true);

    uint32_t frames = (uint32_t)(seconds * (float)synthway_engine_get_sample_rate(engine));
    synthway_result_t res = synthway_engine_render_to_wav(engine, path, frames);
    synthway_engine_destroy(engine);

    if (res != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Error: Rendering failed: %s (%d)\n", synthway_result_to_string(res), res);
        return 1;
    }
    if (partials) {
        printf("[+] Rendered %.2f Hz, %u partials, %.2f s to %s (offline, nothing was played)\n",
               freq, timbre.partial_count, seconds, path);
    } else {
        printf("[+] Rendered %.2f Hz, waveform %d, %.2f s to %s (offline, nothing was played)\n", freq, wave, seconds, path);
    }
    return 0;
}

/* Offline rendering of a note that glides (synthway_engine_note_glide): it
   starts at start_freq, follows each freq:sec in turn, then holds 0.5 s */
static int render_glide_to_file(int argc, char* argv[]) {
    const char* usage = "[!] Usage: %s --glide <file.wav> <start_freq> <freq:sec>,... [--partials <ratio:amp[:wave]>,...]\n";
    const char* partials = NULL;
    for (int i = 3; i < argc; ++i) {
        if (strcmp(argv[i], "--partials") == 0) {
            partials = i + 1 < argc ? argv[i + 1] : "";
            argc = i;
            break;
        }
    }
    if (argc != 5) {
        fprintf(stderr, usage, argv[0]);
        return 1;
    }
    const char* path = argv[2];
    const float start = (float)atof(argv[3]);
    synthway_timbre_t timbre;
    if (partials && parse_partials(partials, &timbre) != 0) {
        fprintf(stderr, "[!] Error: invalid --partials, expected ratio:amplitude[:waveform],... (at most %u)\n",
                synthway_get_max_partials());
        return 1;
    }

    synthway_engine_t* engine = synthway_engine_create();
    if (!engine) {
        fprintf(stderr, "[!] Error: Failed to allocate synthesizer engine.\n");
        return 1;
    }
    synthway_engine_config_t config;
    memset(&config, 0, sizeof(config));
    config.sample_rate = 48000;
    config.channels = 2;
    synthway_engine_init_offline(engine, &config);
    synthway_engine_set_tone_enabled(engine, false); /* only the gliding note */
    if (partials && synthway_engine_set_timbre(engine, &timbre) != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Error: partial out of range (ratio in (0, 1000], amplitude in [0, 1], waveform 0-3)\n");
        synthway_engine_destroy(engine);
        return 1;
    }
    if (synthway_engine_note_on(engine, 1, 0, start, 0.20f) != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Error: invalid start frequency.\n");
        synthway_engine_destroy(engine);
        return 1;
    }

    /* The glides, as freq:sec,freq:sec,... */
    float seconds = 0.5f;
    unsigned count = 0;
    const char* cursor = argv[4];
    while (*cursor) {
        char* end = NULL;
        const float freq = strtof(cursor, &end);
        float glide = -1.0f;
        if (end != cursor && *end == ':') {
            cursor = end + 1;
            glide = strtof(cursor, &end);
        }
        if (end == cursor || (*end != ',' && *end != '\0') || count == SYNTHWAY_MAX_GLIDES
            || synthway_engine_note_glide(engine, 1, freq, glide) != SYNTHWAY_OK) {
            fprintf(stderr, "[!] Error: invalid glide near \"%s\": freq:sec, frequency in (0, 24000], 0 to %.0f s, %u at most\n",
                    cursor, SYNTHWAY_MAX_GLIDE_SECONDS, SYNTHWAY_MAX_GLIDES);
            synthway_engine_destroy(engine);
            return 1;
        }
        seconds += glide;
        ++count;
        cursor = *end == ',' ? end + 1 : end;
    }

    const uint32_t frames = (uint32_t)(seconds * (float)synthway_engine_get_sample_rate(engine));
    synthway_result_t res = synthway_engine_render_to_wav(engine, path, frames);
    synthway_engine_destroy(engine);
    if (res != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Error: Rendering failed: %s (%d)\n", synthway_result_to_string(res), res);
        return 1;
    }
    printf("[+] Rendered %.2f Hz and %u glide(s), %.2f s to %s (offline, nothing was played)\n", start, count, seconds, path);
    return 0;
}

static void print_midi_ports(void) {
    static const struct {
        synthway_midi_port_type_t type;
        const char* label;
    } sections[] = {
        { SYNTHWAY_MIDI_INPUT,  "INPUT PORTS (Keyboards, Controllers)" },
        { SYNTHWAY_MIDI_OUTPUT, "OUTPUT PORTS (Synths, Interfaces)" },
    };

    printf("\n=======================================================\n");
    printf("              SYNTHWAY MIDI PORTS\n");
    printf("=======================================================\n");

    for (size_t s = 0; s < sizeof(sections) / sizeof(sections[0]); ++s) {
        uint32_t count = 0;
        synthway_result_t res = synthway_get_midi_port_count(sections[s].type, &count);

        printf("\n--- [ %s : %u ] ---\n", sections[s].label, count);
        if (res != SYNTHWAY_OK) {
            printf("  (MIDI backend unavailable: %s)\n", synthway_result_to_string(res));
            continue;
        }
        if (count == 0) {
            printf("  (No MIDI ports found)\n");
        }
        for (uint32_t i = 0; i < count; ++i) {
            synthway_midi_port_info_t info;
            if (synthway_get_midi_port_info(sections[s].type, i, &info) == SYNTHWAY_OK) {
                printf("  [%u] %s\n", i, info.name);
            }
        }
    }
    printf("\n=======================================================\n\n");
}

int main(int argc, char* argv[]) {
    print_banner();

    /* Mode: list devices only */
    if (argc > 1 && strcmp(argv[1], "--list") == 0) {
        synthway_print_devices();
        return 0;
    }

    /* Mode: list MIDI ports only */
    if (argc > 1 && strcmp(argv[1], "--midi") == 0) {
        print_midi_ports();
        return 0;
    }

    /* Mode: offline rendering to a WAV file */
    if (argc > 1 && strcmp(argv[1], "--render") == 0) {
        return render_to_file(argc, argv);
    }
    if (argc > 1 && strcmp(argv[1], "--glide") == 0) {
        return render_glide_to_file(argc, argv);
    }

    /* Mode: analysis of an audio file, nothing played */
    if (argc > 1 && strcmp(argv[1], "--analyze") == 0) {
        return analyze_file(argc, argv);
    }

    /* Mode: live analysis of the microphone, nothing played or saved */
    if (argc > 1 && strcmp(argv[1], "--listen") == 0) {
        return listen_to_input(argc, argv);
    }

    float freq = 440.0f;
    int duration_ms = 2500;
    synthway_waveform_t wave = SYNTHWAY_WAVEFORM_SINE;
    int device_idx = -1;

    /* Parse custom tone arguments if provided */
    if (argc > 1 && strcmp(argv[1], "--tone") == 0) {
        if (argc > 2) {
            freq = (float)atof(argv[2]);
            if (freq <= 0.0f) freq = 440.0f;
        }
        if (argc > 3) {
            float sec = (float)atof(argv[3]);
            if (sec > 0.0f) duration_ms = (int)(sec * 1000.0f);
        }
    } else if (argc > 1 && strcmp(argv[1], "--waveform") == 0) {
        if (argc > 2) {
            int w = atoi(argv[2]);
            if (w >= 0 && w <= 3) wave = (synthway_waveform_t)w;
        }
    } else if (argc > 1 && (strcmp(argv[1], "-h") == 0 || strcmp(argv[1], "--help") == 0)) {
        print_usage(argv[0]);
        return 0;
    }

    /* 1. Show audio devices */
    synthway_print_devices();

    /* 2. Configure and initialize the audio engine */
    printf("[*] Initializing Synthway Audio Engine...\n");
    synthway_engine_t* engine = synthway_engine_create();
    if (!engine) {
        fprintf(stderr, "[!] Error: Failed to allocate synthesizer engine.\n");
        return 1;
    }

    synthway_engine_config_t config;
    memset(&config, 0, sizeof(config));
    config.sample_rate = 48000;
    config.channels = 2;
    config.playback_device_index = device_idx; /* default playback device */

    synthway_result_t res = synthway_engine_init(engine, &config);
    if (res != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Error: Engine init failed: %s (%d)\n", synthway_result_to_string(res), res);
        synthway_engine_destroy(engine);
        return 1;
    }

    /* Set tone parameters */
    synthway_engine_set_waveform(engine, wave);
    synthway_engine_set_frequency(engine, freq);
    synthway_engine_set_volume(engine, 0.20f); /* Safe volume level */
    synthway_engine_set_tone_enabled(engine, true);

    const char* wave_str = "Sine";
    if (wave == SYNTHWAY_WAVEFORM_SQUARE) wave_str = "Square";
    else if (wave == SYNTHWAY_WAVEFORM_TRIANGLE) wave_str = "Triangle";
    else if (wave == SYNTHWAY_WAVEFORM_SAWTOOTH) wave_str = "Sawtooth";

    printf("[*] Starting Audio Engine Playback...\n");
    printf("    -> Waveform : %s\n", wave_str);
    printf("    -> Frequency: %.2f Hz\n", freq);
    printf("    -> Volume   : %.0f%%\n", synthway_engine_get_volume(engine) * 100.0f);
    printf("    -> Duration : %.1f seconds\n\n", (float)duration_ms / 1000.0f);

    res = synthway_engine_start(engine);
    if (res != SYNTHWAY_OK) {
        fprintf(stderr, "[!] Error: Engine start failed: %s (%d)\n", synthway_result_to_string(res), res);
        synthway_engine_destroy(engine);
        return 1;
    }

    printf("[>] Playing audio tone now... (listen to your speakers / headphones)\n");
    
    /* Play in segments with visual progress */
    int steps = 10;
    int step_ms = duration_ms / steps;
    for (int i = 0; i < steps; ++i) {
        synthway_sleep_ms(step_ms);
        printf(".");
        fflush(stdout);
    }
    printf(" Done!\n\n");

    /* Quick musical arpeggio demo (C4, E4, G4, C5) if default mode */
    if (argc <= 1) {
        printf("[*] Playing quick arpeggio test (C4 -> E4 -> G4 -> C5)...\n");
        float arpeggio[] = { 261.63f, 329.63f, 392.00f, 523.25f };
        for (int i = 0; i < 4; ++i) {
            synthway_engine_set_frequency(engine, arpeggio[i]);
            printf("    Note %d: %.2f Hz\n", i + 1, arpeggio[i]);
            synthway_sleep_ms(350);
        }
        printf("[*] Arpeggio completed!\n\n");
    }

    /* Stop and clean up */
    printf("[*] Stopping audio engine...\n");
    synthway_engine_stop(engine);
    synthway_engine_destroy(engine);
    printf("[*] Engine successfully destroyed. Goodbye!\n");

    return 0;
}
