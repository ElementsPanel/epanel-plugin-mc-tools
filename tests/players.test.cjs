const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter, once } = require("node:events");
const { test } = require("node:test");
const { loader } = require("./helpers.cjs");
const { queryServer } = require("./query-fixture.cjs");

const load = loader();
const { playerOperation } = load("shared/players.ts");
const { PlayerManagementService, playerCommand } = load("daemon/src/backend/players/service.ts");
const { onlineParser, operationParser, requestConsole } = load("daemon/src/backend/players/console.ts");
const { savedPlayers } = load("daemon/src/backend/players/files.ts");

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "epanel-players-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function json(root, name, value) { await fs.writeFile(path.join(root, name), JSON.stringify(value)); }
async function javaQuery(t, root, options) {
  const server = await queryServer(t, options);
  await fs.writeFile(path.join(root, "server.properties"), `enable-query=true\nquery.port=${server.port}\nserver-ip=127.0.0.1\n`);
  return server;
}
function instance(root, type = "minecraft/java") {
  const value = new EventEmitter();
  value.running = true; value.commands = [];
  value.config = { type };
  value.status = () => value.running ? 3 : 0;
  value.absoluteCwdPath = () => root;
  value.respond = async (command) => {
    if (command === "list") value.emit("data", "[12:30:00] [Server thread/INFO]: There are 1 of a max of 20 players online: Alex\n");
    else value.emit("data", "[12:30:00] [Server thread/INFO]: Kicked Alex: Test\n");
  };
  value.execPreset = async (preset, command) => { assert.equal(preset, "command"); value.commands.push(command); await value.respond(command); };
  return value;
}

test("player operations reject selectors, command injection and invalid destinations before building console commands", () => {
  for (const name of ["@a", "Steve\nstop", "Steve\rstop", "Steve\0", 'A" B', "A\\B", " Steve", "Steve ", "A;op Steve", "A\u2028stop"]) {
    assert.throws(() => playerOperation({ action: "op", player: name }), /MC_PLAYERS_INVALID_NAME/);
  }
  for (const reason of ["test\nstop", "\x03", "a".repeat(201)]) assert.throws(() => playerOperation({ action: "kick", player: "Alex", reason }), /MC_PLAYERS_INVALID_REASON/);
  for (const destination of [null, [], { x: 0, y: NaN, z: 0 }, { x: Infinity, y: 64, z: 0 }, { x: 0, y: 2049, z: 0 }, { x: 30000001, y: 64, z: 0 }, { player: "@e" }]) assert.throws(() => playerOperation({ action: "teleport", player: "Alex", destination }), /MC_PLAYERS_INVALID/);
  assert.throws(() => playerOperation({ action: "stop", player: "Alex" }), /MC_PLAYERS_INVALID/);
  assert.throws(() => playerOperation({ action: "gamemode", player: "Alex", mode: "creative\nstop" }), /MC_PLAYERS_INVALID/);
  assert.equal(playerCommand(playerOperation({ action: "gamemode", player: "Alex", mode: "creative" }), "java"), "gamemode creative Alex");
  assert.equal(playerCommand(playerOperation({ action: "teleport", player: "Alex", destination: { x: -12.5, y: -64, z: 30000000 } }), "java"), "tp Alex -12.5 -64 30000000");
  assert.equal(playerCommand(playerOperation({ action: "teleport", player: "Alex Smith", destination: { player: "Steve Jones" } }), "bedrock"), 'tp "Alex Smith" "Steve Jones"');
  assert.throws(() => playerCommand(playerOperation({ action: "op", player: "Alex Smith" }), "java"), /MC_PLAYERS_INVALID_NAME/);
  assert.throws(() => playerCommand(playerOperation({ action: "ban", player: "Alex" }), "bedrock"), /MC_PLAYERS_ACTION_UNSUPPORTED/);
});

test("Java and Bedrock lists handle fragmented, colored and multiline responses without consuming player chat", async () => {
  const value = instance(".");
  value.respond = async () => {
    value.emit("data", "\x1b[32m[12:30:00] [Server thread/INFO]: There are 2 of a max of 20 players on");
    value.emit("data", "line: §aAlex, St");
    value.emit("data", "eve\x1b[0m\n");
  };
  const cancellations = new Set();
  assert.deepEqual(await requestConsole(value, "list", onlineParser(), cancellations, 100), { names: ["Alex", "Steve"], maxPlayers: 20 });
  value.respond = async () => {
    value.emit("data", "[2026-11-04 12:30:00:001 INFO] There are 2/10 players online:\n");
    value.emit("data", "[2026-11-04 12:30:00:002 INFO] Alex Smith, Steve\n");
  };
  assert.deepEqual(await requestConsole(value, "list", onlineParser(), cancellations, 100), { names: ["Alex Smith", "Steve"], maxPlayers: 10 });
  value.respond = async () => value.emit("data", "There are 0/10 players online:\n");
  assert.deepEqual(await requestConsole(value, "list", onlineParser(), cancellations, 100), { names: [], maxPlayers: 10 });
  assert.equal(operationParser({ action: "op", player: "Alex" })("<Steve> Alex is already an operator"), undefined);
  assert.equal(operationParser({ action: "kick", player: "Alex" })("Kicked Alexander: reason"), undefined);
  assert.equal(value.listenerCount("data"), 0);
  assert.equal(value.listenerCount("exit"), 0);
  assert.equal(cancellations.size, 0);
});

test("player rosters merge UUIDs, online names, operators, allowlists and active bans without changing source files", async (t) => {
  const root = await temporary(t);
  await javaQuery(t, root);
  const uuid = "1".repeat(32), banned = "2".repeat(32);
  await json(root, "usercache.json", [{ name: "OldAlex", uuid }, { name: "Steve", uuid: banned }]);
  await json(root, "whitelist.json", [{ name: "Alex", uuid }]);
  await json(root, "ops.json", [{ name: "Alex", uuid, level: 4 }]);
  await json(root, "banned-players.json", [{ name: "Steve", uuid: banned, expires: "forever", reason: "Test reason" }, { name: "Expired", uuid: "3".repeat(32), expires: "2000-01-01 00:00:00 +0000" }]);
  const before = await Promise.all((await fs.readdir(root)).map(async name => [name, await fs.readFile(path.join(root, name), "utf8")]));
  const value = instance(root), service = new PlayerManagementService({ getInstance: () => value }, 100);
  t.after(() => service.dispose());
  const roster = await service.list("server");
  assert.equal(roster.players.length, 2);
  assert.deepEqual(roster.warnings, []);
  assert.equal(roster.maxPlayers, 20);
  assert.equal(roster.onlineAvailable, true);
  const alex = roster.players.find(player => player.name === "Alex");
  assert.equal(alex.uuid, uuid); assert(alex.online && alex.operator && alex.whitelisted);
  const steve = roster.players.find(player => player.name === "Steve");
  assert(steve.banned && !steve.online); assert.equal(steve.banReason, "Test reason");
  value.running = false;
  const offline = await service.list("server");
  assert(!offline.running && offline.players.every(player => player.online === false));
  assert.equal(value.commands.length, 0);
  await assert.rejects(service.action("server", { action: "kick", player: "Alex" }), /MC_PLAYERS_NOT_RUNNING/);
  for (const [name, text] of before) assert.equal(await fs.readFile(path.join(root, name), "utf8"), text);
});

test("Bedrock rosters merge permission XUIDs with allowlist names and hide unsupported native bans", async (t) => {
  const root = await temporary(t);
  await json(root, "permissions.json", [{ xuid: "123456789123456789", permission: "operator" }, { xuid: "456", permission: "member" }]);
  await json(root, "allowlist.json", [{ name: "Alex Smith", xuid: "123456789123456789" }]);
  const value = instance(root, "minecraft/bedrock");
  value.respond = async () => value.emit("data", "There are 1/10 players online:\nAlex Smith\n");
  const service = new PlayerManagementService({ getInstance: () => value }, 100);
  t.after(() => service.dispose());
  const roster = await service.list("server");
  const alex = roster.players.find(player => player.name === "Alex Smith");
  assert.equal(roster.players.length, 2);
  assert(alex.online && alex.operator && alex.whitelisted);
  assert(!roster.actions.includes("ban") && !roster.actions.includes("pardon"));
  assert(roster.actions.includes("gamemode") && roster.actions.includes("teleport"));
  const commandCount = value.commands.length;
  await assert.rejects(service.action("server", { action: "ban", player: "Alex Smith" }), /MC_PLAYERS_ACTION_UNSUPPORTED/);
  assert.equal(value.commands.length, commandCount);
});

test("missing, corrupt and unsafe roster files do not expose outside files or report unknown online players as offline", async (t) => {
  const root = await temporary(t), outside = await temporary(t);
  await javaQuery(t, root, { silent: true });
  await json(outside, "ops.json", [{ name: "Outside", uuid: "a".repeat(32) }]);
  await fs.symlink(path.join(outside, "ops.json"), path.join(root, "ops.json"));
  await fs.writeFile(path.join(root, "whitelist.json"), "invalid");
  await json(root, "usercache.json", [{ name: "Alex", uuid: "1".repeat(32) }]);
  const value = instance(root); value.respond = async () => {};
  const service = new PlayerManagementService({ getInstance: () => value }, 20);
  t.after(() => service.dispose());
  const roster = await service.list("server");
  assert.deepEqual(roster.warnings.sort(), ["MC_PLAYERS_FILES_PARTIAL", "MC_PLAYERS_QUERY_UNAVAILABLE"]);
  assert(!roster.onlineAvailable);
  assert.deepEqual(roster.players.map(player => [player.name, player.online]), [["Alex", null]]);
  assert.equal(value.listenerCount("data"), 0);
  assert.equal(value.listenerCount("exit"), 0);
});

test("Java Query configuration and incomplete-list warnings preserve unknown status without falling back to console polling", async t => {
  const root = await temporary(t), value = instance(root);
  const server = await queryServer(t, { names: [], numPlayers: 1 });
  await json(root, "usercache.json", [{ name: "Alex", uuid: "1".repeat(32) }]);
  const service = new PlayerManagementService({ getInstance: () => value }, 1000);
  t.after(() => service.dispose());
  for (const [properties, warning] of [
    [null, "MC_PLAYERS_QUERY_CONFIG"],
    ["enable-query=false\n", "MC_PLAYERS_QUERY_DISABLED"],
    ["enable-query=true\nquery.port=invalid\n", "MC_PLAYERS_QUERY_CONFIG"],
    [`enable-query=true\nquery.port=${server.port}\n`, "MC_PLAYERS_QUERY_RESPONSE"]
  ]) {
    if (properties !== null) await fs.writeFile(path.join(root, "server.properties"), properties);
    const roster = await service.list("server");
    assert.deepEqual(roster.warnings, [warning]);
    assert.equal(roster.onlineAvailable, false);
    assert.deepEqual(roster.players.map(player => [player.name, player.online]), [["Alex", null]]);
    assert.equal(value.commands.length, 0);
    assert.equal(value.listenerCount("exit"), 0);
    assert.equal(value.listenerCount("data"), 0);
  }
});

test("Java Query is cancelled on server stop or plugin unload without retaining stale online status or listeners", async t => {
  const root = await temporary(t), value = instance(root);
  const server = await javaQuery(t, root, { silent: true });
  await json(root, "usercache.json", [{ name: "Alex", uuid: "1".repeat(32) }]);
  const service = new PlayerManagementService({ getInstance: () => value }, 1000);
  t.after(() => service.dispose());
  let received = once(server.socket, "message");
  const stopping = service.list("server");
  await received;
  await assert.rejects(service.action("server", { action: "kick", player: "Alex" }), /MC_PLAYERS_BUSY/);
  value.running = false; value.emit("exit");
  const stopped = await stopping;
  assert(!stopped.running && stopped.onlineAvailable && stopped.players.every(player => !player.online));
  assert.deepEqual(stopped.warnings, []);
  assert.equal(value.listenerCount("exit"), 0);
  value.running = true;
  received = once(server.socket, "message");
  const unloading = service.list("server");
  const rejected = assert.rejects(unloading, /MC_PLAYERS_UNAVAILABLE/);
  await received;
  service.dispose(); await rejected;
  assert.equal(value.listenerCount("exit"), 0);
  assert.equal(value.listenerCount("data"), 0);
  assert.equal(value.commands.length, 0);
});

test("all management commands require matching native feedback and expose failures without claiming success", async (t) => {
  const root = await temporary(t), value = instance(root);
  const service = new PlayerManagementService({ getInstance: () => value }, 50);
  t.after(() => service.dispose());
  const fixtures = [
    [{ action: "kick", player: "Alex", reason: "Test" }, "kick Alex Test", "Kicked Alex: Test"],
    [{ action: "ban", player: "Alex", reason: "Test" }, "ban Alex Test", "Banned Alex: Test"],
    [{ action: "pardon", player: "Alex" }, "pardon Alex", "Unbanned Alex"],
    [{ action: "whitelist-add", player: "Alex" }, "whitelist add Alex", "Added Alex to the whitelist"],
    [{ action: "whitelist-remove", player: "Alex" }, "whitelist remove Alex", "Removed Alex from the whitelist"],
    [{ action: "op", player: "Alex" }, "op Alex", "Made Alex a server operator"],
    [{ action: "deop", player: "Alex" }, "deop Alex", "Made Alex no longer a server operator"],
    [{ action: "gamemode", player: "Alex", mode: "creative" }, "gamemode creative Alex", "Set Alex's game mode to Creative Mode"],
    [{ action: "teleport", player: "Alex", destination: { x: 12.5, y: 64, z: -5 } }, "tp Alex 12.5 64 -5", "Teleported Alex to 12.5, 64, -5"],
    [{ action: "teleport", player: "Alex", destination: { player: "Steve" } }, "tp Alex Steve", "Teleported Alex to Steve"]
  ];
  for (const [operation, command, response] of fixtures) {
    value.respond = async received => { assert.equal(received, command); value.emit("data", "[12:30:00] [Server thread/INFO]: " + response + "\n"); };
    assert.deepEqual(await service.action("server", operation), { ok: true, message: response });
  }
  value.respond = async () => value.emit("data", "No player was found\n");
  assert.deepEqual(await service.action("server", { action: "kick", player: "Alex" }), { ok: false, message: "No player was found" });
  value.respond = async () => value.emit("data", "<Steve> Kicked Alex: chat\n");
  await assert.rejects(service.action("server", { action: "kick", player: "Alex" }), /MC_PLAYERS_NO_RESPONSE/);
  assert.equal(value.listenerCount("data"), 0);
});

test("concurrent commands, stopping and unload cancel cleanly and cannot send a command after disposal", async (t) => {
  const root = await temporary(t), value = instance(root);
  value.respond = async () => {};
  const service = new PlayerManagementService({ getInstance: () => value }, 1000);
  const first = service.action("server", { action: "kick", player: "Alex" });
  await assert.rejects(service.action("server", { action: "op", player: "Alex" }), /MC_PLAYERS_BUSY/);
  value.running = false; value.emit("exit");
  await assert.rejects(first, /MC_PLAYERS_NOT_RUNNING/);
  assert.equal(value.listenerCount("data"), 0);
  value.running = true;
  const next = service.action("server", { action: "op", player: "Alex" });
  const count = value.commands.length;
  service.dispose();
  await assert.rejects(next, /MC_PLAYERS_UNAVAILABLE/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(value.commands.length, count);
  assert.equal(value.listenerCount("data"), 0);
  assert.equal(value.listenerCount("exit"), 0);
  await assert.rejects(service.list("server"), /MC_PLAYERS_UNAVAILABLE/);
});

test("player panel routes authorize instance ownership and only POST validated actions to the daemon", async () => {
  const routes = new Map(), calls = [], checks = [];
  const ctx = {
    koa: { router(prefix) { assert.equal(prefix, "/api/mc-tools/players"); return Object.fromEntries(["get", "post"].map(method => [method, (route, ...handlers) => routes.set(method + route, handlers)])); } },
    roles: { USER: 1 },
    middleware: {
      permission() { return async (request, next) => { checks.push("permission"); await next(); }; },
      validator() { return async (request, next) => { checks.push("validate"); await next(); }; },
      async instanceAccess(request, next) { checks.push("instance"); if (request.denied) { request.status = 403; return; } await next(); }
    },
    remote: { services: { getInstance: () => ({ available: true }) }, Request: class { async request(event, data) { calls.push({ event, data }); return { ok: true }; } } }
  };
  load("panel/src/backend/players.ts").registerPlayerRoutes(ctx);
  async function request(method, body, denied) {
    const value = { query: { uuid: "server", daemonId: "node" }, request: { body }, denied };
    const handlers = routes.get(method);
    const run = index => handlers[index]?.(value, () => run(index + 1));
    await run(0); return value;
  }
  assert(!routes.has("get/action"));
  assert.equal((await request("post/action", { action: "op", player: "Alex" }, true)).status, 403);
  assert.equal(calls.length, 0);
  await request("get/list");
  assert.deepEqual(checks.slice(-3), ["permission", "validate", "instance"]);
  await request("post/action", { action: "op", player: "Alex", command: "stop", instanceUuid: "other" });
  assert.deepEqual(calls[1], { event: "mc-tools/players/action", data: { instanceUuid: "server", operation: { action: "op", player: "Alex" } } });
  assert.match((await request("post/action", { action: "op", player: "@a" })).body.message, /MC_PLAYERS_INVALID_NAME/);
  assert.equal(calls.length, 2);
});

test("daemon player protocol hides filesystem errors, rejects proxies and removes its pending listeners on unload", async (t) => {
  const root = await temporary(t), value = instance(root);
  await javaQuery(t, root);
  const events = new Map(), disposals = [];
  const ctx = {
    instances: { subsystem: { getInstance: id => id === "server" ? value : undefined } },
    features: { add: name => assert.equal(name, "mcPlayers") },
    on: (event, callback) => disposals.push(callback),
    protocol: { on: (event, handler) => events.set(event, handler), response: (request, result) => { request.result = result; }, responseError: (request, error) => { request.error = error; } }
  };
  load("daemon/src/backend/players/index.ts").registerPlayerManagement(ctx);
  const request = async (event, data) => { const result = {}; await events.get(event)(result, data); return result; };
  assert.equal((await request("mc-tools/players/list", { instanceUuid: "missing" })).error.message, "MC_PLAYERS_INSTANCE_MISSING");
  const roster = (await request("mc-tools/players/list", { instanceUuid: "server" })).result;
  assert.equal(roster.players[0].name, "Alex");
  assert(!JSON.stringify(roster).includes(root));
  value.config.type = "minecraft/java/bungeecord";
  assert.equal((await request("mc-tools/players/list", { instanceUuid: "server" })).error.message, "MC_PLAYERS_UNSUPPORTED_INSTANCE");
  value.config.type = "minecraft/java"; value.absoluteCwdPath = () => path.join(root, "missing");
  assert.equal((await request("mc-tools/players/list", { instanceUuid: "server" })).error.message, "MC_PLAYERS_READ_FAILED");
  for (const dispose of disposals) await dispose();
});
