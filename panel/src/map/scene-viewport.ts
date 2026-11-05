import { BufferAttribute, Color, Fog, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, MeshBasicMaterial, OctahedronGeometry, PerspectiveCamera, Scene, Sphere, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MAP_LIMIT, MAP_SCENE_SIZE, mapHeight, type MapSceneTile, type MapWorld } from "../../../shared/map";
import type { Camera, MapRenderer, MapViewState } from "./viewport";
import { decodeScene } from "./scene-codec";
import { sceneMaterials } from "./scene-materials";

const SIZE = MAP_SCENE_SIZE, MAX_FACES = 1_200_000;
const tileKey = (x: number, z: number, y?: number) => `${y ?? "surface"}:${x}:${z}`;
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

export class SceneViewport implements MapRenderer {
  readonly camera: Camera = { x: 0, z: 0, zoom: 2 };
  private readonly scene = new Scene();
  private readonly viewCamera = new PerspectiveCamera(55, 1, 0.1, 600);
  private readonly renderer: WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly materials: ReturnType<typeof sceneMaterials>;
  private readonly observer: ResizeObserver;
  private readonly marker = new Mesh(new OctahedronGeometry(0.9), new MeshBasicMaterial({ color: 0xffd56a }));
  private readonly abort = new AbortController();
  private readonly cache = new Map<string, SceneTile>();
  private readonly displayed = new Map<string, SceneTile>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly skipped = new Set<string>();
  private visible = new Set<string>();
  private origin = { x: 0, z: 0 };
  private anchor = "";
  private faces = 0;
  private frame = 0;
  private animationTimer?: ReturnType<typeof setTimeout>;
  private lost = false;
  private error?: unknown;
  private readonly reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: MapWorld,
    private readonly load: (world: string, x: number, z: number, signal: AbortSignal, y?: number) => Promise<MapSceneTile>,
    private readonly changed: (state: MapViewState) => void,
    private sliceY?: number
  ) {
    mapHeight(sliceY);
    try { this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" }); }
    catch { throw new Error("MC_MAP_WEBGL_UNAVAILABLE"); }
    const nether = world.dimension === "minecraft:the_nether", end = world.dimension === "minecraft:the_end";
    const sky = nether ? 0x482728 : end ? 0x242036 : 0xbad8f3;
    this.materials = sceneMaterials(sky, nether, this.schedule, () => { if (!this.abort.signal.aborted) { this.error = new Error("MC_MAP_READ_FAILED"); this.schedule(); } });
    this.scene.background = new Color(sky);
    this.scene.fog = new Fog(sky, 90, 235);
    this.scene.add(this.marker);
    this.origin = { x: Math.floor(world.spawn.x / SIZE) * SIZE, z: Math.floor(world.spawn.z / SIZE) * SIZE };
    const target = new Vector3(world.spawn.x - this.origin.x, Math.min(sliceY ?? 64, 64) + 2, world.spawn.z - this.origin.z);
    this.viewCamera.position.copy(target).add(new Vector3(46, 46, 46).setLength(80));
    this.controls = new OrbitControls(this.viewCamera, canvas);
    this.controls.target.copy(target);
    this.controls.minDistance = 160 / 12; this.controls.maxDistance = 160;
    this.controls.minPolarAngle = 0.08; this.controls.maxPolarAngle = Math.PI / 2 - 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.enableDamping = !this.reducedMotion; this.controls.dampingFactor = 0.16;
    this.controls.rotateSpeed = 0.65; this.controls.panSpeed = 0.85;
    this.controls.listenToKeyEvents(canvas);
    this.controls.addEventListener("change", this.schedule);
    this.camera.x = world.spawn.x; this.camera.z = world.spawn.z;
    Object.defineProperty(this.camera, "zoom", { enumerable: true,
      get: () => Math.max(1, Math.min(12, 160 / this.controls.getDistance())),
      set: (zoom: number) => this.setZoom(zoom)
    });
    this.controls.update();
    this.updateClipping();
    canvas.addEventListener("pointerdown", this.focus);
    canvas.addEventListener("webglcontextlost", this.contextLost);
    this.observer = new ResizeObserver(this.resize); this.observer.observe(canvas);
    this.resize();
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

  setLayer(y?: number) {
    mapHeight(y);
    if (this.sliceY === y || this.abort.signal.aborted) return;
    this.sliceY = y; this.failed.clear(); this.skipped.clear(); this.error = undefined;
    this.updateClipping(); this.schedule();
  }

  dispose() {
    if (this.abort.signal.aborted) return;
    this.abort.abort(); cancelAnimationFrame(this.frame); this.frame = 0;
    clearTimeout(this.animationTimer);
    this.observer.disconnect(); this.controls.removeEventListener("change", this.schedule); this.controls.dispose();
    this.canvas.removeEventListener("pointerdown", this.focus);
    this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    for (const tile of [...this.cache.values()]) this.remove(tile);
    this.displayed.clear(); this.pending.clear(); this.failed.clear(); this.skipped.clear();
    this.materials[0].uniforms.uAtlas.value.dispose(); this.materials[0].uniforms.uAnimation.value.dispose();
    for (const material of this.materials) material.dispose();
    this.marker.geometry.dispose(); this.marker.material.dispose(); this.scene.clear();
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }

  private setZoom(value: number) {
    if (!Number.isFinite(value) || this.abort.signal.aborted) return;
    const offset = this.viewCamera.position.clone().sub(this.controls.target).setLength(160 / Math.max(1, Math.min(12, value)));
    this.viewCamera.position.copy(this.controls.target).add(offset);
    this.controls.update(); this.schedule();
  }

  private updateClipping() {
    this.materials[0].uniforms.uCut.value = this.sliceY === undefined ? 4096 : this.sliceY + 1.001;
  }

  private focus = () => this.canvas.focus({ preventScroll: true });
  private contextLost = (event: Event) => {
    event.preventDefault(); this.lost = true; cancelAnimationFrame(this.frame); this.frame = 0;
    clearTimeout(this.animationTimer);
    this.changed({ ...this.camera, loading: 0, warnings: 0, error: new Error("MC_MAP_WEBGL_UNAVAILABLE") });
  };
  private resize = () => {
    const bounds = this.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height || this.abort.signal.aborted) return;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setSize(bounds.width, bounds.height, false);
    this.viewCamera.aspect = bounds.width / bounds.height; this.viewCamera.updateProjectionMatrix(); this.schedule();
  };
  private schedule = () => {
    if (this.abort.signal.aborted || this.frame || this.lost) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
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
    const tile = this.cache.get(tileKey(tx, tz, this.sliceY)) ?? this.displayed.get(`${tx}:${tz}`);
    const value = tile?.heights[(Math.floor(z) - tz * SIZE) * SIZE + Math.floor(x) - tx * SIZE];
    return value === undefined || value === -32768 ? undefined : Math.min(value, this.sliceY ?? Infinity);
  }

  private draw() {
    clearTimeout(this.animationTimer);
    this.controls.update();
    const x = clamp(this.controls.target.x + this.origin.x), z = clamp(this.controls.target.z + this.origin.z);
    if (x !== this.controls.target.x + this.origin.x || z !== this.controls.target.z + this.origin.z) this.center(x, z);
    this.camera.x = x; this.camera.z = z; this.rebase();
    const tiles = visibleSceneTiles(this.camera);
    const anchor = `${Math.floor(x / SIZE)}:${Math.floor(z / SIZE)}:${tiles.length}`;
    if (this.anchor !== anchor) { this.anchor = anchor; this.skipped.clear(); this.failed.clear(); }
    this.visible = new Set(tiles.map(tile => tileKey(tile.x, tile.z, this.sliceY)));
    const positions = new Set(tiles.map(tile => tile.position));
    for (const [position, tile] of this.displayed) if (!positions.has(position)) { tile.group.visible = false; this.displayed.delete(position); }
    let warnings = 0, limited = !!this.skipped.size, count = 0, animated = false;
    for (const item of tiles) {
      const tile = this.cache.get(tileKey(item.x, item.z, this.sliceY)) ?? this.displayed.get(item.position);
      if (!tile) continue;
      const previous = this.displayed.get(item.position);
      if (previous && previous !== tile) previous.group.visible = false;
      tile.group.visible = true; this.displayed.set(item.position, tile);
      warnings += tile.warnings; limited ||= tile.limited; count += tile.count;
      animated ||= tile.animated;
    }
    const ground = this.elevation(x, z);
    let settling = false;
    if (ground !== undefined) {
      const remaining = ground + 2 - this.controls.target.y;
      const delta = this.reducedMotion || Math.abs(remaining) < 0.05 ? remaining : remaining * 0.25;
      this.controls.target.y += delta; this.viewCamera.position.y += delta;
      settling = Math.abs(remaining) >= 0.05 && !this.reducedMotion;
    }
    const spawn = this.elevation(this.world.spawn.x, this.world.spawn.z);
    this.marker.visible = spawn !== undefined;
    if (spawn !== undefined) this.marker.position.set(this.world.spawn.x - this.origin.x + 0.5, spawn + 3.5, this.world.spawn.z - this.origin.z + 0.5);
    this.materials[0].uniforms.uTime.value = performance.now() / 1000;
    this.renderer.render(this.scene, this.viewCamera);
    const needed = tiles.filter(tile => {
      const key = tileKey(tile.x, tile.z, this.sliceY);
      return !this.cache.has(key) && !this.pending.has(key) && !this.failed.has(key) && !this.skipped.has(key);
    });
    const loading = needed.length + this.pending.size;
    this.changed({ x: Math.round(x), z: Math.round(z), zoom: this.camera.zoom, loading, warnings, limited, empty: !loading && !count && !this.error, error: this.error });
    for (const item of needed.slice(0, Math.max(0, 2 - this.pending.size))) void this.fetch(item);
    if (settling) this.schedule();
    if (animated && !this.reducedMotion) this.animationTimer = setTimeout(this.schedule, 50);
  }

  private distance(tile: { x: number; z: number }) { return Math.hypot((tile.x + 0.5) * SIZE - this.camera.x, (tile.z + 0.5) * SIZE - this.camera.z); }

  private room(count: number, incoming: { x: number; z: number }) {
    while (this.cache.size >= 80 || this.faces + count > MAX_FACES) {
      const candidates = [...this.cache.values()].sort((a, b) => Number(this.visible.has(a.key)) - Number(this.visible.has(b.key)) || this.distance(b) - this.distance(a));
      const oldest = candidates[0];
      if (!oldest || this.visible.has(oldest.key) && this.distance(oldest) <= this.distance(incoming)) return false;
      if (this.visible.has(oldest.key)) this.skipped.add(oldest.key);
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
    const y = this.sliceY, key = tileKey(item.x, item.z, y), signal = this.abort.signal;
    this.pending.add(key);
    try {
      const result = await this.load(this.world.id, item.x, item.z, signal, y);
      if (signal.aborted || y !== this.sliceY || !this.visible.has(key)) return;
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
        geometry.setAttribute("color", new InstancedBufferAttribute(part.colors, 3, true));
        geometry.setAttribute("aTexture", new InstancedBufferAttribute(part.sprites, 1));
        geometry.setAttribute("aFlags", new InstancedBufferAttribute(part.flags, 1));
        geometry.setAttribute("aAO", new InstancedBufferAttribute(part.occlusion, 1));
        const halfHeight = (part.maxY - part.minY) / 2;
        geometry.boundingSphere = new Sphere(new Vector3(SIZE / 2, part.minY + halfHeight, SIZE / 2), Math.hypot(SIZE / Math.SQRT2, halfHeight));
        group.add(new Mesh(geometry, this.materials[part.kind]));
      }
      const tile = { ...item, key, group, heights: decoded.heights, count: decoded.count, warnings: decoded.warnings, limited: decoded.limited, animated: decoded.animated };
      this.cache.set(key, tile); this.scene.add(group); this.faces += tile.count;
    } catch (error) {
      if (!signal.aborted && y === this.sliceY) { this.failed.add(key); this.error = error; }
    } finally {
      this.pending.delete(key); this.schedule();
    }
  }
}
