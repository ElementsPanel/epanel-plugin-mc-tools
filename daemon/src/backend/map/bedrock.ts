import type { LevelDB } from "leveldb-zlib";
import { protos, simplify } from "prismarine-nbt";
import { isAir, legacyBlockName } from "./colors";
import { surfaceFromLayers, type BlockLayer } from "./chunk";

export function bedrockKey(x: number, z: number, dimension: number, tag: number, y?: number) {
  const key = Buffer.alloc((dimension === 0 ? 8 : 12) + (y === undefined ? 1 : 2));
  key.writeInt32LE(x, 0);
  key.writeInt32LE(z, 4);
  if (dimension !== 0) key.writeInt32LE(dimension, 8);
  key[key.length - (y === undefined ? 1 : 2)] = tag;
  if (y !== undefined) key.writeInt8(y, key.length - 1);
  return key;
}

/** Persistent Bedrock subchunks use X/Z/Y order and little-endian named NBT palettes. */
export function bedrockLayer(data: Buffer, y: number): BlockLayer {
  if (data.length > 8 * 1024 * 1024 || !data.length) throw new Error("MC_MAP_CORRUPT");
  const version = data[0];
  if (version === 0) {
    if (data.length < 6145) throw new Error("MC_MAP_CORRUPT");
    return { y, block: (index) => {
      const x = index & 15, z = (index >> 4) & 15, localY = index >> 8;
      return legacyBlockName(data[1 + (x << 8) + (z << 4) + localY]);
    } };
  }
  if (![1, 8, 9].includes(version)) throw new Error("MC_MAP_CORRUPT");
  let offset = version === 1 ? 1 : version === 9 ? 3 : 2;
  const count = version === 1 ? 1 : data[1];
  if (count > 8 || (version === 9 && data.readInt8(2) !== y)) throw new Error("MC_MAP_CORRUPT");
  const storages: ((index: number) => string)[] = [];
  for (let layer = 0; layer < count; layer++) {
    if (offset >= data.length) throw new Error("MC_MAP_CORRUPT");
    const header = data[offset++], bits = header >> 1;
    if ((header & 1) || ![0, 1, 2, 3, 4, 5, 6, 8, 16].includes(bits)) throw new Error("MC_MAP_CORRUPT");
    const perWord = bits ? Math.floor(32 / bits) : 4096;
    const words = bits ? Math.ceil(4096 / perWord) : 0;
    const start = offset;
    offset += words * 4;
    if (bits && offset + 4 > data.length) throw new Error("MC_MAP_CORRUPT");
    const size = bits ? data.readUInt32LE(offset) : 1;
    if (bits) offset += 4;
    if (size < 1 || size > 4096 || size > 2 ** bits) throw new Error("MC_MAP_CORRUPT");
    const names: string[] = [];
    for (let index = 0; index < size; index++) {
      const parsed = protos.little.parsePacketBuffer("nbt", data, offset);
      const name = simplify(parsed.data).name;
      if (typeof name !== "string" || !parsed.metadata.size) throw new Error("MC_MAP_CORRUPT");
      names.push(name);
      offset += parsed.metadata.size;
    }
    const mask = 2 ** bits - 1;
    storages.push((index) => {
      const paletteIndex = bits ? (data.readUInt32LE(start + Math.floor(index / perWord) * 4) >>> ((index % perWord) * bits)) & mask : 0;
      if (paletteIndex >= size) throw new Error("MC_MAP_CORRUPT");
      return names[paletteIndex];
    });
  }
  return { y, block: (index) => {
    const packed = ((index & 15) << 8) | (((index >> 4) & 15) << 4) | (index >> 8);
    for (const storage of storages) {
      const name = storage(packed);
      if (!isAir(name)) return name;
    }
    return "air";
  } };
}

export async function bedrockSurface(db: LevelDB, x: number, z: number, dimension: number) {
  const prefix = bedrockKey(x, z, dimension, 47);
  const iterator = db.getIterator({ gte: prefix, lt: bedrockKey(x, z, dimension, 48), limit: 257, fillCache: false });
  const layers: BlockLayer[] = [];
  let warnings = 0, found = false;
  try {
    let next: any[] | null;
    // Use the explicit iterator so errors and early returns also close its native handle.
    while ((next = await iterator.next())) {
      const [value, key] = next as [Buffer, Buffer];
      if (key.length !== prefix.length + 1 || !key.subarray(0, prefix.length).equals(prefix)) continue;
      found = true;
      try { layers.push(bedrockLayer(value, key.readInt8(key.length - 1))); }
      catch { warnings++; }
    }
  } finally { await iterator.end(); }
  if (!found) return undefined;
  layers.sort((a, b) => b.y - a.y);
  return { ...surfaceFromLayers(layers, dimension === 1), warnings };
}
