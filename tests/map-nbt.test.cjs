const assert = require("node:assert/strict");
const { test } = require("node:test");
const nbt = require("prismarine-nbt");
const { loader } = require("./helpers.cjs");
const load = loader();
const { readChunkNbt } = load("daemon/src/backend/map/nbt.ts");
const { chunkSurface } = load("daemon/src/backend/map/chunk.ts");
const { blockColor } = load("daemon/src/backend/map/colors.ts");

/** The fast reader must agree with prismarine-nbt on everything the map reads. */
function compare(chunk, nether = false) {
  const bytes = nbt.writeUncompressed(chunk);
  const fast = readChunkNbt(bytes);
  const slow = nbt.simplify(nbt.parseUncompressed(bytes));
  assert.deepEqual(chunkSurface(fast, nether), chunkSurface(slow, nether));
  return fast;
}

const ones = Array.from({ length: 256 }, () => [0x11111111, 0x11111111]);

test("the chunk reader matches prismarine-nbt for every palette shape the map supports", () => {
  const fixtures = [
    nbt.comp({ DataVersion: nbt.int(3465), sections: nbt.list({ type: "compound", value: [
      { Y: nbt.byte(4), block_states: nbt.comp({ palette: nbt.list({ type: "compound", value: [{ Name: nbt.string("minecraft:grass_block") }] }) }) }
    ] }) }),
    nbt.comp({ DataVersion: nbt.int(2230), Level: nbt.comp({ Sections: nbt.list({ type: "compound", value: [{
      Y: nbt.byte(4), Palette: nbt.list({ type: "compound", value: [{ Name: nbt.string("minecraft:air") }, { Name: nbt.string("minecraft:stone") }] }),
      BlockStates: nbt.longArray(ones)
    }] }) }) }),
    nbt.comp({ Level: nbt.comp({ Sections: nbt.list({ type: "compound", value: [{ Y: nbt.byte(4), Blocks: nbt.byteArray(Array(4096).fill(2)) }] }) }) }),
    nbt.comp({ DataVersion: nbt.int(5023), sections: nbt.list({ type: "compound", value: [{
      Y: nbt.byte(4),
      block_states: nbt.comp({ palette: nbt.list({ type: "string", value: ["minecraft:sand"] }), data: nbt.longArray(ones) })
    }] }) }),
    nbt.comp({ DataVersion: nbt.int(5023), sections: nbt.list({ type: "compound", value: [{
      Y: nbt.byte(4),
      block_states: nbt.comp({ palette: nbt.list({ type: "compound", value: [
        { "": nbt.string("minecraft:air") },
        { id: nbt.string("minecraft:water"), properties: nbt.comp({ level: nbt.string("0") }) }
      ] }), data: nbt.longArray(ones) })
    }] }) })
  ];
  for (const fixture of fixtures) compare(fixture);
  assert.deepEqual(compare(fixtures[0]).sections[0].Y, 4);
});

test("skipped tags keep the reader fast without changing the decoded surface", () => {
  const fixture = nbt.comp({
    DataVersion: nbt.int(3465),
    Heightmaps: nbt.comp({ MOTION_BLOCKING: nbt.longArray(Array(37).fill(0)) }),
    entities: nbt.list({ type: "compound", value: [] }),
    block_entities: nbt.list({ type: "compound", value: [{ id: nbt.string("minecraft:chest"), x: nbt.int(1) }] }),
    sections: nbt.list({ type: "compound", value: [{
      Y: nbt.byte(4),
      BlockLight: nbt.byteArray(Array(2048).fill(0)),
      SkyLight: nbt.byteArray(Array(2048).fill(-1)),
      block_states: nbt.comp({ palette: nbt.list({ type: "compound", value: [{ Name: nbt.string("minecraft:grass_block") }] }) }),
      biomes: nbt.comp({ palette: nbt.list({ type: "string", value: ["minecraft:plains"] }), data: nbt.longArray(Array(64).fill([0, 0])) })
    }] })
  });
  const fast = compare(fixture);
  assert.equal(fast.Heightmaps, undefined, "heightmaps are never materialized");
  assert.equal(fast.entities, undefined);
  assert.equal(fast.sections.length, 1);
  assert.equal(fast.sections[0].BlockLight, undefined);
  assert.equal(fast.sections[0].biomes.palette.length, 1);
  assert.equal(chunkSurface(fast).colors[0], blockColor("grass_block"));
});

test("truncated or malformed chunks report corruption instead of reading past the buffer", () => {
  const bytes = nbt.writeUncompressed(nbt.comp({ DataVersion: nbt.int(3465), sections: nbt.list({ type: "compound", value: [] }) }));
  for (const length of [1, 2, 5, bytes.length - 1]) {
    assert.throws(() => readChunkNbt(bytes.subarray(0, length)), /MC_MAP_CORRUPT/, String(length));
  }
  assert.throws(() => readChunkNbt(Buffer.from([0x01, 0x00, 0x00, 0x00])), /MC_MAP_CORRUPT/);
  // A list whose declared length exceeds the data must not allocate or loop forever.
  const bomb = Buffer.from(bytes);
  bomb.writeInt32BE(0x7fffffff, 0);
  assert.throws(() => readChunkNbt(bomb), /MC_MAP_CORRUPT/);
});
