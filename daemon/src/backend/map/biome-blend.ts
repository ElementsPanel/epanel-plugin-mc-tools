import { MAP_SCENE_SIZE } from "../../../../shared/map";
import { minecraftAssets } from "../../../../shared/scene";
import type { BlockLayer } from "./chunk";

export type BiomeTint = 0 | 1 | 2 | 3;
const RADIUS = 3, HALO = 1, PAD = RADIUS + HALO;
const UNKNOWN = 0x1000000;

/**
 * Blend a 7×7 horizontal neighborhood, including the adjoining area's biomes.
 * Chunk coordinates are relative to the area's first chunk; the result covers the
 * area plus a one-block halo so vertex colors can sample across its edge.
 */
export function biomeBlend(chunks: ReadonlyArray<{ x: number; z: number; layers: BlockLayer[] }>, area = MAP_SCENE_SIZE) {
  const SIZE = area + HALO * 2, SAMPLES = area + PAD * 2, STRIDE = SAMPLES + 1;
  // Biomes are stored per 4×4×4 cell and chunks are 16-aligned, so a sample only
  // depends on its 4×4 column cell and on y / 4.
  const CELLS = SAMPLES / 4;
  const span = Math.ceil(area / 16) + 2;
  const columns: (Map<number, BlockLayer> | undefined)[] = new Array(span * span);
  for (const chunk of chunks) {
    if (chunk.x < -1 || chunk.z < -1 || chunk.x >= span - 1 || chunk.z >= span - 1) continue;
    columns[(chunk.z + 1) * span + chunk.x + 1] = new Map(chunk.layers.map(layer => [layer.y, layer]));
  }
  const cache = new Map<number, Uint32Array>();
  const palette = (biome?: string) => minecraftAssets.biomes[biome ?? "minecraft:plains"] ?? minecraftAssets.biomes["minecraft:plains"];
  return (x: number, y: number, z: number, tint: BiomeTint, fallback?: string): number => {
    const key = (y >> 2) * 4 + tint;
    let colors = cache.get(key);
    if (!colors) {
      const section = Math.floor(y / 16);
      const cellColors = new Int32Array(CELLS * CELLS);
      for (let cz = 0; cz < CELLS; cz++) for (let cx = 0; cx < CELLS; cx++) {
        const bx = cx * 4 - PAD, bz = cz * 4 - PAD;
        const column = columns[(Math.floor(bz / 16) + 1) * span + Math.floor(bx / 16) + 1];
        let layer = column?.get(section);
        if (!layer?.biome && column) {
          let distance = Infinity;
          for (const candidate of column.values()) if (candidate.biome && Math.abs(candidate.y - section) < distance) {
            layer = candidate; distance = Math.abs(candidate.y - section);
          }
        }
        const biome = layer?.biome?.((y & 15) * 256 + (bz & 15) * 16 + (bx & 15));
        cellColors[cz * CELLS + cx] = biome ? palette(biome)[tint] : -1;
      }
      // Summed-area tables keep the cost independent of the blending radius.
      const sums = Array.from({ length: 4 }, () => new Uint32Array(STRIDE * STRIDE));
      for (let sz = 0; sz < SAMPLES; sz++) for (let sx = 0; sx < SAMPLES; sx++) {
        const color = cellColors[(sz >> 2) * CELLS + (sx >> 2)];
        const index = (sz + 1) * STRIDE + sx + 1;
        for (let channel = 0; channel < 4; channel++) {
          const value = channel === 3 ? Number(color >= 0) : color < 0 ? 0 : (color >> ((2 - channel) * 8)) & 255;
          const sum = sums[channel];
          sum[index] = value + sum[index - 1] + sum[index - STRIDE] - sum[index - STRIDE - 1];
        }
      }
      colors = new Uint32Array(SIZE * SIZE);
      for (let cz = 0; cz < SIZE; cz++) for (let cx = 0; cx < SIZE; cx++) {
        const start = cz * STRIDE + cx, end = (cz + RADIUS * 2 + 1) * STRIDE + cx + RADIUS * 2 + 1;
        const sum = (channel: number) => sums[channel][end] - sums[channel][end - RADIUS * 2 - 1]
          - sums[channel][start + RADIUS * 2 + 1] + sums[channel][start];
        // Unloaded chunks have no biome samples; never introduce a plains-colored rim.
        const count = sum(3);
        colors[cz * SIZE + cx] = count ? (Math.round(sum(0) / count) << 16) | (Math.round(sum(1) / count) << 8) | Math.round(sum(2) / count) : UNKNOWN;
      }
      cache.set(key, colors);
    }
    const color = colors[(z + HALO) * SIZE + x + HALO];
    return color === UNKNOWN ? palette(fallback)[tint] : color;
  };
}
