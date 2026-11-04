import { MAP_LIMIT, MAP_TILE_SIZE, type MapTile, type MapWorld } from "../../../shared/map";

export interface Camera { x: number; z: number; zoom: number }
export interface MapViewState { x: number; z: number; zoom: number; loading: number; warnings: number; error?: unknown }
interface Tile { image: HTMLImageElement; warnings: number; appearedAt?: number }
interface ZoomAnimation { from: number; to: number; x: number; y: number; startedAt: number }

const TILE_FADE_DURATION = 240;
const ZOOM_DURATION = 200;
const easeOut = (progress: number) => 1 - Math.pow(1 - progress, 3);

export function worldPosition(camera: Camera, width: number, height: number, x: number, y: number) {
  return { x: camera.x + (x - width / 2) / camera.zoom, z: camera.z + (y - height / 2) / camera.zoom };
}

export function zoomCamera(camera: Camera, width: number, height: number, x: number, y: number, zoom: number) {
  const before = worldPosition(camera, width, height, x, y);
  camera.zoom = Math.max(1, Math.min(12, zoom));
  camera.x = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, before.x - (x - width / 2) / camera.zoom));
  camera.z = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, before.z - (y - height / 2) / camera.zoom));
}

export function visibleTiles(camera: Camera, width: number, height: number) {
  const start = worldPosition(camera, width, height, 0, 0);
  const end = worldPosition(camera, width, height, width, height);
  const limit = Math.ceil(MAP_LIMIT / MAP_TILE_SIZE);
  const result: { x: number; z: number; key: string }[] = [];
  for (let z = Math.max(-limit, Math.floor(start.z / MAP_TILE_SIZE)); z <= Math.min(limit, Math.floor(end.z / MAP_TILE_SIZE)); z++) {
    for (let x = Math.max(-limit, Math.floor(start.x / MAP_TILE_SIZE)); x <= Math.min(limit, Math.floor(end.x / MAP_TILE_SIZE)); x++) result.push({ x, z, key: `${x}:${z}` });
  }
  return result.sort((a, b) => Math.hypot(a.x * MAP_TILE_SIZE - camera.x, a.z * MAP_TILE_SIZE - camera.z) - Math.hypot(b.x * MAP_TILE_SIZE - camera.x, b.z * MAP_TILE_SIZE - camera.z));
}

export class MapViewport {
  readonly camera: Camera = { x: 0, z: 0, zoom: 2 };
  private readonly cache = new Map<string, Tile>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private visible = new Set<string>();
  private readonly abort = new AbortController();
  private readonly observer: ResizeObserver;
  private world: MapWorld;
  private width = 1;
  private height = 1;
  private frame = 0;
  private dragging?: { id: number; x: number; y: number };
  private active = 0;
  private error?: unknown;
  private zoomAnimation?: ZoomAnimation;
  private readonly reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    world: MapWorld,
    private readonly load: (world: string, x: number, z: number, signal: AbortSignal) => Promise<MapTile>,
    private readonly changed: (state: MapViewState) => void
  ) {
    this.world = world;
    this.camera.x = world.spawn.x;
    this.camera.z = world.spawn.z;
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointercancel", this.up);
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
  }

  center(x: number, z: number) {
    this.stopZoom();
    this.camera.x = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, x));
    this.camera.z = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, z));
    this.schedule();
  }

  zoom(factor: number) {
    this.animateZoom(factor, this.width / 2, this.height / 2);
  }

  dispose() {
    this.abort.abort();
    this.observer.disconnect();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.zoomAnimation = undefined;
    for (const [name, callback] of [["pointerdown", this.down], ["pointermove", this.move], ["pointerup", this.up], ["pointercancel", this.up], ["wheel", this.wheel]] as const) {
      this.canvas.removeEventListener(name, callback as EventListener);
    }
    this.cache.clear();
  }

  private resize() {
    const bounds = this.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    this.stopZoom();
    this.width = bounds.width;
    this.height = bounds.height;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.schedule();
  }

  private schedule() {
    if (this.abort.signal.aborted || this.frame) return;
    this.frame = requestAnimationFrame((time) => { this.frame = 0; this.draw(time); });
  }

  private animateZoom(factor: number, x: number, y: number) {
    if (this.abort.signal.aborted || !Number.isFinite(factor) || factor <= 0) return;
    const time = performance.now();
    this.advanceZoom(time);
    const to = Math.max(1, Math.min(12, (this.zoomAnimation?.to ?? this.camera.zoom) * factor));
    if (to === (this.zoomAnimation?.to ?? this.camera.zoom)) return;
    if (this.reducedMotion?.matches) {
      zoomCamera(this.camera, this.width, this.height, x, y, to);
      this.zoomAnimation = undefined;
    } else {
      this.zoomAnimation = { from: this.camera.zoom, to, x, y, startedAt: time };
    }
    this.schedule();
  }

  private advanceZoom(time: number) {
    const animation = this.zoomAnimation;
    if (!animation) return false;
    const progress = this.reducedMotion?.matches ? 1 : Math.max(0, Math.min(1, (time - animation.startedAt) / ZOOM_DURATION));
    const zoom = progress === 1 ? animation.to : animation.from * Math.pow(animation.to / animation.from, easeOut(progress));
    zoomCamera(this.camera, this.width, this.height, animation.x, animation.y, zoom);
    if (progress === 1) this.zoomAnimation = undefined;
    return progress < 1;
  }

  private stopZoom() {
    this.advanceZoom(performance.now());
    this.zoomAnimation = undefined;
  }

  private down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.stopZoom();
    this.schedule();
    this.canvas.setPointerCapture(event.pointerId);
    this.dragging = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.canvas.style.cursor = "grabbing";
  };

  private move = (event: PointerEvent) => {
    if (this.dragging?.id !== event.pointerId) return;
    this.center(this.camera.x - (event.clientX - this.dragging.x) / this.camera.zoom, this.camera.z - (event.clientY - this.dragging.y) / this.camera.zoom);
    this.dragging.x = event.clientX;
    this.dragging.y = event.clientY;
  };

  private up = (event: PointerEvent) => {
    if (this.dragging?.id !== event.pointerId) return;
    this.dragging = undefined;
    this.canvas.style.cursor = "grab";
  };

  private wheel = (event: WheelEvent) => {
    event.preventDefault();
    const bounds = this.canvas.getBoundingClientRect();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1);
    this.animateZoom(Math.exp(-Math.max(-1000, Math.min(1000, delta)) * 0.002), event.clientX - bounds.left, event.clientY - bounds.top);
  };

  private draw(time = performance.now()) {
    let animating = this.advanceZoom(time);
    const context = this.canvas.getContext("2d");
    if (!context) return;
    const ratio = this.canvas.width / this.width;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.globalAlpha = 1;
    context.imageSmoothingEnabled = false;
    context.fillStyle = "#19252a";
    context.fillRect(0, 0, this.width, this.height);
    context.fillStyle = "#213035";
    for (let z = 0; z < this.height; z += 32) for (let x = 0; x < this.width; x += 32) if ((x / 32 + z / 32) % 2) context.fillRect(x, z, 32, 32);
    const visible = visibleTiles(this.camera, this.width, this.height);
    this.visible = new Set(visible.map((item) => item.key));
    let warnings = 0;
    for (const item of visible) {
      const tile = this.cache.get(item.key);
      if (!tile) continue;
      warnings += tile.warnings;
      const x = (item.x * MAP_TILE_SIZE - this.camera.x) * this.camera.zoom + this.width / 2;
      const y = (item.z * MAP_TILE_SIZE - this.camera.z) * this.camera.zoom + this.height / 2;
      const size = MAP_TILE_SIZE * this.camera.zoom;
      tile.appearedAt ??= time;
      if (this.reducedMotion?.matches) tile.appearedAt = time - TILE_FADE_DURATION;
      const progress = Math.max(0, Math.min(1, (time - tile.appearedAt) / TILE_FADE_DURATION));
      context.globalAlpha = easeOut(progress);
      if (progress < 1) animating = true;
      context.drawImage(tile.image, Math.round(x), Math.round(y), Math.ceil(size), Math.ceil(size));
    }
    context.globalAlpha = 1;
    const spawnX = (this.world.spawn.x - this.camera.x) * this.camera.zoom + this.width / 2;
    const spawnZ = (this.world.spawn.z - this.camera.z) * this.camera.zoom + this.height / 2;
    context.fillStyle = "#ffd56a";
    context.strokeStyle = "#172020";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(spawnX, spawnZ, 6, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.strokeStyle = "#ffffffbb";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(this.width / 2 - 6, this.height / 2);
    context.lineTo(this.width / 2 + 6, this.height / 2);
    context.moveTo(this.width / 2, this.height / 2 - 6);
    context.lineTo(this.width / 2, this.height / 2 + 6);
    context.stroke();
    const needed = visible.filter((item) => !this.cache.has(item.key) && !this.pending.has(item.key) && !this.failed.has(item.key));
    this.changed({ x: Math.round(this.camera.x), z: Math.round(this.camera.z), zoom: this.camera.zoom, loading: needed.length + this.active, warnings, error: this.error });
    for (const item of needed.slice(0, Math.max(0, 3 - this.active))) this.fetchTile(item);
    if (animating) this.schedule();
  }

  private async fetchTile(item: { x: number; z: number; key: string }) {
    this.active++;
    this.pending.add(item.key);
    try {
      const result = await this.load(this.world.id, item.x, item.z, this.abort.signal);
      if (this.abort.signal.aborted) return;
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("MC_MAP_READ_FAILED")); });
      image.src = "data:image/png;base64," + result.image;
      await loaded;
      if (this.abort.signal.aborted) return;
      this.cache.set(item.key, { image, warnings: result.warnings });
      while (this.cache.size > 256) {
        const outside = [...this.cache.keys()].find((key) => !this.visible.has(key));
        if (!outside) break;
        this.cache.delete(outside);
      }
    } catch (error) {
      if (!this.abort.signal.aborted) { this.error = error; this.failed.add(item.key); }
    } finally {
      this.active--;
      this.pending.delete(item.key);
      this.schedule();
    }
  }
}
