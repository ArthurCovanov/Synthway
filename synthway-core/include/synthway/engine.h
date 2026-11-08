#ifndef SYNTHWAY_ENGINE_H
#define SYNTHWAY_ENGINE_H

/* The synthesizer engine: lifecycle, real-time parameters, offline rendering.
   Implemented in src/engine/. Include "synthway/synthway.h" rather than this file. */

#include "synthway/types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
   Synthesizer Engine Lifecycle
   -------------------------------------------------------------------------- */
/**
 * Allocates and returns a new synthesizer engine instance.
 */
SYNTHWAY_API synthway_engine_t* synthway_engine_create(void);

/**
 * Initializes the engine with the provided configuration (or defaults if NULL).
 */
SYNTHWAY_API synthway_result_t synthway_engine_init(
    synthway_engine_t* engine,
    const synthway_engine_config_t* config
);

/**
 * Starts audio processing and playback.
 */
SYNTHWAY_API synthway_result_t synthway_engine_start(synthway_engine_t* engine);

/**
 * Stops audio processing and playback.
 */
SYNTHWAY_API synthway_result_t synthway_engine_stop(synthway_engine_t* engine);

/**
 * Tears down and frees all resources associated with the engine instance.
 */
SYNTHWAY_API void synthway_engine_destroy(synthway_engine_t* engine);

SYNTHWAY_API bool synthway_engine_is_running(const synthway_engine_t* engine);

/**
 * Sample rate and channel count actually used by the engine (after init).
 */
SYNTHWAY_API uint32_t synthway_engine_get_sample_rate(const synthway_engine_t* engine);
SYNTHWAY_API uint32_t synthway_engine_get_channels(const synthway_engine_t* engine);

/* --------------------------------------------------------------------------
   Synthesizer Real-Time Parameters
   -------------------------------------------------------------------------- */
SYNTHWAY_API synthway_result_t synthway_engine_set_frequency(synthway_engine_t* engine, float frequency_hz);
SYNTHWAY_API float synthway_engine_get_frequency(const synthway_engine_t* engine);

SYNTHWAY_API synthway_result_t synthway_engine_set_volume(synthway_engine_t* engine, float volume);
SYNTHWAY_API float synthway_engine_get_volume(const synthway_engine_t* engine);

SYNTHWAY_API synthway_result_t synthway_engine_set_waveform(synthway_engine_t* engine, synthway_waveform_t waveform);
SYNTHWAY_API synthway_waveform_t synthway_engine_get_waveform(const synthway_engine_t* engine);

/**
 * Note gate: true starts the envelope's attack (note on), false its release
 * (note off). Turning it on while already on keeps the current envelope stage
 * (legato). A new attack starts from the current level, so it never clicks.
 */
SYNTHWAY_API synthway_result_t synthway_engine_set_tone_enabled(synthway_engine_t* engine, bool enabled);
SYNTHWAY_API bool synthway_engine_is_tone_enabled(const synthway_engine_t* engine);

/**
 * ADSR envelope of the single oscillator (a timbre gives each partial its
 * own, see synthway_engine_set_timbre): attack, decay and release times in
 * seconds (0 to 10), sustain level in [0, 1]. Segments are linear; the release
 * always lasts release_s, whatever the level it starts from.
 * Default: 5 ms attack, no decay, full sustain, 10 ms release.
 */
SYNTHWAY_API synthway_result_t synthway_engine_set_envelope(
    synthway_engine_t* engine,
    float attack_s,
    float decay_s,
    float sustain_level,
    float release_s
);

SYNTHWAY_API synthway_result_t synthway_engine_get_envelope(
    const synthway_engine_t* engine,
    float* out_attack_s,
    float* out_decay_s,
    float* out_sustain_level,
    float* out_release_s
);

/** Band-pass filter: lower and upper cutoff in Hz (20 to 20000), resonance in [0, 1]. */
SYNTHWAY_API synthway_result_t synthway_engine_set_filter(synthway_engine_t* engine, float low_cutoff_hz, float high_cutoff_hz, float resonance);
SYNTHWAY_API synthway_result_t synthway_engine_get_filter(const synthway_engine_t* engine, float* out_low_cutoff_hz, float* out_high_cutoff_hz, float* out_resonance);

/**
 * Reverb, after the filter: mix in [0, 1] is the share of reverberated sound,
 * as an equal-power crossfade (0: none, the default; 0.5: as much of each;
 * 1: the reverb alone). A room whose tail takes about 2 s to fall 60 dB and
 * keeps ringing after the note ends; its left and right channels differ.
 * A held note keeps about its level, but its peaks get higher: up to two or
 * three times at full mix. Back at 0, the tail stops within a millisecond.
 */
SYNTHWAY_API synthway_result_t synthway_engine_set_reverb(synthway_engine_t* engine, float mix);
SYNTHWAY_API float synthway_engine_get_reverb(const synthway_engine_t* engine);

/**
 * Unison, for the timbre (not the single oscillator): each partial is played
 * by voices oscillators (1 to SYNTHWAY_MAX_UNISON_VOICES; 1, the default: no
 * unison), from detune_cents below to detune_cents above it (0 to
 * SYNTHWAY_MAX_UNISON_DETUNE_CENTS), closer together near the partial so that
 * they never all come back in phase at regular intervals. Their beating thickens the sound,
 * as the many detuned saws of a "supersaw". spread in [0, 1] places them
 * across the stereo field, alternately left and right (0: all in the middle,
 * mono; 1: the outermost at the far left and right). The voices of a partial
 * share its envelope; each starts at its own point of the waveform, and the
 * sum is scaled by 1 / sqrt(voices) to keep about the same loudness.
 * Takes effect at the next audio block, also while a note is held.
 * Returns SYNTHWAY_INVALID_PARAM, and keeps the unison in place, when a value
 * is out of range.
 */
SYNTHWAY_API synthway_result_t synthway_engine_set_unison(synthway_engine_t* engine, uint32_t voices, float detune_cents, float spread);
SYNTHWAY_API synthway_result_t synthway_engine_get_unison(const synthway_engine_t* engine, uint32_t* out_voices, float* out_detune_cents, float* out_spread);

/* --------------------------------------------------------------------------
   Additive Synthesis (timbre)
   -------------------------------------------------------------------------- */
/**
 * Plays every note as a sum of partials: each one is an oscillator at
 * ratio × the note's frequency, with its own amplitude, waveform and envelope
 * (linear or exponential, see synthway_envelope_curve_t, with a straight or
 * convex attack, see synthway_attack_curve_t), or several detuned ones (see
 * synthway_engine_set_unison).
 * The sum is then scaled by the volume. A timbre replaces the single
 * oscillator (set_waveform, set_envelope); NULL goes back to it, which is the
 * default. A timbre with no partial is silent.
 * Takes effect at the next audio block, also while a note is held: a partial
 * added during a note starts its attack at once.
 * Nothing guards against partials above half the sample rate (they fold back
 * as other frequencies) or a sum above 1 (it clips): the caller warns about them.
 * Returns SYNTHWAY_INVALID_PARAM, and keeps the timbre in place, when a value
 * is out of range (see synthway_partial_t and synthway_envelope_t).
 */
SYNTHWAY_API synthway_result_t synthway_engine_set_timbre(
    synthway_engine_t* engine,
    const synthway_timbre_t* timbre
);

/**
 * Copies the timbre in place into out_timbre (partial_count 0 when the
 * single oscillator plays: see synthway_engine_has_timbre).
 */
SYNTHWAY_API synthway_result_t synthway_engine_get_timbre(
    const synthway_engine_t* engine,
    synthway_timbre_t* out_timbre
);

/**
 * true when notes are played by a timbre, false by the single oscillator.
 */
SYNTHWAY_API bool synthway_engine_has_timbre(const synthway_engine_t* engine);

/**
 * Most partials a timbre can hold (SYNTHWAY_MAX_PARTIALS), for callers that
 * cannot read the header's #define, such as the Python bridge.
 */
SYNTHWAY_API uint32_t synthway_get_max_partials(void);

/* --------------------------------------------------------------------------
   Polyphony: several notes at once, each on one of the instruments
   --------------------------------------------------------------------------
   The functions above play a single note (set_frequency, set_volume,
   set_tone_enabled) and set instrument 0 (waveform, envelope, filter, reverb,
   unison, timbre). The functions below play up to SYNTHWAY_MAX_NOTES more
   notes, on top of it: each one has its own envelopes, so it starts with its
   own attack whatever the others do. Each note plays one of
   SYNTHWAY_MAX_INSTRUMENTS instruments; an instrument filters and
   reverberates the sum of its notes. Notes add up: several loud notes can
   go beyond [-1, 1], which clips on the sound card. */

/**
 * Sets instrument slot (0 to SYNTHWAY_MAX_INSTRUMENTS - 1). Takes effect at
 * the next audio block, also for its notes already playing, as the setters
 * above do for instrument 0 (which this sets as they would).
 * Returns SYNTHWAY_INVALID_PARAM, and keeps the instrument, when a value is
 * out of the range its setter above accepts.
 */
SYNTHWAY_API synthway_result_t synthway_engine_set_instrument(
    synthway_engine_t* engine,
    uint32_t slot,
    const synthway_instrument_t* instrument
);

SYNTHWAY_API synthway_result_t synthway_engine_get_instrument(
    const synthway_engine_t* engine,
    uint32_t slot,
    synthway_instrument_t* out_instrument
);

/**
 * Starts a note: frequency_hz (above 0, up to 24000) at volume (0 to 1), on
 * instrument slot. note_id is the caller's name for it, for note_off. When
 * note_id still sounds (held or fading out), that note starts again from
 * its current level, at the new frequency. When all SYNTHWAY_MAX_NOTES are
 * taken, the oldest note fading out makes way, else the oldest held one.
 * Drops the glides the note was still to play (synthway_engine_note_glide).
 * Takes effect at the next audio block (offline: the next render call).
 * Returns SYNTHWAY_ERROR when too many notes are waiting for the audio
 * thread (it is not running).
 */
SYNTHWAY_API synthway_result_t synthway_engine_note_on(
    synthway_engine_t* engine,
    uint32_t note_id,
    uint32_t slot,
    float frequency_hz,
    float volume
);

/**
 * Glides note note_id to frequency_hz (above 0, up to 24000) in seconds (0
 * to SYNTHWAY_MAX_GLIDE_SECONDS; 0: a jump), in a straight line in
 * semitones: the frequency grows by the same factor at every sample, so
 * that each semitone takes the same time. The glides of a note chain: each
 * starts where and when the one before ends, the first at the next audio
 * block. A glide to the frequency the note already has holds it for that
 * time. The note keeps gliding while it is released.
 * A note holds up to SYNTHWAY_MAX_GLIDES glides waiting; more are ignored,
 * as are the glides of a note that does not sound.
 * Same timing and errors as synthway_engine_note_on.
 */
SYNTHWAY_API synthway_result_t synthway_engine_note_glide(
    synthway_engine_t* engine,
    uint32_t note_id,
    float frequency_hz,
    float seconds
);

/**
 * Starts the release of note note_id; nothing when it is not held.
 * Same timing and errors as synthway_engine_note_on.
 */
SYNTHWAY_API synthway_result_t synthway_engine_note_off(synthway_engine_t* engine, uint32_t note_id);

/**
 * Starts the release of every note started by synthway_engine_note_on (not
 * the single-note API's). Same timing and errors as synthway_engine_note_on.
 */
SYNTHWAY_API synthway_result_t synthway_engine_all_notes_off(synthway_engine_t* engine);

/**
 * Notes started by synthway_engine_note_on that still sound (held or fading
 * out), as of the last audio block.
 */
SYNTHWAY_API uint32_t synthway_engine_get_sounding_notes(const synthway_engine_t* engine);

/* --------------------------------------------------------------------------
   Automation: an instrument's settings varying over time
   --------------------------------------------------------------------------
   A score can make some settings of an instrument slot vary while it plays
   (synthway_automation_param_t): a setting that a ramp has set is taken
   over from the instrument (set_instrument no longer changes it) until
   synthway_engine_clear_automation gives it back. Left and right can differ:
   left is played on even channels, right on odd ones. With a single channel,
   the left side's settings apply and the pan is ignored. */

/**
 * Takes setting param of instrument slot, on side (both, left or right),
 * from where it is to value in seconds (0 to SYNTHWAY_MAX_AUTOMATION_SECONDS;
 * 0: a jump), in a straight line: in octaves for the cutoffs (each octave
 * takes the same time), in the setting's unit for the others. The ramp starts
 * at the next audio block (offline: the next render call), from where the
 * setting is then: the instrument's own value when it was not automated yet.
 * It replaces the ramp running on that side; after it, the setting holds
 * value. A jump followed by a ramp of the same setting before the next block
 * is taken first, so that the ramp starts from its value. Runs whether the
 * instrument plays or not.
 * A running ramp moves the filter, the reverb mix and the detune every
 * SYNTHWAY_AUTOMATION_PERIOD samples; the gain and the pan are smoothed over
 * about a millisecond, so that a jump does not click.
 * Returns SYNTHWAY_INVALID_PARAM for a value out of the range of param, or a
 * side other than both for the pan and the detune. Same timing and errors as
 * synthway_engine_note_on.
 */
SYNTHWAY_API synthway_result_t synthway_engine_automate(
    synthway_engine_t* engine,
    uint32_t slot,
    synthway_automation_param_t param,
    synthway_side_t side,
    float value,
    float seconds
);

/**
 * Gives every setting of instrument slot back to the instrument (gain 1, pan
 * centre) at the next audio block, dropping the ramps running; slot
 * SYNTHWAY_MAX_INSTRUMENTS: of every instrument. The gain and the pan come
 * back within about a millisecond, the other settings at once.
 * Same timing and errors as synthway_engine_note_on.
 */
SYNTHWAY_API synthway_result_t synthway_engine_clear_automation(synthway_engine_t* engine, uint32_t slot);

/* --------------------------------------------------------------------------
   Offline Rendering (no audio device)
   -------------------------------------------------------------------------- */
/**
 * Initializes the engine for offline rendering: no audio device is opened and
 * nothing is played. Uses config->sample_rate and config->channels (or the
 * defaults, 48000 Hz stereo, when NULL or 0); playback_device_index is ignored.
 * An engine is either offline or bound to a device, never both.
 */
SYNTHWAY_API synthway_result_t synthway_engine_init_offline(
    synthway_engine_t* engine,
    const synthway_engine_config_t* config
);

/**
 * Renders frame_count frames of interleaved float samples, in [-1, 1] unless
 * several notes add up beyond it, into out_samples (frame_count * channels
 * values), exactly as the audio device would receive them. Only for engines
 * initialized with synthway_engine_init_offline.
 */
SYNTHWAY_API synthway_result_t synthway_engine_render(
    synthway_engine_t* engine,
    float* out_samples,
    uint32_t frame_count
);

/**
 * Renders frame_count frames into a 16-bit PCM WAV file at path (created or
 * overwritten). Only for engines initialized with synthway_engine_init_offline.
 * The path goes to fopen(): ANSI code page on Windows, UTF-8 elsewhere.
 */
SYNTHWAY_API synthway_result_t synthway_engine_render_to_wav(
    synthway_engine_t* engine,
    const char* path,
    uint32_t frame_count
);

/* --------------------------------------------------------------------------
   Audio Files: what an offline engine renders, written as WAV or Ogg Vorbis
   (a score is rendered piece by piece, its notes started and released
   between two renders). Allocates and writes files: never from the audio
   thread.
   -------------------------------------------------------------------------- */
/**
 * Creates (or overwrites) the audio file at path, for frames of channels
 * (1 or 2) channels at sample_rate (8000 to 192000 Hz), and gives its writer
 * in *out_writer. quality is Ogg Vorbis's, from -0.1 (smallest) to 1 (best),
 * 0.5 being about 160 kbit/s in stereo; it is ignored for WAV.
 * The path goes to fopen(): ANSI code page on Windows, UTF-8 elsewhere.
 * Returns SYNTHWAY_IO_ERROR when the file cannot be created,
 * SYNTHWAY_INVALID_PARAM for a value out of range.
 */
SYNTHWAY_API synthway_result_t synthway_audio_writer_open(
    synthway_audio_writer_t** out_writer,
    const char* path,
    synthway_audio_file_format_t format,
    uint32_t channels,
    uint32_t sample_rate,
    float quality
);

/**
 * Appends frame_count frames of interleaved float samples. Values beyond
 * [-1, 1] are written as -1 or 1, as a sound card would play them, and counted
 * in the writer's stats.
 */
SYNTHWAY_API synthway_result_t synthway_audio_writer_write(
    synthway_audio_writer_t* writer,
    const float* samples,
    uint32_t frame_count
);

/**
 * Renders frame_count frames of an offline engine (same channels and sample
 * rate as writer) and appends them to writer, as synthway_audio_writer_write
 * would, their gain going in a straight line from gain_start to gain_end
 * (0 to 1; 1 and 1: as rendered, 1 and 0: a fade out). frame_count 0 renders
 * nothing but hands the notes waiting to the engine, which frees their queue.
 */
SYNTHWAY_API synthway_result_t synthway_engine_render_to_writer(
    synthway_engine_t* engine,
    synthway_audio_writer_t* writer,
    uint32_t frame_count,
    float gain_start,
    float gain_end
);

/** What has been written so far, into *out_stats */
SYNTHWAY_API synthway_result_t synthway_audio_writer_get_stats(
    const synthway_audio_writer_t* writer,
    synthway_audio_writer_stats_t* out_stats
);

/**
 * Finishes the file (WAV sizes, last Ogg pages), closes it and frees writer,
 * whatever the result: writer must not be used again. Returns an error when
 * the file could not be finished, or when a write had failed before.
 */
SYNTHWAY_API synthway_result_t synthway_audio_writer_close(synthway_audio_writer_t* writer);

#ifdef __cplusplus
}
#endif

#endif /* SYNTHWAY_ENGINE_H */
