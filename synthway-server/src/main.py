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
    SYNTHWAY_DEMUCS, SYNTHWAY_DEMUCS_DIR  the AI-nalyzer's Demucs (see separation.py)
"""

import asyncio
import json
import logging
import math
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import quote

try:
    import anyio  # FastAPI's own async layer
    from fastapi import Body, FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware
    import uvicorn
    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False

try:  # run from src/ (uvicorn main:app, python main.py)
    from core_bridge import (
        MAX_HARMONIC_CENTS, MAX_REFERENCE_HZ, MAX_WINDOW_S, MIN_REFERENCE_HZ, MIN_WINDOW_S, NOISE_GATE_OFF,
        RESULT_FORMAT_ERROR, RESULT_INVALID_PARAM, Analyzer, CoreError,
        SynthwayCore, DeviceTypeEnum,
    )
    from models import (
        Analysis,
        ClipResponse,
        ClipWaveform,
        DeviceListResponse,
        EngineConfigRequest,
        EngineStatusResponse,
        EnvelopeAnalysis,
        Envelope,
        Timbre,
        ToneControlRequest,
        WaveformEnum,
    )
    from separation import SeparationError, separation
except ImportError:  # installed package (synthway-server command)
    from .core_bridge import (
        MAX_HARMONIC_CENTS, MAX_REFERENCE_HZ, MAX_WINDOW_S, MIN_REFERENCE_HZ, MIN_WINDOW_S, NOISE_GATE_OFF,
        RESULT_FORMAT_ERROR, RESULT_INVALID_PARAM, Analyzer, CoreError,
        SynthwayCore, DeviceTypeEnum,
    )
    from .models import (
        Analysis,
        ClipResponse,
        ClipWaveform,
        DeviceListResponse,
        EngineConfigRequest,
        EngineStatusResponse,
        EnvelopeAnalysis,
        Envelope,
        Timbre,
        ToneControlRequest,
        WaveformEnum,
    )
    from .separation import SeparationError, separation

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
# the microphone is read and recorded by the core, only analysis results leave
# it (and the recording, as a WAV file, when the page downloads it)
MAX_CLIP_UPLOAD_BYTES = 256 * 1024 * 1024  # a 10-minute WAV, 48 kHz stereo 16 bits, is 115 MB
CLIP_OVERVIEW_POINTS = 1000
CLIP_TRACK_STEP_S = 0.02  # one note every 20 ms along a file...
CLIP_TRACK_MAX_POINTS = 1000  # ...at most 1000 of them
CLIP_WAVEFORM_MAX_PARTS = 8192  # a zoomed waveform: about one part per pixel column of the page
LIVE_INTERVAL_S = 0.05  # 20 analyses per second from the microphone (they also feed the recording)
RECORDING_NAME = "Enregistrement"
# A moment with the usual window is the zone of that length around it (the core's window is at least as long)
ANALYSIS_USUAL_WINDOW_S = 0.17


class AnalyzerHub:
    """The server's two analyzers, created on first use: one for the
    microphone, one for the loaded file, so that decoding a long file never
    holds the live analysis up. One page listens to the microphone at a time.
    The microphone's recording becomes the clip of the live analyzer, apart
    from the loaded file."""

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

    def recording(self) -> Optional[Analyzer]:
        """The live analyzer once it holds a finished recording, else None (blocking: call it in a thread)."""
        live = self._live
        if live is None or live.is_recording() or live.clip_info()[0] == 0:
            return None
        return live


analyzers = AnalyzerHub()


def clip_response(analyzer: Analyzer, name: str) -> ClipResponse:
    """The loaded file for display: waveform and note track (blocking: call it in a thread)."""
    frames, rate = analyzer.clip_info()
    duration = frames / rate
    track_points = max(1, min(CLIP_TRACK_MAX_POINTS, math.ceil(duration / CLIP_TRACK_STEP_S)))
    overview_count = max(1, min(CLIP_OVERVIEW_POINTS, frames))
    overview_left, overview_right = analyzer.clip_stereo_overview(overview_count)
    return ClipResponse(
        name=name,
        duration=duration,
        sample_rate=rate,
        frame_count=frames,
        overview=analyzer.clip_overview(overview_count),
        overview_left=overview_left,
        overview_right=overview_right,
        track=analyzer.clip_track(track_points),
    )


def clip_wav_bytes(analyzer: Analyzer) -> bytes:
    """The analyzer's clip (a loaded file or a recording) as a WAV file written by the core
    (blocking: call it in a thread)."""
    handle, path = tempfile.mkstemp(prefix="synthway-", suffix=".wav")
    os.close(handle)
    try:
        analyzer.save_clip_wav(path)
        with open(path, "rb") as file:
            return file.read()
    finally:
        os.remove(path)


def clip_wav_payload(data: bytes, range_header: Optional[str]):
    """Return a WAV response payload with optional byte-range support."""
    headers = {"Accept-Ranges": "bytes", "Content-Disposition": "inline"}
    if not range_header or not range_header.startswith("bytes=") or "," in range_header:
        return 200, headers, data

    requested = range_header[6:]
    start_text, separator, end_text = requested.partition("-")
    if not separator:
        return 200, headers, data
    try:
        if start_text:
            start = int(start_text)
            end = int(end_text) if end_text else len(data) - 1
        else:
            suffix_length = int(end_text)
            if suffix_length <= 0:
                raise ValueError
            start = max(0, len(data) - suffix_length)
            end = len(data) - 1
    except ValueError:
        return 200, headers, data

    if start < 0 or start >= len(data) or end < start:
        return 416, {**headers, "Content-Range": f"bytes */{len(data)}"}, b""

    end = min(end, len(data) - 1)
    return (
        206,
        {**headers, "Content-Range": f"bytes {start}-{end}/{len(data)}"},
        data[start:end + 1],
    )


if HAS_FASTAPI:
    app = FastAPI(
        title="Synthway Server API",
        description="REST & WebSocket API orchestrating the Synthway audio engine",
        version="0.1.0",
    )

    # The UI calls the API directly, from its own origin (the Vite dev server).
    # Cross-origin calls are only accepted from pages served by this machine,
    # so that no other website can drive the audio engine.
    LOCAL_ORIGIN = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=LOCAL_ORIGIN,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    async def accept_local(websocket: WebSocket) -> bool:
        """
        Accepts a WebSocket from a page served by this machine, or from a program
        (no Origin header: browsers always send one). CORS does not cover
        WebSockets: without this, any website open in the browser could play
        notes or open the microphone. False when refused (closed, HTTP 403).
        """
        origin = websocket.headers.get("origin")
        if origin is not None and not re.match(LOCAL_ORIGIN, origin):
            logger.warning(f"WebSocket {websocket.url.path} refused from origin {origin}")
            await websocket.close(code=1008)
            return False
        await websocket.accept()
        return True

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
        if tone.low_cutoff is not None or tone.cutoff is not None or tone.resonance is not None:
            low_cutoff, cutoff, resonance = core.get_filter()
            try:
                core.set_filter(tone.low_cutoff if tone.low_cutoff is not None else low_cutoff,
                                tone.cutoff if tone.cutoff is not None else cutoff,
                                tone.resonance if tone.resonance is not None else resonance)
            except (ValueError, RuntimeError) as ex:
                raise HTTPException(status_code=422, detail=str(ex)) from ex
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
        if not await accept_local(websocket):
            return
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
                        if "low_cutoff" in msg or "cutoff" in msg or "resonance" in msg:
                            low_cutoff, cutoff, resonance = core.get_filter()
                            core.set_filter(float(msg.get("low_cutoff", low_cutoff)), float(msg.get("cutoff", cutoff)),
                                            float(msg.get("resonance", resonance)))
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

    # ---------- Analyzer: displays microphone analysis, records it when asked, serves file playback ----------

    @app.post("/api/analyzer/clip", response_model=ClipResponse)
    async def load_clip(request: Request, name: str = Query(default="son", max_length=200)):
        """Loads an audio file (WAV, FLAC, MP3), sent as the raw request body, in place of the previous one."""
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        return await load_analyzer_clip(await uploaded_audio(request), name)

    async def uploaded_audio(request: Request) -> bytes:
        """The audio file sent as the raw request body: 400 when empty, 413 when too big."""
        data = await request.body()
        if not data:
            raise HTTPException(status_code=400, detail="Fichier vide")
        if len(data) > MAX_CLIP_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"Fichier trop gros ({MAX_CLIP_UPLOAD_BYTES // 2**20} Mo au plus)")
        return data

    async def load_analyzer_clip(data: bytes, name: str) -> ClipResponse:
        """Decodes an audio file into the Analyzer's file, in place of the previous one."""
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

    @app.get("/api/analyzer/clip.wav")
    async def play_clip(request: Request):
        """Serves the loaded file decoded as WAV, so the browser can play and seek it."""
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        if analyzers.clip_name is None:
            raise HTTPException(status_code=404, detail="Aucun fichier chargé")
        return await wav_response(analyzers.clip(), request, "inline")

    async def wav_response(analyzer: Analyzer, request: Request, disposition: str) -> Response:
        """The analyzer's clip as WAV, whole or the byte range asked: the browser plays it and seeks in it."""
        try:
            data = await asyncio.to_thread(clip_wav_bytes, analyzer)
        except CoreError as ex:
            raise HTTPException(status_code=500, detail=str(ex)) from ex
        status_code, headers, body = clip_wav_payload(data, request.headers.get("range"))
        headers["Content-Disposition"] = disposition
        return Response(content=body, status_code=status_code, media_type="audio/wav", headers=headers)

    def check_analysis_options(window_ms: float, reference_hz: float, harmonic_cents: float):
        """422 for a window, reference note or harmonic tolerance the core would refuse."""
        if window_ms != 0 and not MIN_WINDOW_S * 1000 <= window_ms <= MAX_WINDOW_S * 1000:
            raise HTTPException(
                status_code=422,
                detail=f"Fenêtre de {MIN_WINDOW_S * 1000:g} à {MAX_WINDOW_S * 1000:g} ms, ou 0 pour l’habituelle",
            )
        if reference_hz != 0 and not MIN_REFERENCE_HZ <= reference_hz <= MAX_REFERENCE_HZ:
            raise HTTPException(
                status_code=422,
                detail=f"Note de référence de {MIN_REFERENCE_HZ:g} à {MAX_REFERENCE_HZ:g} Hz, ou 0 pour celle entendue",
            )
        if harmonic_cents > MAX_HARMONIC_CENTS:
            raise HTTPException(status_code=422, detail=f"Tolérance des harmoniques de 0 à {MAX_HARMONIC_CENTS:g} cents")

    async def analyze_moment_or_zone(
        analyzer: Analyzer,
        time: Optional[float],
        start: Optional[float],
        end: Optional[float],
        window_ms: float,
        noise_gate_db: float,
        reference_hz: float = 0.0,
        harmonic_cents: float = 0.0,
    ) -> Analysis:
        """A moment (time) through a window of window_ms (0: the usual one, about 170 ms),
        or a zone (start and end): the median of its moments, through windows of window_ms.
        Ratios to reference_hz (0: the note heard), only harmonics with harmonic_cents > 0."""
        check_analysis_options(window_ms, reference_hz, harmonic_cents)
        window_s = window_ms / 1000
        options = (window_s, noise_gate_db, reference_hz, harmonic_cents)
        if start is not None or end is not None:
            if start is None or end is None or not end > start:
                raise HTTPException(status_code=422, detail="Une zone demande start et end, end après start")
            return await asyncio.to_thread(analyzer.analyze_clip_range, start, end, *options)
        if time is None:
            raise HTTPException(status_code=422, detail="Il faut time, ou start et end")
        if window_s == 0 and reference_hz == 0 and harmonic_cents == 0:
            return await asyncio.to_thread(analyzer.analyze_clip, time, noise_gate_db)
        half = (window_s or ANALYSIS_USUAL_WINDOW_S) / 2
        return await asyncio.to_thread(analyzer.analyze_clip_range, time - half, time + half, *options)

    async def measure_note_envelopes(
        analyzer: Analyzer,
        start: float,
        end: float,
        window_ms: float,
        noise_gate_db: float,
        reference_hz: float,
        harmonic_cents: float,
    ) -> EnvelopeAnalysis:
        """The partials of a zone holding one note, and the envelope of each over it."""
        check_analysis_options(window_ms, reference_hz, harmonic_cents)
        if not end > start:
            raise HTTPException(status_code=422, detail="La zone finit après son début")
        analysis, envelopes = await asyncio.to_thread(
            analyzer.measure_envelopes, start, end, window_ms / 1000, noise_gate_db, reference_hz, harmonic_cents,
        )
        return EnvelopeAnalysis(analysis=analysis, envelopes=envelopes)

    @app.get("/api/analyzer/clip/analysis", response_model=Analysis)
    async def analyze_clip(
        time: Optional[float] = Query(default=None, ge=0.0, description="Seconds from the start of the file"),
        start: Optional[float] = Query(default=None, ge=0.0, description="Start of a zone, in seconds"),
        end: Optional[float] = Query(default=None, ge=0.0, description="End of a zone, in seconds"),
        window_ms: float = Query(default=0.0, ge=0.0, description="Analysis window: 10 to 500 ms; 0, the usual one (about 170 ms)"),
        noise_gate_db: float = Query(
            default=NOISE_GATE_OFF, ge=NOISE_GATE_OFF, le=0.0,
            description="Peaks below this level (dBFS) are ignored as ambient noise; -120: none",
        ),
        reference_hz: float = Query(default=0.0, ge=0.0, description="Note the ratios are taken to: 16 to 5000 Hz; 0, the note heard"),
        harmonic_cents: float = Query(default=0.0, ge=0.0, description="Only partials this close to a whole ratio (up to 100 cents); 0, every partial"),
    ):
        """The note, the partials and the spectrum of the loaded file: around time, or the median over a zone."""
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        if analyzers.clip_name is None:
            raise HTTPException(status_code=404, detail="Aucun fichier chargé")
        return await analyze_moment_or_zone(
            analyzers.clip(), time, start, end, window_ms, noise_gate_db, reference_hz, harmonic_cents,
        )

    async def waveform_response(analyzer: Analyzer, first: int, frames: int, count: int) -> ClipWaveform:
        """A part of the analyzer's clip for drawing: 422 when it starts past the end."""
        try:
            return await asyncio.to_thread(analyzer.clip_waveform, first, frames, count)
        except CoreError as ex:
            if ex.code == RESULT_INVALID_PARAM:
                raise HTTPException(status_code=422, detail="Au-delà de la fin du son") from ex
            raise HTTPException(status_code=500, detail=str(ex)) from ex

    @app.get("/api/analyzer/clip/waveform", response_model=ClipWaveform)
    async def clip_waveform(
        first: int = Query(ge=0, description="First frame of the part"),
        frames: int = Query(ge=1, description="Frames in the part (stopped at the end of the file)"),
        count: int = Query(ge=1, le=CLIP_WAVEFORM_MAX_PARTS, description="Equal parts, one per pixel column: never more than frames"),
    ):
        """The waveform of a part of the loaded file, to draw it zoomed in: lowest and highest sample of each channel per part."""
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        if analyzers.clip_name is None:
            raise HTTPException(status_code=404, detail="Aucun fichier chargé")
        return await waveform_response(analyzers.clip(), first, frames, count)

    @app.get("/api/analyzer/clip/envelopes", response_model=EnvelopeAnalysis)
    async def clip_envelopes(
        start: float = Query(ge=0.0, description="Start of the note's zone, in seconds"),
        end: float = Query(gt=0.0, description="End of the zone: before the next note"),
        window_ms: float = Query(default=0.0, ge=0.0, description="Analysis window that finds the partials: 10 to 500 ms; 0, the usual one"),
        noise_gate_db: float = Query(default=NOISE_GATE_OFF, ge=NOISE_GATE_OFF, le=0.0, description="As for the analysis"),
        reference_hz: float = Query(default=0.0, ge=0.0, description="As for the analysis"),
        harmonic_cents: float = Query(default=0.0, ge=0.0, description="As for the analysis"),
    ):
        """The partials of a zone holding one note, and the exponential envelope of each over it
        (synthway_analyzer_measure_envelopes): to make an instrument of them."""
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        if analyzers.clip_name is None:
            raise HTTPException(status_code=404, detail="Aucun fichier chargé")
        return await measure_note_envelopes(
            analyzers.clip(), start, end, window_ms, noise_gate_db, reference_hz, harmonic_cents,
        )

    async def finished_recording() -> Analyzer:
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        recording = await asyncio.to_thread(analyzers.recording)
        if recording is None:
            raise HTTPException(status_code=404, detail="Aucun enregistrement")
        return recording

    @app.get("/api/analyzer/recording", response_model=Optional[ClipResponse])
    async def get_recording():
        """The microphone's last recording, shown like a file; null when none (or while recording)."""
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        recording = await asyncio.to_thread(analyzers.recording)
        if recording is None:
            return None
        return await asyncio.to_thread(clip_response, recording, RECORDING_NAME)

    @app.get("/api/analyzer/recording/analysis", response_model=Analysis)
    async def analyze_recording(
        time: Optional[float] = Query(default=None, ge=0.0, description="Seconds from the start of the recording"),
        start: Optional[float] = Query(default=None, ge=0.0, description="Start of a zone, in seconds"),
        end: Optional[float] = Query(default=None, ge=0.0, description="End of a zone, in seconds"),
        window_ms: float = Query(default=0.0, ge=0.0, description="Analysis window: 10 to 500 ms; 0, the usual one (about 170 ms)"),
        noise_gate_db: float = Query(
            default=NOISE_GATE_OFF, ge=NOISE_GATE_OFF, le=0.0,
            description="Peaks below this level (dBFS) are ignored as ambient noise; -120: none",
        ),
        reference_hz: float = Query(default=0.0, ge=0.0, description="Note the ratios are taken to: 16 to 5000 Hz; 0, the note heard"),
        harmonic_cents: float = Query(default=0.0, ge=0.0, description="Only partials this close to a whole ratio (up to 100 cents); 0, every partial"),
    ):
        """The note, the partials and the spectrum of the last recording, like /api/analyzer/clip/analysis."""
        recording = await finished_recording()
        return await analyze_moment_or_zone(
            recording, time, start, end, window_ms, noise_gate_db, reference_hz, harmonic_cents,
        )

    @app.get("/api/analyzer/recording/waveform", response_model=ClipWaveform)
    async def recording_waveform(
        first: int = Query(ge=0, description="First frame of the part"),
        frames: int = Query(ge=1, description="Frames in the part (stopped at the end of the recording)"),
        count: int = Query(ge=1, le=CLIP_WAVEFORM_MAX_PARTS, description="Equal parts, one per pixel column: never more than frames"),
    ):
        """The waveform of a part of the last recording, like /api/analyzer/clip/waveform."""
        recording = await finished_recording()
        return await waveform_response(recording, first, frames, count)

    @app.get("/api/analyzer/recording/envelopes", response_model=EnvelopeAnalysis)
    async def recording_envelopes(
        start: float = Query(ge=0.0, description="Start of the note's zone, in seconds"),
        end: float = Query(gt=0.0, description="End of the zone: before the next note"),
        window_ms: float = Query(default=0.0, ge=0.0, description="As for the analysis"),
        noise_gate_db: float = Query(default=NOISE_GATE_OFF, ge=NOISE_GATE_OFF, le=0.0, description="As for the analysis"),
        reference_hz: float = Query(default=0.0, ge=0.0, description="As for the analysis"),
        harmonic_cents: float = Query(default=0.0, ge=0.0, description="As for the analysis"),
    ):
        """The envelopes of a note of the last recording, like /api/analyzer/clip/envelopes."""
        recording = await finished_recording()
        return await measure_note_envelopes(recording, start, end, window_ms, noise_gate_db, reference_hz, harmonic_cents)

    @app.get("/api/analyzer/recording.wav")
    async def recording_wav(request: Request):
        """The last recording as a mono 16-bit WAV file, written by the core: downloaded
        (attachment), or played by the browser, which ignores the attachment and seeks with Range."""
        recording = await finished_recording()
        name = f"synthway-{datetime.now().strftime('%Y%m%d-%H%M%S')}.wav"
        return await wav_response(recording, request, f'attachment; filename="{name}"')

    @app.websocket("/ws/analyzer")
    async def websocket_analyzer_endpoint(websocket: WebSocket):
        """
        Live analysis of the microphone. The core listens and analyzes; only the
        results go out, LIVE_INTERVAL_S apart. Nothing is recorded unless asked.
        From the page:
          - {"type": "start", "device_index": -1, "sample_rate": 0, "noise_gate_db": -120}
            opens the capture device (-1: the system's; sample rate 0: the device's own)
          - {"type": "set", "noise_gate_db": -70}
            peaks below this level (dBFS) are ignored as ambient noise; -120 (the default): none
          - {"type": "record"}       records from now on, with no time limit (the microphone must be open)
          - {"type": "stop_record"}  ends the recording; the microphone stays open
          - {"type": "stop"}
        To the page:
          - {"type": "started", "device_index": -1, "sample_rate": 48000, "exclusive": true}
            (exclusive: without the system's audio effects, which fade a held note; false: shared mode)
          - {"type": "analysis", "analysis": {...}, "recording": {"duration": 1.25, "lost": 0.0}}
            (see the Analysis model; "recording" only while recording, in seconds,
            lost: samples the core had no time to take, replaced by silence)
          - {"type": "recording"}  the recording has started
          - {"type": "recorded", "duration": 3.5, "lost": 0.0}
            the recording has ended, also when the microphone closes during it:
            GET /api/analyzer/recording then shows it
          - {"type": "stopped"}
          - {"type": "error", "error": "..."}
        The microphone closes when the page stops or disconnects. One page listens at a time.
        """
        if not await accept_local(websocket):
            return
        send_lock = asyncio.Lock()
        stream: Optional[asyncio.Task] = None

        async def send(message: dict):
            async with send_lock:
                await websocket.send_json(message)

        def recording_times(analyzer: Analyzer, sample_rate: int) -> dict:
            frames, lost = analyzer.recording_info()
            rate = max(1, sample_rate)
            return {"duration": round(frames / rate, 3), "lost": round(lost / rate, 3)}

        def analyze_live(analyzer: Analyzer) -> dict:
            # Each analysis also moves what the microphone heard into the recording
            analysis = analyzer.analyze_input()
            message = {"type": "analysis", "analysis": analysis.model_dump()}
            if analyzer.is_recording():
                message["recording"] = recording_times(analyzer, analysis.sample_rate)
            return message

        def finish_recording(analyzer: Analyzer) -> Optional[dict]:
            """Ends the recording; its times, or None when nothing was recorded."""
            if not analyzer.stop_recording():
                return None
            return recording_times(analyzer, analyzer.clip_info()[1])

        def close_microphone(analyzer: Analyzer) -> Optional[dict]:
            recorded = finish_recording(analyzer)  # a recording in progress ends first, and is kept
            analyzer.close_input()
            return recorded

        async def stream_analyses(analyzer: Analyzer):
            try:
                while True:
                    await send(await asyncio.to_thread(analyze_live, analyzer))
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
                # Shielded: the page's task may be cancelled meanwhile (a page that
                # leaves, the server stopping), and the microphone must close anyway
                with anyio.CancelScope(shield=True):
                    recorded = await anyio.to_thread.run_sync(close_microphone, analyzers.live())
                logger.info("Microphone closed")
                if recorded is not None:
                    try:
                        await send({"type": "recorded", **recorded})
                    except Exception:
                        pass  # the page has left; GET /api/analyzer/recording still shows it

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
                    elif action == "record":
                        if analyzers.listener is not websocket:
                            await send({"type": "error", "error": "Le micro n’est pas ouvert : rien à enregistrer"})
                            continue
                        await asyncio.to_thread(analyzers.live().start_recording)
                        logger.info("Recording the microphone")
                        await send({"type": "recording"})
                    elif action == "stop_record":
                        recorded = None
                        if analyzers.listener is websocket:
                            recorded = await asyncio.to_thread(finish_recording, analyzers.live())
                        if recorded is None:
                            await send({"type": "error", "error": "Aucun enregistrement en cours"})
                            continue
                        logger.info(f"Recording stopped: {recorded['duration']} s")
                        await send({"type": "recorded", **recorded})
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

    # ---------- AI-nalyzer: Demucs separates a piece into its sources, in a process of its own ----------

    SOURCE_MEDIA_TYPES = {".wav": "audio/wav", ".flac": "audio/flac", ".mp3": "audio/mpeg", ".ogg": "audio/ogg"}

    def refused(ex: SeparationError) -> HTTPException:
        return HTTPException(status_code=ex.status, detail=ex.detail)

    def attachment(filename: str) -> str:
        """A Content-Disposition for downloading under filename, accents included (RFC 5987)"""
        ascii_name = filename.encode("ascii", "replace").decode("ascii").replace("?", "_").replace('"', "_")
        return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"

    async def file_response(path: Path, request: Request, media_type: str, disposition: str) -> Response:
        """A file on disk, whole or the byte range asked: the browser plays it and seeks in it."""
        try:
            data = await asyncio.to_thread(path.read_bytes)
        except OSError as ex:
            raise HTTPException(status_code=404, detail="Fichier introuvable") from ex
        status_code, headers, body = clip_wav_payload(data, request.headers.get("range"))
        headers["Content-Disposition"] = disposition
        return Response(content=body, status_code=status_code, media_type=media_type, headers=headers)

    @app.get("/api/separation")
    async def separation_status():
        """Whether Demucs is ready (else why not), the piece loaded, the separation running or done and its stems
        (with the peaks of each, to draw it)."""
        return separation.status()

    @app.post("/api/separation/source")
    async def separation_source(request: Request, name: str = Query(default="morceau", max_length=200)):
        """The piece to decompose (WAV, FLAC, MP3, OGG), sent as the raw request body, in place of the previous one
        and of its stems. 409 while a separation runs, 503 when Demucs is not ready."""
        data = await uploaded_audio(request)
        try:
            await asyncio.to_thread(separation.set_source, name, data)
        except SeparationError as ex:
            raise refused(ex) from ex
        return separation.status()

    @app.get("/api/separation/source")
    async def separation_source_audio(request: Request):
        """The piece as it was sent, for the browser to play it."""
        try:
            path, _ = separation.source_file()
        except SeparationError as ex:
            raise refused(ex) from ex
        return await file_response(path, request, SOURCE_MEDIA_TYPES.get(path.suffix, "application/octet-stream"), "inline")

    @app.post("/api/separation/run")
    async def separation_run(model: str = Body(default="htdemucs", embed=True)):
        """Decomposes the piece loaded with a Demucs model (htdemucs, htdemucs_ft, htdemucs_6s), in the
        background: GET /api/separation follows it. The weights are downloaded on a model's first use."""
        try:
            await asyncio.to_thread(separation.start, model)
        except SeparationError as ex:
            raise refused(ex) from ex
        return separation.status()

    @app.post("/api/separation/cancel")
    async def separation_cancel():
        """Stops the separation in progress (its process is killed)."""
        await asyncio.to_thread(separation.cancel)
        return separation.status()

    @app.get("/api/separation/stems/{name}.wav")
    async def separation_stem(request: Request, name: str, download: bool = Query(default=False)):
        """A stem as a 16-bit stereo WAV file: played by the browser, or downloaded (download=true)."""
        try:
            path = separation.stem_file(name)
            _, source_name = separation.source_file()
        except SeparationError as ex:
            raise refused(ex) from ex
        disposition = attachment(f"{Path(source_name).stem} - {name}.wav") if download else "inline"
        return await file_response(path, request, "audio/wav", disposition)

    @app.post("/api/separation/stems/{name}/analyzer", response_model=ClipResponse)
    async def separation_stem_to_analyzer(name: str):
        """Loads a stem into the Analyzer, in place of its file: its Fichier tab then shows and analyzes it."""
        if not core:
            raise HTTPException(status_code=503, detail="Synthway core library not loaded")
        try:
            path = separation.stem_file(name)
            _, source_name = separation.source_file()
        except SeparationError as ex:
            raise refused(ex) from ex
        try:
            data = await asyncio.to_thread(path.read_bytes)
        except OSError as ex:
            raise HTTPException(status_code=404, detail="Fichier introuvable") from ex
        return await load_analyzer_clip(data, f"{Path(source_name).stem} · {name}")


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
