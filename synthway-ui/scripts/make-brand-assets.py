"""Derive the UI brand assets (emblem, favicon, logo) from the master logo.

Usage, from the repository root:
    uv run --with pillow python synthway-ui/scripts/make-brand-assets.py [assets/logo/v4.png]

Writes synthway-ui/src/assets/brand/{emblem-256,logo-640}.png and
synthway-ui/public/favicon.png. Expects the master logo layout: emblem on top,
wordmark below, on a near-black background.
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "assets" / "logo" / "v4.png"
BRAND_DIR = ROOT / "synthway-ui" / "src" / "assets" / "brand"
PUBLIC_DIR = ROOT / "synthway-ui" / "public"

THRESHOLD = 70  # a pixel belongs to the artwork when one channel is brighter than this
WORDMARK_TOP = 0.69  # the wordmark starts below this fraction of the height

img = Image.open(SOURCE).convert("RGB")
width, height = img.size

# Background colour: average of the four corners
corners = [img.getpixel((x, y)) for x in (5, width - 6) for y in (5, height - 6)]
background = tuple(sum(c[i] for c in corners) // 4 for i in range(3))


def bright_bbox(box):
    region = img.crop(box)
    mask = Image.new("L", region.size, 0)
    for channel in region.split():
        mask = Image.composite(Image.new("L", region.size, 255), mask, channel.point(lambda v: 255 if v > THRESHOLD else 0))
    left, top, right, bottom = mask.getbbox()
    return left + box[0], top + box[1], right + box[0], bottom + box[1]


split = int(height * WORDMARK_TOP)
emblem_box = bright_bbox((0, 0, width, split))
wordmark_box = bright_bbox((0, split, width, height))


def emblem(pad=24):
    # Crop only the emblem (never the wordmark), centred on a square canvas
    # filled with the logo's own background colour
    part = img.crop((emblem_box[0] - pad, emblem_box[1] - pad, emblem_box[2] + pad, emblem_box[3] + pad))
    side = max(part.size)
    canvas = Image.new("RGB", (side, side), background)
    canvas.paste(part, ((side - part.width) // 2, (side - part.height) // 2))
    return canvas


BRAND_DIR.mkdir(parents=True, exist_ok=True)
PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

square = emblem()
square.resize((256, 256), Image.LANCZOS).save(BRAND_DIR / "emblem-256.png", optimize=True)
square.resize((64, 64), Image.LANCZOS).save(PUBLIC_DIR / "favicon.png", optimize=True)

pad = 40
full = img.crop((
    min(emblem_box[0], wordmark_box[0]) - pad,
    emblem_box[1] - pad,
    max(emblem_box[2], wordmark_box[2]) + pad,
    wordmark_box[3] + pad,
))
full.resize((640, round(full.height * 640 / full.width)), Image.LANCZOS).save(BRAND_DIR / "logo-640.png", optimize=True)

print(f"background #{background[0]:02x}{background[1]:02x}{background[2]:02x}")
for path in (BRAND_DIR / "emblem-256.png", BRAND_DIR / "logo-640.png", PUBLIC_DIR / "favicon.png"):
    print(f"{path.relative_to(ROOT)}: {path.stat().st_size} bytes")
