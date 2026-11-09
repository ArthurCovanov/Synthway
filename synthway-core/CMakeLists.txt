cmake_minimum_required(VERSION 3.16)
project(synthway-core VERSION 0.3.1 LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Output directories
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/lib)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)

# Options
option(BUILD_SHARED_LIBS "Build Synthway as a shared library" ON)
option(SYNTHWAY_BUILD_EXAMPLES "Build Synthway CLI examples" ON)
option(SYNTHWAY_BUILD_TESTS "Build the offline render and analysis tests (run with ctest)" ON)

# Public & Private Includes
set(SYNTHWAY_INCLUDE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/include)
set(SYNTHWAY_VENDOR_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor)
set(SYNTHWAY_SRC_DIR ${CMAKE_CURRENT_SOURCE_DIR}/src)

# ------------------------------------------------------------------------------
# Third-party libraries, built as separate static libraries without warnings
# (vendor/ only holds unmodified upstream files, see vendor/README.md)
# ------------------------------------------------------------------------------

# miniaudio (configured by src/io/miniaudio_config.h)
add_library(miniaudio STATIC ${SYNTHWAY_SRC_DIR}/io/miniaudio_impl.c)
target_include_directories(miniaudio PUBLIC ${SYNTHWAY_VENDOR_DIR}/miniaudio)
set_target_properties(miniaudio PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_options(miniaudio PRIVATE $<$<C_COMPILER_ID:GNU,Clang,AppleClang>:-w>)

if(WIN32)
    target_link_libraries(miniaudio PUBLIC ole32 winmm)
elseif(APPLE)
    find_library(COREAUDIO_LIB CoreAudio)
    find_library(AUDIOUNIT_LIB AudioUnit)
    find_library(AUDIOTOOLBOX_LIB AudioToolbox)
    target_link_libraries(miniaudio PUBLIC ${COREAUDIO_LIB} ${AUDIOUNIT_LIB} ${AUDIOTOOLBOX_LIB} pthread m)
else()
    target_link_libraries(miniaudio PUBLIC pthread m dl)
endif()

# RtMidi (WinMM on Windows, CoreMIDI on macOS, ALSA on Linux)
add_library(rtmidi STATIC
    ${SYNTHWAY_VENDOR_DIR}/rtmidi/RtMidi.cpp
    ${SYNTHWAY_VENDOR_DIR}/rtmidi/rtmidi_c.cpp
)
target_include_directories(rtmidi PUBLIC ${SYNTHWAY_VENDOR_DIR}/rtmidi)
set_target_properties(rtmidi PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_compile_options(rtmidi PRIVATE $<$<CXX_COMPILER_ID:GNU,Clang,AppleClang>:-w>)

if(WIN32)
    target_compile_definitions(rtmidi PRIVATE RTMIDI_API_WINMM)
    target_link_libraries(rtmidi PUBLIC winmm)
elseif(APPLE)
    find_library(COREMIDI_LIB CoreMIDI)
    find_library(COREFOUNDATION_LIB CoreFoundation)
    target_compile_definitions(rtmidi PRIVATE RTMIDI_API_CORE)
    target_link_libraries(rtmidi PUBLIC ${COREMIDI_LIB} ${COREAUDIO_LIB} ${COREFOUNDATION_LIB})
else()
    find_package(ALSA REQUIRED)
    target_compile_definitions(rtmidi PRIVATE RTMIDI_API_ALSA)
    target_link_libraries(rtmidi PUBLIC ALSA::ALSA pthread)
endif()

# libogg and libvorbis, for Ogg Vorbis files. src/io/xiph holds the
# ogg/config_types.h that libogg's configure would generate.
file(GLOB OGG_SOURCES ${SYNTHWAY_VENDOR_DIR}/libogg/src/*.c)
add_library(ogg STATIC ${OGG_SOURCES})
target_include_directories(ogg PUBLIC ${SYNTHWAY_VENDOR_DIR}/libogg/include ${SYNTHWAY_SRC_DIR}/io/xiph)
set_target_properties(ogg PROPERTIES POSITION_INDEPENDENT_CODE ON C_EXTENSIONS ON)
target_compile_options(ogg PRIVATE $<$<C_COMPILER_ID:GNU,Clang,AppleClang>:-w>)

file(GLOB VORBIS_SOURCES ${SYNTHWAY_VENDOR_DIR}/libvorbis/lib/*.c)
add_library(vorbis STATIC ${VORBIS_SOURCES})
target_include_directories(vorbis
    PUBLIC ${SYNTHWAY_VENDOR_DIR}/libvorbis/include
    PRIVATE ${SYNTHWAY_VENDOR_DIR}/libvorbis/lib
)
target_link_libraries(vorbis PUBLIC ogg)
if(UNIX)
    target_link_libraries(vorbis PUBLIC m)
endif()
set_target_properties(vorbis PROPERTIES POSITION_INDEPENDENT_CODE ON C_EXTENSIONS ON)
target_compile_options(vorbis PRIVATE $<$<C_COMPILER_ID:GNU,Clang,AppleClang>:-w>)

# ------------------------------------------------------------------------------
# Synthway library
# ------------------------------------------------------------------------------
# By layer, see README.md
set(SYNTHWAY_SOURCES
    ${SYNTHWAY_SRC_DIR}/synthway.c
    ${SYNTHWAY_SRC_DIR}/engine/engine.c
    ${SYNTHWAY_SRC_DIR}/engine/engine_params.c
    ${SYNTHWAY_SRC_DIR}/engine/engine_offline.c
    ${SYNTHWAY_SRC_DIR}/synth/synth.c
    ${SYNTHWAY_SRC_DIR}/synth/oscillator.c
    ${SYNTHWAY_SRC_DIR}/synth/envelope.c
    ${SYNTHWAY_SRC_DIR}/synth/reverb.c
      ${SYNTHWAY_SRC_DIR}/interpreter/interpreter.c
    ${SYNTHWAY_SRC_DIR}/analyzer/analyzer.c
    ${SYNTHWAY_SRC_DIR}/analysis/analysis.c
    ${SYNTHWAY_SRC_DIR}/analysis/notes.c
    ${SYNTHWAY_SRC_DIR}/analysis/waveform.c
    ${SYNTHWAY_SRC_DIR}/analysis/pitch.c
    ${SYNTHWAY_SRC_DIR}/analysis/spectrum.c
    ${SYNTHWAY_SRC_DIR}/analysis/fft.c
    ${SYNTHWAY_SRC_DIR}/io/audio_output.c
    ${SYNTHWAY_SRC_DIR}/io/audio_input.c
    ${SYNTHWAY_SRC_DIR}/io/audio_file.c
    ${SYNTHWAY_SRC_DIR}/io/wav_file.c
    ${SYNTHWAY_SRC_DIR}/io/audio_writer.c
    ${SYNTHWAY_SRC_DIR}/io/audio_devices.c
    ${SYNTHWAY_SRC_DIR}/io/midi_ports.c
)

# Shared / Static library target
add_library(synthway ${SYNTHWAY_SOURCES})

target_include_directories(synthway
    PUBLIC
        $<BUILD_INTERFACE:${SYNTHWAY_INCLUDE_DIR}>
        $<INSTALL_INTERFACE:include>
    PRIVATE
        ${SYNTHWAY_SRC_DIR}
)
target_link_libraries(synthway PRIVATE miniaudio rtmidi vorbis ogg)

# Internal sw_* functions stay private: only SYNTHWAY_API is exported
set_target_properties(synthway PROPERTIES C_VISIBILITY_PRESET hidden)

if(BUILD_SHARED_LIBS)
    target_compile_definitions(synthway
        PUBLIC SYNTHWAY_USE_SHARED
        PRIVATE SYNTHWAY_BUILD_SHARED
    )
endif()

if(WIN32)
    # synthway.dll (not libsynthway.dll), the name the Python bridge loads
    set_target_properties(synthway PROPERTIES PREFIX "")
endif()

if(MINGW AND BUILD_SHARED_LIBS)
    # GCC, C++ and winpthread runtimes inside the DLL, so that it loads from
    # Python without MSYS2 in PATH
    target_link_options(synthway PRIVATE -static)
endif()

# CLI Executable example
if(SYNTHWAY_BUILD_EXAMPLES)
    add_executable(synthway_cli examples/cli_main.c)
    target_link_libraries(synthway_cli PRIVATE synthway)

    if(WIN32)
        # Ensure DLL is in the same directory as the executable on Windows
        set_target_properties(synthway_cli PROPERTIES
            RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
        )
    endif()
endif()

# Offline render and analysis tests: no audio device, no sound
if(SYNTHWAY_BUILD_TESTS)
    enable_testing()
    add_executable(synthway_render_test tests/render_test.c)
    target_link_libraries(synthway_render_test PRIVATE synthway)
    if(UNIX)
        target_link_libraries(synthway_render_test PRIVATE m)
    endif()
    add_test(NAME offline_render COMMAND synthway_render_test ${CMAKE_BINARY_DIR}/render_test.wav)

    add_executable(synthway_analysis_test tests/analysis_test.c)
    target_link_libraries(synthway_analysis_test PRIVATE synthway)
    if(UNIX)
        target_link_libraries(synthway_analysis_test PRIVATE m)
    endif()
    add_test(NAME analysis COMMAND synthway_analysis_test ${CMAKE_BINARY_DIR}/analysis_test.wav)
endif()

# Installation rules
install(TARGETS synthway
    EXPORT synthway-targets
    LIBRARY DESTINATION lib
    ARCHIVE DESTINATION lib
    RUNTIME DESTINATION bin
)

install(DIRECTORY ${SYNTHWAY_INCLUDE_DIR}/
    DESTINATION include
)
