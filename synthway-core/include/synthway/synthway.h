#ifndef SYNTHWAY_H
#define SYNTHWAY_H

/* Public API of synthway-core: the only header to include.
   Each header matches a part of src/ (see README.md):
     types.h    shared types, result codes
     devices.h  audio devices and MIDI ports    → src/io/
     engine.h   the synthesizer engine          → src/engine/
     analyzer.h the sound analyzer              → src/analyzer/
     this file  version and result strings      → src/synthway.c */

#include "synthway/types.h"
#include "synthway/devices.h"
#include "synthway/engine.h"
#include "synthway/analyzer.h"

#ifdef __cplusplus
extern "C" {
#endif

/* --------------------------------------------------------------------------
   Version & Helpers
   -------------------------------------------------------------------------- */
SYNTHWAY_API const char* synthway_get_version(void);
SYNTHWAY_API const char* synthway_result_to_string(synthway_result_t result);

#ifdef __cplusplus
}
#endif

#endif /* SYNTHWAY_H */
