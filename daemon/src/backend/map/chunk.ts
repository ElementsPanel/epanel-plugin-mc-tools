import { blockColor, isAir, legacyBlockName } from "./colors";
import { blockFluid } from "./materials";
import { ChunkLongs } from "./nbt";

function unsignedLong(value: any): bigint {
  if (typeof value === "bigint") return BigInt.asUintN(64, value);
  if (Array.isArray(value) && value.length === 2) return (BigInt(value[0] >>> 0) << 32n) | BigInt(value[1] >>> 0);
  throw new Error("MC_MAP_CORRUPT");
}

/** Java 1.13-1.15 pack across longs; 1.16+ pad each long independently. */
export function paletteReader(data: ArrayLike<unknown> | ChunkLongs | undefined, size: number, version: number, count = 4096, minimumBits = 4) {
  const bits = Math.max(minimumBits, Math.ceil(Math.log2(size)));
  const mask = (1 << bits) - 1;
  const longs: ArrayLike<unknown> = data || [];
  const perLong = Math.floor(64 / bits);
  const padded = version >= 2529 || (bits !== 4 && longs.length === Math.ceil(count / perLong));
  if (size > 1 && longs.length < (padded ? Math.ceil(count / perLong) : Math.ceil(count * bits / 64))) throw new Error("MC_MAP_CORRUPT");
  const length = longs.length;
  // Splitting every long up front dominates the cost of a surface scan, which reads
  // one to three blocks per column; split nothing until the first read asks for it.
  let high: Uint32Array | undefined, low: Uint32Array | undefined, ready = false;
  const split = () => {
    if (ready) return;
    ready = true;
    high = new Uint32Array(length); low = new Uint32Array(length);
    if (data instanceof ChunkLongs) data.split(high, low);
    else for (let i = 0; i < length; i++) {
      const value = unsignedLong(longs[i]);
      high[i] = Number(value >> 32n) >>> 0;
      low[i] = Number(value & 0xffffffffn);
    }
  };
  return (index: number) => {
    if (size === 1) return 0;
    if (!ready) split();
    const bit = index * bits;
    const slot = padded ? Math.floor(index / perLong) : Math.floor(bit / 64);
    const shift = padded ? (index % perLong) * bits : bit % 64;
    let value: number;
    if (shift >= 32) {
      const top = high![slot];
      if (bits <= 64 - shift) value = top >>> (shift - 32);
      else {
        const next = low![slot + 1];
        if (next === undefined) throw new Error("MC_MAP_CORRUPT");
        value = (top >>> (shift - 32)) | (next << (64 - shift));
      }
    } else if (shift === 0) value = low![slot];
    else value = (low![slot] >>> shift) | (high![slot] << (32 - shift));
    return value & mask;
  };
}

/** Older Java palettes use Name; 26.x also uses strings and id/properties compounds. */
function blockStateName(block: unknown): string {
  const name = typeof block === "string" ? block : block && typeof block === "object"
    ? (block as any).Name ?? (block as any).id ?? (block as any)[""] : undefined;
  // Mixed NBT lists can wrap a string in a compound whose tag name is empty.
  if (typeof name !== "string" || !name) throw new Error("MC_MAP_CORRUPT");
  return name;
}

export function blockProperties(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const entries = Object.entries(value).filter(([key, value]) => key.length <= 128 && ["string", "number", "boolean"].includes(typeof value));
  if (entries.length) return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
}

export function chunkLayers(nbt: any, retainBiomes = false): BlockLayer[] {
  const chunk = nbt.Level ?? nbt;
  const sections = chunk.sections ?? chunk.Sections;
  if (!Array.isArray(sections)) throw new Error("MC_MAP_CORRUPT");
  const version = Number(nbt.DataVersion || chunk.DataVersion || 0);
  return sections.map((section: any) => {
    const y = Number(section.Y);
    if (!Number.isInteger(y) || y < -128 || y > 127) throw new Error("MC_MAP_CORRUPT");
    let biome: BlockLayer["biome"];
    const biomes = section.biomes?.palette;
    if (Array.isArray(biomes) && biomes.length && biomes.length <= 64 && biomes.every(name => typeof name === "string")) {
      try {
        const read = paletteReader(section.biomes.data, biomes.length, version, 64, 1);
        biome = index => biomes[read(((index >> 10) & 3) * 16 + ((index >> 6) & 3) * 4 + ((index >> 2) & 3))];
      } catch { /* Incomplete biome data does not hide otherwise readable blocks. */ }
    }
    const palette = section.block_states?.palette ?? section.Palette;
    if (Array.isArray(palette) && palette.length) {
      if (palette.length > 4096) throw new Error("MC_MAP_CORRUPT");
      const names = palette.map(blockStateName);
      const properties = palette.map((state: any) => blockProperties(state?.Properties ?? state?.properties));
      if (names.every(isAir)) {
        // Air sections still carry the biome colors needed by neighboring treetops.
        return retainBiomes && biome ? { y, biome, empty: true, block: () => "minecraft:air" } : undefined;
      }
      const read = paletteReader(section.block_states?.data ?? section.BlockStates, names.length, version);
      return { y, biome, block: (index: number) => names[read(index)] ?? "minecraft:air", properties: (index: number) => properties[read(index)] };
    }
    if (section.Blocks?.length === 4096) {
      return { y, block: (index: number) => legacyBlockName((section.Blocks[index] & 255) | (((section.Add?.[index >> 1] ?? 0) >> ((index & 1) * 4) & 15) << 8)) };
    }
    return undefined;
  }).filter(Boolean).sort((a: any, b: any) => b.y - a.y) as BlockLayer[];
}

export interface BlockLayer { y: number; empty?: boolean; block(index: number): string; biome?(index: number): string; properties?(index: number): Readonly<Record<string, string>> | undefined; fluid?(index: number): string | undefined }

export function chunkSurface(nbt: any, nether = false) {
  return surfaceFromLayers(chunkLayers(nbt), nether);
}

export function surfaceFromLayers(layers: BlockLayer[], nether = false) {
  const colors = new Uint32Array(256);
  const heights = new Int16Array(256).fill(-32768);
  const record = (column: number, height: number, name: string, layer: BlockLayer, index: number) => {
    const properties = layer.properties?.(index);
    const fluid = layer.fluid?.(index) ?? blockFluid(name, properties);
    if (fluid) name = fluid;
    colors[column] = blockColor(name, layer.biome?.(index));
    heights[column] = height;
  };
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    let open = !nether;
    let lastY = 121;
    search: for (const layer of layers) {
      if (nether && layer.y * 16 > 120) continue;
      if (nether && lastY - (layer.y * 16 + 15) > 1) open = true;
      for (let y = Math.min(15, nether ? 120 - layer.y * 16 : 15); y >= 0; y--) {
        const height = layer.y * 16 + y;
        const name = layer.block(y * 256 + z * 16 + x);
        lastY = height;
        if (isAir(name)) { open = true; continue; }
        if (!open) continue;
        record(z * 16 + x, height, name, layer, y * 256 + z * 16 + x);
        break search;
      }
    }
  }
  return { colors, heights };
}
