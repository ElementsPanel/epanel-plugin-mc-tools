const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loader } = require("./helpers.cjs");
const load = loader();
const { meshScene } = load("daemon/src/backend/map/scene.ts");
const { decodeScene } = load("panel/src/map/scene-codec.ts");
const { SceneKind, SCENE_MODEL, sceneTextures } = load("shared/scene.ts");

test("snow layers keep their layered thickness instead of rendering as full snow blocks", async () => {
  const tile = async layers => ({ ...await meshScene([{ x: 0, z: 0, layers: [{ y: 0,
    block: i => i === 0 ? "snow" : "air", properties: () => ({ layers: String(layers) }) }] }]), chunks: 1, warnings: 0 });
  for (const layers of [1, 4, 8]) {
    const mesh = decodeScene(await tile(layers)).meshes[0];
    assert.equal(mesh.count, 6, `layers=${layers}`);
    assert.equal(mesh.maxY, layers * 2 / 16, `layers=${layers}`);
    assert.deepEqual(new Set([...mesh.sprites].map(sprite => sceneTextures.get(sprite)[0])), new Set(["block/snow"]));
  }
});

test("water surfaces and dirt paths sit lower than a full block like vanilla", async () => {
  const tile = async (name, properties = {}) => ({ ...await meshScene([{ x: 0, z: 0, layers: [{ y: 0,
    block: i => i === 0 ? name : "air", properties: () => properties }] }]), chunks: 1, warnings: 0 });
  const water = decodeScene(await tile("water")).meshes.find(mesh => mesh.kind === SceneKind.Translucent);
  assert(water);
  const tops = Array.from({ length: water.count }, (_, i) => i).filter(i => water.faces[i] === 2);
  assert(tops.every(i => Math.abs(water.origins[i * 3 + 1] - 14 / 16) < 1e-6), "water top is two pixels low");
  for (let i = 0; i < water.count; i++) if (water.faces[i] < 2 || water.faces[i] === 4 || water.faces[i] === 5)
    assert.equal(water.sizes[i * 2 + 1], 14 / 16, "water sides stop at the lowered surface");
  const path = decodeScene(await tile("dirt_path"));
  assert.equal(Buffer.from((await tile("dirt_path")).quads, "base64").length, 16, "one model carrier");
  assert.equal(path.meshes[0].count, 6); assert.equal(path.meshes[0].kind, SceneKind.Opaque);
  assert.equal(path.meshes[0].maxY, 15 / 16);
  assert.deepEqual(new Set([...path.meshes[0].sprites].map(sprite => sceneTextures.get(sprite)[0])),
    new Set(["block/dirt_path_side", "block/dirt_path_top", "block/dirt"]));
});

test("campfires and straw beds expand their real models and keep their animated fire and facing", async () => {
  const tile = async (name, properties = {}) => ({ ...await meshScene([{ x: 0, z: 0, layers: [{ y: 0,
    block: i => i === 0 ? name : "air", properties: () => properties }] }]), chunks: 1, warnings: 0 });
  const sprites = mesh => new Set([...mesh.sprites].map(sprite => sceneTextures.get(sprite)[0]));
  const unlit = decodeScene(await tile("campfire", { facing: "south", lit: "false" }));
  assert.equal(unlit.meshes[0].count, 28); assert.equal(unlit.meshes[0].kind, SceneKind.Cutout);
  assert.deepEqual(sprites(unlit.meshes[0]), new Set(["block/campfire_log"]));
  assert.equal(unlit.meshes[0].maxY, 7 / 16); assert.equal(unlit.animated, false);
  const lit = decodeScene(await tile("campfire", { facing: "north", lit: "true" }));
  assert.equal(lit.meshes[0].count, 32); assert(lit.animated);
  assert.deepEqual(sprites(lit.meshes[0]), new Set(["block/campfire_log", "block/campfire_log_lit", "block/campfire_fire"]));
  assert.equal(lit.meshes[0].maxY, 17 / 16);
  const soul = decodeScene(await tile("soul_campfire", { facing: "east", lit: "true" }));
  assert.deepEqual(sprites(soul.meshes[0]), new Set(["block/campfire_log", "block/soul_campfire_log_lit", "block/soul_campfire_fire"]));
  const foot = decodeScene(await tile("straw_bed", { facing: "south", part: "foot" }));
  assert.equal(foot.meshes[0].count, 11); assert.deepEqual(sprites(foot.meshes[0]), new Set(["block/straw_bed"]));
  assert.equal(foot.meshes[0].maxY, 4 / 16);
  const head = decodeScene(await tile("straw_bed", { facing: "west", part: "head" }));
  assert.equal(head.meshes[0].count, 32); assert.equal(head.meshes[0].maxY, 5 / 16);
  assert(head.meshes[0].maxY > foot.meshes[0].maxY, "the pillow is taller than the foot");
});

test("torches and composters expand their real thin model geometry instead of textured cubes", async () => {
  const tile = async (name, properties = {}) => ({ ...await meshScene([{ x: 0, z: 0, layers: [{ y: 0,
    block: i => i === 0 ? name : "air", properties: () => properties }] }]), chunks: 1, warnings: 0 });
  const sprites = mesh => new Set([...mesh.sprites].map(sprite => sceneTextures.get(sprite)[0]));
  for (const [name, properties, texture] of [["torch", {}, "block/torch"], ["soul_torch", {}, "block/soul_torch"],
    ["redstone_torch", { lit: "true" }, "block/redstone_torch"]]) {
    const result = await tile(name, properties), bytes = Buffer.from(result.quads, "base64");
    assert.equal(bytes.length, 16, name); assert(bytes[9] & SCENE_MODEL);
    const mesh = decodeScene(result).meshes[0];
    assert.equal(mesh.count, 6, name); assert.equal(mesh.kind, SceneKind.Cutout, name);
    assert.deepEqual(sprites(mesh), new Set([texture]), name);
    assert(mesh.minY === 0 && mesh.maxY === 1, name);
  }
  for (const facing of ["north", "east", "south", "west"]) {
    const mesh = decodeScene(await tile("wall_torch", { facing })).meshes[0];
    assert.equal(mesh.count, 6); assert(mesh.axes, "the wall model tilts away from its cube");
    assert(mesh.maxY > 1, "the torch extends above the supporting block");
  }
  const composter = decodeScene(await tile("composter")).meshes[0];
  assert.equal(composter.count, 18); assert.equal(composter.kind, SceneKind.Opaque);
  assert.deepEqual(sprites(composter), new Set(["block/composter_side", "block/composter_top", "block/composter_bottom"]));
  assert(composter.minY === 0 && composter.maxY === 1);
});

test("adjacent faces carry identical corner colors along their shared edge, including legacy cached colors", async () => {
  const layer = { y: 0, block: i => i >> 8 === 0 ? "grass_block" : "air",
    biome: i => (i & 15) < 8 ? "minecraft:dappled_forest" : "minecraft:plains" };
  const tile = { ...await meshScene([{ x: 0, z: 0, layers: [layer] }]), chunks: 1, warnings: 0 };
  const bytes = Buffer.from(tile.quads, "base64"), tints = Buffer.from(tile.tints, "base64");
  const find = x => { for (let o = 0; o < bytes.length; o += 16) if (bytes[o] === x && bytes[o + 1] === 7 && bytes[o + 8] === 2) return o / 16; assert.fail("missing top face"); };
  const a = find(7), b = find(8), corner = (i, c) => [...tints.subarray(i * 12 + c * 3, i * 12 + c * 3 + 3)];
  assert.deepEqual(corner(a, 3), corner(b, 0)); assert.deepEqual(corner(a, 2), corner(b, 1));
  assert.notDeepEqual(corner(a, 0), corner(a, 3), "color varies within the face");
  const decoded = decodeScene(tile);
  assert(decoded.meshes.every(mesh => mesh.cornerColors.every(colors => colors.length === mesh.count * 3)));
  assert.throws(() => decodeScene({ ...tile, tints: tile.tints.slice(4) }), /MC_MAP_CORRUPT/);
  const legacy = Buffer.alloc(tints.length / 3 * 5);
  for (let i = 0; i < tints.length / 3; i++) {
    tints.copy(legacy, i * 5, i * 3, i * 3 + 3);
    legacy[i * 5 + 3] = i % 256; legacy[i * 5 + 4] = 255 - i % 256;
  }
  assert.deepEqual(decodeScene({ ...tile, tints: undefined, shading: legacy.toString("base64") }), decoded);
  assert.throws(() => decodeScene({ ...tile, tints: undefined, shading: legacy.subarray(3).toString("base64") }), /MC_MAP_CORRUPT/);
});

test("shelf mushrooms use their thin original geometry and UV regions in every horizontal facing", async () => {
  for (const facing of ["north", "east", "south", "west"]) for (const age of ["0", "1"]) {
    const layers = [{ y: 0, block: i => i === 0 ? "shelf_mushroom" : "air", properties: () => ({ facing, age }) }];
    const tile = { ...await meshScene([{ x: 0, z: 0, layers }]), chunks: 1, warnings: 0 };
    const bytes = Buffer.from(tile.quads, "base64"); assert(bytes[9] & SCENE_MODEL);
    const decoded = decodeScene(tile), mesh = decoded.meshes[0];
    assert.equal(decoded.count, 12);
    assert.equal(mesh.maxY, 11 / 16); assert.equal(mesh.minY, (age === "0" ? 8 : 6) / 16);
    assert([...mesh.sizes].every(value => value < 1));
    assert([...mesh.uvU, ...mesh.uvV].every(Number.isFinite));
    assert([...mesh.uvU, ...mesh.uvV].some(value => value !== 0 && value !== 1));
  }
});

