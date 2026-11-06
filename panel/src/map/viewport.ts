import { MAP_LIMIT, MAP_TILE_SIZE, type MapTile, type MapWorld, type MapSceneTile } from "../../../shared/map";
import { loadSceneViewport } from "./scene-loader";
import { KeyboardNavigation } from "./navigation";
import { normalizeBearing, rotatedSize, screenToWorld, tileInView, worldToScreen } from "./bearing";

export interface Camera { x: number; z: number; zoom: number }
export interface MapViewState { x: number; z: number; zoom: number; bearing?: number; loading: number; warnings: number; error?: unknown; limited?: boolean; empty?: boolean }
export interface MapRenderer {
  readonly camera: Camera;
  center(x: number, z: number): void;
  zoom(factor: number): void;
  dispose(): void;
}
export const MAP_DETAIL_ZOOM = 4;
interface Tile { image: HTMLImageElement; warnings: number; appearedAt?: number }
interface DisplayTile { tile: Tile; startedAt: number; duration: number }
interface ZoomAnimation { from: number; to: number; x: number; y: number; startedAt: number }

const TILE_FADE_DURATION = 240;
const DETAIL_FADE_DURATION = 240;
const ZOOM_DURATION = 200;
const easeOut = (progress: number) => 1 - Math.pow(1 - progress, 3);
const tileKey = (position: string) => `surface:${position}`;

export function worldPosition(camera: Camera, width: number, height: number, x: number, y: number, bearing = 0) {
  const offset = screenToWorld((x - width / 2) / camera.zoom, (y - height / 2) / camera.zoom, bearing);
  return { x: camera.x + offset.x, z: camera.z + offset.z };
}

export function zoomCamera(camera: Camera, width: number, height: number, x: number, y: number, zoom: number, bearing = 0) {
  const before = worldPosition(camera, width, height, x, y, bearing);
  camera.zoom = Math.max(1, Math.min(12, zoom));
  const offset = screenToWorld((x - width / 2) / camera.zoom, (y - height / 2) / camera.zoom, bearing);
  camera.x = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, before.x - offset.x));
  camera.z = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, before.z - offset.z));
}

export function visibleTiles(camera: Camera, width: number, height: number, bearing = 0) {
  const size = rotatedSize(width, height, bearing);
  const start = worldPosition(camera, size.width, size.height, 0, 0);
  const end = worldPosition(camera, size.width, size.height, size.width, size.height);
  const limit = Math.ceil(MAP_LIMIT / MAP_TILE_SIZE);
  const result: { x: number; z: number; key: string }[] = [];
  for (let z = Math.max(-limit, Math.floor(start.z / MAP_TILE_SIZE)); z <= Math.min(limit, Math.floor(end.z / MAP_TILE_SIZE)); z++) {
    for (let x = Math.max(-limit, Math.floor(start.x / MAP_TILE_SIZE)); x <= Math.min(limit, Math.floor(end.x / MAP_TILE_SIZE)); x++) {
      if (tileInView(x * MAP_TILE_SIZE, z * MAP_TILE_SIZE, MAP_TILE_SIZE, camera, width / camera.zoom / 2, height / camera.zoom / 2, bearing)) result.push({ x, z, key: `${x}:${z}` });
    }
  }
  return result.sort((a, b) => Math.hypot(a.x * MAP_TILE_SIZE - camera.x, a.z * MAP_TILE_SIZE - camera.z) - Math.hypot(b.x * MAP_TILE_SIZE - camera.x, b.z * MAP_TILE_SIZE - camera.z));
}

/** Adjacent tiles share the exact same physical pixel edge, including at fractional zoom/DPR. */
export function tileBounds(camera: Camera, width: number, height: number, x: number, z: number, ratio: number, ratioY = ratio) {
  const edgeX = (tile: number) => Math.round(((tile * MAP_TILE_SIZE - camera.x) * camera.zoom + width / 2) * ratio) / ratio;
  const edgeZ = (tile: number) => Math.round(((tile * MAP_TILE_SIZE - camera.z) * camera.zoom + height / 2) * ratioY) / ratioY;
  const left = edgeX(x), top = edgeZ(z);
  return { x: left, y: top, width: edgeX(x + 1) - left, height: edgeZ(z + 1) - top };
}

export class MapViewport {
  readonly camera: Camera = { x: 0, z: 0, zoom: 2 };
  private readonly cache = new Map<string, Tile>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly displayed = new Map<string, DisplayTile>();
  private visible = new Set<string>();
  private readonly abort = new AbortController();
  private terrainCanvas?: HTMLCanvasElement | OffscreenCanvas;
  private detail?: import("./scene-viewport").SceneViewport;
  private detailCanvas?: HTMLCanvasElement;
  private backdropCanvas?: HTMLCanvasElement;
  private detailFrame?: { camera: Camera; width: number; height: number; bearing?: number; orthographic: boolean };
  private detailOpacity = 0;
  private detailFade?: { from: number; to: number; startedAt: number };
  private mode: "2d" | "3d" = "2d";
  private detailState?: MapViewState;
  private detailGeneration = 0;
  private detailLoading = false;
  private detailUnavailable = false;
  private detailError?: unknown;
  private readonly observer: ResizeObserver;
  private readonly navigation: KeyboardNavigation;
  private world: MapWorld;
  private width = 1;
  private height = 1;
  private frame = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private rotating?: number;
  private bearing = 0;
  private active = 0;
  private background = 0;
  private error?: unknown;
  private zoomAnimation?: ZoomAnimation;
  private readonly reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;

  project(position: { x: number; y: number; z: number }) {
    const offset = worldToScreen((position.x - this.camera.x) * this.camera.zoom, (position.z - this.camera.z) * this.camera.zoom, this.bearing);
    const point = this.detailFrame && !this.detailFrame.orthographic && this.sceneVisible ? this.detail?.project(position)
      : { x: offset.x + this.width / 2, y: offset.y + this.height / 2 };
    return point && point.x >= -32 && point.y >= -32 && point.x <= this.width + 32 && point.y <= this.height + 32 ? point : undefined;
  }

  projectSpawn() {
    if (this.detailFrame && !this.detailFrame.orthographic && this.sceneVisible) return this.detail?.projectSpawn();
    return this.project({ ...this.world.spawn, y: 0 });
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    world: MapWorld,
    private readonly load: (world: string, x: number, z: number, signal: AbortSignal) => Promise<MapTile>,
    private readonly changed: (state: MapViewState) => void,
    private readonly loadScene?: (world: string, x: number, z: number, signal: AbortSignal) => Promise<MapSceneTile>
  ) {
    this.world = world;
    this.camera.x = world.spawn.x;
    this.camera.z = world.spawn.z;
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointercancel", this.up);
    canvas.addEventListener("lostpointercapture", this.up);
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    this.navigation = new KeyboardNavigation(canvas, () => this.mode === "2d" && !this.detail?.isTransitioning && !this.abort.signal.aborted, () => this.schedule());
    canvas.addEventListener("contextmenu", this.contextMenu);
    this.observer = new ResizeObserver(entries => this.resize(entries.find(entry => entry.target === canvas)?.contentRect));
    this.observer.observe(canvas);
    this.resize();
  }

  center(x: number, z: number) {
    this.stopZoom();
    this.camera.x = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, x));
    this.camera.z = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, z));
    if (this.mode === "3d") this.detail?.center(this.camera.x, this.camera.z);
    this.schedule();
  }

  zoom(factor: number) {
    if (this.mode === "3d" && this.detail) { this.detail.zoom(factor); return; }
    this.animateZoom(factor, this.width / 2, this.height / 2);
  }

  setBearing(value: number) {
    if (!Number.isFinite(value) || this.abort.signal.aborted) return;
    this.stopZoom();
    this.bearing = normalizeBearing(value);
    if (this.mode === "3d" || this.detail?.isTransitioning) this.detail?.setBearing(this.bearing);
    this.schedule();
  }

  resetBearing() { this.clearPointers(); this.setBearing(0); }

  setMode(mode: "2d" | "3d") {
    if (this.mode === mode || this.abort.signal.aborted) return;
    this.navigation.clear();
    this.stopZoom();
    const previous = this.mode;
    this.clearPointers();
    this.mode = mode;
    if (this.detail) {
      if (mode === "3d") this.detail.setTopDownView(this.camera, this.width, this.height, this.bearing);
      this.detail.setProjection(mode === "3d" ? "perspective" : "orthographic");
      if (previous === "3d") { Object.assign(this.camera, this.detail.camera); this.bearing = this.detail.bearing ?? this.bearing; }
    }
    this.schedule();
  }

  dispose() {
    this.abort.abort();
    this.navigation.dispose();
    this.observer.disconnect();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.zoomAnimation = undefined;
    this.clearPointers();
    for (const [name, callback] of [["pointerdown", this.down], ["pointermove", this.move], ["pointerup", this.up], ["pointercancel", this.up], ["lostpointercapture", this.up], ["wheel", this.wheel], ["contextmenu", this.contextMenu]] as const) {
      this.canvas.removeEventListener(name, callback as EventListener);
    }
    this.cache.clear();
    this.displayed.clear();
    if (this.terrainCanvas) this.terrainCanvas.width = this.terrainCanvas.height = 0;
    this.terrainCanvas = undefined;
    this.stopDetail();
  }

  private resize(size?: Pick<DOMRectReadOnly, "width" | "height">) {
    // Dialog/window scale animations change client rects without a layout resize.
    // All layers must use the untransformed content box, including fractional sizes.
    const width = size?.width ?? this.canvas.clientWidth, height = size?.height ?? this.canvas.clientHeight;
    if (!width || !height) return;
    this.stopZoom();
    this.width = width;
    this.height = height;
    if (this.terrainCanvas) this.terrainCanvas.width = this.terrainCanvas.height = 0;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    if (this.backdropCanvas) {
      this.backdropCanvas.width = this.canvas.width;
      this.backdropCanvas.height = this.canvas.height;
    }
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
      zoomCamera(this.camera, this.width, this.height, x, y, to, this.bearing);
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
    zoomCamera(this.camera, this.width, this.height, animation.x, animation.y, zoom, this.bearing);
    if (progress === 1) this.zoomAnimation = undefined;
    return progress < 1;
  }

  private stopZoom() {
    this.advanceZoom(performance.now());
    this.zoomAnimation = undefined;
  }

  private down = (event: PointerEvent) => {
    if (![0, 2].includes(event.button) || this.mode === "3d" || this.detail?.isTransitioning || this.pointers.size >= 2) return;
    if (this.rotating !== undefined || event.button === 2 && this.pointers.size) return;
    this.canvas.focus?.({ preventScroll: true });
    this.stopZoom();
    this.schedule();
    this.canvas.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, this.pointerPosition(event));
    if (event.button === 2) this.rotating = event.pointerId;
    this.canvas.style.cursor = "grabbing";
  };

  private contextMenu = (event: Event) => event.preventDefault();

  private move = (event: PointerEvent) => {
    if (!this.pointers.has(event.pointerId)) return;
    this.stopZoom();
    if (this.rotating === event.pointerId) {
      const previous = this.pointers.get(event.pointerId)!, next = this.pointerPosition(event);
      this.pointers.set(event.pointerId, next);
      this.setBearing(this.bearing + (next.x - previous.x) * Math.PI * 2 / this.height * 0.65);
      return;
    }
    const before = this.gesture();
    this.pointers.set(event.pointerId, this.pointerPosition(event));
    const after = this.gesture();
    // Apply distance and midpoint changes together, so the world point under
    // the fingers follows their midpoint even while pinching and panning.
    if (before.distance > 0 && after.distance > 0) {
      zoomCamera(this.camera, this.width, this.height, before.x, before.y, this.camera.zoom * after.distance / before.distance, this.bearing);
    }
    const offset = screenToWorld((after.x - before.x) / this.camera.zoom, (after.y - before.y) / this.camera.zoom, this.bearing);
    this.center(this.camera.x - offset.x, this.camera.z - offset.z);
  };

  private up = (event: PointerEvent) => {
    if (!this.pointers.delete(event.pointerId)) return;
    if (this.rotating === event.pointerId) this.rotating = undefined;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.canvas.style.cursor = this.pointers.size ? "grabbing" : "grab";
  };

  private gesture() {
    const [a, b = a] = this.pointers.values();
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  private clearPointers() {
    const ids = [...this.pointers.keys()];
    this.pointers.clear();
    this.rotating = undefined;
    for (const id of ids) if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    this.canvas.style.cursor = "grab";
  }

  private wheel = (event: WheelEvent) => {
    if (this.mode === "3d" || this.detail?.isTransitioning) return;
    event.preventDefault();
    const { x, y } = this.pointerPosition(event);
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1);
    this.animateZoom(Math.exp(-Math.max(-1000, Math.min(1000, delta)) * 0.002), x, y);
  };

  private pointerPosition(event: PointerEvent | WheelEvent) {
    const bounds = this.canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * this.width / bounds.width, y: (event.clientY - bounds.top) * this.height / bounds.height };
  }

  private draw(time = performance.now()) {
    let animating = this.advanceZoom(time);
    const movement = this.navigation.advance(time);
    if (movement) {
      const offset = screenToWorld(movement.x / this.camera.zoom, movement.y / this.camera.zoom, this.bearing);
      this.camera.x = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, this.camera.x + offset.x));
      this.camera.z = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, this.camera.z + offset.z));
      animating = true;
    }
    const foreground = this.canvas.getContext("2d");
    if (!foreground) return;
    this.updateDetail();
    this.presentScene(time);
    const context = this.backdropCanvas?.getContext("2d") ?? foreground;
    const ratio = this.canvas.width / this.width, ratioY = this.canvas.height / this.height;
    for (const layer of new Set([foreground, context])) {
      layer.setTransform(ratio, 0, 0, ratioY, 0, 0);
      layer.globalAlpha = 1;
      layer.imageSmoothingEnabled = false;
    }
    if (context !== foreground) foreground.clearRect(0, 0, this.width, this.height);
    if (this.detailFrame && !this.detailFrame.orthographic && this.sceneVisible) {
      this.changed({ ...this.detailState!, x: Math.round(this.camera.x), z: Math.round(this.camera.z), zoom: this.camera.zoom, bearing: this.bearing });
      if (animating) this.schedule();
      return;
    }
    context.fillStyle = "#19252a";
    context.fillRect(0, 0, this.width, this.height);
    context.fillStyle = "#213035";
    for (let z = 0; z < this.height; z += 32) for (let x = 0; x < this.width; x += 32) if ((x / 32 + z / 32) % 2) context.fillRect(x, z, 32, 32);
    const visible = visibleTiles(this.camera, this.width, this.height, this.bearing);
    this.visible = new Set(visible.map((item) => tileKey(item.key)));
    const positions = new Set(visible.map((item) => item.key));
    for (const key of this.displayed.keys()) if (!positions.has(key)) this.displayed.delete(key);
    let warnings = 0;
    let terrain: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D = context;
    let paintWidth = this.width, paintHeight = this.height;
    if (this.bearing) {
      const size = rotatedSize(this.width, this.height, this.bearing);
      this.terrainCanvas ??= typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1) : this.canvas.ownerDocument.createElement("canvas");
      const width = Math.ceil((size.width + 4) * ratio / 128) * 128, height = Math.ceil((size.height + 4) * ratioY / 128) * 128;
      // Grow in buckets while rotating, and keep the buffer until a layout resize.
      if (this.terrainCanvas.width < width) this.terrainCanvas.width = width;
      if (this.terrainCanvas.height < height) this.terrainCanvas.height = height;
      const raster = this.terrainCanvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (!raster) return;
      terrain = raster;
      terrain.setTransform(1, 0, 0, 1, 0, 0);
      terrain.clearRect(0, 0, this.terrainCanvas.width, this.terrainCanvas.height);
      terrain.setTransform(ratio, 0, 0, ratioY, 0, 0);
      terrain.imageSmoothingEnabled = false;
      paintWidth = this.terrainCanvas.width / ratio; paintHeight = this.terrainCanvas.height / ratioY;
    }
    for (const item of visible) {
      let display = this.displayed.get(item.key);
      const tile = this.cache.get(tileKey(item.key));
      if (tile && tile !== display?.tile) {
        tile.appearedAt ??= time;
        display = { tile, startedAt: tile.appearedAt, duration: TILE_FADE_DURATION };
        this.displayed.set(item.key, display);
      }
      if (!display) continue;
      warnings += this.cache.get(tileKey(item.key))?.warnings || 0;
      const bounds = tileBounds(this.camera, paintWidth, paintHeight, item.x, item.z, ratio, ratioY);
      if (this.reducedMotion?.matches) {
        display.startedAt = time - display.duration;
        display.tile.appearedAt = time - TILE_FADE_DURATION;
      }
      const progress = Math.max(0, Math.min(1, (time - display.startedAt) / display.duration));
      if (progress < 1) animating = true;
      terrain.globalAlpha = easeOut(progress);
      terrain.drawImage(display.tile.image, bounds.x, bounds.y, bounds.width, bounds.height);
    }
    context.globalAlpha = 1;
    if (terrain !== context) {
      // Rasterize shared tile edges on the pixel grid before rotating the whole
      // layer; rotating individual drawImage calls leaves antialiased seams.
      const c = Math.cos(this.bearing), s = Math.sin(this.bearing), cx = this.width / 2, cy = this.height / 2;
      context.setTransform(ratio * c, -ratioY * s, ratio * s, ratioY * c, ratio * (cx - c * cx - s * cy), ratioY * (cy + s * cx - c * cy));
      context.drawImage(this.terrainCanvas!, (this.width - paintWidth) / 2, (this.height - paintHeight) / 2, paintWidth, paintHeight);
    }
    context.setTransform(ratio, 0, 0, ratioY, 0, 0);
    this.drawMarkers(foreground);
    const needed = visible.filter((item) => {
      const key = tileKey(item.key);
      return !this.cache.has(key) && !this.pending.has(key) && !this.failed.has(key);
    });
    this.changed({ x: Math.round(this.camera.x), z: Math.round(this.camera.z), zoom: this.camera.zoom, bearing: this.bearing,
      loading: needed.length + this.active - this.background + (this.wantsScene ? this.detailState?.loading || 0 : 0) + Number(this.detailLoading),
      warnings: Math.max(warnings, this.wantsScene ? this.detailState?.warnings || 0 : 0), limited: this.wantsScene && this.detailState?.limited,
      error: this.error ?? (this.wantsScene ? this.detailError ?? this.detailState?.error : undefined) });
    // The daemon renders a few tiles in parallel; keeping the queue deeper hides the
    // per-tile latency instead of waiting for one image before starting the next.
    for (const item of needed.slice(0, Math.max(0, 6 - this.active))) this.fetchTile(item);
    if (!needed.length && this.active === this.background) this.prefetch(visible);
    if (animating) this.schedule();
  }

  /** Warm the ring around the viewport once it settled, so panning shows terrain at once. */
  private prefetch(visible: { x: number; z: number; key: string }[]) {
    const limit = Math.ceil(MAP_LIMIT / MAP_TILE_SIZE);
    const seen = new Set(visible.map((item) => item.key));
    const ring: { x: number; z: number; key: string }[] = [];
    for (const item of visible) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = item.x + dx, z = item.z + dz, key = `${x}:${z}`;
      if (seen.has(key) || Math.abs(x) > limit || Math.abs(z) > limit) continue;
      seen.add(key);
      const cacheKey = tileKey(key);
      if (this.cache.has(cacheKey) || this.pending.has(cacheKey) || this.failed.has(cacheKey)) continue;
      ring.push({ x, z, key });
    }
    ring.sort((a, b) => Math.hypot(a.x * MAP_TILE_SIZE - this.camera.x, a.z * MAP_TILE_SIZE - this.camera.z)
      - Math.hypot(b.x * MAP_TILE_SIZE - this.camera.x, b.z * MAP_TILE_SIZE - this.camera.z));
    for (const item of ring.slice(0, 2)) void this.fetchTile(item, true);
  }

  private drawMarkers(context: CanvasRenderingContext2D) {
    context.strokeStyle = "#ffffffbb";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(this.width / 2 - 6, this.height / 2);
    context.lineTo(this.width / 2 + 6, this.height / 2);
    context.moveTo(this.width / 2, this.height / 2 - 6);
    context.lineTo(this.width / 2, this.height / 2 + 6);
    context.stroke();
  }

  private get wantsScene() { return this.mode === "3d" || this.camera.zoom >= MAP_DETAIL_ZOOM || !!this.detail?.isTransitioning; }
  private get sceneReady() {
    return this.detail?.ready && !!this.detailCanvas?.width;
  }
  private get sceneVisible() { return this.sceneReady && this.detailOpacity > 0; }

  private advanceDetailFade(time: number) {
    const fade = this.detailFade;
    if (!fade) return;
    const duration = Math.max(1, DETAIL_FADE_DURATION * Math.abs(fade.to - fade.from));
    const progress = Math.max(0, Math.min(1, (time - fade.startedAt) / duration));
    this.detailOpacity = fade.from + (fade.to - fade.from) * easeOut(progress);
    if (progress === 1) this.detailFade = undefined;
  }

  private presentScene(time = performance.now()) {
    const canvas = this.detailCanvas, frame = this.detailFrame;
    if (!canvas) return;
    if (!this.sceneReady || !frame) {
      canvas.style.visibility = "hidden";
      canvas.style.opacity = "0";
      this.detailOpacity = 0;
      this.detailFade = undefined;
      if (!this.wantsScene) this.detail?.setActive(false);
      return;
    }
    this.advanceDetailFade(time);
    // Wait for the initial footprint, then keep loaded terrain visible through
    // pans and reverse either fade from its current opacity on rapid zooms.
    const target = this.wantsScene && (this.mode === "3d" || !frame.orthographic || this.detailOpacity > 0
      || this.detailFade?.to === 1 || this.detailState?.loading === 0) ? 1 : 0;
    if (this.reducedMotion?.matches || !frame.orthographic || this.mode === "3d") {
      this.detailOpacity = target;
      this.detailFade = undefined;
    } else if (target !== (this.detailFade?.to ?? this.detailOpacity)) {
      this.detailFade = { from: this.detailOpacity, to: target, startedAt: time };
    }
    canvas.style.visibility = this.detailOpacity > 0 || this.detailFade ? "visible" : "hidden";
    canvas.style.opacity = String(this.detailOpacity);
    if (this.detailFade) this.schedule();
    else if (!this.wantsScene) this.detail?.setActive(false);
    // Composite WebGL directly. Copying it with 2D drawImage can swap R/B channels
    // on accelerated browser backends, including for textures without biome tint.
    const scale = frame.orthographic ? this.camera.zoom / frame.camera.zoom : 1;
    const angle = frame.orthographic ? (frame.bearing ?? 0) - this.bearing : 0;
    const offset = worldToScreen((frame.camera.x - this.camera.x) * this.camera.zoom, (frame.camera.z - this.camera.z) * this.camera.zoom, this.bearing);
    const x = frame.orthographic ? offset.x + this.width / 2 - (Math.cos(angle) * frame.width - Math.sin(angle) * frame.height) * scale / 2 : 0;
    const y = frame.orthographic ? offset.y + this.height / 2 - (Math.sin(angle) * frame.width + Math.cos(angle) * frame.height) * scale / 2 : 0;
    canvas.style.width = `${frame.orthographic ? frame.width : this.width}px`;
    canvas.style.height = `${frame.orthographic ? frame.height : this.height}px`;
    canvas.style.transform = `translate(${x}px, ${y}px) ${angle ? `rotate(${angle}rad) ` : ""}scale(${scale})`;
  }

  private updateDetail() {
    if (!this.loadScene || !this.wantsScene && this.detailOpacity === 0 && !this.detailFade) {
      // A far overview pauses the shared scene; its bounded cache is reused on return.
      this.detail?.setActive(false);
      if (this.detailLoading) { this.detailGeneration++; this.detailLoading = false; }
      return;
    }
    if (this.detailUnavailable) return;
    if (this.detail) {
      this.detail.setActive(true);
      if (this.mode === "2d") {
        this.detail.setTopDownView(this.camera, this.width, this.height, this.bearing);
        this.detail.renderTopDown();
      }
      else this.detail.setSize(this.width, this.height);
      return;
    }
    if (this.detailLoading || !this.wantsScene) return;
    const generation = ++this.detailGeneration;
    this.detailLoading = true;
    void loadSceneViewport().then(({ SceneViewport }) => {
      if (this.abort.signal.aborted || generation !== this.detailGeneration || !this.wantsScene) return;
      const canvas = this.canvas.ownerDocument.createElement("canvas");
      this.detailCanvas = canvas;
      const backdrop = this.canvas.ownerDocument.createElement("canvas");
      this.backdropCanvas = backdrop;
      backdrop.width = this.canvas.width; backdrop.height = this.canvas.height;
      for (const layer of [backdrop, canvas]) {
        layer.setAttribute("aria-hidden", "true");
        Object.assign(layer.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", transformOrigin: "0 0" });
      }
      canvas.style.visibility = "hidden";
      // Tiles stay below WebGL; the original canvas keeps markers and all input.
      this.canvas.before(backdrop, canvas);
      this.detail = new SceneViewport(canvas, this.world, this.loadScene!, state => {
        if (this.abort.signal.aborted || generation !== this.detailGeneration) return;
        if (state.error instanceof Error && state.error.message === "MC_MAP_WEBGL_UNAVAILABLE") {
          this.detailUnavailable = true; this.detailError = state.error; this.stopDetail();
        } else {
          this.detailState = state;
          if (this.mode === "3d" && this.detail) Object.assign(this.camera, this.detail.camera);
          if (this.mode === "3d" || this.detail?.isTransitioning) this.bearing = state.bearing ?? this.bearing;
          if (this.detail?.ready) this.detailFrame = this.detail.frameView;
          this.presentScene();
        }
        this.schedule();
      }, this.mode === "3d" ? "perspective" : "orthographic", this.canvas);
      this.detail.setSize(this.width, this.height);
      this.detail.camera.zoom = this.camera.zoom;
      this.detail.center(this.camera.x, this.camera.z);
      this.detail.setBearing(this.bearing);
    }).catch(error => {
      if (this.abort.signal.aborted || generation !== this.detailGeneration) return;
      this.detailUnavailable = true; this.detailError = error; this.stopDetail(); this.schedule();
    }).finally(() => {
      if (generation === this.detailGeneration) { this.detailLoading = false; this.schedule(); }
    });
  }

  private stopDetail() {
    if (!this.detailLoading && !this.detail && !this.detailCanvas) return;
    this.detailGeneration++; this.detailLoading = false;
    this.detail?.dispose(); this.detail = undefined;
    for (const canvas of [this.detailCanvas, this.backdropCanvas]) if (canvas) {
      canvas.remove(); canvas.width = canvas.height = 0;
    }
    this.backdropCanvas = undefined;
    this.detailCanvas = undefined; this.detailFrame = undefined; this.detailState = undefined;
    this.detailOpacity = 0; this.detailFade = undefined;
  }

  private async fetchTile(item: { x: number; z: number; key: string }, background = false) {
    const signal = this.abort.signal;
    const key = tileKey(item.key);
    this.active++;
    if (background) this.background++;
    this.pending.add(key);
    try {
      const result = await this.load(this.world.id, item.x, item.z, signal);
      if (signal.aborted) return;
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("MC_MAP_READ_FAILED")); });
      image.src = "data:image/png;base64," + result.image;
      await loaded;
      if (signal.aborted) return;
      this.cache.set(key, { image, warnings: result.warnings });
      while (this.cache.size > 256) {
        const outside = [...this.cache.keys()].find((key) => !this.visible.has(key));
        if (!outside) break;
        this.cache.delete(outside);
      }
    } catch (error) {
      if (!signal.aborted) {
        // A background ring tile must not raise the visible map's error banner.
        if (!background) this.error = error;
        this.failed.add(key);
      }
    } finally {
      if (!signal.aborted) {
        this.active--;
        if (background) this.background--;
        this.pending.delete(key);
        this.schedule();
      }
    }
  }
}
