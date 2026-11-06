import { MAP_LIMIT, MAP_TILE_SIZE, mapHeight, type MapTile, type MapWorld, type MapSceneTile } from "../../../shared/map";
import { loadSceneViewport } from "./scene-loader";
import { keyboardPan } from "./navigation";

export interface Camera { x: number; z: number; zoom: number }
export interface MapViewState { x: number; z: number; zoom: number; loading: number; warnings: number; error?: unknown; limited?: boolean; empty?: boolean }
export interface MapRenderer {
  readonly camera: Camera;
  center(x: number, z: number): void;
  zoom(factor: number): void;
  setLayer(y?: number): void;
  dispose(): void;
}
export const MAP_DETAIL_ZOOM = 4;
interface Tile { image: HTMLImageElement; warnings: number; position: string; y?: number; appearedAt?: number }
interface DisplayTile { tile: Tile; previous?: Tile; startedAt: number; duration: number }
interface ZoomAnimation { from: number; to: number; x: number; y: number; startedAt: number }

const TILE_FADE_DURATION = 240;
const DETAIL_FADE_DURATION = 240;
const LAYER_FADE_DURATION = 100;
const ZOOM_DURATION = 200;
const easeOut = (progress: number) => 1 - Math.pow(1 - progress, 3);
const tileKey = (position: string, y?: number) => `${y ?? "surface"}:${position}`;

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
  private blendCanvas?: HTMLCanvasElement | OffscreenCanvas;
  private detail?: import("./scene-viewport").SceneViewport;
  private detailCanvas?: HTMLCanvasElement;
  private backdropCanvas?: HTMLCanvasElement;
  private detailFrame?: { camera: Camera; width: number; height: number; orthographic: boolean; y?: number };
  private detailOpacity = 0;
  private detailFade?: { from: number; to: number; startedAt: number };
  private mode: "2d" | "3d" = "2d";
  private detailState?: MapViewState;
  private detailGeneration = 0;
  private detailLoading = false;
  private detailUnavailable = false;
  private detailError?: unknown;
  private readonly observer: ResizeObserver;
  private world: MapWorld;
  private width = 1;
  private height = 1;
  private frame = 0;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private active = 0;
  private error?: unknown;
  private zoomAnimation?: ZoomAnimation;
  private readonly reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;

  project(position: { x: number; y: number; z: number }) {
    const point = this.detailFrame && !this.detailFrame.orthographic && this.sceneVisible ? this.detail?.project(position)
      : { x: (position.x - this.camera.x) * this.camera.zoom + this.width / 2, y: (position.z - this.camera.z) * this.camera.zoom + this.height / 2 };
    return point && point.x >= -32 && point.y >= -32 && point.x <= this.width + 32 && point.y <= this.height + 32 ? point : undefined;
  }

  projectSpawn() {
    if (this.detailFrame && !this.detailFrame.orthographic && this.sceneVisible) return this.detail?.projectSpawn();
    return this.project({ ...this.world.spawn, y: 0 });
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    world: MapWorld,
    private readonly load: (world: string, x: number, z: number, signal: AbortSignal, y?: number) => Promise<MapTile>,
    private readonly changed: (state: MapViewState) => void,
    private sliceY?: number,
    private readonly loadScene?: (world: string, x: number, z: number, signal: AbortSignal, y?: number) => Promise<MapSceneTile>
  ) {
    mapHeight(sliceY);
    this.world = world;
    this.camera.x = world.spawn.x;
    this.camera.z = world.spawn.z;
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointercancel", this.up);
    canvas.addEventListener("lostpointercapture", this.up);
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    canvas.addEventListener("keydown", this.keydown);
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

  setMode(mode: "2d" | "3d") {
    if (this.mode === mode || this.abort.signal.aborted) return;
    this.stopZoom();
    const previous = this.mode;
    this.clearPointers();
    this.mode = mode;
    if (this.detail) {
      if (mode === "3d") this.detail.setTopDownView(this.camera, this.width, this.height);
      this.detail.setProjection(mode === "3d" ? "perspective" : "orthographic");
      if (previous === "3d") Object.assign(this.camera, this.detail.camera);
    }
    this.schedule();
  }

  setLayer(y?: number) {
    mapHeight(y);
    if (this.abort.signal.aborted || this.sliceY === y) return;
    this.sliceY = y;
    this.detail?.setLayer(y);
    this.failed.clear();
    this.error = undefined;
    this.schedule();
  }

  dispose() {
    this.abort.abort();
    this.observer.disconnect();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.zoomAnimation = undefined;
    this.clearPointers();
    for (const [name, callback] of [["pointerdown", this.down], ["pointermove", this.move], ["pointerup", this.up], ["pointercancel", this.up], ["lostpointercapture", this.up], ["wheel", this.wheel], ["keydown", this.keydown], ["contextmenu", this.contextMenu]] as const) {
      this.canvas.removeEventListener(name, callback as EventListener);
    }
    this.cache.clear();
    this.displayed.clear();
    this.blendCanvas = undefined;
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
    if (![0, 2].includes(event.button) || this.mode === "3d" || this.detail?.isTransitioning || this.pointers.size >= 2) return;
    this.canvas.focus?.({ preventScroll: true });
    this.stopZoom();
    this.schedule();
    this.canvas.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, this.pointerPosition(event));
    this.canvas.style.cursor = "grabbing";
  };

  private contextMenu = (event: Event) => event.preventDefault();
  private keydown = (event: KeyboardEvent) => {
    if (this.mode === "3d" || this.detail?.isTransitioning || this.abort.signal.aborted) return;
    const direction = keyboardPan(event);
    if (!direction) return;
    event.preventDefault();
    this.center(this.camera.x + direction[0] * 16 / this.camera.zoom, this.camera.z + direction[1] * 16 / this.camera.zoom);
  };

  private move = (event: PointerEvent) => {
    if (!this.pointers.has(event.pointerId)) return;
    this.stopZoom();
    const before = this.gesture();
    this.pointers.set(event.pointerId, this.pointerPosition(event));
    const after = this.gesture();
    // Apply distance and midpoint changes together, so the world point under
    // the fingers follows their midpoint even while pinching and panning.
    if (before.distance > 0 && after.distance > 0) {
      zoomCamera(this.camera, this.width, this.height, before.x, before.y, this.camera.zoom * after.distance / before.distance);
    }
    this.center(this.camera.x - (after.x - before.x) / this.camera.zoom, this.camera.z - (after.y - before.y) / this.camera.zoom);
  };

  private up = (event: PointerEvent) => {
    if (!this.pointers.delete(event.pointerId)) return;
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

  private nearestTile(position: string, previous?: Tile) {
    const exact = this.cache.get(tileKey(position, this.sliceY));
    if (exact || this.sliceY === undefined) return exact;
    let closest = previous?.y === undefined ? undefined : previous;
    let distance = closest ? Math.abs(closest.y! - this.sliceY) : Infinity;
    for (const tile of this.cache.values()) {
      if (tile.position !== position || tile.y === undefined) continue;
      const delta = Math.abs(tile.y - this.sliceY);
      if (delta < distance) { closest = tile; distance = delta; }
    }
    return closest;
  }

  private blend(previous: Tile, tile: Tile, progress: number): CanvasImageSource {
    const before = previous.image, current = tile.image, size = MAP_TILE_SIZE;
    if (!this.blendCanvas) {
      this.blendCanvas = typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(MAP_TILE_SIZE, MAP_TILE_SIZE) : this.canvas.ownerDocument.createElement("canvas");
    }
    if (this.blendCanvas.width !== size) this.blendCanvas.width = this.blendCanvas.height = size;
    const context = this.blendCanvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) return tile.image;
    context.clearRect(0, 0, size, size);
    context.imageSmoothingEnabled = false;
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1 - progress;
    context.drawImage(before, 0, 0, size, size);
    // Blend premultiplied pixels so air fades out and opaque terrain does not darken.
    context.globalCompositeOperation = "lighter";
    context.globalAlpha = progress;
    context.drawImage(current, 0, 0, size, size);
    return this.blendCanvas;
  }

  private draw(time = performance.now()) {
    let animating = this.advanceZoom(time);
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
      this.changed({ ...this.detailState!, x: Math.round(this.camera.x), z: Math.round(this.camera.z), zoom: this.camera.zoom });
      return;
    }
    context.fillStyle = "#19252a";
    context.fillRect(0, 0, this.width, this.height);
    context.fillStyle = "#213035";
    for (let z = 0; z < this.height; z += 32) for (let x = 0; x < this.width; x += 32) if ((x / 32 + z / 32) % 2) context.fillRect(x, z, 32, 32);
    const visible = visibleTiles(this.camera, this.width, this.height);
    this.visible = new Set(visible.map((item) => tileKey(item.key, this.sliceY)));
    const positions = new Set(visible.map((item) => item.key));
    for (const key of this.displayed.keys()) if (!positions.has(key)) this.displayed.delete(key);
    let warnings = 0;
    for (const item of visible) {
      let display = this.displayed.get(item.key);
      const tile = this.nearestTile(item.key, display?.tile);
      if (tile && tile !== display?.tile) {
        tile.appearedAt ??= time;
        display = { tile, previous: display?.tile, startedAt: display ? time : tile.appearedAt, duration: display ? LAYER_FADE_DURATION : TILE_FADE_DURATION };
        this.displayed.set(item.key, display);
      }
      if (!display) continue;
      warnings += this.cache.get(tileKey(item.key, this.sliceY))?.warnings || 0;
      const bounds = tileBounds(this.camera, this.width, this.height, item.x, item.z, ratio, ratioY);
      if (this.reducedMotion?.matches) {
        display.startedAt = time - display.duration;
        display.tile.appearedAt = time - TILE_FADE_DURATION;
      }
      const progress = Math.max(0, Math.min(1, (time - display.startedAt) / display.duration));
      if (progress < 1) animating = true;
      if (display.previous && progress < 1) {
        context.globalAlpha = 1;
        context.drawImage(this.blend(display.previous, display.tile, easeOut(progress)), bounds.x, bounds.y, bounds.width, bounds.height);
      } else {
        display.previous = undefined;
        context.globalAlpha = easeOut(progress);
        context.drawImage(display.tile.image, bounds.x, bounds.y, bounds.width, bounds.height);
      }
    }
    context.globalAlpha = 1;
    this.drawMarkers(foreground);
    const needed = visible.filter((item) => {
      const key = tileKey(item.key, this.sliceY);
      return !this.cache.has(key) && !this.pending.has(key) && !this.failed.has(key);
    });
    this.changed({ x: Math.round(this.camera.x), z: Math.round(this.camera.z), zoom: this.camera.zoom,
      loading: needed.length + this.active + (this.wantsScene ? this.detailState?.loading || 0 : 0) + Number(this.detailLoading),
      warnings: Math.max(warnings, this.wantsScene ? this.detailState?.warnings || 0 : 0), limited: this.wantsScene && this.detailState?.limited,
      error: this.error ?? (this.wantsScene ? this.detailError ?? this.detailState?.error : undefined) });
    for (const item of needed.slice(0, Math.max(0, 3 - this.active))) this.fetchTile(item);
    if (animating) this.schedule();
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
    return this.detail?.ready && !!this.detailCanvas?.width && this.detailFrame?.y === this.sliceY;
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
    const x = frame.orthographic ? (frame.camera.x - this.camera.x) * this.camera.zoom + this.width / 2 - frame.width * scale / 2 : 0;
    const y = frame.orthographic ? (frame.camera.z - this.camera.z) * this.camera.zoom + this.height / 2 - frame.height * scale / 2 : 0;
    canvas.style.width = `${frame.orthographic ? frame.width : this.width}px`;
    canvas.style.height = `${frame.orthographic ? frame.height : this.height}px`;
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
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
        this.detail.setTopDownView(this.camera, this.width, this.height);
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
          if (this.detail?.ready) this.detailFrame = { ...this.detail.frameView, y: this.sliceY };
          this.presentScene();
        }
        this.schedule();
      }, this.sliceY, this.mode === "3d" ? "perspective" : "orthographic", this.canvas);
      this.detail.setSize(this.width, this.height);
      this.detail.camera.zoom = this.camera.zoom;
      this.detail.center(this.camera.x, this.camera.z);
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

  private async fetchTile(item: { x: number; z: number; key: string }) {
    const signal = this.abort.signal;
    const y = this.sliceY, key = tileKey(item.key, y);
    this.active++;
    this.pending.add(key);
    try {
      const result = await this.load(this.world.id, item.x, item.z, signal, y);
      if (signal.aborted) return;
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("MC_MAP_READ_FAILED")); });
      image.src = "data:image/png;base64," + result.image;
      await loaded;
      if (signal.aborted) return;
      this.cache.set(key, { image, warnings: result.warnings, position: item.key, y });
      while (this.cache.size > 256) {
        const outside = [...this.cache.keys()].find((key) => !this.visible.has(key));
        if (!outside) break;
        this.cache.delete(outside);
      }
    } catch (error) {
      if (!signal.aborted) {
        if (this.sliceY === y) this.error = error;
        this.failed.add(key);
      }
    } finally {
      if (!signal.aborted) {
        this.active--;
        this.pending.delete(key);
        this.schedule();
      }
    }
  }
}
