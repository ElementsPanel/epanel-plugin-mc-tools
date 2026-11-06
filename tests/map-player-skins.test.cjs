const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loader, deferred } = require("./helpers.cjs");
const { PlayerSkinService } = loader()("panel/src/backend/player-skins.ts");
const uuid = "a".repeat(32), texture = "b".repeat(64), skin = "https://textures.minecraft.net/texture/" + texture;
const session = url => ({ properties: [{ name: "textures", value: Buffer.from(JSON.stringify({ textures: { SKIN: { url } } })).toString("base64") }] });

test("skin lookup resolves the player name via Mojang, deduplicates names case-insensitively and caches the HTTPS texture", async t => {
  const calls = [], service = new PlayerSkinService(); t.after(() => service.dispose());
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push(url); assert.equal(options.redirect, "error"); assert(options.signal);
    return Response.json(url.includes("api.mojang.com") ? { id: uuid } : session(skin.replace("https:", "http:")));
  });
  assert.deepEqual(await Promise.all([service.get("Steve"), service.get("steve")]), [skin, skin]);
  assert.equal(await service.get("STEVE"), skin);
  assert.deepEqual(calls, ["https://api.mojang.com/users/profiles/minecraft/steve", "https://sessionserver.mojang.com/session/minecraft/profile/" + uuid]);
});

test("unavailable skins fall back with a negative cache and untrusted texture URLs are rejected", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(null, { status: 404 }); });
  const service = new PlayerSkinService(); t.after(() => service.dispose());
  assert.equal(await service.get("Missing"), null); assert.equal(await service.get("missing"), null); assert.equal(calls, 1);
  for (const name of ["@a", "../Steve", "a".repeat(17), ["Steve"], null]) assert.equal(await service.get(name), null);
  assert.equal(calls, 1);
  for (const url of ["http://localhost/secret", skin + "?redirect=http://localhost", "https://textures.minecraft.net.attacker.test/texture/" + texture]) {
    const service = new PlayerSkinService(); t.after(() => service.dispose());
    t.mock.method(globalThis, "fetch", async urlRequested => Response.json(urlRequested.includes("api.mojang.com") ? { id: uuid } : session(url)));
    assert.equal(await service.get("Steve"), null);
  }
});

test("oversized Mojang responses are bounded and disposal aborts pending name lookups", async t => {
  const service = new PlayerSkinService();
  t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(70_000)));
  assert.equal(await service.get("Huge"), null);
  const entered = deferred();
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    entered.resolve(signal);
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const pending = service.get("Alex"), signal = await entered.promise;
  service.dispose(); assert(signal.aborted); assert.equal(await pending, null);
});

test("browser skin requests use player names, share avatars across markers and lists, and bound concurrency", async t => {
  const { playerSkin } = loader()("panel/src/map/player-skins.ts");
  const calls = [], gates = [];
  let active = 0, maximum = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.credentials, "omit"); calls.push(url);
    active++; maximum = Math.max(maximum, active);
    const gate = deferred(); gates.push(gate); await gate.promise; active--;
    return Response.json({ status: 200, data: { skin } });
  });
  const jobs = [...Array(24)].map((_, i) => playerSkin("Player" + i));
  jobs.push(playerSkin("player0"));
  for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); for (const gate of gates) gate.resolve(); }
  assert((await Promise.all(jobs)).every(value => value === skin));
  assert.equal(calls.length, 24); assert.equal(maximum, 6);
  assert.equal(new URL(calls[0], "https://panel.test").searchParams.get("name"), "Player0");
  assert.equal(await playerSkin("PLAYER0"), skin); assert.equal(calls.length, 24);
});
