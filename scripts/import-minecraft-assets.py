#!/usr/bin/env python3
"""Build the map's texture atlas from a locally supplied Minecraft client JAR.

Usage: python3 scripts/import-minecraft-assets.py /path/to/client.jar
Update colors from a newer server JAR while retaining the existing texture atlas:
  python3 scripts/import-minecraft-assets.py /path/to/client.jar --biomes /path/to/server.jar --biomes-only
Requires Pillow only when reimporting; normal plugin builds use the saved atlas.
"""
import argparse
import hashlib
import io
import json
import math
from contextlib import contextmanager
from functools import lru_cache, reduce
from pathlib import Path
from zipfile import ZipFile

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DIRECTIONS = ["east", "west", "up", "down", "south", "north"]
INNER, PADDING, CELL, COLUMNS = 16, 8, 32, 64


@contextmanager
def resources(jar):
    with ZipFile(jar) as archive:
        bundled = [name for name in archive.namelist() if name.startswith("META-INF/versions/") and name.endswith(".jar")]
        if bundled:
            with ZipFile(io.BytesIO(archive.read(bundled[0]))) as inner:
                yield inner
        else:
            yield archive


def biome_palette(archive, biome_archive):
    entries = set(archive.namelist())
    colormaps = {name: Image.open(io.BytesIO(archive.read("assets/minecraft/textures/colormap/" + name + ".png"))).convert("RGB") for name in ("grass", "foliage", "dry_foliage") if "assets/minecraft/textures/colormap/" + name + ".png" in entries}
    colormaps.setdefault("dry_foliage", colormaps["foliage"])
    def color(value):
        return int(value.removeprefix("#"), 16) if isinstance(value, str) else value
    def sample(name, temperature, humidity):
        x, y = int((1 - temperature) * 255), int((1 - humidity * temperature) * 255)
        r, g, b = colormaps[name].getpixel((x, y))
        return (r << 16) | (g << 8) | b
    biomes = {}
    for filename in sorted(biome_archive.namelist()):
        if not filename.startswith("data/minecraft/worldgen/biome/") or not filename.endswith(".json"):
            continue
        biome = json.loads(biome_archive.read(filename))
        effects = biome.get("effects", {})
        temperature = max(0, min(1, biome.get("temperature", 0.8)))
        humidity = max(0, min(1, biome.get("downfall", 0.4)))
        grass = color(effects.get("grass_color", sample("grass", temperature, humidity)))
        if effects.get("grass_color_modifier") == "dark_forest":
            grass = ((grass & 0xfefefe) + 0x28340a) >> 1
        elif effects.get("grass_color_modifier") == "swamp":
            grass = 0x6a7039
        biomes["minecraft:" + Path(filename).stem] = [grass, color(effects.get("foliage_color", sample("foliage", temperature, humidity))), color(effects.get("water_color", 0x3f76e4)), color(effects.get("dry_foliage_color", sample("dry_foliage", temperature, humidity)))]
    return biomes


def main(jar, biome_jar=None, biomes_only=False):
    biome_jar = biome_jar or jar
    with resources(jar) as archive, resources(biome_jar) as biome_archive:
        biome_version = json.loads(biome_archive.read("version.json"))["id"]
        biome_source = {"biomeVersion": biome_version, "biomeJarSha256": hashlib.sha256(biome_jar.read_bytes()).hexdigest()}
        if biomes_only:
            metadata_file = ROOT / "shared/minecraft-assets.json"
            source_file = ROOT / "panel/src/assets/minecraft/source.json"
            metadata = json.loads(metadata_file.read_text())
            metadata.update({"biomes": biome_palette(archive, biome_archive), "biomeVersion": biome_version})
            source = json.loads(source_file.read_text())
            source.update(biome_source)
            metadata_file.write_text(json.dumps(metadata, separators=(",", ":")) + "\n")
            source_file.write_text(json.dumps(source, indent=2) + "\n")
            print(json.dumps({**biome_source, "biomes": len(metadata["biomes"])}, indent=2))
            return
        entries = set(archive.namelist())

        def read(name):
            return json.loads(archive.read(name))

        @lru_cache(None)
        def model(name):
            name = name.removeprefix("minecraft:")
            filename = "assets/minecraft/models/" + name + ".json"
            if filename not in entries:
                return {}
            own = read(filename)
            parent = model(own["parent"]) if own.get("parent") else {}
            return {**parent, **own, "textures": {**parent.get("textures", {}), **own.get("textures", {})}}

        def resolve(value, textures):
            seen = set()
            if isinstance(value, dict):
                value = value.get("sprite")
            while value and value.startswith("#") and value not in seen:
                seen.add(value)
                value = textures.get(value[1:])
                if isinstance(value, dict):
                    value = value.get("sprite")
            value = (value or "missing").removeprefix("minecraft:")
            return value if "assets/minecraft/textures/" + value + ".png" in entries else "missing"

        def preferred(variants):
            defaults = {"axis": "y", "half": "bottom", "type": "bottom", "facing": "north", "snowy": "false", "open": "false", "lit": "false", "age": "0", "stage": "0", "shape": "straight"}
            def score(key):
                fields = dict(part.split("=", 1) for part in key.split(",") if "=" in part)
                return sum(value == fields.get(name) for name, value in defaults.items())
            return variants[max(variants, key=score)]

        blocks, used = {}, {"block/grass_block_side_overlay", "block/water_still", "block/water_flow", "block/lava_still", "block/lava_flow"}
        def describe(name, variant):
            if isinstance(variant, list):
                variant = variant[0] if variant else {}
            definition = model(variant.get("model", "block/" + name))
            textures = definition.get("textures", {})
            fallback = resolve(textures.get("particle", textures.get("all", next(iter(textures.values()), "missing"))), textures)
            faces, tint, overlay = [fallback] * 6, 0, 0
            for face, direction in enumerate(DIRECTIONS):
                candidates = [element["faces"][direction] for element in definition.get("elements", []) if direction in element.get("faces", {})]
                if candidates:
                    selected = next((c for c in candidates if not resolve(c.get("texture"), textures).endswith("_overlay")), candidates[0])
                    faces[face] = resolve(selected.get("texture"), textures)
                    if "tintindex" in selected:
                        tint |= 1 << face
                    if any(resolve(c.get("texture"), textures) == "block/grass_block_side_overlay" for c in candidates):
                        overlay |= 1 << face
            if name in ("water", "lava"):
                faces = ["block/" + name + ("_still" if face in (2, 3) else "_flow") for face in range(6)]
                tint = 63 if name == "water" else 0
            used.update(faces)
            result = {"faces": faces, "tint": tint, "overlay": overlay}
            elements = definition.get("elements", [])
            if elements and all(element["from"][1] == element["to"][1] and 0 <= element["from"][1] <= 2 for element in elements):
                result["shape"] = "ground"
            elif elements and all((element["from"][0] == element["to"][0] or element["from"][2] == element["to"][2]) and element.get("rotation", {}).get("axis") == "y" and abs(element["rotation"].get("angle", 0)) == 45 for element in elements):
                result["shape"] = "cross"
            return result

        for filename in sorted(entries):
            if not filename.startswith("assets/minecraft/blockstates/") or not filename.endswith(".json"):
                continue
            name = Path(filename).stem
            state = read(filename)
            variant = preferred(state["variants"]) if state.get("variants") else next((item["apply"] for item in state.get("multipart", []) if "apply" in item), {})
            blocks[name] = describe(name, variant)
            upper = {key: value for key, value in state.get("variants", {}).items() if "half=upper" in key.split(",")}
            if blocks[name].get("shape") == "cross" and upper:
                blocks[name + "[half=upper]"] = describe(name, preferred(upper))

        textures, frames, index_by_name, alpha_by_name = [], [], {}, {}
        missing = Image.new("RGBA", (16, 16))
        missing.putdata([(255, 0, 255, 255) if (x // 8 + y // 8) % 2 else (0, 0, 0, 255) for y in range(16) for x in range(16)])
        for name in ["missing"] + sorted(used - {"missing"}):
            filename = "assets/minecraft/textures/" + name + ".png"
            source = missing if name == "missing" else Image.open(io.BytesIO(archive.read(filename))).convert("RGBA")
            meta = read(filename + ".mcmeta").get("animation", {}) if filename + ".mcmeta" in entries else {}
            width = meta.get("width", source.width)
            height = meta.get("height", min(source.height, width))
            frame_count = (source.width // width) * (source.height // height)
            timeline = meta.get("frames", list(range(frame_count))) or [0]
            times = [item.get("time", meta.get("frametime", 1)) if isinstance(item, dict) else meta.get("frametime", 1) for item in timeline]
            step = reduce(math.gcd, times)
            sequence = []
            for item, duration in zip(timeline, times):
                frame = item["index"] if isinstance(item, dict) else item
                sequence.extend([frame] * (duration // step))
            if len(sequence) > 512:
                raise ValueError("Animation timeline is too large: " + name)
            first = len(frames)
            index_by_name[name] = first
            alpha = set(source.getchannel("A").tobytes())
            alpha_by_name[name] = 2 if any(0 < a < 255 for a in alpha) else 1 if 0 in alpha else 0
            for frame in sequence:
                x = (frame % (source.width // width)) * width
                y = (frame // (source.width // width)) * height
                image = source.crop((x, y, x + width, y + height)).resize((INNER, INNER), Image.Resampling.NEAREST)
                padded = Image.new("RGBA", (CELL, CELL))
                padded.paste(image, (PADDING, PADDING))
                # Extruded texels protect each sprite's mip levels from adjacent sprites.
                for px in range(CELL):
                    for py in range(CELL):
                        if not (PADDING <= px < PADDING + INNER and PADDING <= py < PADDING + INNER):
                            padded.putpixel((px, py), image.getpixel((max(0, min(INNER - 1, px - PADDING)), max(0, min(INNER - 1, py - PADDING)))))
                frames.append(padded)
            textures.append([name, first, len(sequence), step / 20, bool(meta.get("interpolate"))])

        rows = 1 << math.ceil(math.log2(max(1, math.ceil(len(frames) / COLUMNS))))
        atlas = Image.new("RGBA", (COLUMNS * CELL, rows * CELL))
        for index, frame in enumerate(frames):
            atlas.paste(frame, ((index % COLUMNS) * CELL, (index // COLUMNS) * CELL))
        for name, value in blocks.items():
            value["kind"] = max(alpha_by_name.get(texture, 0) for texture in value["faces"])
            value["faces"] = [index_by_name[texture] for texture in value["faces"]]
            if "leaves" in name:
                value["kind"] = 1
            if name in ("water", "lava"):
                value["kind"] = 2 if name == "water" else 0

        biomes = biome_palette(archive, biome_archive)

        output = ROOT / "panel/src/assets/minecraft"
        output.mkdir(parents=True, exist_ok=True)
        atlas.save(output / "atlas.png", optimize=True)
        metadata = {"version": read("version.json")["id"], "atlas": {"width": atlas.width, "height": atlas.height, "cell": CELL, "inner": INNER, "padding": PADDING, "columns": COLUMNS}, "textures": textures, "blocks": blocks, "biomes": biomes, "biomeVersion": biome_version}
        (ROOT / "shared/minecraft-assets.json").write_text(json.dumps(metadata, separators=(",", ":")) + "\n")
        base_blocks = sum("[" not in name for name in blocks)
        provenance = {"minecraftVersion": metadata["version"], "jarSha256": hashlib.sha256(jar.read_bytes()).hexdigest(), "atlasSha256": hashlib.sha256((output / "atlas.png").read_bytes()).hexdigest(), "textures": len(textures) - 1, "frames": len(frames), "blocks": base_blocks, "variants": len(blocks) - base_blocks, **biome_source}
        (output / "source.json").write_text(json.dumps(provenance, indent=2) + "\n")
        print(json.dumps(provenance, indent=2))
        print("Atlas:", atlas.size)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jar", type=Path)
    parser.add_argument("--biomes", type=Path, help="Client or bundled server JAR supplying biome definitions")
    parser.add_argument("--biomes-only", action="store_true", help="Update biome colors without replacing textures or models")
    args = parser.parse_args()
    main(args.jar, args.biomes, args.biomes_only)
