"""
Decomposer: separates a piece of music into its sources (drums, bass, vocals,
other...) with Demucs v4. Demucs lives apart, in synthway-demucs/, with its own
Python and torch: the server never imports them, it runs
synthway-demucs/separate.py as a process and follows the JSON lines it prints.
This is offline work on a file; no audio stream goes through Python.

Optional: without synthway-demucs (or its environment, made by `uv sync`), or
with SYNTHWAY_DEMUCS=0, the rest of the server works the same and the
Decomposer says why it cannot decompose.

Environment:
    SYNTHWAY_DEMUCS      0 turns the Decomposer off
    SYNTHWAY_DEMUCS_DIR  the synthway-demucs folder (default: next to synthway-server)
"""

import atexit
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
from collections import deque
from pathlib import Path
from typing import Optional

logger = logging.getLogger("synthway-server")

MODELS = ("htdemucs", "htdemucs_ft", "htdemucs_6s")
DEFAULT_DEMUCS_DIR = Path(__file__).resolve().parents[2] / "synthway-demucs"
# Extensions kept for the uploaded file: Demucs decodes it by them
SOURCE_SUFFIXES = (".wav", ".flac", ".mp3", ".ogg")
STDERR_LINES = 20  # last lines of Demucs' error output, shown when it fails without saying why


class SeparationError(Exception):
    """Refused: status is the HTTP status to answer with"""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def demucs_python(demucs_dir: Path) -> Path:
    """The Python of synthway-demucs' own environment"""
    if sys.platform == "win32":
        return demucs_dir / ".venv" / "Scripts" / "python.exe"
    return demucs_dir / ".venv" / "bin" / "python"


class Separation:
    """
    One piece of music at a time (the source) and its stems. Starts empty when
    the server launches; one separation runs at a time, in a process of its own.
    """

    def __init__(self, demucs_dir: Optional[Path] = None, enabled: Optional[bool] = None):
        if enabled is None:
            enabled = os.environ.get("SYNTHWAY_DEMUCS", "1") != "0"
        if demucs_dir is None:
            demucs_dir = Path(os.environ.get("SYNTHWAY_DEMUCS_DIR", DEFAULT_DEMUCS_DIR))
        self.enabled = enabled
        self.demucs_dir = demucs_dir
        self.python = demucs_python(demucs_dir)
        self.script = demucs_dir / "separate.py"
        self.work_dir = demucs_dir / "work"
        self.stems_dir = self.work_dir / "stems"
        self._lock = threading.Lock()
        self._process: Optional[subprocess.Popen] = None
        self._source: Optional[dict] = None  # {"name", "file", "size"}
        self._job = self._idle_job()
        self._result: Optional[dict] = None

    @staticmethod
    def _idle_job() -> dict:
        return {"state": "idle", "stage": None, "progress": 0.0, "model": None, "device": None, "error": None}

    # ---------- What the page shows ----------

    def unavailable_reason(self) -> Optional[str]:
        """Why nothing can be decomposed, None when Demucs is ready"""
        if not self.enabled:
            return "Decomposer désactivé (SYNTHWAY_DEMUCS=0)"
        if not self.script.is_file():
            return f"Demucs n’est pas installé : {self.script} est introuvable"
        if not self.python.is_file():
            return f"L’environnement de Demucs n’est pas créé : lance « uv sync » dans {self.demucs_dir}"
        return None

    def status(self) -> dict:
        with self._lock:
            result = self._result
            return {
                "available": self.unavailable_reason() is None,
                "reason": self.unavailable_reason(),
                "models": list(MODELS),
                "source": None if self._source is None else {"name": self._source["name"], "size": self._source["size"]},
                "job": dict(self._job),
                "result": None if result is None else {
                    "model": result["model"],
                    "device": result["device"],
                    "sample_rate": result["sample_rate"],
                    "duration": result["duration"],
                    "seconds": result["seconds"],
                    "stems": [{"name": stem["name"], "peaks": stem["peaks"]} for stem in result["stems"]],
                },
            }

    # ---------- The source ----------

    def _clean_work(self) -> None:
        """Removes source files and stems, preserving other directories (like comparaison/)."""
        if self.work_dir.is_dir():
            for item in self.work_dir.glob("source*"):
                if item.is_file():
                    item.unlink(missing_ok=True)
        if self.stems_dir.is_dir():
            shutil.rmtree(self.stems_dir, ignore_errors=True)

    def set_source(self, name: str, data: bytes) -> None:
        """The piece to decompose, in place of the previous one and its stems"""
        reason = self.unavailable_reason()
        if reason:
            raise SeparationError(503, reason)
        with self._lock:
            if self._job["state"] == "running":
                raise SeparationError(409, "Une décomposition est en cours")
            suffix = Path(name).suffix.lower()
            file = f"source{suffix if suffix in SOURCE_SUFFIXES else ''}"
            self._clean_work()
            self.work_dir.mkdir(parents=True, exist_ok=True)
            (self.work_dir / file).write_bytes(data)
            self._source = {"name": name, "file": file, "size": len(data)}
            (self.work_dir / "source.json").write_text(json.dumps(self._source), encoding="utf-8")
            self._result = None
            self._job = self._idle_job()

    def clear(self) -> None:
        """Clears the piece and its stems: the Decomposer becomes empty."""
        with self._lock:
            if self._job["state"] == "running":
                raise SeparationError(409, "Une décomposition est en cours")
            self._source = None
            self._job = self._idle_job()
            self._result = None
            self._clean_work()

    def source_file(self) -> tuple[Path, str]:
        """The uploaded file and its name"""
        with self._lock:
            if self._source is None:
                raise SeparationError(404, "Aucun morceau chargé")
            return self.work_dir / self._source["file"], self._source["name"]

    # ---------- The separation ----------

    def start(self, model: str, device: str = "auto") -> None:
        if model not in MODELS:
            raise SeparationError(422, f"Modèle inconnu : {model} ({', '.join(MODELS)})")
        reason = self.unavailable_reason()
        if reason:
            raise SeparationError(503, reason)
        with self._lock:
            if self._source is None:
                raise SeparationError(400, "Aucun morceau à décomposer")
            if self._job["state"] == "running":
                raise SeparationError(409, "Une décomposition est déjà en cours")
            shutil.rmtree(self.stems_dir, ignore_errors=True)
            self._result = None
            # -I: none of the server's own Python settings (PYTHONPATH, PYTHONHOME...) reach it
            command = [
                str(self.python), "-I", str(self.script),
                str(self.work_dir / self._source["file"]), str(self.stems_dir),
                "--model", model, "--device", device,
            ]
            process = subprocess.Popen(
                command,
                cwd=self.demucs_dir,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            self._process = process
            self._job = {**self._idle_job(), "state": "running", "stage": "starting", "model": model}
        logger.info(f"Demucs started: {model} on {self._source['name']}")
        threading.Thread(target=self._follow, args=(process,), name="demucs", daemon=True).start()

    def cancel(self) -> None:
        with self._lock:
            process = self._process
            if process is None or self._job["state"] != "running":
                return
            self._job = {**self._job, "state": "cancelled", "stage": None}
        process.kill()
        logger.info("Demucs cancelled")

    def _follow(self, process: subprocess.Popen) -> None:
        """Follows the process' report until it ends (in its own thread)"""
        errors: deque = deque(maxlen=STDERR_LINES)
        # Read apart, or a full error pipe (download progress bars) would block Demucs
        drain = threading.Thread(target=lambda: errors.extend(process.stderr), daemon=True)
        drain.start()
        reported_error = None
        for line in process.stdout:
            try:
                message = json.loads(line)
                event = message["event"]
            except (ValueError, KeyError, TypeError):
                continue  # a line of Demucs' own
            with self._lock:
                if self._process is not process or self._job["state"] != "running":
                    continue
                if event == "progress":
                    self._job["progress"] = float(message["value"])
                    self._job["stage"] = "separating"
                elif event == "loading":
                    self._job["device"] = message.get("device")
                    self._job["stage"] = "loading"
                elif event in ("reading", "saving"):
                    self._job["stage"] = event
                elif event == "error":
                    reported_error = message.get("message")
        code = process.wait()
        drain.join(timeout=5)
        result = None
        if code == 0:
            try:
                result = json.loads((self.stems_dir / "result.json").read_text(encoding="utf-8"))
            except (OSError, ValueError) as ex:
                reported_error = f"Résultat illisible : {ex}"
        with self._lock:
            if self._process is not process:
                return
            self._process = None
            if self._job["state"] == "cancelled":
                self._job = {**self._idle_job(), "error": "Décomposition annulée"}
            elif result is not None:
                self._result = result
                self._job = {**self._job, "state": "done", "stage": None, "progress": 1.0}
                logger.info(f"Demucs done in {result['seconds']} s on {result['device']}")
            else:
                tail = "".join(errors).strip().splitlines()[-3:]
                error = reported_error or (" / ".join(tail) if tail else f"Demucs s’est arrêté (code {code})")
                self._job = {**self._job, "state": "error", "stage": None, "error": error}
                logger.error(f"Demucs failed: {error}")

    # ---------- The stems ----------

    def stem_file(self, name: str) -> Path:
        with self._lock:
            if self._result is None or name not in [stem["name"] for stem in self._result["stems"]]:
                raise SeparationError(404, f"Aucune piste « {name} »")
            return self.stems_dir / f"{name}.wav"

    def stop(self) -> None:
        """Ends a separation in progress: the server is stopping"""
        process = self._process
        if process is not None and process.poll() is None:
            process.kill()


separation = Separation()
atexit.register(separation.stop)
