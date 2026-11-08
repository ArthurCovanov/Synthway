"""
Data models for Synthway Server API.
Supports both Pydantic (when installed for FastAPI) and standard Python dataclasses as fallback.
"""

from enum import IntEnum
from typing import List, Optional

try:
    from pydantic import BaseModel, Field
    HAS_PYDANTIC = True
except ImportError:
    from dataclasses import dataclass, field

    HAS_PYDANTIC = False

    class BaseModel:
        def dict(self):
            return self.__dict__


class WaveformEnum(IntEnum):
    SINE = 0
    SQUARE = 1
    TRIANGLE = 2
    SAWTOOTH = 3


class DeviceTypeEnum(IntEnum):
    PLAYBACK = 0
    CAPTURE = 1


class MidiPortTypeEnum(IntEnum):
    INPUT = 0
    OUTPUT = 1


# SYNTHWAY_MAX_PARTIALS of synthway-core, fixed when the core is built. The
# bridge checks it against synthway_get_max_partials() when it loads the library.
MAX_PARTIALS = 64

# SYNTHWAY_ANALYSIS_SPECTRUM_POINTS of synthway-core. The bridge checks the size
# of the whole analysis structure (synthway_analysis_get_size) when it loads the library.
ANALYSIS_SPECTRUM_POINTS = 256


if HAS_PYDANTIC:
    class DeviceInfo(BaseModel):
        index: int
        name: str
        id: str
        is_default: bool
        sample_rate: int
        channels: int
        type: str  # "playback" or "capture"

    class DeviceListResponse(BaseModel):
        playback_devices: List[DeviceInfo] = []
        capture_devices: List[DeviceInfo] = []

    class MidiPortInfo(BaseModel):
        index: int
        name: str
        type: str  # "input" or "output"

    class EngineConfigRequest(BaseModel):
        sample_rate: int = Field(default=48000, description="Sampling rate in Hz (e.g. 44100, 48000)")
        channels: int = Field(default=2, description="Number of audio channels (e.g. 2 for stereo)")
        device_index: int = Field(default=-1, description="-1 for system default playback device")

    class ToneControlRequest(BaseModel):
        frequency: Optional[float] = Field(default=None, ge=10.0, le=22000.0, description="Frequency in Hz")
        volume: Optional[float] = Field(default=None, ge=0.0, le=1.0, description="Normalized volume (0.0 to 1.0)")
        waveform: Optional[WaveformEnum] = Field(default=None, description="Waveform type (0=Sine, 1=Square, 2=Triangle, 3=Sawtooth)")
        enabled: Optional[bool] = Field(default=None, description="Enable or mute synthesizer tone")

    class Envelope(BaseModel):
        """ADSR envelope of every note; defaults are the core's (synthway_engine_set_envelope)."""
        attack: float = Field(default=0.005, ge=0.0, le=10.0, description="Attack time in seconds")
        decay: float = Field(default=0.0, ge=0.0, le=10.0, description="Decay time in seconds")
        sustain: float = Field(default=1.0, ge=0.0, le=1.0, description="Sustain level (0.0 to 1.0)")
        release: float = Field(default=0.01, ge=0.0, le=10.0, description="Release time in seconds")

    class Partial(BaseModel):
        """One partial of a timbre: its own oscillator and envelope (synthway_partial_t)."""
        ratio: float = Field(
            default=1.0, gt=0.0, le=1000.0,
            description="Frequency relative to the note: 1 is the note, 2 its octave, 2.76 an inharmonic partial",
        )
        amplitude: float = Field(default=1.0, ge=0.0, le=1.0, description="Amplitude (0.0 to 1.0)")
        waveform: WaveformEnum = Field(default=WaveformEnum.SINE, description="Waveform of this partial")
        envelope: Envelope = Field(default_factory=Envelope, description="ADSR envelope of this partial")

    class Timbre(BaseModel):
        """Set of partials that plays every note instead of the single oscillator (synthway_engine_set_timbre)."""
        partials: List[Partial] = Field(default_factory=list, max_length=MAX_PARTIALS)

    class EngineStatusResponse(BaseModel):
        is_running: bool
        is_tone_enabled: bool
        frequency: float
        volume: float
        waveform: WaveformEnum
        envelope: Envelope
        timbre: Optional[Timbre] = Field(default=None, description="null: the single oscillator plays")
        max_partials: int = Field(default=MAX_PARTIALS, description="Most partials a timbre can hold")
        sample_rate: Optional[int] = Field(default=None, description="Sample rate of the running engine, null without one")
        core_version: str

    class AnalysisPartial(BaseModel):
        """A peak of the spectrum (synthway_analysis_partial_t)."""
        frequency: float = Field(description="Frequency in Hz")
        ratio: float = Field(description="Frequency / fundamental, 0 without a fundamental")
        amplitude: float = Field(description="Relative to the strongest partial, in (0, 1]")

    class Analysis(BaseModel):
        """What the analyzer hears at one moment (synthway_analysis_t)."""
        sample_rate: int
        frequency: float = Field(description="Fundamental in Hz (the note played), 0 when none was found")
        clarity: float = Field(description="How periodic the sound is, in [0, 1]: the note is reliable above about 0.8")
        level_db: float = Field(description="RMS level in dBFS, -120 for silence")
        partials: List[AnalysisPartial] = Field(default_factory=list, description="Sorted by frequency")
        spectrum_min_hz: float
        spectrum_max_hz: float
        spectrum_db: List[float] = Field(
            default_factory=list,
            description=f"{ANALYSIS_SPECTRUM_POINTS} levels in dBFS, on log-spaced frequencies from spectrum_min_hz to spectrum_max_hz",
        )

    class ClipTrack(BaseModel):
        """The note along a file: one value per point, points evenly spread."""
        frequency: List[float] = Field(default_factory=list)
        clarity: List[float] = Field(default_factory=list)
        level_db: List[float] = Field(default_factory=list)

    class ClipResponse(BaseModel):
        """An audio file loaded into the analyzer, for display."""
        name: str
        duration: float = Field(description="Seconds")
        sample_rate: int
        frame_count: int
        overview: List[float] = Field(default_factory=list, description="Peak of each equal part of the file, for the waveform")
        overview_left: List[float] = Field(default_factory=list, description="Left-channel peak of each equal part")
        overview_right: List[float] = Field(default_factory=list, description="Right-channel peak of each equal part")
        track: ClipTrack = Field(default_factory=ClipTrack)

    class ClipWaveform(BaseModel):
        """A part of the clip, cut into equal parts: the lowest and highest sample of each channel in each.
        With as many parts as frames, each part is one sample."""
        first_frame: int
        frame_count: int = Field(description="Frames covered, stopped at the end of the clip")
        left_low: List[float] = Field(default_factory=list)
        left_high: List[float] = Field(default_factory=list)
        right_low: List[float] = Field(default_factory=list)
        right_high: List[float] = Field(default_factory=list)

else:
    @dataclass
    class DeviceInfo:
        index: int
        name: str
        id: str
        is_default: bool
        sample_rate: int
        channels: int
        type: str

    @dataclass
    class DeviceListResponse:
        playback_devices: List[DeviceInfo] = field(default_factory=list)
        capture_devices: List[DeviceInfo] = field(default_factory=list)

    @dataclass
    class MidiPortInfo:
        index: int
        name: str
        type: str

    @dataclass
    class EngineConfigRequest:
        sample_rate: int = 48000
        channels: int = 2
        device_index: int = -1

    @dataclass
    class ToneControlRequest:
        frequency: Optional[float] = None
        volume: Optional[float] = None
        waveform: Optional[WaveformEnum] = None
        enabled: Optional[bool] = None

    @dataclass
    class Envelope:
        attack: float = 0.005
        decay: float = 0.0
        sustain: float = 1.0
        release: float = 0.01

    @dataclass
    class Partial:
        ratio: float = 1.0
        amplitude: float = 1.0
        waveform: WaveformEnum = WaveformEnum.SINE
        envelope: Envelope = field(default_factory=Envelope)

    @dataclass
    class Timbre:
        partials: List[Partial] = field(default_factory=list)

    @dataclass
    class EngineStatusResponse:
        is_running: bool = False
        is_tone_enabled: bool = False
        frequency: float = 440.0
        volume: float = 0.25
        waveform: WaveformEnum = WaveformEnum.SINE
        envelope: Envelope = field(default_factory=Envelope)
        timbre: Optional[Timbre] = None
        max_partials: int = MAX_PARTIALS
        sample_rate: Optional[int] = None
        core_version: str = "unknown"

    @dataclass
    class AnalysisPartial:
        frequency: float = 0.0
        ratio: float = 0.0
        amplitude: float = 0.0

    @dataclass
    class Analysis:
        sample_rate: int = 0
        frequency: float = 0.0
        clarity: float = 0.0
        level_db: float = -120.0
        partials: List[AnalysisPartial] = field(default_factory=list)
        spectrum_min_hz: float = 20.0
        spectrum_max_hz: float = 20000.0
        spectrum_db: List[float] = field(default_factory=list)

    @dataclass
    class ClipTrack:
        frequency: List[float] = field(default_factory=list)
        clarity: List[float] = field(default_factory=list)
        level_db: List[float] = field(default_factory=list)

    @dataclass
    class ClipResponse:
        name: str = ""
        duration: float = 0.0
        sample_rate: int = 0
        frame_count: int = 0
        overview: List[float] = field(default_factory=list)
        overview_left: List[float] = field(default_factory=list)
        overview_right: List[float] = field(default_factory=list)
        track: ClipTrack = field(default_factory=ClipTrack)

    @dataclass
    class ClipWaveform:
        first_frame: int = 0
        frame_count: int = 0
        left_low: List[float] = field(default_factory=list)
        left_high: List[float] = field(default_factory=list)
        right_low: List[float] = field(default_factory=list)
        right_high: List[float] = field(default_factory=list)
