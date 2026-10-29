#!/usr/bin/env python3
"""Prepare overlapping visual inspection views from a screenshot."""
import argparse
import json
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    raise SystemExit("Pillow is required for this optional helper. Use an equivalent image tool if unavailable.")

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("image", type=Path)
parser.add_argument("output", type=Path, help="new directory for derived inspection views")
args = parser.parse_args()
if args.output.exists():
    raise SystemExit("Output directory already exists; choose a new path.")
image = Image.open(args.image).convert("RGB")
width, height = image.size
args.output.mkdir(parents=True)
records = []
for index in range(3):
    left = max(0, round(width * index / 3) - (round(width * .04) if index else 0))
    right = min(width, round(width * (index + 1) / 3) + (round(width * .04) if index < 2 else 0))
    crop = image.crop((left, 0, right, height))
    enlarged = crop.resize((crop.width * 2, crop.height * 2), Image.Resampling.NEAREST)
    original_name = f"region-{index + 1}.png"
    enhanced_name = f"region-{index + 1}-dark-detail.png"
    enlarged.save(args.output / original_name)
    enlarged.point(lambda value: max(0, min(255, (value - 20) * 3))).save(args.output / enhanced_name)
    records.append({"region": index + 1, "source_box": [left, 0, right, height],
                    "enlarged": original_name, "contrast_aid": enhanced_name})
(args.output / "manifest.json").write_text(json.dumps({
    "source": str(args.image), "size": [width, height], "views": records,
    "note": "Contrast views are altered aids; verify candidates against the unaltered original."
}, indent=2), encoding="utf-8")
print(json.dumps({"output": str(args.output), "views": records}, indent=2))
