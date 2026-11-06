const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loader } = require("./helpers.cjs");
const load = loader();
const { meshScene } = load("daemon/src/backend/map/scene.ts");
const { blockStateKey } = load("daemon/src/backend/map/materials.ts");
const { decodeScene } = load("panel/src/map/scene-codec.ts");
const { SceneKind, SCENE_MODEL, SCENE_EMISSIVE, SCENE_AXES, sceneTextures } = load("shared/scene.ts");
const { FIRE_DIRECTIONS } = load("shared/fire.ts");
const near = (a, b) => assert(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
// Vanilla's tilted floor planes extend slightly into the supporting block.
const floorInset = .05 * Math.tan(Math.PI / 8);
async function fire(name, properties = {}) {
  return { ...await meshScene([{ x: 0, z: 0, layers: [{ y: 0, block: i => i === 0 ? name : "air", properties: () => properties }] }]), chunks: 1, warnings: 0 };
}
function vertices(mesh) {
  return Array.from({ length: mesh.count }, (_, i) => [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) =>
    [0, 1, 2].map(axis => mesh.origins[i * 3 + axis] + mesh.axes[0][i * 3 + axis] * u + mesh.axes[1][i * 3 + axis] * v))).flat();
}

test("standing fire and soul fire use animated inclined planes, retain their height and never become cube faces", async () => {
  for (const name of ["fire", "soul_fire"]) {
    const tile = await fire(name), bytes = Buffer.from(tile.quads, "base64");
    assert.equal(bytes.length, 16); assert(bytes[9] & SCENE_MODEL); assert(bytes[9] & SCENE_EMISSIVE);
    const scene = decodeScene(tile), mesh = scene.meshes[0];
    assert.equal(mesh.kind, SceneKind.Plant); assert.equal(mesh.count, 12); assert.equal(scene.animated, true);
    assert(mesh.flags.every(value => value & SCENE_AXES)); assert(mesh.occlusion.every(value => value === 0));
    near(mesh.minY, -floorInset); near(mesh.maxY, 1.4 + floorInset);
    assert(mesh.axes.some(axis => Array.from({ length: mesh.count }, (_, i) => [...axis.slice(i * 3, i * 3 + 3)].filter(value => Math.abs(value) > 1e-5).length > 1)));
    const textures = new Set([...mesh.sprites].map(sprite => sceneTextures.get(sprite)[0]));
    assert.deepEqual(textures, new Set([`block/${name}_0`, `block/${name}_1`]));
    assert([...mesh.sprites].every(sprite => sceneTextures.get(sprite)[2] === 32));
    assert(vertices(mesh).flat().every(Number.isFinite));
  }
});

test("fire keeps all attachment combinations and ignores age while placing wall and ceiling flames on their supporting faces", async () => {
  for (let mask = 1; mask < 32; mask++) {
    const properties = Object.fromEntries(FIRE_DIRECTIONS.map((direction, i) => [direction, String(!!(mask & (1 << i)))]));
    const tile = await fire("fire", properties), mesh = decodeScene(tile).meshes[0];
    assert.equal(Buffer.from(tile.quads, "base64")[15], mask);
    assert.equal(mesh.count, 2 * mask.toString(2).replaceAll("0", "").length);
    assert.equal(blockStateKey("fire", { ...properties, age: "0" }), blockStateKey("fire", { ...properties, age: "15" }));
    if (mask === 16) { assert(mesh.minY > .5); near(mesh.maxY, 1); }
    if ([1, 2, 4, 8].includes(mask)) {
      const axis = mask === 1 || mask === 4 ? 2 : 0;
      const position = mask === 1 || mask === 8 ? .01 / 16 : 1 - .01 / 16;
      vertices(mesh).forEach(point => near(point[axis], position));
      near(mesh.minY, 0); near(mesh.maxY, 1.4);
    }
  }
  assert.notEqual(blockStateKey("fire", { east: "true" }), blockStateKey("fire", { west: "true" }));
});

test("fire does not hide or darken the supporting terrain", async () => {
  const tile = async name => ({ ...await meshScene([{ x: 0, z: 0, layers: [{ y: 0,
    block: i => i === 0 ? "stone" : i === 256 ? name : "air" }] }]), chunks: 1, warnings: 0 });
  const bare = decodeScene(await tile("air")), burning = decodeScene(await tile("fire"));
  assert.deepEqual(burning.meshes.find(mesh => mesh.kind === SceneKind.Opaque), bare.meshes[0]);
  near(burning.meshes.find(mesh => mesh.kind === SceneKind.Plant).minY, 1 - floorInset);
});

test("legacy merged fire cubes become separate flames at the correct block height, and malformed attachments are rejected", async () => {
  const tile = await fire("fire"), raw = Buffer.from(tile.quads, "base64");
  raw[15] = 32;
  assert.throws(() => decodeScene({ ...tile, quads: raw.toString("base64") }), /MC_MAP_CORRUPT/);
  raw[9] = SceneKind.Cutout; raw[15] = 0;
  raw.writeInt16LE(0, 2); raw.writeUInt16LE(2, 4); raw.writeUInt16LE(3, 6);
  const mesh = decodeScene({ ...tile, quads: raw.toString("base64") }).meshes[0];
  assert.equal(mesh.count, 6 * 12); near(mesh.minY, -1 - floorInset);
  const points = vertices(mesh);
  near(Math.min(...points.map(point => point[0])), 0); near(Math.max(...points.map(point => point[0])), 3);
  near(Math.min(...points.map(point => point[2])), 0); near(Math.max(...points.map(point => point[2])), 2);
  assert(mesh.sprites.every(sprite => sceneTextures.get(sprite)[0].startsWith("block/fire_")));
});
