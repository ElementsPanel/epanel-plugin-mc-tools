const assert = require("node:assert/strict");
const { test } = require("node:test");
const three = require("three");
const { loader } = require("./helpers.cjs");
const load = loader();
const { transitionPose, transitionProjection, MAP_FOV } = load("panel/src/map/perspective-transition.ts");
const { sortTransparentFaces } = load("panel/src/map/scene-transparency.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));
const near = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test("the projection transition starts at exact 2D scale, keeps depth-independent positions, and ends at the normal perspective", () => {
  const height = 700, width = 1100, zoom = 3.1;
  const camera = new three.PerspectiveCamera(MAP_FOV, width / height, .1, 1000);
  const first = transitionPose(height, zoom, 0), last = transitionPose(height, zoom, 1);
  near(last.distance, 160 / zoom); near(first.polar, 0);
  const start = transitionProjection(camera.projectionMatrix, camera.aspect, camera.near, camera.far, first);
  const a = new three.Vector3(32, -24, -first.distance).applyMatrix4(start);
  const b = new three.Vector3(32, -24, -first.distance - 64).applyMatrix4(start);
  near(a.x, 32 * zoom * 2 / width); near(a.y, -24 * zoom * 2 / height);
  near(a.x, b.x); near(a.y, b.y);
  const end = transitionProjection(camera.projectionMatrix, camera.aspect, camera.near, camera.far, last);
  const expected = new three.Vector3(5, 7, -last.distance).applyMatrix4(camera.projectionMatrix);
  const actual = new three.Vector3(5, 7, -last.distance).applyMatrix4(end);
  near(actual.x, expected.x); near(actual.y, expected.y); near(actual.z, expected.z);
  let previous = first.distance;
  for (let step = 0; step <= 100; step++) {
    const pose = transitionPose(height, zoom, step / 100);
    assert(pose.distance <= previous + 1e-9); previous = pose.distance;
    const projection = transitionProjection(camera.projectionMatrix, camera.aspect, camera.near, camera.far, pose);
    assert(projection.elements.every(Number.isFinite)); assert(Math.abs(projection.determinant()) > 1e-10);
  }
});

test("transparent instance faces reorder with the view direction while keeping each face's texture and tint", () => {
  const geometry = new three.InstancedBufferGeometry(); geometry.instanceCount = 2;
  const attribute = (name, array, size) => geometry.setAttribute(name, new three.InstancedBufferAttribute(array, size));
  attribute("aOrigin", new Float32Array([0, 0, -1, 0, 0, -10]), 3);
  attribute("aSize", new Float32Array([1, 1, 1, 1]), 2);
  attribute("aFace", new Uint8Array([4, 4]), 1);
  attribute("aMaterial", new Uint16Array([111, 2, 70, 222, 2, 140]), 3);
  attribute("color", new Uint8Array([255, 0, 0, 0, 0, 255]), 3);
  sortTransparentFaces(geometry, new three.Matrix4());
  assert.deepEqual([...geometry.getAttribute("aMaterial").array], [222, 2, 140, 111, 2, 70]);
  assert.deepEqual([...geometry.getAttribute("color").array], [0, 0, 255, 255, 0, 0]);
  const version = geometry.getAttribute("aMaterial").version;
  sortTransparentFaces(geometry, new three.Matrix4());
  assert.equal(geometry.getAttribute("aMaterial").version, version);
  sortTransparentFaces(geometry, new three.Matrix4().makeRotationY(Math.PI));
  assert.deepEqual([...geometry.getAttribute("aMaterial").array], [111, 2, 70, 222, 2, 140]);
  geometry.dispose();
});

test("terrain textures premultiply before mip filtering and water remains visible from both sides", () => {
  const texture = new three.Texture();
  const { sceneMaterials } = loader({
    three: { ...three, TextureLoader: class { load() { return texture; } } },
    "./minecraft-atlas": { minecraftAtlasUrl: () => "atlas.png" }
  })("panel/src/map/scene-materials.ts");
  const materials = sceneMaterials(0xbad8f3, false, () => {}, () => {});
  assert.equal(texture.premultiplyAlpha, true);
  assert.equal(materials[2].side, three.DoubleSide);
  assert.equal(materials[2].depthWrite, false);
  assert.equal(materials[2].transparent, true);
  texture.dispose(); materials[0].uniforms.uAnimation.value.dispose(); materials.forEach(material => material.dispose());
});

function sceneFixture(t, reduced = false, topDown = false, actualControls = false, scale = 1, options = {}) {
  const globals = ["ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "devicePixelRatio", "matchMedia"];
  const originals = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const frames = new Map(), rendered = [], listeners = new Map();
  let sequence = 0, now = 0, ready;
  t.mock.method(performance, "now", () => now);
  Object.assign(globalThis, { devicePixelRatio: 1, matchMedia: () => ({ matches: reduced }),
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: fn => { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame: id => frames.delete(id) });
  const controls = class {
    constructor(camera) { this.camera = camera; this.target = new three.Vector3(); }
    update() {} addEventListener() {} removeEventListener() {} dispose() {} listenToKeyEvents() {} connect() {} disconnect() {}
    getDistance() { return this.camera.position.distanceTo(this.target); }
  };
  const renderer = class {
    constructor(options) { this.options = options; }
    setPixelRatio() {}
    setSize(width, height, updateStyle) {
      this.size = { width, height };
      this.options.canvas.width = width; this.options.canvas.height = height;
      assert.equal(updateStyle, false);
    }
    dispose() {} forceContextLoss() {}
    render(scene, camera) { rendered.push({ scene, camera: camera.clone(), matrix: camera.projectionMatrix.clone(), position: camera.position.clone() }); }
  };
  const uniforms = { uAtlas: { value: { dispose() {} } }, uAnimation: { value: { dispose() {} } },
    uFogColor: { value: new three.Color() },
    uTime: { value: 0 }, uFogNear: { value: 96 }, uFogFar: { value: 220 } };
  const { SceneViewport, visibleTopDownTiles } = loader({ three: { ...three, WebGLRenderer: renderer },
    "three/addons/controls/OrbitControls.js": { OrbitControls: actualControls ? require("three/addons/controls/OrbitControls.js").OrbitControls : controls },
    "./scene-materials": { sceneMaterials(_sky, _nether, callback) { ready = callback; return Array.from({ length: 4 }, () => ({ uniforms, dispose() {} })); } }
  })("panel/src/map/scene-viewport.ts");
  const canvas = { style: {}, clientWidth: 1100, clientHeight: 700, ownerDocument: { addEventListener() {}, removeEventListener() {} },
    getBoundingClientRect: () => ({ width: 1100 * scale, height: 700 * scale }), addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name), focus() {} };
  const initial = { x: 8.25, z: -16.375, zoom: 4 };
  const heights = Buffer.alloc(2048); for (let i = 0; i < 1024; i++) heights.writeInt16LE(64, i * 2);
  const quad = Buffer.alloc(16); quad.writeInt16LE(65, 2); quad.writeUInt16LE(1, 4); quad.writeUInt16LE(1, 6); quad[8] = 2;
  const requests = [], states = [];
  const view = new SceneViewport(canvas, { id: "world", dimension: options.dimension ?? "minecraft:overworld", spawn: { x: 8, z: -16 } }, async (world, x, z, signal, y) => {
    const request = { world, x, z, signal, y }; requests.push(request);
    const result = { version: 1, heights: heights.toString("base64"), quads: quad.toString("base64"), chunks: 1, warnings: 0, limited: false };
    return options.load ? options.load(request, result) : result;
  }, state => states.push(state), topDown ? "orthographic" : "perspective", canvas);
  view.camera.zoom = initial.zoom; view.center(initial.x, initial.z);
  const frame = time => {
    now = time;
    for (const id of [...frames.keys()]) { const fn = frames.get(id); frames.delete(id); fn?.(time); }
  };
  t.after(() => { view.dispose(); for (const key of globals) { const original = originals.get(key); if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key]; } });
  return { view, frame, ready: () => ready(), frames, rendered, listeners, uniforms, requests, states, visibleTopDownTiles };
}

test("3D held WASD combines camera-relative directions, preserves the view angle and stops without mouse inertia", t => {
  const f = sceneFixture(t, false, false, true); f.ready(); f.frame(0);
  assert.deepEqual(f.view.controls.mouseButtons, { LEFT: three.MOUSE.PAN, MIDDLE: three.MOUSE.DOLLY, RIGHT: three.MOUSE.ROTATE });
  assert.deepEqual(f.view.controls.touches, { ONE: three.TOUCH.ROTATE, TWO: three.TOUCH.DOLLY_PAN });
  const start = f.view.controls.target.clone(), offset = f.view.viewCamera.position.clone().sub(start);
  let prevented = 0;
  const key = (code, extras = {}) => f.listeners.get("keydown")({ code, preventDefault() { prevented++; }, ...extras });
  const up = code => f.listeners.get("keyup")({ code });
  key("KeyW"); near(f.view.controls.target.distanceTo(start), 0); f.frame(16);
  assert(f.view.controls.target.x < start.x && f.view.controls.target.z < start.z);
  const first = f.view.controls.target.clone(); f.frame(32);
  assert(f.view.controls.target.distanceTo(start) > first.distanceTo(start), "one press keeps moving on subsequent frames");
  near(f.view.viewCamera.position.clone().sub(f.view.controls.target).distanceTo(offset), 0);
  key("KeyD"); const diagonal = f.view.controls.target.clone(); f.frame(48);
  near(f.view.controls.target.x, diagonal.x); assert(f.view.controls.target.z < diagonal.z);
  up("KeyW"); const right = f.view.controls.target.clone(); f.frame(64);
  assert(f.view.controls.target.x > right.x && f.view.controls.target.z < right.z);
  up("KeyD"); const stopped = f.view.controls.target.clone(); f.frame(80); f.frame(96);
  near(f.view.controls.target.distanceTo(stopped), 0);
  near(f.view.viewCamera.position.clone().sub(f.view.controls.target).distanceTo(offset), 0);
  key("ArrowUp"); key("ArrowDown"); f.frame(112); near(f.view.controls.target.distanceTo(stopped), 0);
  key("KeyW", { ctrlKey: true }); key("KeyA", { isComposing: true }); assert.equal(prevented, 4);
  f.view.setProjection("orthographic"); key("KeyW"); assert.equal(prevented, 4);
  f.view.dispose(); assert.equal(f.listeners.has("keydown"), false); assert.equal(f.listeners.has("keyup"), false);
});

test("3D movement clears on pause, projection switch and context loss instead of resuming held keys", t => {
  const f = sceneFixture(t, true, false, true); f.ready(); f.frame(0);
  const key = (repeat = false) => f.listeners.get("keydown")({ code: "KeyW", repeat, preventDefault() {} });
  key(); f.frame(16); const paused = { ...f.view.camera };
  f.view.setActive(false); f.frame(32); f.view.setActive(true); key(true); f.frame(48);
  assert.deepEqual(f.view.camera, paused);
  key(); f.frame(64); assert(f.view.camera.x < paused.x);
  f.view.setProjection("orthographic"); f.frame(80);
  f.view.setProjection("perspective"); f.frame(96); const switched = { ...f.view.camera };
  key(true); f.frame(112); assert.deepEqual(f.view.camera, switched);
  key(); f.frame(128); assert(f.view.camera.x < switched.x);
  f.listeners.get("webglcontextlost")({ preventDefault() {} });
  assert.equal(f.frames.size, 0); assert.equal(f.view.navigation.advance(144), undefined);
});

test("heading follows 3D orbit and resetting north preserves center, tilt and zoom after damping settles", t => {
  const f = sceneFixture(t, false, false, true); f.ready(); f.frame(0);
  near(f.view.bearing, Math.PI * 7 / 4);
  f.view.controls.rotateLeft(.8); f.view.controls.pan(24, 12);
  const target = f.view.controls.target.clone(), offset = f.view.viewCamera.position.clone().sub(target);
  const zoom = f.view.camera.zoom;
  assert(Math.abs(f.view.bearing - Math.PI * 7 / 4) > .01);
  f.view.setBearing(0);
  near(f.view.bearing, 0); near(f.view.controls.target.distanceTo(target), 0); near(f.view.camera.zoom, zoom);
  near(f.view.viewCamera.position.y - target.y, offset.y);
  near(f.view.viewCamera.position.x, target.x); assert(f.view.viewCamera.position.z > target.z);
  f.frame(16); f.frame(32);
  near(f.view.bearing, 0); near(f.states.at(-1).bearing, 0); near(f.view.controls.target.distanceTo(target), 0);
});

test("rotated 2D geometry matches map coordinates and preserves heading throughout 2D/3D transitions", async t => {
  const f = sceneFixture(t, false, true, true), bearing = 1.2;
  f.ready(); f.view.setTopDownView({ x: -37.5, z: 24.25, zoom: 4 }, 800, 600, bearing); f.frame(0);
  const { worldToScreen } = load("panel/src/map/bearing.ts");
  for (const y of [-64, 64, 1000]) {
    const actual = f.view.project({ x: -27.5, y, z: 4.25 }), expected = worldToScreen(40, -80, bearing);
    near(actual.x, 400 + expected.x); near(actual.y, 300 + expected.y);
  }
  const tiles = new Set(f.visibleTopDownTiles(f.view.camera, 800, 600, 0, bearing).map(tile => tile.position));
  const { worldPosition } = load("panel/src/map/viewport.ts");
  for (const x of [0, 800]) for (const y of [0, 600]) {
    const point = worldPosition(f.view.camera, 800, 600, x, y, bearing);
    assert(tiles.has(`${Math.floor(point.x / 32)}:${Math.floor(point.z / 32)}`));
  }
  f.view.setProjection("perspective");
  for (const time of [0, 200, 400, 800]) { f.frame(time); near(f.view.bearing, bearing); near(f.states.at(-1).bearing, bearing); }
  f.view.setProjection("orthographic");
  for (const time of [800, 1000, 1200, 1600]) { f.frame(time); near(f.view.bearing, bearing); }
  f.view.setBearing(0); f.frame(1616);
  const north = f.view.project({ x: f.view.camera.x, y: 64, z: f.view.camera.z - 10 });
  near(north.x, 400); near(north.y, 260);
});

test("spawn compass projects above saved terrain and follows both camera modes", async t => {
  const f = sceneFixture(t, true, true); f.ready(); f.frame(0);
  assert.equal(f.view.projectSpawn(), undefined);
  for (let i = 1; i <= 4; i++) { await tick(); f.frame(i * 16); }
  const expected = f.view.project({ x: 8, y: 67.5, z: -16 });
  assert.deepEqual(f.view.projectSpawn(), expected);
  f.view.setProjection("perspective"); f.frame(100);
  assert.deepEqual(f.view.projectSpawn(), f.view.project({ x: 8, y: 67.5, z: -16 }));
  assert(f.view.projectSpawn());
});

test("top-down camera updates render synchronously and consume the queued GPU frame", t => {
  const f = sceneFixture(t, true, true); f.ready(); f.frame(0);
  const count = f.rendered.length;
  f.view.setTopDownView({ x: -37.5, z: 24.25, zoom: 5 }, 800, 600);
  assert.equal(f.rendered.length, count);
  f.view.renderTopDown();
  assert.equal(f.rendered.length, count + 1);
  assert.equal(f.frames.size, 0);
  const camera = f.rendered.at(-1).camera;
  near(camera.position.x + f.view.origin.x, -37.5); near(camera.position.z + f.view.origin.z, 24.25);
  f.view.renderTopDown(); assert.equal(f.rendered.length, count + 1);
  f.view.setProjection("perspective"); f.view.renderTopDown();
  assert.equal(f.rendered.length, count + 1, "orbit transitions keep their animation scheduling");
});

test("player projections follow rendered perspective transitions and rebased world coordinates", t => {
  const f = sceneFixture(t, false, true); f.ready(); f.frame(0);
  const initial = f.view.project({ x: f.view.camera.x + 10, y: 66, z: f.view.camera.z - 5 });
  near(initial.x, 550 + 40); near(initial.y, 350 - 20);
  f.view.setProjection("perspective");
  for (const time of [0, 80, 160, 240, 500]) {
    f.frame(time);
    const point = { x: f.view.camera.x + 2, y: 66, z: f.view.camera.z + 1 };
    const rendered = f.rendered.at(-1).camera;
    const ndc = new three.Vector3(point.x - f.view.origin.x, point.y, point.z - f.view.origin.z).project(rendered);
    const actual = f.view.project(point);
    near(actual.x, (ndc.x + 1) * 550); near(actual.y, (1 - ndc.y) * 350);
  }
  f.view.center(-2500, 1800); f.frame(600);
  const point = { x: -2500, y: 66, z: 1800 }, rendered = f.rendered.at(-1).camera;
  assert.notEqual(f.view.origin.x, 0);
  const expected = new three.Vector3(point.x - f.view.origin.x, point.y, point.z - f.view.origin.z).project(rendered);
  near(f.view.project(point).x, (expected.x + 1) * 550);
  assert.equal(f.view.project({ x: 0, y: Infinity, z: 0 }), undefined);
});

test("top-down prefetch warms every edge, prioritizes visible tiles, and reveals cached geometry immediately on a drag", async t => {
  let hold = false;
  const f = sceneFixture(t, true, true, false, 1, { load: (_request, result) => hold ? new Promise(() => {}) : result });
  f.ready();
  const initial = { ...f.view.camera };
  const visible = f.visibleTopDownTiles(initial, 1100, 700);
  for (let i = 0; i < 160; i++) { f.frame(i * 16); await tick(); if (!f.frames.size) break; }
  assert.equal(f.frames.size, 0);
  assert.equal(f.states.at(-1).loading, 0);
  assert(f.requests.length > visible.length);
  assert.deepEqual(new Set(f.requests.slice(0, visible.length).map(tile => `${tile.x}:${tile.z}`)), new Set(visible.map(tile => tile.position)));
  assert(f.states.some(state => state.loading === 0) && f.view.cache.size > visible.length);
  hold = true;
  for (const [dx, dz] of [[48, 0], [-48, 0], [0, 48], [0, -48], [48, 48], [-48, -48]]) {
    const camera = { ...initial, x: initial.x + dx, z: initial.z + dz };
    f.view.setTopDownView(camera, 1100, 700); f.view.renderTopDown();
    assert.equal(f.states.at(-1).loading, 0, "background requests must not appear as visible map loading");
    for (const item of f.visibleTopDownTiles(camera, 1100, 700)) {
      const tile = f.view.displayed.get(item.position);
      assert(tile?.group.visible && tile.group.children.length, `edge ${item.position} must already have renderable geometry`);
    }
    assert(f.view.pending.size <= 2);
  }
});

test("prefetch stays bounded at the cache limit without evicting visible corners or repeatedly fetching tiles", async t => {
  const f = sceneFixture(t, true, true); f.ready();
  f.view.setTopDownView({ x: 0, z: 0, zoom: 4 }, 1800, 1800);
  for (let i = 0; i < 260; i++) { f.frame(i * 16); await tick(); if (!f.frames.size) break; }
  assert.equal(f.frames.size, 0, "a full prefetch cache must stop requesting and rendering");
  assert(f.view.cache.size <= 256); assert(f.view.faces <= 1_200_000);
  assert.equal(f.states.at(-1).loading, 0); assert.equal(f.states.at(-1).limited, false);
  const requests = f.requests.map(tile => `${tile.y}:${tile.x}:${tile.z}`);
  assert.equal(new Set(requests).size, requests.length);
  for (const item of f.visibleTopDownTiles(f.view.camera, 1800, 1800)) assert(f.view.cache.has(`surface:${item.position}`));
});

test("scene sizing ignores ancestor transforms and rounds the GPU buffer to match the color layer", t => {
  const f = sceneFixture(t, true, true, false, .9); f.ready(); f.frame(0);
  assert.equal(f.view.frameView.width, 1100); assert.equal(f.view.frameView.height, 700);
  for (const [width, height, ratio] of [[1101.3, 701.7, 1.25], [701.5, 1101.25, 1.5], [701.5, 1101.25, 2]]) {
    globalThis.devicePixelRatio = ratio;
    f.view.setTopDownView(f.view.camera, width, height); f.frame(16);
    assert.deepEqual(f.view.renderer.size, { width: Math.round(width * ratio), height: Math.round(height * ratio) });
    const camera = f.rendered.at(-1).camera;
    const projected = new three.Vector3(camera.position.x + 17, 64, camera.position.z + 23).project(camera);
    near((projected.x + 1) * width / 2, width / 2 + 17 * f.view.camera.zoom);
    near((1 - projected.y) * height / 2, height / 2 + 23 * f.view.camera.zoom);
  }
});

test("projection changes animate the same scene and retain its meshes, materials, renderer and cached tile requests", async t => {
  const f = sceneFixture(t, false, true); f.ready(); f.frame(0);
  for (let i = 1; i <= 45; i++) { await tick(); f.frame(i * 16); }
  const renderer = f.view.renderer, scene = f.rendered.at(-1).scene, materials = f.view.materials;
  const cached = [...f.view.cache.values()].find(tile => tile.x === 0 && tile.z === -1);
  assert(cached && cached.group.children.length);
  const geometry = cached.group.children[0].geometry;
  const assertShared = () => {
    assert.equal(f.view.renderer, renderer); assert.equal(f.rendered.at(-1).scene, scene);
    assert.equal(f.view.materials, materials); assert.equal(f.view.cache.get(cached.key), cached);
    assert.equal(cached.group.children[0].geometry, geometry);
    // Tile groups plus the overworld's own cloud layer, which is part of the sky.
    assert(scene.children.every(child => child.isGroup || child === f.view.clouds?.mesh), "no screenshot or second-map transition plane");
  };
  f.view.setProjection("perspective"); f.frame(720);
  assert.equal(f.view.controls.enabled, false); assertShared();
  f.frame(1120);
  assert(f.view.blend > 0 && f.view.blend < 1); assertShared();
  const pose = transitionPose(700, 4, f.view.blend, load("shared/map.ts").MAP_MAX_Y + 64 - f.view.controls.target.y);
  const edge = new three.Vector3(0, pose.halfHeight, -pose.distance).applyMatrix4(f.rendered.at(-1).matrix);
  near(edge.y, 1, "both projections retain the same target-plane scale during the camera movement");
  f.frame(1520);
  assert.equal(f.view.isTransitioning, false); assert.equal(f.view.controls.enabled, true);
  assert.equal(f.rendered.at(-1).camera.isPerspectiveCamera, true); near(f.view.camera.zoom, 4); assertShared();
  f.view.setProjection("orthographic"); f.frame(1920); assertShared(); f.frame(2320);
  assert.equal(f.view.isTransitioning, false); assert.equal(f.view.controls.enabled, false);
  assert.equal(f.rendered.at(-1).camera.isOrthographicCamera, true); assertShared();
  for (let i = 0; i < 45; i++) { await tick(); f.frame(2336 + i * 16); }
  const keys = f.requests.map(request => `${request.y}:${request.x}:${request.z}`);
  assert.equal(new Set(keys).size, keys.length, "projection changes must not refetch already cached tiles");
  f.view.setActive(false); f.view.center(1000, 1000); await tick();
  assert.equal(f.frames.size, 0, "far overviews pause GPU work and scene loading");
  assert.equal(f.view.cache.get(cached.key), cached);
  f.view.dispose(); assert.equal(f.frames.size, 0); assert.equal(f.listeners.size, 0);
  assert(f.requests.every(request => request.signal.aborted));
});

test("projection animation can reverse mid-flight and restores the previous orbit without a camera jump", t => {
  const f = sceneFixture(t, false, true); f.ready(); f.frame(0);
  f.view.setProjection("perspective"); f.frame(320);
  const before = f.rendered.at(-1).camera;
  f.view.setProjection("orthographic"); f.frame(320);
  const after = f.rendered.at(-1).camera;
  near(before.position.distanceTo(after.position), 0);
  before.projectionMatrix.elements.forEach((value, i) => near(value, after.projectionMatrix.elements[i]));
  f.frame(640); assert.equal(f.view.frameView.orthographic, true);
  f.view.setProjection("perspective"); f.frame(1440);
  const orbit = new three.Vector3(-30, 60, 40).setLength(40);
  f.view.viewCamera.position.copy(f.view.controls.target).add(orbit); f.view.viewCamera.lookAt(f.view.controls.target);
  f.view.setProjection("orthographic"); f.frame(2240);
  f.view.setProjection("perspective"); f.frame(3040);
  near(f.view.viewCamera.position.clone().sub(f.view.controls.target).distanceTo(orbit), 0);
  near(f.view.camera.zoom, 4);
  f.view.setProjection("orthographic"); f.frame(3200); f.view.dispose();
  assert.equal(f.view.isTransitioning, false); assert.equal(f.frames.size, 0);
});

test("reduced-motion views change projection in one frame using the same renderer", t => {
  const f = sceneFixture(t, true, true); f.ready(); f.frame(0);
  const renderer = f.view.renderer;
  f.view.setProjection("perspective"); f.frame(0);
  assert.equal(f.view.isTransitioning, false); assert.equal(f.rendered.at(-1).camera.isPerspectiveCamera, true);
  f.view.setProjection("orthographic"); f.frame(0);
  assert.equal(f.view.isTransitioning, false); assert.equal(f.rendered.at(-1).camera.isOrthographicCamera, true);
  assert.equal(f.view.renderer, renderer);
});

test("switching projections cancels real OrbitControls inertia without changing the saved orbit or target", t => {
  const f = sceneFixture(t, false, false, true); f.ready(); f.frame(0);
  f.view.controls.rotateLeft(.8); f.view.controls.pan(24, 12);
  const position = f.view.viewCamera.position.clone(), target = f.view.controls.target.clone(), zoom = f.view.camera.zoom;
  f.view.setProjection("orthographic");
  near(f.view.viewCamera.position.distanceTo(position), 0); near(f.view.controls.target.distanceTo(target), 0);
  near(f.view.camera.x, target.x + f.view.origin.x); near(f.view.camera.z, target.z + f.view.origin.z);
  f.frame(800); f.view.setProjection("perspective"); f.frame(1600);
  near(f.view.viewCamera.position.distanceTo(position), 0); near(f.view.controls.target.distanceTo(target), 0);
  near(f.view.camera.zoom, zoom);
  f.frame(1616);
  near(f.view.viewCamera.position.distanceTo(position), 0);
});

test("flat 2D layer maps onto the moving transition camera so it fades with the perspective", t => {
  const f = sceneFixture(t, false, true);
  f.ready(); f.frame(0);
  const { worldPosition } = load("panel/src/map/viewport.ts");
  f.view.setProjection("perspective");
  for (const time of [0, 200, 400, 600]) {
    f.frame(time);
    const matrix = f.view.surfaceMatrix(), progress = f.view.transitionProgress;
    assert(matrix?.length === 16); assert(progress >= 0 && progress <= 1);
    const camera = { ...f.view.camera }, bearing = f.view.bearing, plane = f.view.controls.target.y;
    for (const [x, y] of [[550, 350], [800, 200], [300, 600]]) {
      const world = worldPosition(camera, 1100, 700, x, y, bearing);
      const direct = f.view.project({ x: world.x, y: plane, z: world.z });
      const point = new three.Vector4(x, y, 0, 1).applyMatrix4(new three.Matrix4().fromArray(matrix));
      assert(direct && Math.abs(point.x / point.w - direct.x) < 1e-6 && Math.abs(point.y / point.w - direct.y) < 1e-6);
    }
  }
});

test("the orthographic scene has exact 2D scale at every elevation and remains aligned after rebasing or resizing", async t => {
  const f = sceneFixture(t, false, true);
  const { MAP_MIN_Y, MAP_MAX_Y } = load("shared/map.ts");
  f.ready();
  for (const [x, z, zoom, width, height] of [[-1105.25, 3000.375, 4, 1100, 700], [29999998.75, -29999998.125, 12, 701.5, 1101.25]]) {
    const target = { x, z, zoom };
    f.view.setTopDownView(target, width, height); f.frame(0);
    const render = f.rendered.at(-1), camera = render.camera;
    assert.equal(camera.isOrthographicCamera, true);
    assert.equal(render.scene.fog, null); assert.equal(render.scene.background, null);
    assert.equal(f.view.controls.enabled, false);
    assert(f.uniforms.uFogNear.value > camera.far, "overhead camera must not fog out terrain");
    for (const y of [MAP_MIN_Y, -64, 64, MAP_MAX_Y + 1]) {
      const projected = new three.Vector3(camera.position.x + 17, y, camera.position.z + 23).project(camera);
      near(projected.x, 17 * zoom * 2 / width); near(projected.y, -23 * zoom * 2 / height);
      assert(projected.z >= -1 && projected.z <= 1, "the entire supported terrain height range is visible");
    }
    assert.deepEqual(f.view.frameView, { camera: target, width, height, bearing: 0, orthographic: true });
  }
  assert.equal(f.view.renderer.options.alpha, true);
  assert(!f.view.renderer.options.preserveDrawingBuffer, "direct canvas composition needs no retained readback buffer");
  for (let i = 0; i < 40 && f.frames.size; i++) { await tick(); f.frame(48 + i * 16); }
  await tick(); f.frame(800);
  assert.equal(f.frames.size, 0);
  const { camera, width, height } = f.view.frameView;
  f.view.setTopDownView(camera, width, height);
  assert.equal(f.frames.size, 0, "syncing an unchanged 2D view must not keep WebGL rendering");
  f.view.dispose(); assert(f.requests.every(request => request.signal.aborted));
});

test("orthographic tile coverage reaches all viewport edges at different aspect ratios and zoom levels", t => {
  const { visibleTopDownTiles } = sceneFixture(t, false, true);
  const { MAP_SCENE_SIZE, MAP_LIMIT } = load("shared/map.ts");
  for (const [x, z] of [[0, 0], [-128.75, 65.375], [MAP_LIMIT, -MAP_LIMIT]]) {
    for (const [width, height] of [[1100, 700], [3840, 2160], [360, 800]]) for (const zoom of [4, 7.125, 12]) {
      const camera = { x, z, zoom }, tiles = visibleTopDownTiles(camera, width, height);
      const keys = new Set(tiles.map(tile => tile.position));
      for (const sx of [0, width / 2, width - .001]) for (const sy of [0, height / 2, height - .001]) {
        const tx = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, x + (sx - width / 2) / zoom));
        const tz = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, z + (sy - height / 2) / zoom));
        assert(keys.has(`${Math.floor(tx / MAP_SCENE_SIZE)}:${Math.floor(tz / MAP_SCENE_SIZE)}`));
      }
      const distance = tile => Math.hypot((tile.x + .5) * MAP_SCENE_SIZE - x, (tile.z + .5) * MAP_SCENE_SIZE - z);
      for (let i = 1; i < tiles.length; i++) assert(distance(tiles[i - 1]) <= distance(tiles[i]));
    }
  }
});

test("the overworld sky carries Minecraft's cloud layer, which leaves with the perspective view", t => {
  const f = sceneFixture(t); f.ready(); f.frame(0);
  const clouds = f.view.clouds;
  assert(clouds, "overworld maps have clouds");
  assert(f.rendered.at(-1).scene.children.includes(clouds.mesh));
  assert.equal(clouds.mesh.visible, true);
  assert(clouds.mesh.geometry.instanceCount > 1000, "the full 128-chunk cloud range is meshed");
  assert(f.view.viewCamera.far >= 2048, "the far plane reaches the cloud fog end");
  const uniforms = clouds.mesh.material.uniforms;
  near(uniforms.uOffset.value.y, 192.33, "clouds sit at the overworld cloud height");
  // Orbiting up into the layer fades it instead of veiling the map with cloud tops.
  const position = f.view.viewCamera.position.clone();
  clouds.update(new three.Vector3(position.x, 184.33, position.z), { x: 0, z: 0 }, 0, 1);
  near(uniforms.uOpacity.value, 0.5);
  clouds.update(new three.Vector3(position.x, 200, position.z), { x: 0, z: 0 }, 0, 1);
  assert.equal(clouds.mesh.visible, false);
  clouds.update(position, { x: 0, z: 0 }, 0, 1);
  f.view.setProjection("orthographic");
  for (let time = 16; time <= 2000; time += 100) f.frame(time);
  assert.equal(f.view.isTransitioning, false);
  assert.equal(clouds.mesh.visible, false, "the overhead map has no clouds over it");
});

for (const dimension of ["minecraft:the_nether", "minecraft:the_end"]) test(dimension + " has no cloud_color and therefore no clouds", t => {
  const f = sceneFixture(t, false, false, false, 1, { dimension }); f.ready(); f.frame(0);
  assert.equal(f.view.clouds, undefined);
  assert(f.rendered.at(-1).scene.children.every(child => child.isGroup));
});
