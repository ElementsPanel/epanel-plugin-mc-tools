import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { parseUncompressed, simplify } from "prismarine-nbt";
import { MAP_LIMIT, type MapWorld } from "../../../../shared/map";

const unzip = promisify(gunzip);
export interface SavedWorld extends MapWorld {
  directory: string;
  root: string;
  edition: "java" | "bedrock";
  dimensionId?: number;
}

function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

export async function safePath(root: string, ...parts: string[]) {
  const candidate = path.resolve(root, ...parts);
  if (!within(root, candidate)) throw new Error("MC_MAP_INVALID");
  const real = await fs.realpath(candidate);
  if (!within(root, real)) throw new Error("MC_MAP_INVALID");
  return real;
}

export async function readSmall(root: string, filename: string, limit: number) {
  const target = await safePath(root, filename);
  const file = await fs.open(target, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("MC_MAP_CORRUPT");
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) throw new Error("MC_MAP_CORRUPT");
    return buffer;
  } finally { await file.close(); }
}

async function levelInfo(root: string, directory: string, bedrock = false) {
  try {
    let bytes = await readSmall(root, path.join(directory, "level.dat"), 2 * 1024 * 1024);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await unzip(bytes, { maxOutputLength: 8 * 1024 * 1024 });
    const result = simplify(parseUncompressed(bedrock ? bytes.subarray(8) : bytes, bedrock ? "little" : "big"));
    return result.Data || result;
  } catch { return {}; }
}

function worldSpawn(info: any, dimension: string) {
  const position = info.spawn?.pos;
  const modern = Array.isArray(position) && Number.isFinite(position[0]) && Number.isFinite(position[2]);
  const source = modern && typeof info.spawn.dimension === "string" ? info.spawn.dimension : "minecraft:overworld";
  let scale = 1;
  if (source !== dimension) {
    if (source === "minecraft:overworld" && dimension === "minecraft:the_nether") scale = 1 / 8;
    else if (source === "minecraft:the_nether" && dimension === "minecraft:overworld") scale = 8;
    else if (source !== "minecraft:overworld" || dimension === "minecraft:the_end") return { x: 0, z: 0 };
  }
  const coordinate = (value: unknown) => Number.isFinite(value) ? Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, Math.floor(Number(value) * scale))) : 0;
  return { x: coordinate(modern ? position[0] : info.SpawnX), z: coordinate(modern ? position[2] : info.SpawnZ) };
}

export async function discoverWorlds(instance: { config: { type?: string }; absoluteCwdPath(): string }): Promise<SavedWorld[]> {
  const type = String(instance.config.type);
  const bedrock = type.startsWith("minecraft/bedrock");
  if ((!type.startsWith("minecraft/java") && !bedrock) || type.includes("bungeecord")) {
    throw new Error("MC_MAP_UNSUPPORTED_INSTANCE");
  }
  const root = await fs.realpath(instance.absoluteCwdPath());
  const entries = await fs.readdir(root, { withFileTypes: true });
  const candidates = [root, ...entries.filter((item) => item.isDirectory() && !item.name.startsWith(".")).slice(0, 128).map((item) => path.join(root, item.name))];
  if (bedrock) {
    try {
      const directory = await safePath(root, "worlds");
      const entries = await fs.readdir(directory, { withFileTypes: true });
      candidates.unshift(...entries.filter((item) => item.isDirectory() && !item.name.startsWith(".")).slice(0, 128).map((item) => path.join(directory, item.name)));
    } catch { /* Imported saves may also live directly in the instance folder. */ }
  }
  try {
    const properties = (await readSmall(root, "server.properties", 256 * 1024)).toString("utf8");
    const match = properties.match(/^\s*level-name\s*[=:]\s*(.*?)\s*$/m);
    if (match) {
      const name = match[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\([\\ :=])/g, "$1");
      candidates.unshift(await safePath(root, bedrock ? "worlds" : ".", name));
    }
  } catch { /* Default and Bukkit world folders can be discovered without properties. */ }
  const worlds: SavedWorld[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  for (const base of new Set(candidates)) {
    if (bedrock) {
      try {
        const directory = await safePath(root, base);
        const database = await safePath(root, directory, "db");
        if (seen.has(database) || !(await fs.stat(database)).isDirectory()) continue;
        await readSmall(root, path.join(database, "CURRENT"), 1024);
        const info = await levelInfo(root, directory, true);
        for (const [dimensionId, dimension] of ["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"].entries()) {
          if (worlds.length >= 128) break;
          worlds.push({
            id: createHash("sha256").update(path.relative(root, directory) + ":bedrock:" + dimensionId).digest("hex").slice(0, 24),
            name: String(info.LevelName || path.basename(directory)).slice(0, 100),
            dimension, dimensionId, edition: "bedrock", directory, root,
            spawn: worldSpawn(info, dimension)
          });
        }
        seen.add(database);
      } catch { /* Ignore incomplete or inaccessible world folders. */ }
      continue;
    }
    let info: any;
    const dimensions = new Set<string>();
    const add = async (directory: string, dimension: string) => {
      if (worlds.length >= 128 || dimensions.has(dimension)) return false;
      try {
        const region = await safePath(root, directory, "region");
        if (seen.has(region) || !(await fs.stat(region)).isDirectory()) return false;
        const actual = await safePath(root, directory);
        info ??= await levelInfo(root, base);
        const relative = path.relative(root, actual).split(path.sep).join("/");
        worlds.push({
          id: createHash("sha256").update(relative).digest("hex").slice(0, 24),
          name: String(info.LevelName || path.basename(base)).slice(0, 100),
          dimension,
          spawn: worldSpawn(info, dimension),
          directory: actual,
          root,
          edition: "java"
        });
        seen.add(region);
        dimensions.add(dimension);
        return true;
      } catch { return false; /* A world or dimension need not contain saved regions yet. */ }
    };
    for (const [name, legacy] of [["overworld", ""], ["the_nether", "DIM-1"], ["the_end", "DIM1"]]) {
      const dimension = "minecraft:" + name;
      if (!await add(path.join(base, "dimensions", "minecraft", name), dimension)) await add(path.join(base, legacy), dimension);
    }
    const scan = async (directory: string, parts: string[], depth: number) => {
      if (depth > 4 || worlds.length >= 128 || ++scanned > 512) return;
      let children;
      try { children = await fs.readdir(await safePath(root, directory), { withFileTypes: true }); }
      catch { return; }
      if (parts.length >= 2) await add(directory, parts[0] + ":" + parts.slice(1).join("/"));
      for (const child of children.slice(0, 128)) if (child.isDirectory() && child.name !== "region" && child.name !== "entities" && child.name !== "poi") {
        await scan(path.join(directory, child.name), [...parts, child.name], depth + 1);
      }
    };
    await scan(path.join(base, "dimensions"), [], 0);
  }
  return worlds;
}
