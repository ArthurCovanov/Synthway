#ifndef SYNTHWAY_MINIAUDIO_CONFIG_H
#define SYNTHWAY_MINIAUDIO_CONFIG_H

/* --------------------------------------------------------------------------
   miniaudio build configuration.
   Shared by the implementation unit (miniaudio_impl.c) and every internal
   user of miniaudio, so that all translation units see the same API.
   -------------------------------------------------------------------------- */

/* Synthway drives the low-level device API directly: the high-level engine,
   node graph and resource manager are not compiled. Decoding and encoding
   stay available (sample playback, offline WAV rendering). */
#define MA_NO_ENGINE
#define MA_NO_NODE_GRAPH
#define MA_NO_RESOURCE_MANAGER

#include "miniaudio.h"

#endif /* SYNTHWAY_MINIAUDIO_CONFIG_H */
