"""Importer regressions; run with python3 tests/import-minecraft-assets.test.py."""
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from PIL import Image

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("assets", Path(__file__).resolve().parents[1] / "scripts/import-minecraft-assets.py")
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


def png(color):
    output = io.BytesIO()
    Image.new("RGBA", (16, 16), color).save(output, format="PNG")
    return output.getvalue()


def jar(path, version, textures, blocks):
    with ZipFile(path, "w") as archive:
        archive.writestr("version.json", json.dumps({"id": version}))
        for name in ("grass", "foliage", "dry_foliage"):
            output = io.BytesIO()
            Image.new("RGB", (256, 256), "green").save(output, format="PNG")
            archive.writestr("assets/minecraft/textures/colormap/" + name + ".png", output.getvalue())
        archive.writestr("data/minecraft/worldgen/biome/plains.json", json.dumps({"temperature": 0.8, "downfall": 0.4}))
        for name, color in textures.items():
            archive.writestr("assets/minecraft/textures/block/" + name + ".png", png(color))
        for name, texture in blocks.items():
            archive.writestr("assets/minecraft/blockstates/" + name + ".json", json.dumps({"variants": {"": {"model": "block/" + name}}}))
            # The official heavy-core model uses a bare alias instead of #all.
            model = {"textures": {"all": "block/" + texture}, "elements": [{"from": [0, 0, 0], "to": [16, 16, 16],
                "faces": {face: {"texture": "all"} for face in assets.DIRECTIONS}}]}
            archive.writestr("assets/minecraft/models/block/" + name + ".json", json.dumps(model))


class ImportTests(unittest.TestCase):
    def test_fire_multipart_inheritance_rotation_and_texture_alternatives(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "fire.jar"
            standing = {name: "false" for name in ["north", "east", "south", "west", "up"]}
            with ZipFile(filename, "w") as archive:
                archive.writestr("assets/minecraft/blockstates/fire.json", json.dumps({"multipart": [
                    {"when": standing, "apply": [{"model": "block/fire_floor0"}, {"model": "block/fire_floor1"}]},
                    {"when": {"OR": [{"east": "true"}, standing]}, "apply": {"model": "block/fire_floor0", "y": 90}}
                ]}))
                archive.writestr("assets/minecraft/models/block/template_fire.json", json.dumps({"elements": [{
                    "from": [0, 0, 8.8], "to": [16, 22.4, 8.8],
                    "rotation": {"origin": [8, 8, 8], "axis": "x", "angle": -22.5, "rescale": True},
                    "faces": {"south": {"texture": "#fire", "uv": [0, 0, 16, 16], "rotation": 270}}
                }]}))
                for index in [0, 1]:
                    archive.writestr(f"assets/minecraft/models/block/fire_floor{index}.json", json.dumps({
                        "parent": "minecraft:block/template_fire", "textures": {"fire": f"minecraft:block/fire_{index}"}
                    }))
            with ZipFile(filename) as archive:
                model = assets.fire_blocks(archive, {"block/fire_0": 10, "block/fire_1": 42})["fire"]
            self.assertEqual(model["shape"], "model")
            floor, side = model["fire"]
            self.assertEqual(floor["connections"], [0])
            self.assertEqual(side["connections"], [0] + [mask for mask in range(32) if mask & 2])
            self.assertEqual([v[0]["faces"]["south"]["texture"] for v in floor["variants"]], [10, 42])
            element = side["variants"][0][0]
            self.assertEqual(element["yaw"], 90)
            self.assertEqual(element["rotation"], {"origin": [8, 8, 8], "axis": "x", "angle": -22.5, "rescale": True})
            self.assertEqual(element["faces"]["south"]["rotation"], 270)

    def test_complete_sprites_aliases_supplement_precedence_and_stable_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original_root = assets.ROOT
            assets.ROOT = root
            self.addCleanup(setattr, assets, "ROOT", original_root)
            (root / "shared").mkdir()
            base, extra = root / "base.jar", root / "extra.jar"
            jar(base, "base", {"z_core": "red", "unused_state": "blue"}, {"heavy_core": "z_core"})
            with contextlib.redirect_stdout(io.StringIO()):
                assets.main(base)
            metadata_file = root / "shared/minecraft-assets.json"
            first = json.loads(metadata_file.read_text())
            sprites = {t[0]: t for t in first["textures"]}
            self.assertIn("block/unused_state", sprites, "nondefault sprites must not be dropped")
            self.assertEqual(first["blocks"]["heavy_core"]["faces"], [sprites["block/z_core"][1]] * 6)

            # A lexically earlier sprite must not shift existing cached sprite IDs.
            jar(extra, "extra", {"a_leaves": "yellow", "z_core": "green"}, {"new_leaves": "a_leaves", "heavy_core": "a_leaves"})
            with contextlib.redirect_stdout(io.StringIO()):
                assets.main(base, supplement=extra)
            second = json.loads(metadata_file.read_text())
            second_sprites = {t[0]: t for t in second["textures"]}
            for name, texture in sprites.items():
                self.assertEqual(second_sprites[name], texture)
            self.assertEqual(second["blocks"]["heavy_core"], first["blocks"]["heavy_core"])
            self.assertTrue(all(second["blocks"]["new_leaves"]["faces"]))
            atlas_file = root / "panel/src/assets/minecraft/atlas.png"
            with Image.open(atlas_file) as atlas:
                frame = sprites["block/z_core"][1]
                self.assertEqual(atlas.getpixel((frame % 64 * 32 + 8, frame // 64 * 32 + 8)), (255, 0, 0, 255))
            before = metadata_file.read_bytes(), atlas_file.read_bytes()
            with contextlib.redirect_stdout(io.StringIO()):
                assets.main(base, supplement=extra)
            self.assertEqual((metadata_file.read_bytes(), atlas_file.read_bytes()), before, "reimport is reproducible")


if __name__ == "__main__":
    unittest.main()
