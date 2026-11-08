#include "synth/synth.h"
#include <math.h>
#include <string.h>

/* Per-sample smoothing of frequency and volume (exponential moving average),
   which hides parameter jumps between blocks */
#define SW_SMOOTHING 0.02f

#define SW_TWO_PI 6.28318530717958647692
/* Unison voice v starts at the point v × this share of the note's period
   (the golden ratio's fractional part): starting points as spread out as
   possible, whatever the number of voices, so that they never start in phase */
#define SW_UNISON_PHASE_STEP 0.61803398874989484820

#define SW_VOICE_COUNT (1 + SYNTHWAY_MAX_NOTES)

static void sw_voice_drop_glides(sw_voice* voice) {
    voice->glide_head = 0;
    voice->glide_count = 0;
    voice->glide_left = 0;
}

static void sw_voice_init(sw_voice* voice, float frequency_hz, float volume) {
    voice->frequency_hz = frequency_hz;
    voice->volume = volume;
    sw_voice_drop_glides(voice);
    voice->current_frequency = frequency_hz;
    voice->current_volume = volume;
    voice->gate = false;
    voice->gate_seen = false;
    voice->trigger = false;
    voice->sounding = false;
    voice->note_id = 0;
    voice->instrument = 0;
    voice->started = 0;
    sw_oscillator_reset(&voice->oscillator);
    sw_envelope_reset(&voice->envelope);
    for (uint32_t i = 0; i < SYNTHWAY_MAX_PARTIALS; ++i) {
        for (uint32_t v = 0; v < SYNTHWAY_MAX_UNISON_VOICES; ++v) {
            sw_oscillator_reset(&voice->partials[i].oscillators[v]);
        }
        sw_envelope_reset(&voice->partials[i].envelope);
    }
}

void sw_synth_init(sw_synth* synth, float frequency_hz, float volume) {
    for (uint32_t v = 0; v < SW_VOICE_COUNT; ++v) {
        sw_voice_init(&synth->voices[v], frequency_hz, volume);
    }
    synth->note_count = 0;
    for (uint32_t i = 0; i < SYNTHWAY_MAX_INSTRUMENTS; ++i) {
        sw_instrument_bus* bus = &synth->buses[i];
        memset(bus->high_pass, 0, sizeof(bus->high_pass));
        memset(bus->low_pass, 0, sizeof(bus->low_pass));
        bus->active = false;
        sw_reverb_init(&bus->reverb); /* leaves the delay lines alone: they are cleared when it turns on */
    }
}

/* ---------------------------------------------------------------------------
   Notes
   --------------------------------------------------------------------------- */

/* Held, about to start, or still fading out */
static bool sw_voice_busy(const sw_voice* voice) {
    return voice->gate || voice->trigger || voice->sounding;
}

void sw_synth_note_on(sw_synth* synth, uint32_t note_id, uint32_t instrument, float frequency_hz, float volume) {
    sw_voice* chosen = NULL;
    /* The note already playing: struck again */
    for (uint32_t v = 1; v < SW_VOICE_COUNT && !chosen; ++v) {
        if (sw_voice_busy(&synth->voices[v]) && synth->voices[v].note_id == note_id) {
            chosen = &synth->voices[v];
        }
    }
    for (uint32_t v = 1; v < SW_VOICE_COUNT && !chosen; ++v) {
        if (!sw_voice_busy(&synth->voices[v])) {
            chosen = &synth->voices[v];
        }
    }
    /* All taken: the oldest fading out, else the oldest held */
    for (uint32_t pass = 0; pass < 2 && !chosen; ++pass) {
        for (uint32_t v = 1; v < SW_VOICE_COUNT; ++v) {
            sw_voice* voice = &synth->voices[v];
            if ((pass == 1 || !voice->gate) && (!chosen || voice->started < chosen->started)) {
                chosen = voice;
            }
        }
    }

    if (!sw_voice_busy(chosen)) {
        /* From silence: no glide nor fade from the voice's previous note */
        chosen->current_frequency = frequency_hz;
        chosen->current_volume = volume;
    }
    chosen->note_id = note_id;
    chosen->instrument = instrument;
    chosen->frequency_hz = frequency_hz;
    chosen->volume = volume;
    sw_voice_drop_glides(chosen);
    chosen->gate = true;
    chosen->trigger = true;
    chosen->started = ++synth->note_count;
}

void sw_synth_note_off(sw_synth* synth, uint32_t note_id) {
    for (uint32_t v = 1; v < SW_VOICE_COUNT; ++v) {
        sw_voice* voice = &synth->voices[v];
        if (voice->gate && voice->note_id == note_id) {
            voice->gate = false;
        }
    }
}

void sw_synth_note_glide(sw_synth* synth, uint32_t note_id, float frequency_hz, float seconds) {
    for (uint32_t v = 1; v < SW_VOICE_COUNT; ++v) {
        sw_voice* voice = &synth->voices[v];
        if (sw_voice_busy(voice) && voice->note_id == note_id) {
            if (voice->glide_count < SYNTHWAY_MAX_GLIDES) {
                sw_glide* glide = &voice->glides[(voice->glide_head + voice->glide_count) % SYNTHWAY_MAX_GLIDES];
                glide->frequency_hz = frequency_hz;
                glide->seconds = seconds;
                voice->glide_count++;
            }
            return;
        }
    }
}

void sw_synth_all_notes_off(sw_synth* synth) {
    for (uint32_t v = 1; v < SW_VOICE_COUNT; ++v) {
        synth->voices[v].gate = false;
    }
}

uint32_t sw_synth_sounding_notes(const sw_synth* synth) {
    uint32_t count = 0;
    for (uint32_t v = 1; v < SW_VOICE_COUNT; ++v) {
        count += sw_voice_busy(&synth->voices[v]) ? 1u : 0u;
    }
    return count;
}

/* ---------------------------------------------------------------------------
   Voices
   --------------------------------------------------------------------------- */

/* A partial that starts from silence: voice 0 at phase 0, so that a timbre
   always begins with the same waveform; voice v as if started v × the golden
   ratio's fraction of the note's period earlier (each partial at ratio × that
   angle: the voice's waveform is the same, shifted in time) */
static void sw_synth_start_partial(sw_synth_partial* state, float ratio) {
    for (uint32_t v = 0; v < SYNTHWAY_MAX_UNISON_VOICES; ++v) {
        const double share = fmod(v * SW_UNISON_PHASE_STEP, 1.0);
        state->oscillators[v].phase = fmod(share * SW_TWO_PI * (double)ratio, SW_TWO_PI);
    }
}

/* Starts an envelope on a gate edge, or when the gate is held and the
   envelope is silent (a partial added during a note, or a switch between the
   single oscillator and a timbre). Returns true when it starts from silence. */
static bool sw_synth_gate(sw_envelope* envelope, const sw_envelope_steps* steps, bool gate, bool opened, bool closed) {
    if (closed) {
        sw_envelope_release(envelope, steps);
    } else if (opened || (gate && !sw_envelope_is_active(envelope))) {
        const bool from_silence = !sw_envelope_is_active(envelope);
        sw_envelope_trigger(envelope);
        return from_silence;
    }
    return false;
}

/* Gate edges, seen once per block like the other parameters. steps: the
   single oscillator's, then the partials'. */
static void sw_voice_begin_block(sw_voice* voice, const sw_instrument_sound* sound, const sw_envelope_steps* steps) {
    const bool opened = voice->trigger || (voice->gate && !voice->gate_seen);
    const bool closed = !voice->gate && (voice->gate_seen || voice->trigger);
    voice->gate_seen = voice->gate;
    voice->trigger = false;
    const uint32_t partial_count = sound->timbre ? sound->timbre->partial_count : 0;

    /* The source that does not play stays silent, so that switching to it
       never brings back an old note */
    if (sound->timbre) {
        sw_envelope_reset(&voice->envelope);
    } else {
        sw_synth_gate(&voice->envelope, &steps[0], voice->gate, opened, closed);
    }

    for (uint32_t i = 0; i < SYNTHWAY_MAX_PARTIALS; ++i) {
        sw_synth_partial* state = &voice->partials[i];
        if (i >= partial_count) {
            sw_envelope_reset(&state->envelope); /* removed partial: silent at once */
            continue;
        }
        if (sw_synth_gate(&state->envelope, &steps[1 + i], voice->gate, opened, closed)) {
            sw_synth_start_partial(state, sound->timbre->partials[i].ratio);
        }
    }
}

/* Held, or an envelope still sounding */
static bool sw_voice_still_sounding(const sw_voice* voice) {
    if (voice->gate || sw_envelope_is_active(&voice->envelope)) {
        return true;
    }
    for (uint32_t i = 0; i < SYNTHWAY_MAX_PARTIALS; ++i) {
        if (sw_envelope_is_active(&voice->partials[i].envelope)) {
            return true;
        }
    }
    return false;
}

/* Starts the next glide waiting; the jumps (shorter than a sample) are taken
   at once, along with what follows them */
static void sw_voice_start_glide(sw_voice* voice, float rate) {
    while (voice->glide_count > 0) {
        const sw_glide glide = voice->glides[voice->glide_head];
        voice->glide_head = (voice->glide_head + 1) % SYNTHWAY_MAX_GLIDES;
        voice->glide_count--;
        const double samples = floor((double)glide.seconds * (double)rate + 0.5);
        if (samples < 1.0) {
            voice->frequency_hz = glide.frequency_hz;
            continue;
        }
        voice->glide_frequency = voice->frequency_hz;
        voice->glide_factor = pow((double)glide.frequency_hz / (double)voice->frequency_hz, 1.0 / samples);
        voice->glide_left = (uint32_t)samples;
        voice->glide_target = glide.frequency_hz;
        return;
    }
}

/* The note's frequency at the next sample: along the running glide, then
   smoothed. Without a glide, the smoothing alone, as it always was. */
static inline void sw_voice_next_frequency(sw_voice* voice, float rate) {
    if (voice->glide_left == 0 && voice->glide_count > 0) {
        sw_voice_start_glide(voice, rate);
    }
    if (voice->glide_left > 0) {
        voice->glide_frequency *= voice->glide_factor;
        voice->frequency_hz = --voice->glide_left > 0 ? (float)voice->glide_frequency : voice->glide_target;
    }
    voice->current_frequency += (voice->frequency_hz - voice->current_frequency) * SW_SMOOTHING;
}

/* The single oscillator: one waveform, one envelope. Adds into out. */
static void sw_voice_render_oscillator(
    sw_voice* voice,
    const sw_instrument_sound* sound,
    const sw_envelope_steps* steps,
    float rate,
    uint32_t channels,
    float* out,
    uint32_t frame_count
) {
    for (uint32_t frame = 0; frame < frame_count; ++frame) {
        sw_voice_next_frequency(voice, rate);
        voice->current_volume += (voice->volume - voice->current_volume) * SW_SMOOTHING;
        const float level = sw_envelope_next(&voice->envelope, steps);

        float sample = 0.0f;
        if (sw_envelope_is_active(&voice->envelope) && voice->current_volume > 0.0001f) {
            sample = sw_oscillator_sample(&voice->oscillator, sound->waveform);
            sample *= voice->current_volume * level;
            sw_oscillator_advance(&voice->oscillator, voice->current_frequency, rate);
        }

        for (uint32_t ch = 0; ch < channels; ++ch) {
            *out++ += sample;
        }
    }
}

/* The timbre: the sum of its partials, each at ratio × the note's frequency. Adds into out. */
static void sw_voice_render_timbre(
    sw_voice* voice,
    const sw_instrument_sound* sound,
    const sw_envelope_steps* steps,
    float rate,
    uint32_t channels,
    float* out,
    uint32_t frame_count
) {
    const synthway_timbre_t* timbre = sound->timbre;

    for (uint32_t frame = 0; frame < frame_count; ++frame) {
        sw_voice_next_frequency(voice, rate);
        voice->current_volume += (voice->volume - voice->current_volume) * SW_SMOOTHING;

        float sum = 0.0f;
        for (uint32_t i = 0; i < timbre->partial_count; ++i) {
            sw_synth_partial* state = &voice->partials[i];
            const synthway_partial_t* partial = &timbre->partials[i];
            const float level = sw_envelope_next(&state->envelope, &steps[i]);
            if (sw_envelope_is_active(&state->envelope)) {
                sum += sw_oscillator_sample(&state->oscillators[0], partial->waveform) * partial->amplitude * level;
                sw_oscillator_advance(&state->oscillators[0], voice->current_frequency * partial->ratio, rate);
            }
        }

        const float sample = sum * voice->current_volume;
        for (uint32_t ch = 0; ch < channels; ++ch) {
            *out++ += sample;
        }
    }
}

/* The timbre in unison: each partial played by several detuned voices, placed
   alternately left and right. Left goes to even channels, right to odd ones,
   their mean to a single channel. Adds into out. */
static void sw_voice_render_unison(
    sw_voice* voice,
    const sw_instrument_sound* sound,
    const sw_envelope_steps* steps,
    float rate,
    uint32_t channels,
    float* out,
    uint32_t frame_count
) {
    const synthway_timbre_t* timbre = sound->timbre;
    const uint32_t voices = sound->unison_voices > SYNTHWAY_MAX_UNISON_VOICES ? SYNTHWAY_MAX_UNISON_VOICES : sound->unison_voices;

    /* Voice v sits at x from -1 to 1, evenly. It is detuned by |x|^1.5 × the
       detune (with the sign of x): closer together near the note, so that the
       gaps differ and the voices never all come back in phase at regular
       intervals, which would pulse. It is panned by ± x × the spread (the sign
       alternates, so that each side gets low and high voices); panning keeps
       the middle at full level on both sides. */
    float detune[SYNTHWAY_MAX_UNISON_VOICES], left[SYNTHWAY_MAX_UNISON_VOICES], right[SYNTHWAY_MAX_UNISON_VOICES];
    const float scale = (float)(1.0 / sqrt((double)voices)); /* not sqrtf: see sw_envelope_next */
    for (uint32_t v = 0; v < voices; ++v) {
        const float x = 2.0f * (float)v / (float)(voices - 1) - 1.0f;
        const float pan = sound->unison_spread * ((v & 1) ? -x : x);
        detune[v] = exp2f(sound->unison_detune_cents * copysignf(powf(fabsf(x), 1.5f), x) / 1200.0f);
        left[v] = fminf(1.0f, 1.0f - pan) * scale;
        right[v] = fminf(1.0f, 1.0f + pan) * scale;
    }

    for (uint32_t frame = 0; frame < frame_count; ++frame) {
        sw_voice_next_frequency(voice, rate);
        voice->current_volume += (voice->volume - voice->current_volume) * SW_SMOOTHING;

        float sum_left = 0.0f, sum_right = 0.0f;
        for (uint32_t i = 0; i < timbre->partial_count; ++i) {
            sw_synth_partial* state = &voice->partials[i];
            const synthway_partial_t* partial = &timbre->partials[i];
            const float level = sw_envelope_next(&state->envelope, &steps[i]);
            if (!sw_envelope_is_active(&state->envelope)) {
                continue;
            }
            const float gain = partial->amplitude * level;
            const float frequency = voice->current_frequency * partial->ratio;
            for (uint32_t v = 0; v < voices; ++v) {
                const float sample = sw_oscillator_sample(&state->oscillators[v], partial->waveform) * gain;
                sum_left += sample * left[v];
                sum_right += sample * right[v];
                sw_oscillator_advance(&state->oscillators[v], frequency * detune[v], rate);
            }
        }

        const float l = sum_left * voice->current_volume;
        const float r = sum_right * voice->current_volume;
        if (channels == 1) {
            *out++ += 0.5f * (l + r);
        } else {
            for (uint32_t ch = 0; ch < channels; ++ch) {
                *out++ += (ch & 1) ? r : l;
            }
        }
    }
}

static void sw_voice_render(
    sw_voice* voice,
    const sw_instrument_sound* sound,
    const sw_envelope_steps* steps,
    float rate,
    uint32_t channels,
    float* out,
    uint32_t frame_count
) {
    if (sound->timbre && sound->unison_voices > 1) {
        sw_voice_render_unison(voice, sound, steps + 1, rate, channels, out, frame_count);
    } else if (sound->timbre) {
        sw_voice_render_timbre(voice, sound, steps + 1, rate, channels, out, frame_count);
    } else {
        sw_voice_render_oscillator(voice, sound, &steps[0], rate, channels, out, frame_count);
    }
}

/* ---------------------------------------------------------------------------
   Instruments
   --------------------------------------------------------------------------- */

static float sw_filter_process(float input, sw_filter_state* state,
    float b0, float b1, float b2, float a1, float a2) {
    const float output = b0 * input + b1 * state->x1 + b2 * state->x2
        - a1 * state->y1 - a2 * state->y2;
    state->x2 = state->x1;
    state->x1 = input;
    state->y2 = state->y1;
    state->y1 = output;
    return output;
}

/* The band-pass, on the sum of an instrument's notes */
static void sw_bus_filter(
    sw_instrument_bus* bus,
    const sw_instrument_sound* sound,
    float rate,
    uint32_t channels,
    float* block,
    uint32_t frame_count
) {
    /* Bypass the fully open band exactly, preserving the engine's default sound. */
    if (sound->filter_low_cutoff_hz <= 20.0f && sound->filter_high_cutoff_hz >= 20000.0f
        && sound->filter_resonance == 0.0f) {
        memset(&bus->high_pass, 0, sizeof(bus->high_pass));
        memset(&bus->low_pass, 0, sizeof(bus->low_pass));
        return;
    }

    /* Resonant RBJ high-pass and low-pass sections form a band-pass. */
    const float q = 0.70710678f + sound->filter_resonance * 9.29289322f;
    const bool high_pass_enabled = sound->filter_low_cutoff_hz > 20.0f;
    const bool low_pass_enabled = sound->filter_high_cutoff_hz < 20000.0f;
    float hp_b0 = 1.0f, hp_b1 = 0.0f, hp_b2 = 0.0f, hp_a1 = 0.0f, hp_a2 = 0.0f;
    float lp_b0 = 1.0f, lp_b1 = 0.0f, lp_b2 = 0.0f, lp_a1 = 0.0f, lp_a2 = 0.0f;
    if (high_pass_enabled) {
        float cutoff = fminf(sound->filter_low_cutoff_hz, rate * 0.49f);
        const float omega = 6.28318530718f * cutoff / rate;
        const float cosine = cosf(omega), alpha = sinf(omega) / (2.0f * q);
        const float a0 = 1.0f + alpha;
        hp_b0 = ((1.0f + cosine) * 0.5f) / a0;
        hp_b1 = -(1.0f + cosine) / a0;
        hp_b2 = hp_b0;
        hp_a1 = (-2.0f * cosine) / a0;
        hp_a2 = (1.0f - alpha) / a0;
    } else {
        memset(&bus->high_pass, 0, sizeof(bus->high_pass));
    }
    if (low_pass_enabled) {
        float cutoff = fminf(sound->filter_high_cutoff_hz, rate * 0.49f);
        const float omega = 6.28318530718f * cutoff / rate;
        const float cosine = cosf(omega), alpha = sinf(omega) / (2.0f * q);
        const float a0 = 1.0f + alpha;
        lp_b0 = ((1.0f - cosine) * 0.5f) / a0;
        lp_b1 = (1.0f - cosine) / a0;
        lp_b2 = lp_b0;
        lp_a1 = (-2.0f * cosine) / a0;
        lp_a2 = (1.0f - alpha) / a0;
    } else {
        memset(&bus->low_pass, 0, sizeof(bus->low_pass));
    }
    /* Left (channel 0) and right (channel 1) apart, since a spread unison makes
       them differ; the other channels repeat them (even: left, odd: right) */
    const uint32_t sides = channels < 2 ? channels : 2;
    for (uint32_t frame = 0; frame < frame_count; ++frame) {
        float* frame_out = block + (size_t)frame * channels;
        float output[2];
        for (uint32_t side = 0; side < sides; ++side) {
            output[side] = frame_out[side];
            if (high_pass_enabled) output[side] = sw_filter_process(output[side], &bus->high_pass[side], hp_b0, hp_b1, hp_b2, hp_a1, hp_a2);
            if (low_pass_enabled) output[side] = sw_filter_process(output[side], &bus->low_pass[side], lp_b0, lp_b1, lp_b2, lp_a1, lp_a2);
        }
        for (uint32_t ch = 0; ch < channels; ++ch) frame_out[ch] = output[ch & (sides - 1)];
    }
}

/* ---------------------------------------------------------------------------
   Rendering
   --------------------------------------------------------------------------- */

void sw_synth_render(
    sw_synth* synth,
    const sw_synth_params* params,
    uint32_t sample_rate,
    uint32_t channels,
    float* out,
    uint32_t frame_count
) {
    const float rate = (float)sample_rate;
    bool playing[SW_VOICE_COUNT];
    bool used[SYNTHWAY_MAX_INSTRUMENTS];
    memset(used, 0, sizeof(used));

    /* Voice 0 plays the single-note API's note, on instrument 0, and runs
       even in silence, as the engine always did */
    sw_voice* single = &synth->voices[0];
    single->frequency_hz = params->frequency_hz;
    single->volume = params->volume;
    single->gate = params->gate;
    single->instrument = 0;
    playing[0] = true;
    used[0] = true;
    for (uint32_t v = 1; v < SW_VOICE_COUNT; ++v) {
        sw_voice* voice = &synth->voices[v];
        playing[v] = sw_voice_busy(voice) && voice->instrument < SYNTHWAY_MAX_INSTRUMENTS;
        if (playing[v]) {
            used[voice->instrument] = true;
        }
    }

    /* Envelope steps of the instruments that play, shared by their notes */
    for (uint32_t i = 0; i < SYNTHWAY_MAX_INSTRUMENTS; ++i) {
        if (!used[i]) {
            continue;
        }
        const sw_instrument_sound* sound = &params->instruments[i];
        synth->steps[i][0] = sw_envelope_steps_for(&sound->envelope, rate);
        const uint32_t partial_count = sound->timbre ? sound->timbre->partial_count : 0;
        for (uint32_t p = 0; p < partial_count; ++p) {
            synth->steps[i][1 + p] = sw_envelope_steps_for(&sound->timbre->partials[p].envelope, rate);
        }
    }

    for (uint32_t v = 0; v < SW_VOICE_COUNT; ++v) {
        if (playing[v]) {
            sw_voice* voice = &synth->voices[v];
            sw_voice_begin_block(voice, &params->instruments[voice->instrument], synth->steps[voice->instrument]);
        }
    }

    /* Each instrument's notes are summed apart, filtered and reverberated,
       then added to the others, in chunks that fit the mix buffer */
    memset(out, 0, sizeof(float) * (size_t)frame_count * channels);
    const uint32_t chunk_frames = channels <= SW_SYNTH_MIX_SAMPLES ? SW_SYNTH_MIX_SAMPLES / channels : 0;
    bool processed[SYNTHWAY_MAX_INSTRUMENTS];
    memset(processed, 0, sizeof(processed));
    for (uint32_t done = 0; chunk_frames > 0 && done < frame_count; ) {
        const uint32_t frames = frame_count - done < chunk_frames ? frame_count - done : chunk_frames;
        const size_t samples = (size_t)frames * channels;
        float* block = out + (size_t)done * channels;

        for (uint32_t i = 0; i < SYNTHWAY_MAX_INSTRUMENTS; ++i) {
            sw_instrument_bus* bus = &synth->buses[i];
            if (!used[i] && !bus->reverb.active) {
                continue; /* nothing playing, nothing left ringing */
            }
            const sw_instrument_sound* sound = &params->instruments[i];
            memset(synth->mix, 0, sizeof(float) * samples);
            for (uint32_t v = 0; v < SW_VOICE_COUNT; ++v) {
                sw_voice* voice = &synth->voices[v];
                if (playing[v] && voice->instrument == i) {
                    sw_voice_render(voice, sound, synth->steps[i], rate, channels, synth->mix, frames);
                }
            }
            sw_bus_filter(bus, sound, rate, channels, synth->mix, frames);
            sw_reverb_process(&bus->reverb, sound->reverb_mix, sample_rate, channels, synth->mix, frames);
            for (size_t s = 0; s < samples; ++s) {
                block[s] += synth->mix[s];
            }
            processed[i] = true;
        }
        done += frames;
    }

    for (uint32_t v = 1; v < SW_VOICE_COUNT; ++v) {
        if (playing[v]) {
            synth->voices[v].sounding = sw_voice_still_sounding(&synth->voices[v]);
        }
    }
    /* An instrument that fell silent starts its filter afresh next time */
    for (uint32_t i = 0; i < SYNTHWAY_MAX_INSTRUMENTS; ++i) {
        sw_instrument_bus* bus = &synth->buses[i];
        if (bus->active && !processed[i]) {
            memset(bus->high_pass, 0, sizeof(bus->high_pass));
            memset(bus->low_pass, 0, sizeof(bus->low_pass));
        }
        bus->active = processed[i];
    }
}
