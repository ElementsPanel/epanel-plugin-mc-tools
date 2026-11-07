const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loader } = require("./helpers.cjs");
const load = loader();
const { embedCommand, embedOrigins } = load("shared/embed.ts");
const { createEmbedBridge } = load("panel/src/map/embed.ts");

test("the embed allowlist normalizes origins and rejects anything that is not a bare origin", () => {
  assert.deepEqual(embedOrigins("https://a.example\nhttp://localhost:3000"), ["https://a.example", "http://localhost:3000"]);
  // Hosts are case-insensitive, so both entries collapse into one origin.
  assert.deepEqual(embedOrigins("https://A.example/, https://a.example"), ["https://a.example"]);
  assert.deepEqual(embedOrigins(["https://b.example", " https://c.example "]), ["https://b.example", "https://c.example"]);
  assert.deepEqual(embedOrigins(undefined), []);
  for (const value of ["*", "https://a.example/path", "javascript:alert(1)", "ftp://a.example", "https://user:pass@a.example", "https://a.example?x=1", "a.example"]) {
    assert.deepEqual(embedOrigins(value), [], value);
    assert.throws(() => embedOrigins(value, true), /MC_MAP_EMBED_INVALID/, value);
  }
  assert.equal(embedOrigins(Array.from({ length: 20 }, (_, i) => `https://s${i}.example`)).length, 16);
  assert.throws(() => embedOrigins(Array.from({ length: 20 }, (_, i) => `https://s${i}.example`), true), /MC_MAP_EMBED_INVALID/);
  assert.throws(() => embedOrigins(42, true), /MC_MAP_EMBED_INVALID/);
});

test("only documented commands are accepted and malformed entries are dropped", () => {
  assert.deepEqual(embedCommand({ type: "mcmap:hello" }), { type: "mcmap:hello" });
  assert.deepEqual(embedCommand({
    type: "mcmap:markers",
    markers: [
      { id: "base", x: 10.4, z: -20, label: "  基地  ", icon: "mdi-home", color: "#f00" },
      { id: "bad name", x: 0, z: 0 },
      { id: "far", x: 40_000_000, z: 0 },
      { id: "noz", x: 1 },
      { id: "script", x: 1, z: 1, icon: "javascript:alert(1)", color: "red" },
      { id: "y", x: 1, z: 1, y: 5000 }
    ]
  }), {
    type: "mcmap:markers",
    markers: [{ id: "base", x: 10, z: -20, label: "基地", icon: "mdi-home", color: "#f00" }, { id: "script", x: 1, z: 1 }, { id: "y", x: 1, z: 1 }]
  });
  assert.deepEqual(embedCommand({
    type: "mcmap:menu",
    items: [{ id: "home", label: "Home", x: 1, z: 2, zoom: 6, icon: "mdi-pin" }, { id: "n", label: "no coords" }, { id: "z", label: "bad zoom", zoom: 99 }]
  }), { type: "mcmap:menu", items: [{ id: "home", label: "Home", icon: "mdi-pin", zoom: 6, x: 1, z: 2 }, { id: "n", label: "no coords" }, { id: "z", label: "bad zoom" }] });
  assert.deepEqual(embedCommand({ type: "mcmap:focus", x: 5, z: 6, zoom: 3, render: "3d" }), { type: "mcmap:focus", focus: { x: 5, z: 6, zoom: 3, render: "3d" } });
  for (const value of [null, 1, "x", [], {}, { type: "other" }, { type: "mcmap:focus", x: 1 },
    { type: "mcmap:markers", markers: "x" }, { type: "mcmap:markers", markers: Array(201).fill({ id: "a", x: 0, z: 0 }) },
    { type: "mcmap:menu", items: Array(51).fill({ id: "a", label: "b" }) }]) {
    assert.equal(embedCommand(value), undefined, JSON.stringify(value)?.slice(0, 40));
  }
});

function port() {
  const listeners = new Set(), sent = [], replies = [];
  const source = { postMessage: (message, origin) => replies.push({ message, origin }) };
  return {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    parent: { postMessage: (message, origin) => sent.push({ message, origin }) },
    listeners, sent, replies, source,
    emit: (data, origin = "https://site.example", value = source) => { for (const listener of [...listeners]) listener({ data, origin, source: value }); }
  };
}

function bridgeFixture(t) {
  const target = port();
  const calls = { focus: [], ready: 0, view: 0 };
  const bridge = createEmbedBridge(target, {
    origins: () => ["https://site.example"],
    ready: () => { calls.ready++; return { map: "survival", worlds: [{ id: "w", name: "World" }], embed: true }; },
    view: () => { calls.view++; return { map: "survival", world: "w", x: 1, z: 2, zoom: 3, render: "2d" }; },
    focus: (value) => { calls.focus.push(value); return value.x !== 99; }
  });
  t.after(() => bridge.stop());
  bridge.start();
  return { target, bridge, calls };
}

test("the bridge ignores other origins and applies markers, menu and focus from allowed ones", (t) => {
  const f = bridgeFixture(t);
  f.target.emit({ type: "mcmap:markers", markers: [{ id: "a", x: 1, z: 2 }] }, "https://evil.example");
  assert.deepEqual(f.bridge.markers.value, [], "messages from other origins are dropped");

  f.target.emit({ type: "mcmap:markers", markers: [{ id: "a", x: 1, z: 2, label: "A" }] });
  f.target.emit({ type: "mcmap:menu", items: [{ id: "m", label: "Menu" }] });
  assert.deepEqual(f.bridge.markers.value, [{ id: "a", x: 1, z: 2, label: "A" }]);
  assert.deepEqual(f.bridge.menu.value, [{ id: "m", label: "Menu" }]);

  f.target.emit({ type: "mcmap:focus", x: 10, z: 20, zoom: 4 });
  assert.deepEqual(f.calls.focus, [{ x: 10, z: 20, zoom: 4 }]);
  f.target.emit({ type: "mcmap:focus", x: 99, z: 20 });
  assert.deepEqual(f.target.replies.at(-1), { message: { type: "mcmap:error", code: "MC_MAP_NOT_READY" }, origin: "https://site.example" });

  f.bridge.notifyMarker("a");
  f.bridge.notifyMenu("m");
  assert.deepEqual(f.target.replies.slice(-2), [
    { message: { type: "mcmap:marker", id: "a" }, origin: "https://site.example" },
    { message: { type: "mcmap:menu", id: "m" }, origin: "https://site.example" }
  ]);
});

test("hello answers with readiness and the current view, and view updates are throttled", (t) => {
  const f = bridgeFixture(t);
  let now = 0;
  t.mock.method(Date, "now", () => now);
  f.target.emit({ type: "mcmap:hello" });
  assert.deepEqual(f.target.replies, [
    { message: { type: "mcmap:ready", map: "survival", worlds: [{ id: "w", name: "World" }], embed: true }, origin: "https://site.example" },
    { message: { type: "mcmap:view", map: "survival", world: "w", x: 1, z: 2, zoom: 3, render: "2d" }, origin: "https://site.example" }
  ]);
  f.bridge.publishView();
  assert.equal(f.target.replies.length, 3);
  f.bridge.publishView();
  assert.equal(f.target.replies.length, 3, "a second update inside the window is skipped");
  now += 300;
  f.bridge.publishView();
  assert.equal(f.target.replies.length, 4);

  // Events stay silent until a parent talked to us.
  const idle = bridgeFixture(t);
  idle.bridge.notifyMarker("a");
  assert.deepEqual(idle.target.replies, []);
  idle.bridge.announce();
  assert.deepEqual(idle.target.sent, [{ message: { type: "mcmap:ready", map: "survival", worlds: [{ id: "w", name: "World" }], embed: true }, origin: "https://site.example" }]);
});

test("stopping the bridge detaches the listener", (t) => {
  const f = bridgeFixture(t);
  assert.equal(f.target.listeners.size, 1);
  f.bridge.stop();
  assert.equal(f.target.listeners.size, 0);
  f.target.emit({ type: "mcmap:markers", markers: [{ id: "a", x: 1, z: 2 }] });
  assert.deepEqual(f.bridge.markers.value, []);
});
