#ifndef SYNTHWAY_DEVICES_H
#define SYNTHWAY_DEVICES_H

/* Devices of the machine: audio outputs and inputs, MIDI ports.
   Implemented in src/io/. Include "synthway/synthway.h" rather than this file. */

#include "synthway/types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
   Audio Device Enumeration
   -------------------------------------------------------------------------- */
/**
 * Retrieves the number of available audio devices for a given category (playback or capture).
 */
SYNTHWAY_API synthway_result_t synthway_get_device_count(
    synthway_device_type_t type,
    uint32_t* out_count
);

/**
 * Retrieves detailed info for a specific device index within a category.
 */
SYNTHWAY_API synthway_result_t synthway_get_device_info(
    synthway_device_type_t type,
    uint32_t index,
    synthway_device_info_t* out_info
);

/**
 * Convenience utility to print all discovered playback and capture devices
 * neatly categorized to standard output.
 */
SYNTHWAY_API void synthway_print_devices(void);

/* --------------------------------------------------------------------------
   MIDI Port Enumeration
   -------------------------------------------------------------------------- */
/**
 * Retrieves the number of available MIDI ports for a given direction (input or output).
 */
SYNTHWAY_API synthway_result_t synthway_get_midi_port_count(
    synthway_midi_port_type_t type,
    uint32_t* out_count
);

/**
 * Retrieves detailed info for a specific MIDI port index within a direction.
 */
SYNTHWAY_API synthway_result_t synthway_get_midi_port_info(
    synthway_midi_port_type_t type,
    uint32_t index,
    synthway_midi_port_info_t* out_info
);

#ifdef __cplusplus
}
#endif

#endif /* SYNTHWAY_DEVICES_H */
