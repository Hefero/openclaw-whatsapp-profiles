#!/usr/bin/env python3
import argparse
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit(
        "Pillow is required for sticker WebP preparation. Run: npm run media:install"
    ) from exc


def clamp_green_spill(r: int, g: int, b: int) -> tuple[int, int, int]:
    if g > 120 and g > r * 1.35 and g > b * 1.35:
        return r, max(r, b), b
    return r, g, b


def prepare_sticker(
    input_path: Path,
    output_path: Path,
    alpha_threshold: int,
    quality: int,
    method: int,
) -> None:
    image = Image.open(input_path).convert("RGBA")
    pixels = image.load()
    width, height = image.size

    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a <= alpha_threshold:
                pixels[x, y] = (0, 0, 0, 0)
            else:
                pixels[x, y] = (*clamp_green_spill(r, g, b), a)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(
        output_path,
        "WEBP",
        lossless=True,
        quality=quality,
        method=method,
        exact=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare a WhatsApp sticker WebP with exact transparent pixels.")
    parser.add_argument("input_png", type=Path)
    parser.add_argument("output_webp", type=Path)
    parser.add_argument("--alpha-threshold", type=int, default=15)
    parser.add_argument("--quality", type=int, default=75)
    parser.add_argument("--method", type=int, default=6)
    args = parser.parse_args()

    prepare_sticker(
        args.input_png,
        args.output_webp,
        max(0, min(255, args.alpha_threshold)),
        max(1, min(100, args.quality)),
        max(0, min(6, args.method)),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
