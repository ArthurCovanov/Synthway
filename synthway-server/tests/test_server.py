"""Server behaviour checked against fakes of the native core: no audio is ever
produced, no microphone is ever opened."""
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import core_bridge
import main
from core_bridge import CoreError
from models import (
    MAX_PARTIALS, Analysis, AnalysisPartial, ClipTrack, ClipWaveform, DeviceInfo, DeviceTypeEnum, Envelope, Timbre,
    WaveformEnum,
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

    def synthway_engine_set_filter(self, engine, low_cutoff, high_cutoff, resonance):
        self.calls.append(("filter", low_cutoff, high_cutoff, resonance))
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

    # Like the real bridge, the filter is kept even without an engine, and a band it would refuse raises
    filter = (20.0, 20000.0, 0.0)

    def set_filter(self, low_cutoff, cutoff, resonance):
        if not low_cutoff < cutoff:
            raise ValueError("Invalid filter")
        self.filter = (low_cutoff, cutoff, resonance)

    def get_filter(self):
        return self.filter

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
        self.recording = False
        self.recorded_frames = 0

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
        self.stop_recording()  # like the core: a recording in progress is kept
        self.input_open = False

    def analyze_input(self):
        self.recording_info()  # takes what the microphone heard, like the core
        return fake_analysis(440.0)

    def start_recording(self):
        if not self.input_open:
            raise CoreError("Starting the recording failed: Not running (-6)", core_bridge.RESULT_NOT_RUNNING)
        self.recording = True
        self.recorded_frames = 0

    def is_recording(self):
        return self.recording

    def recording_info(self):
        if self.recording:
            self.recorded_frames += 2205  # 50 ms more at 44.1 kHz each time
        return self.recorded_frames, 0

    def stop_recording(self):
        if not self.recording:
            return False
        self.recording_info()
        self.recording = False
        self.clip = (self.recorded_frames, 44100)
        return True

    def save_clip_wav(self, path):
        with open(path, "wb") as file:
            file.write(b"RIFF....WAVEfmt ")

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

    def clip_stereo_overview(self, count):
        return [0.5] * count, [0.25] * count

    def clip_waveform(self, first_frame, frame_count, count):
        # Like the bridge: stopped at the end, never more parts than frames
        frames = self.clip[0]
        if first_frame >= frames:
            raise CoreError("Waveform failed: Invalid parameter (-2)", core_bridge.RESULT_INVALID_PARAM)
        covered = min(frame_count, frames - first_frame)
        count = min(count, covered)
        return ClipWaveform(
            first_frame=first_frame, frame_count=covered,
            left_low=[-0.5] * count, left_high=[0.5] * count, right_low=[-0.25] * count, right_high=[0.25] * count,
        )

    def clip_track(self, count):
        return ClipTrack(frequency=[330.0] * count, clarity=[0.99] * count, level_db=[-9.0] * count)

    def analyze_clip(self, time_s, noise_gate_db=None):
        if noise_gate_db is not None:
            self.set_noise_gate(noise_gate_db)
        self.analyzed = ("moment", time_s)
        return fake_analysis(330.0)

    def analyze_clip_range(self, start_s, end_s, window_s=0.0, noise_gate_db=None, reference_hz=0.0, harmonic_cents=0.0):
        if noise_gate_db is not None:
            self.set_noise_gate(noise_gate_db)
        self.analyzed = ("zone", round(start_s, 6), round(end_s, 6), window_s)
        self.reference = (reference_hz, harmonic_cents)
        return fake_analysis(330.0)

    def measure_envelopes(self, start_s, end_s, window_s=0.0, noise_gate_db=None, reference_hz=0.0, harmonic_cents=0.0):
        self.measured = (round(start_s, 6), round(end_s, 6), window_s, reference_hz, harmonic_cents)
        analysis = fake_analysis(330.0)
        return analysis, [Envelope(attack=0.002, decay=1.5, sustain=0.0, release=0.3, curve=1) for _ in analysis.partials]


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


def test_filter_is_kept_across_engine_restarts():
    lib = FakeLib()
    bridge = bridge_with(lib)
    bridge.set_filter(200.0, 5000.0, 0.3)  # no engine yet
    bridge.start_engine()
    bridge.start_engine()
    applied = [call for call in lib.calls if call[0] == "filter"]
    assert applied == [("filter", 200.0, 5000.0, 0.3)] * 2
    assert lib.calls.index(applied[0]) < lib.calls.index("start")

    # A band the core would refuse is refused before being kept, engine or not
    for band in [(5000.0, 200.0, 0.3), (10.0, 5000.0, 0.3), (200.0, 5000.0, 1.5)]:
        with pytest.raises(ValueError):
            bridge.set_filter(*band)
    assert bridge.get_filter() == (200.0, 5000.0, 0.3)


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


@pytest.mark.parametrize("path", ["/ws/synth", "/ws/analyzer"])
def test_websockets_refuse_other_websites(server, path):
    # CORS does not cover WebSockets: the server checks their origin itself
    client, fake = server
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect(path, headers={"Origin": "https://example.com"}):
            pass
    assert refused.value.code == 1008
    assert fake.calls == [] and fake.analyzers == []
    # Pages served by this machine, and programs (no Origin header), get in
    for headers in ({"Origin": "http://127.0.0.1:5173"}, {}):
        with client.websocket_connect(path, headers=headers):
            pass


def test_health_without_core(monkeypatch):
    monkeypatch.setattr(main, "core", None)
    with TestClient(main.app) as client:
        assert client.get("/health").json() == {"status": "ok", "core_loaded": False, "core_version": None}


def test_envelope_route_validates_and_applies(server):
    client, fake = server
    envelope = {"attack": 0.2, "decay": 0.1, "sustain": 0.6, "release": 0.8, "curve": 0}
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


def test_filter_bounds_are_updated_separately(server):
    client, fake = server
    with client.websocket_connect("/ws/synth") as ws:
        ws.send_json({"type": "set_param", "cutoff": 5000.0})  # the other settings are kept
        ws.receive_json()
        assert fake.filter == (20.0, 5000.0, 0.0)
        ws.send_json({"type": "set_param", "low_cutoff": 6000.0})  # above the upper bound
        assert "error" in ws.receive_json()
    assert client.post("/api/synth/tone", json={"low_cutoff": 200.0, "resonance": 0.4}).status_code == 200
    assert fake.filter == (200.0, 5000.0, 0.4)
    assert client.post("/api/synth/tone", json={"cutoff": 100.0}).status_code == 422
    assert fake.filter == (200.0, 5000.0, 0.4)


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
            {"ratio": 1.0, "amplitude": 0.8, "waveform": 0, "envelope": {"attack": 0.01, "decay": 0.2, "sustain": 0.5, "release": 0.3, "curve": 0}},
            {"ratio": 2.76, "amplitude": 0.3, "waveform": 3, "envelope": {"attack": 0.0, "decay": 0.1, "sustain": 0.0, "release": 0.1, "curve": 1}},
        ]
    }
    assert client.post("/api/synth/timbre", json=timbre).json() == timbre
    assert fake.timbre == Timbre(**timbre)
    status = client.get("/api/engine/status").json()
    assert status["timbre"] == timbre
    assert status["max_partials"] == MAX_PARTIALS
    assert status["sample_rate"] is None  # no engine running

    bad_partials = [{"ratio": 0}, {"ratio": 1001}, {"amplitude": 1.5}, {"waveform": 4}, {"envelope": {"sustain": 2}}, {"envelope": {"curve": 2}}]
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


def eventually(condition, timeout=2.0):
    """Waits for condition: when a page leaves, the test client cancels the
    server's task, whose cleanup then ends in a worker thread, a little later."""
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "condition still false"
        time.sleep(0.01)


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

    wav = client.get("/api/analyzer/clip.wav")
    assert wav.status_code == 200 and wav.headers["accept-ranges"] == "bytes"
    assert wav.content.startswith(b"RIFF")
    ranged = client.get("/api/analyzer/clip.wav", headers={"Range": "bytes=0-3"})
    assert ranged.status_code == 206
    assert ranged.headers["content-range"] == f"bytes 0-3/{len(wav.content)}"
    assert ranged.content == b"RIFF"


def test_clip_waveform_of_a_part(server):
    client, _ = server
    assert client.get("/api/analyzer/clip/waveform?first=0&frames=10&count=10").status_code == 404
    client.post("/api/analyzer/clip", content=b"RIFF")  # 72000 frames
    part = client.get("/api/analyzer/clip/waveform?first=1000&frames=4800&count=800").json()
    assert (part["first_frame"], part["frame_count"], len(part["left_low"])) == (1000, 4800, 800)
    assert part["left_high"][0] == 0.5 and part["right_low"][0] == -0.25
    # Stopped at the end of the file, never more parts than frames
    end = client.get("/api/analyzer/clip/waveform?first=71990&frames=100&count=800").json()
    assert (end["frame_count"], len(end["right_high"])) == (10, 10)
    assert client.get("/api/analyzer/clip/waveform?first=72000&frames=10&count=10").status_code == 422
    assert client.get("/api/analyzer/clip/waveform?first=0&frames=10&count=0").status_code == 422
    assert client.get(f"/api/analyzer/clip/waveform?first=0&frames=10&count={main.CLIP_WAVEFORM_MAX_PARTS + 1}").status_code == 422


def test_clip_wav_payload_supports_ranges():
    wav = b"RIFF....WAVEfmt "

    status, headers, body = main.clip_wav_payload(wav, "bytes=4-7")
    assert status == 206
    assert headers["Content-Range"] == f"bytes 4-7/{len(wav)}"
    assert body == b"...."

    status, headers, body = main.clip_wav_payload(wav, "bytes=-4")
    assert status == 206
    assert headers["Content-Range"] == f"bytes {len(wav) - 4}-{len(wav) - 1}/{len(wav)}"
    assert body == wav[-4:]

    status, headers, body = main.clip_wav_payload(wav, f"bytes={len(wav)}-")
    assert status == 416
    assert headers["Content-Range"] == f"bytes */{len(wav)}"
    assert body == b""


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
    eventually(lambda: not fake.analyzers[0].input_open)
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


def test_analysis_window_and_zone(server):
    client, fake = server
    client.post("/api/analyzer/clip", content=b"RIFF")
    clip_analyzer = fake.analyzers[-1]
    url = "/api/analyzer/clip/analysis"
    assert client.get(f"{url}?time=0.5").status_code == 200
    assert clip_analyzer.analyzed == ("moment", 0.5)  # the usual window, as before
    assert client.get(f"{url}?time=0.5&window_ms=50").status_code == 200
    assert clip_analyzer.analyzed == ("zone", 0.475, 0.525, 0.05)  # the moment through a 50 ms window
    assert client.get(f"{url}?start=0.2&end=1.0&window_ms=170").json()["frequency"] == 330.0
    assert clip_analyzer.analyzed == ("zone", 0.2, 1.0, 0.17)
    assert clip_analyzer.reference == (0.0, 0.0)  # the note heard, every partial
    assert client.get(f"{url}?start=0.2&end=1.0&window_ms=170&reference_hz=49&harmonic_cents=30").status_code == 200
    assert clip_analyzer.reference == (49.0, 30.0)
    # A note given at a moment with the usual window: the zone of 170 ms around it
    assert client.get(f"{url}?time=0.5&reference_hz=98").status_code == 200
    assert clip_analyzer.analyzed == ("zone", 0.415, 0.585, 0.0) and clip_analyzer.reference == (98.0, 0.0)
    for query in (
        "", "start=0.2", "start=1&end=0.5", "start=1&end=1", "time=0.5&window_ms=5", "time=0.5&window_ms=600",
        "time=0.5&reference_hz=10", "time=0.5&reference_hz=6000", "time=0.5&harmonic_cents=150", "time=0.5&harmonic_cents=-1",
    ):
        assert client.get(f"{url}?{query}").status_code == 422, query

    # The recording, the same way
    with client.websocket_connect("/ws/analyzer") as ws:
        ws.send_json({"type": "start"})
        receive_until(ws, "started")
        ws.send_json({"type": "record"})
        receive_until(ws, "recording")
        ws.send_json({"type": "stop"})
        receive_until(ws, "recorded")
        receive_until(ws, "stopped")
    assert client.get("/api/analyzer/recording/analysis?start=0&end=0.05&window_ms=20").status_code == 200
    assert fake.analyzers[-1].analyzed == ("zone", 0.0, 0.05, 0.02)  # the microphone's analyzer, created last


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


def test_recording_the_microphone(server):
    client, fake = server
    with client.websocket_connect("/ws/analyzer") as ws:
        ws.send_json({"type": "start"})
        receive_until(ws, "started")
        ws.send_json({"type": "record"})
        receive_until(ws, "recording")
        message = ws.receive_json()
        assert message["type"] == "analysis" and message["recording"]["duration"] > 0
        assert client.get("/api/analyzer/recording").json() is None  # not while recording
        ws.send_json({"type": "stop_record"})
        recorded = receive_until(ws, "recorded")
        assert recorded["duration"] > 0 and recorded["lost"] == 0
        live = fake.analyzers[0]
        assert live.input_open and not live.recording  # the microphone keeps listening
        ws.send_json({"type": "stop"})
        receive_until(ws, "stopped")

    recording = client.get("/api/analyzer/recording").json()
    assert recording["name"] == "Enregistrement" and recording["sample_rate"] == 44100
    assert recording["duration"] == pytest.approx(recorded["duration"], abs=0.001)
    assert client.get("/api/analyzer/recording/analysis?time=0.05&noise_gate_db=-60").json()["frequency"] == 330.0
    assert live.noise_gate == -60.0
    wav = client.get("/api/analyzer/recording.wav")
    assert wav.status_code == 200 and wav.headers["content-type"] == "audio/wav"
    assert wav.content.startswith(b"RIFF")
    assert wav.headers["content-disposition"].startswith('attachment; filename="synthway-')
    # The page plays it too, and seeks in it
    assert wav.headers["accept-ranges"] == "bytes"
    ranged = client.get("/api/analyzer/recording.wav", headers={"Range": "bytes=4-"})
    assert ranged.status_code == 206 and ranged.content == wav.content[4:]
    assert ranged.headers["content-range"] == f"bytes 4-{len(wav.content) - 1}/{len(wav.content)}"
    waveform = client.get(f"/api/analyzer/recording/waveform?first=0&frames={recording['frame_count']}&count=100").json()
    assert waveform["frame_count"] == recording["frame_count"] and len(waveform["left_low"]) == 100
    assert client.get("/api/analyzer/clip").json() is None  # the loaded file is another thing


def test_recording_needs_the_microphone(server):
    client, _ = server
    assert client.get("/api/analyzer/recording").json() is None
    assert client.get("/api/analyzer/recording/analysis?time=0").status_code == 404
    assert client.get("/api/analyzer/recording.wav").status_code == 404
    assert client.get("/api/analyzer/recording/waveform?first=0&frames=1&count=1").status_code == 404
    with client.websocket_connect("/ws/analyzer") as ws:
        ws.send_json({"type": "record"})
        assert "pas ouvert" in ws.receive_json()["error"]
        ws.send_json({"type": "stop_record"})
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"type": "start"})
        receive_until(ws, "started")
        ws.send_json({"type": "stop_record"})  # listening, but not recording
        receive_until(ws, "error")


def test_recording_kept_when_the_microphone_closes(server):
    client, fake = server
    with client.websocket_connect("/ws/analyzer") as ws:
        ws.send_json({"type": "start"})
        receive_until(ws, "started")
        ws.send_json({"type": "record"})
        receive_until(ws, "recording")
        ws.send_json({"type": "stop"})
        receive_until(ws, "recorded")
        receive_until(ws, "stopped")
    assert not fake.analyzers[0].input_open
    assert client.get("/api/analyzer/recording").json()["duration"] > 0

    # Also when the page leaves in the middle of a recording
    with client.websocket_connect("/ws/analyzer") as ws:
        ws.send_json({"type": "start"})
        receive_until(ws, "started")
        ws.send_json({"type": "record"})
        receive_until(ws, "recording")
    eventually(lambda: not fake.analyzers[0].input_open)
    assert client.get("/api/analyzer/recording").json()["duration"] > 0


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


def test_note_envelopes(server):
    client, fake = server
    client.post("/api/analyzer/clip", content=b"RIFF")
    clip_analyzer = fake.analyzers[-1]
    url = "/api/analyzer/clip/envelopes"
    body = client.get(f"{url}?start=0.2&end=0.6&window_ms=120&reference_hz=330&harmonic_cents=30").json()
    assert body["analysis"]["frequency"] == 330.0
    assert body["envelopes"] == [{"attack": 0.002, "decay": 1.5, "sustain": 0.0, "release": 0.3, "curve": 1}]
    assert clip_analyzer.measured == (0.2, 0.6, 0.12, 330.0, 30.0)
    for query in ("start=0.6&end=0.2", "end=0.5", "start=0.2&end=0.6&window_ms=5", "start=0.2&end=0.6&reference_hz=6000"):
        assert client.get(f"{url}?{query}").status_code == 422, query
    assert client.get("/api/analyzer/recording/envelopes?start=0&end=1").status_code == 404  # no recording
