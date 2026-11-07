const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loader } = require("./helpers.cjs");
const load = loader();
const clouds = load("panel/src/map/scene-clouds.ts");
const { cloudTexture, cloudCamera, cloudScroll, cloudFaces, CLOUD_INSIDE_FACE } = clouds;
const data = require("../shared/clouds.json");
const [DOWN, UP, NORTH, SOUTH, WEST, EAST] = [0, 1, 2, 3, 4, 5];

/** A texture with the given filled cells, in the same packed form as shared/clouds.json. */
function synthetic(width, height, filled) {
  const bits = Buffer.alloc(Math.ceil(width * height / 8));
  for (const [x, z] of filled) bits[(x + z * width) >> 3] |= 1 << ((x + z * width) & 7);
  return cloudTexture({ width, height, cells: bits.toString("base64") });
}
const triples = faces => Array.from({ length: faces.length / 3 }, (_, i) => ({ dx: faces[i * 3], dz: faces[i * 3 + 1], face: faces[i * 3 + 2] }));

test("the vanilla cloud texture becomes CloudRenderer's wrapping cell grid", () => {
  const texture = cloudTexture();
  assert.equal(texture.width, 256); assert.equal(texture.height, 256);
  assert.equal(data.minecraftVersion, "26.3");
  // clouds.png has 18,103 opaque pixels; the rest are fully transparent.
  assert.equal(texture.cells.filter(Boolean).length, 18103);
  const wrap = synthetic(4, 4, [[0, 0], [3, 0], [0, 3]]);
  // Cell (0,0) touches (3,0) to its west and (0,3) to its north across the edges.
  assert.equal(wrap.cells[0], 16 | 4 | 2);
});

test("the camera is above, inside or below the 4-block layer at y 192.33", () => {
  assert.equal(cloudCamera(100), 1);
  assert.equal(cloudCamera(192.33), 2);
  assert.equal(cloudCamera(196.33), 2);
  assert.equal(cloudCamera(196.34), 0);
});

test("clouds drift west at 0.6 blocks per second and wrap every 256 cells", () => {
  const texture = cloudTexture();
  const edge = (x, ticks) => { const s = cloudScroll(texture, x, 0, ticks); return x - s.offsetX - (s.cellX * 12 - ticks % (256 * 400) * 0.030000001); };
  // The cell under the camera starts at 12 × cell − drift, modulo the texture.
  for (const x of [-5000, -12, 0, 7.5, 3071]) for (const ticks of [0, 20, 12345.5]) assert(Math.abs(((edge(x, ticks) % 3072) + 3072) % 3072 % 3072) < 1e-6 || Math.abs(((edge(x, ticks) % 3072) + 3072) % 3072 - 3072) < 1e-6);
  const before = cloudScroll(texture, 100, 0, 0), after = cloudScroll(texture, 100, 0, 20);
  const start = s => 100 - s.offsetX;
  assert(Math.abs(start(before) - start(after) - 0.6) < 1e-4 || Math.abs(start(before) - start(after) - 0.6 + 12) < 1e-4, "one second later the cell edge is 0.6 blocks further west");
  assert.deepEqual(cloudScroll(texture, 0, 0, 0), cloudScroll(texture, 0, 0, 256 * 400));
  assert(Math.abs(cloudScroll(texture, 0, 0, 0).offsetZ - 3.96) < 1e-9, "the grid sits 3.96 blocks north");
});

test("faces follow CloudRenderer's culling and near-to-far ring order", () => {
  const texture = synthetic(16, 16, [[10, 8], [5, 8], [8, 11], [8, 9]]);
  const below = triples(cloudFaces(texture, 8, 8, 1, 5));
  const at = (dx, dz, list = below) => list.filter(f => f.dx === dx && f.dz === dz).map(f => f.face).sort();
  // East of the camera, seen from below: bottom and its west side only.
  assert.deepEqual(at(2, 0), [DOWN, WEST]);
  assert.deepEqual(at(-3, 0), [DOWN, EAST]);
  assert.deepEqual(at(0, 3), [DOWN, NORTH]);
  // Next to the camera every face is drawn, plus all six from the inside.
  assert.deepEqual(at(0, 1), [DOWN, NORTH, 0 | CLOUD_INSIDE_FACE, 1 | CLOUD_INSIDE_FACE, 2 | CLOUD_INSIDE_FACE, 3 | CLOUD_INSIDE_FACE, 4 | CLOUD_INSIDE_FACE, 5 | CLOUD_INSIDE_FACE].sort());
  const above = triples(cloudFaces(texture, 8, 8, 0, 5)), inside = triples(cloudFaces(texture, 8, 8, 2, 5));
  assert.deepEqual(at(2, 0, above), [UP, WEST]);
  assert.deepEqual(at(2, 0, inside), [DOWN, UP, WEST]);
  // Rings by Manhattan distance, clipped to a circle of the radius.
  const real = triples(cloudFaces(cloudTexture(), 100, 37, 1, 20));
  for (let i = 1; i < real.length; i++) assert(Math.abs(real[i].dx) + Math.abs(real[i].dz) >= Math.abs(real[i - 1].dx) + Math.abs(real[i - 1].dz));
  assert(real.every(f => f.dx * f.dx + f.dz * f.dz <= 400));
  assert(real.length > 300);
});

test("the shader's packed corners match clouds.vsh and wind every face outwards", () => {
  const packed = [0xF03CC3, 0x6666F0, 0xC3F066];
  const corner = i => packed.map(mask => (mask >> i) & 1);
  const normals = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
  for (let face = 0; face < 6; face++) for (const inside of [false, true]) {
    const v = [0, 1, 2].map(q => corner(face * 4 + (inside ? 3 - q : q)));
    const a = v[1].map((c, i) => c - v[0][i]), b = v[2].map((c, i) => c - v[0][i]);
    const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    // Counter-clockwise triangles face their normal, which Three culls as FrontSide.
    assert.deepEqual(n.map(c => Math.sign(c) + 0), normals[face].map(c => (inside ? -c : c) + 0), `face ${face}${inside ? " inside" : ""}`);
  }
});
