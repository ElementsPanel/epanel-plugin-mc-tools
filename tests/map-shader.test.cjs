const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const three = require("three");
const { loader } = require("./helpers.cjs");

test("complete Three.js terrain shaders link within GPU limits and render fixed shading, original AO and smooth biome colors", async t => {
  const { sceneMaterials } = loader({
    three: { ...three, TextureLoader: class { load() { return new three.Texture(); } } },
    "./minecraft-atlas": { minecraftAtlasUrl: () => "atlas.png", strawBedUrl: () => "straw_bed.png" }
  })("panel/src/map/scene-materials.ts");
  const materials = sceneMaterials(false, () => {}, () => {});
  t.after(() => { materials[0].uniforms.uAtlas.value.dispose(); materials[0].uniforms.uAnimation.value.dispose(); materials.forEach(m => m.dispose()); });
  const modulePath = path.resolve(path.dirname(require.resolve("three")), "../src/renderers/webgl/WebGLProgram.js");
  const { WebGLProgram } = await import(pathToFileURL(modulePath).href);
  const programs = materials.map(material => {
    const source = {};
    // Capture the actual engine-generated shaders, including normal/UV inputs.
    // Compiling the material text alone misses those extra attribute slots.
    const gl = {
      VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, createProgram: () => ({}), createShader: type => ({ type }),
      shaderSource(shader, code) { source[shader.type === 1 ? "vertex" : "fragment"] = code; },
      compileShader() {}, attachShader() {}, linkProgram() {}, bindAttribLocation() {}
    };
    new WebGLProgram({ getContext: () => gl }, "terrain", {
      defines: material.defines, vertexShader: material.vertexShader, fragmentShader: material.fragmentShader,
      precision: "highp", shaderType: "ShaderMaterial", shaderName: "terrain", hasPositionAttribute: true,
      toneMapping: three.NoToneMapping, outputColorSpace: three.SRGBColorSpace, rendererExtensionParallelShaderCompile: false
    }, {});
    return source;
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "epanel-shaders-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "programs.json");
  fs.writeFileSync(filename, JSON.stringify(programs));
  const input = fs.openSync(filename, "r");
  let result;
  try {
    result = spawnSync("python3", [path.join(__dirname, "helpers/map-shader-gpu.py")], {
      stdio: [input, "pipe", "pipe"], encoding: "utf8", timeout: 30_000
    });
  } finally { fs.closeSync(input); }
  if (result.error?.code === "ENOENT" || result.status === 77) { t.skip("Python/EGL offscreen rendering is unavailable"); return; }
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const checks = JSON.parse(result.stdout);
  assert.equal(checks.length, materials.length);
  for (const check of checks) {
    assert(check.attributes <= 16);
    assert(check.surface.every(value => value >= 250));
    assert(check.occluded.every(value => Math.abs(value - 102) <= 1));
    assert(check.emissive.every(value => value >= 250));
    assert(check.inclined.every(value => value >= 250), "inclined model planes use their geometry axes");
    assert(check.tinted[0] > 50 && check.tinted[0] < 200);
    assert(check.tinted[1] > 50 && check.tinted[1] < 200);
    assert.equal(check.tinted[2], 0);
  }
});
