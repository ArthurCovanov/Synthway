"""Server behaviour checked against fakes of the native core: no audio is ever
produced, no microphone is ever opened."""
import pytest
from fastapi.testclient import TestClient

import core_bridge
import main
from core_bridge import CoreError
from models import (
    MAX_PARTIALS, Analysis, AnalysisPartial, ClipTrack, DeviceInfo, DeviceTypeEnum, Envelope, Timbre, WaveformEnum,
)


class FakeLib:
    """Stands in for the ctypes library and records the engine calls in order."""

    def __init__(self, start_result=0):
        self.calls = []
        self.start_result = start_result

    def synthway_engine_create(self):
        self.calls.append("create")
        return 1

    def synthway_engine_init(self, engine, config):
        self.calls.append("init")
        return 0

    def synthway_engine_set_tone_enabled(self, engine, enabled):
        self.calls.append(("tone", bool(enabled)))
        return 0

    def synthway_engine_set_envelope(self, engine, attack, decay, sustain, release):
        self.calls.append(("envelope", attack, decay, sustain, release))
        return 0

    def synthway_engine_set_timbre(self, engine, timbre):
        # timbre is ctypes.byref(SynthwayTimbreC), or None for the single oscillator
        self.calls.append(("timbre", None if timbre is None else [p.ratio for p in timbre._obj.partials[: timbre._obj.partial_count]]))
        return 0

    def synthway_engine_start(self, engine):
        self.calls.append("start")
        return self.start_result

    def synthway_engine_stop(self, engine):
        self.calls.append("stop")
        return 0

    def synthway_engine_destroy(self, engine):
        self.calls.append("destroy")


def bridge_with(lib):
    bridge = core_bridge.SynthwayCore.__new__(core_bridge.SynthwayCore)  # skips loading the real library
    bridge.lib_path = "fake"
    bridge._lib = lib
    bridge._engine = None
    return bridge


class FakeCore:
    """Stands in for SynthwayCore. Like the real bridge, setters do nothing while no engine exists."""

    def __init__(self):
        self.calls = []
        self.running = False
        self.enabled = False
        self.frequency = 440.0
        self.volume = 0.25
        self.waveform = WaveformEnum.SINE

    def get_version(self):
        return "0.0.0-test"

    def list_devices(self, device_type):
        kind = "playback" if device_type == DeviceTypeEnum.PLAYBACK else "capture"
        return [DeviceInfo(index=0, name=f"Fake {kind}", id="0", is_default=True, sample_rate=48000, channels=2, type=kind)]

    def start_engine(self, sample_rate=48000, channels=2, device_index=-1):
        self.calls.append("start")
        self.running = True
        self.enabled = False
        return True

    def stop_engine(self):
        self.calls.append("stop")
        self.running = False

    def is_running(self):
        return self.running

    def set_frequency(self, frequency):
        if self.running:
            self.calls.append(("frequency", frequency))
            self.frequency = frequency

    def set_volume(self, volume):
        if self.running:
            self.calls.append(("volume", volume))
            self.volume = volume

    def set_waveform(self, waveform):
        if self.running:
            self.waveform = waveform

    def set_tone_enabled(self, enabled):
        if self.running:
            self.calls.append(("enabled", enabled))
            self.enabled = enabled

    def get_frequency(self):
        return self.frequency

    def get_volume(self):
        return self.volume

    def get_waveform(self):
        return self.waveform

    def is_tone_enabled(self):
        return self.enabled

    # Like the real bridge, the envelope is kept even without an engine
    envelope = Envelope()

    def set_envelope(self, envelope):
        self.envelope = envelope

    def get_envelope(self):
        return self.envelope

    timbre = None

    def set_timbre(self, timbre):
        self.timbre = timbre

    def get_timbre(self):
        return self.timbre

    def get_max_partials(self):
        return MAX_PARTIALS

    def get_sample_rate(self):
        return 48000 if self.running else None

    def create_analyzer(self):
        analyzer = FakeAnalyzer()
        self.analyzers.append(analyzer)
        return analyzer


def fake_analysis(frequency):
    return Analysis(
        sample_rate=48000, frequency=frequency, clarity=0.99, level_db=-9.0,
        partials=[AnalysisPartial(frequency=frequency, ratio=1.0, amplitude=1.0)],
        spectrum_min_hz=20.0, spectrum_max_hz=20000.0, spectrum_db=[-120.0] * 256,
    )


class FakeAnalyzer:
    """Stands in for core_bridge.Analyzer: a microphone that is never opened, files that are never decoded."""

    def __init__(self):
        self.input_open = False
        self.clip = (0, 0)
        self.noise_gate = core_bridge.NOISE_GATE_OFF

    def set_noise_gate(self, threshold_db):
        # Same range as the core
        if not core_bridge.NOISE_GATE_OFF <= threshold_db <= 0.0:
            raise CoreError("Setting the noise gate failed: Invalid parameter (-2)", core_bridge.RESULT_INVALID_PARAM)
        self.noise_gate = threshold_db

    def open_input(self, device_index=-1, sample_rate=0):
        if device_index == 99:
            raise CoreError("Opening the microphone failed: Device not found (-3)", -3)
        self.input_open = True
        return 44100, device_index != 2  # input 2 refuses the exclusive mode

    def close_input(self):
        self.input_open = False

    def analyze_input(self):
        return fake_analysis(440.0)

    def load_clip_bytes(self, data):
        # RIFF: a WAV file; LONG: too long; anything else is not audio
        self.clip = (0, 0)
        if data.startswith(b"LONG"):
            raise CoreError("Loading the file failed: Invalid parameter (-2)", core_bridge.RESULT_INVALID_PARAM)
        if not data.startswith(b"RIFF"):
            raise CoreError("Loading the file failed: Unsupported or corrupt audio file (-9)", core_bridge.RESULT_FORMAT_ERROR)
        self.clip = (72000, 48000)

    def clip_info(self):
        return self.clip

    def clip_overview(self, count):
        return [0.5] * count

    def clip_track(self, count):
        return ClipTrack(frequency=[330.0] * count, clarity=[0.99] * count, level_db=[-9.0] * count)

    def analyze_clip(self, time_s, noise_gate_db=None):
        if noise_gate_db is not None:
            self.set_noise_gate(noise_gate_db)
        return fake_analysis(330.0)


@pytest.fixture
def server(monkeypatch):
    fake = FakeCore()
    fake.analyzers = []
    monkeypatch.setattr(main, "core", fake)
    monkeypatch.setattr(main, "analyzers", main.AnalyzerHub())
    with TestClient(main.app) as client:
        yield client, fake


# ---------- Bridge ----------


def test_engine_starts_muted():
    lib = FakeLib()
    assert bridge_with(lib).start_engine() is True
    assert lib.calls.index(("tone", False)) < lib.calls.index("start")


def test_envelope_is_kept_across_engine_restarts():
    lib = FakeLib()
    bridge = bridge_with(lib)
    bridge.set_envelope(Envelope(attack=0.1, decay=0.2, sustain=0.5, release=0.3))  # no engine yet
    bridge.start_engine()
    bridge.start_engine()  # a restart creates a new engine
    applied = [call for call in lib.calls if call[0] == "envelope"]
    assert applied == [("envelope", 0.1, 0.2, 0.5, 0.3)] * 2
    assert lib.calls.index(applied[0]) < lib.calls.index("start")


def test_timbre_is_kept_across_engine_restarts():
    lib = FakeLib()
    bridge = bridge_with(lib)
    bridge.set_timbre(Timbre(partials=[{"ratio": 1.0}, {"ratio": 2.76, "amplitude": 0.4}]))  # no engine yet
    bridge.start_engine()
    bridge.start_engine()
    applied = [call for call in lib.calls if call[0] == "timbre"]
    assert len(applied) == 2 and applied[0][1] == pytest.approx([1.0, 2.76])
    assert lib.calls.index(applied[0]) < lib.calls.index("start")

    bridge.set_timbre(None)  # engine running: back to the single oscillator at once
    assert lib.calls[-1] == ("timbre", None)


def test_failed_start_releases_the_engine():
    lib = FakeLib(start_result=-4)
    bridge = bridge_with(lib)
    assert bridge.start_engine() is False
    assert lib.calls[-1] == "destroy"
    assert bridge._engine is None


# ---------- Server ----------


def test_first_note_plays_the_requested_note(server):
    client, fake = server
    with client.websocket_connect("/ws/synth") as ws:
        ws.send_json({"type": "note_on", "frequency": 523.25, "volume": 0.4})
        state = ws.receive_json()
    assert fake.calls[0] == "start"
    assert state == {"frequency": 523.25, "volume": 0.4, "waveform": 0, "running": True, "enabled": True}


def test_note_off_mutes_without_stopping(server):
    client, fake = server
    with client.websocket_connect("/ws/synth") as ws:
        ws.send_json({"type": "note_on", "frequency": 440.0, "volume": 0.3})
        ws.receive_json()
        ws.send_json({"type": "note_off"})
        state = ws.receive_json()
    assert state["enabled"] is False
    assert state["running"] is True


def test_devices_are_listed(server):
    client, _ = server
    body = client.get("/api/devices").json()
    assert body["playback_devices"][0]["name"] == "Fake playback"
    assert body["capture_devices"][0]["name"] == "Fake capture"


def test_cors_accepts_local_pages_only(server):
    client, _ = server

    def preflight(origin):
        return client.options(
            "/api/engine/start",
            headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
        )

    assert preflight("http://localhost:5173").headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert "access-control-allow-origin" not in preflight("https://example.com").headers


def test_health_without_core(monkeypatch):
    monkeypatch.setattr(main, "core", None)
    with TestClient(main.app) as client:
        assert client.get("/health").json() == {"status": "ok", "core_loaded": False, "core_version": None}


def test_envelope_route_validates_and_applies(server):
    client, fake = server
    envelope = {"attack": 0.2, "decay": 0.1, "sustain": 0.6, "release": 0.8}
    assert client.post("/api/synth/envelope", json=envelope).json() == envelope
    assert fake.envelope == Envelope(**envelope)
    assert client.post("/api/synth/envelope", json={**envelope, "sustain": 1.5}).status_code == 422
    assert client.get("/api/engine/status").json()["envelope"] == envelope


def test_ws_set_param_envelope(server):
    client, fake = server
    envelope = {"attack": 0.05, "decay": 0.3, "sustain": 0.4, "release": 1.2}
    with client.websocket_connect("/ws/synth") as ws:
        ws.send_json({"type": "set_param", "envelope": envelope})
        ws.receive_json()
    assert fake.envelope == Envelope(**envelope)


def test_ws_invalid_message_keeps_the_connection(server):
    client, _ = server
    with client.websocket_connect("/ws/synth") as ws:
        ws.send_json({"type": "set_param", "envelope": {"sustain": 2.0}})
        assert "error" in ws.receive_json()
        ws.send_text("not json")
        assert "error" in ws.receive_json()
        ws.send_json({"type": "note_on", "frequency": 330.0, "volume": 0.2})
        assert ws.receive_json()["frequency"] == 330.0


def test_timbre_route_validates_and_applies(server):
    client, fake = server
    timbre = {
        "partials": [
            {"ratio": 1.0, "amplitude": 0.8, "waveform": 0, "envelope": {"attack": 0.01, "decay": 0.2, "sustain": 0.5, "release": 0.3}},
            {"ratio": 2.76, "amplitude": 0.3, "waveform": 3, "envelope": {"attack": 0.0, "decay": 0.1, "sustain": 0.0, "release": 0.1}},
        ]
    }
    assert client.post("/api/synth/timbre", json=timbre).json() == timbre
    assert fake.timbre == Timbre(**timbre)
    status = client.get("/api/engine/status").json()
    assert status["timbre"] == timbre
    assert status["max_partials"] == MAX_PARTIALS
    assert status["sample_rate"] is None  # no engine running

    bad_partials = [{"ratio": 0}, {"ratio": 1001}, {"amplitude": 1.5}, {"waveform": 4}, {"envelope": {"sustain": 2}}]
    for bad in bad_partials:
        assert client.post("/api/synth/timbre", json={"partials": [bad]}).status_code == 422, bad
    too_many = {"partials": [{"ratio": n + 1} for n in range(MAX_PARTIALS + 1)]}
    assert client.post("/api/synth/timbre", json=too_many).status_code == 422
    assert fake.timbre == Timbre(**timbre)  # refusals keep the timbre in place

    assert client.delete("/api/synth/timbre").json() == {"timbre": None}
    assert client.get("/api/engine/status").json()["timbre"] is None


def test_ws_set_param_timbre(server):
    client, fake = server
    with client.websocket_connect("/ws/synth") as ws:
        ws.send_json({"type": "set_param", "timbre": {"partials": [{"ratio": 1.5, "amplitude": 0.5}]}})
        ws.receive_json()
        assert fake.timbre.partials[0].ratio == 1.5
        assert fake.timbre.partials[0].envelope == Envelope()  # default envelope
        ws.send_json({"type": "set_param", "timbre": {"partials": [{"ratio": -1}]}})
        assert "error" in ws.receive_json()
        assert fake.timbre.partials[0].ratio == 1.5
        ws.send_json({"type": "set_param", "timbre": None})
        ws.receive_json()
    assert fake.timbre is None


# ---------- Analyzer ----------


def receive_until(ws, message_type):
    """Messages up to the first of message_type (live analyses keep coming meanwhile)."""
    while True:
        message = ws.receive_json()
        if message["type"] == message_type:
            return message
        assert message["type"] == "analysis", message


def test_clip_upload_shows_waveform_and_note(server):
    client, _ = server
    assert client.get("/api/analyzer/clip").json() is None
    response = client.post("/api/analyzer/clip?name=guitare.wav", content=b"RIFF....WAVE")
    assert response.status_code == 200
    clip = response.json()
    assert (clip["name"], clip["duration"], clip["sample_rate"], clip["frame_count"]) == ("guitare.wav", 1.5, 48000, 72000)
    assert len(clip["overview"]) == main.CLIP_OVERVIEW_POINTS
    assert len(clip["track"]["frequency"]) == 75  # one point every 20 ms
    assert client.get("/api/analyzer/clip").json()["name"] == "guitare.wav"

    analysis = client.get("/api/analyzer/clip/analysis?time=0.75").json()
    assert analysis["frequency"] == 330.0
    assert analysis["partials"][0]["ratio"] == 1.0
    assert client.get("/api/analyzer/clip/analysis?time=-1").status_code == 422


def test_clip_errors(server):
    client, _ = server
    assert client.post("/api/analyzer/clip", content=b"").status_code == 400
    assert client.post("/api/analyzer/clip", content=b"not audio").status_code == 415
    assert client.post("/api/analyzer/clip", content=b"LONG....").status_code == 413
    # A refused file unloads the previous one, as the core does
    client.post("/api/analyzer/clip", content=b"RIFF")
    client.post("/api/analyzer/clip", content=b"not audio")
    assert client.get("/api/analyzer/clip").json() is None
    assert client.get("/api/analyzer/clip/analysis?time=0").status_code == 404


def test_microphone_streams_analyses_until_stopped(server):
    client, fake = server
    with client.websocket_connect("/ws/analyzer") as ws:
        ws.send_json({"type": "start", "device_index": 1})
        assert ws.receive_json() == {"type": "started", "device_index": 1, "sample_rate": 44100, "exclusive": True}
        message = ws.receive_json()
        assert message["type"] == "analysis" and message["analysis"]["frequency"] == 440.0
        live = fake.analyzers[0]
        assert live.input_open
        ws.send_json({"type": "stop"})
        receive_until(ws, "stopped")
        assert not live.input_open
        assert main.analyzers.listener is None


def test_microphone_closes_when_the_page_leaves(server):
    client, fake = server
    with client.websocket_connect("/ws/analyzer") as ws:
        ws.send_json({"type": "start"})
        receive_until(ws, "started")
        assert fake.analyzers[0].input_open
    assert not fake.analyzers[0].input_open
    assert main.analyzers.listener is None


def test_one_page_listens_at_a_time(server):
    client, _ = server
    with client.websocket_connect("/ws/analyzer") as first, client.websocket_connect("/ws/analyzer") as second:
        first.send_json({"type": "start"})
        receive_until(first, "started")
        second.send_json({"type": "start"})
        assert second.receive_json()["type"] == "error"
        first.send_json({"type": "stop"})
        receive_until(first, "stopped")
        second.send_json({"type": "start"})  # free again
        receive_until(second, "started")


def test_microphone_errors_keep_the_connection(server):
    client, fake = server
    with client.websocket_connect("/ws/analyzer") as ws:
        ws.send_json({"type": "start", "device_index": 99})
        assert "Device not found" in ws.receive_json()["error"]
        ws.send_text("not json")
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"type": "dance"})
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"type": "start"})
        receive_until(ws, "started")
    assert main.analyzers.listener is None


def test_microphone_reports_shared_mode(server):
    client, _ = server
    with client.websocket_connect("/ws/analyzer") as ws:
        ws.send_json({"type": "start", "device_index": 2})
        assert receive_until(ws, "started")["exclusive"] is False


def test_analysis_numbers_stay_valid_json():
    # NaN or infinity would make JSON that browsers refuse, freezing the page
    assert core_bridge._number(float("nan"), 2) == 0.0
    assert core_bridge._number(float("inf"), 2, -120.0) == -120.0
    assert core_bridge._number(440.123456, 2) == 440.12


def test_noise_gate_on_file_analysis(server):
    client, fake = server
    client.post("/api/analyzer/clip", content=b"RIFF")
    clip_analyzer = fake.analyzers[-1]
    client.get("/api/analyzer/clip/analysis?time=0.5")
    assert clip_analyzer.noise_gate == core_bridge.NOISE_GATE_OFF  # off unless asked
    assert client.get("/api/analyzer/clip/analysis?time=0.5&noise_gate_db=-60").status_code == 200
    assert clip_analyzer.noise_gate == -60.0
    assert client.get("/api/analyzer/clip/analysis?time=0.5&noise_gate_db=5").status_code == 422
    assert client.get("/api/analyzer/clip/analysis?time=0.5&noise_gate_db=-121").status_code == 422


def test_noise_gate_on_microphone(server):
    client, fake = server
    with client.websocket_connect("/ws/analyzer") as ws:
        ws.send_json({"type": "start", "noise_gate_db": -70})
        receive_until(ws, "started")
        live = fake.analyzers[0]
        assert live.noise_gate == -70.0
        ws.send_json({"type": "set", "noise_gate_db": -55})
        ws.send_json({"type": "set", "noise_gate_db": 3})
        receive_until(ws, "error")
        assert live.noise_gate == -55.0  # the refused value leaves the gate in place
        ws.send_json({"type": "stop"})
        receive_until(ws, "stopped")
