#ifndef SW_IO_MA_RESULT_H
#define SW_IO_MA_RESULT_H

#include "synthway/types.h"
#include "io/miniaudio_config.h"

/* Converts a miniaudio result into the public result code */
static inline synthway_result_t sw_result_from_ma(ma_result result) {
    switch (result) {
        case MA_SUCCESS:
            return SYNTHWAY_OK;
        case MA_INVALID_ARGS:
            return SYNTHWAY_INVALID_PARAM;
        case MA_NO_DEVICE:
        case MA_DEVICE_NOT_INITIALIZED:
            return SYNTHWAY_DEVICE_NOT_FOUND;
        default:
            return SYNTHWAY_BACKEND_ERROR;
    }
}

#endif /* SW_IO_MA_RESULT_H */
