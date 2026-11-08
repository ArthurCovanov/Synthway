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

/* How the decay and the release fall (the attack is always a straight ramp) */
typedef enum synthway_envelope_curve {
    SYNTHWAY_ENVELOPE_LINEAR      = 0,  /* straight ramps: decay_s and release_s are the times to reach the sustain level and silence */
    SYNTHWAY_ENVELOPE_EXPONENTIAL = 1   /* a steady fall in dB, like a struck string: decay_s and release_s are the times to fall by 60 dB */
} synthway_envelope_curve_t;

typedef struct synthway_envelope {
    float attack_s;                /* 0 to 10 s */
    float decay_s;                 /* 0 to 10 s */
    float sustain_level;           /* in [0, 1] */
    float release_s;               /* 0 to 10 s */
    synthway_envelope_curve_t curve; /* SYNTHWAY_ENVELOPE_LINEAR (0) when zeroed */
} synthway_envelope_t;

/* --------------------------------------------------------------------------
   Additive Synthesis: a timbre is a set of partials, its identity card
   -------------------------------------------------------------------------- */

/* Most partials a timbre can hold. Fixed at build time: the audio thread
   never allocates memory. */
#define SYNTHWAY_MAX_PARTIALS 64

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
