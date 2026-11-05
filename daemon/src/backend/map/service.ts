import fs from "node:fs/promises";
import { MAP_TILE_SIZE, mapCoordinate, mapSceneCoordinate, mapHeight, type MapTile, type MapSceneTile } from "../../../../shared/map";
import { discoverWorlds, type SavedWorld } from "./worlds";
import { chunkLayers, chunkSurface } from "./chunk";
import { encodePng } from "./png";
import { BedrockSnapshots } from "./snapshot";
import { bedrockLayers, bedrockSurface } from "./bedrock";
import { javaRegions, readJavaChunks } from "./java";
import { meshScene, type SceneChunk } from "./scene";


export class WorldMapService {
  private readonly cache = new Map<string, { stamp: string; tile: MapTile }>();
  private readonly pending = new Map<string, Promise<MapTile>>();
  private readonly sceneCache = new Map<string, { stamp: string; tile: MapSceneTile; bytes: number }>();
  private readonly scenePending = new Map<string, Promise<MapSceneTile>>();
  private sceneBytes = 0;
  private readonly catalog = new Map<string, { at: number; worlds: SavedWorld[] }>();
  private readonly loadingWorlds = new Map<string, Promise<SavedWorld[]>>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private disposed = false;
  private readonly snapshots = new BedrockSnapshots();
  private readonly revisions = new Map<string, number>();

  constructor(private readonly instances: { getInstance(id: string): any }) {}

  async worlds(instanceUuid: string, refresh = false): Promise<SavedWorld[]> {
    if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
    const instance = this.instances.getInstance(instanceUuid);
    if (!instance) throw new Error("MC_MAP_INSTANCE_MISSING");
    const key = instanceUuid + ":" + instance.absoluteCwdPath();
    const cached = this.catalog.get(key);
    if (!refresh && cached && Date.now() - cached.at < 5000) return cached.worlds;
    const current = this.loadingWorlds.get(key);
    if (current) {
      if (!refresh) return current;
      await current;
      return this.worlds(instanceUuid, true);
    }
    const discovering = discoverWorlds(instance);
    this.loadingWorlds.set(key, discovering);
    let worlds;
    try { worlds = await discovering; }
    finally { this.loadingWorlds.delete(key); }
    if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
    if (refresh) {
      const root = await fs.realpath(instance.absoluteCwdPath());
      this.snapshots.invalidate(root);
      this.revisions.set(root, (this.revisions.get(root) || 0) + 1);
    }
    this.catalog.set(key, { at: Date.now(), worlds });
    if (this.catalog.size > 64) this.catalog.delete(this.catalog.keys().next().value!);
    if (refresh) for (const world of worlds) for (const key of this.cache.keys()) {
      if (key.startsWith(world.root + ":" + world.id + ":")) this.cache.delete(key);
    }
    if (refresh) for (const world of worlds) for (const [key, cached] of this.sceneCache) {
      if (key.startsWith(world.root + ":" + world.id + ":")) {
        this.sceneBytes -= cached.bytes;
        this.sceneCache.delete(key);
      }
    }
    return worlds;
  }

  async tile(instanceUuid: string, worldId: string, x: number, z: number, y?: number) {
    mapCoordinate(x);
    mapCoordinate(z);
    mapHeight(y);
    const world = (await this.worlds(instanceUuid)).find((item) => item.id === worldId);
    if (!world) throw new Error("MC_MAP_WORLD_MISSING");
    const key = world.root + ":" + world.id + ":" + (this.revisions.get(world.root) || 0) + ":" + (y ?? "surface") + ":" + x + ":" + z;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const task = this.limited(() => this.render(world, key, x, z, y));
    this.pending.set(key, task);
    try { return await task; }
    finally { this.pending.delete(key); }
  }

  async dispose() {
    this.disposed = true;
    this.cache.clear();
    this.sceneCache.clear();
    this.sceneBytes = 0;
    this.catalog.clear();
    this.revisions.clear();
    for (const wake of this.waiting.splice(0)) wake();
    await Promise.allSettled([...this.pending.values(), ...this.scenePending.values()]);
    await this.snapshots.dispose();
  }

  async scene(instanceUuid: string, worldId: string, x: number, z: number, y?: number): Promise<MapSceneTile> {
    mapSceneCoordinate(x); mapSceneCoordinate(z); mapHeight(y);
    const world = (await this.worlds(instanceUuid)).find(item => item.id === worldId);
    if (!world) throw new Error("MC_MAP_WORLD_MISSING");
    const key = world.root + ":" + world.id + ":" + (this.revisions.get(world.root) || 0) + ":" + (y ?? "surface") + ":" + x + ":" + z;
    const pending = this.scenePending.get(key);
    if (pending) return pending;
    const task = this.limited(() => this.renderScene(world, key, x, z, y));
    this.scenePending.set(key, task);
    try { return await task; }
    finally { this.scenePending.delete(key); }
  }

  private async renderScene(world: SavedWorld, key: string, tileX: number, tileZ: number, y?: number): Promise<MapSceneTile> {
    const cached = (stamp: string) => {
      const previous = this.sceneCache.get(key);
      if (previous?.stamp !== stamp) return;
      this.sceneCache.delete(key); this.sceneCache.set(key, previous);
      return previous.tile;
    };
    const finish = async (stamp: string, chunks: SceneChunk[], neighbors: SceneChunk[], warnings: number) => {
      const tile = { ...await meshScene(chunks, world.dimension === "minecraft:the_nether", y, () => this.disposed, neighbors), chunks: chunks.length, warnings };
      if (!this.disposed && !warnings && !tile.limited) {
        this.sceneBytes -= this.sceneCache.get(key)?.bytes || 0;
        const bytes = tile.quads.length + tile.heights.length;
        this.sceneCache.set(key, { stamp, tile, bytes }); this.sceneBytes += bytes;
        while (this.sceneBytes > 32 * 1024 * 1024 || this.sceneCache.size > 128) {
          const oldest = this.sceneCache.keys().next().value!;
          this.sceneBytes -= this.sceneCache.get(oldest)!.bytes;
          this.sceneCache.delete(oldest);
        }
      }
      return tile;
    };
    if (world.edition === "bedrock") return this.snapshots.use(world, async (db, stamp) => {
      const previous = cached(stamp);
      if (previous) return previous;
      const chunks: SceneChunk[] = [], neighbors: SceneChunk[] = [];
      let warnings = 0;
      for (let z = -1; z <= 2; z++) for (let x = -1; x <= 2; x++) {
        if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
        const chunk = await bedrockLayers(db, tileX * 2 + x, tileZ * 2 + z, world.dimensionId!);
        if (chunk) {
          (x >= 0 && x < 2 && z >= 0 && z < 2 ? chunks : neighbors).push({ x, z, layers: chunk.layers });
          warnings += chunk.warnings;
        }
      }
      return finish(stamp, chunks, neighbors, warnings);
    });
    const { files, stamp } = await javaRegions(world, tileX * 2 - 1, tileZ * 2 - 1, 4);
    const previous = cached(stamp);
    if (previous) return previous;
    const chunks: SceneChunk[] = [], neighbors: SceneChunk[] = [];
    const result = await readJavaChunks(world, files, (nbt, x, z) => {
      x -= tileX * 2; z -= tileZ * 2;
      (x >= 0 && x < 2 && z >= 0 && z < 2 ? chunks : neighbors).push({ x, z, layers: chunkLayers(nbt) });
    }, () => this.disposed);
    return finish(stamp, chunks, neighbors, result.warnings);
  }

  private async limited<T>(run: () => Promise<T>) {
    if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
    if (this.active >= 2) {
      if (this.waiting.length >= 32) throw new Error("MC_MAP_BUSY");
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active++;
    if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
    try { return await run(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async render(world: SavedWorld, key: string, tileX: number, tileZ: number, sliceY?: number): Promise<MapTile> {
    if (world.edition === "bedrock") return this.renderBedrock(world, key, tileX, tileZ, sliceY);
    const firstX = tileX * 8, firstZ = tileZ * 8;
    const { files, stamp } = await javaRegions(world, firstX, firstZ, 8);
    const cached = this.cache.get(key);
    if (cached?.stamp === stamp) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.tile;
    }
    const colors = new Uint32Array(MAP_TILE_SIZE ** 2);
    const heights = new Int16Array(colors.length).fill(-32768);
    const { chunks, warnings } = await readJavaChunks(world, files, (nbt, chunkX, chunkZ) => {
      const surface = chunkSurface(nbt, world.dimension === "minecraft:the_nether", sliceY);
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const target = ((chunkZ - firstZ) * 16 + z) * MAP_TILE_SIZE + (chunkX - firstX) * 16 + x;
        colors[target] = surface.colors[z * 16 + x];
        heights[target] = surface.heights[z * 16 + x];
      }
    }, () => this.disposed);
    return this.finish(key, stamp, colors, heights, chunks, warnings);
  }

  private async renderBedrock(world: SavedWorld, key: string, tileX: number, tileZ: number, sliceY?: number): Promise<MapTile> {
    return this.snapshots.use(world, async (db, stamp) => {
      const cached = this.cache.get(key);
      if (cached?.stamp === stamp) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.tile;
      }
      const colors = new Uint32Array(MAP_TILE_SIZE ** 2);
      const heights = new Int16Array(colors.length).fill(-32768);
      let chunks = 0, warnings = 0;
      for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) {
        if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
        let surface;
        try { surface = await bedrockSurface(db, tileX * 8 + x, tileZ * 8 + z, world.dimensionId!, sliceY); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "MC_MAP_CORRUPT") throw error;
          warnings++;
          continue;
        }
        if (!surface) continue;
        warnings += surface.warnings;
        chunks++;
        for (let localZ = 0; localZ < 16; localZ++) for (let localX = 0; localX < 16; localX++) {
          const target = (z * 16 + localZ) * MAP_TILE_SIZE + x * 16 + localX;
          colors[target] = surface.colors[localZ * 16 + localX];
          heights[target] = surface.heights[localZ * 16 + localX];
        }
        if (chunks % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return this.finish(key, stamp, colors, heights, chunks, warnings);
    });
  }

  private finish(key: string, stamp: string, colors: Uint32Array, heights: Int16Array, chunks: number, warnings: number): MapTile {
    const pixels = new Uint8Array(colors.length * 4);
    for (let i = 0; i < colors.length; i++) {
      if (heights[i] === -32768) continue;
      const before = i >= MAP_TILE_SIZE ? heights[i - MAP_TILE_SIZE] : heights[i];
      const shade = before === -32768 ? 1 : Math.max(0.72, Math.min(1.2, 1 + (heights[i] - before) * 0.045));
      pixels[i * 4] = Math.min(255, Math.round(((colors[i] >> 16) & 255) * shade));
      pixels[i * 4 + 1] = Math.min(255, Math.round(((colors[i] >> 8) & 255) * shade));
      pixels[i * 4 + 2] = Math.min(255, Math.round((colors[i] & 255) * shade));
      pixels[i * 4 + 3] = 255;
    }
    const tile = { image: encodePng(pixels, MAP_TILE_SIZE, MAP_TILE_SIZE).toString("base64"), chunks, warnings };
    if (!this.disposed && !warnings) {
      this.cache.set(key, { stamp, tile });
      if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    }
    return tile;
  }
}
