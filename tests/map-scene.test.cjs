const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loader } = require("./helpers.cjs");
const load = loader();
const { meshScene } = load("daemon/src/backend/map/scene.ts");
const { surfaceFromLayers } = load("daemon/src/backend/map/chunk.ts");
const { decodeScene } = load("panel/src/map/scene-codec.ts");
const { SceneKind, minecraftAssets, sceneTextures, SCENE_GRASS_OVERLAY, SCENE_GROUND } = load("shared/scene.ts");
const { MAP_SCENE_MAX_QUADS, mapSceneCoordinate } = load("shared/map.ts");
const layer = (y, block) => ({ y, block: typeof block === "function" ? index => block(index & 15, index >> 8, (index >> 4) & 15) : () => block });
const chunk = (layers, x = 0, z = 0) => ({ x, z, layers });
const tile = async (chunks, nether = false, y, neighbors = []) => ({ ...await meshScene(chunks, nether, y, undefined, neighbors), chunks: chunks.length, warnings: 0 });
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
  assert.equal(decoded.count, 6);
  assert.equal(decoded.heights[0], 79); assert.equal(decoded.heights[31], 79);
  assert.equal(decoded.heights[32 * 16], -32768);
  assert.equal(result.limited, false);
  assert.deepEqual(quads(result).map(q => q.face).sort(), [0, 1, 2, 3, 4, 5]);
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
  assert.equal(decodeScene(await tile([chunk([solid])])).count, 6);
  const result = await tile([chunk([hollow])]);
  assert.equal(decodeScene(result).count, 12);
  assert(quads(result).some(q => q.face === 3 && q.y === 3 && q.x === 2 && q.z === 2), "cavity ceiling has a visible underside");
});

test("3D cutaways cap the exact requested layer, including zero, negative heights and empty layers", async () => {
  const chunks = [chunk([layer(-1, "stone"), layer(0, "diamond_block")])];
  for (const y of [-16, -1, 0, 7]) {
    const result = await tile(chunks, false, y), decoded = decodeScene(result);
    assert.equal(decoded.heights[0], y);
    assert(quads(result).some(q => q.face === 2 && q.y === y + 1));
    for (const part of decoded.meshes) assert(part.maxY <= y + 1);
  }
  const empty = decodeScene(await tile(chunks, false, -17));
  assert.equal(empty.count, 0); assert(empty.heights.every(y => y === -32768));
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
  const joined = await tile(chunks, false, undefined, adjacent), faces = quads(joined);
  assert(!faces.some(q => q.face === 0 && q.x === 32), "the adjacent scene hides the shared east face");
  assert(faces.some(q => q.face === 2 && q.y === 16), "the water surface stays visible");
  assert.equal(joined.chunks, 4);
  assert(faces.every(q => q.x <= 32 && q.z <= 32), "neighboring geometry is not emitted twice");
  assert.equal(decodeScene(joined).count, faces.length);
  const cut = quads(await tile(chunks, false, 0, adjacent));
  assert(!cut.some(q => q.face === 0 && q.x === 32));
  assert(cut.some(q => q.face === 2 && q.y === 1));
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

test("the 3D Nether overview removes its roof, while explicit cutaways preserve selected roof blocks", async () => {
  const chunks = [chunk([layer(7, "bedrock"), layer(5, "netherrack")])];
  const overview = await tile(chunks, true);
  assert.equal(decodeScene(overview).heights[0], 95);
  assert(quads(overview).every(q => q.y <= 96));
  const sliced = await tile(chunks, true, 120);
  assert.equal(decodeScene(sliced).heights[0], 120);
  assert(quads(sliced).some(q => q.face === 2 && q.y === 121));
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
  await assert.rejects(meshScene([chunk([layer(0, "stone")])], false, undefined, () => true), /MC_MAP_UNAVAILABLE/);
});
