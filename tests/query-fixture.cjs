const assert = require("node:assert/strict");
const dgram = require("node:dgram");

function fullStat(session, names = ["Alex"], numPlayers = names.length, maxPlayers = 20) {
  const fields = ["hostname", "Test server", "gametype", "SMP", "game_id", "MINECRAFT", "version", "1.21", "numplayers", String(numPlayers), "maxplayers", String(maxPlayers), "hostport", "25565", "hostip", "127.0.0.1"];
  return Buffer.concat([
    Buffer.from([0x00]), session,
    Buffer.from("splitnum\0\x80\0", "latin1"),
    Buffer.from(fields.join("\0") + "\0", "utf8"),
    Buffer.from("\0\x01player_\0\0"),
    Buffer.from(names.map(name => name + "\0").join("") + "\0", "utf8")
  ]);
}

async function queryServer(t, options = {}) {
  const socket = dgram.createSocket("udp4");
  const server = { socket, names: ["Alex"], maxPlayers: 20, requests: [], ...options };
  socket.on("message", (data, remote) => {
    server.requests.push(Buffer.from(data));
    const reply = packet => socket.send(packet, remote.port, remote.address);
    if (server.respond) return server.respond(data, reply);
    if (server.silent) return;
    assert.equal(data.readUInt16BE(0), 0xfefd);
    const session = data.subarray(3, 7);
    if (data[2] === 0x09) {
      assert.equal(data.length, 7);
      reply(Buffer.concat([Buffer.from([0x09]), session, Buffer.from("-123456\0")]));
    } else {
      assert.equal(data.length, 15);
      assert.equal(data[2], 0x00);
      assert.equal(data.readInt32BE(7), -123456);
      assert.equal(data.readUInt32BE(11), 0);
      reply(fullStat(session, server.names, server.numPlayers ?? server.names.length, server.maxPlayers));
    }
  });
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.bind(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => socket.close(resolve)));
  server.port = socket.address().port;
  return server;
}

module.exports = { fullStat, queryServer };
