"""
ctypes bridge for synthway-core native shared library.
Portable across Windows (.dll) and Linux (.so).
"""

import ctypes
import math
import os
import sys
import threading
from typing import List, Optional, Sequence, Tuple

try:
    from models import (
        ANALYSIS_SPECTRUM_POINTS, MAX_PARTIALS, Analysis, AnalysisPartial, ClipTrack, DeviceInfo, DeviceTypeEnum,
        Envelope, MidiPortInfo, MidiPortTypeEnum, Timbre, WaveformEnum,
    )
except ImportError:
    from .models import (
        ANALYSIS_SPECTRUM_POINTS, MAX_PARTIALS, Analysis, AnalysisPartial, ClipTrack, DeviceInfo, DeviceTypeEnum,
        Envelope, MidiPortInfo, MidiPortTypeEnum, Timbre, WaveformEnum,
    )

# synthway_result_t codes the server tells apart
RESULT_INVALID_PARAM = -2
RESULT_IO_ERROR = -8
RESULT_FORMAT_ERROR = -9

# SYNTHWAY_ANALYZER_NOISE_GATE_OFF: the noise gate ignores nothing
NOISE_GATE_OFF = -120.0


class CoreError(RuntimeError):
    """A call refused by synthway-core; code is its synthway_result_t."""

    def __init__(self, message: str, code: int):
        super().__init__(message)
        self.code = code


class SynthwayDeviceInfoC(ctypes.Structure):
    _fields_ = [
        ("name", ctypes.c_char * 256),
        ("id", ctypes.c_char * 256),
        ("is_default", ctypes.c_bool),
        ("sample_rate", ctypes.c_uint32),
        ("channels", ctypes.c_uint32),
        ("type", ctypes.c_int),
    ]


class SynthwayEngineConfigC(ctypes.Structure):
    _fields_ = [
        ("sample_rate", ctypes.c_uint32),
        ("channels", ctypes.c_uint32),
        ("playback_device_index", ctypes.c_int),
    ]


class SynthwayMidiPortInfoC(ctypes.Structure):
    _fields_ = [
        ("name", ctypes.c_char * 256),
        ("type", ctypes.c_int),
    ]


class SynthwayEnvelopeC(ctypes.Structure):
    _fields_ = [
        ("attack_s", ctypes.c_float),
        ("decay_s", ctypes.c_float),
        ("sustain_level", ctypes.c_float),
        ("release_s", ctypes.c_float),
    ]


class SynthwayPartialC(ctypes.Structure):
    _fields_ = [
        ("ratio", ctypes.c_float),
        ("amplitude", ctypes.c_float),
        ("waveform", ctypes.c_int),
        ("envelope", SynthwayEnvelopeC),
    ]


class SynthwayTimbreC(ctypes.Structure):
    _fields_ = [
        ("partial_count", ctypes.c_uint32),
        ("partials", SynthwayPartialC * MAX_PARTIALS),
    ]


def _timbre_to_c(timbre: Timbre) -> SynthwayTimbreC:
    if len(timbre.partials) > MAX_PARTIALS:
        raise RuntimeError(f"A timbre holds at most {MAX_PARTIALS} partials, not {len(timbre.partials)}")
    c_timbre = SynthwayTimbreC(partial_count=len(timbre.partials))
    for i, partial in enumerate(timbre.partials):
        envelope = partial.envelope
        c_timbre.partials[i] = SynthwayPartialC(
            ratio=partial.ratio,
            amplitude=partial.amplitude,
            waveform=int(partial.waveform),
            envelope=SynthwayEnvelopeC(envelope.attack, envelope.decay, envelope.sustain, envelope.release),
        )
    return c_timbre


class SynthwayAnalysisPartialC(ctypes.Structure):
    _fields_ = [
        ("frequency_hz", ctypes.c_float),
        ("ratio", ctypes.c_float),
        ("amplitude", ctypes.c_float),
    ]


class SynthwayAnalysisC(ctypes.Structure):
    _fields_ = [
        ("sample_rate", ctypes.c_uint32),
        ("frequency_hz", ctypes.c_float),
        ("clarity", ctypes.c_float),
        ("level_db", ctypes.c_float),
        ("partial_count", ctypes.c_uint32),
        ("partials", SynthwayAnalysisPartialC * MAX_PARTIALS),
        ("spectrum_min_hz", ctypes.c_float),
        ("spectrum_max_hz", ctypes.c_float),
        ("spectrum_db", ctypes.c_float * ANALYSIS_SPECTRUM_POINTS),
    ]


def _number(value: float, digits: int, fallback: float = 0.0) -> float:
    """Rounded value, fallback for NaN or infinity: they would make JSON that browsers refuse."""
    return round(value, digits) if math.isfinite(value) else fallback


def _analysis_from_c(c_analysis: SynthwayAnalysisC) -> Analysis:
    # Rounded: the JSON sent several times a second stays small, well below what the ear tells apart
    return Analysis(
        sample_rate=c_analysis.sample_rate,
        frequency=_number(c_analysis.frequency_hz, 4),
        clarity=_number(c_analysis.clarity, 4),
        level_db=_number(c_analysis.level_db, 2, -120.0),
        partials=[
            AnalysisPartial(
                frequency=_number(p.frequency_hz, 3), ratio=_number(p.ratio, 4), amplitude=_number(p.amplitude, 4)
            )
            for p in c_analysis.partials[: c_analysis.partial_count]
        ],
        spectrum_min_hz=c_analysis.spectrum_min_hz,
        spectrum_max_hz=c_analysis.spectrum_max_hz,
        spectrum_db=[_number(v, 1, -120.0) for v in c_analysis.spectrum_db],
    )


def _check_result(lib, res: int, action: str):
    if res != 0:
        message = lib.synthway_result_to_string(res).decode("utf-8", errors="replace")
        raise CoreError(f"{action} failed: {message} ({res})", res)


class Analyzer:
    """A synthway_analyzer_t: the note and the partials of a microphone, an
    audio file or samples. It neither plays nor records anything.
    The native analyzer is not thread-safe: every call here holds a lock."""

    def __init__(self, lib):
        self._lib = lib
        self._lock = threading.Lock()
        self._handle = lib.synthway_analyzer_create()
        if not self._handle:
            raise RuntimeError("Failed to allocate a sound analyzer")

    def close(self):
        """Closes the microphone and frees the analyzer."""
        with self._lock:
            if self._handle:
                self._lib.synthway_analyzer_destroy(self._handle)
                self._handle = None

    def _analysis(self, call, *args) -> Analysis:
        c_analysis = SynthwayAnalysisC()
        _check_result(self._lib, call(self._handle, *args, ctypes.byref(c_analysis)), "Analysis")
        return _analysis_from_c(c_analysis)

    def analyze_samples(self, samples: Sequence[float], sample_rate: int) -> Analysis:
        """Analyzes mono samples around their middle (a window of about 170 ms)."""
        buffer = (ctypes.c_float * len(samples))(*samples)
        with self._lock:
            return self._analysis(self._lib.synthway_analyzer_analyze_samples, buffer, len(samples), sample_rate)

    # ---------- Microphone: listened to, never saved ----------

    def open_input(self, device_index: int = -1, sample_rate: int = 0) -> Tuple[int, bool]:
        """Opens a capture device (-1: the system's) and starts listening.
        Returns its sample rate, and whether it is in exclusive mode (without the
        system's audio effects) rather than shared."""
        with self._lock:
            _check_result(
                self._lib, self._lib.synthway_analyzer_open_input(self._handle, device_index, sample_rate),
                "Opening the microphone",
            )
            return (
                int(self._lib.synthway_analyzer_get_input_sample_rate(self._handle)),
                bool(self._lib.synthway_analyzer_is_input_exclusive(self._handle)),
            )

    def close_input(self):
        with self._lock:
            self._lib.synthway_analyzer_close_input(self._handle)

    def is_input_open(self) -> bool:
        with self._lock:
            return bool(self._lib.synthway_analyzer_is_input_open(self._handle))

    def analyze_input(self) -> Analysis:
        """What the microphone heard last."""
        with self._lock:
            return self._analysis(self._lib.synthway_analyzer_analyze_input)

    # ---------- Noise gate ----------

    def set_noise_gate(self, threshold_db: float):
        """Peaks below threshold_db (dBFS) are ignored: no partial, and no note
        without a partial. NOISE_GATE_OFF (-120) ignores nothing."""
        with self._lock:
            _check_result(
                self._lib, self._lib.synthway_analyzer_set_noise_gate(self._handle, threshold_db),
                "Setting the noise gate",
            )

    def get_noise_gate(self) -> float:
        with self._lock:
            return float(self._lib.synthway_analyzer_get_noise_gate(self._handle))

    # ---------- Audio file (clip) ----------

    def load_clip(self, path: str):
        """Loads a WAV, FLAC or MP3 file from disk."""
        # The core opens the file with fopen(): ANSI code page on Windows, UTF-8 elsewhere
        native_path = os.fspath(path).encode("mbcs" if sys.platform.startswith("win") else "utf-8")
        with self._lock:
            _check_result(self._lib, self._lib.synthway_analyzer_load_clip(self._handle, native_path), "Loading the file")

    def load_clip_bytes(self, data: bytes):
        """Loads a WAV, FLAC or MP3 file held in memory, decoded at once."""
        with self._lock:
            _check_result(
                self._lib, self._lib.synthway_analyzer_load_clip_memory(self._handle, data, len(data)),
                "Loading the file",
            )

    def clip_info(self) -> Tuple[int, int]:
        """(frame count, sample rate) of the loaded file, (0, 0) without one."""
        frames, rate = ctypes.c_uint64(0), ctypes.c_uint32(0)
        with self._lock:
            self._lib.synthway_analyzer_get_clip_info(self._handle, ctypes.byref(frames), ctypes.byref(rate))
        return frames.value, rate.value

    def analyze_clip(self, time_s: float, noise_gate_db: Optional[float] = None) -> Analysis:
        """The loaded file around time_s, with this noise gate (None: the one in place)."""
        with self._lock:
            if noise_gate_db is not None:
                _check_result(
                    self._lib, self._lib.synthway_analyzer_set_noise_gate(self._handle, noise_gate_db),
                    "Setting the noise gate",
                )
            return self._analysis(self._lib.synthway_analyzer_analyze_clip, ctypes.c_double(time_s))

    def clip_overview(self, count: int) -> List[float]:
        """Peak of each of count equal parts of the file, for the waveform."""
        peaks = (ctypes.c_float * count)()
        with self._lock:
            _check_result(self._lib, self._lib.synthway_analyzer_get_clip_overview(self._handle, peaks, count), "Overview")
        return [round(v, 4) for v in peaks]

    def clip_track(self, count: int) -> ClipTrack:
        """The note at count moments evenly spread along the file."""
        frequency, clarity, level = (ctypes.c_float * count)(), (ctypes.c_float * count)(), (ctypes.c_float * count)()
        with self._lock:
            _check_result(
                self._lib, self._lib.synthway_analyzer_get_clip_track(self._handle, count, frequency, clarity, level),
                "Note track",
            )
        return ClipTrack(
            frequency=[round(v, 3) for v in frequency],
            clarity=[round(v, 3) for v in clarity],
            level_db=[round(v, 1) for v in level],
        )


def _find_library() -> str:
    """Dynamically finds the compiled synthway shared library relative to project structure."""
    # Explicit path, needed once the server is installed as a package
    explicit = os.environ.get("SYNTHWAY_CORE_LIB")
    if explicit:
        return explicit

    lib_name = "synthway.dll" if sys.platform.startswith("win") else "libsynthway.so"
    if sys.platform == "darwin":
        lib_name = "libsynthway.dylib"

    base_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        # From synthway-server/src/
        os.path.abspath(os.path.join(base_dir, "..", "..", "synthway-core", "build", "lib", lib_name)),
        os.path.abspath(os.path.join(base_dir, "..", "..", "synthway-core", "build", "bin", lib_name)),
        # From synthway-server/
        os.path.abspath(os.path.join(base_dir, "..", "synthway-core", "build", "lib", lib_name)),
        os.path.abspath(os.path.join(base_dir, "..", "synthway-core", "build", "bin", lib_name)),
        os.path.abspath(os.path.join(base_dir, "lib", lib_name)),
        lib_name,
    ]

    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate

    return lib_name


class SynthwayCore:
    """High-level Python wrapper around the native Synthway Core audio engine."""

    # The live engine is recreated at each start: the envelope and the timbre
    # are kept here and applied to every new engine
    _envelope = Envelope()
    _timbre: Optional[Timbre] = None  # None: the single oscillator plays

    def __init__(self, lib_path: Optional[str] = None):
        self.lib_path = lib_path or _find_library()
        self._lib = None
        self._engine = None
        self._load_library()

    def _load_library(self):
        try:
            self._lib = ctypes.CDLL(self.lib_path)
        except OSError as e:
            raise RuntimeError(
                f"Failed to load Synthway Core native library from '{self.lib_path}'. "
                f"Did you build synthway-core first? Error: {e}"
            ) from e

        # Function signatures
        self._lib.synthway_get_version.restype = ctypes.c_char_p

        self._lib.synthway_get_device_count.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint32)]
        self._lib.synthway_get_device_count.restype = ctypes.c_int

        self._lib.synthway_get_device_info.argtypes = [
            ctypes.c_int,
            ctypes.c_uint32,
            ctypes.POINTER(SynthwayDeviceInfoC),
        ]
        self._lib.synthway_get_device_info.restype = ctypes.c_int

        self._lib.synthway_get_midi_port_count.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint32)]
        self._lib.synthway_get_midi_port_count.restype = ctypes.c_int

        self._lib.synthway_get_midi_port_info.argtypes = [
            ctypes.c_int,
            ctypes.c_uint32,
            ctypes.POINTER(SynthwayMidiPortInfoC),
        ]
        self._lib.synthway_get_midi_port_info.restype = ctypes.c_int

        self._lib.synthway_engine_create.restype = ctypes.c_void_p

        self._lib.synthway_engine_init.argtypes = [ctypes.c_void_p, ctypes.POINTER(SynthwayEngineConfigC)]
        self._lib.synthway_engine_init.restype = ctypes.c_int

        self._lib.synthway_engine_start.argtypes = [ctypes.c_void_p]
        self._lib.synthway_engine_start.restype = ctypes.c_int

        self._lib.synthway_engine_stop.argtypes = [ctypes.c_void_p]
        self._lib.synthway_engine_stop.restype = ctypes.c_int

        self._lib.synthway_engine_destroy.argtypes = [ctypes.c_void_p]
        self._lib.synthway_engine_destroy.restype = None

        self._lib.synthway_engine_init_offline.argtypes = [ctypes.c_void_p, ctypes.POINTER(SynthwayEngineConfigC)]
        self._lib.synthway_engine_init_offline.restype = ctypes.c_int

        self._lib.synthway_engine_render.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
        self._lib.synthway_engine_render.restype = ctypes.c_int

        self._lib.synthway_engine_render_to_wav.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
        self._lib.synthway_engine_render_to_wav.restype = ctypes.c_int

        self._lib.synthway_engine_get_sample_rate.argtypes = [ctypes.c_void_p]
        self._lib.synthway_engine_get_sample_rate.restype = ctypes.c_uint32

        self._lib.synthway_engine_get_channels.argtypes = [ctypes.c_void_p]
        self._lib.synthway_engine_get_channels.restype = ctypes.c_uint32

        self._lib.synthway_result_to_string.argtypes = [ctypes.c_int]
        self._lib.synthway_result_to_string.restype = ctypes.c_char_p

        self._lib.synthway_engine_set_envelope.argtypes = [ctypes.c_void_p] + [ctypes.c_float] * 4
        self._lib.synthway_engine_set_envelope.restype = ctypes.c_int

        self._lib.synthway_engine_get_envelope.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(ctypes.c_float)] * 4
        self._lib.synthway_engine_get_envelope.restype = ctypes.c_int

        self._lib.synthway_engine_set_frequency.argtypes = [ctypes.c_void_p, ctypes.c_float]
        self._lib.synthway_engine_set_frequency.restype = ctypes.c_int

        self._lib.synthway_engine_get_frequency.argtypes = [ctypes.c_void_p]
        self._lib.synthway_engine_get_frequency.restype = ctypes.c_float

        self._lib.synthway_engine_set_volume.argtypes = [ctypes.c_void_p, ctypes.c_float]
        self._lib.synthway_engine_set_volume.restype = ctypes.c_int

        self._lib.synthway_engine_get_volume.argtypes = [ctypes.c_void_p]
        self._lib.synthway_engine_get_volume.restype = ctypes.c_float

        self._lib.synthway_engine_set_waveform.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self._lib.synthway_engine_set_waveform.restype = ctypes.c_int

        self._lib.synthway_engine_get_waveform.argtypes = [ctypes.c_void_p]
        self._lib.synthway_engine_get_waveform.restype = ctypes.c_int

        self._lib.synthway_engine_set_tone_enabled.argtypes = [ctypes.c_void_p, ctypes.c_bool]
        self._lib.synthway_engine_set_tone_enabled.restype = ctypes.c_int

        self._lib.synthway_engine_is_tone_enabled.argtypes = [ctypes.c_void_p]
        self._lib.synthway_engine_is_tone_enabled.restype = ctypes.c_bool

        self._lib.synthway_engine_is_running.argtypes = [ctypes.c_void_p]
        self._lib.synthway_engine_is_running.restype = ctypes.c_bool

        self._lib.synthway_engine_set_timbre.argtypes = [ctypes.c_void_p, ctypes.POINTER(SynthwayTimbreC)]
        self._lib.synthway_engine_set_timbre.restype = ctypes.c_int

        self._lib.synthway_get_max_partials.argtypes = []
        self._lib.synthway_get_max_partials.restype = ctypes.c_uint32

        # SynthwayTimbreC mirrors the header: a core built with another limit
        # would read the structure at the wrong offsets
        core_max = self._lib.synthway_get_max_partials()
        if core_max != MAX_PARTIALS:
            raise RuntimeError(
                f"synthway-core holds {core_max} partials per timbre, this server expects {MAX_PARTIALS}: "
                "update MAX_PARTIALS in models.py"
            )

        # Sound analyzer
        analyzer = ctypes.c_void_p
        analysis = ctypes.POINTER(SynthwayAnalysisC)
        floats = ctypes.POINTER(ctypes.c_float)
        signatures = {
            "synthway_analyzer_create": ([], analyzer),
            "synthway_analyzer_destroy": ([analyzer], None),
            "synthway_analysis_get_size": ([], ctypes.c_uint32),
            "synthway_analyzer_analyze_samples": ([analyzer, floats, ctypes.c_uint32, ctypes.c_uint32, analysis], ctypes.c_int),
            "synthway_analyzer_open_input": ([analyzer, ctypes.c_int, ctypes.c_uint32], ctypes.c_int),
            "synthway_analyzer_close_input": ([analyzer], None),
            "synthway_analyzer_is_input_open": ([analyzer], ctypes.c_bool),
            "synthway_analyzer_is_input_exclusive": ([analyzer], ctypes.c_bool),
            "synthway_analyzer_get_input_sample_rate": ([analyzer], ctypes.c_uint32),
            "synthway_analyzer_set_noise_gate": ([analyzer, ctypes.c_float], ctypes.c_int),
            "synthway_analyzer_get_noise_gate": ([analyzer], ctypes.c_float),
            "synthway_analyzer_analyze_input": ([analyzer, analysis], ctypes.c_int),
            "synthway_analyzer_load_clip": ([analyzer, ctypes.c_char_p], ctypes.c_int),
            "synthway_analyzer_load_clip_memory": ([analyzer, ctypes.c_char_p, ctypes.c_size_t], ctypes.c_int),
            "synthway_analyzer_get_clip_info": (
                [analyzer, ctypes.POINTER(ctypes.c_uint64), ctypes.POINTER(ctypes.c_uint32)], ctypes.c_int,
            ),
            "synthway_analyzer_analyze_clip": ([analyzer, ctypes.c_double, analysis], ctypes.c_int),
            "synthway_analyzer_get_clip_overview": ([analyzer, floats, ctypes.c_uint32], ctypes.c_int),
            "synthway_analyzer_get_clip_track": ([analyzer, ctypes.c_uint32, floats, floats, floats], ctypes.c_int),
        }
        for name, (argtypes, restype) in signatures.items():
            function = getattr(self._lib, name)
            function.argtypes = argtypes
            function.restype = restype

        # SynthwayAnalysisC mirrors the header, like SynthwayTimbreC
        core_size = self._lib.synthway_analysis_get_size()
        if core_size != ctypes.sizeof(SynthwayAnalysisC):
            raise RuntimeError(
                f"synthway-core's analysis structure is {core_size} bytes, this server expects "
                f"{ctypes.sizeof(SynthwayAnalysisC)}: update ANALYSIS_SPECTRUM_POINTS in models.py"
            )

    def create_analyzer(self) -> Analyzer:
        """A new sound analyzer, independent of the engine. Close it when done."""
        return Analyzer(self._lib)

    def get_version(self) -> str:
        ver = self._lib.synthway_get_version()
        return ver.decode("utf-8") if ver else "unknown"

    def list_devices(self, device_type: DeviceTypeEnum) -> List[DeviceInfo]:
        count = ctypes.c_uint32(0)
        res = self._lib.synthway_get_device_count(int(device_type), ctypes.byref(count))
        if res != 0:
            return []

        devices: List[DeviceInfo] = []
        for i in range(count.value):
            c_info = SynthwayDeviceInfoC()
            if self._lib.synthway_get_device_info(int(device_type), i, ctypes.byref(c_info)) == 0:
                devices.append(
                    DeviceInfo(
                        index=i,
                        name=c_info.name.decode("utf-8", errors="replace"),
                        id=c_info.id.decode("utf-8", errors="replace"),
                        is_default=bool(c_info.is_default),
                        sample_rate=c_info.sample_rate,
                        channels=c_info.channels,
                        type="playback" if device_type == DeviceTypeEnum.PLAYBACK else "capture",
                    )
                )
        return devices

    def list_midi_ports(self, port_type: MidiPortTypeEnum) -> List[MidiPortInfo]:
        count = ctypes.c_uint32(0)
        res = self._lib.synthway_get_midi_port_count(int(port_type), ctypes.byref(count))
        if res != 0:
            return []

        ports: List[MidiPortInfo] = []
        for i in range(count.value):
            c_info = SynthwayMidiPortInfoC()
            if self._lib.synthway_get_midi_port_info(int(port_type), i, ctypes.byref(c_info)) == 0:
                ports.append(
                    MidiPortInfo(
                        index=i,
                        name=c_info.name.decode("utf-8", errors="replace"),
                        type="input" if port_type == MidiPortTypeEnum.INPUT else "output",
                    )
                )
        return ports

    def start_engine(self, sample_rate: int = 48000, channels: int = 2, device_index: int = -1) -> bool:
        if self._engine is not None:
            self.stop_engine()

        self._engine = self._lib.synthway_engine_create()
        if not self._engine:
            raise RuntimeError("Failed to allocate audio engine instance")

        config = SynthwayEngineConfigC(
            sample_rate=sample_rate,
            channels=channels,
            playback_device_index=device_index,
        )

        res = self._lib.synthway_engine_init(self._engine, ctypes.byref(config))
        if res != 0:
            self._lib.synthway_engine_destroy(self._engine)
            self._engine = None
            raise RuntimeError(f"Engine initialization failed with code {res}")

        # A new engine has its tone enabled (440 Hz): start it silent, sound is
        # then switched on explicitly (note_on, set_tone_enabled).
        self._lib.synthway_engine_set_tone_enabled(self._engine, False)
        self._apply_envelope(self._engine, self._envelope)
        if self._timbre is not None:
            self._apply_timbre(self._engine, self._timbre)

        start_res = self._lib.synthway_engine_start(self._engine)
        if start_res != 0:
            self._lib.synthway_engine_destroy(self._engine)
            self._engine = None
            return False
        return True

    def stop_engine(self):
        if self._engine:
            self._lib.synthway_engine_stop(self._engine)
            self._lib.synthway_engine_destroy(self._engine)
            self._engine = None

    # ---------- Envelope ----------

    def _apply_envelope(self, engine, envelope: Envelope):
        res = self._lib.synthway_engine_set_envelope(
            engine, envelope.attack, envelope.decay, envelope.sustain, envelope.release
        )
        self._check(res, "Setting the envelope")

    def set_envelope(self, envelope: Envelope):
        """ADSR envelope of every note, kept across engine restarts."""
        if self._engine:
            self._apply_envelope(self._engine, envelope)
        self._envelope = envelope

    def get_envelope(self) -> Envelope:
        return self._envelope

    # ---------- Timbre (additive synthesis) ----------

    def _apply_timbre(self, engine, timbre: Optional[Timbre]):
        c_timbre = None if timbre is None else ctypes.byref(_timbre_to_c(timbre))
        self._check(self._lib.synthway_engine_set_timbre(engine, c_timbre), "Setting the timbre")

    def set_timbre(self, timbre: Optional[Timbre]):
        """Partials that play every note (None: back to the single oscillator), kept across engine restarts."""
        if self._engine:
            self._apply_timbre(self._engine, timbre)
        self._timbre = timbre

    def get_timbre(self) -> Optional[Timbre]:
        return self._timbre

    def get_max_partials(self) -> int:
        """Most partials a timbre can hold, checked against the core when the library is loaded."""
        return MAX_PARTIALS

    def get_sample_rate(self) -> Optional[int]:
        """Sample rate of the running engine, None without one."""
        if self._engine:
            return int(self._lib.synthway_engine_get_sample_rate(self._engine))
        return None

    # ---------- Offline rendering: no audio device, nothing is played ----------

    def _offline_engine(
        self,
        frequency: float,
        waveform: WaveformEnum,
        volume: float,
        sample_rate: int,
        channels: int,
        envelope: Optional[Envelope] = None,
        timbre: Optional[Timbre] = None,
    ):
        """Separate engine for offline rendering; the live engine is left untouched."""
        engine = self._lib.synthway_engine_create()
        if not engine:
            raise RuntimeError("Failed to allocate audio engine instance")
        config = SynthwayEngineConfigC(sample_rate=sample_rate, channels=channels, playback_device_index=-1)
        res = self._lib.synthway_engine_init_offline(engine, ctypes.byref(config))
        if res != 0:
            self._lib.synthway_engine_destroy(engine)
            raise RuntimeError(f"Offline engine initialization failed with code {res}")
        self._lib.synthway_engine_set_waveform(engine, int(waveform))
        self._lib.synthway_engine_set_frequency(engine, ctypes.c_float(frequency))
        self._lib.synthway_engine_set_volume(engine, ctypes.c_float(volume))
        try:
            if envelope is not None:
                self._apply_envelope(engine, envelope)
            if timbre is not None:
                self._apply_timbre(engine, timbre)
        except RuntimeError:
            self._lib.synthway_engine_destroy(engine)
            raise
        self._lib.synthway_engine_set_tone_enabled(engine, True)
        return engine

    def _check(self, res: int, action: str):
        if res != 0:
            message = self._lib.synthway_result_to_string(res).decode("utf-8", errors="replace")
            raise RuntimeError(f"{action} failed: {message} ({res})")

    def render(
        self,
        frequency: float,
        seconds: float,
        waveform: WaveformEnum = WaveformEnum.SINE,
        volume: float = 0.5,
        sample_rate: int = 48000,
        channels: int = 1,
        envelope: Optional[Envelope] = None,
        timbre: Optional[Timbre] = None,
    ) -> List[float]:
        """Renders a tone into memory (interleaved samples in [-1, 1]) without any audio device.
        With a timbre, its partials play instead of the waveform and envelope."""
        engine = self._offline_engine(frequency, waveform, volume, sample_rate, channels, envelope, timbre)
        try:
            frames = int(seconds * sample_rate)
            buffer = (ctypes.c_float * (frames * channels))()
            self._check(self._lib.synthway_engine_render(engine, buffer, frames), "Offline rendering")
            return list(buffer)
        finally:
            self._lib.synthway_engine_destroy(engine)

    def render_to_wav(
        self,
        path: str,
        frequency: float,
        seconds: float,
        waveform: WaveformEnum = WaveformEnum.SINE,
        volume: float = 0.5,
        sample_rate: int = 48000,
        channels: int = 2,
        envelope: Optional[Envelope] = None,
        timbre: Optional[Timbre] = None,
    ) -> None:
        """Renders a tone into a 16-bit PCM WAV file without any audio device."""
        # The core opens the file with fopen(): ANSI code page on Windows, UTF-8 elsewhere
        native_path = os.fspath(path).encode("mbcs" if sys.platform.startswith("win") else "utf-8")
        engine = self._offline_engine(frequency, waveform, volume, sample_rate, channels, envelope, timbre)
        try:
            frames = int(seconds * sample_rate)
            self._check(self._lib.synthway_engine_render_to_wav(engine, native_path, frames), "WAV rendering")
        finally:
            self._lib.synthway_engine_destroy(engine)

    def set_frequency(self, freq: float):
        if self._engine:
            self._lib.synthway_engine_set_frequency(self._engine, ctypes.c_float(freq))

    def get_frequency(self) -> float:
        if self._engine:
            return float(self._lib.synthway_engine_get_frequency(self._engine))
        return 0.0

    def set_volume(self, vol: float):
        if self._engine:
            self._lib.synthway_engine_set_volume(self._engine, ctypes.c_float(vol))

    def get_volume(self) -> float:
        if self._engine:
            return float(self._lib.synthway_engine_get_volume(self._engine))
        return 0.0

    def set_waveform(self, waveform: WaveformEnum):
        if self._engine:
            self._lib.synthway_engine_set_waveform(self._engine, int(waveform))

    def get_waveform(self) -> WaveformEnum:
        if self._engine:
            return WaveformEnum(self._lib.synthway_engine_get_waveform(self._engine))
        return WaveformEnum.SINE

    def set_tone_enabled(self, enabled: bool):
        if self._engine:
            self._lib.synthway_engine_set_tone_enabled(self._engine, enabled)

    def is_tone_enabled(self) -> bool:
        if self._engine:
            return bool(self._lib.synthway_engine_is_tone_enabled(self._engine))
        return False

    def is_running(self) -> bool:
        if self._engine:
            return bool(self._lib.synthway_engine_is_running(self._engine))
        return False
