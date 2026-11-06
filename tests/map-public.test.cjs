const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loader, deferred } = require("./helpers.cjs");

const load = loader();
const world = "a".repeat(24), hiddenWorld = "b".repeat(24);
const entry = () => ({ id: "survival", name: "Survival", source: `node/server/${world}` });

async function configuration(stored = null) {
  let declaration, saved = stored, failure;
  const writes = [];
  const ctx = {
    i18n: { $t: key => key },
    storage: { getStorage: () => ({
      load: async () => saved,
      store: async (category, id, value) => { if (failure) throw failure; writes.push({ category, id, value }); saved = structuredClone(value); }
    }) },
    settingsForm: { declare(value) { declaration = value; } }
  };
  const settings = await load("panel/src/backend/settings.ts").registerMapSettings(ctx);
  return { ...settings, declaration, writes, ctx, fail: () => { failure = new Error("disk full"); } };
}

test("public map configuration defaults closed, declares the plugin form, persists an explicit allowlist, and applies only successful saves", async () => {
  const f = await configuration();
  assert.deepEqual(f.read(), { mapPageEnabled: false, publicMaps: [] });
  assert.equal(f.writes.length, 0);
  const fields = f.declaration.fields();
  assert.equal(fields.find(field => field.key === "mapPageEnabled").type, "boolean");
  assert(fields.some(field => field.type === "link" && field.route === "/mc-tools/map/settings"));
  assert(fields.some(field => field.type === "link" && field.route === "/mc-tools/map"));
  await f.write({ mapPageEnabled: true, publicMaps: [{ ...entry(), id: "" }] });
  const saved = f.read();
  assert.equal(saved.mapPageEnabled, true);
  assert.match(saved.publicMaps[0].id, /^[a-f0-9]{32}$/);
  assert.equal(f.writes[0].category, "McToolsSettings");
  const restored = await load("panel/src/backend/settings.ts").registerMapSettings(f.ctx);
  assert.deepEqual(restored.read(), saved);
  assert.deepEqual(f.declaration.read(), { mapPageEnabled: true });
  await assert.rejects(f.declaration.write({ publicMaps: [] }), /MC_MAP_PAGE_SETTINGS_INVALID/);
  saved.publicMaps[0].source = `other/server/${hiddenWorld}`;
  assert.equal(f.read().publicMaps[0].source, entry().source);
  f.fail();
  await assert.rejects(f.declaration.write({ mapPageEnabled: false }), /disk full/);
  assert.equal(f.read().mapPageEnabled, true);
});

test("public map settings reject malformed sources, duplicate aliases and invalid values without modifying the active allowlist", async () => {
  const f = await configuration({ mapPageEnabled: true, publicMaps: [entry()] });
  const invalid = [
    null, [], { mapPageEnabled: "false" }, { mapPageEnabled: null }, { other: true },
    { publicMaps: null }, { publicMaps: Array(33).fill(entry()) }, { publicMaps: [entry(), entry()] },
    ...["../outside", `node/server/${hiddenWorld}/extra`, `node/server/../${world}`, "", "/etc/passwd"].map(source => ({ publicMaps: [{ ...entry(), source }] })),
    ...["../map", "with space", "-map", "x".repeat(65)].map(id => ({ publicMaps: [{ ...entry(), id }] })),
    ...[" ", "line\nbreak", "x".repeat(101)].map(name => ({ publicMaps: [{ ...entry(), name }] }))
  ];
  for (const values of invalid) await assert.rejects(f.write(values), /MC_MAP_PAGE_SETTINGS_INVALID/);
  assert.deepEqual(f.read(), { mapPageEnabled: true, publicMaps: [entry()] });
  assert.equal(f.writes.length, 0);
  await f.declaration.write({ mapPageEnabled: false });
  assert.deepEqual(f.read(), { mapPageEnabled: false, publicMaps: [entry()] });
  const damaged = await configuration({ mapPageEnabled: true, publicMaps: [{ ...entry(), source: "../outside" }] });
  assert.deepEqual(damaged.read(), { mapPageEnabled: false, publicMaps: [] });
});

function routesFixture() {
  const routes = new Map(), calls = [], checks = [];
  let config = { mapPageEnabled: false, publicMaps: [entry()] };
  let respond = async event => event.endsWith("worlds") ? [
    { id: world, name: "Private server name", dimension: "minecraft:overworld", spawn: { x: 8, z: -16, private: "secret" }, root: "/private/save" },
    { id: hiddenWorld, name: "Unlisted world", dimension: "minecraft:the_nether", spawn: { x: 0, z: 0 } }
  ] : { image: "png", chunks: 1, warnings: 0, path: "/private/save" };
  const ctx = {
    koa: { router(prefix) { assert.equal(prefix, "/api/mc-tools/map/public"); return { get(route, ...handlers) { routes.set(route, handlers); } }; } },
    roles: { USER: 1 }, identity: { of: request => ({ elevated: request.admin }) },
    middleware: {
      permission: () => async (request, next) => { checks.push("permission"); if (!request.logged) { request.status = 403; return; } await next(); },
      validator: () => async (request, next) => { checks.push("validate"); await next(); },
      instanceAccess: async (request, next) => { checks.push("instance"); if (request.denied) { request.status = 403; return; } await next(); }
    },
    remote: {
      services: { getInstance(id) { assert.equal(id, "node"); return { available: true }; } },
      Request: class { async request(event, data) { calls.push({ event, data }); return respond(event, data); } }
    }
  };
  load("panel/src/backend/public-map.ts").registerPublicMapRoutes(ctx, () => structuredClone(config));
  return {
    calls, checks,
    configure(values) { config = { ...config, ...values }; },
    respond(value) { respond = value; },
    async request(route, query = {}, extra = {}) {
      const request = { query, headers: {}, set(name, value) { this.headers[name] = value; }, ...extra };
      const handlers = routes.get(route);
      const run = index => handlers[index]?.(request, () => run(index + 1));
      await run(0);
      assert.equal(request.headers["Cache-Control"], "no-store");
      return request;
    }
  };
}

test("public player reads are scoped to the published world and aliases, and revocation during a read hides results", async () => {
  const f = routesFixture(); f.configure({ mapPageEnabled: true });
  f.respond(async () => ({ edition: "java", running: true, rconEnabled: true, warnings: [], players: [
    { name: "Steve", position: { x: 1, y: 64, z: 2, world, dimension: "minecraft:overworld" } },
    { name: "Alex", position: { x: 5, y: 64, z: 6, world: hiddenWorld, dimension: "minecraft:the_nether" } }, { name: "Unknown" }
  ] }));
  const result = (await f.request("/players", { map: "survival", uuid: "injected", world: hiddenWorld, daemonId: "injected" })).body;
  assert.deepEqual(result.players.map(player => player.name), ["Steve"]);
  assert.equal(result.players[0].position.world, "survival");
  assert.deepEqual(f.calls[0], { event: "mc-tools/map/players", data: { instanceUuid: "server", world } });
  const gate = deferred(); f.respond(() => gate.promise);
  const read = f.request("/players", { map: "survival" });
  f.configure({ mapPageEnabled: false }); gate.resolve(result);
  assert.equal((await read).body.message, "MC_MAP_PAGE_DISABLED");
});

test("anonymous map routes reveal only configured aliases and use the configured instance and dimension regardless of injected parameters", async () => {
  const f = routesFixture();
  assert.deepEqual((await f.request("/maps")).body, { enabled: false, maps: [] });
  assert.equal((await f.request("/worlds", { map: "survival" })).body.message, "MC_MAP_PAGE_DISABLED");
  assert.equal(f.calls.length, 0);
  f.configure({ mapPageEnabled: true });
  assert.deepEqual((await f.request("/maps")).body, { enabled: true, maps: [{ id: "survival", name: "Survival" }] });
  const injected = { map: "survival", daemonId: "other", uuid: "other", world: hiddenWorld, path: "/etc/passwd" };
  assert.deepEqual((await f.request("/worlds", injected)).body, [
    { id: "survival", name: "Survival", dimension: "minecraft:overworld", spawn: { x: 8, z: -16 } }
  ]);
  assert.deepEqual(f.calls[0], { event: "mc-tools/map/worlds", data: { instanceUuid: "server" } });
  assert.deepEqual((await f.request("/tile", { ...injected, x: "-1", z: "2", y: "0" })).body, { image: "png", chunks: 1, warnings: 0 });
  assert.deepEqual(f.calls[1], { event: "mc-tools/map/tile", data: { instanceUuid: "server", world, x: -1, z: 2, y: 0 } });
  assert.equal(f.checks.length, 0);
  for (const map of [world, hiddenWorld, "unlisted"]) assert.equal((await f.request("/worlds", { map })).body.message, "MC_MAP_PUBLIC_NOT_FOUND");
  for (const query of [{ map: ["survival"] }, { map: "../outside" }, { map: "survival", x: "1.5", z: "0" }, { map: "survival", x: "0", z: "0", y: "2048" }, { map: "survival", x: "0", z: ["0"] }]) {
    assert.equal((await f.request("/tile", query)).body.message, "MC_MAP_INVALID");
  }
  assert.equal(f.calls.length, 2);
});

test("private link lookups retain login and instance permission checks, and expose configuration controls only to administrators", async () => {
  const f = routesFixture();
  f.configure({ mapPageEnabled: true });
  const query = { uuid: "server", daemonId: "node" };
  assert.equal((await f.request("/links", query)).status, 403);
  assert.equal((await f.request("/links", query, { logged: true, denied: true })).status, 403);
  assert.deepEqual((await f.request("/links", query, { logged: true, admin: false })).body, {
    enabled: true, canConfigure: false, maps: [{ id: "survival", name: "Survival", world }]
  });
  assert.equal((await f.request("/links", query, { logged: true, admin: true })).body.canConfigure, true);
  assert.deepEqual((await f.request("/links", { ...query, uuid: "other" }, { logged: true })).body.maps, []);
  assert.equal(f.calls.length, 0);
});

test("anonymous 3D scenes use only the configured save, validate scene coordinates and discard revoked in-flight geometry", async () => {
  const f = routesFixture();
  assert.equal((await f.request("/scene", { map: "survival", x: "0", z: "0" })).body.message, "MC_MAP_PAGE_DISABLED");
  f.configure({ mapPageEnabled: true });
  const scene = { version: 1, quads: "mesh", heights: "height", chunks: 4, warnings: 0, limited: false };
  f.respond(async () => ({ ...scene, root: "/private/save", world: hiddenWorld }));
  assert.deepEqual((await f.request("/scene", { map: "survival", x: "-937500", z: "0", y: "0", world: hiddenWorld, uuid: "other", daemonId: "other" })).body, scene);
  assert.deepEqual(f.calls.at(-1), { event: "mc-tools/map/scene", data: { instanceUuid: "server", world, x: -937500, z: 0, y: 0 } });
  assert.equal(f.checks.length, 0);
  assert.equal((await f.request("/scene", { map: "unlisted", x: "0", z: "0" })).body.message, "MC_MAP_PUBLIC_NOT_FOUND");
  for (const query of [{ x: "937501", z: "0" }, { x: "0", z: "0", y: "2048" }, { x: ["0"], z: "0" }]) {
    assert.equal((await f.request("/scene", { map: "survival", ...query })).body.message, "MC_MAP_INVALID");
  }
  assert.equal(f.calls.length, 1);
  const gate = deferred(); f.respond(() => gate.promise);
  const pending = f.request("/scene", { map: "survival", x: "0", z: "0" });
  await new Promise(resolve => setImmediate(resolve));
  f.configure({ publicMaps: [] }); gate.resolve(scene);
  assert.equal((await pending).body.message, "MC_MAP_PUBLIC_NOT_FOUND");
});

test("the host form and instance map editor serialize writes without overwriting each other's fields", async () => {
  const f = await configuration({ mapPageEnabled: true, publicMaps: [entry()] });
  const gate = deferred();
  const first = f.write({ publicMaps: [{ ...entry(), name: "New name" }] }, () => gate.promise);
  const second = f.declaration.write({ mapPageEnabled: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.length, 0);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.read(), { mapPageEnabled: false, publicMaps: [{ ...entry(), name: "New name" }] });
  assert.equal(f.writes.length, 2);
});

async function editorFixture(stored = null) {
  const settings = await configuration(stored);
  const routes = new Map(), calls = [];
  let administrator = true;
  const nodes = new Map([
    ["node", { available: true, config: { remarks: "Main node", apiKey: "secret" } }],
    ["offline", { available: false, config: { remarks: "Offline", apiKey: "secret" } }]
  ]);
  let respond = async (event) => {
    if (event === "instance/select") return { maxPage: 2, data: [
      { instanceUuid: "server", config: { nickname: "Survival", type: "minecraft/java", startCommand: "private" } },
      { instanceUuid: "bedrock", config: { nickname: "Bedrock", type: "minecraft/bedrock" } },
      { instanceUuid: "steam", config: { nickname: "Steam", type: "steam/universal" } },
      { instanceUuid: "proxy", config: { type: "minecraft/java/velocity" } },
      { instanceUuid: "global0001", config: { type: "minecraft/java" } }
    ] };
    if (event === "instance/section") return [{ instanceUuid: "other", config: { nickname: "Another server", type: "minecraft/java/paper" } }];
    return [{ id: world, name: "world", dimension: "minecraft:overworld", spawn: { x: 0, z: 0 } }];
  };
  const ctx = {
    koa: { router(prefix) {
      assert.equal(prefix, "/api/mc-tools/map/config");
      return Object.fromEntries(["get", "put"].map(method => [method, (path, ...handlers) => routes.set(method + path, handlers)]));
    } },
    roles: { USER: 1, ADMIN: 10 },
    identity: { of: request => ({ elevated: request.admin && administrator }) },
    middleware: { permission: ({ level }) => { assert.equal(level, 10); return async (request, next) => {
      if (!request.logged || !request.admin) { request.status = 403; return; } await next();
    }; } },
    remote: { services: { services: nodes, getInstance: id => nodes.get(id) }, Request: class {
      async request(event, data) { calls.push({ event, data }); return respond(event, data); }
    } }
  };
  load("panel/src/backend/map-settings.ts").registerMapEditorRoutes(ctx, settings);
  return { settings, calls, nodes, revoke: () => { administrator = false; }, respond: value => { respond = value; }, async request(method, path, query = {}, body, extra = { logged: true, admin: true }) {
    const request = { ...extra, query, request: { body }, set() {} };
    const handlers = routes.get(method + path);
    const run = index => handlers[index]?.(request, () => run(index + 1));
    await run(0); return request;
  } };
}

test("instance map configuration APIs require an administrator and list only sanitized node and Minecraft instance choices", async () => {
  const f = await editorFixture();
  for (const access of [{}, { logged: true, admin: false }]) {
    for (const [method, path] of [["get", "/settings"], ["get", "/nodes"], ["get", "/instances"], ["put", "/settings"]]) {
      assert.equal((await f.request(method, path, {}, {}, access)).status, 403);
    }
  }
  assert.equal(f.calls.length, 0); assert.equal(f.settings.writes.length, 0);
  assert.deepEqual((await f.request("get", "/nodes")).body, [
    { id: "node", name: "Main node", available: true }, { id: "offline", name: "Offline", available: false }
  ]);
  const result = (await f.request("get", "/instances", { daemonId: "node", page: "2", search: " Test ", selected: "other" })).body;
  assert.deepEqual(result, { page: 2, maxPage: 2, data: [{ id: "server", name: "Survival" }, { id: "bedrock", name: "Bedrock" }], selected: { id: "other", name: "Another server" } });
  assert.deepEqual(f.calls[0], { event: "instance/select", data: { page: 2, pageSize: 50, condition: { instanceName: "Test" } } });
  assert.deepEqual(f.calls[1], { event: "instance/section", data: { instanceUuids: ["other"] } });
  for (const query of [{ daemonId: ["node"] }, { daemonId: "node", page: "0" }, { daemonId: "node", page: "10001" }, { daemonId: "node", search: ["Test"] }, { daemonId: "node", selected: "../world" }]) {
    assert.equal((await f.request("get", "/instances", query)).body.message, "MC_MAP_INVALID");
  }
  assert.equal(f.calls.length, 2);
});

test("saving instance maps verifies new sources, preserves settings on failure, and allows removing maps while their node is offline", async () => {
  const f = await editorFixture();
  let result = await f.request("put", "/settings", {}, { mapPageEnabled: true, publicMaps: [{ ...entry(), source: `node/server/${hiddenWorld}` }] });
  assert.equal(result.body.message, "MC_MAP_WORLD_MISSING");
  assert.deepEqual(f.settings.read(), { mapPageEnabled: false, publicMaps: [] });
  result = await f.request("put", "/settings", {}, { mapPageEnabled: true, publicMaps: [entry()] });
  assert.deepEqual(result.body, { mapPageEnabled: true, publicMaps: [entry()] });
  assert.deepEqual(f.calls.at(-1), { event: "mc-tools/map/worlds", data: { instanceUuid: "server" } });
  f.nodes.get("node").available = false;
  const calls = f.calls.length;
  result = await f.request("put", "/settings", {}, { publicMaps: [{ ...entry(), name: "Renamed" }] });
  assert.equal(result.body.publicMaps[0].name, "Renamed");
  result = await f.request("put", "/settings", {}, { publicMaps: [] });
  assert.deepEqual(result.body, { mapPageEnabled: true, publicMaps: [] });
  assert.equal(f.calls.length, calls);
});

test("instance map configuration rechecks administrator access after asynchronous source validation", async () => {
  const f = await editorFixture(), gate = deferred();
  f.respond(() => gate.promise);
  const result = f.request("put", "/settings", {}, { publicMaps: [entry()] });
  await new Promise(resolve => setImmediate(resolve));
  f.revoke(); gate.resolve([{ id: world }]);
  assert.equal((await result).body.message, "MC_MAP_SETTINGS_FORBIDDEN");
  assert.equal(f.settings.read().publicMaps.length, 0);
});

test("disabling, removing, or retargeting a map revokes in-flight public responses and remote errors never disclose private paths", async () => {
  for (const change of [
    { mapPageEnabled: false }, { publicMaps: [] }, { publicMaps: [{ ...entry(), source: `node/server/${hiddenWorld}` }] }
  ]) {
    const f = routesFixture(), gate = deferred();
    f.configure({ mapPageEnabled: true }); f.respond(() => gate.promise);
    const response = f.request("/tile", { map: "survival", x: "0", z: "0" });
    await new Promise(resolve => setImmediate(resolve));
    f.configure(change);
    gate.resolve({ image: "secret", chunks: 1, warnings: 0 });
    assert.match((await response).body.message, /MC_MAP_PAGE_DISABLED|MC_MAP_PUBLIC_NOT_FOUND/);
  }
  const f = routesFixture(); f.configure({ mapPageEnabled: true });
  f.respond(async () => { throw new Error("ENOENT /home/private/save/level.dat"); });
  assert.equal((await f.request("/worlds", { map: "survival" })).body.message, "MC_MAP_READ_FAILED");
});

test("public refreshes can reload saved changes but snapshot invalidation is limited per instance", async t => {
  const f = routesFixture();
  f.configure({ mapPageEnabled: true, publicMaps: [entry(), { ...entry(), id: "another" }] });
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  for (const map of ["survival", "survival", "another"]) await f.request("/worlds", { map, refresh: "1" });
  assert.equal(f.calls[0].data.refresh, true);
  assert.equal(f.calls[1].data.refresh, undefined);
  assert.equal(f.calls[2].data.refresh, undefined);
  now += 30_000;
  await f.request("/worlds", { map: "survival", refresh: "1" });
  assert.equal(f.calls[3].data.refresh, true);
});
