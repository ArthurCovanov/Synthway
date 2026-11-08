"""Sound analysis through the real synthway-core library: sounds rendered
offline by the engine, then analyzed. No audio device is opened, the
microphone is never used. Skipped when synthway-core has not been built."""
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


def test_clip_refuses_what_is_not_audio(analyzer):
    with pytest.raises(core_bridge.CoreError) as error:
        analyzer.load_clip_bytes(b"definitely not an audio file, just some bytes")
    assert error.value.code == core_bridge.RESULT_FORMAT_ERROR
    assert analyzer.clip_info() == (0, 0)


def test_microphone_stays_closed(analyzer):
    assert analyzer.is_input_open() is False
    with pytest.raises(core_bridge.CoreError):
        analyzer.analyze_input()


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
