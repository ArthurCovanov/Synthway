"""AI-nalyzer: the separation process is followed, refused when it must be, and
its stems served or sent to the Analyzer. Demucs is replaced with a fake
script: no model is loaded, nothing is played."""
import os
import sys
import textwrap
import time

import pytest
from fastapi.testclient import TestClient

import main
from separation import Separation, demucs_python
from test_server import FakeCore

# Stands in for synthway-demucs/separate.py, with the same report. What it does
# depends on the uploaded file: FAIL fails, SLOW runs until killed.
FAKE_SEPARATE = textwrap.dedent('''
    import json, sys, time
    from pathlib import Path

    def report(event, **fields):
        print(json.dumps({"event": event, **fields}), flush=True)

    source, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    model = sys.argv[sys.argv.index("--model") + 1]
    data = source.read_bytes()
    print("a line of Demucs' own", flush=True)
    report("loading", model=model, device="cpu")
    report("reading")
    if data.startswith(b"FAIL"):
        print("Traceback: something broke", file=sys.stderr, flush=True)
        report("error", message="LoadAudioError: could not read the file")
        sys.exit(1)
    report("progress", value=0.5)
    if data.startswith(b"SLOW"):
        while True:
            time.sleep(0.05)
    report("saving")
    out_dir.mkdir(parents=True)
    stems = []
    for name in ("drums", "other"):
        (out_dir / f"{name}.wav").write_bytes(b"RIFF" + name.encode() + b"WAVEfmt ")
        stems.append({"name": name, "file": f"{name}.wav", "peaks": [0.5, 0.25]})
    result = {"model": model, "device": "cpu", "sample_rate": 44100, "duration": 1.5, "seconds": 0.1, "stems": stems}
    (out_dir / "result.json").write_text(json.dumps(result))
    report("done", result=str(out_dir / "result.json"))
''')


def eventually(condition, timeout=10.0):
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "condition still false"
        time.sleep(0.02)


@pytest.fixture
def demucs_dir(tmp_path):
    folder = tmp_path / "synthway-demucs"
    folder.mkdir()
    (folder / "separate.py").write_text(FAKE_SEPARATE)
    python = demucs_python(folder)
    python.parent.mkdir(parents=True)
    os.symlink(sys.executable, python)
    return folder


@pytest.fixture
def server(monkeypatch, demucs_dir):
    fake = FakeCore()
    fake.analyzers = []
    separation = Separation(demucs_dir, enabled=True)
    monkeypatch.setattr(main, "core", fake)
    monkeypatch.setattr(main, "analyzers", main.AnalyzerHub())
    monkeypatch.setattr(main, "separation", separation)
    with TestClient(main.app) as client:
        yield client, separation
    separation.stop()


def job(client):
    return client.get("/api/separation").json()["job"]


def test_separation_unavailable_says_why(tmp_path):
    missing = Separation(tmp_path / "nowhere", enabled=True)
    status = missing.status()
    assert not status["available"] and "introuvable" in status["reason"]
    assert status["source"] is None and status["result"] is None

    (tmp_path / "nowhere").mkdir()
    (tmp_path / "nowhere" / "separate.py").write_text("")
    assert "uv sync" in missing.unavailable_reason()

    assert "désactivé" in Separation(tmp_path, enabled=False).unavailable_reason()


def test_separation_refuses_without_demucs(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "separation", Separation(tmp_path / "nowhere", enabled=True))
    with TestClient(main.app) as client:
        assert client.post("/api/separation/source?name=a.mp3", content=b"ID3").status_code == 503
        assert client.post("/api/separation/run", json={"model": "htdemucs"}).status_code == 503


def test_separation_decomposes_and_serves_stems(server):
    client, _ = server
    status = client.get("/api/separation").json()
    assert status["available"] and status["models"] == ["htdemucs", "htdemucs_ft", "htdemucs_6s"]
    assert status["source"] is None and status["job"]["state"] == "idle"
    assert client.post("/api/separation/run", json={"model": "htdemucs"}).status_code == 400  # nothing loaded
    assert client.post("/api/separation/source", content=b"").status_code == 400

    status = client.post("/api/separation/source?name=Chanson été.mp3", content=b"ID3 fake mp3").json()
    assert status["source"] == {"name": "Chanson été.mp3", "size": 12}
    source = client.get("/api/separation/source")
    assert source.content == b"ID3 fake mp3" and source.headers["content-type"] == "audio/mpeg"

    assert client.post("/api/separation/run", json={"model": "unknown"}).status_code == 422
    status = client.post("/api/separation/run", json={"model": "htdemucs_6s"}).json()
    assert status["job"]["state"] == "running" and status["job"]["model"] == "htdemucs_6s"
    eventually(lambda: job(client)["state"] == "done")

    status = client.get("/api/separation").json()
    assert status["job"]["progress"] == 1.0 and status["job"]["device"] == "cpu"
    assert [stem["name"] for stem in status["result"]["stems"]] == ["drums", "other"]
    assert status["result"]["stems"][0]["peaks"] == [0.5, 0.25] and status["result"]["duration"] == 1.5

    wav = client.get("/api/separation/stems/drums.wav")
    assert wav.status_code == 200 and wav.content == b"RIFFdrumsWAVEfmt " and wav.headers["content-type"] == "audio/wav"
    ranged = client.get("/api/separation/stems/drums.wav", headers={"Range": "bytes=0-3"})
    assert ranged.status_code == 206 and ranged.content == b"RIFF"
    download = client.get("/api/separation/stems/other.wav?download=true")
    assert download.headers["content-disposition"] == (
        "attachment; filename=\"Chanson _t_ - other.wav\"; filename*=UTF-8''Chanson%20%C3%A9t%C3%A9%20-%20other.wav"
    )
    assert client.get("/api/separation/stems/vocals.wav").status_code == 404

    # A stem goes to the Analyzer in place of its file
    clip = client.post("/api/separation/stems/other/analyzer").json()
    assert clip["name"] == "Chanson été · other"
    assert client.get("/api/analyzer/clip").json()["name"] == "Chanson été · other"
    assert client.post("/api/separation/stems/vocals/analyzer").status_code == 404

    # A new piece drops the stems of the previous one
    status = client.post("/api/separation/source?name=b.wav", content=b"RIFF").json()
    assert status["result"] is None and status["job"]["state"] == "idle"
    assert client.get("/api/separation/stems/drums.wav").status_code == 404


def test_separation_reports_demucs_errors(server):
    client, _ = server
    client.post("/api/separation/source?name=a.mp3", content=b"FAIL")
    client.post("/api/separation/run", json={"model": "htdemucs"})
    eventually(lambda: job(client)["state"] == "error")
    assert job(client)["error"] == "LoadAudioError: could not read the file"
    assert client.get("/api/separation").json()["result"] is None


def test_separation_can_be_cancelled(server):
    client, _ = server
    client.post("/api/separation/source?name=a.mp3", content=b"SLOW")
    client.post("/api/separation/run", json={"model": "htdemucs"})
    eventually(lambda: job(client)["stage"] == "separating")
    assert job(client)["progress"] == 0.5
    # One at a time, and the piece stays while it runs
    assert client.post("/api/separation/run", json={"model": "htdemucs"}).status_code == 409
    assert client.post("/api/separation/source?name=b.mp3", content=b"ID3").status_code == 409

    client.post("/api/separation/cancel")
    eventually(lambda: job(client)["state"] == "idle")
    assert job(client)["error"] == "Décomposition annulée"
    assert client.get("/api/separation").json()["source"]["name"] == "a.mp3"


def test_separation_comes_back_after_a_restart(server, demucs_dir):
    client, _ = server
    client.post("/api/separation/source?name=a.flac", content=b"fLaC")
    client.post("/api/separation/run", json={"model": "htdemucs"})
    eventually(lambda: job(client)["state"] == "done")

    restarted = Separation(demucs_dir, enabled=True).status()
    assert restarted["source"] == {"name": "a.flac", "size": 4}
    assert restarted["job"]["state"] == "done" and restarted["job"]["model"] == "htdemucs"
    assert [stem["name"] for stem in restarted["result"]["stems"]] == ["drums", "other"]
