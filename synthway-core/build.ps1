# Helper build script for Windows PowerShell
# Usage: .\build.ps1 [-Clean] [-Test]
#   -Clean : rebuild everything, including the third-party libraries (miniaudio, RtMidi, libogg, libvorbis)
#   -Test  : then run the offline render and analysis tests (no audio device, no sound)
param([switch]$Clean, [switch]$Test)
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Add MSYS2 UCRT64 / MINGW64 to PATH if gcc is not yet found
if (-not (Get-Command "gcc" -ErrorAction SilentlyContinue)) {
    if (Test-Path "C:\msys64\ucrt64\bin") {
        $env:PATH = "C:\msys64\ucrt64\bin;" + $env:PATH
    } elseif (Test-Path "C:\msys64\mingw64\bin") {
        $env:PATH = "C:\msys64\mingw64\bin;" + $env:PATH
    }
}

# Locate C and C++ compilers (MSYS2 may only ship the cc / c++ names)
$cc = "gcc"
if (Get-Command "gcc" -ErrorAction SilentlyContinue) {
    $cc = "gcc"
} elseif (Get-Command "cc" -ErrorAction SilentlyContinue) {
    $cc = "cc"
} elseif (Test-Path "C:\msys64\ucrt64\bin\cc.exe") {
    $cc = "C:\msys64\ucrt64\bin\cc.exe"
}

$cxx = "g++"
if (Get-Command "g++" -ErrorAction SilentlyContinue) {
    $cxx = "g++"
} elseif (Get-Command "c++" -ErrorAction SilentlyContinue) {
    $cxx = "c++"
}

Write-Host "[*] Using C Compiler  : $cc"
Write-Host "[*] Using C++ Compiler: $cxx"

# Runs a native command and stops the build if it fails
# ($ErrorActionPreference does not apply to native commands)
function Invoke-Native {
    $exe = $args[0]
    # Always an array: splatting a single string would pass it character by character
    $rest = @($args | Select-Object -Skip 1)
    & $exe @rest
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $exe $rest"
    }
}

# True when $target is missing or older than any of $sources
function Test-Stale($target, $sources) {
    if (-not (Test-Path $target)) { return $true }
    $targetTime = (Get-Item $target).LastWriteTime
    foreach ($source in $sources) {
        if ((Get-Item $source).LastWriteTime -gt $targetTime) { return $true }
    }
    return $false
}

# Per-platform directories, so that a WSL build never reuses Windows objects
$objDir = "build/obj/windows"
$vendorDir = "build/vendor/windows"

if ($Clean) {
    Remove-Item -Recurse -Force $objDir, $vendorDir -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $objDir, $vendorDir, build/lib, build/bin -Force | Out-Null

# --------------------------------------------------------------------------
# Third-party libraries: built once, rebuilt only when their sources change
# --------------------------------------------------------------------------
$miniaudioLib = "$vendorDir/libminiaudio.a"
if (Test-Stale $miniaudioLib @("vendor/miniaudio/miniaudio.h", "src/io/miniaudio_impl.c", "src/io/miniaudio_config.h")) {
    Write-Host "[*] Building libminiaudio.a..."
    Invoke-Native $cc -O2 -w -std=c11 -Ivendor/miniaudio -c src/io/miniaudio_impl.c -o "$vendorDir/miniaudio_impl.o"
    Remove-Item $miniaudioLib -ErrorAction SilentlyContinue
    Invoke-Native ar rcs $miniaudioLib "$vendorDir/miniaudio_impl.o"
} else {
    Write-Host "[=] libminiaudio.a is up to date"
}

$rtmidiLib = "$vendorDir/librtmidi.a"
if (Test-Stale $rtmidiLib @("vendor/rtmidi/RtMidi.cpp", "vendor/rtmidi/RtMidi.h", "vendor/rtmidi/rtmidi_c.cpp", "vendor/rtmidi/rtmidi_c.h")) {
    Write-Host "[*] Building librtmidi.a (WinMM backend)..."
    Invoke-Native $cxx -O2 -w -std=c++17 -DRTMIDI_API_WINMM -Ivendor/rtmidi -c vendor/rtmidi/RtMidi.cpp -o "$vendorDir/RtMidi.o"
    Invoke-Native $cxx -O2 -w -std=c++17 -DRTMIDI_API_WINMM -Ivendor/rtmidi -c vendor/rtmidi/rtmidi_c.cpp -o "$vendorDir/rtmidi_c.o"
    Remove-Item $rtmidiLib -ErrorAction SilentlyContinue
    Invoke-Native ar rcs $rtmidiLib "$vendorDir/RtMidi.o" "$vendorDir/rtmidi_c.o"
} else {
    Write-Host "[=] librtmidi.a is up to date"
}

# libogg and libvorbis, for Ogg Vorbis files. src/io/xiph holds the
# ogg/config_types.h that libogg's configure would generate.
$xiphIncludes = @("-Ivendor/libogg/include", "-Isrc/io/xiph", "-Ivendor/libvorbis/include")
$xiphConfig = "src/io/xiph/ogg/config_types.h"

$oggLib = "$vendorDir/libogg.a"
$oggFiles = @(Get-ChildItem -Recurse -File vendor/libogg | ForEach-Object { $_.FullName }) + $xiphConfig
if (Test-Stale $oggLib $oggFiles) {
    Write-Host "[*] Building libogg.a..."
    New-Item -ItemType Directory -Path "$vendorDir/libogg" -Force | Out-Null
    $oggObjects = @()
    foreach ($source in Get-ChildItem vendor/libogg/src -Filter *.c) {
        $object = "$vendorDir/libogg/$($source.BaseName).o"
        Invoke-Native $cc -O2 -w -std=gnu11 @xiphIncludes -c $source.FullName -o $object
        $oggObjects += $object
    }
    Remove-Item $oggLib -ErrorAction SilentlyContinue
    Invoke-Native ar rcs $oggLib @oggObjects
} else {
    Write-Host "[=] libogg.a is up to date"
}

$vorbisLib = "$vendorDir/libvorbis.a"
$vorbisFiles = @(Get-ChildItem -Recurse -File vendor/libvorbis, vendor/libogg/include | ForEach-Object { $_.FullName }) + $xiphConfig
if (Test-Stale $vorbisLib $vorbisFiles) {
    Write-Host "[*] Building libvorbis.a (with the encoder)..."
    New-Item -ItemType Directory -Path "$vendorDir/libvorbis" -Force | Out-Null
    $vorbisObjects = @()
    foreach ($source in Get-ChildItem vendor/libvorbis/lib -Filter *.c) {
        $object = "$vendorDir/libvorbis/$($source.BaseName).o"
        Invoke-Native $cc -O2 -w -std=gnu11 @xiphIncludes -Ivendor/libvorbis/lib -c $source.FullName -o $object
        $vorbisObjects += $object
    }
    Remove-Item $vorbisLib -ErrorAction SilentlyContinue
    Invoke-Native ar rcs $vorbisLib @vorbisObjects
} else {
    Write-Host "[=] libvorbis.a is up to date"
}

# --------------------------------------------------------------------------
# Synthway library
# --------------------------------------------------------------------------
# Library sources, relative to src/ and by layer (see README.md); objects mirror this tree in $objDir
$sources = @(
    "synthway",
    "engine/engine", "engine/engine_params", "engine/engine_offline",
    "synth/synth", "synth/oscillator", "synth/envelope", "synth/reverb", "interpreter/interpreter",
    "analyzer/analyzer",
    "analysis/analysis", "analysis/notes", "analysis/waveform", "analysis/pitch", "analysis/spectrum", "analysis/fft",
    "io/audio_output", "io/audio_input", "io/audio_file", "io/wav_file", "io/audio_writer", "io/audio_devices", "io/midi_ports"
)
foreach ($name in $sources) {
    Write-Host "[*] Compiling src/$name.c..."
    New-Item -ItemType Directory -Path (Split-Path "$objDir/$name.o") -Force | Out-Null
    Invoke-Native $cc -O2 -Wall -std=c11 -DSYNTHWAY_BUILD_SHARED -Iinclude -Isrc -Ivendor/miniaudio -Ivendor/rtmidi @xiphIncludes -c "src/$name.c" -o "$objDir/$name.o"
}
$objects = $sources | ForEach-Object { "$objDir/$_.o" }

# Linked with the C++ driver because RtMidi is C++. -static pulls the GCC,
# C++ and winpthread runtimes into the DLL, so that it loads from Python
# without MSYS2 in PATH (only Windows system DLLs remain).
# -fno-use-linker-plugin works around the incomplete MSYS2 GCC install
# (liblto_plugin.dll missing); harmless once GCC is repaired.
Write-Host "[*] Linking synthway.dll..."
Invoke-Native $cxx -fno-use-linker-plugin -shared -static -o build/lib/synthway.dll @objects $rtmidiLib $miniaudioLib $vorbisLib $oggLib "-Wl,--out-implib,build/lib/libsynthway.a" -lwinmm -lole32 -lm

Write-Host "[*] Compiling CLI example..."
Invoke-Native $cc -O2 -Wall -std=c11 -DSYNTHWAY_USE_SHARED -Iinclude -c examples/cli_main.c -o "$objDir/cli_main.o"
Invoke-Native $cc -fno-use-linker-plugin -o build/bin/synthway_cli.exe "$objDir/cli_main.o" -Lbuild/lib -lsynthway -lole32 -lwinmm -lm

Write-Host "[*] Compiling render test..."
Invoke-Native $cc -O2 -Wall -std=c11 -DSYNTHWAY_USE_SHARED -Iinclude -c tests/render_test.c -o "$objDir/render_test.o"
Invoke-Native $cc -fno-use-linker-plugin -o build/bin/synthway_render_test.exe "$objDir/render_test.o" -Lbuild/lib -lsynthway -lm

Write-Host "[*] Compiling analysis test..."
Invoke-Native $cc -O2 -Wall -std=c11 -DSYNTHWAY_USE_SHARED -Iinclude -c tests/analysis_test.c -o "$objDir/analysis_test.o"
Invoke-Native $cc -fno-use-linker-plugin -o build/bin/synthway_analysis_test.exe "$objDir/analysis_test.o" -Lbuild/lib -lsynthway -lm

Copy-Item build/lib/synthway.dll build/bin/ -Force

Write-Host "[+] Build complete!"
Write-Host "    Library: build\lib\synthway.dll"
Write-Host "    CLI    : build\bin\synthway_cli.exe"
Write-Host "    Tests  : build\bin\synthway_render_test.exe, build\bin\synthway_analysis_test.exe"

if ($Test) {
    Write-Host "[*] Running offline render test..."
    Invoke-Native build/bin/synthway_render_test.exe build/render_test.wav
    Write-Host "[*] Running analysis test..."
    Invoke-Native build/bin/synthway_analysis_test.exe build/analysis_test.wav
}
