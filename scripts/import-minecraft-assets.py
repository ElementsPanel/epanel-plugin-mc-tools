#!/usr/bin/env python3
"""Build the map's texture atlas from a locally supplied Minecraft client JAR.

Usage: python3 scripts/import-minecraft-assets.py /path/to/client.jar
Fill newer blocks without replacing the base version's textures:
  python3 scripts/import-minecraft-assets.py /path/to/client.jar --supplement /path/to/newer-client.jar --biomes /path/to/newer-client.jar
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


def fire_blocks(archive, sprites):
    """Preserve fire's multipart conditions, inclined planes and animated alternatives."""
    entries = set(archive.namelist())
    directions = ["north", "east", "south", "west", "up"]
    @lru_cache(None)
    def model(name):
        own = json.loads(archive.read("assets/minecraft/models/" + name.removeprefix("minecraft:") + ".json"))
        parent = model(own["parent"]) if own.get("parent") else {}
        return {**parent, **own, "textures": {**parent.get("textures", {}), **own.get("textures", {})}}
    def matches(condition, mask):
        return all(any(matches(c, mask) for c in value) if key == "OR" else
            all(matches(c, mask) for c in value) if key == "AND" else
            ("true" if mask & (1 << directions.index(key)) else "false") in value.split("|")
            for key, value in condition.items())
    result = {}
    for name in ["fire", "soul_fire"]:
        filename = "assets/minecraft/blockstates/" + name + ".json"
        if filename not in entries:
            continue
        parts = []
        for part in json.loads(archive.read(filename))["multipart"]:
            variants = []
            for variant in part["apply"] if isinstance(part["apply"], list) else [part["apply"]]:
                definition = model(variant["model"])
                def texture(value):
                    while value.startswith("#"):
                        value = definition["textures"][value[1:]]
                    return sprites[value.removeprefix("minecraft:")]
                variants.append([{**element, "yaw": variant.get("y", 0), "faces": {
                    direction: {**face, "texture": texture(face["texture"])} for direction, face in element["faces"].items()
                }} for element in definition["elements"]])
            parts.append({"connections": [mask for mask in range(32) if matches(part.get("when", {}), mask)], "variants": variants})
        result[name] = {"faces": [sprites["block/" + name + "_0"]] * 6, "tint": 0, "overlay": 0,
            "kind": 1, "shape": "model", "fire": parts}
    return result


def main(jar, biome_jar=None, biomes_only=False, supplement=None):
    biome_jar = biome_jar or jar
    with resources(jar) as archive, resources(biome_jar) as biome_archive, resources(supplement or jar) as extra:
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
        base_entries = set(archive.namelist())
        entries = base_entries | set(extra.namelist())
        metadata_file = ROOT / "shared/minecraft-assets.json"
        previous = json.loads(metadata_file.read_text()) if metadata_file.exists() else {}

        def read_bytes(name):
            # The supplied base version wins; a supplement only fills absent assets.
            return (archive if name in base_entries else extra).read(name)

        def read(name):
            return json.loads(read_bytes(name))

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
            while value and (value.startswith("#") or value in textures) and value not in seen:
                seen.add(value)
                value = textures.get(value.removeprefix("#"))
                if isinstance(value, dict):
                    value = value.get("sprite")
            value = (value or "missing").removeprefix("minecraft:")
            return value if "assets/minecraft/textures/" + value + ".png" in entries else "missing"

        def preferred(variants):
            defaults = {"axis": "y", "half": "bottom", "type": "bottom", "facing": "north", "snowy": "false", "open": "false", "lit": "false", "age": "0", "stage": "0", "shape": "straight"}
            def score(key):
                fields = dict(part.split("=", 1) for part in key.split(",") if "=" in part)
                return sum(value == fields.get(name) for name, value in defaults.items())
            return max(variants, key=score)

        blocks, states = {}, {}
        # Include every block sprite, including nondefault states and multipart pieces.
        used = {name.removeprefix("assets/minecraft/textures/").removesuffix(".png") for name in entries
            if name.startswith("assets/minecraft/textures/block/") and name.endswith(".png")}
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
            # Blockstate rotations also rotate which texture/tint belongs to each face.
            normals = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
            rotated, rotated_tint, rotated_overlay = faces.copy(), 0, 0
            for face, (x, y, z) in enumerate(normals):
                for _ in range(variant.get("x", 0) // 90):
                    y, z = z, -y
                for _ in range(variant.get("y", 0) // 90):
                    x, z = -z, x
                target = normals.index((x, y, z))
                rotated[target] = faces[face]
                if tint & (1 << face):
                    rotated_tint |= 1 << target
                if overlay & (1 << face):
                    rotated_overlay |= 1 << target
            faces, tint, overlay = rotated, rotated_tint, rotated_overlay
            used.update(faces)
            result = {"faces": faces, "tint": tint, "overlay": overlay}
            elements = definition.get("elements", [])
            # Flowerbeds add short vertical stem planes beneath their petals.
            # Treat these low, flat decorations like litter, not full cubes.
            low_planes = elements and all(0 <= element["from"][1] <= element["to"][1] <= 3
                and any(element["from"][axis] == element["to"][axis] for axis in range(3)) for element in elements)
            if low_planes and any(element["from"][1] == element["to"][1] and "up" in element.get("faces", {}) for element in elements):
                result["shape"] = "ground"
            elif elements and all((element["from"][0] == element["to"][0] or element["from"][2] == element["to"][2]) and element.get("rotation", {}).get("axis") == "y" and abs(element["rotation"].get("angle", 0)) == 45 for element in elements):
                result["shape"] = "cross"
            if name == "shelf_mushroom":
                result["shape"] = "model"
                result["rotation"] = variant.get("y", 0)
                result["elements"] = [{"from": element["from"], "to": element["to"], "faces": {
                    direction: {"texture": resolve(face["texture"], textures), "uv": face["uv"]}
                    for direction, face in element["faces"].items()}} for element in elements]
            return result

        for filename in sorted(entries):
            if not filename.startswith("assets/minecraft/blockstates/") or not filename.endswith(".json"):
                continue
            name = Path(filename).stem
            state = read(filename)
            variants = state.get("variants", {})
            default = preferred(variants) if variants else ""
            variant = variants[default] if variants else next((item["apply"] for item in state.get("multipart", []) if "apply" in item), {})
            blocks[name] = describe(name, variant)
            upper = {key: value for key, value in variants.items() if "half=upper" in key.split(",")}
            if blocks[name].get("shape") == "cross" and upper:
                blocks[name + "[half=upper]"] = describe(name, upper[preferred(upper)])
            models, cases = [], []
            for key, value in variants.items():
                material = describe(name, value)
                if material not in models:
                    models.append(material)
                fields = dict(part.split("=", 1) for part in key.split(",") if "=" in part)
                cases.append((fields, models.index(material)))
            if len(models) > 1:
                properties = sorted({key for fields, _ in cases for key in fields})
                # Discard properties that only change geometry (e.g. slab type).
                for prop in properties.copy():
                    projected = {}
                    for fields, index in cases:
                        key = tuple(fields.get(p, "") for p in properties if p != prop)
                        projected.setdefault(key, set()).add(index)
                    if all(len(indices) == 1 for indices in projected.values()):
                        properties.remove(prop)
                defaults = dict(part.split("=", 1) for part in default.split(",") if "=" in part)
                states[name] = {"properties": properties, "defaults": [defaults.get(p, "") for p in properties],
                    "variants": {",".join(fields.get(p, "") for p in properties): index for fields, index in cases}, "models": models}

        textures, frames, index_by_name, alpha_by_name = [], [], {}, {}
        previous_textures = {texture[0]: texture for texture in previous.get("textures", [])}
        frames = [None] * max((texture[1] + texture[2] for texture in previous_textures.values()), default=0)
        missing = Image.new("RGBA", (16, 16))
        missing.putdata([(255, 0, 255, 255) if (x // 8 + y // 8) % 2 else (0, 0, 0, 255) for y in range(16) for x in range(16)])
        used.add("missing")
        ordered = [name for name in previous_textures if name in used]
        ordered += sorted(used - set(ordered)) if ordered else ["missing"] + sorted(used - {"missing"})
        for name in ordered:
            filename = "assets/minecraft/textures/" + name + ".png"
            source = missing if name == "missing" else Image.open(io.BytesIO(read_bytes(filename))).convert("RGBA")
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
            old = previous_textures.get(name)
            first = old[1] if old and old[2] == len(sequence) else len(frames)
            if first == len(frames):
                frames.extend([None] * len(sequence))
            index_by_name[name] = first
            alpha = set(source.getchannel("A").tobytes())
            alpha_by_name[name] = 2 if any(0 < a < 255 for a in alpha) else 1 if 0 in alpha else 0
            for offset, frame in enumerate(sequence):
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
                frames[first + offset] = padded
            textures.append([name, first, len(sequence), step / 20, bool(meta.get("interpolate"))])

        rows = 1 << math.ceil(math.log2(max(1, math.ceil(len(frames) / COLUMNS))))
        atlas = Image.new("RGBA", (COLUMNS * CELL, rows * CELL))
        for index, frame in enumerate(frames):
            if frame is not None:
                atlas.paste(frame, ((index % COLUMNS) * CELL, (index // COLUMNS) * CELL))
        def encode(name, value):
            value["kind"] = max(alpha_by_name.get(texture, 0) for texture in value["faces"])
            value["faces"] = [index_by_name[texture] for texture in value["faces"]]
            for element in value.get("elements", []):
                for face in element["faces"].values():
                    face["texture"] = index_by_name[face["texture"]]
            if "leaves" in name:
                value["kind"] = 1
            if name in ("water", "lava"):
                value["kind"] = 2 if name == "water" else 0
        for name, value in blocks.items():
            encode(name, value)
        for name, state in states.items():
            for value in state["models"]:
                encode(name, value)
        blocks.update(fire_blocks(archive, index_by_name))

        biomes = biome_palette(archive, biome_archive)

        # The flat 2D map fills each column with its top face's average sprite color.
        frame_names = {}
        for name, first, count, _duration, _interpolate in textures:
            for frame in range(first, first + count):
                frame_names[frame] = name
        def top_color(value):
            frame = frames[value["faces"][2]]
            if frame is None:
                return None
            pixels = [frame.getpixel((PADDING + x, PADDING + y)) for y in range(INNER) for x in range(INNER)]
            alpha = sum(pixel[3] for pixel in pixels)
            if not alpha:
                return None
            return tuple(round(sum(pixel[channel] * pixel[3] for pixel in pixels) / alpha) for channel in range(3))
        top_colors = {}
        for name, value in blocks.items():
            if "[" in name or frame_names.get(value["faces"][2]) == "missing":
                continue
            color = top_color(value)
            if color is not None:
                top_colors[name] = (color[0] << 16) | (color[1] << 8) | color[2]

        output = ROOT / "panel/src/assets/minecraft"
        output.mkdir(parents=True, exist_ok=True)
        atlas.save(output / "atlas.png", optimize=True)
        (ROOT / "shared/top-colors.json").write_text(json.dumps(top_colors, separators=(",", ":"), sort_keys=True) + "\n")
        metadata = {"version": read("version.json")["id"], "atlas": {"width": atlas.width, "height": atlas.height, "cell": CELL, "inner": INNER, "padding": PADDING, "columns": COLUMNS}, "textures": textures, "blocks": blocks, "states": states, "biomes": biomes, "biomeVersion": biome_version}
        (ROOT / "shared/minecraft-assets.json").write_text(json.dumps(metadata, separators=(",", ":")) + "\n")
        base_blocks = sum("[" not in name for name in blocks)
        provenance = {"minecraftVersion": metadata["version"], "jarSha256": hashlib.sha256(jar.read_bytes()).hexdigest(), "atlasSha256": hashlib.sha256((output / "atlas.png").read_bytes()).hexdigest(), "textures": len(textures) - 1, "frames": len(frames), "blocks": base_blocks, "variants": len(blocks) - base_blocks, **biome_source}
        if supplement:
            provenance.update({"supplementVersion": json.loads(extra.read("version.json"))["id"],
                "supplementJarSha256": hashlib.sha256(supplement.read_bytes()).hexdigest(),
                "supplementBlocks": sum(name.startswith("assets/minecraft/blockstates/") and name.endswith(".json") for name in entries - base_entries)})
        provenance["stateModels"] = sum(len(state["models"]) for state in states.values())
        (output / "source.json").write_text(json.dumps(provenance, indent=2) + "\n")
        print(json.dumps(provenance, indent=2))
        print("Atlas:", atlas.size)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jar", type=Path)
    parser.add_argument("--biomes", type=Path, help="Client or bundled server JAR supplying biome definitions")
    parser.add_argument("--biomes-only", action="store_true", help="Update biome colors without replacing textures or models")
    parser.add_argument("--supplement", type=Path, help="Additional client JAR supplying blocks and textures absent from the base JAR")
    args = parser.parse_args()
    main(args.jar, args.biomes, args.biomes_only, args.supplement)
