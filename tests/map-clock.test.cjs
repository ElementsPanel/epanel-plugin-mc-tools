const assert = require("node:assert/strict");
const { test } = require("node:test");
const vue = require("vue");
const { loader } = require("./helpers.cjs");
const { useWorldClock } = loader()("panel/src/map/world-clock.ts");

function fixture(t) {
  let now = 0, update, cleared = false;
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setInterval", (fn, delay) => { assert.equal(delay, 1000); update = fn; return 1; });
  t.mock.method(globalThis, "clearInterval", () => { cleared = true; });
  const roster = vue.ref();
  const renderer = vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp({ setup: () => ({ times: useWorldClock(roster) }), render: () => null });
  app.mount({}); const state = app._instance.setupState; let closed = false;
  const close = () => { if (!closed) { closed = true; app.unmount(); } }; t.after(close);
  return { state, roster, close, cleared: () => cleared, advance: time => { now = time; update(); },
    sample: (ticks, sampledAt = now, extra = {}) => { roster.value = { edition: "java", running: true, rconEnabled: true, players: [], warnings: [], worldTimes: { world: ticks }, worldTimeSampledAt: sampledAt, ...extra }; } };
}

test("clock advances each local second, follows actual elapsed time and calibrates to RCON without cached-sample resets", t => {
  const f = fixture(t); f.sample(0, 100000);
  f.advance(1000); assert.equal(f.state.times.world, 20);
  f.advance(2000); assert.equal(f.state.times.world, 40);
  f.sample(0, 100000); assert.equal(f.state.times.world, 40, "same cached sample keeps its original anchor");
  f.advance(3000); f.sample(60, 103000); assert.equal(f.state.times.world, 60);
  f.advance(4500); assert.equal(f.state.times.world, 90, "late timer callbacks do not slow the clock");
  f.close(); assert(f.cleared());
});

test("clock handles dawn rollover, pauses, resumed clocks and manual time jumps", t => {
  const f = fixture(t); f.sample(23980);
  f.advance(1000); assert.equal(f.state.times.world, 0);
  f.advance(3000); f.sample(40); f.advance(4000); assert.equal(f.state.times.world, 60);
  f.advance(6000); f.sample(40); f.advance(8000); assert.equal(f.state.times.world, 40, "unchanged new sample detects a paused world");
  f.advance(9000); f.sample(100); f.advance(10000); assert.equal(f.state.times.world, 120);
  f.advance(12000); f.sample(18000); f.advance(13000); assert.equal(f.state.times.world, 18020, "time set anchors the clock without a huge inferred rate");
});

test("clock estimates independent world rates and clears unavailable, offline and invalid samples", t => {
  const f = fixture(t); f.sample(0, 0, { worldTimes: { world: 0, moon: 100 } });
  f.advance(3000); f.sample(30, 3000, { worldTimes: { world: 30, moon: 220 } });
  f.advance(4000); assert.deepEqual(f.state.times, { world: 40, moon: 260 });
  f.advance(20000); assert.deepEqual(f.state.times, { world: 200, moon: 900 }, "the clock keeps running from its only calibration");
  for (const extra of [{ running: false }, { rconEnabled: false }, { worldTimes: {} }, { worldTimes: { world: NaN } }]) {
    f.sample(100, 20000, extra); assert.deepEqual(f.state.times, {});
  }
  // A roster without worldTimes means "already calibrated": keep counting.
  f.sample(0, 21000); f.advance(22000);
  const before = f.state.times.world;
  f.roster.value = { edition: "java", running: true, rconEnabled: true, players: [], warnings: [] };
  f.advance(23000);
  assert.equal(f.state.times.world, before + 20, "an uncalibrated read keeps the local clock");
  f.roster.value = undefined; assert.deepEqual(f.state.times, {});
  f.sample(0, 21000); assert.equal(f.state.times.world, 0, "recovery starts from a fresh sample");
});

test("the roster is calibrated once per visit and later polls only ask for players", async (t) => {
  const intervals = [];
  t.mock.method(globalThis, "setInterval", (fn, delay) => { intervals.push({ fn, delay }); return intervals.length; });
  t.mock.method(globalThis, "clearInterval", () => {});
  const { useMapPlayers } = loader({ "../settings": { t: (key) => key } })("panel/src/map/player-state.ts");
  const calls = [];
  const roster = { edition: "java", running: true, rconEnabled: true, players: [], warnings: [], worldTimes: { world: 6000 }, worldTimeSampledAt: 0 };
  const api = { players: async (signal, time) => { calls.push(time); return roster; } };
  const renderer = vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp({ setup: () => useMapPlayers(api, (error) => String(error)), render: () => null });
  app.mount({}); t.after(() => app.unmount());
  const poll = intervals.find((item) => item.delay === 3000).fn;

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [true], "the first read asks for an RCON calibration");
  poll();
  await new Promise((resolve) => setImmediate(resolve));
  poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [true, false, false], "later polls never query the clock again");
});
