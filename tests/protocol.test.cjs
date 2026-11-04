const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { loader } = require("./helpers.cjs");

function javaFixture() {
  const socket = Object.assign(new EventEmitter(), {
    destroy() { this.destroyed = true; },
    write(data) { this.written = data; }
  });
  const { default: Ping } = loader({ "node:net": { connect: () => socket } })("daemon/src/backend/mcping.ts");
  return { socket, ping: new Ping(25565, "localhost") };
}

function legacyPacket(text) {
  const payload = Buffer.from(text, "utf16le").swap16();
  const header = Buffer.from([0xff, 0, 0]);
  header.writeUInt16BE(payload.length / 2, 1);
  return Buffer.concat([header, payload]);
}

test("Java ping handles fragmented UTF-16 packets and shares an in-flight query", async () => {
  const { socket, ping } = javaFixture();
  const pending = ping.getStatus();
  assert.equal(ping.getStatus(), pending);
  socket.emit("connect");
  assert.deepEqual(socket.written, Buffer.from([0xfe, 0x01]));
  const packet = legacyPacket(["§1", "127", "1.21", "你好 世界", "7", "20"].join("\0"));
  for (let i = 0; i < packet.length; i += 3) socket.emit("data", packet.subarray(i, i + 3));
  const result = await pending;
  assert.equal(result.online, true);
  assert.equal(result.motd, "你好 世界");
  assert.equal(result.version, "1.21");
  assert.equal(result.current_players, 7);
  assert.equal(result.max_players, 20);
  assert.equal(socket.destroyed, true);
  assert.equal(ping.client, undefined);
});

test("Java ping rejects malformed, truncated and invalid-count responses and releases sockets", async () => {
  for (const scenario of ["malformed", "truncated", "count", "connection"]) {
    const { socket, ping } = javaFixture();
    const pending = ping.getStatus();
    const rejected = assert.rejects(pending);
    if (scenario === "malformed") socket.emit("data", Buffer.from([0, 0, 0]));
    if (scenario === "truncated") {
      socket.emit("data", Buffer.from([0xff, 0, 20]));
      socket.emit("close");
    }
    if (scenario === "count") socket.emit("data", legacyPacket(["§1", "127", "1.21", "MOTD", "-1", "20"].join("\0")));
    if (scenario === "connection") socket.emit("error", new Error("Connection refused"));
    await rejected;
    assert.equal(socket.destroyed, true);
    assert.equal(ping.status.online, false);
  }
});

test("Java timeout rejects, destroys the socket and resets the pending query", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { socket, ping } = javaFixture();
  const pending = ping.getStatus();
  const rejected = assert.rejects(pending, /timed out/);
  t.mock.timers.tick(15_000);
  await rejected;
  assert.equal(socket.destroyed, true);
  assert.equal(ping.client, undefined);
});

test("cancelling Java and Bedrock queries closes their sockets immediately", async () => {
  const java = javaFixture();
  const javaAbort = new AbortController();
  const javaPending = java.ping.getStatus(javaAbort.signal);
  const javaRejected = assert.rejects(javaPending, /cancelled/);
  javaAbort.abort();
  await javaRejected;
  assert.equal(java.socket.destroyed, true);
  const bedrock = bedrockFixture();
  const bedrockAbort = new AbortController();
  const bedrockPending = bedrock.requestBedrockStatus("localhost", 19132, bedrockAbort.signal);
  const bedrockRejected = assert.rejects(bedrockPending, /cancelled/);
  bedrockAbort.abort();
  await bedrockRejected;
  assert.equal(bedrock.socket.closed, true);
});

function bedrockPacket() {
  const payload = Buffer.from("MCPE;测试服务器;776;1.21.60;8;30;server-id;world;Survival;");
  const header = Buffer.alloc(35);
  header[0] = 0x1c;
  Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex").copy(header, 17);
  header.writeUInt16BE(payload.length, 33);
  return Buffer.concat([header, payload]);
}

function bedrockFixture() {
  const socket = Object.assign(new EventEmitter(), {
    connect(port, host, callback) { this.target = { port, host }; callback(); },
    send(data, callback) { this.sent = data; callback(); },
    close() { this.closed = true; }
  });
  return { socket, ...loader({ "node:dgram": { createSocket: () => socket } })("daemon/src/backend/bedrock.ts") };
}

test("Bedrock RakNet pong uses the UTF-8 payload after its binary header", async () => {
  const f = bedrockFixture();
  const pending = f.requestBedrockStatus("localhost", 19132);
  assert.deepEqual(f.socket.target, { host: "localhost", port: 19132 });
  assert.equal(f.socket.sent[0], 1);
  assert.equal(f.socket.sent.length, 33);
  assert.deepEqual(f.socket.sent.subarray(9, 25), Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex"));
  f.socket.emit("message", bedrockPacket());
  const response = await pending;
  assert.equal(response.online, true);
  assert.equal(response.motd, "测试服务器");
  assert.equal(response.current_players, 8);
  assert.equal(response.max_players, 30);
  assert.equal(response.version, "1.21.60");
  assert.equal(f.socket.closed, true);
});

test("Bedrock rejects malformed payloads, handles socket errors and closes on timeout", async (t) => {
  const f = bedrockFixture();
  for (const packet of [Buffer.alloc(0), Buffer.alloc(35), bedrockPacket().subarray(0, 36)]) {
    assert.throws(() => f.parseBedrockStatus(packet, "localhost", 19132), /Invalid|Incomplete/);
  }
  const invalid = bedrockPacket();
  invalid[invalid.indexOf(Buffer.from(";8;30;")) + 1] = 0x78;
  assert.throws(() => f.parseBedrockStatus(invalid, "localhost", 19132), /Invalid/);
  for (const reason of ["timeout", "error", "malformed"]) {
    const query = bedrockFixture();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = query.requestBedrockStatus("localhost", 19132);
    const rejected = assert.rejects(pending);
    if (reason === "timeout") t.mock.timers.tick(3000);
    if (reason === "error") query.socket.emit("error", new Error("UDP unavailable"));
    if (reason === "malformed") query.socket.emit("message", Buffer.alloc(1));
    await rejected;
    assert.equal(query.socket.closed, true);
    t.mock.timers.reset();
  }
});
