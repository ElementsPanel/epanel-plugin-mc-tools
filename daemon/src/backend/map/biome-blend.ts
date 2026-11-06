import { MAP_SCENE_SIZE } from "../../../../shared/map";
import { minecraftAssets } from "../../../../shared/scene";
import type { BlockLayer } from "./chunk";

export type BiomeTint = 0 | 1 | 3;
const RADIUS = 3, HALO = 1, PAD = RADIUS + HALO;
const SIZE = MAP_SCENE_SIZE + HALO * 2, SAMPLES = MAP_SCENE_SIZE + PAD * 2, STRIDE = SAMPLES + 1;
const UNKNOWN = 0x1000000;

/** Blend a 7×7 horizontal neighborhood, including the adjoining scene's biomes. */
export function biomeBlend(chunks: ReadonlyArray<{ x: number; z: number; layers: BlockLayer[] }>) {
  const layers = new Map(chunks.map(chunk => [chunk.x + ":" + chunk.z, new Map(chunk.layers.map(layer => [layer.y, layer]))]));
  const cache = new Map<string, Uint32Array>();
  const palette = (biome?: string) => minecraftAssets.biomes[biome ?? "minecraft:plains"] ?? minecraftAssets.biomes["minecraft:plains"];
  return (x: number, y: number, z: number, tint: BiomeTint, fallback?: string): number => {
    const key = y + ":" + tint;
    let colors = cache.get(key);
    if (!colors) {
      // Summed-area tables keep the cost independent of the blending radius.
      const sums = Array.from({ length: 4 }, () => new Uint32Array(STRIDE * STRIDE));
      for (let sz = 0; sz < SAMPLES; sz++) for (let sx = 0; sx < SAMPLES; sx++) {
        const bx = sx - PAD, bz = sz - PAD;
        const column = layers.get(Math.floor(bx / 16) + ":" + Math.floor(bz / 16));
        let layer = column?.get(Math.floor(y / 16));
        if (!layer?.biome && column) {
          let distance = Infinity;
          for (const candidate of column.values()) if (candidate.biome && Math.abs(candidate.y - Math.floor(y / 16)) < distance) {
            layer = candidate; distance = Math.abs(candidate.y - Math.floor(y / 16));
          }
        }
        const biome = layer?.biome?.((y & 15) * 256 + (bz & 15) * 16 + (bx & 15));
        const color = biome ? palette(biome)[tint] : 0;
        const index = (sz + 1) * STRIDE + sx + 1;
        for (let channel = 0; channel < 4; channel++) {
          const value = channel === 3 ? Number(!!biome) : (color >> ((2 - channel) * 8)) & 255;
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
