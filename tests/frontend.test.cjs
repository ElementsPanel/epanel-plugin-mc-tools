const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { loader, root } = require("./helpers.cjs");
const vue = require("vue");

test("Minecraft settings appear in both interfaces only for a scoped Minecraft instance with node support", () => {
  const actions = [];
  let locales;
  const ctx = {
    routes: { add() {} },
    i18n: { define(value) { locales = value; }, translate: (key) => key },
    actions: { instances: actions, instance(action) { actions.push(action); } }
  };
  const load = loader();
  const { apply } = load("panel/src/frontend.ts");
  apply(ctx);
  assert.equal(actions.length, 3);
  const action = actions.find((value) => value.id === "mcstats");
  assert.equal(action.id, "mcstats");
  assert(action.normalComponent);
  assert(action.desktopComponent);
  const context = { instanceId: "instance", daemonId: "node", instanceInfo: { config: { type: "minecraft/java" } }, daemon: { features: { mcstats: true } } };
  assert.equal(action.condition(context), true);
  assert.equal(action.condition({ ...context, instanceInfo: { config: { type: "minecraft/bedrock" } } }), true);
  for (const change of [{ instanceId: "" }, { daemonId: "" }, { isGlobalTerminal: true }, { daemon: {} }, { instanceInfo: { config: { type: "steam/universal" } } }]) {
    assert.equal(action.condition({ ...context, ...change }), false);
  }
  apply(ctx);
  assert.equal(actions.length, 3);
  assert.equal(Object.keys(locales).length, 12);
  const keys = Object.keys(locales.en_us).sort();
  for (const locale of Object.values(locales)) assert.deepEqual(Object.keys(locale).sort(), keys);
});

test("saved map action supports both editions, requires node support, and registers alongside a legacy status action", () => {
  const actions = [{ id: "mcstats" }];
  const ctx = {
    routes: { add() {} },
    i18n: { define() {}, translate: (key) => key },
    actions: { instances: actions, instance(action) { actions.push(action); } }
  };
  const { apply } = loader()("panel/src/frontend.ts");
  apply(ctx);
  apply(ctx);
  assert.equal(actions.length, 3);
  const action = actions.find((value) => value.id === "mc-world-map");
  assert(action.normalComponent);
  assert(action.desktopComponent);
  const context = { instanceId: "server", daemonId: "node", daemon: { features: { mcWorldMap: true } } };
  for (const type of ["minecraft/java", "minecraft/java/paper", "minecraft/bedrock"]) {
    assert.equal(action.condition({ ...context, instanceInfo: { config: { type } } }), true);
  }
  const instanceInfo = { config: { type: "minecraft/java" } };
  for (const change of [{ instanceId: "" }, { daemonId: "" }, { isGlobalTerminal: true }, { daemon: {} }, { instanceInfo: { config: { type: "minecraft/java/bungeecord" } } }, { instanceInfo: { config: { type: "steam/universal" } } }]) {
    assert.equal(action.condition({ ...context, instanceInfo, ...change }), false);
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(metadata.elementspanel.panel.frontendInject, ["console", "i18n", "instance"]);
});

function settingsFixture() {
  const calls = [];
  let respond = async () => ({});
  const load = loader({
    "@elements-panel/sdk": {
      ctx: { i18n: { translate: (key) => key } },
      usePluginService: (name) => {
        assert.equal(name, "instance");
        return { api: { updateInstanceConfig: () => ({ execute: async (value) => { calls.push(value); return respond(); } }) } };
      }
    }
  });
  return { calls, settings: load("panel/src/settings.ts").usePingSettings("server-id", "daemon-id"), respond: (callback) => { respond = callback; } };
}

test("settings use the host's authorized instance API and preserve ping options", async () => {
  const f = settingsFixture();
  f.settings.load({ config: { pingConfig: { ip: "game.local", port: 19132, type: 2 } } });
  assert.equal(f.settings.form.port, "19132");
  f.settings.form.ip = "  game.internal  ";
  assert.equal(await f.settings.save(), true);
  assert.deepEqual(f.calls[0], { params: { uuid: "server-id", daemonId: "daemon-id" }, data: { pingConfig: { ip: "game.internal", port: 19132, type: 2 } } });
  f.settings.form.port = "";
  assert.equal(await f.settings.save(), true);
  assert.equal(f.calls[1].data.pingConfig.port, 0);
  for (const port of ["-1", "65536", "1.5", "invalid"]) {
    f.settings.form.port = port;
    assert.equal(await f.settings.save(), false);
  }
  assert.equal(f.calls.length, 2);
  f.settings.form.port = "25565";
  f.respond(async () => { throw new Error("Permission denied"); });
  assert.equal(await f.settings.save(), false);
  assert.equal(f.settings.error.value, "Permission denied");
  assert.equal(f.settings.loading.value, false);
});

test("desktop settings initialize after async instance loading and retain unsaved edits", async () => {
  const Module = require("node:module");
  const { compileScript, parse } = require("@vue/compiler-sfc");
  const { transformSync } = require("esbuild");
  const filename = path.join(root, "panel/src/DesktopMcPing.vue");
  const { descriptor } = parse(fs.readFileSync(filename, "utf8"));
  const script = compileScript(descriptor, { id: "desktop-mc-ping" });
  const info = vue.ref();
  const loaded = [];
  const mod = new Module(filename, module);
  mod.require = (id) => {
    if (id === "@elements-panel/sdk") return { usePluginService: () => ({ hooks: { useInstanceInfo: () => ({ instanceInfo: info }) } }) };
    if (id === "./settings") return { t: (key) => key, usePingSettings: () => ({ load: (value) => loaded.push(value) }) };
    if (id.endsWith(".vue") || id === "vuetify/components") return {};
    return require(id);
  };
  mod._compile(transformSync(script.content, { loader: "ts", format: "cjs" }).code, filename);
  const scope = vue.effectScope();
  scope.run(() => mod.exports.default.setup({ instanceUuid: "server", daemonId: "node" }, { expose() {} }));
  assert.equal(loaded.length, 0);
  info.value = { config: { pingConfig: { port: 25565 } } };
  await vue.nextTick();
  assert.equal(loaded.length, 1);
  info.value = { config: { pingConfig: { port: 25566 } } };
  await vue.nextTick();
  assert.equal(loaded.length, 1);
  scope.stop();
});
