import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, inflate } from "node:zlib";
import { parseUncompressed, simplify } from "prismarine-nbt";
import { MAP_TILE_SIZE, mapCoordinate, type MapTile } from "../../../../shared/map";
import { discoverWorlds, readSmall, safePath, type SavedWorld } from "./worlds";
import { chunkSurface } from "./chunk";
import { encodePng } from "./png";
import { BedrockSnapshots } from "./snapshot";
import { bedrockSurface } from "./bedrock";

const ungzip = promisify(gunzip);
const unzlib = promisify(inflate);
const MAX_CHUNK = 8 * 1024 * 1024;
const missing = (error: any) => error?.code === "ENOENT" || error?.code === "ENOTDIR";

export class WorldMapService {
  private readonly cache = new Map<string, { stamp: string; tile: MapTile }>();
  private readonly pending = new Map<string, Promise<MapTile>>();
  private readonly catalog = new Map<string, { at: number; worlds: SavedWorld[] }>();
  private readonly loadingWorlds = new Map<string, Promise<SavedWorld[]>>();
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private disposed = false;
  private readonly snapshots = new BedrockSnapshots();
  private readonly revisions = new Map<string, number>();

  constructor(private readonly instances: { getInstance(id: string): any }) {}

  async worlds(instanceUuid: string, refresh = false) {
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
    return worlds;
  }

  async tile(instanceUuid: string, worldId: string, x: number, z: number) {
    mapCoordinate(x);
    mapCoordinate(z);
    const world = (await this.worlds(instanceUuid)).find((item) => item.id === worldId);
    if (!world) throw new Error("MC_MAP_WORLD_MISSING");
    const key = world.root + ":" + world.id + ":" + (this.revisions.get(world.root) || 0) + ":" + x + ":" + z;
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
    this.catalog.clear();
    this.revisions.clear();
    for (const wake of this.waiting.splice(0)) wake();
    await Promise.allSettled([...this.pending.values()]);
    await this.snapshots.dispose();
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

  private async render(world: SavedWorld, key: string, tileX: number, tileZ: number): Promise<MapTile> {
    if (world.edition === "bedrock") return this.renderBedrock(world, key, tileX, tileZ);
    const groups = new Map<string, { x: number; z: number }[]>();
    const firstX = tileX * 8, firstZ = tileZ * 8;
    for (let z = firstZ; z < firstZ + 8; z++) for (let x = firstX; x < firstX + 8; x++) {
      const name = `r.${Math.floor(x / 32)}.${Math.floor(z / 32)}.mca`;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push({ x, z });
    }
    const files: { filename: string; chunks: { x: number; z: number }[] }[] = [];
    const stamps: string[] = [];
    for (const [name, chunks] of groups) {
      try {
        const filename = await safePath(world.root, world.directory, "region", name);
        const stat = await fs.stat(filename);
        if (!stat.isFile()) throw new Error("MC_MAP_CORRUPT");
        files.push({ filename, chunks });
        stamps.push(name, String(stat.size), String(stat.mtimeMs));
      } catch (error) { if (!missing(error)) throw error; stamps.push(name, "missing"); }
    }
    const stamp = stamps.join(":");
    const cached = this.cache.get(key);
    if (cached?.stamp === stamp) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.tile;
    }
    const colors = new Uint32Array(MAP_TILE_SIZE ** 2);
    const heights = new Int16Array(colors.length).fill(-32768);
    let chunks = 0, warnings = 0;
    for (const region of files) {
      const file = await fs.open(region.filename, "r");
      try {
        const header = Buffer.alloc(4096);
        if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length) throw new Error("MC_MAP_CORRUPT");
        for (const position of region.chunks) {
          if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
          const index = (((position.x % 32) + 32) % 32 + (((position.z % 32) + 32) % 32) * 32) * 4;
          const sector = header.readUIntBE(index, 3);
          const sectors = header[index + 3];
          if (!sector || !sectors) continue;
          try {
            if (sector < 2) throw new Error("MC_MAP_CORRUPT");
            const prefix = Buffer.alloc(5);
            if ((await file.read(prefix, 0, 5, sector * 4096)).bytesRead !== 5) throw new Error("MC_MAP_CORRUPT");
            const length = prefix.readUInt32BE(0);
            const type = prefix[4] & 0x7f;
            let data: Buffer;
            if (prefix[4] & 0x80) {
              data = await readSmall(world.root, path.join(world.directory, "region", `c.${position.x}.${position.z}.mcc`), MAX_CHUNK);
            } else {
              if (length < 1 || length > sectors * 4096 - 4 || length > MAX_CHUNK) throw new Error("MC_MAP_CORRUPT");
              data = Buffer.alloc(length - 1);
              if ((await file.read(data, 0, data.length, sector * 4096 + 5)).bytesRead !== data.length) throw new Error("MC_MAP_CORRUPT");
            }
            if (type === 1) data = await ungzip(data, { maxOutputLength: MAX_CHUNK });
            else if (type === 2) data = await unzlib(data, { maxOutputLength: MAX_CHUNK });
            else if (type !== 3) throw new Error("MC_MAP_COMPRESSION");
            const nbt = simplify(parseUncompressed(data));
            const surface = chunkSurface(nbt, world.dimension === "minecraft:the_nether");
            for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
              const target = ((position.z - firstZ) * 16 + z) * MAP_TILE_SIZE + (position.x - firstX) * 16 + x;
              colors[target] = surface.colors[z * 16 + x];
              heights[target] = surface.heights[z * 16 + x];
            }
            chunks++;
          } catch { warnings++; }
          if (chunks % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } finally { await file.close(); }
    }
    return this.finish(key, stamp, colors, heights, chunks, warnings);
  }

  private async renderBedrock(world: SavedWorld, key: string, tileX: number, tileZ: number): Promise<MapTile> {
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
        try { surface = await bedrockSurface(db, tileX * 8 + x, tileZ * 8 + z, world.dimensionId!); }
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
