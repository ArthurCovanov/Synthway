"""Measure a WAV file rendered offline (synthway_cli --render): duration, level
and frequency of the first channel. Standard library only, nothing to install.

Usage:
    python synthway-core/tools/analyze_wav.py file.wav [--expect-hz 440]

With --expect-hz, the exit code is 1 when the measured frequency is off by more
than 0.5 % (or when the file is silent).
"""
import argparse
import math
import struct
import sys
import wave

SETTLE_SECONDS = 0.05  # the engine smooths frequency and volume changes


def measure_frequency(samples, rate):
    """Frequency from positive-going zero crossings, interpolated between samples."""
    first = last = None
    crossings = 0
    for i in range(1, len(samples)):
        a, b = samples[i - 1], samples[i]
        if a < 0.0 <= b:
            t = (i - 1) + a / (a - b)
            if first is None:
                first = t
            last = t
            crossings += 1
    if crossings < 2:
        return 0.0
    return (crossings - 1) * rate / (last - first)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", help="16-bit PCM WAV file")
    parser.add_argument("--expect-hz", type=float, help="expected frequency of the tone")
    args = parser.parse_args()

    with wave.open(args.path, "rb") as wav:
        channels, width, rate, frames = wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()
        if width != 2:
            sys.exit(f"Only 16-bit PCM WAV files are supported (got {8 * width}-bit)")
        raw = wav.readframes(frames)

    values = struct.unpack(f"<{frames * channels}h", raw)
    first_channel = [v / 32768.0 for v in values[0::channels]]
    steady = first_channel[int(rate * SETTLE_SECONDS):]

    peak = max((abs(x) for x in steady), default=0.0)
    rms = math.sqrt(sum(x * x for x in steady) / len(steady)) if steady else 0.0
    frequency = measure_frequency(steady, rate)

    print(f"file      : {args.path}")
    print(f"format    : {channels} channel(s), {rate} Hz, {frames / rate:.3f} s")
    if peak == 0.0:
        print("level     : silence")
    else:
        print(f"level     : peak {peak:.4f} ({20 * math.log10(peak):.1f} dBFS), rms {rms:.4f}")
        print(f"frequency : {frequency:.3f} Hz")

    if args.expect_hz is not None:
        ok = peak > 0.0 and abs(frequency - args.expect_hz) <= args.expect_hz * 0.005
        print(f"expected  : {args.expect_hz:.3f} Hz -> {'OK' if ok else 'MISMATCH'}")
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
