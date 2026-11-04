const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { loader, deferred } = require("./helpers.cjs");
const load = loader();
const { PlayerManagementService } = load("daemon/src/backend/players/service.ts");
const { javaQueryConfiguration } = load("daemon/src/backend/players/query-config.ts");

async function fixture(t, text = "# Keep settings\r\nenable-query=false\r\nquery.port=24444\r\nmotd=My server\r\n") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epanel-query-enable-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "server.properties");
  await fs.writeFile(filename, text, { mode: 0o640 });
  const instance = new EventEmitter();
  instance.config = { type: "minecraft/java" }; instance.running = 3;
  instance.status = () => instance.running; instance.absoluteCwdPath = () => root;
  const commands = [];
  instance.execPreset = async preset => { commands.push(preset); assert.equal((await javaQueryConfiguration(root)).enabled, true); };
  const service = new PlayerManagementService({ getInstance: () => instance });
  t.after(() => service.dispose());
  return { root, filename, instance, commands, service, text };
}

test("confirmed Query setup writes only the enable flag, preserves formatting and mode, then requests exactly one restart", async t => {
  const f = await fixture(t);
  assert.equal((await f.service.list("server")).queryEnabled, false);
  assert.deepEqual(f.commands, []);
  await assert.rejects(f.service.enableQuery("server", false), /MC_PLAYERS_INVALID/);
  await assert.rejects(f.service.enableQuery("server", undefined), /MC_PLAYERS_INVALID/);
  assert.equal(await fs.readFile(f.filename, "utf8"), f.text);
  assert.deepEqual(await f.service.enableQuery("server", true), { changed: true, restartRequested: true });
  assert.equal(await fs.readFile(f.filename, "utf8"), f.text.replace("enable-query=false", "enable-query=true"));
  assert.equal((await fs.stat(f.filename)).mode & 0o777, 0o640);
  assert.deepEqual(f.commands, ["restart"]);
  assert.deepEqual(await f.service.enableQuery("server", true), { changed: false, restartRequested: false });
  assert.deepEqual(f.commands, ["restart"]);
  assert.deepEqual(await fs.readdir(f.root), ["server.properties"]);
});

test("Query setup supports missing flags, duplicate and escaped keys without modifying continued MOTD text", async t => {
  for (const text of [
    "\uFEFF# settings\nquery.port=24444\nmotd=Welcome",
    "query.port=24444\nmotd=continued\\",
    "query.port=24444\nenable-query:false\nenable-query false\n",
    "query.port=24444\n\\u0065nable-query=false\nmotd=first\\\nenable-query=false\nother=value\n"
  ]) {
    const f = await fixture(t, text);
    await f.service.enableQuery("server", true);
    const result = await fs.readFile(f.filename, "utf8");
    assert.equal((await javaQueryConfiguration(f.root)).enabled, true);
    assert.equal((await javaQueryConfiguration(f.root)).port, 24444);
    if (text.includes("motd=first")) assert(result.includes("motd=first\\\nenable-query=false\nother=value\n"));
    if (text.startsWith("\uFEFF")) assert(result.startsWith("\uFEFF# settings\n"));
    assert.deepEqual(f.commands, ["restart"]);
  }
});

test("Query setup preserves legacy property bytes and never restarts when the atomic save fails", async t => {
  const f = await fixture(t);
  const before = Buffer.concat([Buffer.from("motd=Caf"), Buffer.from([0xe9]), Buffer.from("\nenable-query=false\nquery.port=24444\n")]);
  await fs.writeFile(f.filename, before);
  await f.service.enableQuery("server", true);
  assert.deepEqual(await fs.readFile(f.filename), Buffer.concat([Buffer.from("motd=Caf"), Buffer.from([0xe9]), Buffer.from("\nenable-query=true\nquery.port=24444\n")]));
  await fs.writeFile(f.filename, before); f.commands.length = 0;
  const { PlayerManagementService: FailingService } = loader({ "node:fs/promises": { ...fs, rename: async () => { throw new Error("EACCES"); } } })("daemon/src/backend/players/service.ts");
  const service = new FailingService({ getInstance: () => f.instance });
  t.after(() => service.dispose());
  await assert.rejects(service.enableQuery("server", true), /MC_PLAYERS_QUERY_WRITE_FAILED/);
  assert.deepEqual(await fs.readFile(f.filename), before);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(await fs.readdir(f.root), ["server.properties"]);
});

test("Query setup rejects Bedrock, busy instances, unsafe or invalid settings and never restarts after a failed save", async t => {
  for (const scenario of ["bedrock", "busy", "locked", "port", "symlink"]) {
    const f = await fixture(t);
    if (scenario === "bedrock") f.instance.config.type = "minecraft/bedrock";
    if (scenario === "busy") f.instance.running = 2;
    if (scenario === "locked") f.instance.lock = true;
    if (scenario === "port") await fs.writeFile(f.filename, "enable-query=false\nquery.port=invalid\n");
    if (scenario === "symlink") {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "epanel-query-outside-"));
      t.after(() => fs.rm(outside, { recursive: true, force: true }));
      await fs.writeFile(path.join(outside, "server.properties"), f.text);
      await fs.rm(f.filename); await fs.symlink(path.join(outside, "server.properties"), f.filename);
    }
    const before = await fs.readFile(f.filename);
    await assert.rejects(f.service.enableQuery("server", true), /MC_PLAYERS_(?:ACTION_UNSUPPORTED|BUSY|QUERY_CONFIG)/);
    assert.deepEqual(await fs.readFile(f.filename), before);
    assert.deepEqual(f.commands, []);
  }
});

test("Query setup reports restart failures truthfully and prevents overlapping confirmations from restarting twice", async t => {
  const f = await fixture(t);
  const gate = deferred();
  f.instance.execPreset = async preset => { f.commands.push(preset); await gate.promise; throw new Error("failed"); };
  const first = f.service.enableQuery("server", true);
  const rejected = assert.rejects(first, /MC_PLAYERS_QUERY_RESTART_FAILED/);
  await assert.rejects(f.service.enableQuery("server", true), /MC_PLAYERS_BUSY/);
  for (let attempt = 0; attempt < 100 && !f.commands.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(f.commands, ["restart"]);
  gate.resolve(); await rejected;
  assert.equal((await javaQueryConfiguration(f.root)).enabled, true);
});

test("Query setup routes require instance access and explicit confirmation and forward only the selected instance", async () => {
  const routes = new Map(), calls = [];
  const ctx = {
    koa: { router: () => Object.fromEntries(["get", "post"].map(method => [method, (path, ...handlers) => routes.set(method + path, handlers)])) },
    roles: { USER: 1 }, middleware: {
      permission: () => async (_, next) => next(), validator: () => async (_, next) => next(),
      instanceAccess: async (request, next) => { if (!request.denied) await next(); }
    },
    remote: { services: { getInstance: () => ({ available: true }) }, Request: class { async request(event, data) { calls.push({ event, data }); return true; } } }
  };
  load("panel/src/backend/players.ts").registerPlayerRoutes(ctx);
  const request = async (body, denied = false) => {
    const context = { query: { uuid: "server", daemonId: "node" }, request: { body }, denied };
    const handlers = routes.get("post/query/enable");
    const run = index => handlers[index]?.(context, () => run(index + 1));
    await run(0); return context;
  };
  assert(!routes.has("get/query/enable"));
  await request({ confirmed: true }, true);
  for (const confirmed of [undefined, false, "true"]) assert.equal((await request({ confirmed })).body.message, "MC_PLAYERS_INVALID");
  assert.deepEqual(calls, []);
  await request({ confirmed: true, instanceUuid: "other", filename: "/outside", command: "kill" });
  assert.deepEqual(calls, [{ event: "mc-tools/players/query-enable", data: { instanceUuid: "server", confirmed: true } }]);
});
