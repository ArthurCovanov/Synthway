#ifndef SYNTHWAY_TYPES_H
#define SYNTHWAY_TYPES_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
   Export / Import macros for Shared Library (DLL / SO)
   -------------------------------------------------------------------------- */
#if defined(_WIN32) || defined(__CYGWIN__)
    #if defined(SYNTHWAY_BUILD_SHARED)
        #define SYNTHWAY_API __declspec(dllexport)
    #elif defined(SYNTHWAY_USE_SHARED)
        #define SYNTHWAY_API __declspec(dllimport)
    #else
        #define SYNTHWAY_API
    #endif
#else
    #if defined(__GNUC__) && __GNUC__ >= 4
        #define SYNTHWAY_API __attribute__((visibility("default")))
    #else
        #define SYNTHWAY_API
    #endif
#endif

/* --------------------------------------------------------------------------
   Return and Status Codes
   -------------------------------------------------------------------------- */
typedef enum synthway_result {
    SYNTHWAY_OK                  = 0,
    SYNTHWAY_ERROR               = -1,
    SYNTHWAY_INVALID_PARAM       = -2,
    SYNTHWAY_DEVICE_NOT_FOUND    = -3,
    SYNTHWAY_BACKEND_ERROR       = -4,
    SYNTHWAY_ALREADY_RUNNING     = -5,
    SYNTHWAY_NOT_RUNNING         = -6,
    SYNTHWAY_MIDI_BACKEND_ERROR  = -7,
    SYNTHWAY_IO_ERROR            = -8,
    SYNTHWAY_FORMAT_ERROR        = -9    /* audio file in an unknown format, or corrupt */
} synthway_result_t;

/* --------------------------------------------------------------------------
   Device Classification
   -------------------------------------------------------------------------- */
typedef enum synthway_device_type {
    SYNTHWAY_DEVICE_PLAYBACK     = 0,
    SYNTHWAY_DEVICE_CAPTURE      = 1
} synthway_device_type_t;

/* --------------------------------------------------------------------------
   Waveform Types for Synthesis
   -------------------------------------------------------------------------- */
typedef enum synthway_waveform {
    SYNTHWAY_WAVEFORM_SINE       = 0,
    SYNTHWAY_WAVEFORM_SQUARE     = 1,
    SYNTHWAY_WAVEFORM_TRIANGLE   = 2,
    SYNTHWAY_WAVEFORM_SAWTOOTH   = 3
} synthway_waveform_t;

/* --------------------------------------------------------------------------
   ADSR Envelope
   -------------------------------------------------------------------------- */

/* How the decay or the release falls (curve and release_curve below; the attack has its own curves) */
typedef enum synthway_envelope_curve {
    SYNTHWAY_ENVELOPE_LINEAR      = 0,  /* a straight ramp: decay_s or release_s is the time to reach the sustain level or silence */
    SYNTHWAY_ENVELOPE_EXPONENTIAL = 1   /* a steady fall in dB, like a struck string: decay_s or release_s is the time to fall by 60 dB */
} synthway_envelope_curve_t;

/* How the attack rises, from the current level to the top in attack_s */
typedef enum synthway_attack_curve {
    SYNTHWAY_ATTACK_LINEAR = 0,  /* a straight ramp */
    SYNTHWAY_ATTACK_CONVEX = 1   /* the square of a straight ramp: slow, then faster and faster (heard as an exponential swell) */
} synthway_attack_curve_t;

typedef struct synthway_envelope {
    float attack_s;                /* 0 to 10 s */
    float decay_s;                 /* 0 to 10 s */
    float sustain_level;           /* in [0, 1] */
    float release_s;               /* 0 to 10 s */
    synthway_envelope_curve_t curve; /* the decay's; SYNTHWAY_ENVELOPE_LINEAR (0) when zeroed */
    synthway_attack_curve_t attack_curve; /* SYNTHWAY_ATTACK_LINEAR (0) when zeroed */
    synthway_envelope_curve_t release_curve; /* SYNTHWAY_ENVELOPE_LINEAR (0) when zeroed */
} synthway_envelope_t;

/* --------------------------------------------------------------------------
   Additive Synthesis: a timbre is a set of partials, its identity card
   -------------------------------------------------------------------------- */

/* Most partials a timbre can hold. Fixed at build time: the audio thread
   never allocates memory. */
#define SYNTHWAY_MAX_PARTIALS 64

/* Unison (synthway_engine_set_unison): most voices per partial, and widest detune */
#define SYNTHWAY_MAX_UNISON_VOICES 8
#define SYNTHWAY_MAX_UNISON_DETUNE_CENTS 100.0f

/* Fixed limits keep composition playback allocation-free in the audio thread. */
#define SYNTHWAY_INTERPRETER_MAX_TRACKS 16
#define SYNTHWAY_INTERPRETER_MAX_NOTES 1024
#define SYNTHWAY_INTERPRETER_MAX_VOICES 32

/* One partial: its own oscillator and its own envelope */
typedef struct synthway_partial {
    float ratio;                   /* frequency / note frequency, in (0, 1000]: 1 is the note, 2 its octave, 2.76 an inharmonic partial */
    float amplitude;               /* in [0, 1] */
    synthway_waveform_t waveform;
    synthway_envelope_t envelope;
} synthway_partial_t;

typedef struct synthway_timbre {
    uint32_t partial_count;        /* 0 to SYNTHWAY_MAX_PARTIALS; the other entries are ignored */
    synthway_partial_t partials[SYNTHWAY_MAX_PARTIALS];
} synthway_timbre_t;

/* --------------------------------------------------------------------------
   Polyphony: instruments, and the notes that play them
   -------------------------------------------------------------------------- */

/* Instruments the engine holds at once (synthway_engine_set_instrument).
   Instrument 0 is the one the single-note API plays and sets. */
#define SYNTHWAY_MAX_INSTRUMENTS 16

/* Notes that can sound at once (synthway_engine_note_on), besides the
   single-note API's own */
#define SYNTHWAY_MAX_NOTES 32

/* Glides a note holds waiting (synthway_engine_note_glide), besides the one it plays */
#define SYNTHWAY_MAX_GLIDES 64

/* Longest glide, in seconds */
#define SYNTHWAY_MAX_GLIDE_SECONDS 600.0f

/* Everything that makes an instrument's sound. A note's frequency and volume
   are given when it starts (synthway_engine_note_on). */
typedef struct synthway_instrument {
    synthway_waveform_t waveform;  /* of the single oscillator, played when has_timbre is false */
    synthway_envelope_t envelope;  /* of the single oscillator; its curves are ignored (always linear) */
    float filter_low_cutoff_hz;    /* band-pass, as in synthway_engine_set_filter */
    float filter_high_cutoff_hz;
    float filter_resonance;
    float reverb_mix;              /* as in synthway_engine_set_reverb */
    uint32_t unison_voices;        /* as in synthway_engine_set_unison */
    float unison_detune_cents;
    float unison_spread;
    bool has_timbre;               /* false: the single oscillator plays, and timbre is ignored */
    synthway_timbre_t timbre;
} synthway_instrument_t;

/* --------------------------------------------------------------------------
   Automation: settings of an instrument that vary over time
   (synthway_engine_automate)
   -------------------------------------------------------------------------- */

/* A setting a ramp can take, and the values it accepts */
typedef enum synthway_automation_param {
    SYNTHWAY_AUTOMATION_GAIN = 0,        /* 0 to 1: multiplies all the instrument plays, after its reverb (not automated: 1) */
    SYNTHWAY_AUTOMATION_PAN = 1,         /* -1 (left) to 1 (right), after the gain (not automated: 0, the centre, where both sides keep their level); both sides only */
    SYNTHWAY_AUTOMATION_LOW_CUTOFF = 2,  /* Hz, 20 to 20000: lower edge of the band-pass (its high-pass; 20: none) */
    SYNTHWAY_AUTOMATION_HIGH_CUTOFF = 3, /* Hz, 20 to 20000: upper edge (its low-pass; 20000: none) */
    SYNTHWAY_AUTOMATION_RESONANCE = 4,   /* 0 to 1 */
    SYNTHWAY_AUTOMATION_REVERB = 5,      /* reverb mix, 0 to 1 */
    SYNTHWAY_AUTOMATION_DETUNE = 6       /* unison detune in cents, 0 to SYNTHWAY_MAX_UNISON_DETUNE_CENTS; both sides only */
} synthway_automation_param_t;

/* Settings a ramp can take: synthway_automation_param_t's values are 0 to this, excluded */
#define SYNTHWAY_AUTOMATION_PARAM_COUNT 7

/* Which side of the stereo field a ramp sets */
typedef enum synthway_side {
    SYNTHWAY_SIDE_BOTH = 0,
    SYNTHWAY_SIDE_LEFT = 1,              /* even channels */
    SYNTHWAY_SIDE_RIGHT = 2              /* odd channels */
} synthway_side_t;

/* Longest automation ramp, in seconds */
#define SYNTHWAY_MAX_AUTOMATION_SECONDS 600.0f

/* Samples between two steps of a running ramp (0.67 ms at 48 kHz) */
#define SYNTHWAY_AUTOMATION_PERIOD 32

/* --------------------------------------------------------------------------
   Audio Device Information
   -------------------------------------------------------------------------- */
typedef struct synthway_device_info {
    char name[256];
    char id[256];
    bool is_default;
    uint32_t sample_rate;
    uint32_t channels;
    synthway_device_type_t type;
} synthway_device_info_t;

/* --------------------------------------------------------------------------
   MIDI Port Classification
   -------------------------------------------------------------------------- */
typedef enum synthway_midi_port_type {
    SYNTHWAY_MIDI_INPUT          = 0,
    SYNTHWAY_MIDI_OUTPUT         = 1
} synthway_midi_port_type_t;

/* --------------------------------------------------------------------------
   MIDI Port Information
   -------------------------------------------------------------------------- */
typedef struct synthway_midi_port_info {
    char name[256];
    synthway_midi_port_type_t type;
} synthway_midi_port_info_t;

/* --------------------------------------------------------------------------
   Engine Initialization Configuration
   -------------------------------------------------------------------------- */
typedef struct synthway_engine_config {
    uint32_t sample_rate;          /* 0 for default, typically 44100 or 48000 */
    uint32_t channels;             /* 0 for default, typically 2 (stereo) */
    int playback_device_index;     /* -1 for system default playback device */
} synthway_engine_config_t;

/* Opaque pointer representing the synthesis engine instance */
typedef struct synthway_engine synthway_engine_t;

/* --------------------------------------------------------------------------
   Audio Files Written from Offline Rendering
   -------------------------------------------------------------------------- */
typedef enum synthway_audio_file_format {
    SYNTHWAY_AUDIO_FILE_WAV      = 0,   /* 16-bit PCM WAV */
    SYNTHWAY_AUDIO_FILE_OGG      = 1    /* Ogg Vorbis, variable bit rate (libvorbis) */
} synthway_audio_file_format_t;

/* What has been written to an audio file so far */
typedef struct synthway_audio_writer_stats {
    uint64_t frames;               /* frames written */
    uint64_t clipped_samples;      /* samples beyond [-1, 1], written as -1 or 1 */
    float peak;                    /* highest absolute value of the samples, before clipping (1: full scale) */
    float last_peak;               /* the same, for the samples of the last write or render only */
} synthway_audio_writer_stats_t;

/* Opaque pointer representing an audio file being written */
typedef struct synthway_audio_writer synthway_audio_writer_t;

/* --------------------------------------------------------------------------
   Sound Analysis: the note played and the partials of a sound
   -------------------------------------------------------------------------- */

/* Most partials an analysis reports: as many as a timbre can hold */
#define SYNTHWAY_ANALYSIS_MAX_PARTIALS SYNTHWAY_MAX_PARTIALS

/* Points of the display spectrum, spread on a logarithmic frequency scale */
#define SYNTHWAY_ANALYSIS_SPECTRUM_POINTS 256

/* A peak of the spectrum */
typedef struct synthway_analysis_partial {
    float frequency_hz;
    float ratio;                   /* frequency / fundamental, 0 when no fundamental was found */
    float amplitude;               /* relative to the strongest partial, in (0, 1] */
} synthway_analysis_partial_t;

/* What the analyzer hears at one moment */
typedef struct synthway_analysis {
    uint32_t sample_rate;          /* of the sound analyzed */
    float frequency_hz;            /* fundamental: the note played, 0 when none was found (silence, noise) */
    float clarity;                 /* in [0, 1]: how periodic the sound is; the note is reliable above about 0.8 */
    float level_db;                /* RMS level in dBFS, -120 for silence */
    uint32_t partial_count;        /* 0 to SYNTHWAY_ANALYSIS_MAX_PARTIALS, sorted by frequency */
    synthway_analysis_partial_t partials[SYNTHWAY_ANALYSIS_MAX_PARTIALS];
    float spectrum_min_hz;         /* frequency of spectrum_db[0] */
    float spectrum_max_hz;         /* frequency of the last point: 20 kHz, or half the sample rate below 40 kHz */
    float spectrum_db[SYNTHWAY_ANALYSIS_SPECTRUM_POINTS]; /* level in dBFS (a full-scale sine reads 0), -120 at most */
} synthway_analysis_t;

/* Opaque pointer representing a sound analyzer instance */
typedef struct synthway_analyzer synthway_analyzer_t;

#ifdef __cplusplus
}
#endif

#endif /* SYNTHWAY_TYPES_H */
