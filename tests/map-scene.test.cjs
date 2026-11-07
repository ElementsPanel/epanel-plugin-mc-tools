const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loader } = require("./helpers.cjs");
const load = loader();
const { meshScene } = load("daemon/src/backend/map/scene.ts");
const { surfaceFromLayers } = load("daemon/src/backend/map/chunk.ts");
const { decodeScene, decodeSceneTile } = load("panel/src/map/scene-codec.ts");
const { SceneKind, minecraftAssets, sceneTextures, SCENE_GRASS_OVERLAY, SCENE_GROUND } = load("shared/scene.ts");
const { MAP_SCENE_MAX_QUADS, mapSceneCoordinate } = load("shared/map.ts");
const layer = (y, block) => ({ y, block: typeof block === "function" ? index => block(index & 15, index >> 8, (index >> 4) & 15) : () => block });
const chunk = (layers, x = 0, z = 0) => ({ x, z, layers });
const tile = async (chunks, nether = false, neighbors = []) => ({ ...await meshScene(chunks, nether, undefined, neighbors), chunks: chunks.length, warnings: 0 });
function quads(tile) {
  const b = Buffer.from(tile.quads, "base64");
  return Array.from({ length: b.length / 16 }, (_, i) => {
    const o = i * 16;
    return { x: b[o], z: b[o + 1], y: b.readInt16LE(o + 2), w: b.readUInt16LE(o + 4), h: b.readUInt16LE(o + 6), face: b[o + 8], kind: b[o + 9] & 3, flags: b[o + 9], texture: b.readUInt16LE(o + 10), tint: b.readUIntBE(o + 12, 3), ao: b[o + 15] };
  });
}

test("voxel meshes merge solid terrain, cull chunk seams and provide compact instances for every face", async () => {
  const result = await tile([chunk([layer(4, "grass_block")]), chunk([layer(4, "grass_block")], 1)]);
  const decoded = decodeScene(result);
  const faces = quads(result);
  assert.equal(faces.reduce((area, q) => area + q.w * q.h, 0), 2 * (32 * 16 + 32 * 16 + 16 * 16));
  assert(faces.some(q => q.w >= 16 && q.h >= 16), "uniformly shaded terrain still merges into large faces");
  assert(!faces.some(q => q.face < 2 && q.x === 16), "no internal chunk seam");
  assert.equal(decoded.heights[0], 79); assert.equal(decoded.heights[31], 79);
  assert.equal(decoded.heights[32 * 16], -32768);
  assert.equal(result.limited, false);
  assert.deepEqual([...new Set(faces.map(q => q.face))].sort(), [0, 1, 2, 3, 4, 5]);
  assert.equal(Math.min(...decoded.meshes.map(part => part.minY)), 64);
  assert.equal(Math.max(...decoded.meshes.map(part => part.maxY)), 80);
  for (const part of decoded.meshes) {
    assert.equal(part.origins.length, part.count * 3);
    assert.equal(part.sizes.length, part.count * 2);
    assert.equal(part.sprites.length, part.count);
    assert.equal(part.colors.length, part.count * 3);
    assert(part.sprites.every(sprite => sceneTextures.has(sprite)));
  }
});

test("3D geometry retains hidden cavities and overhangs even when their 2D surface is identical", async () => {
  const solid = layer(0, (x, y, z) => x >= 1 && x <= 3 && y >= 1 && y <= 3 && z >= 1 && z <= 3 ? "stone" : "air");
  const hollow = layer(0, (x, y, z) => x === 2 && y === 2 && z === 2 ? "air" : solid.block(y * 256 + z * 16 + x));
  assert.deepEqual(surfaceFromLayers([solid]), surfaceFromLayers([hollow]));
  const area = result => quads(result).reduce((total, q) => total + q.w * q.h, 0);
  assert.equal(area(await tile([chunk([solid])])), 54);
  const result = await tile([chunk([hollow])]);
  assert.equal(area(result), 60);
  assert(quads(result).some(q => q.face === 3 && q.y === 3 && q.x === 2 && q.z === 2), "cavity ceiling has a visible underside");
});

test("water retains the solid faces beneath it, foliage uses cutouts and small plants use crossed planes", async () => {
  const result = await tile([chunk([layer(0, (x, y, z) => {
    if (z !== 1) return "air";
    if (x === 1 && y === 0) return "stone";
    if (x === 1 && y === 1) return "water";
    if (x === 3 && y === 0) return "oak_leaves";
    if (x === 5 && y === 0) return "short_grass";
    return "air";
  })])]);
  const faces = quads(result);
  assert(faces.some(q => q.x === 1 && q.y === 1 && q.face === 2 && q.kind === SceneKind.Opaque));
  assert(faces.some(q => sceneTextures.get(q.texture)?.[0] === "block/water_still"));
  assert(faces.some(q => sceneTextures.get(q.texture)?.[0] === "block/oak_leaves" && q.kind === SceneKind.Cutout));
  assert.deepEqual(faces.filter(q => q.kind === SceneKind.Plant).map(q => q.face), [6, 7]);
  assert(decodeScene(result).meshes.some(mesh => mesh.kind === SceneKind.Plant));
  assert.equal(decodeScene(result).animated, true);
});

test("water joins across scene boundaries and biome colors without duplicate internal walls", async () => {
  const water = biome => ({ ...layer(0, "water"), biome: () => biome });
  const chunks = [chunk([water("minecraft:plains")]), chunk([water("minecraft:swamp")], 1), chunk([water("minecraft:plains")], 0, 1), chunk([water("minecraft:swamp")], 1, 1)];
  const exposed = quads(await tile(chunks));
  assert(exposed.some(q => q.face === 0 && q.x === 32), "a true outer water edge remains visible");
  assert(!exposed.some(q => q.face < 2 && q.x === 16), "biome tint changes do not create water walls");
  const adjacent = [chunk([water("minecraft:plains")], 2), chunk([water("minecraft:plains")], 2, 1)];
  const joined = await tile(chunks, false, adjacent), faces = quads(joined);
  assert(!faces.some(q => q.face === 0 && q.x === 32), "the adjacent scene hides the shared east face");
  assert(faces.some(q => q.face === 2 && q.y === 16), "the water surface stays visible");
  assert.equal(joined.chunks, 4);
  assert(faces.every(q => q.x <= 32 && q.z <= 32), "neighboring geometry is not emitted twice");
  assert.equal(decodeScene(joined).count, faces.length);
});

test("underwater plants coexist with a continuous water volume instead of carving air holes", async () => {
  for (const plant of ["seagrass", "tall_seagrass", "kelp", "kelp_plant"]) {
    const wet = layer(0, (x, y, z) => y === 0 && z === 0 && x < 2 ? x === 0 ? plant : "water" : "air");
    const faces = quads(await tile([chunk([wet])]));
    const water = faces.filter(face => face.kind === SceneKind.Translucent);
    assert.equal(water.length, 6, plant + " shares the outer water shell");
    assert(!water.some(face => face.face < 2 && face.x === 1), "no internal wall between water and the waterlogged plant");
    assert.equal(faces.filter(face => face.kind === SceneKind.Plant).length, 2);
    assert(water.some(face => face.face === 2 && face.y === 1 && face.h === 2));
    // Seen from above the plant's vertical quads vanish: the column is plain water.
    const flat = surfaceFromLayers([wet]).colors;
    assert.equal(flat[0], flat[1]);
    assert.notEqual(flat[0], 0);
  }
});

test("Java waterlogged states and Bedrock secondary storage retain both the block and its water", async () => {
  const { chunkLayers } = load("daemon/src/backend/map/chunk.ts");
  const { bedrockLayer } = load("daemon/src/backend/map/bedrock.ts");
  const nbt = require("prismarine-nbt");
  const java = chunkLayers({ DataVersion: 4903, sections: [{ Y: 0, block_states: { palette: [
    { Name: "minecraft:mangrove_roots", Properties: { waterlogged: "true" } }
  ] } }] });
  const faces = quads(await tile([chunk(java)]));
  assert(faces.some(face => face.kind === SceneKind.Translucent));
  assert(faces.some(face => sceneTextures.get(face.texture)[0].includes("mangrove_roots")));
  const storage = name => Buffer.concat([Buffer.from([0]), nbt.writeUncompressed(nbt.comp({ name: nbt.string("minecraft:" + name), states: nbt.comp({}) }), "little")]);
  const wet = bedrockLayer(Buffer.concat([Buffer.from([9, 2, 0]), storage("seagrass"), storage("water")]), 0);
  assert.equal(wet.block(1234), "minecraft:seagrass");
  assert.equal(wet.fluid(1234), "minecraft:water");
  const decoded = decodeScene(await tile([chunk([wet])]));
  assert.equal(decoded.meshes.find(mesh => mesh.kind === SceneKind.Translucent).count, 6);
  assert.equal(decoded.meshes.find(mesh => mesh.kind === SceneKind.Plant).count, 4096 * 2);
  const dry = bedrockLayer(Buffer.concat([Buffer.from([9, 1, 0]), storage("mangrove_roots")]), 0);
  assert.equal(dry.fluid(0), undefined);
});

test("vanilla face textures retain their original tint masks and Java biome palettes color grass", async () => {
  const { chunkLayers } = load("daemon/src/backend/map/chunk.ts");
  const layers = chunkLayers({ DataVersion: 4903, sections: [{ Y: 0,
    block_states: { palette: ["minecraft:grass_block"] },
    biomes: { palette: ["minecraft:swamp"] }
  }] });
  assert.equal(layers[0].biome(4095), "minecraft:swamp");
  const faces = quads(await tile([chunk(layers)]));
  const top = faces.find(q => q.face === 2), bottom = faces.find(q => q.face === 3), side = faces.find(q => q.face === 0);
  assert.equal(sceneTextures.get(top.texture)[0], "block/grass_block_top");
  assert.equal(top.tint, minecraftAssets.biomes["minecraft:swamp"][0]);
  assert.equal(sceneTextures.get(bottom.texture)[0], "block/dirt");
  assert.equal(bottom.tint, 0xffffff);
  assert.equal(sceneTextures.get(side.texture)[0], "block/grass_block_side");
  assert(side.flags & SCENE_GRASS_OVERLAY);
  assert.equal(side.tint, top.tint);
});

test("26.3 dappled forest uses its own grass, foliage and water colors through NBT decoding and scene meshing", async () => {
  const { chunkLayers } = load("daemon/src/backend/map/chunk.ts");
  // Official 26.3 biome effects; this biome previously fell back to plains.
  const expected = [0xdf6827, 0xe68e30, 0x375154, 0x8c3a04];
  assert.equal(minecraftAssets.biomeVersion, "26.3");
  assert.deepEqual(minecraftAssets.biomes["minecraft:dappled_forest"], expected);
  for (const [name, color] of [["grass_block", expected[0]], ["short_grass", expected[0]],
    ["oak_leaves", expected[1]], ["water", expected[2]], ["leaf_litter", expected[3]]]) {
    const layers = chunkLayers({ DataVersion: 5023, sections: [{ Y: 0,
      block_states: { palette: ["minecraft:" + name] }, biomes: { palette: ["minecraft:dappled_forest"] }
    }] });
    const result = await tile([chunk(layers)]), faces = quads(result);
    const tinted = faces.filter(face => name === "short_grass" ? face.face >= 6 : face.face === 2);
    assert(tinted.length > 0, name);
    assert(tinted.every(face => face.tint === color), name);
    assert(decodeScene(result).meshes.some(mesh => {
      const rgb = mesh.colors;
      return Array.from({ length: mesh.count }, (_, i) => (rgb[i * 3] << 16) | (rgb[i * 3 + 1] << 8) | rgb[i * 3 + 2]).includes(color);
    }), "the correct RGB tint reaches the shared 2D/3D renderer");
  }
});

test("grass, foliage and water transition across biome borders while preserving interior colors and untinted faces", async () => {
  const { chunkLayers } = load("daemon/src/backend/map/chunk.ts");
  let packed = 0n;
  for (let i = 0; i < 64; i++) if ((i & 3) >= 2) packed |= 1n << BigInt(i);
  for (const [block, first, second] of [["grass_block", 0xdf6827, 0x91bd59],
    ["oak_leaves", minecraftAssets.biomes["minecraft:dappled_forest"][1], minecraftAssets.biomes["minecraft:plains"][1]],
    ["water", 0x375154, 0x3f76e4]]) {
    const layers = chunkLayers({ DataVersion: 5023, sections: [{ Y: 0,
      block_states: { palette: ["minecraft:" + block] },
      biomes: { palette: ["minecraft:dappled_forest", "minecraft:plains"], data: [packed] }
    }] });
    const faces = quads(await tile([chunk(layers)]));
    const tops = faces.filter(face => face.face === 2);
    const color = x => tops.find(face => x >= face.x && x < face.x + face.h && face.z <= 7 && face.z + face.w > 7).tint;
    assert.equal(color(0), first); assert.equal(color(15), second);
    assert.equal(new Set(Array.from({ length: 8 }, (_, i) => color(i + 4))).size, 8, "the transition has intermediate colors, not a hard boundary");
    for (let x = 5; x <= 10; x++) for (const shift of [16, 8, 0]) {
      const a = (first >> shift) & 255, b = (second >> shift) & 255;
      const before = (color(x - 1) >> shift) & 255, now = (color(x) >> shift) & 255;
      assert(now >= Math.min(a, b) && now <= Math.max(a, b));
      assert(b > a ? now >= before : now <= before, "each color channel changes monotonically");
    }
    if (block === "grass_block") {
      assert(faces.filter(face => face.face === 3).every(face => face.tint === 0xffffff), "the dirt underside is not biome tinted");
      assert(faces.filter(face => face.face === 4).some(face => face.tint !== first && face.tint !== second && face.flags & SCENE_GRASS_OVERLAY), "the grass side overlay also blends");
    }
    assert(!faces.some(face => face.face < 2 && face.x === 8), "a tint change does not create a wall");
  }
});

test("biome blending crosses adjoining scene tiles at negative coordinates without a color seam", async () => {
  const mix = (a, b, count) => [16, 8, 0].reduce((color, shift) => color | (Math.round((((a >> shift) & 255) * (7 - count) + ((b >> shift) & 255) * count) / 7) << shift), 0);
  const first = minecraftAssets.biomes["minecraft:dappled_forest"][0], second = minecraftAssets.biomes["minecraft:plains"][0];
  for (const origin of [-2, 0]) {
    const owned = [], neighbors = [];
    for (let z = -1; z <= 2; z++) for (let x = origin - 1; x <= origin + 2; x++) {
      const blocks = { ...layer(-1, "grass_block"), biome: () => x < 0 ? "minecraft:dappled_forest" : "minecraft:plains" };
      const entry = chunk([blocks], x - origin, z);
      (entry.x >= 0 && entry.x < 2 && z >= 0 && z < 2 ? owned : neighbors).push(entry);
    }
    const result = await tile(owned, false, neighbors), tops = quads(result).filter(face => face.face === 2);
    for (let x = 0; x < 32; x++) {
      const worldX = x + origin * 16;
      const face = tops.find(face => x >= face.x && x < face.x + face.h && face.z <= 16 && face.z + face.w > 16);
      assert.equal(face.tint, mix(first, second, Math.max(0, Math.min(7, worldX + 4))), "world X=" + worldX);
    }
    assert(!result.limited);
    assert(!quads(result).some(face => face.face < 2 && face.x === (origin < 0 ? 32 : 0)), "the shared terrain edge stays culled");
  }
});

test("air-section biomes blend neighboring treetops without creating terrain or a plains-colored unloaded rim", async () => {
  const { chunkLayers } = load("daemon/src/backend/map/chunk.ts");
  const section = (Y, block, biome) => ({ Y, block_states: { palette: ["minecraft:" + block] }, biomes: { palette: ["minecraft:" + biome] } });
  const own = chunkLayers({ DataVersion: 5023, sections: [section(-1, "oak_leaves", "dappled_forest"), section(50, "air", "plains")] }, true);
  const air = { DataVersion: 5023, sections: [section(-1, "air", "plains")] };
  assert.equal(chunkLayers(air).length, 0, "ordinary surface extraction still skips air sections");
  const adjacent = chunkLayers(air, true);
  assert.equal(adjacent[0].empty, true); assert.equal(adjacent[0].biome(123), "minecraft:plains");
  const result = await tile([chunk(own)], false, [chunk(adjacent, 1)]);
  const faces = quads(result), tops = faces.filter(face => face.face === 2);
  const first = minecraftAssets.biomes["minecraft:dappled_forest"][1], second = minecraftAssets.biomes["minecraft:plains"][1];
  assert(tops.some(face => face.x === 0 && face.tint === first), "missing western chunks do not change the biome's own color");
  assert(tops.some(face => face.x === 15 && face.tint !== first && face.tint !== second), "eastern air provides real neighboring biome colors");
  assert(faces.every(face => face.y <= 0 && face.x <= 16 && face.z <= 16));
  assert.equal(Math.max(...decodeScene(result).meshes.map(mesh => mesh.maxY)), 0);
});

test("biome tint neighborhoods include both horizontal axes and keep each elevation's palette", () => {
  const { biomeBlend } = load("daemon/src/backend/map/biome-blend.ts");
  const names = ["minecraft:dappled_forest", "minecraft:plains", "minecraft:swamp", "minecraft:desert"];
  const chunks = [];
  for (let z = -1; z <= 2; z++) for (let x = -1; x <= 2; x++) {
    const biome = names[(z < 0 ? 0 : 2) + (x < 0 ? 0 : 1)];
    chunks.push(chunk([{ ...layer(0, "air"), empty: true, biome: index => index >> 8 < 8 ? biome : names[3] }], x, z));
  }
  const blend = biomeBlend(chunks);
  for (const tint of [0, 1, 3]) {
    const weights = [9, 12, 12, 16]; // 3×3, 4×3, 3×4 and 4×4 blocks around the corner.
    const expected = [16, 8, 0].reduce((rgb, shift) => rgb | (Math.round(names.reduce((sum, name, i) =>
      sum + ((minecraftAssets.biomes[name][tint] >> shift) & 255) * weights[i], 0) / 49) << shift), 0);
    assert.equal(blend(0, 3, 0, tint), expected);
    assert.equal(blend(0, 8, 0, tint), minecraftAssets.biomes[names[3]][tint]);
  }
});

test("leaf litter lies above the visible ground with Java dry-foliage tint, and model-defined bushes use crosses", async () => {
  const ground = layer(0, (x, y, z) => {
    if (z !== 1) return "air";
    if (x === 1 && y === 0) return "grass_block";
    if (x === 1 && y === 1) return "leaf_litter";
    if (x === 3 && y === 1) return "bush";
    return "air";
  });
  ground.biome = () => "minecraft:forest";
  const result = await tile([chunk([ground])]), faces = quads(result);
  const litter = faces.filter(q => sceneTextures.get(q.texture)[0] === "block/leaf_litter");
  assert.equal(litter.length, 1);
  assert.equal(litter[0].face, 2);
  assert.equal(litter[0].kind, SceneKind.Plant);
  assert.equal(litter[0].y, 1);
  assert(litter[0].flags & SCENE_GROUND);
  assert.equal(litter[0].tint, minecraftAssets.biomes["minecraft:forest"][3]);
  assert.notEqual(litter[0].tint, minecraftAssets.biomes["minecraft:forest"][0]);
  assert(faces.some(q => q.face === 2 && q.y === 1 && q.kind === SceneKind.Opaque), "ground remains visible through the litter's transparent pixels");
  assert.deepEqual(faces.filter(q => sceneTextures.get(q.texture)[0] === "block/bush").map(q => q.face), [6, 7]);
  assert.equal(decodeScene(result).count, faces.length);
});

test("pink petals and wildflowers lie on their supporting block like litter without raising a cube or hiding the ground", async () => {
  for (const name of ["pink_petals", "wildflowers", "leaf_litter"]) for (const sectionY of [-1, 0, 4]) {
    const blocks = layer(sectionY, (x, y, z) => x === 1 && z === 1 ? y === 0 ? "grass_block" : y === 1 ? name : "air" : "air");
    blocks.biome = () => "minecraft:dappled_forest";
    const baseY = sectionY * 16 + 1;
    const result = await tile([chunk([blocks])]), faces = quads(result);
    const plants = faces.filter(face => sceneTextures.get(face.texture)[0].startsWith("block/" + name));
    assert.equal(plants.length, 1, `${name} must not produce cube walls or crossed stems`);
    const [plant] = plants;
    assert.equal(plant.face, 2); assert.equal(plant.kind, SceneKind.Plant);
    assert.equal(plant.y, baseY, "petals sit at the bottom of their block, not a full block above the ground");
    assert.equal(plant.w, 1); assert.equal(plant.h, 1); assert(plant.flags & SCENE_GROUND);
    assert.equal(plant.tint, name === "leaf_litter" ? minecraftAssets.biomes["minecraft:dappled_forest"][3] : 0xffffff,
      "flower colors come from the petal texture; only litter receives dry-foliage tint");
    assert(faces.some(face => face.face === 2 && face.y === baseY && face.kind === SceneKind.Opaque), "transparent petal pixels reveal the supporting grass");
    const mesh = decodeScene(result).meshes.find(part => part.kind === SceneKind.Plant);
    assert.equal(mesh.minY, baseY); assert.equal(mesh.maxY, baseY + 1 / 64, "the only height offset is the existing anti-z-fighting offset");

  }
});

test("ground-cover classification also works with an older asset catalog", () => {
  const scene = load("shared/scene.ts"), blocks = { ...minecraftAssets.blocks };
  for (const name of ["pink_petals", "wildflowers"]) {
    blocks[name] = { ...blocks[name] }; delete blocks[name].shape;
  }
  const { blockMaterial } = loader({ "../../../../shared/scene": { ...scene, minecraftAssets: { ...minecraftAssets, blocks } } })("daemon/src/backend/map/materials.ts");
  for (const name of ["pink_petals", "wildflowers"]) {
    const material = blockMaterial("minecraft:" + name);
    assert.equal(material.kind, SceneKind.Plant); assert.equal(material.model.shape, "ground");
    assert.equal(blocks[name].shape, undefined, "runtime classification does not mutate the imported catalog");
  }
});

test("old daemon flower cubes decode at ground level in 3D, including merged petals and negative heights", async () => {
  const materials = load("daemon/src/backend/map/materials.ts");
  const legacyMesh = loader({ "./materials": { ...materials, blockMaterial(...args) {
    const material = materials.blockMaterial(...args);
    return ["pink_petals", "wildflowers"].includes(material.name)
      ? { ...material, model: { ...material.model, shape: undefined }, kind: SceneKind.Cutout } : material;
  } } })("daemon/src/backend/map/scene.ts").meshScene;
  for (const name of ["pink_petals", "wildflowers"]) for (const sectionY of [-1, 0, 4]) {
    const blocks = layer(sectionY, (x, y, z) => {
      if (z !== 1) return "air";
      if ((x === 1 || x === 2) && y === 0) return "grass_block";
      if ((x === 1 || x === 2) && y === 1) return name;
      return x === 4 && y === 1 ? "leaf_litter" : "air";
    });
    const old = { ...await legacyMesh([chunk([blocks])]), chunks: 1, warnings: 0 };
    const encoded = old.quads, baseY = sectionY * 16 + 1;
    const legacyFaces = quads(old).filter(face => sceneTextures.get(face.texture)[0].startsWith("block/" + name));
    assert(legacyFaces.some(face => face.face === 2 && face.y === baseY + 1), "fixture reproduces the floating top face from an old daemon");
    const decoded = decodeScene(old), plants = decoded.meshes.find(mesh => mesh.kind === SceneKind.Plant);
    const petals = Array.from({ length: plants.count }, (_, i) => i).filter(i => sceneTextures.get(plants.sprites[i])[0] === "block/" + name);
    assert.equal(petals.length, 1, "the merged flowerbed remains one quad");
    for (const i of petals) {
      assert.equal(plants.origins[i * 3 + 1], baseY);
      assert.equal(plants.faces[i], 2); assert(plants.flags[i] & SCENE_GROUND);
      assert.equal(plants.sizes[i * 2] * plants.sizes[i * 2 + 1], 2);
      assert.deepEqual([...plants.colors.slice(i * 3, i * 3 + 3)], [255, 255, 255]);
    }
    assert.equal(plants.maxY, baseY + 1 / 64);
    assert(decoded.meshes.every(mesh => [...mesh.sprites].every(sprite => !sceneTextures.get(sprite)[0].endsWith(name + "_stem"))), "full-height stem walls are removed");
    assert.equal(decoded.count, decoded.meshes.reduce((count, mesh) => count + mesh.count, 0));
    assert(decoded.count < quads(old).length); assert.equal(old.quads, encoded);
    const current = decodeScene(await tile([chunk([blocks])]));
    assert.deepEqual(decoded.heights, current.heights);
    assert.equal(current.meshes.find(mesh => mesh.kind === SceneKind.Plant).maxY, plants.maxY);
  }
});

test("small ferns stay crossed and Java palette properties select distinct upper and lower large-fern textures", async () => {
  const { chunkLayers } = load("daemon/src/backend/map/chunk.ts");
  for (const [id, properties] of [["Name", "Properties"], ["id", "properties"]]) {
    const data = Array(256).fill(0n); data[0] = 1n | (3n << 4n); data[16] = 2n;
    const layers = chunkLayers({ DataVersion: 4903, sections: [{ Y: 0,
      block_states: { palette: ["minecraft:air", { [id]: "minecraft:large_fern", [properties]: { half: "lower" } }, { [id]: "minecraft:large_fern", [properties]: { half: "upper" } }, "minecraft:fern"], data },
      biomes: { palette: ["minecraft:forest"] }
    }] });
    assert.equal(layers[0].properties(0).half, "lower");
    assert.equal(layers[0].properties(256).half, "upper");
    const faces = quads(await tile([chunk(layers)]));
    assert.deepEqual(faces.filter(q => q.x === 0 && q.y === 0).map(q => sceneTextures.get(q.texture)[0]), ["block/large_fern_bottom", "block/large_fern_bottom"]);
    assert.deepEqual(faces.filter(q => q.x === 0 && q.y === 1).map(q => sceneTextures.get(q.texture)[0]), ["block/large_fern_top", "block/large_fern_top"]);
    assert.deepEqual(faces.filter(q => q.x === 1).map(q => q.face), [6, 7]);
    assert(faces.every(q => q.kind === SceneKind.Plant && q.tint === minecraftAssets.biomes["minecraft:forest"][0]));
  }
});

test("saved block states choose lit, grown, upper-half and directional textures without merging distinct states", async () => {
  const { chunkLayers } = load("daemon/src/backend/map/chunk.ts");
  const examples = [
    ["furnace", { facing: "east", lit: "true" }, 0, "furnace_front_on"],
    ["furnace", { facing: "east", lit: "false" }, 0, "furnace_front"],
    ["wheat", { age: "7" }, 6, "wheat_stage7"],
    ["wheat", { age: "0" }, 6, "wheat_stage0"],
    ["oak_door", { half: "upper", facing: "north", hinge: "left", open: "false" }, undefined, "oak_door_top"],
    ["red_bed", { facing: "north", part: "head" }, 2, "red_bed_head_up"],
    ["copper_bulb", { lit: "true", powered: "false" }, 2, "copper_bulb_lit"],
    ["poplar_log", { axis: "x" }, 0, "poplar_log_top"]
  ];
  const palette = ["minecraft:air", ...examples.map(([name, Properties]) => ({ Name: "minecraft:" + name, Properties }))];
  const data = Array(256).fill(0n);
  examples.forEach((_, i) => { data[0] |= BigInt(i + 1) << BigInt(i * 8); });
  const layers = chunkLayers({ DataVersion: 5023, sections: [{ Y: 0, block_states: { palette, data } }] });
  const result = await tile([chunk(layers)]), faces = quads(result);
  examples.forEach(([name, , face, texture], i) => {
    assert(faces.some(q => q.x === i * 2 + (face === 0 ? 1 : 0) && (face === undefined || q.face === face) &&
      sceneTextures.get(q.texture)[0] === "block/" + texture), name + " uses " + texture);
  });
  assert.equal(decodeScene(result).count, faces.length);
});

test("the complete asset catalog has no missing visible faces, including heavy core and 26.3 forest blocks", async () => {
  for (const [name, model] of Object.entries(minecraftAssets.blocks)) {
    if (["air", "cave_air", "void_air"].includes(name)) continue;
    assert(model.faces.every(sprite => sprite !== 0 && sceneTextures.has(sprite)), name);
  }
  for (const [name, state] of Object.entries(minecraftAssets.states)) for (const model of state.models) {
    assert(model.faces.every(sprite => sprite !== 0 && sceneTextures.has(sprite)), name);
  }
  const names = ["heavy_core", "orange_poplar_leaves", "red_poplar_leaves", "yellow_poplar_leaves", "poplar_log", "red_shrub", "shelf_mushroom"];
  const faces = quads(await tile([chunk([layer(0, (x, y, z) => y === 0 && z === 0 && x % 2 === 0 ? names[x / 2] ?? "air" : "air")])]));
  for (const name of names) assert(faces.some(q => sceneTextures.get(q.texture)[0].startsWith("block/" + name)), name);
  assert(faces.filter(q => sceneTextures.get(q.texture)[0].includes("poplar_leaves")).every(q => q.kind === SceneKind.Cutout && q.tint === 0xffffff));
  assert.deepEqual(faces.filter(q => sceneTextures.get(q.texture)[0] === "block/red_shrub").map(q => q.face), [6, 7]);
  const { blockStateKey } = load("daemon/src/backend/map/materials.ts");
  assert.equal(blockStateKey("oak_leaves", { distance: "1" }), blockStateKey("oak_leaves", { distance: "7" }), "irrelevant states still merge");
});

test("cherry, pale oak and azalea leaves keep their texture colors while registered foliage uses biome tint", async () => {
  const names = ["cherry_leaves", "pale_oak_leaves", "flowering_azalea_leaves", "oak_leaves"];
  for (const biome of ["minecraft:forest", "minecraft:desert"]) {
    const blocks = { ...layer(0, (x, y, z) => y === 0 && z === 1 && x % 2 === 1 ? names[(x - 1) / 2] ?? "air" : "air"), biome: () => biome };
    const faces = quads(await tile([chunk([blocks])]));
    for (const name of names) {
      const leaves = faces.filter(q => sceneTextures.get(q.texture)[0] === "block/" + name);
      assert.equal(leaves.length, 6);
      assert(leaves.every(q => q.tint === (name === "oak_leaves" ? minecraftAssets.biomes[biome][1] : 0xffffff)), name);
    }
  }
});

test("ambient occlusion darkens the corners of a recess without shading an isolated cube", async () => {
  const isolated = quads(await tile([chunk([layer(0, (x, y, z) => x === 2 && y === 2 && z === 2 ? "stone" : "air")])]));
  assert(isolated.every(q => q.ao === 0));
  const corner = await tile([chunk([layer(0, (x, y, z) => (y === 0 && x < 4 && z < 4) || (x === 0 && y < 4 && z < 4) ? "stone" : "air")])]);
  assert(quads(corner).some(q => q.ao !== 0));
  assert(decodeScene(corner).meshes.some(mesh => mesh.occlusion.some(value => value !== 0)));
});

test("the 3D Nether surface removes its roof", async () => {
  const chunks = [chunk([layer(7, "bedrock"), layer(5, "netherrack")])];
  const overview = await tile(chunks, true);
  assert.equal(decodeScene(overview).heights[0], 95);
  assert(quads(overview).every(q => q.y <= 96));
});

test("scene decoding rejects unbounded or malformed geometry before building render buffers", async () => {
  const good = await tile([chunk([layer(0, "stone")])]);
  const mutate = change => { const data = Buffer.from(good.quads, "base64"); change(data); return { ...good, quads: data.toString("base64") }; };
  for (const bad of [
    { ...good, version: 2 }, { ...good, chunks: 5 }, { ...good, heights: "" }, { ...good, quads: "%%%" },
    { ...good, quads: Buffer.alloc(MAP_SCENE_MAX_QUADS * 16 + 16).toString("base64") },
    mutate(b => { b[0] = 33; }), mutate(b => { b[8] = 8; }), mutate(b => { b[9] = 255; }), mutate(b => { b[9] |= SCENE_GROUND; }),
    mutate(b => b.writeInt16LE(-2049, 2)), mutate(b => b.writeUInt16LE(65535, 4))
  ]) assert.throws(() => decodeScene(bad), /MC_MAP_CORRUPT/);
  for (const value of [null, "0", Infinity, 0.5, 937501, -937501]) assert.throws(() => mapSceneCoordinate(value), /MC_MAP_INVALID/);
  assert.equal(mapSceneCoordinate(-937500), -937500);
  await assert.rejects(meshScene([chunk([layer(0, "stone")])], false, () => true), /MC_MAP_UNAVAILABLE/);
});

test("compressed scene tiles inflate to the same geometry and reject damaged payloads", async () => {
  const chunks = [chunk([layer(4, "grass_block")])];
  const raw = await tile(chunks);
  const packed = { ...await meshScene(chunks, false, () => false, [], true), chunks: 1, warnings: 0 };
  assert.equal(packed.gzip, true);
  assert.equal(packed.quads, undefined, "the compressed form carries one payload instead of three strings");
  const expected = decodeScene(raw), actual = await decodeSceneTile(packed);
  assert.equal(actual.count, expected.count);
  assert.equal(actual.meshes.length, expected.meshes.length);
  assert.deepEqual(actual.heights, expected.heights);
  assert.equal(actual.animated, expected.animated);
  assert(packed.payload.length < raw.quads.length + raw.tints.length + raw.heights.length, "compression must not grow the payload");

  for (const payload of ["bm90IGd6aXA=", "", undefined]) {
    await assert.rejects(() => decodeSceneTile({ ...packed, payload }), /MC_MAP_CORRUPT/, String(payload));
  }
  // The header lengths must describe the inflated body exactly.
  const gzip = require("node:zlib").gzipSync(Buffer.alloc(20));
  await assert.rejects(() => decodeSceneTile({ ...packed, payload: gzip.toString("base64") }), /MC_MAP_CORRUPT/);
});
