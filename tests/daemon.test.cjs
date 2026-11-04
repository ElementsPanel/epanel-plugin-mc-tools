const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loader, deferred } = require("./helpers.cjs");

const status = { online: true, current_players: 3, max_players: 20, version: "1.21", latency: 12 };

function instance(type = "minecraft/java", port = 25565) {
  const presets = new Map();
  const value = {
    config: { type, pingConfig: { port } },
    info: {},
    resetPingInfo() { Object.assign(this.info, { mcPingOnline: false, currentPlayers: 0, maxPlayers: 0, version: "", latency: 0 }); },
    status: () => 3,
    getPreset: (name) => presets.get(name),
    setPreset: (name, command) => presets.set(name, command),
    execPreset: async (name) => presets.get(name).exec(value),
    lifeCycleTaskManager: { lifeCycleTask: [], registerLifeCycleTask(task) { this.lifeCycleTask.push(task); } }
  };
  return value;
}

function fixture(existing = []) {
  const effects = [], disposals = [], timers = new Set(), features = new Set(), presets = new Map(), factories = [];
  const ctx = {
    scope: { isActive: true },
    instances: { Command: class { constructor(name) { this.name = name; } }, Instance: { STATUS_RUNNING: 3 }, subsystem: { getInstances: () => existing } },
    features: { add(name) { features.add(name); effects.push(() => features.delete(name)); } },
    protocol: { on() { effects.push(() => {}); }, response() {}, responseError() {} },
    presets: { entries: () => presets, register(name, factory) { assert(!presets.has(name)); presets.set(name, factory); effects.push(() => presets.delete(name)); } },
    instanceLifecycle: { register(factory) { factories.push(factory); effects.push(() => factories.splice(factories.indexOf(factory), 1)); } },
    setInterval(callback, delay) {
      assert.equal(delay, 60_000);
      timers.add(callback);
      return () => timers.delete(callback);
    },
    on(event, callback) { assert.equal(event, "dispose"); disposals.push(callback); }
  };
  let respond = async () => status;
  const requests = [];
  const load = loader({
    "./mcping": class { constructor(port, host) { this.target = { port, host }; } getStatus() { requests.push({ type: "java", ...this.target }); return respond(); } },
    "./bedrock": { requestBedrockStatus(host, port) { requests.push({ type: "bedrock", port, host }); return respond(); } }
  });
  return {
    ctx, features, presets, factories, timers, requests, load,
    respond: (callback) => { respond = callback; },
    async dispose() { ctx.scope.isActive = false; for (const callback of disposals) await callback(); for (const callback of effects.reverse()) callback(); }
  };
}

test("status command queries Java, proxies and Bedrock on their configured node address", async () => {
  const f = fixture();
  const { createMinecraftStatusCommandClass } = f.load("daemon/src/backend/mcstats.ts");
  const Command = createMinecraftStatusCommandClass(f.ctx);
  for (const type of ["minecraft/java", "minecraft/java/bungeecord", "minecraft/bedrock"]) {
    const value = instance(type, 12345);
    value.config.pingConfig.ip = "game.internal";
    assert.equal(await new Command().exec(value), status);
    assert.deepEqual(value.info, { mcPingOnline: true, currentPlayers: 3, maxPlayers: 20, version: "1.21", latency: 12 });
    assert.deepEqual(f.requests.at(-1), { type: type.includes("bedrock") ? "bedrock" : "java", host: "game.internal", port: 12345 });
  }
});

test("failed and disabled queries clear stale counts and other game types are ignored", async () => {
  const f = fixture();
  const Command = f.load("daemon/src/backend/mcstats.ts").createMinecraftStatusCommandClass(f.ctx);
  const value = instance();
  const command = new Command();
  await command.exec(value);
  f.respond(async () => { throw new Error("Offline"); });
  assert.equal(await command.exec(value), null);
  assert.equal(value.info.mcPingOnline, false);
  assert.equal(value.info.currentPlayers, 0);
  const count = f.requests.length;
  for (const port of [0, -1, 65536, 1.5]) await command.exec(instance("minecraft/java", port));
  await command.exec(instance("steam/universal"));
  assert.equal(f.requests.length, count);
});

test("stopping, reconfiguring or unloading during a query cannot restore stale player counts", async () => {
  for (const scenario of ["stop", "config", "unload"]) {
    const f = fixture();
    const pending = deferred();
    f.respond(() => pending.promise);
    const Command = f.load("daemon/src/backend/mcstats.ts").createMinecraftStatusCommandClass(f.ctx);
    const command = new Command();
    const value = instance();
    const query = command.exec(value);
    if (scenario === "stop") await command.stop(value);
    if (scenario === "config") value.config.pingConfig.port = 25566;
    if (scenario === "unload") await f.dispose();
    pending.resolve(status);
    assert.equal(await query, null);
    assert.notEqual(value.info.mcPingOnline, true);
  }
});

test("plugin attaches restored instances, polls once a minute, and removes all contributions on unload", async () => {
  const value = instance();
  const other = instance("steam/universal");
  const f = fixture([value, other]);
  f.load("daemon/src/backend/index.ts").apply(f.ctx);
  await Promise.resolve();
  assert(f.features.has("mcstats"));
  assert(f.features.has("mcWorldMap"));
  assert(f.presets.has("refreshPlayers"));
  assert.equal(f.factories.length, 1);
  assert.equal(f.factories[0](other), undefined);
  assert.equal(other.lifeCycleTaskManager.lifeCycleTask.length, 0);
  assert.equal(value.lifeCycleTaskManager.lifeCycleTask.length, 1);
  assert.equal(f.timers.size, 1);
  for (const tick of f.timers) tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.info.currentPlayers, 3);
  const task = value.lifeCycleTaskManager.lifeCycleTask[0];
  await task.start(value);
  assert.equal(f.timers.size, 1);
  await task.stop(value);
  assert.equal(f.timers.size, 0);
  await task.start(value);
  await f.dispose();
  assert.equal(f.timers.size, 0);
  assert.equal(f.presets.size, 0);
  assert.equal(f.features.size, 0);
  assert.equal(f.factories.length, 0);
  assert.equal(value.lifeCycleTaskManager.lifeCycleTask.length, 0);
  assert.equal(value.info.currentPlayers, 0);
  assert.equal(await value.execPreset("refreshPlayers"), null);
});

test("a plugin re-enable replaces inactive instance presets instead of retaining a disposed command", async () => {
  const value = instance();
  const first = fixture([value]);
  first.load("daemon/src/backend/index.ts").apply(first.ctx);
  await first.dispose();
  assert.equal(await value.execPreset("refreshPlayers"), null);
  const second = fixture([value]);
  second.load("daemon/src/backend/index.ts").apply(second.ctx);
  await value.execPreset("refreshPlayers");
  assert.equal(value.info.currentPlayers, 3);
  assert.equal(value.lifeCycleTaskManager.lifeCycleTask.length, 1);
  await second.dispose();
});

test("older instance plugins retain exactly one status preset and poller", async () => {
  const f = fixture([instance()]);
  const legacy = () => ({});
  f.presets.set("refreshPlayers", legacy);
  f.load("daemon/src/backend/index.ts").apply(f.ctx);
  assert.equal(f.presets.get("refreshPlayers"), legacy);
  assert.equal(f.factories.length, 0);
  assert.equal(f.timers.size, 0);
  assert(f.features.has("mcWorldMap"));
  await f.dispose();
});

test("Cordis dependency removal unloads the external plugin and clears restored instance tasks", async (t) => {
  const { Context, Service } = require("cordis");
  const ctx = new Context();
  t.after(() => ctx.stop());
  const value = instance();
  const features = new Set(), presets = new Map(), factories = [];
  ctx.plugin(class extends Service {
    constructor(scope) { super(scope, "protocol", true); }
    on() {}
    response() {}
    responseError() {}
  });
  ctx.plugin(class extends Service {
    constructor(scope) { super(scope, "features", true); }
    add(name) { return this.ctx.effect(() => { features.add(name); return () => features.delete(name); }); }
  });
  ctx.plugin(class extends Service {
    constructor(scope) { super(scope, "presets", true); }
    entries() { return presets; }
    register(name, factory) { return this.ctx.effect(() => { presets.set(name, factory); return () => presets.delete(name); }); }
  });
  ctx.plugin(class extends Service {
    constructor(scope) { super(scope, "instanceLifecycle", true); }
    register(factory) { return this.ctx.effect(() => { factories.push(factory); return () => factories.splice(factories.indexOf(factory), 1); }); }
  });
  const provider = ctx.plugin((scope) => scope.set("instances", {
    Command: class {},
    Instance: { STATUS_RUNNING: 3 },
    subsystem: { getInstances: () => [value] }
  }));
  ctx.plugin(loader()("daemon/src/backend/index.ts"));
  await ctx.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert(features.has("mcstats"));
  assert(presets.has("refreshPlayers"));
  assert.equal(value.lifeCycleTaskManager.lifeCycleTask.length, 1);
  await provider.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(features.size, 0);
  assert.equal(presets.size, 0);
  assert.equal(factories.length, 0);
  assert.equal(value.lifeCycleTaskManager.lifeCycleTask.length, 0);
  assert.equal(value.info.currentPlayers, 0);
});
