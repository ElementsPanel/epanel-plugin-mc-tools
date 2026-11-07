#!/usr/bin/env python3
"""Pack Minecraft's cloud texture into the cell map the 3D view extrudes.

``CloudRenderer`` reads ``textures/environment/clouds.png`` once: every pixel is a
12×12 block cell that is empty when its alpha is below 10 (``isCellEmpty``), and
the vanilla texture is plain white. The map ships only that occupancy, one bit per
cell (row-major, least significant bit first), and derives neighbours at runtime.

Usage: cloud-cells.py clouds.png [output.json] [minecraft-version]
"""
import base64
import io
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def pack(png: bytes, version: str):
    image = Image.open(io.BytesIO(png)).convert("RGBA")
    width, height = image.size
    pixels = image.load()
    bits = bytearray((width * height + 7) // 8)
    for z in range(height):
        for x in range(width):
            if pixels[x, z][3] >= 10:
                index = x + z * width
                bits[index >> 3] |= 1 << (index & 7)
    return {"minecraftVersion": version, "width": width, "height": height,
            "cells": base64.b64encode(bytes(bits)).decode()}


def main(png_path, output_path=ROOT / "shared/clouds.json", version="unknown"):
    data = pack(Path(png_path).read_bytes(), version)
    Path(output_path).write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print("Cloud cells:", data["width"], "×", data["height"])


def write(png: bytes, version: str, output_path=ROOT / "shared/clouds.json"):
    Path(output_path).write_text(json.dumps(pack(png, version), separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main(*sys.argv[1:])
