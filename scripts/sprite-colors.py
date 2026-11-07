#!/usr/bin/env python3
"""Summarise every atlas sprite the way the 3D top-down view samples it.

The flat 2D map paints one pixel per block, so it needs each top-face sprite reduced
to what the terrain shader shows around the 2D/3D hand-off zoom (about four screen
pixels per block, i.e. mip level 2 of a 16-texel sprite):

* ``color``/``alpha``: alpha-weighted average color and mean alpha. Translucent
  blocks (water, ice, stained glass) blend with exactly these values.
* ``mipColor``/``cover``: cutout blocks discard mip texels whose alpha is below 0.1
  and draw the rest opaque after un-premultiplying, so they cover ``cover`` of the
  face with ``mipColor``.

Animated sprites are averaged over all of their frames.

Usage: sprite-colors.py [atlas.png] [minecraft-assets.json] [output.json]
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MIP = 4
CUTOFF = 0.1 * 255


def summarise(atlas, layout, first, frames):
    cell, inner, padding, columns = layout["cell"], layout["inner"], layout["padding"], layout["columns"]
    weighted, alpha_sum, count = [0, 0, 0], 0, 0
    mip, covered, cells = [0.0, 0.0, 0.0], 0, 0
    for frame in range(first, first + frames):
        left = (frame % columns) * cell + padding
        top = (frame // columns) * cell + padding
        pixels = atlas.crop((left, top, left + inner, top + inner)).load()
        for y in range(inner):
            for x in range(inner):
                r, g, b, a = pixels[x, y]
                weighted[0] += r * a; weighted[1] += g * a; weighted[2] += b * a
                alpha_sum += a; count += 1
        for cy in range(0, inner, MIP):
            for cx in range(0, inner, MIP):
                block = [pixels[cx + x, cy + y] for y in range(MIP) for x in range(MIP)]
                a = sum(p[3] for p in block)
                cells += 1
                if a / len(block) < CUTOFF:
                    continue
                covered += 1
                for channel in range(3):
                    mip[channel] += sum(p[channel] * p[3] for p in block) / a
    pack = lambda rgb: (round(rgb[0]) << 16) | (round(rgb[1]) << 8) | round(rgb[2])
    color = pack([value / alpha_sum for value in weighted]) if alpha_sum else 0
    mip_color = pack([value / covered for value in mip]) if covered else color
    return [color, round(alpha_sum / count), mip_color, round(covered / cells * 255)]


def main(atlas_path, assets_path, output_path):
    assets = json.loads(Path(assets_path).read_text())
    atlas = Image.open(atlas_path).convert("RGBA")
    sprites = {}
    for name, first, frames, _duration, _interpolate in assets["textures"]:
        if name == "missing":
            continue
        sprites[str(first)] = summarise(atlas, assets["atlas"], first, frames)
    Path(output_path).write_text(json.dumps(sprites, separators=(",", ":"), sort_keys=True) + "\n")
    print("Sprites:", len(sprites))


if __name__ == "__main__":
    args = sys.argv[1:]
    main(args[0] if len(args) > 0 else ROOT / "panel/src/assets/minecraft/atlas.png",
         args[1] if len(args) > 1 else ROOT / "shared/minecraft-assets.json",
         args[2] if len(args) > 2 else ROOT / "shared/sprite-colors.json")
