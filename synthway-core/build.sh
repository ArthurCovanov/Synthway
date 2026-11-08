#!/usr/bin/env bash
# Helper build script for Linux / WSL / macOS
# Usage: ./build.sh [--clean] [--test]
#   --clean : rebuild everything, including the third-party libraries (miniaudio, RtMidi, libogg, libvorbis)
#   --test  : then run the offline render and analysis tests (no audio device, no sound)
set -e

CLEAN=0
TEST=0
for arg in "$@"; do
    case "$arg" in
        --clean) CLEAN=1 ;;
        --test) TEST=1 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CC="${CC:-gcc}"
CXX="${CXX:-g++}"
AR="${AR:-ar}"
echo "[*] Using C Compiler  : $CC"
echo "[*] Using C++ Compiler: $CXX"

UNAME_S=$(uname -s)
if [ "$UNAME_S" = "Darwin" ]; then
    PLATFORM="macos"
    LIB_EXT=".dylib"
    SHARED_FLAGS="-dynamiclib"
    RTMIDI_API="RTMIDI_API_CORE"
    LIBS="-framework CoreMIDI -framework CoreAudio -framework AudioToolbox -framework CoreFoundation -lpthread -lm"
else
    PLATFORM="linux"
    LIB_EXT=".so"
    SHARED_FLAGS="-shared"
    RTMIDI_API="RTMIDI_API_ALSA"
    LIBS="-lasound -lpthread -lm -ldl"
fi

# Per-platform directories, so that a WSL build never reuses Windows objects
OBJ_DIR="build/obj/$PLATFORM"
VENDOR_DIR="build/vendor/$PLATFORM"

if [ "$CLEAN" = 1 ]; then
    rm -rf "$OBJ_DIR" "$VENDOR_DIR"
fi
mkdir -p "$OBJ_DIR" "$VENDOR_DIR" build/lib build/bin

# True when $1 is missing or older than any of the following files
is_stale() {
    local target="$1"
    shift
    [ -f "$target" ] || return 0
    for source in "$@"; do
        [ "$source" -nt "$target" ] && return 0
    done
    return 1
}

# --------------------------------------------------------------------------
# Third-party libraries: built once, rebuilt only when their sources change
# --------------------------------------------------------------------------
MINIAUDIO_LIB="$VENDOR_DIR/libminiaudio.a"
if is_stale "$MINIAUDIO_LIB" vendor/miniaudio/miniaudio.h src/io/miniaudio_impl.c src/io/miniaudio_config.h; then
    echo "[*] Building libminiaudio.a..."
    $CC -O2 -w -std=c11 -fPIC -Ivendor/miniaudio -c src/io/miniaudio_impl.c -o "$VENDOR_DIR/miniaudio_impl.o"
    rm -f "$MINIAUDIO_LIB"
    $AR rcs "$MINIAUDIO_LIB" "$VENDOR_DIR/miniaudio_impl.o"
else
    echo "[=] libminiaudio.a is up to date"
fi

RTMIDI_LIB="$VENDOR_DIR/librtmidi.a"
if is_stale "$RTMIDI_LIB" vendor/rtmidi/RtMidi.cpp vendor/rtmidi/RtMidi.h vendor/rtmidi/rtmidi_c.cpp vendor/rtmidi/rtmidi_c.h; then
    echo "[*] Building librtmidi.a ($RTMIDI_API)..."
    $CXX -O2 -w -std=c++17 -fPIC -D$RTMIDI_API -Ivendor/rtmidi -c vendor/rtmidi/RtMidi.cpp -o "$VENDOR_DIR/RtMidi.o"
    $CXX -O2 -w -std=c++17 -fPIC -D$RTMIDI_API -Ivendor/rtmidi -c vendor/rtmidi/rtmidi_c.cpp -o "$VENDOR_DIR/rtmidi_c.o"
    rm -f "$RTMIDI_LIB"
    $AR rcs "$RTMIDI_LIB" "$VENDOR_DIR/RtMidi.o" "$VENDOR_DIR/rtmidi_c.o"
else
    echo "[=] librtmidi.a is up to date"
fi

# libogg and libvorbis, for Ogg Vorbis files. src/io/xiph holds the
# ogg/config_types.h that libogg's configure would generate.
XIPH_INCLUDES="-Ivendor/libogg/include -Isrc/io/xiph -Ivendor/libvorbis/include"
XIPH_CONFIG=src/io/xiph/ogg/config_types.h

OGG_LIB="$VENDOR_DIR/libogg.a"
if is_stale "$OGG_LIB" $(find vendor/libogg -type f) "$XIPH_CONFIG"; then
    echo "[*] Building libogg.a..."
    mkdir -p "$VENDOR_DIR/libogg"
    OGG_OBJECTS=""
    for source in vendor/libogg/src/*.c; do
        object="$VENDOR_DIR/libogg/$(basename "$source" .c).o"
        $CC -O2 -w -std=gnu11 -fPIC $XIPH_INCLUDES -c "$source" -o "$object"
        OGG_OBJECTS="$OGG_OBJECTS $object"
    done
    rm -f "$OGG_LIB"
    $AR rcs "$OGG_LIB" $OGG_OBJECTS
else
    echo "[=] libogg.a is up to date"
fi

VORBIS_LIB="$VENDOR_DIR/libvorbis.a"
if is_stale "$VORBIS_LIB" $(find vendor/libvorbis vendor/libogg/include -type f) "$XIPH_CONFIG"; then
    echo "[*] Building libvorbis.a (with the encoder)..."
    mkdir -p "$VENDOR_DIR/libvorbis"
    VORBIS_OBJECTS=""
    for source in vendor/libvorbis/lib/*.c; do
        object="$VENDOR_DIR/libvorbis/$(basename "$source" .c).o"
        $CC -O2 -w -std=gnu11 -fPIC $XIPH_INCLUDES -Ivendor/libvorbis/lib -c "$source" -o "$object"
        VORBIS_OBJECTS="$VORBIS_OBJECTS $object"
    done
    rm -f "$VORBIS_LIB"
    $AR rcs "$VORBIS_LIB" $VORBIS_OBJECTS
else
    echo "[=] libvorbis.a is up to date"
fi

# --------------------------------------------------------------------------
# Synthway library
# --------------------------------------------------------------------------
# Library sources, relative to src/ and by layer (see README.md); objects mirror this tree in $OBJ_DIR
SOURCES="synthway
         engine/engine engine/engine_params engine/engine_offline
         synth/synth synth/oscillator synth/envelope synth/reverb
         interpreter/interpreter
         analyzer/analyzer
         analysis/analysis analysis/notes analysis/waveform analysis/pitch analysis/spectrum analysis/fft
         io/audio_output io/audio_input io/audio_file io/wav_file io/audio_writer io/audio_devices io/midi_ports"
OBJECTS=""
for name in $SOURCES; do
    echo "[*] Compiling src/$name.c..."
    mkdir -p "$(dirname "$OBJ_DIR/$name.o")"
    # -fvisibility=hidden: internal sw_* functions stay private, only SYNTHWAY_API is exported
    $CC -O2 -Wall -std=c11 -fPIC -fvisibility=hidden -DSYNTHWAY_BUILD_SHARED -Iinclude -Isrc -Ivendor/miniaudio -Ivendor/rtmidi $XIPH_INCLUDES -c "src/$name.c" -o "$OBJ_DIR/$name.o"
    OBJECTS="$OBJECTS $OBJ_DIR/$name.o"
done

# Linked with the C++ driver because RtMidi is C++
echo "[*] Linking libsynthway${LIB_EXT}..."
$CXX $SHARED_FLAGS -o "build/lib/libsynthway${LIB_EXT}" $OBJECTS "$RTMIDI_LIB" "$MINIAUDIO_LIB" "$VORBIS_LIB" "$OGG_LIB" $LIBS

echo "[*] Compiling CLI example..."
$CC -O2 -Wall -std=c11 -DSYNTHWAY_USE_SHARED -Iinclude -c examples/cli_main.c -o "$OBJ_DIR/cli_main.o"
$CC -o build/bin/synthway_cli "$OBJ_DIR/cli_main.o" -Lbuild/lib -lsynthway -Wl,-rpath,'$ORIGIN/../lib' $LIBS

echo "[*] Compiling render test..."
$CC -O2 -Wall -std=c11 -DSYNTHWAY_USE_SHARED -Iinclude -c tests/render_test.c -o "$OBJ_DIR/render_test.o"
$CC -o build/bin/synthway_render_test "$OBJ_DIR/render_test.o" -Lbuild/lib -lsynthway -Wl,-rpath,'$ORIGIN/../lib' $LIBS

echo "[*] Compiling analysis test..."
$CC -O2 -Wall -std=c11 -DSYNTHWAY_USE_SHARED -Iinclude -c tests/analysis_test.c -o "$OBJ_DIR/analysis_test.o"
$CC -o build/bin/synthway_analysis_test "$OBJ_DIR/analysis_test.o" -Lbuild/lib -lsynthway -Wl,-rpath,'$ORIGIN/../lib' $LIBS

echo "[+] Build complete!"
echo "    Library: build/lib/libsynthway${LIB_EXT}"
echo "    CLI    : build/bin/synthway_cli"
echo "    Tests  : build/bin/synthway_render_test, build/bin/synthway_analysis_test"

if [ "$TEST" = 1 ]; then
    echo "[*] Running offline render test..."
    build/bin/synthway_render_test build/render_test.wav
    echo "[*] Running analysis test..."
    build/bin/synthway_analysis_test build/analysis_test.wav
fi
