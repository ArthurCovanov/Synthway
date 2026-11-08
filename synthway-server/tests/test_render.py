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


def test_instrument_structure_matches_the_core(core):
    """SynthwayInstrumentC must lay out its fields as synthway_instrument_t: a round trip through the core."""
    import ctypes
    from models import Instrument

    lib = core._lib
    lib.synthway_engine_get_instrument.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(core_bridge.SynthwayInstrumentC)]
    lib.synthway_engine_get_instrument.restype = ctypes.c_int
    lib.synthway_engine_init_offline.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    instrument = Instrument(
        waveform=WaveformEnum.TRIANGLE, envelope=Envelope(attack=0.1, decay=0.2, sustain=0.5, release=0.3),
        low_cutoff=100.0, cutoff=5000.0, resonance=0.25, reverb=0.5, unison={"voices": 5, "detune": 12.0, "spread": 0.75},
        timbre=Timbre(partials=[{"ratio": 1.0, "amplitude": 0.5}, {"ratio": 2.5, "amplitude": 0.25, "waveform": 3}]),
    )
    engine = lib.synthway_engine_create()
    try:
        assert lib.synthway_engine_init_offline(engine, None) == 0
        assert lib.synthway_engine_set_instrument(engine, 5, ctypes.byref(core_bridge._instrument_to_c(instrument))) == 0
        out = core_bridge.SynthwayInstrumentC()
        assert lib.synthway_engine_get_instrument(engine, 5, ctypes.byref(out)) == 0
    finally:
        lib.synthway_engine_destroy(engine)
    assert (out.waveform, out.envelope.attack_s, out.envelope.sustain_level, out.envelope.release_s) == pytest.approx((2, 0.1, 0.5, 0.3))
    assert (out.filter_low_cutoff_hz, out.filter_high_cutoff_hz, out.filter_resonance, out.reverb_mix) == pytest.approx((100.0, 5000.0, 0.25, 0.5))
    assert (out.unison_voices, out.unison_detune_cents, out.unison_spread) == pytest.approx((5, 12.0, 0.75))
    assert out.has_timbre and out.timbre.partial_count == 2
    assert (out.timbre.partials[1].ratio, out.timbre.partials[1].amplitude, out.timbre.partials[1].waveform) == pytest.approx((2.5, 0.25, 3))


def test_note_glides_through_the_bridge(core):
    """A note started and glided by the bridge's calls, rendered offline by the real core."""
    import array
    import ctypes

    lib = core._lib
    lib.synthway_engine_init_offline.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    lib.synthway_engine_render.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.c_uint32]
    lib.synthway_engine_render.restype = ctypes.c_int
    engine = lib.synthway_engine_create()
    rate = 48000
    try:
        config = core_bridge.SynthwayEngineConfigC(sample_rate=rate, channels=1, playback_device_index=-1)
        assert lib.synthway_engine_init_offline(engine, ctypes.byref(config)) == 0
        lib.synthway_engine_set_tone_enabled(engine, False)
        core._engine = engine  # the bridge's note calls act on this engine
        core.note_on(1, 0, 220.0, 0.5)
        core.note_glide(1, 440.0, 1.0)
        samples = (ctypes.c_float * (2 * rate))()
        assert lib.synthway_engine_render(engine, samples, 2 * rate) == 0
    finally:
        core._engine = None
        lib.synthway_engine_destroy(engine)
    values = array.array("f", samples)
    halfway = values[rate // 2 - 960 : rate // 2 + 960]
    after = values[rate + 24000 - 960 : rate + 24000 + 960]
    assert abs(measure_frequency(halfway, rate) - 220.0 * 2 ** 0.5) < 1.0
    assert abs(measure_frequency(after, rate) - 440.0) < 0.5
