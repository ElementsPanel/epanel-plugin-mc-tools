const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const vue = require("vue");
const { loader, deferred, root } = require("./helpers.cjs");

test("viewport zoom anchors the cursor, clamps coordinates, and includes negative tiles", () => {
  const { worldPosition, zoomCamera, visibleTiles } = loader()("panel/src/map/viewport.ts");
  const camera = { x: -12, z: 76, zoom: 2 };
  const before = worldPosition(camera, 800, 600, 123, 456);
  zoomCamera(camera, 800, 600, 123, 456, 5);
  assert.deepEqual(worldPosition(camera, 800, 600, 123, 456), before);
  zoomCamera(camera, 800, 600, 400, 300, 999);
  assert.equal(camera.zoom, 12);
  const tiles = visibleTiles({ x: 0, z: 0, zoom: 2 }, 512, 256);
  assert(tiles.some((tile) => tile.x === -1 && tile.z === -1));
  assert(tiles.some((tile) => tile.x === 0 && tile.z === 0));
});

test("viewport limits tile loading and cancels requests, animation frames, and listeners on close", async (t) => {
  const original = Object.fromEntries(["ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "devicePixelRatio"].map((key) => [key, globalThis[key]]));
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const frames = new Map(), listeners = new Map(), requests = [];
  let sequence = 0, disconnected = 0, changed = 0;
  globalThis.ResizeObserver = class { observe() {} disconnect() { disconnected++; } };
  globalThis.requestAnimationFrame = (callback) => { frames.set(++sequence, callback); return sequence; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.devicePixelRatio = 3;
  const canvas = {
    style: {}, clientWidth: 512, clientHeight: 256, getBoundingClientRect: () => ({ width: 512, height: 256 }),
    getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }),
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); }
  };
  const { MapViewport } = loader()("panel/src/map/viewport.ts");
  const view = new MapViewport(canvas, { id: "world", spawn: { x: 0, z: 0 } }, (world, x, z, signal) => {
    const result = deferred(); requests.push({ ...result, signal }); return result.promise;
  }, () => changed++);
  const runFrame = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback()); };
  runFrame();
  assert.equal(canvas.width, 1024);
  assert.equal(requests.length, 3);
  view.center(-100, 100);
  runFrame();
  assert.equal(requests.length, 3);
  const before = changed;
  view.dispose();
  assert.equal(disconnected, 1);
  assert.equal(listeners.size, 0);
  assert.equal(frames.size, 0);
  assert(requests.every((request) => request.signal.aborted));
  requests.forEach((request) => request.resolve({ image: "", warnings: 0 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(changed, before);
  assert.equal(frames.size, 0);
});

function animatedViewport(t, reduced = false) {
  const keys = ["ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "devicePixelRatio", "Image", "matchMedia", "OffscreenCanvas"];
  const original = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let view;
  t.after(() => { view?.dispose(); for (const key of keys) { if (original[key]) Object.defineProperty(globalThis, key, original[key]); else delete globalThis[key]; } });
  const frames = new Map(), listeners = new Map(), requests = [], images = [], markers = [], states = [], blends = [], captured = new Set();
  const motion = { matches: reduced };
  let now = 0, sequence = 0;
  t.mock.method(performance, "now", () => now);
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = callback => { frames.set(++sequence, callback); return sequence; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.devicePixelRatio = 1;
  globalThis.matchMedia = () => motion;
  globalThis.Image = class { set src(value) { this.url = value; queueMicrotask(() => this.onload()); } };
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width; this.height = height; this.draws = [];
      const canvas = this;
      this.context = {
        setTransform(...matrix) { this.matrix = matrix; },
        clearRect() { canvas.draws.length = 0; },
        drawImage(image, ...bounds) {
          blends.push({ image, alpha: this.globalAlpha, operation: this.globalCompositeOperation });
          canvas.draws.push({ image, bounds, matrix: this.matrix, alpha: this.globalAlpha });
        }
      };
    }
    getContext() { return this.context; }
  };
  const context = {
    globalAlpha: 1, setTransform() {}, fillRect() {}, beginPath() {}, arc() {}, stroke() { markers.push(this.globalAlpha); }, moveTo() {}, lineTo() {},
    drawImage(image, ...bounds) { images.push({ image, bounds, alpha: this.globalAlpha }); },
    fill() {}
  };
  const canvas = {
    style: {}, clientWidth: 512, clientHeight: 256, getBoundingClientRect: () => ({ left: 10, top: 20, width: 512, height: 256 }), getContext: () => context,
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id), releasePointerCapture: id => captured.delete(id),
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name)
  };
  const { MapViewport, worldPosition } = loader()("panel/src/map/viewport.ts");
  view = new MapViewport(canvas, { id: "world", spawn: { x: 0, z: 0 } }, (world, x, z, signal, y) => {
    const gate = deferred(); requests.push({ ...gate, signal, x, z, y }); return gate.promise;
  }, (state) => states.push(state));
  const frame = time => { now = time; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)); };
  const wheel = (deltaY, x = 123, y = 90) => listeners.get("wheel")({ preventDefault() {}, clientX: x + 10, clientY: y + 20, deltaY, deltaMode: 0 });
  const touch = (type, pointerId, x, y) => listeners.get(type)({ pointerType: "touch", button: 0, pointerId, clientX: x + 10, clientY: y + 20 });
  return { view, worldPosition, frames, listeners, requests, images, markers, states, blends, motion, frame, wheel, touch, captured, canvas };
}

test("2D held WASD combines directions smoothly, keeps spawn aligned, and preserves mouse pan and shortcuts", t => {
  const f = animatedViewport(t); f.frame(0);
  assert.deepEqual(f.view.projectSpawn(), { x: 256, y: 128 });
  let prevented = 0;
  const key = (code, extras = {}) => f.listeners.get("keydown")({ code, preventDefault() { prevented++; }, ...extras });
  key("KeyW"); key("KeyD");
  assert.deepEqual(f.view.camera, { x: 0, z: 0, zoom: 2 }, "movement starts on the animation frame");
  f.frame(16); const first = f.view.camera.x;
  f.frame(32); assert(f.view.camera.x > first && first > 0);
  assert.equal(f.view.camera.x, -f.view.camera.z);
  assert.deepEqual(f.view.projectSpawn(), { x: 256 - f.view.camera.x * 2, y: 128 - f.view.camera.z * 2 });
  key("ArrowDown"); key("ArrowLeft"); const cancelled = { ...f.view.camera };
  f.frame(48); assert.deepEqual(f.view.camera, cancelled, "opposite directions cancel");
  key("KeyW", { ctrlKey: true }); key("KeyA", { isComposing: true });
  f.frame(64); assert.equal(prevented, 4); assert.deepEqual(f.view.camera, cancelled);
  f.view.center(0, 0);
  f.listeners.get("pointerdown")({ button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  f.listeners.get("pointermove")({ pointerId: 1, clientX: 120, clientY: 130 });
  assert.deepEqual(f.view.camera, { x: -10, z: -15, zoom: 2 });
  f.listeners.get("pointerup")({ pointerId: 1 });
  assert.equal(f.captured.size, 0);
  f.listeners.get("contextmenu")({ preventDefault() { prevented++; } }); assert.equal(prevented, 5);
});

test("2D keyboard movement coexists with zoom and stops on release, blur and mode changes", t => {
  const f = animatedViewport(t); f.frame(0);
  const key = (code, extras = {}) => f.listeners.get("keydown")({ code, preventDefault() {}, ...extras });
  key("KeyW"); key("KeyD"); f.frame(16);
  f.listeners.get("keyup")({ code: "KeyW" }); const z = f.view.camera.z;
  f.wheel(-100, 256, 128); f.frame(32);
  assert.equal(f.view.camera.z, z); assert(f.view.camera.zoom > 2);
  const x = f.view.camera.x; f.frame(48); assert(f.view.camera.x > x);
  f.listeners.get("keyup")({ code: "KeyD" }); const stopped = { ...f.view.camera };
  f.frame(240); assert.equal(f.view.camera.x, stopped.x); assert.equal(f.view.camera.z, stopped.z);
  assert(f.view.camera.zoom > stopped.zoom, "zoom finishes after releasing the movement keys");
  key("KeyA"); f.frame(256); f.listeners.get("blur")(); const blurred = { ...f.view.camera };
  key("KeyA", { repeat: true }); f.frame(272); assert.deepEqual(f.view.camera, blurred);
  key("KeyW"); f.frame(288); const switched = { ...f.view.camera };
  f.view.setMode("3d"); f.view.setMode("2d");
  key("KeyW", { repeat: true }); f.frame(304); assert.deepEqual(f.view.camera, switched);
  key("KeyW"); f.frame(320); assert(f.view.camera.z < switched.z, "a new press starts movement again");
});

test("2D right-drag rotates in place, keeps zoom under the cursor, and pans in screen directions until reset north", t => {
  const f = animatedViewport(t, true); f.frame(0);
  const near = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
  const start = { ...f.view.camera };
  f.listeners.get("pointerdown")({ button: 2, pointerId: 1, clientX: 100, clientY: 100 });
  f.listeners.get("pointermove")({ pointerId: 1, clientX: 100 + 256 / (4 * .65), clientY: 100 });
  f.frame(16);
  near(f.states.at(-1).bearing, Math.PI / 2); assert.deepEqual(f.view.camera, start);
  const point = f.view.project({ x: 10, y: 64, z: 0 }); near(point.x, 256); near(point.y, 108);
  f.listeners.get("pointerup")({ pointerId: 1 });
  f.listeners.get("pointerdown")({ button: 0, pointerId: 2, clientX: 100, clientY: 100 });
  f.listeners.get("pointermove")({ pointerId: 2, clientX: 120, clientY: 130 });
  f.listeners.get("pointerup")({ pointerId: 2 });
  near(f.view.camera.x, 15); near(f.view.camera.z, -10);
  f.listeners.get("keydown")({ code: "KeyW", preventDefault() {} }); f.frame(32);
  assert(f.view.camera.x > 15); near(f.view.camera.z, -10);
  f.listeners.get("keyup")({ code: "KeyW" });
  const anchor = f.worldPosition(f.view.camera, 512, 256, 123, 90, Math.PI / 2);
  f.wheel(-100); f.frame(48);
  const after = f.worldPosition(f.view.camera, 512, 256, 123, 90, Math.PI / 2);
  near(after.x, anchor.x); near(after.z, anchor.z);
  const final = { ...f.view.camera };
  f.view.resetBearing(); f.frame(64);
  assert.equal(f.states.at(-1).bearing, 0); assert.deepEqual(f.view.camera, final);
});

test("rotated viewport coverage includes all corners, and touch pan/pinch preserve the rotated midpoint", t => {
  const { visibleTiles, worldPosition } = loader()("panel/src/map/viewport.ts");
  const camera = { x: -103.5, z: 69.25, zoom: 1.2 };
  for (const bearing of [.3, Math.PI / 4, Math.PI / 2, 5.9]) {
    const tiles = new Set(visibleTiles(camera, 1100, 350, bearing).map(tile => tile.key));
    for (const x of [0, 550, 1100]) for (const y of [0, 175, 350]) {
      const point = worldPosition(camera, 1100, 350, x, y, bearing);
      assert(tiles.has(`${Math.floor(point.x / 128)}:${Math.floor(point.z / 128)}`));
    }
  }
  const f = animatedViewport(t); f.view.setBearing(1.1); f.frame(0);
  const anchor = worldPosition(f.view.camera, 512, 256, 150, 100, 1.1);
  f.touch("pointerdown", 1, 100, 100); f.touch("pointerdown", 2, 200, 100);
  f.touch("pointermove", 1, 50, 120); f.touch("pointermove", 2, 250, 120); f.frame(16);
  const after = worldPosition(f.view.camera, 512, 256, 150, 120, 1.1);
  assert(Math.abs(anchor.x - after.x) < 1e-8 && Math.abs(anchor.z - after.z) < 1e-8);
  assert.equal(f.view.camera.zoom, 4);
});

test("rotating tiles composites pixel-aligned edges once, preserves fades and works at fractional zoom and DPR", async t => {
  const f = animatedViewport(t); f.view.setBearing(.4); f.frame(0);
  f.requests.slice(0, 3).forEach(request => request.resolve({ image: `tile:${request.x}:${request.z}`, warnings: 0 }));
  await new Promise(resolve => setImmediate(resolve));
  f.images.length = 0; f.frame(16);
  assert.equal(f.images.length, 1, "one assembled layer is rotated instead of separate tile images");
  const raster = f.images[0].image;
  assert(raster instanceof OffscreenCanvas); assert(raster.draws.length >= 2);
  assert(raster.draws.every(draw => draw.alpha === 0));
  f.frame(136); assert(raster.draws.every(draw => draw.alpha > 0 && draw.alpha < 1));
  f.frame(256); assert(raster.draws.every(draw => draw.alpha === 1));
  globalThis.devicePixelRatio = 1.25;
  f.view.resize({ width: 511.5, height: 255.25 });
  f.view.camera.zoom = 3.7; f.view.center(-.375, .125);
  for (const [index, angle] of [.001, .3, 1.1, Math.PI / 2, 5.9].entries()) {
    f.images.length = 0; f.view.setBearing(angle); f.frame(400 + index * 16);
    assert.equal(f.images.length, 1); assert.equal(f.images[0].image, raster); assert.equal(f.images[0].alpha, 1);
    const rx = f.canvas.width / 511.5, ry = f.canvas.height / 255.25;
    assert(raster.draws.length >= 2);
    for (const draw of raster.draws) {
      assert.deepEqual(draw.matrix, [rx, 0, 0, ry, 0, 0], "tiles are assembled without rotation");
      draw.bounds.forEach((value, i) => assert(Math.abs(value * (i % 2 ? ry : rx) - Math.round(value * (i % 2 ? ry : rx))) < 1e-8));
    }
    assert(raster.draws.some(a => raster.draws.some(b => a !== b && a.bounds[1] === b.bounds[1] && Math.abs(a.bounds[0] + a.bounds[2] - b.bounds[0]) < 1e-8)), "adjacent tile edges coincide before rotation");
  }
  f.view.dispose(); assert.equal(raster.width, 0); assert.equal(raster.height, 0);
});

test("touch pinch and two-finger pan preserve the midpoint's world position and continue as a single-finger drag", t => {
  const f = animatedViewport(t); f.frame(0);
  f.touch("pointerdown", 1, 100, 100); f.touch("pointerdown", 2, 200, 100);
  const anchor = f.worldPosition(f.view.camera, 512, 256, 150, 100);
  f.touch("pointermove", 1, 50, 120); f.touch("pointermove", 2, 250, 120); f.frame(16);
  assert(Math.abs(f.view.camera.zoom - 4) < 1e-9);
  assert.deepEqual(f.worldPosition(f.view.camera, 512, 256, 150, 120), anchor);
  f.touch("pointermove", 1, 80, 150); f.touch("pointermove", 2, 280, 150); f.frame(32);
  assert(Math.abs(f.view.camera.zoom - 4) < 1e-9);
  const moved = f.worldPosition(f.view.camera, 512, 256, 180, 150);
  assert(Math.abs(moved.x - anchor.x) < 1e-9 && Math.abs(moved.z - anchor.z) < 1e-9);
  const before = { ...f.view.camera };
  f.touch("pointerup", 2, 280, 150);
  assert.deepEqual([...f.captured], [1]);
  f.touch("pointermove", 1, 100, 180); f.frame(48);
  assert.equal(f.view.camera.zoom, before.zoom);
  assert.equal(f.view.camera.x, before.x - 20 / before.zoom);
  assert.equal(f.view.camera.z, before.z - 30 / before.zoom);
  f.touch("pointerup", 1, 100, 180); assert.equal(f.captured.size, 0);
  assert.equal(f.canvas.style.cursor, "grab");
});

test("touch zoom clamps limits, handles coincident fingers and ignores extra contacts and cancelled pointers", t => {
  const f = animatedViewport(t); f.frame(0);
  f.touch("pointerdown", 1, 100, 100); f.touch("pointerdown", 2, 100, 100);
  f.touch("pointermove", 2, 110, 100);
  assert(Object.values(f.view.camera).every(Number.isFinite));
  f.touch("pointermove", 2, 300, 100); assert.equal(f.view.camera.zoom, 12);
  f.touch("pointermove", 2, 101, 100); assert.equal(f.view.camera.zoom, 1);
  const before = { ...f.view.camera };
  f.touch("pointerdown", 3, 400, 100); f.touch("pointermove", 3, 1000, 100);
  assert.deepEqual(f.view.camera, before); assert(!f.captured.has(3));
  f.touch("pointercancel", 2, 101, 100); f.touch("pointermove", 2, 300, 100);
  assert.deepEqual(f.view.camera, before);
  f.touch("lostpointercapture", 1, 100, 100); f.touch("pointermove", 1, 200, 100);
  assert.deepEqual(f.view.camera, before); assert.equal(f.captured.size, 0);
});

test("touch cancels wheel inertia, releases contacts on mode changes or close, and leaves 3D input to OrbitControls", t => {
  const f = animatedViewport(t); f.frame(0); f.wheel(-100); f.frame(50);
  f.touch("pointerdown", 1, 100, 100); f.touch("pointerdown", 2, 200, 100);
  const before = { ...f.view.camera }; f.frame(500);
  assert.deepEqual(f.view.camera, before);
  f.view.setMode("3d"); assert.equal(f.captured.size, 0);
  f.touch("pointermove", 1, 0, 0); f.touch("pointerdown", 3, 200, 100); f.touch("pointermove", 3, 300, 100);
  assert.deepEqual(f.view.camera, before); assert.equal(f.captured.size, 0);
  f.view.setMode("2d");
  f.touch("pointerdown", 4, 100, 100); f.touch("pointerdown", 5, 200, 100);
  f.view.dispose(); assert.equal(f.captured.size, 0); assert.equal(f.frames.size, 0); assert.equal(f.listeners.size, 0);
});

test("map tiles fade from transparent to opaque once per load, leave markers opaque, and stop animation frames when finished", async t => {
  const f = animatedViewport(t);
  f.frame(0);
  f.requests[0].resolve({ image: "test", warnings: 0 });
  await new Promise(resolve => setImmediate(resolve));
  f.frame(16);
  assert.equal(f.images.at(-1).alpha, 0);
  assert.equal(f.frames.size, 1);
  f.frame(136);
  assert(f.images.at(-1).alpha > 0 && f.images.at(-1).alpha < 1);
  f.frame(256);
  assert.equal(f.images.at(-1).alpha, 1);
  assert.equal(f.frames.size, 0);
  assert(f.markers.every(alpha => alpha === 1));
  f.view.center(1, 1); f.frame(272);
  assert.equal(f.images.at(-1).alpha, 1);
  assert.equal(f.frames.size, 0);
});

test("wheel zoom eases through intermediate scales, preserves the cursor anchor and accumulates rapid scrolling without jumps", t => {
  const f = animatedViewport(t);
  f.frame(0);
  const anchor = f.worldPosition(f.view.camera, 512, 256, 123, 90);
  f.wheel(-100);
  const firstTarget = 2 * Math.exp(.2);
  assert.equal(f.view.camera.zoom, 2);
  f.frame(50);
  const intermediate = f.view.camera.zoom;
  assert(intermediate > 2 && intermediate < firstTarget);
  let position = f.worldPosition(f.view.camera, 512, 256, 123, 90);
  assert(Math.abs(position.x - anchor.x) < 1e-9 && Math.abs(position.z - anchor.z) < 1e-9);
  f.wheel(-100);
  assert.equal(f.view.camera.zoom, intermediate);
  f.frame(150);
  assert(f.view.camera.zoom > intermediate && f.view.camera.zoom < 2 * Math.exp(.4));
  f.frame(250);
  assert(Math.abs(f.view.camera.zoom - 2 * Math.exp(.4)) < 1e-9);
  position = f.worldPosition(f.view.camera, 512, 256, 123, 90);
  assert(Math.abs(position.x - anchor.x) < 1e-9 && Math.abs(position.z - anchor.z) < 1e-9);
  assert.equal(f.frames.size, 0);
  f.wheel(100); f.frame(300);
  assert(f.view.camera.zoom > 2 * Math.exp(.2) && f.view.camera.zoom < 2 * Math.exp(.4));
  f.frame(450);
  assert(Math.abs(f.view.camera.zoom - firstTarget) < 1e-9);
});

test("dragging or recentering cancels zoom, reduced motion skips transitions and close removes active animation frames", async t => {
  const f = animatedViewport(t);
  f.frame(0); f.wheel(-100); f.frame(50);
  f.listeners.get("pointerdown")({ button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  const zoom = f.view.camera.zoom;
  f.frame(400);
  assert.equal(f.view.camera.zoom, zoom);
  assert.equal(f.frames.size, 0);
  f.view.zoom(1.5); f.frame(450);
  f.view.center(100, 200); f.frame(700);
  assert.equal(f.view.camera.x, 100); assert.equal(f.view.camera.z, 200);
  assert.equal(f.frames.size, 0);
  f.motion.matches = true;
  const before = f.view.camera.zoom;
  f.wheel(-100);
  assert(Math.abs(f.view.camera.zoom - before * Math.exp(.2)) < 1e-9);
  f.view.center(0, 0);
  f.requests[0].resolve({ image: "test", warnings: 0 });
  await new Promise(resolve => setImmediate(resolve));
  f.frame(716);
  assert.equal(f.images.at(-1).alpha, 1);
  assert.equal(f.frames.size, 0);
  f.motion.matches = false;
  f.view.zoom(1.5);
  assert.equal(f.frames.size, 1);
  f.view.dispose();
  assert.equal(f.frames.size, 0);
  assert.equal(f.listeners.size, 0);
});

test("scrubbing layers keeps requests bounded, blends without blank frames, displays intermediate layers and reuses cached slices", async t => {
  const f = animatedViewport(t);
  f.view.center(-24.25, 88.75);
  f.view.camera.zoom = 2.5;
  f.frame(0);
  f.requests[0].resolve({ image: "surface", warnings: 2 });
  await new Promise(resolve => setImmediate(resolve));
  f.frame(16);
  f.frame(256);
  assert.equal(f.images.at(-1).image.url, "data:image/png;base64,surface");
  const camera = { ...f.view.camera }, previous = [...f.requests];
  for (const y of [64, 63, 62, 63]) { f.view.setLayer(y); f.frame(272); }
  assert.deepEqual(f.view.camera, camera);
  assert.equal(f.requests.length, previous.length);
  assert.equal(f.images.at(-1).image.url, "data:image/png;base64,surface");
  assert.equal(f.images.at(-1).alpha, 1);
  previous[1].resolve({ image: "surface-neighbor", warnings: 9 });
  previous[2].reject(new Error("stale-error"));
  for (const request of previous.slice(3)) request.resolve({ image: "surface-neighbor", warnings: 9 });
  await new Promise(resolve => setImmediate(resolve));
  f.frame(288);
  const current = f.requests.slice(previous.length);
  assert.equal(current.length, 3);
  assert(current.every(request => request.y === 63 && !request.signal.aborted));
  assert.equal(f.states.at(-1).error, undefined);
  assert.equal(f.states.at(-1).warnings, 0);
  current[0].resolve({ image: "layer-63", warnings: 0 });
  await new Promise(resolve => setImmediate(resolve));
  f.frame(304);
  assert.equal(f.blends.at(-2).image.url, "data:image/png;base64,surface");
  assert.equal(f.blends.at(-2).alpha, 1);
  assert.equal(f.blends.at(-1).alpha, 0);
  f.frame(354);
  assert(f.blends.at(-1).alpha > 0 && f.blends.at(-1).alpha < 1);
  assert.equal(f.blends.at(-1).alpha + f.blends.at(-2).alpha, 1);
  assert.equal(f.blends.at(-1).operation, "lighter");
  f.frame(404);
  assert.equal(f.images.at(-1).image.url, "data:image/png;base64,layer-63");
  // Existing loads finish before the next target is requested, even during a fast drag.
  f.view.setLayer(62); f.frame(420);
  const pending63 = f.requests.filter(request => request.y === 63).slice(1);
  pending63[0].resolve({ image: "layer-63-neighbor", warnings: 0 });
  await new Promise(resolve => setImmediate(resolve));
  f.frame(436);
  const next = f.requests.at(-1);
  assert.equal(next.y, 62);
  f.view.setLayer(61); f.frame(452);
  next.resolve({ image: "layer-62", warnings: 0 });
  await new Promise(resolve => setImmediate(resolve));
  f.frame(468); f.frame(568);
  assert(f.images.some(draw => draw.image.url === "data:image/png;base64,layer-62"));
  assert.equal(f.requests.at(-1).y, 61);
  const requestsForFirstTile = () => f.requests.filter(request => request.y === 63 && request.x === current[0].x && request.z === current[0].z).length;
  const cachedCount = requestsForFirstTile();
  const beforeCached = f.images.length;
  f.view.setLayer(63); f.frame(584); f.frame(684);
  assert.equal(requestsForFirstTile(), cachedCount);
  assert(f.images.slice(beforeCached).some(draw => draw.image.url === "data:image/png;base64,layer-63"));
  const beforeSurface = f.images.length;
  f.view.setLayer();
  f.frame(700); f.frame(800);
  assert(f.images.slice(beforeSurface).some(draw => draw.image.url === "data:image/png;base64,surface"));
  assert.throws(() => f.view.setLayer(2048), /MC_MAP_INVALID/);
  assert.deepEqual(f.view.camera, camera);
  f.view.dispose();
  assert(f.requests.every(request => request.signal.aborted));
});

test("map API shares authentication, encodes instance parameters, forwards cancellation, and reports protocol errors", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let authentications = 0;
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ status: 200, data: [] }) }; };
  const { worldMapApi, mapError } = loader({
    "@elements-panel/sdk": { ctx: { get: () => ({ api: { userInfoApi: () => ({ execute: async () => { authentications++; return { value: { token: "token" } }; } }) } }) } },
    "../settings": { t: (key) => "translated:" + key }
  })("panel/src/map/api.ts");
  const api = worldMapApi("server & one", "node");
  const signal = new AbortController().signal;
  await Promise.all([api.worlds(signal), api.tile("a".repeat(24), -1, 2, signal)]);
  assert.equal(authentications, 1);
  const url = new URL(requests[0].url, "http://localhost/panel/");
  assert.equal(url.pathname, "/panel/api/mc-tools/map/worlds");
  assert.equal(url.searchParams.get("uuid"), "server & one");
  assert.equal(requests[0].options.headers.Authorization, "Bearer token");
  assert.equal(requests[0].options.signal, signal);
  assert.equal(new URL(requests[1].url, "http://localhost").searchParams.has("y"), false);
  for (const y of [0, -64, 319]) {
    await api.tile("a".repeat(24), -1, 2, signal, y);
    assert.equal(new URL(requests.at(-1).url, "http://localhost").searchParams.get("y"), String(y));
    assert.equal(requests.at(-1).options.signal, signal);
  }
  await api.scene("a".repeat(24), -1, 2, signal, 0);
  const scene = new URL(requests.at(-1).url, "http://localhost");
  assert.equal(scene.pathname, "/api/mc-tools/map/scene");
  assert.equal(scene.searchParams.get("y"), "0");
  assert.equal(requests.at(-1).options.headers.Authorization, "Bearer token");
  assert.equal(authentications, 1);
  await api.players(signal);
  assert.equal(new URL(requests.at(-1).url, "http://localhost").pathname, "/api/mc-tools/map/players");
  await api.enableRcon(signal);
  assert.equal(new URL(requests.at(-1).url, "http://localhost").pathname, "/api/mc-tools/map/rcon/enable");
  assert.equal(requests.at(-1).options.method, "POST");
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { confirmed: true });
  assert.equal(requests.at(-1).options.headers.Authorization, "Bearer token");
  await api.worlds(signal, true);
  assert.equal(authentications, 2);
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ status: 403, data: "Forbidden" }) });
  await assert.rejects(api.worlds(signal), /Forbidden/);
  assert.equal(mapError(new Error("remote error: MC_MAP_BUSY")), "translated:MC_MAP_BUSY");
});

function mapComponent(overrides) {
  const { compileScript, parse } = require("@vue/compiler-sfc");
  const { transformSync } = require("esbuild");
  const filename = path.join(root, "panel/src/map/WorldMapView.vue");
  const script = compileScript(parse(fs.readFileSync(filename, "utf8")).descriptor, { id: "map-test" });
  const mod = new Module(filename, module);
  mod.require = (id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id === "vuetify/components" || id.endsWith(".vue")) return {};
    if (id === "../../../shared/map") return loader()("shared/map.ts");
    if (id === "./page") return loader()("panel/src/map/page.ts");
    if (id === "./player-state" || id === "./player-markers") return loader({ "../settings": { t: key => key } })("panel/src/map/" + id.slice(2) + ".ts");
    return require(id);
  };
  mod._compile(transformSync(script.content, { loader: "ts", format: "cjs" }).code, filename);
  return { ...mod.exports.default, render: () => null };
}

test("map view validates coordinates and layers, retains the selected layer on refresh/world changes, and disposes on unmount", async () => {
  const worlds = [
    { id: "world", name: "Test", dimension: "minecraft:overworld", spawn: { x: 8, z: 16 } },
    { id: "nether", name: "Test", dimension: "minecraft:the_nether", spawn: { x: 1, z: 2 } }
  ];
  const renderers = [], signals = [];
  const Component = mapComponent({
    "../settings": { t: (key) => key },
    "./api": { mapError: (error) => error.message, worldMapApi: () => ({ worlds: async (signal) => { signals.push(signal); return worlds; }, tile: () => {} }) },
    "./viewport": { MapViewport: class {
      constructor(canvas, world, load, changed, y) { this.camera = { ...world.spawn, zoom: 2 }; this.world = world; this.layer = y; renderers.push(this); }
      dispose() { this.disposed = true; }
      center(x, z) { this.target = { x, z }; }
      setMode() {}
      setLayer(y) { this.layer = y; }
    } }
  });
  const renderer = vue.createRenderer({
    createElement: () => ({ children: [] }), createComment: () => ({}), createText: () => ({}),
    insert() {}, remove() {}, patchProp() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null
  });
  const app = renderer.createApp(Component, { instanceUuid: "server", daemonId: "node" });
  app.mount({ children: [] });
  const view = app._instance.setupState;
  view.canvas = {};
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renderers.length, 1);
  await view.load(true);
  assert.equal(renderers.length, 2);
  assert.equal(renderers[0].disposed, true);
  view.selected = "nether";
  view.selected = "world";
  await vue.nextTick();
  assert.equal(renderers.length, 3);
  assert.equal(renderers[2].world.id, "world");
  view.x = "3.5";
  view.go();
  assert.equal(view.error, "MC_MAP_COORDINATES");
  view.x = "-128"; view.z = "256"; view.go();
  assert.deepEqual(renderers[2].target, { x: -128, z: 256 });
  assert.equal(view.layer, undefined);
  view.mode = "slice";
  assert.equal(renderers.length, 3);
  assert.equal(renderers[2].layer, 64);
  view.y = "0"; view.applyHeight();
  assert.equal(renderers[2].layer, 0);
  for (const y of ["", " ", "1.5", "2048", "-2049", "invalid"]) {
    view.y = y; view.applyHeight();
    assert.equal(view.heightError, "MC_MAP_HEIGHT_INVALID");
    assert.equal(renderers[2].layer, 0);
  }
  view.y = "-2048"; view.applyHeight();
  assert.equal(renderers[2].layer, -2048);
  assert.equal(view.range.min, -2048);
  view.y = "2047"; view.applyHeight();
  assert.equal(renderers[2].layer, 2047);
  assert.equal(view.range.max, 2047);
  // VSlider updates the rendered layer immediately, without waiting for blur or mouseup.
  for (let y = -64; y <= -63; y++) {
    view.height = y;
    assert.equal(renderers[2].layer, y);
    assert.equal(view.y, String(y));
  }
  assert.equal(renderers[2].layer, -63);
  assert.equal(view.heightError, "");
  view.mode = "surface";
  assert.equal(renderers[2].layer, undefined);
  view.mode = "slice";
  assert.equal(renderers[2].layer, -63);
  await view.load(true);
  assert.equal(renderers.length, 4);
  assert.equal(renderers[3].layer, -63);
  assert.equal(renderers[2].disposed, true);
  view.selected = "nether";
  view.y = "32"; view.applyHeight();
  await vue.nextTick();
  assert.equal(renderers.length, 5);
  assert.equal(renderers[4].world.id, "nether");
  assert.equal(renderers[4].layer, 32);
  app.unmount();
  assert.equal(renderers[4].disposed, true);
  assert(signals.every((signal) => signal.aborted));
});
