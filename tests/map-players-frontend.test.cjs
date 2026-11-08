const assert = require("node:assert/strict");
const { test } = require("node:test");
const vue = require("vue");
const { loader, deferred } = require("./helpers.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
const load = loader({ "../settings": { t: key => key } });
const { useMapPlayers } = load("panel/src/map/player-state.ts");
const { playerMarkers, worldForPlayer } = load("panel/src/map/player-markers.ts");

function mount(t, api) {
  const renderer = vue.createRenderer({ createElement: () => ({}), createComment: () => ({}), createText: () => ({}),
    insert() {}, remove() {}, patchProp() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp({ setup: () => useMapPlayers(api, error => error.message), render: () => null });
  app.mount({}); let closed = false;
  const close = () => { if (!closed) { closed = true; app.unmount(); } }; t.after(close);
  return { state: app._instance.setupState, close };
}
const roster = (enabled = false) => ({ edition: "java", running: true, rconEnabled: enabled, players: [], warnings: [] });

test("opening a private map prompts once, cancellation makes no writes, and confirmation is required before enabling", async t => {
  let enables = 0, polls = 0; const signals = [];
  const f = mount(t, {
    players: async signal => { signals.push(signal); polls++; return roster(enables > 0); },
    enableRcon: async signal => { signals.push(signal); enables++; return { changed: true, restartRequested: true }; }
  });
  await tick(); assert.equal(f.state.prompt, true); assert.equal(enables, 0);
  f.state.prompt = false; await f.state.enable(); assert.equal(enables, 0);
  await f.state.load(); assert.equal(f.state.prompt, false); assert.equal(polls, 2);
  f.state.prompt = true; await f.state.enable(); assert.equal(enables, 1);
  assert.equal(f.state.success, "MC_MAP_RCON_RESTART_REQUESTED"); assert.equal(f.state.prompt, false);
  f.close(); assert(signals.every(signal => signal.aborted));
});

test("maps without a readable RCON config stay silent instead of prompting", async t => {
  const f = mount(t, { players: async () => ({ ...roster(), rconConfigured: false }), enableRcon: async () => ({ changed: true, restartRequested: false }) });
  await tick(); assert.equal(f.state.prompt, false); assert.equal(f.state.error, "");
});

test("public maps never prompt, stale reads are discarded on close, and restart failures remain visible after polling", async t => {
  const publicView = mount(t, { players: async () => roster() });
  await tick(); assert.equal(publicView.state.prompt, false);
  const gate = deferred(), late = mount(t, { players: () => gate.promise }); late.close();
  gate.resolve(roster(true)); await tick(); assert.equal(late.state.roster, undefined);
  const failed = mount(t, { players: async () => roster(true), enableRcon: async () => { throw new Error("MC_MAP_RCON_RESTART_FAILED"); } });
  await tick(); failed.state.prompt = true; await failed.state.enable(); await failed.state.load();
  assert.equal(failed.state.error, "MC_MAP_RCON_RESTART_FAILED");
});

test("polling refreshes visible maps, filters names, and removes timers on unmount", async t => {
  const timers = new Map(); let reads = 0;
  t.mock.method(globalThis, "setInterval", (fn, delay) => { timers.set(delay, fn); return delay; });
  t.mock.method(globalThis, "clearInterval", id => timers.delete(id));
  const f = mount(t, { players: async () => { reads++; return { ...roster(true), players: [{ name: "Steve" }, { name: "Alex" }] }; } });
  await tick(); assert.equal(reads, 1); timers.get(1000)(); assert.equal(reads, 1, "local clock updates do not call RCON");
  const poll = timers.get(3000); poll(); await tick(); assert.equal(reads, 2);
  f.state.search = "STE"; assert.deepEqual(f.state.players.map(player => player.name), ["Steve"]);
  f.close(); assert.equal(timers.size, 0); poll(); assert.equal(reads, 2);
});

test("markers use the selected world and head height, project yaw with the camera, and hide missing/offscreen positions", () => {
  const worlds = [{ id: "world", dimension: "minecraft:overworld" }, { id: "nether", dimension: "minecraft:the_nether" }];
  const steve = { name: "Steve", position: { x: 5, y: 64, z: -8, yaw: 0, world: "world", dimension: "minecraft:overworld" } };
  const alex = { name: "Alex", position: { ...steve.position, world: "nether", dimension: "minecraft:the_nether" } };
  const seen = [];
  const markers = playerMarkers([steve, alex, { name: "Missing" }], worlds, "world", point => { seen.push(point); return { x: point.x * 2 + 100, y: point.z * 2 + 80 }; });
  assert.equal(markers.length, 1); assert.equal(markers[0].name, "Steve"); assert.equal(markers[0].x, 110); assert.equal(markers[0].y, 64);
  assert.equal(seen[0].y, 65.9); assert.equal(markers[0].angle, 180);
  const rotated = playerMarkers([steve], worlds, "world", point => ({ x: -point.z, y: point.x }));
  assert.equal(rotated[0].angle, 270);
  assert.deepEqual(playerMarkers([steve], worlds, "world", () => undefined), []);
  assert.equal(worldForPlayer({ ...steve, position: { ...steve.position, world: undefined } }, [...worlds, { id: "import", dimension: "minecraft:overworld" }]), undefined);
  assert.equal(worldForPlayer(steve, worlds).id, "world");
});
