const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loader } = require("./helpers.cjs");
const load = loader();
const { meshScene } = load("daemon/src/backend/map/scene.ts");
const { renderSurface } = load("daemon/src/backend/map/surface.ts");
const { SceneKind, SCENE_EMISSIVE, SCENE_GROUND, SCENE_MODEL } = load("shared/scene.ts");
const sprites = require("../shared/sprite-colors.json");

/** Chunk layers from a world-coordinate block function. */
function world(block, biome = () => "minecraft:plains", sections = [-1, 0, 1, 2, 3, 4, 5]) {
  return (cx, cz) => ({ x: cx, z: cz, layers: sections.slice().reverse().map(sy => ({
    y: sy,
    block: i => block(cx * 16 + (i & 15), sy * 16 + (i >> 8), cz * 16 + ((i >> 4) & 15)),
    biome: i => biome(cx * 16 + (i & 15), sy * 16 + (i >> 8), cz * 16 + ((i >> 4) & 15))
  })) });
}

/** A hilly landscape with everything the flat map treats specially. */
const height = (x, z) => Math.round(40 + 6 * Math.sin(x / 7) * Math.cos(z / 9) + 2 * Math.sin((x - z) / 4));
const landscape = world((x, y, z) => {
  const h = height(x, z), tree = ((x % 11) + 11) % 11 < 3 && ((z % 9) + 9) % 9 < 3, trunk = ((x % 11) + 11) % 11 === 1 && ((z % 9) + 9) % 9 === 1;
  if (y < h - 2) return "minecraft:stone";
  if (y < h) return "minecraft:dirt";
  if (y === h) return h <= 38 ? "minecraft:sand" : (x * 5 + z) % 17 === 0 ? "minecraft:glowstone" : "minecraft:grass_block";
  if (y <= 38) return y === 38 && x > 20 && z < 12 ? "minecraft:ice" : "minecraft:water";
  if (trunk && y <= h + 4) return "minecraft:oak_log";
  if (tree && y >= h + 3 && y <= h + 5 && h > 38) return "minecraft:oak_leaves";
  if (y === h + 1 && (x + z * 3) % 7 === 0) return "minecraft:short_grass";
  if (y === h + 1 && (x * 3 + z) % 13 === 0) return "minecraft:torch";
  if (y === h + 1 && (x * 2 + z * 5) % 19 === 0) return "minecraft:pink_petals";
  if (y === 50 && x >= 4 && x < 8 && z >= 20 && z < 26) return x === 4 ? "minecraft:glass" : "minecraft:red_stained_glass";
  return "minecraft:air";
}, (x) => x < 14 ? "minecraft:plains" : x < 24 ? "minecraft:swamp" : "minecraft:jungle");

const area = (chunk, from, to) => {
  const chunks = [];
  for (let z = from; z <= to; z++) for (let x = from; x <= to; x++) chunks.push(chunk(x, z));
  return chunks;
};

/**
 * Composite the mesher's own top-down faces per block: every +Y face, double-sided
 * translucent −Y faces and flat ground cover, nearest first, using the shader's face
 * shading, vertex occlusion and per-corner tints and the sprite averages seen at the
 * 2D/3D hand-off zoom. Model carriers (torches) are a few texels and are skipped.
 */
async function topDown(chunks) {
  const owned = chunks.filter(c => c.x >= 0 && c.x < 2 && c.z >= 0 && c.z < 2);
  const result = await meshScene(owned, false, undefined, chunks.filter(c => !owned.includes(c)));
  const quads = Buffer.from(result.quads, "base64"), tints = Buffer.from(result.tints, "base64");
  const columns = Array.from({ length: 32 * 32 }, () => []);
  for (let i = 0; i < quads.length / 16; i++) {
    const o = i * 16, face = quads[o + 8], flags = quads[o + 9], kind = flags & 3;
    if (face !== 2 && !(face === 3 && kind === SceneKind.Translucent)) continue;
    if (flags & SCENE_MODEL) continue;
    const x = quads[o], z = quads[o + 1], y = quads.readInt16LE(o + 2), w = quads.readUInt16LE(o + 4), h = quads.readUInt16LE(o + 6);
    const sprite = sprites[quads.readUInt16LE(o + 10)];
    const translucent = kind === SceneKind.Translucent;
    const alpha = kind === SceneKind.Opaque ? 1 : (translucent ? sprite[1] : sprite[3]) / 255;
    const color = translucent ? sprite[0] : sprite[2];
    const tint = [0, 1, 2].map(c => (tints[i * 12 + c] + tints[i * 12 + 3 + c] + tints[i * 12 + 6 + c] + tints[i * 12 + 9 + c]) / 4);
    const ao = quads[o + 15], occlusion = (ao & 3) + ((ao >> 2) & 3) + ((ao >> 4) & 3) + ((ao >> 6) & 3);
    const shade = flags & SCENE_EMISSIVE ? 1 : (face === 3 ? 0.5 : 1) * (1 - occlusion * 0.05);
    // Ground cover floats 1/64 above its cell; translucency wins coplanar ties.
    const depth = y + (flags & SCENE_GROUND ? 1 / 64 : 0) + (translucent ? 1 / 128 : 0);
    for (let dx = 0; dx < h; dx++) for (let dz = 0; dz < w; dz++) columns[(z + dz) * 32 + x + dx].push({ depth, color, alpha, tint, shade });
  }
  return columns.map(faces => {
    faces.sort((a, b) => b.depth - a.depth);
    let transmit = 1; const rgb = [0, 0, 0];
    for (const face of faces) {
      for (let c = 0; c < 3; c++) rgb[c] += transmit * face.alpha * face.shade * ((face.color >> (16 - c * 8)) & 255) * face.tint[c] / 255;
      transmit *= 1 - face.alpha;
      if (transmit < 1 / 512) break;
    }
    return transmit > 1 - 1 / 255 ? undefined : rgb.map(value => Math.round(value / (1 - transmit)));
  });
}

test("the flat map agrees with the 3D view's top-down faces for nearly every block", async () => {
  const chunks = area(landscape, -1, 2);
  const expected = await topDown(chunks);
  const { pixels } = renderSurface(chunks, 32);
  let close = 0, drawn = 0;
  for (let i = 0; i < 32 * 32; i++) {
    if (!expected[i]) continue;
    drawn++;
    if (expected[i].every((value, c) => Math.abs(value - pixels[i * 4 + c]) <= 3)) close++;
  }
  assert.equal(drawn, 32 * 32);
  assert(close / drawn >= 0.95, `only ${(close / drawn * 100).toFixed(1)}% of blocks match the 3D top-down view`);
  if (process.env.MAP_SURFACE_REPORT) console.log(`flat map vs 3D top-down: ${close}/${drawn} blocks within 3/255`);
});

test("vertical plants and torches vanish from above while flat ground cover stays", () => {
  const scene = (top) => world((x, y) => y < 64 ? "minecraft:grass_block" : y === 64 ? top : "minecraft:air", undefined, [3, 4])(0, 0);
  const bare = renderSurface([scene("minecraft:air")], 16).pixels;
  for (const hidden of ["minecraft:short_grass", "minecraft:poppy", "minecraft:torch", "minecraft:sugar_cane", "minecraft:vine"]) {
    assert.deepEqual(renderSurface([scene(hidden)], 16).pixels.subarray(0, 4), bare.subarray(0, 4), hidden);
  }
  assert.notDeepEqual(renderSurface([scene("minecraft:pink_petals")], 16).pixels.subarray(0, 4), bare.subarray(0, 4));
});

test("occlusion darkens the foot of a step, including across a tile's neighbour ring", () => {
  // A wall along x = 0 belongs to the chunk west of the tile.
  const step = world((x, y) => y < 64 || (x < 0 && y === 64) ? "minecraft:stone" : "minecraft:air", undefined, [3, 4]);
  const alone = renderSurface([step(0, 0)], 16).pixels, ringed = renderSurface([step(0, 0), step(-1, 0)], 16).pixels;
  // An interior row: at z = 0 the diagonal corner would fall in an absent chunk.
  const at = (pixels, x) => pixels[(5 * 16 + x) * 4];
  assert.equal(at(alone, 0), at(alone, 1), "no neighbour, no occlusion");
  assert(at(ringed, 0) < at(ringed, 1), "the neighbour's wall shades the edge column");
  assert.equal(Math.round(at(ringed, 1) * 0.8), at(ringed, 0), "two occluded corners of 0.6 average to 0.8");
});

test("water shows the seabed through it and biome tints blend across borders", () => {
  const sea = world((x, y) => y < 60 ? "minecraft:sand" : y < 63 ? "minecraft:water" : "minecraft:air", x => x < 8 ? "minecraft:ocean" : "minecraft:swamp", [3])(0, 0);
  const water = renderSurface([sea], 16).pixels, sand = renderSurface([world((x, y) => y < 60 ? "minecraft:sand" : "minecraft:air", undefined, [3])(0, 0)], 16).pixels;
  assert.equal(water[3], 255);
  assert.notDeepEqual(water.subarray(0, 3), sand.subarray(0, 3));
  // Water now uses the same 7×7 biome blend as grass, so the border fades.
  const red = x => water[x * 4];
  assert(red(0) !== red(15) && Math.abs(red(7) - red(8)) < Math.abs(red(0) - red(15)), "water fades between biomes");
  const grass = world((x, y) => y < 64 ? "minecraft:grass_block" : "minecraft:air", x => x < 8 ? "minecraft:plains" : "minecraft:swamp", [3])(0, 0);
  const field = renderSurface([grass], 16).pixels, grassRed = x => field[x * 4];
  assert(grassRed(0) !== grassRed(15) && grassRed(6) !== grassRed(7) && Math.abs(grassRed(7) - grassRed(8)) < Math.abs(grassRed(0) - grassRed(15)), "grass fades between biomes");
});
