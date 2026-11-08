#ifndef SW_IO_AUDIO_INPUT_H
#define SW_IO_AUDIO_INPUT_H

#include "synthway/types.h"
#include "io/miniaudio_config.h"
#include <stdatomic.h>

/* Samples kept from the microphone: a power of two, 5.4 s at 48 kHz, well
   beyond the longest analysis window, and room for a recording that only
   takes them a few times a second */
#define SW_AUDIO_INPUT_RING_FRAMES 262144

/* A capture device opened with miniaudio, in mono. Its audio thread writes
   into a ring buffer that always holds the latest samples; any other thread
   reads them, without lock (one writer, one reader). Nothing is saved here.
   A virtual input has no device: the caller writes the samples itself. */
typedef struct sw_audio_input {
    ma_context context;
    ma_device device;
    bool context_initialized;
    bool device_initialized;
    bool is_virtual;           /* opened by sw_audio_input_open_virtual */
    bool exclusive;            /* opened in exclusive mode (see sw_audio_input_open) */
    uint32_t sample_rate;
    _Atomic uint64_t written;  /* frames written since opening, by the audio thread */
    float ring[SW_AUDIO_INPUT_RING_FRAMES];
} sw_audio_input;

/* Opens the capture device (device_index -1: system default) and starts
   listening. sample_rate 0 takes the device's own rate.
   exclusive: the device is used by this input alone, at its native format.
   On Windows, the sound then comes straight from the driver, without the
   audio effects of the shared mode (noise suppression, automatic gain), which
   fade a held note. Fails if the device or backend refuses it. */
synthway_result_t sw_audio_input_open(sw_audio_input* input, int device_index, uint32_t sample_rate, bool exclusive);

/* Opens an input without device, fed by sw_audio_input_write */
void sw_audio_input_open_virtual(sw_audio_input* input, uint32_t sample_rate);

bool sw_audio_input_is_open(const sw_audio_input* input);

/* Appends count frames to the ring: what the capture thread does. One writer at a time. */
void sw_audio_input_write(sw_audio_input* input, const float* samples, uint32_t count);

/* Frames written since opening */
uint64_t sw_audio_input_written(sw_audio_input* input);

/* Copies count frames from frame first on (counted since opening). They must
   still be in the ring: first >= written - SW_AUDIO_INPUT_RING_FRAMES, with
   some margin, since the writer keeps going during the copy. */
void sw_audio_input_read(const sw_audio_input* input, uint64_t first, float* out, uint32_t count);

/* Copies the latest count frames (at most SW_AUDIO_INPUT_RING_FRAMES), oldest
   first; zeros stand for frames not captured yet */
void sw_audio_input_read_latest(sw_audio_input* input, float* out, uint32_t count);

/* Stops listening and releases the device; does nothing if not open */
void sw_audio_input_close(sw_audio_input* input);

#endif /* SW_IO_AUDIO_INPUT_H */
