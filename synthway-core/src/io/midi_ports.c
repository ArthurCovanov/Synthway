#include "synthway/synthway.h"
#include "rtmidi_c.h"
#include <string.h>

/* Like the miniaudio contexts in audio_devices.c, an RtMidi handle is created
   per call: enumeration is not on a hot path and this keeps the API stateless. */
static RtMidiPtr synthway_midi_open(synthway_midi_port_type_t type) {
    return (type == SYNTHWAY_MIDI_INPUT) ? rtmidi_in_create_default() : rtmidi_out_create_default();
}

static void synthway_midi_close(synthway_midi_port_type_t type, RtMidiPtr device) {
    if (type == SYNTHWAY_MIDI_INPUT) {
        rtmidi_in_free(device);
    } else {
        rtmidi_out_free(device);
    }
}

SYNTHWAY_API synthway_result_t synthway_get_midi_port_count(
    synthway_midi_port_type_t type,
    uint32_t* out_count
) {
    if (!out_count) {
        return SYNTHWAY_INVALID_PARAM;
    }

    *out_count = 0;

    RtMidiPtr device = synthway_midi_open(type);
    if (!device) {
        return SYNTHWAY_MIDI_BACKEND_ERROR;
    }
    if (!device->ok) {
        synthway_midi_close(type, device);
        return SYNTHWAY_MIDI_BACKEND_ERROR;
    }

    unsigned int count = rtmidi_get_port_count(device);
    synthway_result_t result = device->ok ? SYNTHWAY_OK : SYNTHWAY_MIDI_BACKEND_ERROR;
    if (result == SYNTHWAY_OK) {
        *out_count = (uint32_t)count;
    }

    synthway_midi_close(type, device);
    return result;
}

SYNTHWAY_API synthway_result_t synthway_get_midi_port_info(
    synthway_midi_port_type_t type,
    uint32_t index,
    synthway_midi_port_info_t* out_info
) {
    if (!out_info) {
        return SYNTHWAY_INVALID_PARAM;
    }

    memset(out_info, 0, sizeof(synthway_midi_port_info_t));
    out_info->type = type;

    RtMidiPtr device = synthway_midi_open(type);
    if (!device) {
        return SYNTHWAY_MIDI_BACKEND_ERROR;
    }
    if (!device->ok) {
        synthway_midi_close(type, device);
        return SYNTHWAY_MIDI_BACKEND_ERROR;
    }

    if (index >= rtmidi_get_port_count(device)) {
        synthway_midi_close(type, device);
        return SYNTHWAY_DEVICE_NOT_FOUND;
    }

    int name_len = (int)sizeof(out_info->name);
    rtmidi_get_port_name(device, index, out_info->name, &name_len);
    synthway_result_t result = device->ok ? SYNTHWAY_OK : SYNTHWAY_MIDI_BACKEND_ERROR;

    synthway_midi_close(type, device);
    return result;
}
