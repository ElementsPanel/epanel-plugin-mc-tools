const assert = require("node:assert/strict");
const { test } = require("node:test");
const vue = require("vue");
const { loader, deferred } = require("./helpers.cjs");

test("player action registers once in both console interfaces and requires an eligible instance and daemon feature", () => {
  const actions = [];
  const ctx = { routes: { add() {} }, i18n: { define() {}, translate: key => key }, actions: { instances: actions, instance: action => actions.push(action) } };
  const { apply } = loader()("panel/src/frontend.ts");
  apply(ctx); apply(ctx);
  assert.equal(actions.filter(action => action.id === "mc-players").length, 1);
  const action = actions.find(action => action.id === "mc-players");
  assert(action.normalComponent && action.desktopComponent);
  assert.equal(action.title(), "MC_PLAYERS_TITLE");
  const context = { instanceId: "server", daemonId: "node", daemon: { features: { mcPlayers: true } }, instanceInfo: { config: { type: "minecraft/java" } } };
  for (const type of ["minecraft/java", "minecraft/java/paper", "minecraft/bedrock"]) assert(action.condition({ ...context, instanceInfo: { config: { type } } }));
  for (const change of [{ instanceId: "" }, { daemonId: "" }, { isGlobalTerminal: true }, { daemon: {} }, ...["minecraft/java/bungeecord", "minecraft/java/velocity", "steam/universal"].map(type => ({ instanceInfo: { config: { type } } }))]) assert.equal(action.condition({ ...context, ...change }), false);
});

test("player API authenticates, validates POST bodies, scopes requests and forwards cancellation without using GET mutations", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests = []; let logins = 0;
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ status: 200, data: { ok: true } }) }; };
  const { playersApi, playersError } = loader({
    "@elements-panel/sdk": { ctx: { get: () => ({ api: { userInfoApi: () => ({ execute: async () => { logins++; return { value: { token: "test-token" } }; } }) } }) } },
    "../settings": { t: key => "translated:" + key }
  })("panel/src/players/api.ts");
  const api = playersApi("server & one", "node");
  const signal = new AbortController().signal;
  await api.list(signal);
  await api.action({ action: "gamemode", player: "Alex", mode: "creative", command: "stop" }, signal);
  assert.equal(logins, 1);
  const url = new URL(requests[1].url, "http://localhost/panel/");
  assert.equal(url.pathname, "/panel/api/mc-tools/players/action");
  assert.equal(url.searchParams.get("uuid"), "server & one");
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[0].options.method, "GET");
  assert.equal(requests[1].options.headers.Authorization, "Bearer test-token");
  assert.equal(requests[1].options.signal, signal);
  assert.deepEqual(JSON.parse(requests[1].options.body), { action: "gamemode", player: "Alex", mode: "creative" });
  assert.throws(() => api.action({ action: "op", player: "@a" }, signal), /MC_PLAYERS_INVALID_NAME/);
  assert.equal(requests.length, 2);
  await api.enableQuery(signal);
  assert.equal(requests[2].options.method, "POST");
  assert.equal(new URL(requests[2].url, "http://localhost").pathname, "/api/mc-tools/players/query/enable");
  assert.deepEqual(JSON.parse(requests[2].options.body), { confirmed: true });
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ status: 403, data: "Forbidden" }) });
  await assert.rejects(api.list(signal), /Forbidden/);
  assert.equal(playersError(new Error("remote error: MC_PLAYERS_BUSY")), "translated:MC_PLAYERS_BUSY");
});

function mountedState(t, api) {
  const usePlayers = loader({ "./api": { playersApi: () => api, playersError: error => error.message }, "../settings": { t: key => key } })("panel/src/players/state.ts").usePlayers;
  const renderer = vue.createRenderer({
    createElement: () => ({}), createComment: () => ({}), createText: () => ({}), insert() {}, remove() {}, patchProp() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null
  });
  const app = renderer.createApp({ setup: () => usePlayers("server", "node"), render: () => null });
  app.mount({}); t.after(() => app.unmount());
  return { view: app._instance.setupState, close: () => app.unmount() };
}

function roster() {
  return { edition: "java", running: true, onlineAvailable: true, maxPlayers: 20, actions: ["kick", "op", "gamemode", "teleport"], warnings: [], players: Array.from({ length: 60 }, (_, index) => ({ id: "id-" + index, name: index === 0 ? "Alex" : "Player" + index, uuid: "uuid-" + index, online: index === 0, operator: index === 1, whitelisted: index === 2, banned: false })) };
}

test("player view searches and paginates, validates actions, refreshes after confirmation and preserves server failures", async (t) => {
  let reads = 0; const operations = [];
  let result = { ok: true, message: "Set Alex's game mode to Creative Mode" };
  const { view } = mountedState(t, { list: async () => { reads++; return roster(); }, action: async operation => { operations.push(operation); return result; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.pages, 3); assert.equal(view.players.length, 25); assert.equal(view.online, 1);
  view.filter = "operators"; await vue.nextTick();
  assert.deepEqual(view.players.map(player => player.name), ["Player1"]);
  view.filter = "all"; view.search = "uuid-59"; await vue.nextTick();
  assert.equal(view.players[0].name, "Player59");
  view.search = null; await vue.nextTick();
  assert.equal(view.players.length, 25);
  view.form.player = "@a"; await view.execute();
  assert.equal(view.error, "MC_PLAYERS_INVALID_NAME"); assert.equal(operations.length, 0);
  view.manage(view.roster.players[0]); view.form.action = "gamemode"; view.form.mode = "creative";
  await view.execute();
  assert.deepEqual(operations[0], { action: "gamemode", player: "Alex", mode: "creative" });
  assert.equal(view.success, result.message); assert.equal(reads, 2);
  view.form.action = "teleport"; view.form.x = "";
  await view.execute(); assert.equal(view.error, "MC_PLAYERS_INVALID_COORDINATES"); assert.equal(operations.length, 1);
  view.form.destination = "player"; view.form.target = "Steve";
  result = { ok: false, message: "No player was found" };
  await view.execute();
  assert.deepEqual(operations[1], { action: "teleport", player: "Alex", destination: { player: "Steve" } });
  assert.equal(view.error, result.message); assert.equal(reads, 2); assert.equal(view.success, "");
  view.roster.running = false;
  await view.execute(); assert.equal(view.error, "MC_PLAYERS_NOT_RUNNING"); assert.equal(operations.length, 2);
});

test("closing the player view aborts pending reads and actions, ignores late replies and prevents duplicate submissions", async (t) => {
  const gate = deferred(); let signal; const operations = [];
  const { view, close } = mountedState(t, { list: async current => { signal = current; return roster(); }, action: async (operation, current) => { operations.push(operation); signal = current; return gate.promise; } });
  await new Promise(resolve => setImmediate(resolve));
  view.form.player = "Alex";
  const pending = view.execute();
  await view.execute(); assert.equal(operations.length, 1);
  close(); assert(signal.aborted);
  gate.resolve({ ok: true, message: "Kicked Alex" });
  await pending;
  assert.equal(view.success, "");
  assert.equal(view.error, "");
});

test("Java windows prompt once for disabled Query, cancellation never enables it, and other editions or enabled Query never prompt", async t => {
  for (const [edition, queryEnabled] of [["java", false], ["java", true], ["bedrock", false]]) {
    let changes = 0;
    const { view } = mountedState(t, { list: async () => ({ ...roster(), edition, queryEnabled }), enableQuery: async () => { changes++; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.queryPrompt, edition === "java" && !queryEnabled);
    view.queryPrompt = false;
    await view.enableQuery();
    await view.load();
    assert.equal(view.queryPrompt, false);
    assert.equal(changes, 0);
  }
});

test("confirmed Query setup blocks duplicate submissions, refreshes after a restart request and surfaces failures", async t => {
  const gate = deferred(); let changes = 0, enabled = false, reads = 0;
  const { view } = mountedState(t, {
    list: async () => { reads++; return { ...roster(), queryEnabled: enabled }; },
    enableQuery: async () => { changes++; await gate.promise; enabled = true; return { changed: true, restartRequested: true }; }
  });
  await new Promise(resolve => setImmediate(resolve));
  const first = view.enableQuery();
  await view.enableQuery(); await view.load();
  assert.equal(changes, 1); assert.equal(reads, 1); assert(view.enablingQuery);
  gate.resolve(); await first;
  assert.equal(view.success, "MC_PLAYERS_QUERY_RESTART_REQUESTED");
  assert.equal(view.queryPrompt, false); assert.equal(view.roster.queryEnabled, true); assert.equal(reads, 2);
  const failed = mountedState(t, {
    list: async () => ({ ...roster(), queryEnabled: false }),
    enableQuery: async () => { throw new Error("MC_PLAYERS_QUERY_WRITE_FAILED"); }
  }).view;
  await new Promise(resolve => setImmediate(resolve));
  await failed.enableQuery();
  assert.equal(failed.error, "MC_PLAYERS_QUERY_WRITE_FAILED");
  assert.equal(failed.success, ""); assert.equal(failed.queryPrompt, false);
});
