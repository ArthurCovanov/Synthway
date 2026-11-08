"""
Separates a piece of music into its sources (drums, bass, vocals, other...)
with Demucs v4, for Synthway's Decomposer. Runs with this folder's own Python
(uv sync), never inside the server: synthway-server starts it as a process.

    .venv/Scripts/python separate.py INPUT OUT_DIR [--model htdemucs] [--device auto]

Reports on stdout, one JSON object per line:
    {"event": "loading", "model": "htdemucs", "device": "cuda"}   the model loads (downloaded on first use)
    {"event": "reading"}                                         the input file is decoded
    {"event": "progress", "value": 0.42}                         share of the separation done
    {"event": "saving"}                                          the stems are written
    {"event": "done", "result": "OUT_DIR/result.json"}
    {"event": "error", "message": "..."}                         then exit code 1
OUT_DIR receives one 16-bit WAV per stem and result.json, which describes them
(see write_result). The weights are kept in models/, next to this script.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Before huggingface_hub is imported: everything Demucs downloads stays in this folder
os.environ.setdefault("HF_HOME", str(HERE / "models"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

MODELS = ("htdemucs", "htdemucs_ft", "htdemucs_6s")
PEAK_POINTS = 1000  # peaks of each stem, to draw its waveform


def report(event: str, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def peaks(wav, points: int) -> list:
    """Highest absolute sample of each of points equal parts, over both channels"""
    import torch
    magnitude = wav.abs().amax(dim=0)
    length = magnitude.shape[0]
    points = max(1, min(points, length))
    edges = torch.linspace(0, length, points + 1).long()
    return [round(float(magnitude[edges[i]:max(edges[i + 1], edges[i] + 1)].max()), 4) for i in range(points)]


def write_result(out_dir: Path, model: str, device: str, sample_rate: int, frames: int, stems: dict, seconds: float) -> Path:
    """result.json: what the server shows of a separation, also after a restart"""
    result = {
        "model": model,
        "device": device,
        "sample_rate": sample_rate,
        "duration": frames / sample_rate,
        "seconds": round(seconds, 1),
        "stems": [{"name": name, "file": f"{name}.wav", "peaks": peaks(wav, PEAK_POINTS)} for name, wav in stems.items()],
    }
    path = out_dir / "result.json"
    path.write_text(json.dumps(result), encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("input", type=Path)
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--model", choices=MODELS, default="htdemucs")
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    args = parser.parse_args()

    try:
        import torch
        from demucs.api import Separator
        from demucs.audio import prevent_clip, save_audio

        device = args.device
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        started = time.monotonic()
        report("loading", model=args.model, device=device)

        last = -1.0

        def on_chunk(info: dict):
            # A chunk starts: the ones before it, in this model of the bag, are done
            nonlocal last
            if info["state"] != "start":
                return
            value = (info["model_idx_in_bag"] + info["segment_offset"] / info["audio_length"]) / info["models"]
            if value - last >= 0.01:
                last = value
                report("progress", value=round(value, 3))

        separator = Separator(model=args.model, device=device, callback=on_chunk)
        report("reading")
        _, stems = separator.separate_audio_file(args.input)

        report("saving")
        args.out_dir.mkdir(parents=True, exist_ok=True)
        # Lowered when it would clip, as Demucs does (each stem on its own): the peaks are those of the files
        stems = {name: prevent_clip(wav.cpu(), mode="rescale") for name, wav in stems.items()}
        for name, wav in stems.items():
            save_audio(wav, args.out_dir / f"{name}.wav", samplerate=separator.samplerate, bits_per_sample=16)
        frames = next(iter(stems.values())).shape[-1]
        result = write_result(
            args.out_dir, args.model, device, separator.samplerate, frames, stems, time.monotonic() - started,
        )
        report("done", result=str(result))
        return 0
    except Exception as ex:  # reported to the server, which shows it
        report("error", message=f"{type(ex).__name__}: {ex}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
