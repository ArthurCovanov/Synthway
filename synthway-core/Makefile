# ==============================================================================
# Synthway Core Makefile (Cross-Platform: Windows / Linux / macOS)
# ==============================================================================

# `cc` / `c++` exist in every GCC install (MSYS2 may lack the gcc / g++ names)
ifeq ($(origin CC),default)
    CC = cc
endif
ifeq ($(origin CXX),default)
    CXX = c++
endif
CFLAGS ?= -O2 -Wall -Wextra -std=c11 -fPIC
# libogg and libvorbis; src/io/xiph holds the ogg/config_types.h that libogg's configure would generate
XIPH_INCLUDES = -Ivendor/libogg/include -Isrc/io/xiph -Ivendor/libvorbis/include
INCLUDES = -Iinclude -Isrc -Ivendor/miniaudio -Ivendor/rtmidi $(XIPH_INCLUDES)

# Third-party code is compiled without warnings: it is not ours to fix
VENDOR_CFLAGS = -O2 -w -std=c11 -fPIC
VENDOR_CXXFLAGS = -O2 -w -std=c++17 -fPIC
# libogg and libvorbis are older C: GNU extensions on
XIPH_CFLAGS = -O2 -w -std=gnu11 -fPIC

BUILD_DIR = build
BIN_DIR = $(BUILD_DIR)/bin
LIB_DIR = $(BUILD_DIR)/lib

# OS Detection: $(OS) is not always exported in MSYS2 shells, so `uname`
# (MINGW64_NT-..., UCRT64_NT-..., MSYS_NT-...) is checked as well
UNAME_S := $(shell uname -s 2>/dev/null)
ifneq (,$(or $(filter Windows_NT,$(OS)),$(findstring _NT,$(UNAME_S))))
    PLATFORM = Windows
    PLATFORM_DIR = windows
    TARGET_LIB = $(LIB_DIR)/synthway.dll
    EXE_EXT = .exe
    # -static: GCC, C++ and winpthread runtimes inside the DLL, so that it
    #          loads from Python without MSYS2 in PATH
    # -fno-use-linker-plugin: works around the incomplete MSYS2 GCC install
    #          (liblto_plugin.dll missing); harmless once GCC is repaired
    LDFLAGS_SHARED = -shared -static -fno-use-linker-plugin -Wl,--out-implib,$(LIB_DIR)/libsynthway.a
    RTMIDI_API = RTMIDI_API_WINMM
    LIBS = -lwinmm -lole32 -lm
    # Only the SYNTHWAY_API (dllexport) functions are exported
    LIB_VISIBILITY =
    MKDIR_P = mkdir -p
    RM_RF = rm -rf
else
    # Internal sw_* functions stay private: only SYNTHWAY_API is visible
    LIB_VISIBILITY = -fvisibility=hidden
    ifeq ($(UNAME_S),Darwin)
        PLATFORM = macOS
        PLATFORM_DIR = macos
        TARGET_LIB = $(LIB_DIR)/libsynthway.dylib
        EXE_EXT =
        LDFLAGS_SHARED = -dynamiclib
        RTMIDI_API = RTMIDI_API_CORE
        LIBS = -framework CoreMIDI -framework CoreAudio -framework AudioToolbox -framework CoreFoundation -lpthread -lm
    else
        PLATFORM = Linux
        PLATFORM_DIR = linux
        TARGET_LIB = $(LIB_DIR)/libsynthway.so
        EXE_EXT =
        LDFLAGS_SHARED = -shared
        RTMIDI_API = RTMIDI_API_ALSA
        LIBS = -lasound -lpthread -lm -ldl
    endif
    MKDIR_P = mkdir -p
    RM_RF = rm -rf
endif

# Per-platform directories, so that a WSL build never reuses Windows objects
OBJ_DIR = $(BUILD_DIR)/obj/$(PLATFORM_DIR)
VENDOR_DIR = $(BUILD_DIR)/vendor/$(PLATFORM_DIR)

TARGET_CLI = $(BIN_DIR)/synthway_cli$(EXE_EXT)
TARGET_TEST = $(BIN_DIR)/synthway_render_test$(EXE_EXT)
TARGET_ANALYSIS_TEST = $(BIN_DIR)/synthway_analysis_test$(EXE_EXT)

# Library sources, by layer (see README.md); objects mirror this tree in $(OBJ_DIR)
SRCS = src/synthway.c \
       src/engine/engine.c src/engine/engine_params.c src/engine/engine_offline.c \
       src/synth/synth.c src/synth/oscillator.c src/synth/envelope.c src/synth/reverb.c \
       src/interpreter/interpreter.c \
       src/analyzer/analyzer.c \
       src/analysis/analysis.c src/analysis/notes.c src/analysis/waveform.c src/analysis/pitch.c src/analysis/spectrum.c src/analysis/fft.c \
       src/io/audio_output.c src/io/audio_input.c src/io/audio_file.c src/io/wav_file.c src/io/audio_writer.c \
       src/io/audio_devices.c src/io/midi_ports.c
OBJS = $(patsubst src/%.c,$(OBJ_DIR)/%.o,$(SRCS))
HEADERS = $(wildcard include/synthway/*.h src/*.h src/*/*.h)
CLI_SRC = examples/cli_main.c
CLI_OBJ = $(OBJ_DIR)/cli_main.o
TEST_SRC = tests/render_test.c
TEST_OBJ = $(OBJ_DIR)/render_test.o
ANALYSIS_TEST_SRC = tests/analysis_test.c
ANALYSIS_TEST_OBJ = $(OBJ_DIR)/analysis_test.o

# Third-party static libraries, rebuilt only when their sources change
MINIAUDIO_LIB = $(VENDOR_DIR)/libminiaudio.a
RTMIDI_LIB = $(VENDOR_DIR)/librtmidi.a
RTMIDI_HEADERS = vendor/rtmidi/RtMidi.h vendor/rtmidi/rtmidi_c.h
OGG_LIB = $(VENDOR_DIR)/libogg.a
OGG_OBJS = $(patsubst vendor/libogg/src/%.c,$(VENDOR_DIR)/libogg/%.o,$(wildcard vendor/libogg/src/*.c))
OGG_HEADERS = $(wildcard vendor/libogg/include/ogg/*.h) src/io/xiph/ogg/config_types.h
VORBIS_LIB = $(VENDOR_DIR)/libvorbis.a
VORBIS_OBJS = $(patsubst vendor/libvorbis/lib/%.c,$(VENDOR_DIR)/libvorbis/%.o,$(wildcard vendor/libvorbis/lib/*.c))
VORBIS_HEADERS = $(wildcard vendor/libvorbis/include/vorbis/*.h vendor/libvorbis/lib/*.h vendor/libvorbis/lib/*/*.h vendor/libvorbis/lib/*/*/*.h) $(OGG_HEADERS)

.PHONY: all lib cli vendor test clean run help

all: lib cli $(TARGET_TEST) $(TARGET_ANALYSIS_TEST)

# Compile third-party static libraries
vendor: $(MINIAUDIO_LIB) $(RTMIDI_LIB) $(OGG_LIB) $(VORBIS_LIB)

$(OGG_LIB): $(OGG_OBJS)
	@echo "[AR] $@"
	@rm -f $@
	$(AR) rcs $@ $^

$(VENDOR_DIR)/libogg/%.o: vendor/libogg/src/%.c $(OGG_HEADERS)
	@echo "[CC] $<"
	@$(MKDIR_P) $(dir $@)
	$(CC) $(XIPH_CFLAGS) $(XIPH_INCLUDES) -c $< -o $@

$(VORBIS_LIB): $(VORBIS_OBJS)
	@echo "[AR] $@"
	@rm -f $@
	$(AR) rcs $@ $^

$(VENDOR_DIR)/libvorbis/%.o: vendor/libvorbis/lib/%.c $(VORBIS_HEADERS)
	@echo "[CC] $<"
	@$(MKDIR_P) $(dir $@)
	$(CC) $(XIPH_CFLAGS) $(XIPH_INCLUDES) -Ivendor/libvorbis/lib -c $< -o $@

$(MINIAUDIO_LIB): $(VENDOR_DIR)/miniaudio_impl.o
	@echo "[AR] $@"
	@rm -f $@
	$(AR) rcs $@ $^

$(VENDOR_DIR)/miniaudio_impl.o: src/io/miniaudio_impl.c src/io/miniaudio_config.h vendor/miniaudio/miniaudio.h | $(VENDOR_DIR)
	@echo "[CC] $<"
	$(CC) $(VENDOR_CFLAGS) -Ivendor/miniaudio -c $< -o $@

$(RTMIDI_LIB): $(VENDOR_DIR)/RtMidi.o $(VENDOR_DIR)/rtmidi_c.o
	@echo "[AR] $@"
	@rm -f $@
	$(AR) rcs $@ $^

$(VENDOR_DIR)/%.o: vendor/rtmidi/%.cpp $(RTMIDI_HEADERS) | $(VENDOR_DIR)
	@echo "[CXX] $<"
	$(CXX) $(VENDOR_CXXFLAGS) -D$(RTMIDI_API) -Ivendor/rtmidi -c $< -o $@

# Compile shared library (linked with the C++ driver because RtMidi is C++)
lib: $(TARGET_LIB)

$(TARGET_LIB): $(OBJS) $(RTMIDI_LIB) $(MINIAUDIO_LIB) $(VORBIS_LIB) $(OGG_LIB) | $(LIB_DIR)
	@echo "[LINK] $@"
	$(CXX) $(LDFLAGS_SHARED) -o $@ $(OBJS) $(RTMIDI_LIB) $(MINIAUDIO_LIB) $(VORBIS_LIB) $(OGG_LIB) $(LIBS)

# Compile CLI application
cli: $(TARGET_CLI)

$(TARGET_CLI): $(CLI_OBJ) $(TARGET_LIB) | $(BIN_DIR)
	@echo "[LINK CLI] $@"
ifeq ($(PLATFORM),Windows)
	$(CC) -fno-use-linker-plugin -o $@ $(CLI_OBJ) -L$(LIB_DIR) -lsynthway $(LIBS)
	@cp $(TARGET_LIB) $(BIN_DIR)/
else
	$(CC) -o $@ $(CLI_OBJ) -L$(LIB_DIR) -lsynthway -Wl,-rpath,'$$ORIGIN/../lib' $(LIBS)
endif

# Offline render and analysis tests (no audio device, no sound)
test: $(TARGET_TEST) $(TARGET_ANALYSIS_TEST)
	@echo "[TEST] Offline render test"
	@$(TARGET_TEST) $(BUILD_DIR)/render_test.wav
	@echo "[TEST] Analysis test"
	@$(TARGET_ANALYSIS_TEST) $(BUILD_DIR)/analysis_test.wav

$(TARGET_TEST): $(TEST_OBJ) $(TARGET_LIB) | $(BIN_DIR)
	@echo "[LINK TEST] $@"
ifeq ($(PLATFORM),Windows)
	$(CC) -fno-use-linker-plugin -o $@ $(TEST_OBJ) -L$(LIB_DIR) -lsynthway -lm
	@cp $(TARGET_LIB) $(BIN_DIR)/
else
	$(CC) -o $@ $(TEST_OBJ) -L$(LIB_DIR) -lsynthway -Wl,-rpath,'$$ORIGIN/../lib' $(LIBS)
endif

$(TARGET_ANALYSIS_TEST): $(ANALYSIS_TEST_OBJ) $(TARGET_LIB) | $(BIN_DIR)
	@echo "[LINK TEST] $@"
ifeq ($(PLATFORM),Windows)
	$(CC) -fno-use-linker-plugin -o $@ $(ANALYSIS_TEST_OBJ) -L$(LIB_DIR) -lsynthway -lm
	@cp $(TARGET_LIB) $(BIN_DIR)/
else
	$(CC) -o $@ $(ANALYSIS_TEST_OBJ) -L$(LIB_DIR) -lsynthway -Wl,-rpath,'$$ORIGIN/../lib' $(LIBS)
endif

# Object compilation rules
$(OBJ_DIR)/%.o: src/%.c $(HEADERS) | $(OBJ_DIR)
	@echo "[CC] $<"
	@$(MKDIR_P) $(dir $@)
	$(CC) $(CFLAGS) $(LIB_VISIBILITY) -DSYNTHWAY_BUILD_SHARED $(INCLUDES) -c $< -o $@

$(OBJ_DIR)/cli_main.o: $(CLI_SRC) $(HEADERS) | $(OBJ_DIR)
	@echo "[CC] $<"
	$(CC) $(CFLAGS) -DSYNTHWAY_USE_SHARED $(INCLUDES) -c $< -o $@

$(TEST_OBJ): $(TEST_SRC) $(HEADERS) | $(OBJ_DIR)
	@echo "[CC] $<"
	$(CC) $(CFLAGS) -DSYNTHWAY_USE_SHARED $(INCLUDES) -c $< -o $@

$(ANALYSIS_TEST_OBJ): $(ANALYSIS_TEST_SRC) $(HEADERS) | $(OBJ_DIR)
	@echo "[CC] $<"
	$(CC) $(CFLAGS) -DSYNTHWAY_USE_SHARED $(INCLUDES) -c $< -o $@

$(BUILD_DIR) $(BIN_DIR) $(LIB_DIR) $(OBJ_DIR) $(VENDOR_DIR):
	@$(MKDIR_P) $@

clean:
	@echo "[CLEAN] Removing $(BUILD_DIR)..."
	@$(RM_RF) $(BUILD_DIR)

run: cli
	@echo "[RUN] Executing Synthway CLI..."
	@$(TARGET_CLI)

help:
	@echo "Synthway Core Build System"
	@echo "  make          - Build shared library and CLI"
	@echo "  make vendor   - Build the third-party static libraries (miniaudio, RtMidi, libogg, libvorbis)"
	@echo "  make lib      - Build the synthway shared library"
	@echo "  make cli      - Build synthway_cli executable"
	@echo "  make test     - Build and run the offline render and analysis tests (no sound)"
	@echo "  make run      - Build and run the test CLI (plays sound)"
	@echo "  make clean    - Clean build artifacts"
