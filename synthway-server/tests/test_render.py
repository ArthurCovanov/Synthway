"""Offline rendering through the real synthway-core library: no audio device is
opened and nothing is played. Skipped when synthway-core has not been built."""
import sys
import wave
from pathlib import Path

import pytest

import core_bridge
from models import Envelope, Timbre, WaveformEnum

ROOT = Path(__file__).resolve().parents[2]
if sys.platform.startswith("win"):
    LIB_NAME = "synthway.dll"
elif sys.platform == "darwin":
    LIB_NAME = "libsynthway.dylib"
else:
    LIB_NAME = "libsynthway.so"
LIB_PATH = ROOT / "synthway-core" / "build" / "lib" / LIB_NAME

pytestmark = pytest.mark.skipif(not LIB_PATH.exists(), reason="synthway-core is not built (skill core-build)")


def measure_frequency(samples, rate):
    """Frequency from positive-going zero crossings, interpolated between samples."""
    first = last = None
    crossings = 0
    for i in range(1, len(samples)):
        a, b = samples[i - 1], samples[i]
        if a < 0.0 <= b:
            t = (i - 1) + a / (a - b)
            first = t if first is None else first
            last = t
            crossings += 1
    return (crossings - 1) * rate / (last - first) if crossings > 1 else 0.0


@pytest.fixture(scope="module")
def core():
    return core_bridge.SynthwayCore(str(LIB_PATH))


def test_render_plays_the_requested_note(core):
    samples = core.render(440.0, 0.5, WaveformEnum.SINE, volume=0.5)
    steady = samples[2400:]  # 50 ms of smoothing
    assert abs(measure_frequency(steady, 48000) - 440.0) < 0.5
    assert abs(max(abs(x) for x in steady) - 0.5) < 0.01


def test_render_to_wav(core, tmp_path):
    path = tmp_path / "tone.wav"
    core.render_to_wav(str(path), 330.0, 0.25, WaveformEnum.SQUARE, volume=0.4)
    with wave.open(str(path), "rb") as wav:
        assert (wav.getnchannels(), wav.getframerate(), wav.getnframes()) == (2, 48000, 12000)
        raw = wav.readframes(wav.getnframes())
    left = [int.from_bytes(raw[i : i + 2], "little", signed=True) / 32768 for i in range(0, len(raw), 4)]
    assert abs(measure_frequency(left[2400:], 48000) - 330.0) < 0.5


def test_render_applies_the_envelope(core):
    # Square wave: |sample| = volume * envelope level; 100 ms attack, 100 ms decay to 50 %
    envelope = Envelope(attack=0.1, decay=0.1, sustain=0.5, release=0.1)
    samples = core.render(440.0, 0.4, WaveformEnum.SQUARE, volume=0.5, envelope=envelope)
    assert abs(abs(samples[2400]) - 0.25) < 0.005  # middle of the attack
    assert abs(abs(samples[14400]) - 0.25) < 0.005  # sustain (300 ms)


def test_live_engine_is_untouched(core):
    core.render(880.0, 0.1)
    assert core.is_running() is False


def amplitude_at(samples, rate, hz):
    """Amplitude of the component at hz (one DFT bin); exact over whole periods."""
    import math
    re = sum(x * math.cos(2 * math.pi * hz * i / rate) for i, x in enumerate(samples))
    im = sum(x * math.sin(2 * math.pi * hz * i / rate) for i, x in enumerate(samples))
    return 2 * math.hypot(re, im) / len(samples)


def test_render_plays_the_timbre(core):
    timbre = Timbre(partials=[{"ratio": 1.0, "amplitude": 0.5}, {"ratio": 2.76, "amplitude": 0.25}])
    samples = core.render(200.0, 0.3, volume=1.0, timbre=timbre)
    steady = samples[2400 : 2400 + 12000]  # 250 ms after the glide: whole periods of 200, 400 and 552 Hz
    assert abs(amplitude_at(steady, 48000, 200.0) - 0.5) < 0.005
    assert abs(amplitude_at(steady, 48000, 552.0) - 0.25) < 0.005
    assert amplitude_at(steady, 48000, 400.0) < 0.001
