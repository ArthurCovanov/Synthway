#include "synthway/synthway.h"

SYNTHWAY_API const char* synthway_get_version(void) {
    return "0.1.0";
}

SYNTHWAY_API const char* synthway_result_to_string(synthway_result_t result) {
    switch (result) {
        case SYNTHWAY_OK:
            return "Success";
        case SYNTHWAY_ERROR:
            return "General error";
        case SYNTHWAY_INVALID_PARAM:
            return "Invalid parameter";
        case SYNTHWAY_DEVICE_NOT_FOUND:
            return "Device not found";
        case SYNTHWAY_BACKEND_ERROR:
            return "Audio backend error";
        case SYNTHWAY_ALREADY_RUNNING:
            return "Engine is already running";
        case SYNTHWAY_NOT_RUNNING:
            return "Engine is not running";
        case SYNTHWAY_MIDI_BACKEND_ERROR:
            return "MIDI backend error";
        case SYNTHWAY_IO_ERROR:
            return "File input/output error";
        case SYNTHWAY_FORMAT_ERROR:
            return "Unsupported or corrupt audio file";
        default:
            return "Unknown error";
    }
}
