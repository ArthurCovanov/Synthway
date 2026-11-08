"""Sound analysis through the real synthway-core library: sounds rendered
offline by the engine, then analyzed. No audio device is opened, the
microphone is never used (recordings come from a virtual input fed by the
test). Skipped when synthway-core has not been built."""
import math

import pytest

import core_bridge
import main
from models import Timbre, WaveformEnum
from test_render import LIB_PATH

pytestmark = pytest.mark.skipif(not LIB_PATH.exists(), reason="synthway-core is not built (skill core-build)")


def cents(frequency, expected):
    return 1200 * math.log2(frequency / expected)


@pytest.fixture(scope="module")
def core():
    return core_bridge.SynthwayCore(str(LIB_PATH))


@pytest.fixture
def analyzer(core):
    analyzer = core.create_analyzer()
    yield analyzer
    analyzer.close()


def test_note_and_partials_of_a_card(core, analyzer):
    # A bell-like card of the Instrument Creator, played on G3
    timbre = Timbre(partials=[
        {"ratio": 1.0, "amplitude": 0.6}, {"ratio": 2.0, "amplitude": 0.3},
        {"ratio": 2.76, "amplitude": 0.25}, {"ratio": 5.4, "amplitude": 0.12},
    ])
    samples = core.render(196.0, 0.5, volume=0.5, timbre=timbre)
    analysis = analyzer.analyze_samples(samples, 48000)
    assert abs(cents(analysis.frequency, 196.0)) < 2
    assert [p.ratio for p in analysis.partials] == pytest.approx([1.0, 2.0, 2.76, 5.4], abs=0.003)
    assert [p.amplitude for p in analysis.partials] == pytest.approx([1.0, 0.5, 0.4167, 0.2], abs=0.02)
    assert len(analysis.spectrum_db) == 256
    assert analysis.spectrum_max_hz == 20000.0


def test_clip_from_bytes(core, analyzer, tmp_path):
    path = tmp_path / "saw.wav"
    core.render_to_wav(str(path), 110.0, 1.0, WaveformEnum.SAWTOOTH, volume=0.5)
    analyzer.load_clip_bytes(path.read_bytes())
    assert analyzer.clip_info() == (48000, 48000)
    assert abs(cents(analyzer.analyze_clip(0.5).frequency, 110.0)) < 1

    clip = main.clip_response(analyzer, "saw.wav")
    assert clip.duration == 1.0 and len(clip.overview) == 1000 and len(clip.track.frequency) == 50
    on_note = [f for f in clip.track.frequency if f and abs(cents(f, 110.0)) < 2]
    assert len(on_note) >= 48


def test_window_and_zone(core, analyzer, tmp_path):
    path = tmp_path / "saw.wav"
    core.render_to_wav(str(path), 220.0, 1.0, WaveformEnum.SAWTOOTH, volume=0.5)
    analyzer.load_clip_bytes(path.read_bytes())
    # A moment through a 50 ms window, then the median of a zone through the usual window
    moment = analyzer.analyze_clip_range(0.475, 0.525, 0.05)
    zone = analyzer.analyze_clip_range(0.1, 0.9, core_bridge.WINDOW_AUTO)
    for analysis in (moment, zone):
        assert abs(cents(analysis.frequency, 220.0)) < 2
        assert [round(p.ratio) for p in analysis.partials[:8]] == [1, 2, 3, 4, 5, 6, 7, 8]
    assert [p.ratio for p in zone.partials[:8]] == pytest.approx([1, 2, 3, 4, 5, 6, 7, 8], abs=0.002)
    # The octave below given as the note: the same partials, at 2, 4, 6…; harmonics only changes nothing here
    lower = analyzer.analyze_clip_range(0.1, 0.9, core_bridge.WINDOW_AUTO, None, 110.0, 30.0)
    assert abs(cents(lower.frequency, 110.0)) < 2
    assert [p.ratio for p in lower.partials[:4]] == pytest.approx([2, 4, 6, 8], abs=0.004)
    with pytest.raises(core_bridge.CoreError) as error:
        analyzer.analyze_clip_range(0.5, 0.5)
    assert error.value.code == core_bridge.RESULT_INVALID_PARAM

    # Zoomed in: the whole swing of the sawtooth in each part, then down to its samples
    part = analyzer.clip_waveform(24000, 4800, 10)
    assert part.frame_count == 4800 and all(low < -0.45 and high > 0.45 for low, high in zip(part.left_low, part.left_high))
    assert part.left_low == part.right_low  # rendered the same on both channels
    samples = analyzer.clip_waveform(24000, 50, 800)
    assert len(samples.left_low) == 50 and samples.left_low == samples.left_high
    end = analyzer.clip_waveform(47990, 100, 100)
    assert end.frame_count == 10 and len(end.left_low) == 10
    with pytest.raises(core_bridge.CoreError) as error:
        analyzer.clip_waveform(48000, 10, 10)
    assert error.value.code == core_bridge.RESULT_INVALID_PARAM


def test_clip_refuses_what_is_not_audio(analyzer):
    with pytest.raises(core_bridge.CoreError) as error:
        analyzer.load_clip_bytes(b"definitely not an audio file, just some bytes")
    assert error.value.code == core_bridge.RESULT_FORMAT_ERROR
    assert analyzer.clip_info() == (0, 0)


def test_microphone_stays_closed(analyzer):
    assert analyzer.is_input_open() is False
    with pytest.raises(core_bridge.CoreError):
        analyzer.analyze_input()


def test_recording_from_a_virtual_microphone(core, analyzer, tmp_path):
    # A virtual input stands for the microphone: the test plays the capture thread
    samples = core.render(220.0, 1.0, WaveformEnum.SAWTOOTH, volume=0.5)
    with pytest.raises(core_bridge.CoreError) as error:
        analyzer.start_recording()  # no microphone open
    assert error.value.code == core_bridge.RESULT_NOT_RUNNING
    analyzer.open_virtual_input(48000)
    analyzer.start_recording()
    for start in range(0, len(samples), 4800):
        analyzer.write_input(samples[start:start + 4800])
        analyzer.analyze_input()  # takes the new samples, like the server's live loop
    assert analyzer.is_recording() and analyzer.recording_info() == (48000, 0)
    assert analyzer.stop_recording() is True
    assert analyzer.stop_recording() is False  # nothing left to stop
    assert analyzer.is_input_open() and analyzer.clip_info() == (48000, 48000)

    clip = main.clip_response(analyzer, main.RECORDING_NAME)
    assert clip.duration == 1.0 and clip.name == "Enregistrement"
    assert abs(cents(analyzer.analyze_clip(0.5).frequency, 220.0)) < 1

    path = tmp_path / "enregistrement.wav"
    analyzer.save_clip_wav(str(path))
    analyzer.close_input()
    analyzer.load_clip_bytes(path.read_bytes())
    assert analyzer.clip_info() == (48000, 48000)
    assert abs(cents(analyzer.analyze_clip(0.5).frequency, 220.0)) < 1


def test_noise_gate(core, analyzer):
    # The same bell card at volume 0.5: its partials peak at -10.5, -16.5, -18 and -24.4 dBFS (x5.4)
    timbre = Timbre(partials=[
        {"ratio": 1.0, "amplitude": 0.6}, {"ratio": 2.0, "amplitude": 0.3},
        {"ratio": 2.76, "amplitude": 0.25}, {"ratio": 5.4, "amplitude": 0.12},
    ])
    samples = core.render(196.0, 0.5, volume=0.5, timbre=timbre)
    assert len(analyzer.analyze_samples(samples, 48000).partials) == 4
    analyzer.set_noise_gate(-21.0)
    assert analyzer.get_noise_gate() == -21.0
    gated = analyzer.analyze_samples(samples, 48000)
    assert [p.ratio for p in gated.partials] == pytest.approx([1.0, 2.0, 2.76], abs=0.003)
    with pytest.raises(core_bridge.CoreError):
        analyzer.set_noise_gate(5.0)
    assert analyzer.get_noise_gate() == -21.0


def test_envelopes_round_trip(core, analyzer, tmp_path):
    # A card whose harmonics fade exponentially, each at its own speed, rendered by the
    # engine then measured back: the analyzer finds each partial's decay
    timbre = Timbre(partials=[
        {"ratio": n, "amplitude": round(0.5 / n, 4),
         "envelope": {"attack": 0.002, "decay": round(2.0 / n, 4), "sustain": 0.0, "release": 0.1, "curve": 1}}
        for n in range(1, 6)
    ])
    path = tmp_path / "pluck.wav"
    core.render_to_wav(str(path), 220.0, 0.6, volume=0.8, channels=1, timbre=timbre)
    analyzer.load_clip_bytes(path.read_bytes())
    analysis, envelopes = analyzer.measure_envelopes(0.0, 0.6, core_bridge.WINDOW_AUTO, None, 0.0, 30.0)
    assert abs(cents(analysis.frequency, 220.0)) < 2
    assert len(envelopes) == len(analysis.partials) >= 5
    for n in range(1, 6):
        partial, envelope = next((p, e) for p, e in zip(analysis.partials, envelopes) if round(p.ratio) == n)
        assert envelope.curve == 1 and envelope.sustain == 0.0
        assert envelope.decay == pytest.approx(2.0 / n, rel=0.2), n
        assert partial.amplitude == pytest.approx(1.0 / n, rel=0.15), n
