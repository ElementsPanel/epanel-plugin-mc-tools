const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const nbt = require("prismarine-nbt");
const { loader, deferred } = require("./helpers.cjs");

const load = loader();
const { WorldMapService } = load("daemon/src/backend/map/service.ts");
const { discoverWorlds, safePath } = load("daemon/src/backend/map/worlds.ts");
const { bedrockKey, bedrockLayer, bedrockSurface } = load("daemon/src/backend/map/bedrock.ts");
const { BedrockSnapshots } = load("daemon/src/backend/map/snapshot.ts");
const { chunkSurface, paletteReader, surfaceFromLayers } = load("daemon/src/backend/map/chunk.ts");
const { blockColor } = load("daemon/src/backend/map/colors.ts");

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "epanel-map-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function javaSection(y, name) {
  return { Y: nbt.byte(y), block_states: nbt.comp({ palette: nbt.list({ type: "compound", value: [{ Name: nbt.string("minecraft:" + name) }] }) }) };
}

function javaChunk(name = "grass_block", y = 4) {
  return nbt.comp({ DataVersion: nbt.int(3465), sections: nbt.list({ type: "compound", value: [javaSection(y, name)] }) });
}

function java26Chunk(palette, y = 4, data) {
  const blockStates = { palette };
  if (data) blockStates.data = nbt.longArray(data);
  return nbt.comp({ DataVersion: nbt.int(5023), sections: nbt.list({ type: "compound", value: [
    { Y: nbt.byte(y), block_states: nbt.comp(blockStates) },
    { Y: nbt.byte(y + 1), block_states: nbt.comp({ palette: nbt.list({ type: "string", value: ["minecraft:air"] }) }) }
  ] }) });
}

async function writeRegion(directory, x, z, data, compression = 2, external = false) {
  const region = path.join(directory, "region");
  await fs.mkdir(region, { recursive: true });
  let bytes = nbt.writeUncompressed(data);
  if (compression === 1) bytes = zlib.gzipSync(bytes);
  if (compression === 2) bytes = zlib.deflateSync(bytes);
  const sectors = external ? 1 : Math.ceil((bytes.length + 5) / 4096);
  const file = Buffer.alloc(8192 + sectors * 4096);
  const index = ((x & 31) + (z & 31) * 32) * 4;
  file.writeUIntBE(2, index, 3);
  file[index + 3] = sectors;
  file.writeUInt32BE(external ? 1 : bytes.length + 1, 8192);
  file[8196] = compression | (external ? 128 : 0);
  if (external) await fs.writeFile(path.join(region, `c.${x}.${z}.mcc`), bytes);
  else bytes.copy(file, 8197);
  await fs.writeFile(path.join(region, `r.${Math.floor(x / 32)}.${Math.floor(z / 32)}.mca`), file);
}

function pixels(tile) {
  const file = Buffer.from(tile.image, "base64");
  assert.equal(file.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(file.readUInt32BE(16), 128);
  assert.equal(file.readUInt32BE(20), 128);
  const blocks = [];
  for (let offset = 8; offset < file.length;) {
    const size = file.readUInt32BE(offset);
    if (file.toString("ascii", offset + 4, offset + 8) === "IDAT") blocks.push(file.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(blocks));
  return (x, z) => {
    assert.equal(raw[z * 513], 0);
    return [...raw.subarray(z * 513 + 1 + x * 4, z * 513 + 5 + x * 4)];
  };
}

function rgb(color) { return [(color >> 16) & 255, (color >> 8) & 255, color & 255, 255]; }
function instance(root, type = "minecraft/java") { return { config: { type }, absoluteCwdPath: () => root }; }

function bedrockStorage(names, select = () => 0, bits = 1) {
  const perWord = bits ? Math.floor(32 / bits) : 4096;
  const count = bits ? Math.ceil(4096 / perWord) : 0;
  const data = Buffer.alloc(1 + count * 4 + (bits ? 4 : 0));
  data[0] = bits << 1;
  for (let index = 0; bits && index < 4096; index++) {
    const offset = 1 + Math.floor(index / perWord) * 4;
    data.writeUInt32LE((data.readUInt32LE(offset) | (select(index) << ((index % perWord) * bits))) >>> 0, offset);
  }
  if (bits) data.writeUInt32LE(names.length, 1 + count * 4);
  return Buffer.concat([data, ...names.map((name) => nbt.writeUncompressed(nbt.comp({ name: nbt.string("minecraft:" + name), states: nbt.comp({}), version: nbt.int(18168865) }), "little"))]);
}

function bedrockSubchunk(y, name, version = 9) {
  return Buffer.concat([Buffer.from(version === 9 ? [9, 1, y & 255] : version === 8 ? [8, 1] : [1]), bedrockStorage([name], undefined, 0)]);
}

async function hashes(directory) {
  const result = {};
  for (const file of (await fs.readdir(directory)).sort()) result[file] = createHash("sha256").update(await fs.readFile(path.join(directory, file))).digest("hex");
  return result;
}

test("Java maps discover dimensions, render saved chunks at positive/negative coordinates, and refresh changed terrain", async (t) => {
  const root = await temporary(t), world = path.join(root, "world");
  await writeRegion(world, 0, 0, javaChunk());
  await writeRegion(world, -1, -1, javaChunk("sand"), 1, true);
  await writeRegion(path.join(world, "DIM-1"), 0, 0, javaChunk("netherrack"));
  await writeRegion(path.join(world, "DIM1"), 0, 0, javaChunk("end_stone"));
  await fs.writeFile(path.join(world, "level.dat"), zlib.gzipSync(nbt.writeUncompressed(nbt.comp({ Data: nbt.comp({ LevelName: nbt.string("Test World"), SpawnX: nbt.int(80), SpawnZ: nbt.int(-16) }) }))));
  const service = new WorldMapService({ getInstance: (id) => id === "server" ? instance(root) : undefined });
  t.after(() => service.dispose());
  const worlds = await service.worlds("server");
  assert.equal(worlds.length, 3);
  const overworld = worlds.find((item) => item.dimension === "minecraft:overworld");
  assert.equal(overworld.name, "Test World");
  assert.deepEqual(overworld.spawn, { x: 80, z: -16 });
  assert.deepEqual(worlds.find((item) => item.dimension === "minecraft:the_nether").spawn, { x: 10, z: -2 });
  const first = await service.tile("server", overworld.id, 0, 0);
  assert.equal(first.chunks, 1);
  assert.equal(first.warnings, 0);
  assert.deepEqual(pixels(first)(0, 0), rgb(blockColor("grass_block")));
  assert.deepEqual(pixels(first)(32, 32), [0, 0, 0, 0]);
  const negative = await service.tile("server", overworld.id, -1, -1);
  assert.equal(negative.chunks, 1);
  assert.deepEqual(pixels(negative)(127, 127), rgb(blockColor("sand")));
  assert.equal(await service.tile("server", overworld.id, 0, 0), first);
  await writeRegion(world, 0, 0, javaChunk("water"), 3);
  await service.worlds("server", true);
  assert.deepEqual(pixels(await service.tile("server", overworld.id, 0, 0))(0, 0), rgb(blockColor("water")));
  await assert.rejects(service.tile("server", "0".repeat(24), 0, 0), /MC_MAP_WORLD_MISSING/);
  await assert.rejects(service.tile("server", overworld.id, 1.5, 0), /MC_MAP_INVALID/);
  await assert.rejects(service.tile("server", overworld.id, 999999, 0), /MC_MAP_INVALID/);
  await assert.rejects(service.worlds("unknown"), /MC_MAP_INSTANCE_MISSING/);
});

test("Java 26.x dimensions, legacy dimension fallbacks, and modern spawn data work together without duplicate worlds", async (t) => {
  const root = await temporary(t), world = path.join(root, "world");
  const overworld = path.join(world, "dimensions", "minecraft", "overworld");
  const nether = path.join(world, "dimensions", "minecraft", "the_nether");
  await writeRegion(overworld, 0, 0, java26Chunk(nbt.list({ type: "string", value: ["minecraft:grass_block"] })));
  await writeRegion(nether, 0, 0, java26Chunk(nbt.list({ type: "compound", value: [{ id: nbt.string("minecraft:netherrack"), properties: nbt.comp({}) }] }), 2));
  await writeRegion(world, 0, 0, javaChunk("water"));
  await writeRegion(path.join(world, "DIM-1"), 0, 0, javaChunk("water"));
  await writeRegion(path.join(world, "DIM1"), 0, 0, javaChunk("end_stone"));
  await writeRegion(path.join(world, "dimensions", "example", "islands", "upper"), 0, 0, javaChunk("stone"));
  const metadata = (dimension, position) => zlib.gzipSync(nbt.writeUncompressed(nbt.comp({ Data: nbt.comp({
    LevelName: nbt.string("Mixed layout"), DataVersion: nbt.int(5023), SpawnX: nbt.int(999), SpawnZ: nbt.int(999),
    spawn: nbt.comp({ dimension: nbt.string(dimension), pos: nbt.intArray(position) })
  }) })));
  await fs.writeFile(path.join(world, "level.dat"), metadata("minecraft:overworld", [320, 75, -160]));
  const service = new WorldMapService({ getInstance: () => instance(root) });
  t.after(() => service.dispose());
  let worlds = await service.worlds("server");
  assert.equal(worlds.length, 4);
  assert.equal(new Set(worlds.map((value) => value.dimension)).size, 4);
  assert.deepEqual(worlds.slice(0, 3).map((value) => value.dimension), ["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"]);
  for (const [dimension, directory, spawn, block] of [
    ["minecraft:overworld", overworld, { x: 320, z: -160 }, "grass_block"],
    ["minecraft:the_nether", nether, { x: 40, z: -20 }, "netherrack"],
    ["minecraft:the_end", path.join(world, "DIM1"), { x: 0, z: 0 }, "end_stone"]
  ]) {
    const value = worlds.find((value) => value.dimension === dimension);
    assert.equal(value.directory, directory);
    assert.equal(value.name, "Mixed layout");
    assert.deepEqual(value.spawn, spawn);
    const tile = await service.tile("server", value.id, 0, 0);
    assert.equal(tile.warnings, 0);
    assert.deepEqual(pixels(tile)(0, 0), rgb(blockColor(block)));
  }
  assert(worlds.some((value) => value.dimension === "example:islands/upper"));
  await fs.writeFile(path.join(world, "level.dat"), metadata("minecraft:the_nether", [12, 75, -3]));
  worlds = await service.worlds("server", true);
  assert.deepEqual(worlds.find((value) => value.dimension === "minecraft:the_nether").spawn, { x: 12, z: -3 });
  assert.deepEqual(worlds.find((value) => value.dimension === "minecraft:overworld").spawn, { x: 96, z: -24 });
  await fs.writeFile(path.join(world, "level.dat"), metadata("minecraft:the_end", [100, 50, 0]));
  worlds = await service.worlds("server", true);
  assert.deepEqual(worlds.find((value) => value.dimension === "minecraft:the_end").spawn, { x: 100, z: 0 });
});

test("Java slices select exact positive/negative layers, keep air empty, isolate cached requests, and refresh every layer", async (t) => {
  const root = await temporary(t), directory = path.join(root, "world");
  const below = Array(4096).fill(1), above = Array(4096).fill(1);
  below.fill(8, 15 * 256);
  above.fill(3, 0, 256);
  above[256 + 9 * 16 + 3] = 0;
  const chunk = nbt.comp({ DataVersion: nbt.int(3465), sections: nbt.list({ type: "compound", value: [
    javaSection(-4, "deepslate"),
    { Y: nbt.byte(-1), Blocks: nbt.byteArray(below) },
    { Y: nbt.byte(0), Blocks: nbt.byteArray(above) },
    javaSection(4, "grass_block")
  ] }) });
  await writeRegion(directory, 0, 0, chunk);
  const service = new WorldMapService({ getInstance: () => instance(root) });
  t.after(() => service.dispose());
  const [world] = await service.worlds("server");
  const tile = (y) => service.tile("server", world.id, 0, 0, y);
  const [surface, zero, duplicate, negative] = await Promise.all([tile(), tile(0), tile(0), tile(-1)]);
  assert.equal(zero, duplicate);
  assert.notEqual(zero, surface);
  assert.deepEqual(pixels(surface)(3, 9), rgb(blockColor("grass_block")));
  assert.deepEqual(pixels(zero)(3, 9), rgb(blockColor("dirt")));
  assert.deepEqual(pixels(negative)(3, 9), rgb(blockColor("water")));
  assert.deepEqual(pixels(await tile(1))(3, 9), [0, 0, 0, 0]);
  assert.deepEqual(pixels(await tile(1))(9, 3), rgb(blockColor("stone")));
  assert.deepEqual(pixels(await tile(2))(3, 9), rgb(blockColor("stone")));
  for (const y of [-64, -49]) assert.deepEqual(pixels(await tile(y))(0, 0), rgb(blockColor("deepslate")));
  for (const y of [-2048, -48, 16, 80, 2047]) {
    const empty = await tile(y);
    assert.equal(empty.warnings, 0);
    assert.deepEqual(pixels(empty)(0, 0), [0, 0, 0, 0]);
  }
  assert.equal(await tile(), surface);
  assert.equal(await tile(0), zero);
  assert.equal(await tile(-1), negative);
  for (const y of [null, "0", true, [], NaN, Infinity, -2049, 2048, 1.5]) await assert.rejects(tile(y), /MC_MAP_INVALID/);
  await writeRegion(directory, 0, 0, javaChunk("water", 0));
  await service.worlds("server", true);
  assert.deepEqual(pixels(await tile(0))(3, 9), rgb(blockColor("water")));
  assert.deepEqual(pixels(await tile(-1))(3, 9), [0, 0, 0, 0]);
  assert.notEqual(await tile(), surface);
});

test("Java numeric blocks, legacy Name palettes, and 26.x string/id/mixed palettes all survive NBT region round trips", async (t) => {
  const root = await temporary(t);
  const ones = Array.from({ length: 256 }, () => [0x11111111, 0x11111111]);
  const fixtures = [
    ["numeric", nbt.comp({ Level: nbt.comp({ Sections: nbt.list({ type: "compound", value: [{ Y: nbt.byte(4), Blocks: nbt.byteArray(Array(4096).fill(2)) }] }) }) })],
    ["legacy-palette", nbt.comp({ DataVersion: nbt.int(2230), Level: nbt.comp({ Sections: nbt.list({ type: "compound", value: [{
      Y: nbt.byte(4), Palette: nbt.list({ type: "compound", value: [{ Name: nbt.string("minecraft:air") }, { Name: nbt.string("minecraft:grass_block") }] }), BlockStates: nbt.longArray(ones)
    }] }) }) })],
    ["modern-name", javaChunk()],
    ["string", java26Chunk(nbt.list({ type: "string", value: ["minecraft:grass_block"] }))],
    ["id", java26Chunk(nbt.list({ type: "compound", value: [{ id: nbt.string("minecraft:grass_block"), properties: nbt.comp({ snowy: nbt.string("false") }) }] }))],
    ["wrapped-string", java26Chunk(nbt.list({ type: "compound", value: [{ "": nbt.string("minecraft:grass_block") }] }))],
    ["mixed", java26Chunk(nbt.list({ type: "compound", value: [
      { "": nbt.string("minecraft:air") },
      { id: nbt.string("minecraft:grass_block"), properties: nbt.comp({ snowy: nbt.string("false") }) }
    ] }), 4, ones)]
  ];
  for (const [name, chunk] of fixtures) await writeRegion(path.join(root, name), 0, 0, chunk);
  const service = new WorldMapService({ getInstance: () => instance(root) });
  t.after(() => service.dispose());
  const worlds = await service.worlds("server");
  assert.equal(worlds.length, fixtures.length);
  for (const [name] of fixtures) {
    const world = worlds.find((value) => value.name === name);
    const tile = await service.tile("server", world.id, 0, 0);
    assert.equal(tile.chunks, 1, name);
    assert.equal(tile.warnings, 0, name);
    assert.deepEqual(pixels(tile)(0, 0), rgb(blockColor("grass_block")), name);
    assert.deepEqual(pixels(await service.tile("server", world.id, 0, 0, 64))(0, 0), rgb(blockColor("grass_block")), name);
    assert.deepEqual(pixels(await service.tile("server", world.id, 0, 0, 80))(0, 0), [0, 0, 0, 0], name);
  }
  assert.throws(() => chunkSurface({ sections: [{ Y: 0, block_states: { palette: [{}] } }] }), /MC_MAP_CORRUPT/);
});

test("Java continuous and padded palettes decode long boundaries and old numeric sections remain readable", () => {
  const size = 19, bits = 5;
  for (const padded of [false, true]) {
    const longs = Array(padded ? Math.ceil(4096 / 12) : 320).fill(0n);
    for (let i = 0; i < 4096; i++) {
      const slot = padded ? Math.floor(i / 12) : Math.floor(i * bits / 64);
      const shift = padded ? (i % 12) * bits : i * bits % 64;
      longs[slot] |= BigInt(i % size) << BigInt(shift);
      if (!padded && shift + bits > 64) longs[slot + 1] |= BigInt(i % size) >> BigInt(64 - shift);
    }
    const read = paletteReader(longs.map((word) => [Number(BigInt.asIntN(32, word >> 32n)), Number(BigInt.asIntN(32, word))]), size, padded ? 2584 : 2230);
    for (let i = 0; i < 4096; i++) assert.equal(read(i), i % size);
  }
  assert.throws(() => paletteReader([], 2, 3465), /MC_MAP_CORRUPT/);
  const old = chunkSurface({ Level: { Sections: [{ Y: 0, Blocks: new Int8Array(4096).fill(2) }] } });
  assert.equal(old.heights[0], 15);
  assert.equal(old.colors[0], blockColor("grass_block"));
  const negative = chunkSurface(nbt.simplify(javaChunk("stone", -4)));
  assert.equal(negative.heights[0], -49);
  for (const y of [-2048, -1, 0, 2047]) {
    const slice = chunkSurface(nbt.simplify(javaChunk("stone", Math.floor(y / 16))), false, y);
    assert.equal(slice.heights[0], y);
    assert.equal(slice.colors[0], blockColor("stone"));
  }
});

test("map service limits simultaneous renders, bounds its queue, and coalesces repeated tile requests", async () => {
  const service = new WorldMapService({ getInstance: () => ({}) });
  service.worlds = async () => [{ id: "world", root: "instance" }];
  const gates = [];
  let active = 0, peak = 0, completed = 0;
  service.render = async () => {
    active++; peak = Math.max(active, peak);
    const gate = deferred(); gates.push(gate);
    await gate.promise;
    active--; completed++;
    return { image: "image", chunks: 1, warnings: 0 };
  };
  const requests = Array.from({ length: 35 }, (_, index) => service.tile("server", "world", index, 0).catch((error) => error));
  const duplicate = service.tile("server", "world", 0, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gates.length, 2);
  while (completed < 34) {
    for (const gate of gates.splice(0)) gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const results = await Promise.all(requests);
  assert.equal(results.filter((result) => result.message === "MC_MAP_BUSY").length, 1);
  assert.equal(peak, 2);
  assert.equal(await duplicate, results[0]);
  assert.equal(completed, 34);
  await service.dispose();
});

test("Nether surface skips the bedrock ceiling and selects the terrain below an air gap", () => {
  const blocks = new Uint8Array(4096).fill(87);
  for (let y = 5; y <= 10; y++) blocks.fill(0, y * 256, (y + 1) * 256);
  const result = chunkSurface({ Level: { Sections: [{ Y: 7, Blocks: blocks }] } }, true);
  assert.equal(result.heights[0], 116);
  assert.equal(result.colors[0], blockColor("netherrack"));
  const ceiling = chunkSurface({ Level: { Sections: [{ Y: 7, Blocks: blocks }] } }, true, 127);
  assert.equal(ceiling.heights[0], 127);
  assert.equal(ceiling.colors[0], blockColor("netherrack"));
  const air = chunkSurface({ Level: { Sections: [{ Y: 7, Blocks: blocks }] } }, true, 120);
  assert.equal(air.heights[0], -32768);
});

test("world discovery and file reads reject traversal and symlinks outside the instance", async (t) => {
  const root = await temporary(t), outside = await temporary(t);
  await writeRegion(outside, 0, 0, javaChunk());
  await fs.mkdir(path.join(root, "world"));
  await fs.symlink(path.join(outside, "region"), path.join(root, "world", "region"));
  await fs.writeFile(path.join(root, "server.properties"), "level-name=" + outside);
  assert.deepEqual(await discoverWorlds(instance(root)), []);
  await assert.rejects(safePath(root, ".."), /MC_MAP_INVALID/);
  await assert.rejects(safePath(root, "world", "region"), /MC_MAP_INVALID/);
  await assert.rejects(discoverWorlds(instance(root, "minecraft/java/bungeecord")), /MC_MAP_UNSUPPORTED_INSTANCE/);
});

test("corrupt Java chunk records produce a partial tile without being cached as successful", async (t) => {
  const root = await temporary(t);
  await writeRegion(path.join(root, "world"), 0, 0, javaChunk(), 4);
  const service = new WorldMapService({ getInstance: () => instance(root) });
  t.after(() => service.dispose());
  const [world] = await service.worlds("server");
  const tile = await service.tile("server", world.id, 0, 0);
  assert.equal(tile.warnings, 1);
  assert.equal(tile.chunks, 0);
  assert.notEqual(await service.tile("server", world.id, 0, 0), tile);
});

test("Bedrock subchunks support v1/v8/v9, zero-bit palettes, negative heights, and X/Z/Y packing", () => {
  for (const version of [1, 8, 9]) {
    const layer = bedrockLayer(bedrockSubchunk(-4, "stone", version), -4);
    assert.equal(layer.y, -4);
    assert.equal(layer.block(0), "minecraft:stone");
    assert.equal(surfaceFromLayers([layer], false, -64).heights[0], -64);
  }
  const index = (3 << 8) | (9 << 4) | 12;
  const mixed = bedrockLayer(Buffer.concat([Buffer.from([9, 1, 0]), bedrockStorage(["air", "water"], (i) => Number(i === index))]), 0);
  assert.equal(mixed.block(12 * 256 + 9 * 16 + 3), "minecraft:water");
  assert.equal(mixed.block(12 * 256 + 3 * 16 + 9), "air");
  assert.equal(surfaceFromLayers([mixed], false, 12).colors[9 * 16 + 3], blockColor("water"));
  assert.equal(surfaceFromLayers([mixed], false, 11).heights[9 * 16 + 3], -32768);
  const numeric = Buffer.alloc(6145);
  numeric[1 + index] = 8;
  assert.equal(surfaceFromLayers([bedrockLayer(numeric, 0)], false, 12).colors[9 * 16 + 3], blockColor("water"));
  assert.throws(() => bedrockLayer(Buffer.from([9, 1, 0, 3]), 0), /MC_MAP_CORRUPT/);
  assert.throws(() => bedrockLayer(bedrockSubchunk(1, "stone"), 0), /MC_MAP_CORRUPT/);
});

test("Bedrock map snapshots read a live locked database, isolate dimensions, refresh, and never modify the original files", async (t) => {
  const { LevelDB } = require("leveldb-zlib");
  const root = await temporary(t), world = path.join(root, "worlds", "Bedrock level"), directory = path.join(world, "db");
  await fs.mkdir(directory, { recursive: true });
  const live = new LevelDB(directory, { createIfMissing: true });
  await live.open();
  t.after(() => live.close());
  await live.put(bedrockKey(0, 0, 0, 47, -4), bedrockSubchunk(-4, "grass"));
  await live.put(bedrockKey(-1, -1, 0, 47, 4), bedrockSubchunk(4, "sand"));
  await live.put(bedrockKey(0, 0, 1, 47, 2), bedrockSubchunk(2, "netherrack"));
  await live.put(bedrockKey(0, 0, 2, 47, 3), bedrockSubchunk(3, "end_stone"));
  await live.put(bedrockKey(10, 0, 0, 47, 0), Buffer.concat([Buffer.from([9, 1, 0]), bedrockStorage(["air"], () => 1)]));
  const metadata = nbt.writeUncompressed(nbt.comp({ LevelName: nbt.string("Bedrock test"), SpawnX: nbt.int(8), SpawnZ: nbt.int(-8) }), "little");
  const header = Buffer.alloc(8); header.writeUInt32LE(10); header.writeUInt32LE(metadata.length, 4);
  await fs.writeFile(path.join(world, "level.dat"), Buffer.concat([header, metadata]));
  await fs.writeFile(path.join(root, "server.properties"), "level-name=Bedrock level");
  const before = await hashes(directory);
  const service = new WorldMapService({ getInstance: () => instance(root, "minecraft/bedrock") });
  t.after(() => service.dispose());
  const worlds = await service.worlds("server");
  assert.equal(worlds.length, 3);
  const overworld = worlds.find((item) => item.dimensionId === 0);
  assert.equal(overworld.name, "Bedrock test");
  const tile = await service.tile("server", overworld.id, 0, 0);
  assert.equal(tile.chunks, 1);
  assert.equal(tile.warnings, 0);
  assert.deepEqual(pixels(tile)(0, 0), rgb(blockColor("grass")));
  assert.deepEqual(pixels(await service.tile("server", overworld.id, -1, -1))(127, 127), rgb(blockColor("sand")));
  const partial = await service.tile("server", overworld.id, 1, 0);
  assert.equal(partial.warnings, 1);
  assert.equal(partial.chunks, 0);
  for (const id of [1, 2]) {
    const world = worlds.find((item) => item.dimensionId === id);
    const result = await service.tile("server", world.id, 0, 0);
    assert.deepEqual(pixels(result)(0, 0), rgb(blockColor(id === 1 ? "netherrack" : "end_stone")));
  }
  assert.deepEqual(await hashes(directory), before);
  await live.put(bedrockKey(0, 0, 0, 47, -4), bedrockSubchunk(-4, "water"));
  assert.equal(await service.tile("server", overworld.id, 0, 0), tile);
  await service.worlds("server", true);
  assert.deepEqual(pixels(await service.tile("server", overworld.id, 0, 0))(0, 0), rgb(blockColor("water")));
  await service.dispose();
  assert(await live.get(bedrockKey(0, 0, 0, 47, -4)));
});

test("Bedrock slices read only the selected subchunk, distinguish air and Y=0, and support negative heights and Nether ceilings", async (t) => {
  const { LevelDB } = require("leveldb-zlib");
  const root = await temporary(t), directory = path.join(root, "world", "db");
  await fs.mkdir(directory, { recursive: true });
  const live = new LevelDB(directory, { createIfMissing: true });
  await live.open();
  t.after(() => live.close());
  await live.put(bedrockKey(0, 0, 0, 47, -4), bedrockSubchunk(-4, "deepslate"));
  await live.put(bedrockKey(0, 0, 0, 47, -1), bedrockSubchunk(-1, "sand"));
  await live.put(bedrockKey(0, 0, 0, 47, 0), Buffer.concat([Buffer.from([9, 1, 0]), bedrockStorage(["stone", "air", "water"], (index) => {
    const x = index >> 8, z = (index >> 4) & 15, y = index & 15;
    return y === 0 ? 2 : x === 3 && z === 9 && y === 1 ? 1 : 0;
  }, 2)]));
  await live.put(bedrockKey(0, 0, 0, 47, 10), Buffer.from([255]));
  await live.put(bedrockKey(1, 0, 0, 47, -128), bedrockSubchunk(-128, "bedrock"));
  await live.put(bedrockKey(1, 0, 0, 47, 127), bedrockSubchunk(127, "snow"));
  await live.put(bedrockKey(0, 0, 1, 47, 2), bedrockSubchunk(2, "netherrack"));
  await live.put(bedrockKey(0, 0, 1, 47, 7), bedrockSubchunk(7, "bedrock"));
  await live.put(bedrockKey(0, 0, 2, 47, 0), bedrockSubchunk(0, "end_stone"));
  const service = new WorldMapService({ getInstance: () => instance(root, "minecraft/bedrock") });
  t.after(() => service.dispose());
  const worlds = await service.worlds("server");
  const overworld = worlds.find((world) => world.dimensionId === 0);
  const tile = (y) => service.tile("server", overworld.id, 0, 0, y);
  const zero = await tile(0);
  assert.equal(zero.warnings, 0);
  assert.deepEqual(pixels(zero)(3, 9), rgb(blockColor("water")));
  assert.deepEqual(pixels(await tile(1))(3, 9), [0, 0, 0, 0]);
  assert.deepEqual(pixels(await tile(1))(9, 3), rgb(blockColor("stone")));
  assert.deepEqual(pixels(await tile(2))(3, 9), rgb(blockColor("stone")));
  assert.deepEqual(pixels(await tile(-1))(3, 9), rgb(blockColor("sand")));
  assert.deepEqual(pixels(await tile(-64))(3, 9), rgb(blockColor("deepslate")));
  assert.deepEqual(pixels(await tile(16))(3, 9), [0, 0, 0, 0]);
  assert.deepEqual(pixels(await tile(-2048))(16, 0), rgb(blockColor("bedrock")));
  assert.deepEqual(pixels(await tile(2047))(16, 0), rgb(blockColor("snow")));
  assert.equal((await tile(160)).warnings, 1);
  assert.equal(await tile(0), zero);
  const nether = worlds.find((world) => world.dimensionId === 1);
  assert.deepEqual(pixels(await service.tile("server", nether.id, 0, 0))(0, 0), rgb(blockColor("netherrack")));
  assert.deepEqual(pixels(await service.tile("server", nether.id, 0, 0, 127))(0, 0), rgb(blockColor("bedrock")));
  const end = worlds.find((world) => world.dimensionId === 2);
  assert.deepEqual(pixels(await service.tile("server", end.id, 0, 0, 0))(0, 0), rgb(blockColor("end_stone")));
  await live.put(bedrockKey(0, 0, 0, 47, 0), bedrockSubchunk(0, "lava"));
  assert.equal(await tile(0), zero);
  await service.worlds("server", true);
  assert.deepEqual(pixels(await tile(0))(3, 9), rgb(blockColor("lava")));
});

test("Bedrock snapshot invalidation waits for readers and cleans temporary directories on disposal", async (t) => {
  const { LevelDB } = require("leveldb-zlib");
  const root = await temporary(t), directory = path.join(root, "db");
  const live = new LevelDB(directory, { createIfMissing: true });
  await live.open();
  t.after(() => live.close());
  const snapshots = new BedrockSnapshots();
  t.after(() => snapshots.dispose());
  const world = { root, directory: root };
  const release = deferred(), started = deferred();
  const reading = snapshots.use(world, async (db, filename) => { started.resolve(filename); await release.promise; return filename; });
  const first = await started.promise;
  snapshots.invalidate(root);
  await fs.access(first);
  release.resolve();
  await reading;
  await assert.rejects(fs.access(first), { code: "ENOENT" });
  const second = await snapshots.use(world, async (db, filename) => filename);
  assert.notEqual(first, second);
  await snapshots.dispose();
  await assert.rejects(fs.access(second), { code: "ENOENT" });
  await assert.rejects(snapshots.use(world, async () => {}), /MC_MAP_UNAVAILABLE/);
});

test("map panel routes run instance authorization before forwarding and validate all tile inputs", async () => {
  const routes = new Map(), calls = [], checks = [];
  const ctx = {
    koa: { router(prefix) { assert.equal(prefix, "/api/mc-tools/map"); return { get(route, ...handlers) { routes.set(route, handlers); } }; } },
    roles: { USER: 1 },
    middleware: {
      permission(options) { assert.deepEqual(options, { level: 1, speedLimit: false }); return async (request, next) => { checks.push("permission"); await next(); }; },
      validator(options) { assert.deepEqual(options.query, { uuid: String, daemonId: String }); return async (request, next) => { checks.push("validate"); await next(); }; },
      async instanceAccess(request, next) { checks.push("instance"); if (request.denied) { request.status = 403; return; } await next(); }
    },
    remote: {
      services: { getInstance(id) { assert.equal(id, "node"); return { available: true }; } },
      Request: class { async request(event, data) { calls.push({ event, data }); return ["map"]; } }
    }
  };
  load("panel/src/backend/index.ts").registerWorldMapRoutes(ctx);
  async function request(route, query, denied = false) {
    const value = { query: { uuid: "server", daemonId: "node", ...query }, denied };
    const handlers = routes.get(route);
    const run = (index) => handlers[index]?.(value, () => run(index + 1));
    await run(0);
    return value;
  }
  assert.equal((await request("/worlds", {}, true)).status, 403);
  assert.equal(calls.length, 0);
  assert.deepEqual((await request("/tile", { world: "a".repeat(24), x: "-1", z: "2", path: "/etc/passwd" })).body, ["map"]);
  assert.deepEqual(calls[0], { event: "mc-tools/map/tile", data: { instanceUuid: "server", world: "a".repeat(24), x: -1, z: 2 } });
  assert.deepEqual(checks.slice(-3), ["permission", "validate", "instance"]);
  for (const query of [{ world: "../world", x: "0", z: "0" }, { world: "a".repeat(24), x: "999999", z: "0" }, { world: "a".repeat(24), x: ["0"], z: "0" }]) assert.match((await request("/tile", query)).body.message, /MC_MAP_INVALID/);
  for (const y of ["", "1.5", "1e2", "2048", "-2049", ["0"], null, 0]) {
    assert.match((await request("/tile", { world: "a".repeat(24), x: "0", z: "0", y })).body.message, /MC_MAP_INVALID/);
  }
  assert.equal(calls.length, 1);
  for (const y of ["-2048", "-64", "0", "2047"]) {
    assert.deepEqual((await request("/tile", { world: "a".repeat(24), x: "0", z: "0", y })).body, ["map"]);
    assert.equal(calls.at(-1).data.y, Number(y));
  }
  await request("/worlds", { refresh: "1" });
  assert.deepEqual(calls.at(-1).data, { instanceUuid: "server", refresh: true });
});

test("daemon map protocol returns public identifiers and hides filesystem errors", async (t) => {
  const root = await temporary(t);
  await writeRegion(path.join(root, "world"), 0, 0, javaChunk());
  const events = new Map(), disposals = [];
  let response, error;
  const ctx = {
    instances: { subsystem: { getInstance: (id) => id === "server" ? instance(root) : undefined } },
    features: { add(name) { assert.equal(name, "mcWorldMap"); } },
    on(event, callback) { disposals.push(callback); },
    protocol: { on(event, handler) { events.set(event, handler); }, response(request, value) { response = value; }, responseError(request, value) { error = value; } }
  };
  load("daemon/src/backend/map/index.ts").registerWorldMap(ctx);
  t.after(async () => { for (const callback of disposals) await callback(); });
  await events.get("mc-tools/map/worlds")({}, { instanceUuid: "server" });
  assert.equal(response.length, 1);
  assert.deepEqual(Object.keys(response[0]).sort(), ["dimension", "id", "name", "spawn"]);
  const world = response[0].id;
  await events.get("mc-tools/map/tile")({}, { instanceUuid: "server", world, x: 0, z: 0 });
  assert.equal(response.chunks, 1);
  await events.get("mc-tools/map/tile")({}, { instanceUuid: "server", world, x: 0, z: 0, y: 0 });
  assert.deepEqual(pixels(response)(0, 0), [0, 0, 0, 0]);
  await events.get("mc-tools/map/tile")({}, { instanceUuid: "server", world, x: 0, z: 0, y: 64 });
  assert.deepEqual(pixels(response)(0, 0), rgb(blockColor("grass_block")));
  for (const y of [null, "64", 1.5, -2049, 2048]) {
    await events.get("mc-tools/map/tile")({}, { instanceUuid: "server", world, x: 0, z: 0, y });
    assert.equal(error.message, "MC_MAP_INVALID");
  }
  await events.get("mc-tools/map/tile")({}, { instanceUuid: "server", world: "../secret", x: 0, z: 0 });
  assert.equal(error.message, "MC_MAP_INVALID");
  ctx.instances.subsystem.getInstance = () => instance(path.join(root, "nonexistent"));
  await events.get("mc-tools/map/worlds")({}, { instanceUuid: "server" });
  assert.equal(error.message, "MC_MAP_READ_FAILED");
});
