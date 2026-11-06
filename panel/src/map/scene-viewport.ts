import { BufferAttribute, Color, Group, InstancedBufferAttribute, InstancedBufferGeometry, Matrix4, Mesh, MOUSE, OrthographicCamera, PerspectiveCamera, Scene, Sphere, TOUCH, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MAP_LIMIT, MAP_MIN_Y, MAP_MAX_Y, MAP_SCENE_SIZE, type MapSceneTile, type MapWorld } from "../../../shared/map";
import type { Camera, MapRenderer, MapViewState } from "./viewport";
import { decodeScene } from "./scene-codec";
import { sceneMaterials } from "./scene-materials";
import { MAP_FOV, PERSPECTIVE_TRANSITION_MS, transitionPose, transitionProjection } from "./perspective-transition";
import { SceneKind } from "../../../shared/scene";
import { sortTransparentFaces } from "./scene-transparency";
import { KeyboardNavigation } from "./navigation";
import { normalizeBearing, rotatedSize, screenToWorld, tileInView } from "./bearing";

const SIZE = MAP_SCENE_SIZE, MAX_FACES = 1_200_000, PREFETCH_MARGIN = SIZE * 2;
const tileKey = (x: number, z: number) => `surface:${x}:${z}`;
const clamp = (value: number) => Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, value));
interface SceneTile { x: number; z: number; key: string; position: string; group: Group; heights: Int16Array; count: number; warnings: number; limited: boolean; animated: boolean }

export function visibleSceneTiles(camera: Camera) {
  const x = Math.floor(camera.x / SIZE), z = Math.floor(camera.z / SIZE);
  const radius = camera.zoom >= 3 ? 2 : 3, limit = Math.ceil(MAP_LIMIT / SIZE);
  const tiles: { x: number; z: number; position: string }[] = [];
  for (let tz = Math.max(-limit, z - radius); tz <= Math.min(limit, z + radius); tz++) {
    for (let tx = Math.max(-limit, x - radius); tx <= Math.min(limit, x + radius); tx++) tiles.push({ x: tx, z: tz, position: `${tx}:${tz}` });
  }
  return tiles.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
}

export function visibleTopDownTiles(camera: Camera, width: number, height: number, margin = 0, bearing = 0) {
  const size = rotatedSize(width / camera.zoom + margin * 2, height / camera.zoom + margin * 2, bearing);
  const halfWidth = size.width / 2, halfHeight = size.height / 2;
  const limit = Math.ceil(MAP_LIMIT / SIZE), tiles: { x: number; z: number; position: string }[] = [];
  for (let z = Math.max(-limit, Math.floor((camera.z - halfHeight) / SIZE)); z <= Math.min(limit, Math.floor((camera.z + halfHeight) / SIZE)); z++) {
    for (let x = Math.max(-limit, Math.floor((camera.x - halfWidth) / SIZE)); x <= Math.min(limit, Math.floor((camera.x + halfWidth) / SIZE)); x++) {
      if (tileInView(x * SIZE, z * SIZE, SIZE, camera, width / camera.zoom / 2 + margin, height / camera.zoom / 2 + margin, bearing)) tiles.push({ x, z, position: `${x}:${z}` });
    }
  }
  return tiles.sort((a, b) => Math.hypot((a.x + .5) * SIZE - camera.x, (a.z + .5) * SIZE - camera.z) - Math.hypot((b.x + .5) * SIZE - camera.x, (b.z + .5) * SIZE - camera.z));
}

export class SceneViewport implements MapRenderer {
  readonly camera: Camera = { x: 0, z: 0, zoom: 2 };
  private readonly scene = new Scene();
  private readonly viewCamera = new PerspectiveCamera(MAP_FOV, 1, 0.1, 600);
  private readonly topCamera = new OrthographicCamera(-1, 1, 1, -1, .1, MAP_MAX_Y - MAP_MIN_Y + 128);
  private topZoom = 2;
  private topBearing = 0;
  private width = 1;
  private height = 1;
  private pixelRatio = 0;
  private readonly renderer: WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly materials: ReturnType<typeof sceneMaterials>;
  private readonly observer: ResizeObserver;
  private readonly navigation: KeyboardNavigation;
  private readonly abort = new AbortController();
  private readonly cache = new Map<string, SceneTile>();
  private readonly displayed = new Map<string, SceneTile>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly skipped = new Set<string>();
  private visible = new Set<string>();
  private wanted = new Set<string>();
  private origin = { x: 0, z: 0 };
  private anchor = "";
  private faces = 0;
  private frame = 0;
  private animationTimer?: ReturnType<typeof setTimeout>;
  private lost = false;
  private error?: unknown;
  private atlasReady = false;
  private active = true;
  private blend: number;
  private orbit = { polar: Math.acos(1 / Math.sqrt(3)), azimuth: Math.PI / 4 };
  private transition?: { from: number; to: number; startedAt: number };
  private readonly sky: Color;
  private playerProjection?: Matrix4;
  private readonly reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  project(position: { x: number; y: number; z: number }) {
    if (!this.playerProjection) return;
    const point = new Vector3(position.x - this.origin.x, position.y, position.z - this.origin.z).applyMatrix4(this.playerProjection);
    if (!point.toArray().every(Number.isFinite) || point.z < -1 || point.z > 1) return;
    return { x: (point.x + 1) * this.width / 2, y: (1 - point.y) * this.height / 2 };
  }

  projectSpawn() {
    const height = this.elevation(this.world.spawn.x, this.world.spawn.z);
    return height === undefined ? undefined : this.project({ ...this.world.spawn, y: height + 3.5 });
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: MapWorld,
    private readonly load: (world: string, x: number, z: number, signal: AbortSignal) => Promise<MapSceneTile>,
    private readonly changed: (state: MapViewState) => void,
    private projection: "perspective" | "orthographic" = "perspective",
    private readonly inputCanvas = canvas
  ) {
    this.blend = this.topDown ? 0 : 1;
    try { this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" }); }
    catch { throw new Error("MC_MAP_WEBGL_UNAVAILABLE"); }
    const nether = world.dimension === "minecraft:the_nether", end = world.dimension === "minecraft:the_end";
    const sky = nether ? 0x482728 : end ? 0x242036 : 0xbad8f3;
    this.sky = new Color(sky);
    this.materials = sceneMaterials(sky, nether, () => { this.atlasReady = true; this.schedule(); }, () => { if (!this.abort.signal.aborted) { this.error = new Error("MC_MAP_READ_FAILED"); this.schedule(); } });
    this.origin = { x: Math.floor(world.spawn.x / SIZE) * SIZE, z: Math.floor(world.spawn.z / SIZE) * SIZE };
    const target = new Vector3(world.spawn.x - this.origin.x, 66, world.spawn.z - this.origin.z);
    this.viewCamera.position.copy(target).add(new Vector3(46, 46, 46).setLength(80));
    this.controls = new OrbitControls(this.viewCamera, inputCanvas);
    this.controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    this.controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
    this.controls.target.copy(target);
    this.controls.minDistance = 160 / 12; this.controls.maxDistance = 160;
    this.controls.minPolarAngle = 0.08; this.controls.maxPolarAngle = Math.PI / 2 - 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.enableDamping = !this.reducedMotion; this.controls.dampingFactor = 0.16;
    this.controls.rotateSpeed = 0.65; this.controls.panSpeed = 0.85;
    this.controls.enabled = !this.topDown;
    this.controls.addEventListener("change", this.schedule);
    this.camera.x = world.spawn.x; this.camera.z = world.spawn.z;
    Object.defineProperty(this.camera, "zoom", { enumerable: true,
      get: () => this.topDown || this.transition ? this.topZoom : Math.max(1, Math.min(12, 160 / this.controls.getDistance())),
      set: (zoom: number) => this.setZoom(zoom)
    });
    this.controls.update();
    inputCanvas.addEventListener("pointerdown", this.focus);
    this.navigation = new KeyboardNavigation(inputCanvas,
      () => !this.topDown && !this.transition && this.active && !this.lost && this.controls.enabled && !this.abort.signal.aborted, this.schedule);
    canvas.addEventListener("webglcontextlost", this.contextLost);
    this.observer = new ResizeObserver(this.resize);
    if (inputCanvas === canvas) { this.observer.observe(canvas); this.resize(); }
  }

  private get topDown() { return this.projection === "orthographic"; }
  get ready() { return this.atlasReady && !this.lost && !this.abort.signal.aborted; }
  get isTransitioning() { return !!this.transition; }
  get bearing() {
    if (this.topDown || this.transition) return this.topBearing;
    const offset = this.viewCamera.position.clone().sub(this.controls.target);
    return normalizeBearing(-Math.atan2(offset.x, offset.z));
  }
  get frameView() { return { camera: { ...this.camera }, width: this.width, height: this.height, bearing: this.bearing, orthographic: this.topDown && !this.transition }; }

  setProjection(projection: "perspective" | "orthographic") {
    if (this.abort.signal.aborted || projection === this.projection) return;
    this.navigation.clear();
    this.advanceTransition();
    // Clear an unfinished drag and its inertia without moving the current camera.
    const position = this.viewCamera.position.clone(), target = this.controls.target.clone(), rotation = this.viewCamera.quaternion.clone();
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false; this.controls.update(); this.controls.enableDamping = damping;
    this.viewCamera.position.copy(position); this.controls.target.copy(target); this.viewCamera.quaternion.copy(rotation);
    this.controls.disconnect(); this.controls.connect(this.inputCanvas);
    this.camera.x = clamp(target.x + this.origin.x); this.camera.z = clamp(target.z + this.origin.z);
    if (!this.topDown && !this.transition) {
      this.topZoom = this.camera.zoom;
      const offset = this.viewCamera.position.clone().sub(this.controls.target);
      this.orbit = { polar: Math.acos(offset.y / offset.length()), azimuth: Math.atan2(offset.x, offset.z) };
      this.topBearing = normalizeBearing(-this.orbit.azimuth);
    } else if (!this.transition) {
      this.controls.target.y = (this.elevation(this.camera.x, this.camera.z) ?? this.controls.target.y - 2) + 2;
      this.orbit.azimuth = -this.topBearing;
    }
    this.projection = projection;
    this.transition = { from: this.blend, to: this.topDown ? 0 : 1, startedAt: performance.now() };
    this.controls.enabled = false;
    this.schedule();
  }

  setActive(active: boolean) {
    if (this.active === active || this.abort.signal.aborted) return;
    this.active = active;
    if (!active) this.navigation.clear();
    if (active) this.schedule();
    else { cancelAnimationFrame(this.frame); this.frame = 0; clearTimeout(this.animationTimer); }
  }

  setTopDownView(camera: Camera, width: number, height: number, bearing = this.topBearing) {
    if (!this.topDown || this.abort.signal.aborted || width <= 0 || height <= 0) return;
    this.setSize(width, height);
    if (camera.zoom !== this.topZoom) this.setZoom(camera.zoom);
    if (camera.x !== this.camera.x || camera.z !== this.camera.z) this.center(camera.x, camera.z);
    if (!this.transition && bearing !== this.topBearing) this.setBearing(bearing);
  }

  /** Paint pending top-down changes in the same browser frame as the 2D map. */
  renderTopDown() {
    if (!this.topDown || this.transition || !this.frame || !this.active || this.lost || this.abort.signal.aborted) return;
    cancelAnimationFrame(this.frame); this.frame = 0;
    this.draw();
  }

  center(x: number, z: number) {
    this.error = undefined;
    const offset = this.viewCamera.position.clone().sub(this.controls.target);
    this.controls.target.x = clamp(x) - this.origin.x;
    this.controls.target.z = clamp(z) - this.origin.z;
    this.viewCamera.position.copy(this.controls.target).add(offset);
    this.camera.x = clamp(x); this.camera.z = clamp(z);
    this.rebase(); this.schedule();
  }

  zoom(factor: number) { if (Number.isFinite(factor) && factor > 0) this.setZoom(this.camera.zoom * factor); }

  setBearing(value: number) {
    if (!Number.isFinite(value) || this.abort.signal.aborted) return;
    this.topBearing = normalizeBearing(value);
    if (this.topDown && !this.transition) { this.schedule(); return; }
    // Discard mouse inertia before resetting yaw so the next frame stays north-up.
    const position = this.viewCamera.position.clone(), target = this.controls.target.clone();
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false; this.controls.update(); this.controls.enableDamping = damping;
    this.controls.target.copy(target); this.viewCamera.position.copy(position);
    this.orbit.azimuth = -this.topBearing;
    if (this.transition) this.advanceTransition();
    else {
      const distance = Math.hypot(position.x - target.x, position.z - target.z);
      this.viewCamera.position.set(target.x - Math.sin(this.topBearing) * distance, position.y, target.z + Math.cos(this.topBearing) * distance);
      this.viewCamera.lookAt(target); this.controls.update();
    }
    this.schedule();
  }

  dispose() {
    if (this.abort.signal.aborted) return;
    this.navigation.dispose();
    this.abort.abort(); cancelAnimationFrame(this.frame); this.frame = 0;
    this.transition = undefined;
    clearTimeout(this.animationTimer);
    this.observer.disconnect(); this.controls.removeEventListener("change", this.schedule); this.controls.dispose();
    this.inputCanvas.removeEventListener("pointerdown", this.focus);
    this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    for (const tile of [...this.cache.values()]) this.remove(tile);
    this.displayed.clear(); this.pending.clear(); this.failed.clear(); this.skipped.clear();
    this.materials[0].uniforms.uAtlas.value.dispose(); this.materials[0].uniforms.uAnimation.value.dispose();
    for (const material of this.materials) material.dispose();
    this.scene.clear();
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }

  private setZoom(value: number) {
    if (!Number.isFinite(value) || this.abort.signal.aborted) return;
    if (this.topDown || this.transition) { this.topZoom = Math.max(1, Math.min(12, value)); this.schedule(); return; }
    const offset = this.viewCamera.position.clone().sub(this.controls.target).setLength(160 / Math.max(1, Math.min(12, value)));
    this.viewCamera.position.copy(this.controls.target).add(offset);
    this.controls.update(); this.schedule();
  }

  private focus = () => { if (!this.topDown) this.inputCanvas.focus({ preventScroll: true }); };
  private contextLost = (event: Event) => {
    this.navigation.clear();
    event.preventDefault(); this.lost = true; cancelAnimationFrame(this.frame); this.frame = 0;
    clearTimeout(this.animationTimer);
    this.changed({ ...this.camera, loading: 0, warnings: 0, error: new Error("MC_MAP_WEBGL_UNAVAILABLE") });
  };
  private resize = (entries: ResizeObserverEntry[] = []) => {
    const size = entries.find(entry => entry.target === this.canvas)?.contentRect;
    this.setSize(size?.width ?? this.canvas.clientWidth, size?.height ?? this.canvas.clientHeight);
  };
  setSize(width: number, height: number) {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    if (this.abort.signal.aborted || width <= 0 || height <= 0 || this.width === width && this.height === height && this.pixelRatio === ratio) return;
    this.width = width; this.height = height; this.pixelRatio = ratio;
    // Use the same rounded buffer dimensions as the 2D layers. Explicit physical
    // sizes avoid Three flooring the buffer but rounding the viewport at fractional DPR.
    this.renderer.setSize(Math.round(width * ratio), Math.round(height * ratio), false);
    this.viewCamera.aspect = width / height; this.viewCamera.updateProjectionMatrix(); this.schedule();
  }
  private schedule = () => {
    if (this.abort.signal.aborted || this.frame || this.lost || !this.active) return;
    this.frame = requestAnimationFrame(time => { this.frame = 0; this.draw(time); });
  };

  private rebase() {
    const target = this.controls.target;
    if (Math.abs(target.x) < 1024 && Math.abs(target.z) < 1024) return;
    const x = Math.floor(target.x / SIZE) * SIZE, z = Math.floor(target.z / SIZE) * SIZE;
    this.origin.x += x; this.origin.z += z;
    target.x -= x; target.z -= z; this.viewCamera.position.x -= x; this.viewCamera.position.z -= z;
    for (const tile of this.cache.values()) { tile.group.position.x -= x; tile.group.position.z -= z; }
  }

  private elevation(x: number, z: number) {
    const tx = Math.floor(x / SIZE), tz = Math.floor(z / SIZE);
    const tile = this.cache.get(tileKey(tx, tz)) ?? this.displayed.get(`${tx}:${tz}`);
    const value = tile?.heights[(Math.floor(z) - tz * SIZE) * SIZE + Math.floor(x) - tx * SIZE];
    return value === undefined || value === -32768 ? undefined : value;
  }

  private draw(time = performance.now()) {
    clearTimeout(this.animationTimer);
    if (!this.transition && !this.topDown) this.controls.update();
    const movement = this.navigation.advance(time);
    if (movement) {
      const scale = 2 * this.controls.getDistance() * Math.tan(this.viewCamera.fov * Math.PI / 360) / this.height;
      const offset = screenToWorld(movement.x * scale, movement.y * scale, this.bearing);
      this.controls.target.x += offset.x; this.controls.target.z += offset.z;
      this.viewCamera.position.x += offset.x; this.viewCamera.position.z += offset.z;
    }
    const x = clamp(this.controls.target.x + this.origin.x), z = clamp(this.controls.target.z + this.origin.z);
    if (x !== this.controls.target.x + this.origin.x || z !== this.controls.target.z + this.origin.z) this.center(x, z);
    this.camera.x = x; this.camera.z = z; this.rebase();
    let tiles = this.topDown ? visibleTopDownTiles(this.camera, this.width, this.height, 0, this.topBearing) : visibleSceneTiles(this.camera);
    if (this.transition) {
      // Keep both endpoint footprints in the same scene throughout a projection change.
      const coverage = new Map([...visibleTopDownTiles(this.camera, this.width, this.height, 0, this.topBearing), ...visibleSceneTiles(this.camera)].map(tile => [tile.position, tile]));
      tiles = [...coverage.values()].sort((a, b) => this.distance(a) - this.distance(b));
    }
    const anchor = tiles.map(tile => tile.position).sort().join("|");
    if (this.anchor !== anchor) { this.anchor = anchor; this.skipped.clear(); this.failed.clear(); }
    this.visible = new Set(tiles.map(tile => tileKey(tile.x, tile.z)));
    // Fetch the visible footprint first, then keep two rings of ready geometry
    // outside every edge. Moving the camera can reveal them without a request.
    const buffered = this.topDown && !this.transition ? visibleTopDownTiles(this.camera, this.width, this.height, PREFETCH_MARGIN, this.topBearing) : [];
    const coverage = [...tiles, ...buffered.filter(tile => !this.visible.has(tileKey(tile.x, tile.z)))];
    this.wanted = new Set(coverage.map(tile => tileKey(tile.x, tile.z)));
    const positions = new Set(tiles.map(tile => tile.position));
    for (const [position, tile] of this.displayed) if (!positions.has(position)) { tile.group.visible = false; this.displayed.delete(position); }
    let warnings = 0, limited = [...this.skipped].some(key => this.visible.has(key)), count = 0, animated = false;
    for (const item of tiles) {
      const tile = this.cache.get(tileKey(item.x, item.z)) ?? this.displayed.get(item.position);
      if (!tile) continue;
      const previous = this.displayed.get(item.position);
      if (previous && previous !== tile) previous.group.visible = false;
      tile.group.visible = true; this.displayed.set(item.position, tile);
      warnings += tile.warnings; limited ||= tile.limited; count += tile.count;
      animated ||= tile.animated;
    }
    const ground = this.elevation(x, z);
    let settling = false;
    if (ground !== undefined && !this.topDown && !this.transition) {
      const remaining = ground + 2 - this.controls.target.y;
      const delta = this.reducedMotion || Math.abs(remaining) < 0.05 ? remaining : remaining * 0.25;
      this.controls.target.y += delta; this.viewCamera.position.y += delta;
      settling = Math.abs(remaining) >= 0.05 && !this.reducedMotion;
    }
    this.materials[0].uniforms.uTime.value = performance.now() / 1000;
    const transitioning = this.advanceTransition();
    const orthographic = this.topDown && !this.transition;
    this.scene.background = orthographic ? null : this.sky;
    const fogScale = this.blend === 1 ? 1 : 1 / Math.max(.0001, this.blend ** 8);
    this.materials[0].uniforms.uFogNear.value = 96 * fogScale;
    this.materials[0].uniforms.uFogFar.value = 220 * fogScale;
    if (orthographic) {
      this.topCamera.left = -this.width / this.topZoom / 2; this.topCamera.right = -this.topCamera.left;
      this.topCamera.top = this.height / this.topZoom / 2; this.topCamera.bottom = -this.topCamera.top;
      this.topCamera.position.set(this.controls.target.x, MAP_MAX_Y + 64, this.controls.target.z);
      this.topCamera.up.set(Math.sin(this.topBearing), 0, -Math.cos(this.topBearing));
      this.topCamera.lookAt(this.controls.target.x, MAP_MIN_Y, this.controls.target.z);
      this.topCamera.updateProjectionMatrix();
    }
    const activeCamera = orthographic ? this.topCamera : this.viewCamera;
    activeCamera.updateMatrixWorld(); this.scene.updateMatrixWorld();
    this.playerProjection = new Matrix4().multiplyMatrices(activeCamera.projectionMatrix, activeCamera.matrixWorldInverse);
    const transform = new Matrix4();
    for (const tile of this.displayed.values()) for (const child of tile.group.children) {
      const mesh = child as Mesh<InstancedBufferGeometry>;
      if (mesh.material === this.materials[SceneKind.Translucent]) sortTransparentFaces(mesh.geometry,
        transform.multiplyMatrices(activeCamera.matrixWorldInverse, mesh.matrixWorld));
    }
    this.renderer.render(this.scene, activeCamera);
    const needed = coverage.filter(tile => {
      const key = tileKey(tile.x, tile.z);
      return !this.cache.has(key) && !this.pending.has(key) && !this.failed.has(key) && !this.skipped.has(key);
    });
    const loading = needed.filter(tile => this.visible.has(tileKey(tile.x, tile.z))).length
      + [...this.pending].filter(key => this.visible.has(key)).length;
    this.changed({ x: Math.round(x), z: Math.round(z), zoom: this.camera.zoom, bearing: this.bearing, loading, warnings, limited, empty: !loading && !count && !this.error, error: this.error });
    for (const item of needed.slice(0, Math.max(0, 2 - this.pending.size))) void this.fetch(item);
    if (settling || transitioning || movement) this.schedule();
    if (this.transition || animated && !this.reducedMotion) this.animationTimer = setTimeout(this.schedule, 50);
  }

  private advanceTransition() {
    const transition = this.transition;
    if (!transition) return false;
    const duration = Math.max(1, PERSPECTIVE_TRANSITION_MS * Math.abs(transition.to - transition.from));
    const progress = this.reducedMotion ? 1 : Math.min(1, (performance.now() - transition.startedAt) / duration);
    this.blend = transition.from + (transition.to - transition.from) * progress;
    const target = this.controls.target;
    const pose = transitionPose(this.height, this.topZoom, this.blend, MAP_MAX_Y + 64 - target.y, this.orbit);
    // Retain yaw while tilting between overhead and perspective views.
    pose.azimuth = -this.topBearing;
    this.viewCamera.position.copy(target).add(new Vector3(Math.sin(pose.polar) * Math.sin(pose.azimuth), Math.cos(pose.polar), Math.sin(pose.polar) * Math.cos(pose.azimuth)).multiplyScalar(pose.distance));
    this.viewCamera.up.set(Math.sin(this.topBearing) * (1 - pose.progress), pose.progress, -Math.cos(this.topBearing) * (1 - pose.progress));
    this.viewCamera.lookAt(target);
    // Match both projections' scale at the target while the camera descends from above the world's height limit.
    this.viewCamera.fov = 2 * Math.atan(pose.halfHeight / pose.distance) * 180 / Math.PI;
    this.viewCamera.far = Math.max(600, pose.distance + target.y - MAP_MIN_Y + 128);
    this.viewCamera.updateProjectionMatrix();
    this.viewCamera.projectionMatrix.copy(transitionProjection(this.viewCamera.projectionMatrix, this.viewCamera.aspect, this.viewCamera.near, this.viewCamera.far, pose));
    this.viewCamera.projectionMatrixInverse.copy(this.viewCamera.projectionMatrix).invert();
    if (progress >= 1) {
      this.transition = undefined;
      this.controls.enabled = !this.topDown;
        if (!this.topDown) {
        this.viewCamera.up.set(0, 1, 0); this.viewCamera.fov = MAP_FOV; this.viewCamera.far = 600; this.viewCamera.updateProjectionMatrix();
        this.controls.update();
      }
    }
    return progress < 1;
  }

  private distance(tile: { x: number; z: number }) { return Math.hypot((tile.x + 0.5) * SIZE - this.camera.x, (tile.z + 0.5) * SIZE - this.camera.z); }

  private room(count: number, incoming: { x: number; z: number }) {
    const maxTiles = 256;
    const incomingKey = tileKey(incoming.x, incoming.z), incomingVisible = this.visible.has(incomingKey);
    while (this.cache.size >= maxTiles || this.faces + count > MAX_FACES) {
      // Late responses can still be reused after a reversal, but must not evict
      // geometry needed by the current view or its prefetch margin.
      if (!this.wanted.has(incomingKey)) return false;
      const candidates = [...this.cache.values()].sort((a, b) => Number(this.visible.has(a.key)) - Number(this.visible.has(b.key))
        || Number(this.wanted.has(a.key)) - Number(this.wanted.has(b.key)) || this.distance(b) - this.distance(a));
      const oldest = candidates[0];
      if (!oldest) return false;
      if (this.visible.has(oldest.key) && (!incomingVisible || this.distance(oldest) <= this.distance(incoming))) return false;
      if (!incomingVisible && this.wanted.has(oldest.key) && this.distance(oldest) <= this.distance(incoming)) return false;
      if (this.wanted.has(oldest.key)) this.skipped.add(oldest.key);
      this.remove(oldest);
    }
    return true;
  }

  private remove(tile: SceneTile) {
    this.cache.delete(tile.key); this.scene.remove(tile.group); this.faces -= tile.count;
    if (this.displayed.get(tile.position) === tile) this.displayed.delete(tile.position);
    for (const child of tile.group.children) (child as Mesh).geometry.dispose();
    tile.group.clear();
  }

  private async fetch(item: { x: number; z: number; position: string }) {
    const key = tileKey(item.x, item.z), signal = this.abort.signal;
    this.pending.add(key);
    try {
      const result = await this.load(this.world.id, item.x, item.z, signal);
      if (signal.aborted) return;
      const decoded = decodeScene(result);
      if (!this.room(decoded.count, item)) { this.skipped.add(key); return; }
      const group = new Group(); group.visible = false;
      group.position.set(item.x * SIZE - this.origin.x, 0, item.z * SIZE - this.origin.z);
      for (const part of decoded.meshes) {
        const geometry = new InstancedBufferGeometry();
        geometry.setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3));
        geometry.setIndex([0, 1, 2, 0, 2, 3]); geometry.instanceCount = part.count;
        geometry.setAttribute("aOrigin", new InstancedBufferAttribute(part.origins, 3));
        geometry.setAttribute("aSize", new InstancedBufferAttribute(part.sizes, 2));
        geometry.setAttribute("aFace", new InstancedBufferAttribute(part.faces, 1));
        geometry.setAttribute("color", new InstancedBufferAttribute(part.cornerColors[0], 3, true));
        for (let corner = 1; corner < 4; corner++) geometry.setAttribute("aTint" + corner, new InstancedBufferAttribute(part.cornerColors[corner], 3, true));
        geometry.setAttribute("aUvU", new InstancedBufferAttribute(part.uvU, 3));
        geometry.setAttribute("aUvV", new InstancedBufferAttribute(part.uvV, 3));
        if (part.axes) {
          geometry.setAttribute("aAxisU", new InstancedBufferAttribute(part.axes[0], 3));
          geometry.setAttribute("aAxisV", new InstancedBufferAttribute(part.axes[1], 3));
        }
        const materialData = new Uint16Array(part.count * 3);
        for (let i = 0; i < part.count; i++) {
          materialData[i * 3] = part.sprites[i];
          materialData[i * 3 + 1] = part.flags[i];
          materialData[i * 3 + 2] = part.occlusion[i];
        }
        geometry.setAttribute("aMaterial", new InstancedBufferAttribute(materialData, 3));
        const halfHeight = (part.maxY - part.minY) / 2;
        geometry.boundingSphere = new Sphere(new Vector3(SIZE / 2, part.minY + halfHeight, SIZE / 2), Math.hypot(SIZE / Math.SQRT2, halfHeight));
        group.add(new Mesh(geometry, this.materials[part.kind]));
      }
      const tile = { ...item, key, group, heights: decoded.heights, count: decoded.count, warnings: decoded.warnings, limited: decoded.limited, animated: decoded.animated };
      this.cache.set(key, tile); this.scene.add(group); this.faces += tile.count;
    } catch (error) {
      if (!signal.aborted) {
        this.failed.add(key);
        if (this.visible.has(key)) this.error = error;
      }
    } finally {
      this.pending.delete(key); this.schedule();
    }
  }
}
