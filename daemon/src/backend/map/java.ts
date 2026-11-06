import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, inflate } from "node:zlib";
import { readSmall, safePath, type SavedWorld } from "./worlds";
import { readChunkNbt } from "./nbt";

const ungzip = promisify(gunzip), unzlib = promisify(inflate);
const MAX_CHUNK = 8 * 1024 * 1024;
/** A region file this small is cheaper to read in one go than chunk by chunk. */
const MAX_INLINE_REGION = 8 * 1024 * 1024;
/** Inflate window; matches the default libuv thread pool without starving requests. */
const WINDOW = 8;
interface Region { filename: string; chunks: { x: number; z: number }[] }

export async function javaRegions(world: SavedWorld, firstX: number, firstZ: number, size: number) {
  const groups = new Map<string, { x: number; z: number }[]>();
  for (let z = firstZ; z < firstZ + size; z++) for (let x = firstX; x < firstX + size; x++) {
    const name = `r.${Math.floor(x / 32)}.${Math.floor(z / 32)}.mca`;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push({ x, z });
  }
  const files: Region[] = [], stamps: string[] = [];
  for (const [name, chunks] of groups) {
    try {
      const filename = await safePath(world.root, world.directory, "region", name);
      const stat = await fs.stat(filename);
      if (!stat.isFile()) throw new Error("MC_MAP_CORRUPT");
      files.push({ filename, chunks });
      stamps.push(name, String(stat.size), String(stat.mtimeMs));
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      stamps.push(name, "missing");
    }
  }
  return { files, stamp: stamps.join(":") };
}

/** Both views use the same bounded, read-only Anvil decoder. */
export async function readJavaChunks(world: SavedWorld, regions: Region[], read: (nbt: any, x: number, z: number) => void, disposed: () => boolean) {
  let chunks = 0, warnings = 0;
  for (const region of regions) {
    let inline: Buffer | undefined;
    let file: fs.FileHandle | undefined;
    const stat = await fs.stat(region.filename);
    if (stat.size <= MAX_INLINE_REGION) inline = await fs.readFile(region.filename);
    else file = await fs.open(region.filename, "r");
    try {
      // One read per chunk sector keeps huge region files cheap, while small ones
      // avoid a thread-pool round trip for every 5-byte header.
      const slice = async (offset: number, length: number) => {
        if (inline) {
          if (offset + length > inline.length) throw new Error("MC_MAP_CORRUPT");
          return inline.subarray(offset, offset + length);
        }
        const target = Buffer.allocUnsafe(length);
        if ((await file!.read(target, 0, length, offset)).bytesRead !== length) throw new Error("MC_MAP_CORRUPT");
        return target;
      };
      const header = await slice(0, 4096);
      const pending: { x: number; z: number; type: number; data: Buffer }[] = [];
      for (const position of region.chunks) {
        if (disposed()) throw new Error("MC_MAP_UNAVAILABLE");
        const index = (((position.x % 32) + 32) % 32 + (((position.z % 32) + 32) % 32) * 32) * 4;
        const sector = header.readUIntBE(index, 3), sectors = header[index + 3];
        if (!sector || !sectors) continue;
        try {
          if (sector < 2) throw new Error("MC_MAP_CORRUPT");
          const prefix = await slice(sector * 4096, 5);
          const length = prefix.readUInt32BE(0), type = prefix[4] & 0x7f;
          let data: Buffer;
          if (prefix[4] & 0x80) {
            data = await readSmall(world.root, path.join(world.directory, "region", `c.${position.x}.${position.z}.mcc`), MAX_CHUNK);
          } else {
            if (length < 1 || length > sectors * 4096 - 4 || length > MAX_CHUNK) throw new Error("MC_MAP_CORRUPT");
            data = await slice(sector * 4096 + 5, length - 1);
          }
          pending.push({ x: position.x, z: position.z, type, data });
        } catch { warnings++; }
      }
      // Decompress a window at a time: zlib runs on the thread pool, so waiting for
      // one chunk before starting the next left most of that pool idle.
      for (let start = 0; start < pending.length; start += WINDOW) {
        const batch = pending.slice(start, start + WINDOW);
        const inflated = await Promise.all(batch.map(async (entry) => {
          try {
            if (entry.type === 1) return await ungzip(entry.data, { maxOutputLength: MAX_CHUNK });
            if (entry.type === 2) return await unzlib(entry.data, { maxOutputLength: MAX_CHUNK });
            if (entry.type === 3) return entry.data;
            throw new Error("MC_MAP_COMPRESSION");
          } catch { return undefined; }
        }));
        for (let index = 0; index < batch.length; index++) {
          if (disposed()) throw new Error("MC_MAP_UNAVAILABLE");
          const data = inflated[index];
          if (!data) { warnings++; continue; }
          try {
            read(readChunkNbt(data), batch[index].x, batch[index].z);
            chunks++;
          } catch { warnings++; }
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally { await file?.close(); }
  }
  return { chunks, warnings };
}
