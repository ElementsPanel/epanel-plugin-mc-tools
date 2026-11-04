const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { transformSync } = require("esbuild");

const root = path.resolve(__dirname, "..");

function loader(overrides = {}) {
  const cache = new Map();
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = new Module(filename, module);
    mod.filename = filename;
    cache.set(filename, mod);
    mod.require = (id) => {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id.endsWith(".vue")) return {};
      if (id.startsWith(".") && !id.endsWith(".json")) {
        const stem = path.resolve(path.dirname(filename), id);
        const target = [stem + ".ts", path.join(stem, "index.ts")].find(fs.existsSync);
        return load(target);
      }
      return Module.createRequire(filename)(id);
    };
    mod._compile(transformSync(fs.readFileSync(filename, "utf8"), {
      loader: "ts", format: "cjs", target: "es2022"
    }).code, filename);
    return mod.exports;
  }
  return (name) => load(path.join(root, name));
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

module.exports = { root, loader, deferred };
