import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, inflate } from "node:zlib";
import { parseUncompressed, simplify } from "prismarine-nbt";
import { readSmall, safePath, type SavedWorld } from "./worlds";

const ungzip = promisify(gunzip), unzlib = promisify(inflate);
const MAX_CHUNK = 8 * 1024 * 1024;
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
    const file = await fs.open(region.filename, "r");
    try {
      const header = Buffer.alloc(4096);
      if ((await file.read(header, 0, header.length, 0)).bytesRead !== header.length) throw new Error("MC_MAP_CORRUPT");
      for (const position of region.chunks) {
        if (disposed()) throw new Error("MC_MAP_UNAVAILABLE");
        const index = (((position.x % 32) + 32) % 32 + (((position.z % 32) + 32) % 32) * 32) * 4;
        const sector = header.readUIntBE(index, 3), sectors = header[index + 3];
        if (!sector || !sectors) continue;
        try {
          if (sector < 2) throw new Error("MC_MAP_CORRUPT");
          const prefix = Buffer.alloc(5);
          if ((await file.read(prefix, 0, 5, sector * 4096)).bytesRead !== 5) throw new Error("MC_MAP_CORRUPT");
          const length = prefix.readUInt32BE(0), type = prefix[4] & 0x7f;
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
          read(simplify(parseUncompressed(data)), position.x, position.z);
          chunks++;
        } catch { warnings++; }
        if (chunks % 8 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally { await file.close(); }
  }
  return { chunks, warnings };
}
