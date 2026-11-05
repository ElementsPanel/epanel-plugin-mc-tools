const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loader, deferred } = require("./helpers.cjs");
const { tileBounds } = loader()("panel/src/map/viewport.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));

test("tile edges coincide without gaps or overlaps at fractional zoom, DPR and negative coordinates", () => {
  for (const zoom of [1, 1.13, 2.417, 7.81, 12]) for (const ratio of [1, 1.25, 1.5, 2]) {
    const camera = { x: -128.731, z: 127.319, zoom };
    for (let z = -2; z <= 1; z++) for (let x = -2; x <= 1; x++) {
      const a = tileBounds(camera, 1101.3, 701.7, x, z, ratio);
      const east = tileBounds(camera, 1101.3, 701.7, x + 1, z, ratio);
      const south = tileBounds(camera, 1101.3, 701.7, x, z + 1, ratio);
      assert(Math.abs(a.x + a.width - east.x) < 1e-9);
      assert(Math.abs(a.y + a.height - south.y) < 1e-9);
      assert(Math.abs(a.x * ratio - Math.round(a.x * ratio)) < 1e-9);
      assert(Math.abs(a.y * ratio - Math.round(a.y * ratio)) < 1e-9);
    }
  }
});

function overview(t, options = {}) {
  const globals = ["ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "devicePixelRatio", "matchMedia", "Image"];
  const originals = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map(), imports = [], renderers = [], requests = [], draws = [], states = [], layers = [], observers = [], listeners = new Map();
  const bounds = { width: 800, height: 600, scale: options.scale ?? 1 };
  let sequence = 0;
  Object.assign(globalThis, {
    devicePixelRatio: 1.5, matchMedia: () => ({ matches: true }),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { this.target = target; } disconnect() {}
    },
    requestAnimationFrame: fn => { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame: id => frames.delete(id),
    Image: class { set src(value) { this.url = value; queueMicrotask(() => this.onload()); } }
  });
  class SceneViewport {
    constructor(canvas, world, load, changed, y, projection, inputCanvas) {
      if (options.fail) throw new Error("MC_MAP_WEBGL_UNAVAILABLE");
      canvas.webgl = true;
      Object.assign(this, { canvas, world, load, changed, y, projection, inputCanvas, camera: { ...world.spawn, zoom: 2 }, ready: false, disposed: false, active: true });
      renderers.push(this);
    }
    setTopDownView(camera, width, height) {
      Object.assign(this.camera, camera); this.setSize(width, height);
    }
    get nextView() { return { camera: { ...this.camera }, width: this.width, height: this.height }; }
    setSize(width, height) {
      this.width = width; this.height = height;
      this.canvas.width = width * devicePixelRatio; this.canvas.height = height * devicePixelRatio;
    }
    center(x, z) { Object.assign(this.camera, { x, z }); }
    zoom(factor) { this.camera.zoom *= factor; }
    setProjection(projection) { this.projection = projection; }
    setActive(active) { this.active = active; }
    setLayer(y) { this.y = y; }
    render(state = {}) {
      this.frameView = { ...this.nextView, orthographic: this.projection === "orthographic" };
      this.changed({ ...this.frameView.camera, loading: 0, warnings: 0, ...state });
    }
    dispose() { this.disposed = true; }
  }
  const context = target => ({
    setTransform(...matrix) { this.matrix = matrix; }, clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, stroke() {}, moveTo() {}, lineTo() {},
    drawImage(image, ...bounds) {
      assert(!image.webgl, "WebGL pixels must reach the compositor directly, without a 2D canvas copy");
      draws.push({ image, bounds, target });
    },
    fill() { draws.push({ marker: true, target }); }
  });
  const createCanvas = () => {
    const layer = { width: 0, height: 0, style: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      remove() { const index = layers.indexOf(this); if (index >= 0) layers.splice(index, 1); }
    };
    const ctx = context(layer);
    layer.getContext = () => ctx;
    return layer;
  };
  const foreground = context("foreground");
  const canvas = {
    style: {}, ownerDocument: { createElement: createCanvas },
    before(...elements) { layers.splice(layers.indexOf(this), 0, ...elements); },
    get clientWidth() { return Math.round(bounds.width); }, get clientHeight() { return Math.round(bounds.height); },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: bounds.width * bounds.scale, height: bounds.height * bounds.scale }), getContext: () => foreground,
    addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); }, setPointerCapture() {}
  };
  layers.push(canvas);
  const loadScene = () => assert.fail("scene API must be passed through to the scene renderer");
  const { MapViewport } = loader({ "./scene-loader": { loadSceneViewport() {
    const gate = deferred(); imports.push(gate); return gate.promise;
  } } })("panel/src/map/viewport.ts");
  const view = new MapViewport(canvas, { id: "world", spawn: { x: 8.25, z: -16.375 } }, (world, x, z, signal, y) => {
    const gate = deferred(); requests.push({ ...gate, signal, y }); return gate.promise;
  }, state => states.push(state), options.y, loadScene);
  const frame = () => { draws.length = 0; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(0)); };
  const zoom = value => { view.zoom(value / view.camera.zoom); frame(); };
  const ready = async () => { imports.at(-1).resolve({ SceneViewport }); await tick(); return renderers.at(-1); };
  const resize = (width, height, ratio) => {
    Object.assign(bounds, { width, height }); globalThis.devicePixelRatio = ratio;
    for (const observer of observers) observer.callback([{ target: observer.target, contentRect: { width, height } }]);
    frame();
  };
  t.after(() => {
    view.dispose();
    for (const key of globals) { const original = originals.get(key); if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key]; }
  });
  return { view, canvas, frame, zoom, ready, imports, renderers, requests, draws, frames, states, layers, bounds, resize, listeners, SceneViewport, loadScene };
}

test("dialog scale animations do not shrink the scene or leave right/bottom gaps after opening", async t => {
  const f = overview(t, { scale: .9 }); f.zoom(4);
  const detail = await f.ready(); f.frame(); detail.ready = true; detail.render(); f.frame();
  assert.equal(parseFloat(detail.canvas.style.width), f.bounds.width);
  assert.equal(parseFloat(detail.canvas.style.height), f.bounds.height);
  // Transform-only animations do not notify ResizeObserver when they finish.
  f.bounds.scale = 1;
  f.zoom(8); detail.render(); f.frame();
  assert.equal(parseFloat(detail.canvas.style.width), f.canvas.getBoundingClientRect().width);
  assert.equal(parseFloat(detail.canvas.style.height), f.canvas.getBoundingClientRect().height);
  assert.equal(detail.canvas.style.transform, "translate(0px, 0px) scale(1)");
});

test("fractional layout sizes and display scaling keep both canvas axes aligned with the scene", async t => {
  const f = overview(t); f.zoom(4);
  const detail = await f.ready(); detail.ready = true;
  for (const [width, height, ratio] of [[1101.3, 701.7, 1.25], [701.5, 1101.25, 1.5], [390.25, 844.75, 2]]) {
    f.resize(width, height, ratio); detail.render(); f.frame();
    assert.deepEqual(detail.nextView, { camera: { ...f.view.camera }, width, height });
    for (const canvas of [f.canvas, f.layers[0]]) {
      assert.equal(canvas.width, Math.round(width * ratio)); assert.equal(canvas.height, Math.round(height * ratio));
      const [sx, , , sy] = canvas.getContext("2d").matrix;
      assert(Math.abs(width * sx - canvas.width) < 1e-8);
      assert(Math.abs(height * sy - canvas.height) < 1e-8, "the bottom edge uses its own rounded pixel scale");
    }
    assert.equal(parseFloat(detail.canvas.style.width), width); assert.equal(parseFloat(detail.canvas.style.height), height);
  }
});

test("zoom anchors and drag distances use layout coordinates while an ancestor is scaled", t => {
  const f = overview(t, { scale: .9 }); f.frame();
  const { worldPosition } = loader()("panel/src/map/viewport.ts");
  const anchor = worldPosition(f.view.camera, 800, 600, 120, 90);
  f.listeners.get("wheel")({ preventDefault() {}, clientX: 10 + 120 * .9, clientY: 20 + 90 * .9, deltaY: -100, deltaMode: 0 }); f.frame();
  const next = worldPosition(f.view.camera, 800, 600, 120, 90);
  assert(Math.abs(anchor.x - next.x) < 1e-8 && Math.abs(anchor.z - next.z) < 1e-8);
  const before = { ...f.view.camera };
  f.listeners.get("pointerdown")({ button: 0, pointerId: 1, clientX: 100, clientY: 110 });
  f.listeners.get("pointermove")({ pointerId: 1, clientX: 118, clientY: 137 }); f.frame();
  assert(Math.abs(f.view.camera.x - (before.x - 20 / before.zoom)) < 1e-8);
  assert(Math.abs(f.view.camera.z - (before.z - 30 / before.zoom)) < 1e-8);
});

test("2D overview loads a real orthographic scene only at 4x, keeps its color backdrop while loading, and draws markers last", async t => {
  const f = overview(t, { y: 0 }); f.frame();
  f.requests[0].resolve({ image: "color-tile", warnings: 0 }); await tick(); f.frame();
  assert(f.draws.some(draw => draw.image?.url === "data:image/png;base64,color-tile"));
  assert.equal(f.imports.length, 0);
  f.zoom(3.999); assert.equal(f.imports.length, 0);
  f.zoom(4); assert.equal(f.imports.length, 1);
  const detail = await f.ready(); f.frame();
  assert.equal(detail.projection, "orthographic"); assert.equal(detail.load, f.loadScene); assert.equal(detail.y, 0);
  assert.deepEqual(detail.nextView, { camera: { x: 8.25, z: -16.375, zoom: 4 }, width: 800, height: 600 });
  detail.render({ loading: 2 }); f.frame();
  assert.equal(detail.canvas.style.visibility, "hidden", "wait for the atlas before compositing");
  assert(f.draws.some(draw => draw.image?.url === "data:image/png;base64,color-tile"));
  detail.ready = true; detail.render(); f.frame();
  assert.equal(detail.canvas.style.visibility, "visible");
  assert.equal(detail.canvas.style.transform, "translate(0px, 0px) scale(1)");
  assert.deepEqual(f.layers.slice(1), [detail.canvas, f.canvas], "WebGL sits between the backdrop and input/markers");
  assert.equal(f.draws.find(draw => draw.image?.url)?.target, f.layers[0]);
  assert.deepEqual(f.draws.at(-1), { marker: true, target: "foreground" });
  for (const layer of f.layers.slice(0, 2)) {
    assert.equal(layer.style.pointerEvents, "none"); assert.equal(layer.attributes["aria-hidden"], "true");
  }
  assert.equal(f.frames.size, 0, "unchanged view synchronization must not schedule a perpetual render loop");
  f.zoom(3.999);
  assert.equal(detail.disposed, false); assert.equal(detail.active, false);
  assert.equal(detail.canvas.style.visibility, "hidden");
  f.zoom(4);
  assert.equal(f.renderers.length, 1); assert.equal(detail.active, true);
  f.view.dispose(); assert.equal(detail.disposed, true); assert.equal(f.frames.size, 0);
  assert.deepEqual(f.layers, [f.canvas]);
  assert(f.requests.every(request => request.signal.aborted));
});

test("2D and 3D reuse the same scene, canvas and input target while changing only projection", async t => {
  const f = overview(t, { y: 0 }); f.zoom(4);
  const detail = await f.ready(); detail.ready = true; detail.render(); f.frame();
  assert.equal(detail.inputCanvas, f.canvas);
  for (let i = 0; i < 3; i++) {
    f.view.setMode("3d"); f.frame();
    assert.equal(detail.projection, "perspective"); assert.equal(f.renderers.length, 1);
    detail.center(80.375, -96.125); detail.camera.zoom = 5;
    detail.render(); f.frame();
    assert.deepEqual(f.view.camera, { x: 80.375, z: -96.125, zoom: 5 });
    assert.deepEqual(f.draws, []);
    assert.equal(detail.canvas.style.visibility, "visible");
    assert.equal(detail.canvas.style.transform, "translate(0px, 0px) scale(1)");
    f.view.setMode("2d"); f.frame(); detail.render(); f.frame();
    assert.equal(detail.projection, "orthographic"); assert.equal(detail.y, 0);
    assert.equal(detail.canvas.style.visibility, "visible"); assert.equal(detail.disposed, false);
    assert.deepEqual(f.layers.slice(1), [detail.canvas, f.canvas]);
  }
  f.zoom(2); assert.equal(detail.active, false);
  f.view.setMode("3d"); f.frame(); detail.render(); f.frame();
  assert.equal(detail.active, true); assert.equal(detail.projection, "perspective");
  assert.equal(f.imports.length, 1); assert.equal(f.renderers.length, 1);
});

test("mode changes during lazy loading use the latest projection without creating a second scene", async t => {
  const f = overview(t); f.zoom(4); f.view.setMode("3d"); f.frame();
  const detail = await f.ready();
  assert.equal(detail.projection, "perspective"); assert.equal(f.imports.length, 1);
  f.view.setMode("2d"); f.frame();
  assert.equal(detail.projection, "orthographic"); assert.equal(f.renderers.length, 1);
});

test("retained orthographic frames stay aligned during pan/zoom and cannot show a stale Y slice", async t => {
  const f = overview(t); f.zoom(4);
  const detail = await f.ready(); detail.ready = true; detail.render(); f.frame();
  f.view.center(10.25, -13.375); f.frame();
  assert.equal(detail.canvas.style.transform, "translate(-8px, -12px) scale(1)");
  f.zoom(8);
  assert.equal(detail.canvas.style.transform, "translate(-416px, -324px) scale(2)");
  assert.equal(detail.canvas.style.width, "800px"); assert.equal(detail.canvas.style.height, "600px");
  detail.render();
  assert.equal(detail.canvas.style.transform, "translate(0px, 0px) scale(1)", "a new WebGL frame resets reprojection before the next browser composite");
  f.frame();
  f.view.setLayer(-64); f.frame();
  assert.equal(detail.y, -64);
  assert.equal(detail.canvas.style.visibility, "hidden");
  detail.render(); f.frame();
  assert.equal(detail.canvas.style.visibility, "visible");
});

test("late detail imports cannot revive a zoomed-out or disposed map", async t => {
  const f = overview(t); f.zoom(4); f.zoom(2);
  f.imports[0].resolve({ SceneViewport: f.SceneViewport }); await tick();
  assert.equal(f.renderers.length, 0);
  f.zoom(4); f.view.dispose();
  f.imports[1].resolve({ SceneViewport: f.SceneViewport }); await tick();
  assert.equal(f.renderers.length, 0); assert.equal(f.frames.size, 0);
});

test("unavailable WebGL leaves the color map usable and avoids repeated failed initialization", async t => {
  const f = overview(t, { fail: true }); f.zoom(4); await f.ready(); f.frame();
  assert.equal(f.states.at(-1).error.message, "MC_MAP_WEBGL_UNAVAILABLE");
  f.view.center(100, 200); f.frame(); f.zoom(8);
  assert.deepEqual(f.view.camera, { x: 100, z: 200, zoom: 8 });
  assert.equal(f.imports.length, 1);
  assert.deepEqual(f.layers, [f.canvas]);
  f.zoom(2); assert.equal(f.states.at(-1).error, undefined);
  f.zoom(4); assert.equal(f.imports.length, 1);
});

test("a lost WebGL context releases the detail canvas and pending scene state", async t => {
  const f = overview(t); f.zoom(4);
  const detail = await f.ready(); detail.ready = true; detail.render(); f.frame();
  detail.render({ error: new Error("MC_MAP_WEBGL_UNAVAILABLE") }); f.frame();
  assert.equal(detail.disposed, true); assert.equal(detail.canvas.width, 0);
  assert.deepEqual(f.layers, [f.canvas]);
  assert.equal(f.states.at(-1).error.message, "MC_MAP_WEBGL_UNAVAILABLE");
  f.zoom(8); assert.equal(f.imports.length, 1);
});
