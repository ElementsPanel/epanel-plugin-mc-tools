const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const vue = require("vue");
const { loader, deferred, root } = require("./helpers.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
const world = "a".repeat(24), otherWorld = "b".repeat(24);
const terrain = (id = world) => ({ id, name: "world", dimension: "minecraft:overworld", spawn: { x: 8, z: -16 } });

function component(name, overrides = {}) {
  const { compileScript, parse } = require("@vue/compiler-sfc");
  const { transformSync } = require("esbuild");
  const filename = path.join(root, "panel/src/map", name);
  const script = compileScript(parse(fs.readFileSync(filename, "utf8")).descriptor, { id: name });
  const mod = new Module(filename, module);
  mod.require = id => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id.endsWith(".vue") || id === "vuetify/components") return {};
    if (id === "@elementspanel/epanel-plugin-console/tools/vuetifyToast")
      return { notification: { error() {}, success() {}, warning() {}, info() {} } };
    if (id === "../settings") return { t: key => key };
    if (id === "../../../shared/map") return loader()("shared/map.ts");
    if (id === "../../../shared/embed") return loader()("shared/embed.ts");
    if (id === "./embed") return {
      embedPort: () => ({ addEventListener() {}, removeEventListener() {}, parent: null }),
      createEmbedBridge: (port, options) => ({ markers: vue.ref([]), menu: vue.ref([]), start() {}, stop() {}, announce() {}, publishView() {}, notifyMarker() {}, notifyMenu() {}, options })
    };
    if (id === "./page") return loader()("panel/src/map/page.ts");
    if (id === "./player-state" || id === "./player-markers") return loader({ "../settings": { t: key => key } })("panel/src/map/" + id.slice(2) + ".ts");
    return require(id);
  };
  mod._compile(transformSync(script.content, { loader: "ts", format: "cjs" }).code, filename);
  return { ...mod.exports.default, render: () => null };
}

function mount(t, Component, props = {}) {
  const renderer = vue.createRenderer({
    createElement: () => ({ children: [] }), createComment: () => ({}), createText: () => ({}),
    insert() {}, remove() {}, patchProp() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null
  });
  const app = renderer.createApp(Component, props);
  app.mount({ children: [] });
  let closed = false;
  const close = () => { if (!closed) { closed = true; app.unmount(); } };
  t.after(close);
  return { view: app._instance.setupState, close };
}

test("public map requests omit credentials, never request a login token, and forward cancellation and server errors", async t => {
  const requests = [];
  const api = loader({ "@elements-panel/sdk": { ctx: { get() { assert.fail("public map requested authentication"); }, i18n: { translate: key => key } } } })("panel/src/map/api.ts");
  const signal = new AbortController().signal;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: new URL(url, "http://localhost/"), options });
    return { ok: true, json: async () => ({ status: 200, data: [] }) };
  });
  await api.publicMapCatalog(signal);
  const map = api.publicWorldMapApi("survival");
  await map.worlds(signal, true);
  await map.tile(world, -1, 2, signal);
  await map.tile(world, -1, 2, signal, 0);
  await map.tile(world, -1, 2, signal, -64);
  await map.scene(world, -1, 2, signal, 0);
  for (const { url, options } of requests) {
    assert(url.pathname.startsWith("/api/mc-tools/map/public/"));
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.signal, signal);
    assert.equal(options.cache, "no-store");
    for (const name of ["uuid", "daemonId", "world", "token"]) assert.equal(url.searchParams.has(name), false);
  }
  assert.equal(requests[1].url.searchParams.get("map"), "survival");
  assert.equal(requests[1].url.searchParams.get("refresh"), "1");
  assert.equal(requests[2].url.searchParams.has("y"), false);
  assert.equal(requests[3].url.searchParams.has("y"), false);
  assert.equal(requests[4].url.searchParams.has("y"), false);
  assert.equal(requests[5].url.pathname, "/api/mc-tools/map/public/scene");
  assert.equal(requests[5].url.searchParams.has("y"), false);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 500, data: "MC_MAP_PAGE_DISABLED" }) });
  await assert.rejects(map.worlds(signal), /MC_MAP_PAGE_DISABLED/);
  globalThis.fetch = async () => { throw new DOMException("Cancelled", "AbortError"); };
  await assert.rejects(api.publicMapCatalog(signal), { name: "AbortError" });
});

test("map links preserve a panel subpath and legacy slice links without private identifiers, and reject malformed or out-of-range views", () => {
  const { publicMapUrl, mapPageLocation, mapSettingsUrl } = loader()("panel/src/map/page.ts");
  for (const y of [undefined, 0, -64, 2047]) {
    const source = { x: -120, z: 340, zoom: 3.5, y, world, daemonId: "private-node", uuid: "private-server" };
    const url = new URL(publicMapUrl("survival", source, "https://panel.example/sub/panel/?token=secret#/old?uuid=private"));
    assert.equal(url.pathname, "/sub/panel/");
    assert.equal(url.search, "");
    const query = Object.fromEntries(new URLSearchParams(url.hash.split("?")[1]));
    assert.deepEqual(mapPageLocation(query), { map: "survival", view: { x: -120, z: 340, zoom: 3.5,  } });
    assert(!url.href.includes("private")); assert(!url.href.includes("token"));
  }
  assert.deepEqual(mapPageLocation({ y: "0" }).view, {});
  assert.deepEqual(mapPageLocation({ y: "invalid" }).view, {});
  assert.deepEqual(mapPageLocation({}), { map: undefined, view: {} });
  // The embed flag is read by the page, never by the view parser.
  assert.deepEqual(mapPageLocation({ map: "survival", embed: "1", x: "10", z: "-20" }), { map: "survival", view: { x: 10, z: -20 } });
  for (const query of [{ map: ["survival"] }, { map: "../secret" }, { x: "1" }, { x: "1.5", z: "0" }, { x: "30000001", z: "0" },
    { zoom: "0.5" }, { zoom: "13" }, { x: "Infinity", z: "0" }, { zoom: "1e1" }]) {
    assert.throws(() => mapPageLocation(query), /MC_MAP_INVALID/);
  }
  assert.equal(mapSettingsUrl("https://panel.example/sub/?token=secret#/old"), "https://panel.example/sub/#/mc-tools/map/settings");
  const scene = new URL(publicMapUrl("survival", { x: -32, z: 64, zoom: 4, render: "3d" }, "https://panel.example/sub/"));
  assert.deepEqual(mapPageLocation(Object.fromEntries(new URLSearchParams(scene.hash.split("?")[1]))), { map: "survival", view: { x: -32, z: 64, zoom: 4, render: "3d" } });
  for (const render of [["3d"], "3D", "unknown"]) assert.throws(() => mapPageLocation({ render }), /MC_MAP_INVALID/);
});

function sceneViewer(t, options = {}) {
  const renderers = [], views = [], scene = () => {}, tile = () => {};
  const f = mount(t, component("WorldMapView.vue", {
    "./api": { mapError: error => error.message, worldMapApi: () => assert.fail("public scene used private API"),
      publicWorldMapApi: () => ({ worlds: async () => [terrain("survival")], tile, scene }) },
    "./viewport": { MapViewport: class {
      constructor(canvas, world, load, changed, loadScene) {
        Object.assign(this, { canvas, camera: { ...world.spawn, zoom: 2 }, load, changed, loadScene }); renderers.push(this);
      }
      setMode(kind) { this.kind = kind; }
      center(x, z) {
        Object.assign(this.camera, { x, z });
        this.changed({ ...this.camera, x: Math.round(x), z: Math.round(z), loading: 0, warnings: 0 });
      }
      setLayer(value) { this.layer = value; }
      dispose() { this.disposed = true; }
    } }
  }), { publicMap: "survival", initialView: { x: 48, z: -32, zoom: 3, y: 0, render: options.render }, onView: value => views.push(value) });
  f.view.canvas = {};
  return { ...f, renderers, views, scene, tile };
}

test("choosing a player switches to their world, centers fractional coordinates and updates markers", async t => {
  const renderers = [], worlds = [terrain(), { ...terrain(otherWorld), dimension: "minecraft:the_nether" }];
  const player = { name: "Alex", position: { x: -163.5, y: 70, z: -92.25, world: otherWorld, dimension: "minecraft:the_nether", yaw: 90 } };
  const f = mount(t, component("WorldMapView.vue", {
    "./api": { mapError: error => error.message, worldMapApi: () => ({ worlds: async () => worlds, tile() {},
      players: async () => ({ edition: "java", running: true, rconEnabled: true, players: [player], warnings: [] }) }) },
    "./viewport": { MapViewport: class {
      constructor(_canvas, world, _tile, changed) { this.camera = { ...world.spawn, zoom: 2 }; this.world = world.id; this.changed = changed; renderers.push(this); }
      setMode() {} setLayer(y) { this.layer = y; } dispose() { this.disposed = true; }
      project(point) { return { x: point.x - this.camera.x + 400, y: point.z - this.camera.z + 300 }; }
      center(x, z) { Object.assign(this.camera, { x, z }); this.changed(this.camera); }
    } }
  }), { instanceUuid: "server", daemonId: "node", initialView: { y: 0 } });
  f.view.canvas = {}; await tick(); assert.deepEqual(f.view.markers, []);
  f.view.locatePlayer(player); await tick();
  const current = renderers.at(-1);
  assert.equal(current.world, otherWorld); assert.equal(renderers[0].disposed, true);
  assert.equal(current.camera.x, -163.5); assert.equal(current.camera.z, -92.25);
  assert.equal(f.view.height, undefined); assert.equal(f.view.markers[0].x, 400); assert.equal(f.view.markers[0].y, 300);
  current.center(-150, -80); assert.equal(f.view.markers[0].x, 386.5);
});

test("shared views pass both map APIs to one persistent viewport and retain surface coordinates and zoom across projection switches", async t => {
  const f = sceneViewer(t, { render: "3d" }); await tick();
  const active = f.renderers[0];
  assert.equal(active.kind, "3d"); assert.equal(active.load, f.tile); assert.equal(active.loadScene, f.scene);
  assert.equal(active.layer, undefined); assert.deepEqual(active.camera, { x: 48, z: -32, zoom: 3 });
  active.camera.zoom = 5; active.center(80.375, -96.125);
  for (const kind of ["2d", "3d", "2d", "3d"]) {
    f.view.renderMode = kind; await tick();
    assert.equal(f.renderers.length, 1); assert.equal(active.disposed, undefined); assert.equal(active.kind, kind);
    assert.deepEqual(active.camera, { x: 80.375, z: -96.125, zoom: 5 });
  }
  await f.view.load(true); await tick();
  const refreshed = f.renderers.at(-1);
  assert.equal(f.renderers.length, 2); assert.equal(active.disposed, true);
  assert.equal(refreshed.kind, "3d"); assert.equal(refreshed.layer, undefined);
  assert.deepEqual(f.views.at(-1), { x: 80, z: -96, zoom: 5, render: "3d" });
  f.close(); assert(f.renderers.every(renderer => renderer.disposed));
});

test("WebGL failure returns the existing viewport to 2D without recreating its map or losing the view", async t => {
  const f = sceneViewer(t, { render: "3d" }); await tick();
  const active = f.renderers[0];
  active.camera.zoom = 4; active.center(80.375, -96.125);
  active.changed({ x: 80, z: -96, zoom: 4, loading: 0, warnings: 0, error: new Error("MC_MAP_WEBGL_UNAVAILABLE") });
  await tick();
  assert.equal(f.renderers.length, 1); assert.equal(active.disposed, undefined);
  assert.equal(f.view.renderMode, "2d"); assert.equal(active.kind, "2d");
  assert.equal(f.view.error, "MC_MAP_WEBGL_UNAVAILABLE"); assert.equal(active.layer, undefined);
  assert.deepEqual(active.camera, { x: 80.375, z: -96.125, zoom: 4 });
});

test("standalone maps register an anonymous immersive route and an administrator-only settings route", () => {
  const routes = [];
  const plugin = loader()("panel/src/frontend.ts");
  plugin.apply({ i18n: { define() {} }, routes: { add: route => routes.push(route) }, actions: { instances: [], instance() {} } });
  assert(plugin.inject.includes("routes"));
  assert.deepEqual(routes.find(route => route.path === "/mc-tools/map").meta, { public: true, immersive: true, mainMenu: false });
  const settings = routes.find(route => route.path === "/mc-tools/map/settings");
  assert.equal(settings.meta.public, undefined); assert.equal(settings.meta.permission, 10);
});

test("the public map viewer restores shared position and zoom while ignoring legacy Y=0, emits updated views, and never uses private APIs", async t => {
  const renderers = [], views = [], signals = [];
  const Component = component("WorldMapView.vue", {
    "./api": {
      mapError: reason => reason.message, worldMapApi: () => assert.fail("public viewer used a private API"),
      publicWorldMapApi: id => { assert.equal(id, "survival"); return { worlds: async signal => { signals.push(signal); return [terrain("survival")]; }, tile() {} }; }
    },
    "./viewport": { MapViewport: class {
      constructor(canvas, world, tile, changed, layer) { this.camera = { ...world.spawn, zoom: 2 }; this.changed = changed; this.layer = layer; renderers.push(this); }
      center(x, z) { Object.assign(this.camera, { x, z }); this.changed(this.camera); }
      setMode() {}
      setLayer(y) { this.layer = y; }
      dispose() { this.disposed = true; }
    } }
  });
  const f = mount(t, Component, { publicMap: "survival", initialView: { x: -128, z: 256, y: 0, zoom: 4 }, onView: value => views.push(value) });
  f.view.canvas = {};
  await tick();
  assert.equal(renderers.length, 1); assert.equal(renderers[0].layer, undefined);
  assert.deepEqual(renderers[0].camera, { x: -128, z: 256, zoom: 4 });
  assert.equal(f.view.mode, undefined); assert.equal(f.view.y, undefined);
  assert.deepEqual(views.at(-1), { x: -128, z: 256, zoom: 4 });
  f.close(); assert(signals.every(signal => signal.aborted)); assert.equal(renderers[0].disposed, true);
});

test("the public page handles disabled and unknown maps and rejects stale catalogues during route changes and unmount", async t => {
  const reads = [], replacements = [];
  const route = vue.reactive({ fullPath: "/mc-tools/map?map=old", query: { map: "old" } });
  const f = mount(t, component("WorldMapPage.vue", {
    "vue-router": { useRoute: () => route, useRouter: () => ({ replace: value => replacements.push(value) }) },
    "./api": { mapError: reason => reason.message, publicMapCatalog: signal => { const gate = deferred(); reads.push({ ...gate, signal }); return gate.promise; } }
  }));
  route.query = { map: "survival", x: "10", z: "-20", y: "0", zoom: "3" }; route.fullPath = "/mc-tools/map?map=survival";
  await vue.nextTick(); assert.equal(reads[0].signal.aborted, true);
  reads[1].resolve({ enabled: true, maps: [{ id: "survival", name: "Survival" }] }); await tick();
  reads[0].resolve({ enabled: true, maps: [{ id: "old", name: "Old" }] }); await tick();
  assert.equal(f.view.selected, "survival");
  assert.deepEqual(f.view.initialView, { x: 10, z: -20, zoom: 3 });
  f.view.choose("another"); assert.deepEqual(replacements, [{ path: "/mc-tools/map", query: { map: "another" } }]);
  const pending = f.view.load(); reads[2].resolve({ enabled: false, maps: [] }); await pending;
  assert.equal(f.view.error, "MC_MAP_PAGE_DISABLED"); assert.equal(f.view.selected, "");
  const unknown = f.view.load(); reads[3].resolve({ enabled: true, maps: [{ id: "different", name: "Different" }] }); await unknown;
  assert.equal(f.view.error, "MC_MAP_PUBLIC_NOT_FOUND");
  const closing = f.view.load(); f.close(); assert.equal(reads[4].signal.aborted, true);
  reads[4].resolve({ enabled: true, maps: [{ id: "survival", name: "Survival" }] }); await closing;
  assert.equal(f.view.selected, "");
});

test("map settings requests authenticate once, paginate instance searches, and save configuration with PUT", async t => {
  let authentications = 0;
  const requests = [];
  const api = loader({ "@elements-panel/sdk": { ctx: { i18n: { translate: key => key }, get: () => ({ api: { userInfoApi: () => ({ execute: async () => { authentications++; return { value: { token: "token" } }; } }) } }) } } })("panel/src/map/api.ts").mapSettingsApi();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: new URL(url, "http://localhost"), options });
    return { ok: true, json: async () => ({ status: 200, data: {} }) };
  });
  const signal = new AbortController().signal;
  await Promise.all([api.read(signal), api.nodes(signal)]);
  await api.instances("node", 2, "Test & world", "server", signal);
  await api.worlds("node", "server", signal);
  const settings = { mapPageEnabled: true, publicMaps: [{ id: "survival", name: "Survival", source: `node/server/${world}` }] };
  await api.save(settings, signal);
  assert.equal(authentications, 1);
  assert.equal(requests[2].url.searchParams.get("search"), "Test & world");
  assert.equal(requests[2].url.searchParams.get("page"), "2");
  assert.equal(requests[3].url.searchParams.get("uuid"), "server");
  assert.equal(requests[4].options.method, "PUT");
  assert.deepEqual(JSON.parse(requests[4].options.body), settings);
  for (const { options } of requests) { assert.equal(options.signal, signal); assert.equal(options.headers.Authorization, "Bearer token"); }
});

function settingsFixture(t, overrides = {}) {
  const writes = [], queries = [], signals = [];
  const api = {
    read: async () => ({ mapPageEnabled: false, publicMaps: [] }),
    nodes: async () => [{ id: "node", name: "Main node", available: true }, { id: "other", name: "Other node", available: true }],
    instances: async (node, page, search, selected, signal) => { queries.push({ node, page, search, selected }); signals.push(signal); return { page, maxPage: 2, data: [{ id: "server", name: "Survival" }] }; },
    worlds: async (node, server, signal) => { signals.push(signal); return [terrain()]; },
    save: async (values, signal) => { signals.push(signal); writes.push(values); return { ...values, publicMaps: values.publicMaps.map(map => ({ ...map, id: map.id || "generated" })) }; },
    ...overrides
  };
  const { useMapSettings } = loader({ "./api": { mapSettingsApi: () => api, mapError: reason => reason.message }, "../settings": { t: key => key } })("panel/src/map/useMapSettings.ts");
  return { ...mount(t, { setup: useMapSettings, render: () => null }), writes, queries, signals };
}

test("the settings editor selects a specific instance and dimension, stages changes, and publishes only on successful save", async t => {
  const f = settingsFixture(t); await tick();
  f.view.edit(); f.view.selectNode("node"); await tick();
  f.view.selectInstance("server"); await tick();
  f.view.selectWorld(world);
  assert(f.view.draft.name.includes("Survival")); assert.equal(f.view.canApply, true);
  f.view.apply();
  assert.equal(f.writes.length, 0); assert.equal(f.view.dirty, true);
  assert.equal(f.view.settings.publicMaps[0].source, `node/server/${world}`);
  f.view.settings.mapPageEnabled = true;
  await f.view.save();
  assert.equal(f.writes.length, 1); assert.equal(f.view.dirty, false); assert.equal(f.view.saved, true);
  assert.equal(f.view.settings.publicMaps[0].id, "generated");
  f.view.edit(0); await tick();
  assert.equal(f.view.draft.daemonId, "node"); assert.equal(f.view.draft.instanceUuid, "server");
  f.view.draft.name = "Updated name"; f.view.apply();
  assert.equal(f.view.saved, false); assert.equal(f.view.settings.publicMaps[0].id, "generated");
  f.view.remove(0); await f.view.save();
  assert.deepEqual(f.writes.at(-1).publicMaps, []);
  f.close(); assert(f.signals.every(signal => signal.aborted));
});

test("changing the selected instance cancels old world reads and cannot publish a stale world, while failed saves retain drafts", async t => {
  const reads = [];
  const f = settingsFixture(t, {
    worlds: (node, server, signal) => { const gate = deferred(); reads.push({ ...gate, node, server, signal }); return gate.promise; },
    save: async () => { throw new Error("MC_MAP_NODE_OFFLINE"); }
  });
  await tick(); f.view.edit(); f.view.selectNode("node"); await tick();
  f.view.selectInstance("first"); f.view.selectInstance("second");
  assert.equal(reads[0].signal.aborted, true); assert.equal(f.view.draft.world, ""); assert.equal(f.view.canApply, false);
  reads[1].resolve([terrain(otherWorld)]); await tick();
  reads[0].resolve([terrain(world)]); await tick();
  assert.deepEqual(f.view.worlds.map(world => world.id), [otherWorld]);
  f.view.selectWorld(otherWorld); f.view.draft.name = "Second server"; f.view.apply();
  assert.equal(f.view.settings.publicMaps[0].source, `node/second/${otherWorld}`);
  await f.view.save();
  assert.equal(f.view.error, "MC_MAP_NODE_OFFLINE"); assert.equal(f.view.saved, false); assert.equal(f.view.dirty, true);
  f.view.edit(0); await tick(); f.view.selectNode("other");
  assert.equal(f.view.draft.instanceUuid, ""); assert.equal(f.view.draft.world, "");
  assert.equal(reads[2].signal.aborted, true);
  f.view.dialog = false; f.close();
  reads[2].resolve([terrain()]); await tick();
  assert.deepEqual(f.view.worlds, []);
});
