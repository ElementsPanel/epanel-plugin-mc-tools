const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { loader, deferred } = require("./helpers.cjs");
const load = loader();
const { readRconPlayers, readRconWorldTimes } = load("daemon/src/backend/map/players.ts");
const { javaRconConfiguration } = load("daemon/src/backend/map/rcon-config.ts");

test("RCON parses concatenated vanilla 26.2 entity replies, negative coordinates, dimensions and normalized facing", async () => {
  const calls = [];
  const result = await readRconPlayers(async command => {
    calls.push(command);
    if (command === "list") return "There are 2 of a max of 20 players online: Steve, Alex";
    if (command.endsWith(" Pos")) return "Steve has the following entity data: [-246.5d, 65.0d, -1.62E2d]Alex has the following entity data: [10.0d, 70.0d, 8.0d]";
    if (command.endsWith(" Dimension")) return 'Steve has the following entity data: "minecraft:overworld"Alex has the following entity data: "minecraft:the_nether"';
    if (command.endsWith(" Rotation")) return "Steve has the following entity data: [-90.0f, 0.0f]Alex has the following entity data: [450.0f, 20.0f]";
    throw new Error(command);
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(result, { warnings: [], players: [
    { name: "Steve", position: { x: -246.5, y: 65, z: -162, dimension: "minecraft:overworld", yaw: 270 } },
    { name: "Alex", position: { x: 10, y: 70, z: 8, dimension: "minecraft:the_nether", yaw: 90 } }
  ] });
});

test("partial positions remain listed, malformed coordinates are ignored and empty servers need only one command", async () => {
  let count = 0;
  assert.deepEqual(await readRconPlayers(async () => { count++; return "There are 0 of a max of 20 players online:"; }), { players: [], warnings: [] });
  assert.equal(count, 1);
  const result = await readRconPlayers(async command => command === "list" ? "There are 2 of a max of 20 players online: Steve, Alex"
    : command.endsWith(" pos") ? "Steve has the following entity data: [1d, 2d, 3d]Alex has the following entity data: [NaNd, 2d, 3d]"
      : command.endsWith(" dimension") ? 'Steve has the following entity data: "minecraft:overworld"' : "Found no elements matching query");
  assert.equal(result.players[0].position.x, 1); assert.equal(result.players[0].position.yaw, undefined);
  assert.equal(result.players[1].position, undefined);
  assert.deepEqual(result.warnings, ["MC_MAP_PLAYERS_POSITION_UNAVAILABLE"]);
  await assert.rejects(readRconPlayers(async () => "Unknown command"), /MC_MAP_RCON_RESPONSE/);
});

test("world time queries use 26.2 clocks, normalize long tick counts, and select the active save for each dimension", async () => {
  const worlds = [
    { id: "main", root: "/server", directory: "/server/world", dimension: "minecraft:overworld" },
    { id: "nether", root: "/server", directory: "/server/world/DIM-1", dimension: "minecraft:the_nether" },
    { id: "end", root: "/server", directory: "/server/world/DIM1", dimension: "minecraft:the_end" },
    { id: "old", root: "/server", directory: "/server/old", dimension: "minecraft:overworld" },
    { id: "custom", root: "/server", directory: "/server/world/dimensions/custom/moon", dimension: "custom:moon" },
    { id: "invalid", root: "/server", directory: "/server/world/bad", dimension: "custom:moon run stop" }
  ];
  const calls = [];
  const times = await readRconWorldTimes(async command => {
    calls.push(command);
    if (command === "execute in minecraft:overworld run time query time") return "§aClock minecraft:overworld is at 246000 tick(s)§r";
    if (command === "execute in minecraft:the_end run time query time") return "Clock minecraft:the_end is at 9223372036854775807 tick(s)";
    if (command === "execute in custom:moon run time query time") return "Clock custom:moon is at -1 tick(s)";
    return "Dimension minecraft:the_nether has no default clock configured";
  }, worlds, "world");
  assert.deepEqual(times, { main: 6000, end: Number(9223372036854775807n % 24000n), custom: 23999 });
  assert.equal(calls.length, 5); assert(calls.every(command => !command.includes("stop")));
  assert.equal(calls.filter(command => command.includes("minecraft:overworld")).length, 1);
});

test("legacy daytime fallback accepts midnight but ignores unavailable or malformed time replies", async () => {
  const worlds = [{ id: "main", root: "/server", directory: "/server/world", dimension: "minecraft:overworld" }];
  for (const ticks of [0, 6000, 18000, 23999]) {
    const calls = [];
    const times = await readRconWorldTimes(async command => {
      calls.push(command); return command.endsWith(" daytime") ? `The time is ${ticks}` : "Incorrect argument for command at position 42";
    }, worlds, "world");
    assert.deepEqual(times, { main: ticks }); assert.equal(calls.length, 2);
  }
  for (const response of ["Unknown command at position 42", "The time is NaN", "The time is 2.5", "The time is 42 trailing text", "The game time is 6000 tick(s)"]) {
    assert.deepEqual(await readRconWorldTimes(async () => response, worlds, "world"), {});
  }
});

function packet(id, type, body = "") {
  body = Buffer.from(body);
  const bytes = Buffer.alloc(body.length + 14);
  bytes.writeInt32LE(body.length + 10); bytes.writeInt32LE(id, 4); bytes.writeInt32LE(type, 8); body.copy(bytes, 12);
  return bytes;
}
function connection(respond) {
  const sockets = [];
  const { RconConnection } = loader({ "node:net": { createConnection() {
    const socket = new EventEmitter(); sockets.push(socket);
    socket.setNoDelay = () => {};
    socket.setKeepAlive = (enabled, delay) => { socket.keepAlive = { enabled, delay }; };
    socket.unref = () => {};
    socket.destroy = () => { socket.destroyed = true; };
    socket.write = bytes => respond(socket, bytes.readInt32LE(4), bytes.readInt32LE(8), bytes.subarray(12, -2).toString());
    return socket;
  } } })("daemon/src/backend/map/rcon.ts");
  const open = (signal = new AbortController().signal, timeout = 1000) => new RconConnection({ host: "localhost", port: 25575, password: "secret" }, signal, timeout);
  return { sockets, open, run: async (fn, signal, timeout) => { const client = open(signal, timeout); try { return await client.run(fn); } finally { client.close(); } } };
}

test("RCON waits before sending a delimiter, joins fragmented UTF-8 packets and separates consecutive commands", async () => {
  let received = false, commandId, calls = [];
  const f = connection((socket, id, type, body) => {
    calls.push(body);
    if (type === 3) { queueMicrotask(() => socket.emit("data", packet(id, 2))); return; }
    if (body) {
      received = false; commandId = id;
      const data = packet(id, 0, Buffer.from("玩家").subarray(0, 2));
      queueMicrotask(() => { received = true; socket.emit("data", data.subarray(0, 3)); socket.emit("data", data.subarray(3)); });
    } else {
      assert(received, "26.2 cannot accept pipelined requests before a reply");
      queueMicrotask(() => socket.emit("data", Buffer.concat([packet(commandId, 0, Buffer.from("玩家").subarray(2)), packet(id, 0, "Unknown command")])));
    }
  });
  assert.deepEqual(await f.run(async command => [await command("list"), await command("execute as @a run data get entity @s Pos")]), ["玩家", "玩家"]);
  assert.deepEqual(calls, ["secret", "list", "", "execute as @a run data get entity @s Pos", ""]);
  assert(f.sockets.every(socket => socket.destroyed));
});

test("RCON sanitizes auth, malformed packet, timeout and cancellation failures and closes connections", async () => {
  for (const kind of ["auth", "packet", "timeout", "abort"]) {
    const abort = new AbortController();
    const f = connection(socket => queueMicrotask(() => {
      if (kind === "auth") socket.emit("data", packet(-1, 2));
      if (kind === "packet") { const bad = Buffer.alloc(4); bad.writeInt32LE(-1); socket.emit("data", bad); }
      if (kind === "abort") abort.abort();
    }));
    await assert.rejects(f.run(async command => command("list"), abort.signal, 15), new RegExp(kind === "auth" ? "MC_MAP_RCON_AUTH" : kind === "packet" ? "MC_MAP_RCON_RESPONSE" : "MC_MAP_RCON_UNAVAILABLE"));
    assert(f.sockets.every(socket => socket.destroyed));
  }
});

test("RCON keeps the authenticated socket idle beyond request timeouts and serializes concurrent reads", async t => {
  const calls = [];
  const f = connection((socket, id, type, body) => {
    calls.push(body);
    queueMicrotask(() => socket.emit("data", packet(id, type === 3 ? 2 : 0, body ? "ok" : "")));
  });
  const client = f.open(undefined, 20); t.after(() => client.close());
  assert.equal(await client.run(command => command("first")), "ok");
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(client.closed, false); assert.equal(f.sockets[0].destroyed, undefined);
  await Promise.all([
    client.run(async command => { await command("second"); await command("third"); }),
    client.run(command => command("fourth"))
  ]);
  assert.deepEqual(calls, ["secret", "first", "", "second", "", "third", "", "fourth", ""]);
  assert.deepEqual(f.sockets[0].keepAlive, { enabled: true, delay: 30_000 });
  assert.equal(f.sockets.length, 1);
  f.sockets[0].emit("close"); assert.equal(client.closed, true);
  await assert.rejects(client.run(command => command("fifth")), /MC_MAP_RCON_UNAVAILABLE/);
});

async function fixture(t, text = "# Keep\r\nenable-rcon=false\r\nrcon.port=25576\r\nmotd=Welcome\r\n", overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epanel-map-rcon-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "server.properties"); await fs.writeFile(file, text, { mode: 0o640 });
  const instance = new EventEmitter(), restarts = [], reads = [], connections = [], tells = [], consoleCommands = [];
  instance.config = { type: "minecraft/java" }; instance.running = 3;
  instance.instanceUuid = "server";
  instance.status = () => instance.running; instance.absoluteCwdPath = () => root;
  instance.execPreset = async (name, parameter) => {
    if (name === "command") { consoleCommands.push(String(parameter)); return; }
    restarts.push(name); assert((await javaRconConfiguration(root)).enabled);
  };
  const worlds = [
    { id: "main", root, directory: path.join(root, "world"), dimension: "minecraft:overworld" },
    { id: "nether", root, directory: path.join(root, "world_nether", "DIM-1"), dimension: "minecraft:the_nether" },
    { id: "imported", root, directory: path.join(root, "oldworld"), dimension: "minecraft:overworld" }
  ];
  const { MapPlayerService } = loader({ "./rcon": { RconConnection: class {
    constructor(target, signal) { this.target = target; this.signal = signal; this.closed = false; connections.push(this); signal.addEventListener("abort", () => this.close()); }
    close() { this.closed = true; }
    async run(read) {
      const commands = []; reads.push({ target: this.target, signal: this.signal, commands });
      return read(async command => {
        commands.push(command);
        if (command === "list") return "There are 2 of a max of 20 players online: Steve, Alex";
        if (command.endsWith(" Pos")) return "Steve has the following entity data: [1d, 64d, 2d]Alex has the following entity data: [1d, 64d, 2d]";
        if (command.endsWith(" Dimension")) return 'Steve has the following entity data: "minecraft:overworld"Alex has the following entity data: "minecraft:the_nether"';
        if (command.endsWith(" Rotation")) return "Steve has the following entity data: [0f, 0f]Alex has the following entity data: [0f, 0f]";
        if (command.includes(" time query ")) return "The time is 6000";
        if (command.startsWith("tellraw ")) { tells.push(command); return ""; }
        throw new Error(command);
      });
    }
  } }, ...overrides })("daemon/src/backend/map/players.ts");
  const storage = memoryStorage();
  const service = new MapPlayerService({ getInstance: () => instance }, async () => worlds, { storage });
  t.after(() => service.dispose());
  return { root, file, text, instance, restarts, reads, connections, tells, consoleCommands, worlds, storage, service };
}

test("RCON setup does not modify until confirmed, preserves settings, generates a password and restarts once", async t => {
  const f = await fixture(t);
  assert.equal((await f.service.list("server")).rconEnabled, false);
  for (const value of [undefined, false, "true", 1]) await assert.rejects(f.service.enable("server", value), /MC_MAP_INVALID/);
  assert.equal(await fs.readFile(f.file, "utf8"), f.text); assert.deepEqual(f.restarts, []);
  assert.deepEqual(await f.service.enable("server", true), { changed: true, restartRequested: true });
  const config = await javaRconConfiguration(f.root), written = await fs.readFile(f.file, "utf8");
  assert.match(config.password, /^[a-f0-9]{48}$/); assert.equal(config.port, 25576);
  assert(written.startsWith(f.text.replace("enable-rcon=false", "enable-rcon=true")));
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o640); assert.deepEqual(f.restarts, ["restart"]);
  assert.deepEqual(await f.service.enable("server", true), { changed: false, restartRequested: false });
  assert.deepEqual(f.restarts, ["restart"]);
  assert.deepEqual(await fs.readdir(f.root), ["server.properties"]);
  const roster = await f.service.list("server");
  assert(!JSON.stringify(roster).includes(config.password)); assert.equal(roster.players[0].position.world, "main");
  assert.deepEqual(roster.worldTimes, { main: 6000, nether: 6000 });
  assert.deepEqual((await f.service.list("server", "nether")).worldTimes, { nether: 6000 });
  assert.deepEqual((await f.service.list("server", "imported")).worldTimes, {});
  assert.deepEqual((await f.service.list("server", "nether")).players.map(player => player.name), ["Alex"]);
  assert.equal(f.reads.length, 1); assert.equal(f.instance.listenerCount("exit"), 2, "the session and the chat tracker both listen for exits");
  assert.equal(f.reads[0].signal.aborted, false);
});

test("world time refreshes over the persistent session with no online players and clears when the server stops", async t => {
  let ticks = 0; const connections = [], commands = [];
  const f = await fixture(t, "enable-rcon=true\nrcon.password=test\n", { "./rcon": { RconConnection: class {
    constructor() { connections.push(this); }
    close() { this.closed = true; }
    async run(read) { return read(async command => {
      commands.push(command);
      return command === "list" ? "There are 0 of a max of 20 players online:" : `Clock minecraft:overworld is at ${ticks} tick(s)`;
    }); }
  } } });
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const first = await f.service.list("server"); assert.deepEqual(first.players, []); assert.equal(first.worldTimes.main, 0);
  ticks = 6000; now += 3000;
  assert.equal((await f.service.list("server")).worldTimes.main, 6000);
  assert.equal(connections.length, 1); assert.equal(commands.filter(command => command.includes("data get")).length, 0);
  now += 3000; assert.equal((await f.service.list("server")).worldTimes.main, 6000, "paused clocks stay at the reported time");
  f.instance.running = 0; f.instance.emit("exit");
  assert.equal((await f.service.list("server")).worldTimes, undefined); assert.equal(connections[0].closed, true);
});

test("setup retains escaped passwords and never restarts after invalid config or failed writes", async t => {
  const retained = await fixture(t, "motd=continued\\\nenable-rcon=false\nenable-rcon=false\nrcon.password=pass\\:word\\\\end\n");
  await retained.service.enable("server", true);
  assert.equal((await javaRconConfiguration(retained.root)).password, "pass:word\\end");
  assert((await fs.readFile(retained.file, "utf8")).startsWith("motd=continued\\\nenable-rcon=false\n"));
  for (const kind of ["port", "busy", "locked", "write", "bedrock"]) {
    const f = await fixture(t, kind === "port" ? "enable-rcon=false\nrcon.port=0\n" : undefined,
      kind === "write" ? { "node:fs/promises": { ...fs, rename: async () => { throw new Error("EACCES"); } } } : {});
    if (kind === "busy") f.instance.running = 2;
    if (kind === "locked") f.instance.lock = true;
    if (kind === "bedrock") f.instance.config.type = "minecraft/bedrock";
    await assert.rejects(f.service.enable("server", true), /MC_MAP_RCON_(CONFIG|BUSY|WRITE_FAILED|UNSUPPORTED)/);
    assert.deepEqual(f.restarts, []); assert.equal(await fs.readFile(f.file, "utf8"), f.text);
  }
});

test("concurrent confirmations cannot restart twice and restart failures leave a usable saved config", async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  f.instance.execPreset = async () => { entered.resolve(); await gate.promise; };
  const enabling = f.service.enable("server", true); await entered.promise;
  await assert.rejects(f.service.enable("server", true), /MC_MAP_RCON_BUSY/);
  gate.reject(new Error("private error"));
  await assert.rejects(enabling, /MC_MAP_RCON_RESTART_FAILED/);
  assert((await javaRconConfiguration(f.root)).enabled);
});

test("offline instances do not connect and disposing cancels active RCON reads", async t => {
  const started = deferred();
  const f = await fixture(t, "enable-rcon=true\nrcon.password=test\n", { "./rcon": { RconConnection: class {
    constructor(_target, signal) { this.signal = signal; }
    close() { this.closed = true; }
    async run() { started.resolve(this.signal); await new Promise((resolve, reject) => this.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); }
  } } });
  f.instance.running = 0; assert.deepEqual((await f.service.list("server")).players, []);
  f.instance.running = 3;
  const request = f.service.list("server"); const signal = await started.promise;
  f.service.dispose(); assert(signal.aborted);
  await assert.rejects(request, /MC_MAP_UNAVAILABLE/); assert.equal(f.instance.listenerCount("exit"), 0);
});

test("daemon reuses each instance session across refreshes, reconnects closed sockets and cleans up on server exit", async t => {
  const f = await fixture(t, "enable-rcon=true\nrcon.password=test\n");
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  await Promise.all([f.service.list("server"), f.service.list("server", "nether")]);
  now += 3000; await f.service.list("server");
  assert.equal(f.connections.length, 1); assert.equal(f.reads.length, 2); assert.equal(f.connections[0].closed, false);
  assert.equal(f.instance.listenerCount("exit"), 2);
  f.connections[0].close(); now += 3000; await f.service.list("server");
  assert.equal(f.connections.length, 2); assert.equal(f.instance.listenerCount("exit"), 2);
  f.instance.running = 0; f.instance.emit("exit");
  assert.equal(f.connections[1].closed, true); assert.equal(f.instance.listenerCount("exit"), 1);
  assert.deepEqual((await f.service.list("server")).players, []);
  f.instance.running = 3; await f.service.list("server");
  assert.equal(f.connections.length, 3); assert.equal(f.connections[2].closed, false);
  f.service.dispose(); assert(f.connections.every(connection => connection.closed));
  assert.equal(f.instance.listenerCount("exit"), 0);
});

test("RCON config changes replace only that instance's connection and disabling RCON closes it", async t => {
  const f = await fixture(t, "enable-rcon=true\nrcon.password=before\n");
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  await f.service.list("first"); await f.service.list("second");
  assert.equal(f.connections.length, 2);
  await fs.writeFile(f.file, "enable-rcon=true\nrcon.password=after\nrcon.port=25580\n");
  now += 3000; await f.service.list("first");
  assert.equal(f.connections[0].closed, true); assert.equal(f.connections[1].closed, false);
  assert.equal(f.connections[2].target.password, "after"); assert.equal(f.connections[2].target.port, 25580);
  await fs.writeFile(f.file, "enable-rcon=false\nrcon.password=after\n");
  now += 3000; assert.equal((await f.service.list("first")).rconEnabled, false);
  assert.equal(f.connections[2].closed, true); assert.equal(f.connections[1].closed, false);
});

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await Promise.resolve().then(check).catch(() => undefined);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timeout");
}

const chat = (text) => `[12:00:00] [Server thread/INFO]: ${text}\r\n`;
const HIDDEN_KEY = "McToolsMapVisibility/hidden-players";
const hiddenNames = (storage) => (storage.values.get(HIDDEN_KEY)?.entries ?? []).flatMap((entry) => entry.names);

function memoryStorage() {
  const values = new Map();
  return {
    values,
    load(category, type, entity) {
      const raw = values.get(category + "/" + entity);
      return raw === undefined ? null : Object.assign(new type(), JSON.parse(JSON.stringify(raw)));
    },
    store(category, entity, value) { values.set(category + "/" + entity, JSON.parse(JSON.stringify(value))); }
  };
}

test("chat visibility commands hide a player from every map and confirm privately over RCON", async (t) => {
  const f = await fixture(t, "enable-rcon=true\nrcon.password=test\n");
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const names = async (world) => (await f.service.list("server", world)).players.map((player) => player.name);
  assert.deepEqual(await names(), ["Steve", "Alex"]);
  assert.equal(f.instance.listenerCount("data"), 1, "chat is watched as soon as the map is opened");
  f.service.track(f.instance);
  assert.equal(f.instance.listenerCount("data"), 1, "tracking twice keeps one listener");

  f.instance.emit("data", chat("<Steve> $mapos off"));
  await until(() => f.tells.length && f.tells);
  assert.equal(f.tells[0], 'tellraw Steve [{"text":"[MapOS] ","color":"gold"},{"text":"地图显示已关闭，输入 $mapos on 可恢复","color":"gray"}]');
  now += 3000;
  assert.deepEqual(await names(), ["Alex"]);
  assert.deepEqual(await names("nether"), ["Alex"]);
  assert.deepEqual(await names("imported"), []);
  assert.equal((await f.service.list("server")).worldTimes.main, 6000, "hiding keeps the world clock");
  assert.deepEqual(hiddenNames(f.storage), ["Steve"]);

  f.instance.emit("data", chat("<Steve> $mapos on"));
  await until(() => f.tells.length === 2 && f.tells);
  now += 3000;
  assert.deepEqual(await names(), ["Steve", "Alex"]);
  assert.deepEqual(hiddenNames(f.storage), []);
});

test("the confirmation falls back to the console when RCON is not enabled", async (t) => {
  const f = await fixture(t);
  await f.service.list("server");
  assert.equal(f.instance.listenerCount("data"), 1);
  f.instance.emit("data", chat("[Not Secure] <Alex> $mapos off"));
  await until(() => f.consoleCommands.length && f.consoleCommands);
  assert.equal(f.consoleCommands[0], 'tellraw Alex [{"text":"[MapOS] ","color":"gold"},{"text":"地图显示已关闭，输入 $mapos on 可恢复","color":"gray"}]');
  assert.deepEqual(f.tells, []);
  assert.deepEqual(hiddenNames(f.storage), ["Alex"]);
});

test("map player routes enforce login and instance access, and forward only explicit RCON confirmations", async () => {
  const routes = new Map(), calls = [], disposal = [];
  const ctx = {
    koa: { router: () => ({ get: (name, ...handlers) => routes.set("GET " + name, handlers), post: (name, ...handlers) => routes.set("POST " + name, handlers) }) },
    on: (_event, callback) => disposal.push(callback), roles: { USER: 1 },
    middleware: {
      permission: () => async (request, next) => { if (request.logged) await next(); else request.status = 403; },
      validator: () => async (_request, next) => next(),
      instanceAccess: async (request, next) => { if (request.allowed) await next(); else request.status = 403; }
    },
    remote: { services: { getInstance: () => ({ available: true }) }, Request: class { async request(event, data) { calls.push({ event, data }); return {}; } } }
  };
  load("panel/src/backend/map-players.ts").registerMapPlayerRoutes(ctx);
  const request = async (route, options = {}) => {
    const request = { query: { uuid: "server", daemonId: "node", world: "injected" }, request: { body: { confirmed: true, password: "injected" } }, set() {}, ...options };
    const handlers = routes.get(route), run = index => handlers[index]?.(request, () => run(index + 1));
    await run(0); return request;
  };
  assert.equal((await request("GET /players")).status, 403);
  assert.equal((await request("POST /rcon/enable", { logged: true })).status, 403); assert.deepEqual(calls, []);
  const invalid = await request("POST /rcon/enable", { logged: true, allowed: true, request: { body: {} } });
  assert.equal(invalid.body.message, "MC_MAP_INVALID"); assert.deepEqual(calls, []);
  await request("POST /rcon/enable", { logged: true, allowed: true });
  assert.deepEqual(calls, [{ event: "mc-tools/map/rcon-enable", data: { instanceUuid: "server", confirmed: true } }]);
  await request("GET /players", { logged: true, allowed: true });
  assert.deepEqual(calls.at(-1), { event: "mc-tools/map/players", data: { instanceUuid: "server" } });
  disposal.forEach(callback => callback());
});
