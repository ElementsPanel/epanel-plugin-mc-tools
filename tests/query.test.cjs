const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { loader } = require("./helpers.cjs");
const { fullStat, queryServer } = require("./query-fixture.cjs");
const { javaQueryTarget, parseJavaQuery, requestJavaQuery } = loader()("daemon/src/backend/players/query.ts");

test("Java Query exchanges the signed challenge and full-stat packets over real UDP and returns full or empty lists", async t => {
  const server = await queryServer(t, { names: ["Alex", "Steve", "Player_3"] });
  const signal = new AbortController().signal;
  assert.deepEqual(await requestJavaQuery("127.0.0.1", server.port, signal, 1000), { names: server.names, maxPlayers: 20 });
  server.names = [];
  assert.deepEqual(await requestJavaQuery("localhost", server.port, signal, 1000), { names: [], maxPlayers: 20 });
  assert.deepEqual(server.requests.map(packet => packet[2]), [0x09, 0x00, 0x09, 0x00]);
  for (const packet of server.requests) for (const byte of packet.subarray(3, 7)) assert(byte <= 15);
});

test("Java Query rejects partial, hidden, duplicate and malformed player lists instead of treating missing players as offline", () => {
  const session = Buffer.from([1, 2, 3, 4]);
  const valid = fullStat(session, ["Alex", "Steve"]);
  const invalidHeader = Buffer.from(valid); invalidHeader[14] = 0;
  for (const packet of [
    valid.subarray(0, 12), valid.subarray(0, valid.length - 1), invalidHeader,
    fullStat(session, [], 2), fullStat(session, ["Alex"], 2), fullStat(session, ["Alex", "alex"]),
    fullStat(session, ["@a"]), fullStat(session, ["Steve\nstop"]), fullStat(session, [], -1),
    fullStat(session, [], 10001), fullStat(session, [], 0, "invalid"), fullStat(session, [], 0, 1000001)
  ]) assert.throws(() => parseJavaQuery(packet), /MC_PLAYERS_QUERY_RESPONSE/);
});

test("Java Query ignores wrong-session datagrams and rejects an invalid challenge", async t => {
  const server = await queryServer(t);
  server.respond = (data, reply) => {
    if (data[2] === 0x09) {
      const wrong = Buffer.from(data.subarray(3, 7)); wrong[0] ^= 0x0f;
      reply(Buffer.concat([Buffer.from([0x09]), wrong, Buffer.from("bad\0")]));
      reply(Buffer.concat([Buffer.from([0x09]), data.subarray(3, 7), Buffer.from("2147483648\0")]));
    }
  };
  await assert.rejects(requestJavaQuery("127.0.0.1", server.port, new AbortController().signal, 1000), /MC_PLAYERS_QUERY_RESPONSE/);
  assert.equal(server.requests.length, 1);
});

function socketFixture() {
  const socket = Object.assign(new EventEmitter(), {
    connect(port, host, callback) { this.target = { port, host }; callback(); },
    send(packet, callback) { this.packets.push(Buffer.from(packet)); callback(); },
    packets: [],
    close() { this.closed = true; }
  });
  const types = [];
  const query = loader({ "node:dgram": { createSocket: type => { types.push(type); return socket; } } })("daemon/src/backend/players/query.ts");
  return { socket, types, ...query };
}

test("Java Query retries lost packets, selects IPv6 sockets, and closes sockets and timers on timeout, network errors or cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  for (const scenario of ["timeout", "error", "cancel"]) {
    const fixture = socketFixture(), abort = new AbortController();
    const pending = fixture.requestJavaQuery("::1", 25565, abort.signal, 2500);
    const rejected = assert.rejects(pending, scenario === "cancel" ? /MC_PLAYERS_NOT_RUNNING/ : /MC_PLAYERS_QUERY_UNAVAILABLE/);
    assert.deepEqual(fixture.types, ["udp6"]);
    assert.equal(fixture.socket.packets.length, 1);
    t.mock.timers.tick(1000);
    assert.equal(fixture.socket.packets.length, 2);
    if (scenario === "timeout") t.mock.timers.tick(1500);
    if (scenario === "error") fixture.socket.emit("error", new Error("ECONNREFUSED"));
    if (scenario === "cancel") abort.abort(new Error("MC_PLAYERS_NOT_RUNNING"));
    await rejected;
    assert(fixture.socket.closed);
    assert.equal(fixture.socket.listenerCount("message"), 0);
    const sends = fixture.socket.packets.length;
    t.mock.timers.tick(10000);
    assert.equal(fixture.socket.packets.length, sends);
  }
  const fixture = socketFixture(), abort = new AbortController(); abort.abort(new Error("MC_PLAYERS_UNAVAILABLE"));
  await assert.rejects(fixture.requestJavaQuery("127.0.0.1", 25565, abort.signal), /MC_PLAYERS_UNAVAILABLE/);
  assert.deepEqual(fixture.types, []);
});

test("Java Query uses only the instance's Query properties, independent of the game or Ping port, with safe address defaults", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "epanel-query-config-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "epanel-query-outside-"));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]));
  const filename = path.join(root, "server.properties");
  await assert.rejects(javaQueryTarget(root), /MC_PLAYERS_QUERY_CONFIG/);
  await fs.writeFile(filename, "enable-query=false\nquery.port=25565\n");
  await assert.rejects(javaQueryTarget(root), /MC_PLAYERS_QUERY_DISABLED/);
  await fs.writeFile(filename, "# enable-query=false\n! Query config\nenable-query: true\nserver-port=25566\nserver-ip=0.0.0.0\n");
  assert.deepEqual(await javaQueryTarget(root), { host: "127.0.0.1", port: 25565 });
  assert.deepEqual(await javaQueryTarget(root, "game.internal"), { host: "game.internal", port: 25565 });
  await fs.appendFile(filename, "query.port=24444\nquery.port=25567\nserver-ip=\\u003a\\u003a\n");
  assert.deepEqual(await javaQueryTarget(root), { host: "::1", port: 25567 });
  assert.deepEqual(await javaQueryTarget(root, "[::1]"), { host: "::1", port: 25567 });
  for (const port of ["", "0", "65536", "-1", "12.5", "not-a-port"]) {
    await fs.writeFile(filename, "enable-query=true\nquery.port=" + port);
    await assert.rejects(javaQueryTarget(root), /MC_PLAYERS_QUERY_CONFIG/);
  }
  await fs.writeFile(filename, "x".repeat(256 * 1024 + 1));
  await assert.rejects(javaQueryTarget(root), /MC_PLAYERS_QUERY_CONFIG/);
  await fs.writeFile(path.join(outside, "server.properties"), "enable-query=true\nquery.port=24444");
  await fs.rm(filename); await fs.symlink(path.join(outside, "server.properties"), filename);
  await assert.rejects(javaQueryTarget(root), /MC_PLAYERS_QUERY_CONFIG/);
});
