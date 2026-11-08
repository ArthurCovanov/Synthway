"""
Synthway Server - FastAPI & WebSocket application exposing synthway-core.
Can be run directly via:
    python main.py
or:
    uvicorn main:app --reload --port 18741
or, once installed (pip install .):
    synthway-server

Environment:
    SYNTHWAY_HOST      listening address (default 127.0.0.1: this machine only)
    SYNTHWAY_PORT      listening port (default 18741, an uncommon port: 8000 is
                       often taken by other dev tools). Not read by uvicorn itself.
    SYNTHWAY_CORE_LIB  path to synthway.dll / libsynthway.so (default: found in synthway-core/build)
"""

import asyncio
import json
import logging
import math
import os
import sys
from typing import Optional

try:
    from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware
    import uvicorn
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False

try:  # run from src/ (uvicorn main:app, python main.py)
    from core_bridge import (
        NOISE_GATE_OFF, RESULT_FORMAT_ERROR, RESULT_INVALID_PARAM, Analyzer, CoreError, SynthwayCore, DeviceTypeEnum,
    )
    from models import (
        Analysis,
        ClipResponse,
        DeviceListResponse,
        EngineConfigRequest,
        EngineStatusResponse,
        Envelope,
        Timbre,
        ToneControlRequest,
        WaveformEnum,
    )
except ImportError:  # installed package (synthway-server command)
    from .core_bridge import (
        NOISE_GATE_OFF, RESULT_FORMAT_ERROR, RESULT_INVALID_PARAM, Analyzer, CoreError, SynthwayCore, DeviceTypeEnum,
    )
    from .models import (
        Analysis,
        ClipResponse,
        DeviceListResponse,
        EngineConfigRequest,
        EngineStatusResponse,
        Envelope,
        Timbre,
        ToneControlRequest,
        WaveformEnum,
    )

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("synthway-server")

# Instantiate native bridge
try:
    core = SynthwayCore()
    logger.info(f"Loaded Synthway Core version: {core.get_version()}")
except Exception as e:
    logger.warning(f"Could not load native synthway-core library: {e}")
    core = None


# Analyzer: an uploaded file goes to the core whole, at once (never streamed);
# the microphone is read by the core, only analysis results leave it
MAX_CLIP_UPLOAD_BYTES = 256 * 1024 * 1024  # a 10-minute WAV, 48 kHz stereo 16 bits, is 115 MB
CLIP_OVERVIEW_POINTS = 1000
CLIP_TRACK_STEP_S = 0.02  # one note every 20 ms along a file...
CLIP_TRACK_MAX_POINTS = 1000  # ...at most 1000 of them
LIVE_INTERVAL_S = 0.05  # 20 analyses per second from the microphone


class AnalyzerHub:
    """The server's two analyzers, created on first use: one for the
    microphone, one for the loaded file, so that decoding a long file never
    holds the live analysis up. One page listens to the microphone at a time."""

    def __init__(self):
        self._live: Optional[Analyzer] = None
        self._clip: Optional[Analyzer] = None
        self.clip_name: Optional[str] = None
        self.listener = None  # the WebSocket listening to the microphone

    def live(self) -> Analyzer:
        if self._live is None:
            self._live = core.create_analyzer()
        return self._live

    def clip(self) -> Analyzer:
        if self._clip is None:
            self._clip = core.create_analyzer()
        return self._clip


analyzers = AnalyzerHub()


def clip_response(analyzer: Analyzer, name: str) -> ClipResponse:
    """The loaded file for display: waveform and note track (blocking: call it in a thread)."""
    frames, rate = analyzer.clip_info()
    duration = frames / rate
    track_points = max(1, min(CLIP_TRACK_MAX_POINTS, math.ceil(duration / CLIP_TRACK_STEP_S)))
    return ClipResponse(
        name=name,
        duration=duration,
        sample_rate=rate,
        frame_count=frames,
        overview=analyzer.clip_overview(max(1, min(CLIP_OVERVIEW_POINTS, frames))),
        track=analyzer.clip_track(track_points),
    )


if HAS_FASTAPI:
    app = FastAPI(
        title="Synthway Server API",
        description="REST & WebSocket API orchestrating the Synthway audio engine",
        version="0.1.0",
    )

    # The UI reaches the API through the Vite proxy (same origin). Direct
    # cross-origin calls are only accepted from pages served by this machine,
    # so that no other website can drive the audio engine.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$",
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "core_loaded": core is not None,
            "core_version": core.get_version() if core else None,
        }

    @app.get("/api/devices", response_model=DeviceListResponse)
    async def get_devices():
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        # Enumeration opens its own audio contexts and takes a while: keep it off
        # the event loop (it does not touch the engine, so a thread is safe)
        playback = await asyncio.to_thread(core.list_devices, DeviceTypeEnum.PLAYBACK)
        capture = await asyncio.to_thread(core.list_devices, DeviceTypeEnum.CAPTURE)
        return DeviceListResponse(playback_devices=playback, capture_devices=capture)

    @app.post("/api/engine/start")
    async def start_engine(config: Optional[EngineConfigRequest] = None):
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        cfg = config or EngineConfigRequest()
        success = core.start_engine(
            sample_rate=cfg.sample_rate,
            channels=cfg.channels,
            device_index=cfg.device_index,
        )
        return {"running": success}

    @app.post("/api/engine/stop")
    async def stop_engine():
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        core.stop_engine()
        return {"running": False}

    @app.get("/api/engine/status", response_model=EngineStatusResponse)
    async def get_status():
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        return EngineStatusResponse(
            is_running=core.is_running(),
            is_tone_enabled=core.is_tone_enabled(),
            frequency=core.get_frequency(),
            volume=core.get_volume(),
            waveform=core.get_waveform(),
            envelope=core.get_envelope(),
            timbre=core.get_timbre(),
            max_partials=core.get_max_partials(),
            sample_rate=core.get_sample_rate(),
            core_version=core.get_version(),
        )

    @app.post("/api/synth/tone")
    async def set_tone(tone: ToneControlRequest):
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        if tone.frequency is not None:
            core.set_frequency(tone.frequency)
        if tone.volume is not None:
            core.set_volume(tone.volume)
        if tone.waveform is not None:
            core.set_waveform(tone.waveform)
        if tone.enabled is not None:
            core.set_tone_enabled(tone.enabled)
        return {
            "frequency": core.get_frequency(),
            "volume": core.get_volume(),
            "waveform": int(core.get_waveform()),
            "enabled": core.is_tone_enabled(),
        }

    @app.post("/api/synth/envelope", response_model=Envelope)
    async def set_envelope(envelope: Envelope):
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        core.set_envelope(envelope)
        return core.get_envelope()

    @app.post("/api/synth/timbre", response_model=Timbre)
    async def set_timbre(timbre: Timbre):
        """Partials that play every note instead of the single oscillator, kept across engine restarts."""
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        try:
            core.set_timbre(timbre)
        except RuntimeError as ex:
            raise HTTPException(status_code=422, detail=str(ex)) from ex
        return core.get_timbre()

    @app.delete("/api/synth/timbre")
    async def clear_timbre():
        """Back to the single oscillator (waveform and envelope)."""
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        core.set_timbre(None)
        return {"timbre": None}

    @app.websocket("/ws/synth")
    async def websocket_synth_endpoint(websocket: WebSocket):
        """
        Real-time bidirectional WebSocket channel for low latency synthesizer control.
        Supported JSON messages:
          - {"type": "note_on", "frequency": 440.0, "volume": 0.5}
          - {"type": "note_off"}
          - {"type": "set_param", "frequency": 523.25, "volume": 0.3, "waveform": 1,
             "envelope": {"attack": 0.01, "decay": 0.2, "sustain": 0.7, "release": 0.3},
             "timbre": {"partials": [{"ratio": 1, "amplitude": 0.8, "waveform": 0,
                                      "envelope": {...}}, ...]}}
            ("timbre": null goes back to the single oscillator: waveform and envelope)
        An invalid message gets {"error": ...} back; the connection stays open.
        """
        await websocket.accept()
        logger.info("WebSocket client connected to /ws/synth")
        try:
            while True:
                data = await websocket.receive_text()

                if not core:
                    await websocket.send_json({"error": "Core not loaded"})
                    continue

                try:
                    msg = json.loads(data)
                    action = msg.get("type")

                    if action == "note_on":
                        freq = msg.get("frequency", 440.0)
                        vol = msg.get("volume", 0.3)
                        # Start first: before that there is no engine to set the note on
                        if not core.is_running():
                            core.start_engine()
                        core.set_frequency(float(freq))
                        core.set_volume(float(vol))
                        core.set_tone_enabled(True)
                    elif action == "note_off":
                        core.set_tone_enabled(False)
                    elif action == "set_param":
                        if "frequency" in msg:
                            core.set_frequency(float(msg["frequency"]))
                        if "volume" in msg:
                            core.set_volume(float(msg["volume"]))
                        if "waveform" in msg:
                            core.set_waveform(WaveformEnum(int(msg["waveform"])))
                        if "envelope" in msg:
                            core.set_envelope(Envelope(**msg["envelope"]))
                        if "timbre" in msg:
                            timbre = msg["timbre"]
                            core.set_timbre(None if timbre is None else Timbre(**timbre))
                        if "enabled" in msg:
                            core.set_tone_enabled(bool(msg["enabled"]))
                except (ValueError, TypeError, AttributeError, RuntimeError) as ex:
                    # Includes invalid JSON, pydantic validation errors and values refused by the core
                    await websocket.send_json({"error": f"Invalid message: {ex}"})
                    continue

                # Send back current state
                await websocket.send_json({
                    "frequency": core.get_frequency(),
                    "volume": core.get_volume(),
                    "waveform": int(core.get_waveform()),
                    "running": core.is_running(),
                    "enabled": core.is_tone_enabled(),
                })
        except WebSocketDisconnect:
            logger.info("WebSocket client disconnected")
        except Exception as ex:
            logger.error(f"WebSocket error: {ex}")

    # ---------- Analyzer: displays, never plays nor records ----------

    @app.post("/api/analyzer/clip", response_model=ClipResponse)
    async def load_clip(request: Request, name: str = Query(default="son", max_length=200)):
        """Loads an audio file (WAV, FLAC, MP3), sent as the raw request body, in place of the previous one."""
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        data = await request.body()
        if not data:
            raise HTTPException(status_code=400, detail="Fichier vide")
        if len(data) > MAX_CLIP_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"Fichier trop gros ({MAX_CLIP_UPLOAD_BYTES // 2**20} Mo au plus)")
        analyzer = analyzers.clip()
        analyzers.clip_name = None
        try:
            await asyncio.to_thread(analyzer.load_clip_bytes, data)
        except CoreError as ex:
            if ex.code == RESULT_FORMAT_ERROR:
                raise HTTPException(status_code=415, detail="Format audio non reconnu (WAV, FLAC ou MP3)") from ex
            if ex.code == RESULT_INVALID_PARAM:
                raise HTTPException(status_code=413, detail="Fichier trop long (10 minutes au plus)") from ex
            raise HTTPException(status_code=422, detail=str(ex)) from ex
        analyzers.clip_name = name
        return await asyncio.to_thread(clip_response, analyzer, name)

    @app.get("/api/analyzer/clip", response_model=Optional[ClipResponse])
    async def get_clip():
        """The file loaded last, to show it again (after a page reload for instance); null when none."""
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        if analyzers.clip_name is None:
            return None
        return await asyncio.to_thread(clip_response, analyzers.clip(), analyzers.clip_name)

    @app.get("/api/analyzer/clip/analysis", response_model=Analysis)
    async def analyze_clip(
        time: float = Query(ge=0.0, description="Seconds from the start of the file"),
        noise_gate_db: float = Query(
            default=NOISE_GATE_OFF, ge=NOISE_GATE_OFF, le=0.0,
            description="Peaks below this level (dBFS) are ignored as ambient noise; -120: none",
        ),
    ):
        """The note, the partials and the spectrum of the loaded file around time."""
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        if analyzers.clip_name is None:
            raise HTTPException(status_code=404, detail="Aucun fichier chargé")
        return await asyncio.to_thread(analyzers.clip().analyze_clip, time, noise_gate_db)

    @app.websocket("/ws/analyzer")
    async def websocket_analyzer_endpoint(websocket: WebSocket):
        """
        Live analysis of the microphone. The core listens and analyzes; only the
        results go out, LIVE_INTERVAL_S apart. Nothing is recorded.
        From the page:
          - {"type": "start", "device_index": -1, "sample_rate": 0, "noise_gate_db": -120}
            opens the capture device (-1: the system's; sample rate 0: the device's own)
          - {"type": "set", "noise_gate_db": -70}
            peaks below this level (dBFS) are ignored as ambient noise; -120 (the default): none
          - {"type": "stop"}
        To the page:
          - {"type": "started", "device_index": -1, "sample_rate": 48000, "exclusive": true}
            (exclusive: without the system's audio effects, which fade a held note; false: shared mode)
          - {"type": "analysis", "analysis": {...}}   (see the Analysis model)
          - {"type": "stopped"}
          - {"type": "error", "error": "..."}
        The microphone closes when the page stops or disconnects. One page listens at a time.
        """
        await websocket.accept()
        send_lock = asyncio.Lock()
        stream: Optional[asyncio.Task] = None

        async def send(message: dict):
            async with send_lock:
                await websocket.send_json(message)

        async def stream_analyses(analyzer: Analyzer):
            try:
                while True:
                    analysis = await asyncio.to_thread(analyzer.analyze_input)
                    await send({"type": "analysis", "analysis": analysis.model_dump()})
                    await asyncio.sleep(LIVE_INTERVAL_S)
            except CoreError as ex:
                await send({"type": "error", "error": str(ex)})
            except Exception as ex:
                # Not silently: a stream that stops leaves the page showing its last analysis
                logger.error(f"Live analysis stopped: {ex}")
                try:
                    await send({"type": "error", "error": f"Analyse interrompue : {ex}"})
                except Exception:
                    pass

        async def stop_listening():
            nonlocal stream
            if stream is not None:
                stream.cancel()
                try:
                    await stream
                except (asyncio.CancelledError, Exception):
                    pass
                stream = None
            if analyzers.listener is websocket:
                analyzers.listener = None
                await asyncio.to_thread(analyzers.live().close_input)
                logger.info("Microphone closed")

        try:
            while True:
                data = await websocket.receive_text()
                if not core:
                    await send({"type": "error", "error": "Core not loaded"})
                    continue
                try:
                    msg = json.loads(data)
                    action = msg.get("type")
                    if action == "start":
                        if analyzers.listener is not None and analyzers.listener is not websocket:
                            await send({"type": "error", "error": "Le micro est déjà écouté par une autre page"})
                            continue
                        device_index = int(msg.get("device_index", -1))
                        sample_rate = int(msg.get("sample_rate", 0))
                        noise_gate_db = float(msg.get("noise_gate_db", NOISE_GATE_OFF))
                        await stop_listening()  # another device: closes the previous one first
                        analyzer = analyzers.live()
                        await asyncio.to_thread(analyzer.set_noise_gate, noise_gate_db)
                        rate, exclusive = await asyncio.to_thread(analyzer.open_input, device_index, sample_rate)
                        analyzers.listener = websocket
                        mode = "exclusive" if exclusive else "shared"
                        logger.info(f"Microphone {device_index} open at {rate} Hz, {mode} mode")
                        await send({
                            "type": "started", "device_index": device_index, "sample_rate": rate, "exclusive": exclusive,
                        })
                        stream = asyncio.create_task(stream_analyses(analyzer))
                    elif action == "set":
                        if "noise_gate_db" in msg:
                            await asyncio.to_thread(analyzers.live().set_noise_gate, float(msg["noise_gate_db"]))
                    elif action == "stop":
                        await stop_listening()
                        await send({"type": "stopped"})
                    else:
                        await send({"type": "error", "error": f"Unknown message type: {action}"})
                except (ValueError, TypeError, AttributeError, RuntimeError) as ex:
                    # Includes invalid JSON and a microphone the core cannot open
                    await send({"type": "error", "error": str(ex)})
        except WebSocketDisconnect:
            logger.info("WebSocket client disconnected from /ws/analyzer")
        except Exception as ex:
            logger.error(f"WebSocket error: {ex}")
        finally:
            await stop_listening()


def run_standalone_cli():
    """Fallback interactive CLI if FastAPI or Uvicorn is not yet installed."""
    print("===============================================================")
    print("             Synthway Server (Python CLI Mode)                ")
    print("===============================================================")
    if not core:
        print("[!] Error: synthway-core native library could not be loaded.")
        sys.exit(1)

    print(f"[*] Core Version: {core.get_version()}")
    print("\n--- Audio Playback Devices ---")
    playbacks = core.list_devices(DeviceTypeEnum.PLAYBACK)
    for p in playbacks:
        print(f"  [{p.index}] {p.name} {'[DEFAULT]' if p.is_default else ''}")

    print("\n--- Audio Capture Devices ---")
    captures = core.list_devices(DeviceTypeEnum.CAPTURE)
    for c in captures:
        print(f"  [{c.index}] {c.name} {'[DEFAULT]' if c.is_default else ''}")

    print("\n[*] Starting audio playback test for 1.5s...")
    core.start_engine()
    core.set_frequency(440.0)
    core.set_volume(0.20)
    core.set_waveform(WaveformEnum.SINE)
    core.set_tone_enabled(True)
    import time
    time.sleep(1.5)
    core.stop_engine()
    print("[*] Playback test completed cleanly!")


def start():
    if HAS_FASTAPI:
        # 127.0.0.1 by default: exposing the engine to the network is an explicit choice
        uvicorn.run(
            app,
            host=os.environ.get("SYNTHWAY_HOST", "127.0.0.1"),
            port=int(os.environ.get("SYNTHWAY_PORT", "18741")),
        )
    else:
        print("[!] FastAPI and Uvicorn not installed. Running Python standalone CLI mode.")
        print("[*] Install dependencies with: pip install -r requirements.txt")
        run_standalone_cli()


if __name__ == "__main__":
    start()
