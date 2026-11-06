const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { loader } = require("./helpers.cjs");
const { MapPlayerVisibility, MapVisibilityState, mapCommand } = loader()("daemon/src/backend/map/visibility.ts");

const LINE = (text) => `[12:00:00] [Server thread/INFO]: ${text}\r\n`;
const KEY = "McToolsMapVisibility/hidden-players";
const hooks = (events) => ({
  changed: (id) => events.push(["changed", id]),
  confirm: (id, name, hidden) => events.push(["confirm", id, name, hidden])
});

function memoryStorage(seed) {
  const values = new Map();
  if (seed !== undefined) values.set(KEY, seed);
  return {
    values,
    load(category, type, entity) {
      const raw = values.get(category + "/" + entity);
      return raw === undefined ? null : Object.assign(new type(), JSON.parse(JSON.stringify(raw)));
    },
    store(category, entity, value) { values.set(category + "/" + entity, JSON.parse(JSON.stringify(value))); }
  };
}

function fixture(t, storage) {
  storage ??= memoryStorage();
  const events = [];
  const visibility = new MapPlayerVisibility(hooks(events), storage);
  const open = () => {
    const instance = new EventEmitter();
    instance.status = () => 3;
    t.after(() => visibility.dispose());
    return instance;
  };
  return { events, storage, visibility, open, instance: open() };
}

test("only a complete $-prefixed chat line counts as a map visibility command", () => {
  assert.deepEqual(mapCommand("[12:00:00] [Server thread/INFO]: <Steve> $mapos off"), { name: "Steve", hidden: true });
  assert.deepEqual(mapCommand("[12:00:00] [Server thread/INFO]: [Not Secure] <Alex_1> $mapos ON"), { name: "Alex_1", hidden: false });
  assert.deepEqual(mapCommand("[12:00:00] [Async Chat Thread - #0/INFO]: <Player.one> $mapos  off  "), { name: "Player.one", hidden: true });
  // Spigot, Paper and Velocity merge the level into the time bracket.
  assert.deepEqual(mapCommand("[20:50:45 INFO]: [Not Secure] <ress2338396> $mapos off"), { name: "ress2338396", hidden: true });
  assert.deepEqual(mapCommand("[20:50:45 INFO]: <Steve> $mapos on"), { name: "Steve", hidden: false });
  assert.deepEqual(mapCommand("[20:50:45 WARN]: <Steve> $mapos off\n"), { name: "Steve", hidden: true });
  // Forge and NeoForge prepend their own date and logger brackets.
  assert.deepEqual(mapCommand("[06Nov2026 20:51:01.533] [Server thread/INFO] [minecraft/DedicatedServer]: <Steve> $mapos off"),
    { name: "Steve", hidden: true });
  assert.deepEqual(mapCommand("§8[20:51:01 INFO]: §f<Steve> §7$mapos off"), { name: "Steve", hidden: true });
  for (const line of ["<Steve> hello", "<Steve> $mapos maybe", "<Steve> $mapos off please", "<Steve> $maposoff",
    "<> $mapos off", "$mapos off", "Steve issued server command: /$mapos off", "<Steve> $mapos off; stop",
    "<Steve> someone said [x] <Alex> $mapos off", "[20:50:45 INFO]: said <Steve> $mapos off", "[20:50:45 INFO]: <Steve> said $mapos off"]) {
    assert.equal(mapCommand(line), undefined, line);
  }
});

test("chat commands hide a player, save the entity and restore on demand", (t) => {
  const f = fixture(t);
  f.visibility.track("server", f.instance);
  f.visibility.track("server", f.instance);
  assert.equal(f.instance.listenerCount("data"), 1, "one console listener per instance");
  assert.equal(f.instance.listenerCount("exit"), 1);
  assert.deepEqual([...f.visibility.hiddenPlayers("server").values()], []);

  f.instance.emit("data", LINE("<Steve> hello") + LINE("<Steve> $mapos off"));
  assert.deepEqual([...f.visibility.hiddenPlayers("server").values()], ["Steve"]);
  assert.deepEqual(f.storage.values.get(KEY), { entries: [{ instanceUuid: "server", names: ["Steve"] }] });
  assert.deepEqual(f.events, [["changed", "server"], ["confirm", "server", "Steve", true]]);

  f.instance.emit("data", "[12:01:00] [Server thread/INFO]: <Alex> $mapos o");
  assert.deepEqual([...f.visibility.hiddenPlayers("server").values()], ["Steve"], "a partial line waits for the rest");
  f.instance.emit("data", "ff\r\n");
  assert.deepEqual([...f.visibility.hiddenPlayers("server").values()], ["Steve", "Alex"]);

  const repeated = f.events.length;
  f.instance.emit("data", LINE("<Alex> $mapos off"));
  assert.deepEqual(f.events.slice(repeated), [["confirm", "server", "Alex", true]], "a repeated command only confirms");

  f.instance.emit("data", LINE("<Steve> $mapos on"));
  assert.deepEqual([...f.visibility.hiddenPlayers("server").values()], ["Alex"]);
  assert.deepEqual(f.storage.values.get(KEY), { entries: [{ instanceUuid: "server", names: ["Alex"] }] });
  assert.deepEqual(f.events.at(-2), ["changed", "server"]);
});

test("the stored entity is restored on the next start and isolated per instance", (t) => {
  const storage = memoryStorage({ entries: [
    { instanceUuid: "server", names: ["Steve", "steve", "bad name", 42, "<script>"] },
    { instanceUuid: "second", names: ["Alex"] },
    { instanceUuid: "", names: ["ignored"] }
  ] });
  const f = fixture(t, storage);
  assert.deepEqual([...f.visibility.hiddenPlayers("server").values()], ["Steve"], "invalid and duplicate names are dropped");
  assert.deepEqual([...f.visibility.hiddenPlayers("second").values()], ["Alex"]);
  assert.deepEqual([...f.visibility.hiddenPlayers("missing").values()], []);

  f.visibility.track("server", f.instance);
  f.instance.emit("data", LINE("<Steve> $mapos on"));
  assert.deepEqual(f.storage.values.get(KEY), { entries: [{ instanceUuid: "second", names: ["Alex"] }] });
  assert.deepEqual([...f.visibility.hiddenPlayers("second").values()], ["Alex"], "other instances keep their state");
});

test("disposing detaches console listeners and the map keeps working without storage", (t) => {
  const f = fixture(t);
  f.visibility.track("server", f.instance);
  f.instance.emit("data", LINE("<Steve> $mapos off"));
  f.visibility.dispose();
  assert.equal(f.instance.listenerCount("data"), 0);
  assert.equal(f.instance.listenerCount("exit"), 0);

  const bare = new MapPlayerVisibility(hooks([]));
  const instance = new EventEmitter();
  bare.track("server", instance);
  instance.emit("data", LINE("<Steve> $mapos off"));
  assert.deepEqual([...bare.hiddenPlayers("server").values()], ["Steve"]);
  bare.dispose();
});

test("damaged or failing storage never breaks the map", (t) => {
  const damaged = { load: () => Object.assign(new MapVisibilityState(), { entries: "nope" }), store() {} };
  const f = fixture(t, damaged);
  assert.deepEqual([...f.visibility.hiddenPlayers("server").values()], []);
  f.visibility.track("server", f.instance);
  f.instance.emit("data", LINE("<Alex> $mapos off"));
  assert.deepEqual([...f.visibility.hiddenPlayers("server").values()], ["Alex"]);

  const failing = { load() { throw new Error("disk"); }, store() { throw new Error("disk"); } };
  const g = fixture(t, failing);
  g.visibility.track("server", g.instance);
  g.instance.emit("data", LINE("<Alex> $mapos off"));
  assert.deepEqual([...g.visibility.hiddenPlayers("server").values()], ["Alex"], "memory keeps the state");
});
