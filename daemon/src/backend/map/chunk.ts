import { blockColor, isAir, legacyBlockName } from "./colors";

function unsignedLong(value: any): bigint {
  if (typeof value === "bigint") return BigInt.asUintN(64, value);
  if (Array.isArray(value) && value.length === 2) return (BigInt(value[0] >>> 0) << 32n) | BigInt(value[1] >>> 0);
  throw new Error("MC_MAP_CORRUPT");
}

/** Java 1.13-1.15 pack across longs; 1.16+ pad each long independently. */
export function paletteReader(data: any[], size: number, version: number) {
  const bits = Math.max(4, Math.ceil(Math.log2(size)));
  const mask = (1n << BigInt(bits)) - 1n;
  const longs = (data || []).map(unsignedLong);
  const perLong = Math.floor(64 / bits);
  const padded = version >= 2529 || (bits !== 4 && longs.length === Math.ceil(4096 / perLong));
  if (size > 1 && longs.length < (padded ? Math.ceil(4096 / perLong) : Math.ceil(4096 * bits / 64))) throw new Error("MC_MAP_CORRUPT");
  return (index: number) => {
    if (size === 1) return 0;
    if (padded) return Number((longs[Math.floor(index / perLong)] >> BigInt((index % perLong) * bits)) & mask);
    const bit = index * bits;
    const slot = Math.floor(bit / 64);
    const shift = bit % 64;
    let value = longs[slot] >> BigInt(shift);
    if (shift + bits > 64) value |= longs[slot + 1] << BigInt(64 - shift);
    return Number(value & mask);
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

export function chunkSurface(nbt: any, nether = false) {
  const chunk = nbt.Level ?? nbt;
  const sections = chunk.sections ?? chunk.Sections;
  if (!Array.isArray(sections)) throw new Error("MC_MAP_CORRUPT");
  const version = Number(nbt.DataVersion || chunk.DataVersion || 0);
  const layers = sections.map((section: any) => {
    const y = Number(section.Y);
    if (!Number.isInteger(y) || y < -128 || y > 127) throw new Error("MC_MAP_CORRUPT");
    const palette = section.block_states?.palette ?? section.Palette;
    if (Array.isArray(palette) && palette.length) {
      if (palette.length > 4096) throw new Error("MC_MAP_CORRUPT");
      const names = palette.map(blockStateName);
      if (names.every(isAir)) return undefined;
      const read = paletteReader(section.block_states?.data ?? section.BlockStates, names.length, version);
      return { y, block: (index: number) => names[read(index)] ?? "minecraft:air" };
    }
    if (section.Blocks?.length === 4096) {
      return { y, block: (index: number) => legacyBlockName((section.Blocks[index] & 255) | (((section.Add?.[index >> 1] ?? 0) >> ((index & 1) * 4) & 15) << 8)) };
    }
    return undefined;
  }).filter(Boolean).sort((a: any, b: any) => b.y - a.y) as { y: number; block: (index: number) => string }[];
  return surfaceFromLayers(layers, nether);
}

export interface BlockLayer { y: number; block(index: number): string }

export function surfaceFromLayers(layers: BlockLayer[], nether = false) {
  const colors = new Uint32Array(256);
  const heights = new Int16Array(256).fill(-32768);
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
        colors[z * 16 + x] = blockColor(name);
        heights[z * 16 + x] = height;
        break search;
      }
    }
  }
  return { colors, heights };
}
