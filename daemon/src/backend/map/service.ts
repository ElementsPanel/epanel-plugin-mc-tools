import fs from "node:fs/promises";
import { MAP_TILE_SIZE, mapCoordinate, mapSceneCoordinate, type MapTile, type MapSceneTile } from "../../../../shared/map";
import { discoverWorlds, type SavedWorld } from "./worlds";
import { chunkLayers } from "./chunk";
import { encodePng } from "./png";
import { BedrockSnapshots } from "./snapshot";
import { bedrockLayers } from "./bedrock";
import { javaRegions, readJavaChunks } from "./java";
import { meshScene, type SceneChunk } from "./scene";
import { renderSurface, type SurfaceChunk } from "./surface";


export class WorldMapService {
  private readonly cache = new Map<string, { stamp: string; tile: MapTile; bytes: number }>();
  private tileBytes = 0;
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
    // Scanning every world folder reads level.dat, so it must not run between tiles;
    // an explicit refresh still bypasses this cache.
    if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.worlds;
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
      if (key.startsWith(world.root + ":" + world.id + ":")) this.evictTile(key);
    }
    if (refresh) for (const world of worlds) for (const [key, cached] of this.sceneCache) {
      if (key.startsWith(world.root + ":" + world.id + ":")) {
        this.sceneBytes -= cached.bytes;
        this.sceneCache.delete(key);
      }
    }
    return worlds;
  }

  async tile(instanceUuid: string, worldId: string, x: number, z: number) {
    mapCoordinate(x);
    mapCoordinate(z);
    const world = (await this.worlds(instanceUuid)).find((item) => item.id === worldId);
    if (!world) throw new Error("MC_MAP_WORLD_MISSING");
    const key = world.root + ":" + world.id + ":" + (this.revisions.get(world.root) || 0) + ":surface:" + x + ":" + z;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const task = this.limited(() => this.render(world, key, x, z));
    this.pending.set(key, task);
    try { return await task; }
    finally { this.pending.delete(key); }
  }

  async dispose() {
    this.disposed = true;
    this.cache.clear();
    this.tileBytes = 0;
    this.sceneCache.clear();
    this.sceneBytes = 0;
    this.catalog.clear();
    this.revisions.clear();
    for (const wake of this.waiting.splice(0)) wake();
    await Promise.allSettled([...this.pending.values(), ...this.scenePending.values()]);
    await this.snapshots.dispose();
  }

  async scene(instanceUuid: string, worldId: string, x: number, z: number, options: { compress?: boolean } = {}): Promise<MapSceneTile> {
    mapSceneCoordinate(x); mapSceneCoordinate(z);
    const world = (await this.worlds(instanceUuid)).find(item => item.id === worldId);
    if (!world) throw new Error("MC_MAP_WORLD_MISSING");
    const compress = options.compress !== false;
    const key = world.root + ":" + world.id + ":" + (this.revisions.get(world.root) || 0) + ":surface:" + x + ":" + z + (compress ? ":gz" : "");
    const pending = this.scenePending.get(key);
    if (pending) return pending;
    const task = this.limited(() => this.renderScene(world, key, x, z, compress));
    this.scenePending.set(key, task);
    try { return await task; }
    finally { this.scenePending.delete(key); }
  }

  private async renderScene(world: SavedWorld, key: string, tileX: number, tileZ: number, compress = true): Promise<MapSceneTile> {
    const cached = (stamp: string) => {
      const previous = this.sceneCache.get(key);
      if (previous?.stamp !== stamp) return;
      this.sceneCache.delete(key); this.sceneCache.set(key, previous);
      return previous.tile;
    };
    const finish = async (stamp: string, chunks: SceneChunk[], neighbors: SceneChunk[], warnings: number) => {
      const tile = { ...await meshScene(chunks, world.dimension === "minecraft:the_nether", () => this.disposed, neighbors, compress), chunks: chunks.length, warnings };
      if (!this.disposed && !warnings && !tile.limited) {
        this.sceneBytes -= this.sceneCache.get(key)?.bytes || 0;
        const bytes = tile.payload?.length ?? (tile.quads?.length ?? 0) + (tile.heights?.length ?? 0) + (tile.tints?.length ?? 0);
        this.sceneCache.set(key, { stamp, tile, bytes }); this.sceneBytes += bytes;
        // Compressed tiles are ~20 KB, so a thousand of them cost about 20 MB of RAM.
        while (this.sceneBytes > 48 * 1024 * 1024 || this.sceneCache.size > 1024) {
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
      (x >= 0 && x < 2 && z >= 0 && z < 2 ? chunks : neighbors).push({ x, z, layers: chunkLayers(nbt, true) });
    }, () => this.disposed);
    return finish(stamp, chunks, neighbors, result.warnings);
  }

  private async limited<T>(run: () => Promise<T>) {
    if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
    // Rendering is I/O and zlib bound, so a couple of parallel tiles overlap well;
    // the parser itself is synchronous, which keeps the ceiling small.
    if (this.active >= 4) {
      if (this.waiting.length >= 64) throw new Error("MC_MAP_BUSY");
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

  private async render(world: SavedWorld, key: string, tileX: number, tileZ: number): Promise<MapTile> {
    if (world.edition === "bedrock") return this.renderBedrock(world, key, tileX, tileZ);
    const firstX = tileX * 8, firstZ = tileZ * 8;
    // The ring of neighbouring chunks feeds edge occlusion and biome blending, so
    // tiles meet without seams; it is part of the cache stamp for the same reason.
    const { files, stamp } = await javaRegions(world, firstX - 1, firstZ - 1, 10);
    const cached = this.cache.get(key);
    if (cached?.stamp === stamp) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.tile;
    }
    const owned = (x: number, z: number) => x >= firstX && x < firstX + 8 && z >= firstZ && z < firstZ + 8;
    const split = (inside: boolean) => files.map(file => ({ ...file, chunks: file.chunks.filter(chunk => owned(chunk.x, chunk.z) === inside) }))
      .filter(file => file.chunks.length);
    const nether = world.dimension === "minecraft:the_nether";
    const areas: SurfaceChunk[] = [];
    const collect = (nbt: any, x: number, z: number) => { areas.push({ x: x - firstX, z: z - firstZ, layers: chunkLayers(nbt, true) }); };
    const { chunks, warnings } = await readJavaChunks(world, split(true), collect, () => this.disposed);
    // Missing or damaged neighbours only soften the edge; they are not this tile's warnings.
    if (chunks) await readJavaChunks(world, split(false), collect, () => this.disposed);
    if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
    return this.surface(key, stamp, areas, nether, chunks, warnings);
  }

  private async renderBedrock(world: SavedWorld, key: string, tileX: number, tileZ: number): Promise<MapTile> {
    return this.snapshots.use(world, async (db, stamp) => {
      const cached = this.cache.get(key);
      if (cached?.stamp === stamp) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached.tile;
      }
      const areas: SurfaceChunk[] = [];
      let chunks = 0, warnings = 0, read = 0;
      // Owned chunks first: an empty tile does not need its neighbours.
      for (const ring of [false, true]) for (let z = -1; z <= 8; z++) for (let x = -1; x <= 8; x++) {
        if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
        const owned = x >= 0 && x < 8 && z >= 0 && z < 8;
        if (owned === ring || (ring && !chunks)) continue;
        let chunk;
        try { chunk = await bedrockLayers(db, tileX * 8 + x, tileZ * 8 + z, world.dimensionId!); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "MC_MAP_CORRUPT") throw error;
          if (owned) warnings++;
          continue;
        }
        if (!chunk) continue;
        if (owned) { warnings += chunk.warnings; chunks++; }
        areas.push({ x, z, layers: chunk.layers });
        if (++read % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return this.surface(key, stamp, areas, world.dimensionId === 1, chunks, warnings);
    });
  }

  /** Damaged owned chunks found while drawing count like ones that failed to parse. */
  private surface(key: string, stamp: string, areas: SurfaceChunk[], nether: boolean, chunks: number, warnings: number) {
    const { pixels, corrupt } = renderSurface(areas, MAP_TILE_SIZE, nether);
    const owned = corrupt.filter(chunk => chunk.x >= 0 && chunk.z >= 0 && chunk.x < 8 && chunk.z < 8).length;
    return this.finish(key, stamp, pixels, chunks - owned, warnings + owned);
  }

  private finish(key: string, stamp: string, pixels: Uint8Array, chunks: number, warnings: number): MapTile {
    const tile = { image: encodePng(pixels, MAP_TILE_SIZE, MAP_TILE_SIZE).toString("base64"), chunks, warnings };
    if (!this.disposed && !warnings) {
      this.evictTile(key);
      const bytes = tile.image.length;
      this.cache.set(key, { stamp, tile, bytes }); this.tileBytes += bytes;
      while (this.cache.size > 256 || this.tileBytes > 48 * 1024 * 1024) this.evictTile(this.cache.keys().next().value!);
    }
    return tile;
  }

  private evictTile(key: string) {
    const cached = this.cache.get(key);
    if (cached) { this.tileBytes -= cached.bytes; this.cache.delete(key); }
  }
}
