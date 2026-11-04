const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const vue = require("vue");
const { loader, deferred, root } = require("./helpers.cjs");

test("viewport zoom anchors the cursor, clamps coordinates, and includes negative tiles", () => {
  const { worldPosition, zoomCamera, visibleTiles } = loader()("panel/src/map/viewport.ts");
  const camera = { x: -12, z: 76, zoom: 2 };
  const before = worldPosition(camera, 800, 600, 123, 456);
  zoomCamera(camera, 800, 600, 123, 456, 5);
  assert.deepEqual(worldPosition(camera, 800, 600, 123, 456), before);
  zoomCamera(camera, 800, 600, 400, 300, 999);
  assert.equal(camera.zoom, 12);
  const tiles = visibleTiles({ x: 0, z: 0, zoom: 2 }, 512, 256);
  assert(tiles.some((tile) => tile.x === -1 && tile.z === -1));
  assert(tiles.some((tile) => tile.x === 0 && tile.z === 0));
});

test("viewport limits tile loading and cancels requests, animation frames, and listeners on close", async (t) => {
  const original = Object.fromEntries(["ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "devicePixelRatio"].map((key) => [key, globalThis[key]]));
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const frames = new Map(), listeners = new Map(), requests = [];
  let sequence = 0, disconnected = 0, changed = 0;
  globalThis.ResizeObserver = class { observe() {} disconnect() { disconnected++; } };
  globalThis.requestAnimationFrame = (callback) => { frames.set(++sequence, callback); return sequence; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.devicePixelRatio = 3;
  const canvas = {
    style: {}, getBoundingClientRect: () => ({ width: 512, height: 256 }),
    getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }),
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); }
  };
  const { MapViewport } = loader()("panel/src/map/viewport.ts");
  const view = new MapViewport(canvas, { id: "world", spawn: { x: 0, z: 0 } }, (world, x, z, signal) => {
    const result = deferred(); requests.push({ ...result, signal }); return result.promise;
  }, () => changed++);
  const runFrame = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback()); };
  runFrame();
  assert.equal(canvas.width, 1024);
  assert.equal(requests.length, 3);
  view.center(-100, 100);
  runFrame();
  assert.equal(requests.length, 3);
  const before = changed;
  view.dispose();
  assert.equal(disconnected, 1);
  assert.equal(listeners.size, 0);
  assert.equal(frames.size, 0);
  assert(requests.every((request) => request.signal.aborted));
  requests.forEach((request) => request.resolve({ image: "", warnings: 0 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(changed, before);
  assert.equal(frames.size, 0);
});

test("map API shares authentication, encodes instance parameters, forwards cancellation, and reports protocol errors", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let authentications = 0;
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ status: 200, data: [] }) }; };
  const { worldMapApi, mapError } = loader({
    "@elements-panel/sdk": { ctx: { get: () => ({ api: { userInfoApi: () => ({ execute: async () => { authentications++; return { value: { token: "token" } }; } }) } }) } },
    "../settings": { t: (key) => "translated:" + key }
  })("panel/src/map/api.ts");
  const api = worldMapApi("server & one", "node");
  const signal = new AbortController().signal;
  await Promise.all([api.worlds(signal), api.tile("a".repeat(24), -1, 2, signal)]);
  assert.equal(authentications, 1);
  const url = new URL(requests[0].url, "http://localhost/panel/");
  assert.equal(url.pathname, "/panel/api/mc-tools/map/worlds");
  assert.equal(url.searchParams.get("uuid"), "server & one");
  assert.equal(requests[0].options.headers.Authorization, "Bearer token");
  assert.equal(requests[0].options.signal, signal);
  await api.worlds(signal, true);
  assert.equal(authentications, 2);
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ status: 403, data: "Forbidden" }) });
  await assert.rejects(api.worlds(signal), /Forbidden/);
  assert.equal(mapError(new Error("remote error: MC_MAP_BUSY")), "translated:MC_MAP_BUSY");
});

function mapComponent(overrides) {
  const { compileScript, parse } = require("@vue/compiler-sfc");
  const { transformSync } = require("esbuild");
  const filename = path.join(root, "panel/src/map/WorldMapView.vue");
  const script = compileScript(parse(fs.readFileSync(filename, "utf8")).descriptor, { id: "map-test" });
  const mod = new Module(filename, module);
  mod.require = (id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id === "vuetify/components") return {};
    if (id === "../../../shared/map") return { MAP_LIMIT: 30_000_000 };
    return require(id);
  };
  mod._compile(transformSync(script.content, { loader: "ts", format: "cjs" }).code, filename);
  return { ...mod.exports.default, render: () => null };
}

test("map view creates one renderer on load/refresh, rejects stale world switches, validates coordinates, and disposes on unmount", async () => {
  const worlds = [
    { id: "world", name: "Test", dimension: "minecraft:overworld", spawn: { x: 8, z: 16 } },
    { id: "nether", name: "Test", dimension: "minecraft:the_nether", spawn: { x: 1, z: 2 } }
  ];
  const renderers = [], signals = [];
  const Component = mapComponent({
    "../settings": { t: (key) => key },
    "./api": { mapError: (error) => error.message, worldMapApi: () => ({ worlds: async (signal) => { signals.push(signal); return worlds; }, tile: () => {} }) },
    "./viewport": { MapViewport: class {
      constructor(canvas, world) { this.world = world; renderers.push(this); }
      dispose() { this.disposed = true; }
      center(x, z) { this.target = { x, z }; }
    } }
  });
  const renderer = vue.createRenderer({
    createElement: () => ({ children: [] }), createComment: () => ({}), createText: () => ({}),
    insert() {}, remove() {}, patchProp() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null
  });
  const app = renderer.createApp(Component, { instanceUuid: "server", daemonId: "node" });
  app.mount({ children: [] });
  const view = app._instance.setupState;
  view.canvas = {};
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renderers.length, 1);
  await view.load(true);
  assert.equal(renderers.length, 2);
  assert.equal(renderers[0].disposed, true);
  view.selected = "nether";
  view.selected = "world";
  await vue.nextTick();
  assert.equal(renderers.length, 3);
  assert.equal(renderers[2].world.id, "world");
  view.x = "3.5";
  view.go();
  assert.equal(view.error, "MC_MAP_COORDINATES");
  view.x = "-128"; view.z = "256"; view.go();
  assert.deepEqual(renderers[2].target, { x: -128, z: 256 });
  app.unmount();
  assert.equal(renderers[2].disposed, true);
  assert(signals.every((signal) => signal.aborted));
});
