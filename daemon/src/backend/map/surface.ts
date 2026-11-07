import { minecraftAssets, SceneKind } from "../../../../shared/scene";
import spriteColors from "../../../../shared/sprite-colors.json";
import type { BlockLayer } from "./chunk";
import { fallbackColor, isAir } from "./colors";
import { blockFluid, blockMaterial, blockTintColor } from "./materials";
import { biomeBlend, type BiomeTint } from "./biome-blend";

/**
 * The flat map reproduces what the 3D view shows from straight above (its
 * orthographic 2D mode), reduced to one pixel per block:
 *
 * - only faces that are visible from above count: cross plants, vines, fire and
 *   torches are vertical or tiny and vanish, while carpets of petals stay;
 * - water, ice and stained glass blend with what lies beneath them, using the same
 *   faces the mesher keeps (top and, for double-sided translucency, bottom);
 * - top faces get the mesher's vertex ambient occlusion and face shading;
 * - biome tints use the same 7×7 blend and per-vertex averaging.
 */
export interface SurfaceChunk { x: number; z: number; layers: BlockLayer[] }

type Sprite = [color: number, alpha: number, mipColor: number, cover: number];
const sprites = spriteColors as unknown as Record<string, Sprite>;

const enum Shape { Air, Hidden, Cube, Ground, Model }
interface Info {
  shape: Shape;
  name: string;
  /** Interned name; faces between equal names are culled. */
  slot: number;
  /** Culls neighbouring faces (the mesher's solidOf). */
  solid: boolean;
  opaque: boolean;
  translucent: boolean;
  occludesAo: boolean;
  emissive: boolean;
  waterBody: boolean;
  color: number;
  /** Fraction of the face that is drawn (cutout coverage, or translucent alpha). */
  alpha: number;
  tinted: boolean;
  biomeTint?: BiomeTint;
}

const waterBody = new Set(["minecraft:water", "water", "minecraft:flowing_water", "flowing_water", "minecraft:bubble_column", "bubble_column"]);
const slots = new Map<string, number>();
const plain = new Map<string, Info>();
const withProperties = new WeakMap<object, Map<string, Info>>();
const AIR: Info = { shape: Shape.Air, name: "air", slot: 0, solid: false, opaque: false, translucent: false, occludesAo: false, emissive: false, waterBody: false, color: 0, alpha: 0, tinted: false };

function describe(block: string, properties?: Readonly<Record<string, string>>): Info {
  if (isAir(block)) return AIR;
  const material = blockMaterial(block, undefined, properties), model = material.model;
  let slot = slots.get(material.name);
  if (slot === undefined) { slot = slots.size + 1; slots.set(material.name, slot); }
  const kind = material.kind;
  const shape = kind === SceneKind.Plant ? model.shape === "ground" ? Shape.Ground : Shape.Hidden
    : model.shape === "model" ? model.solid === false ? Shape.Hidden : Shape.Model : Shape.Cube;
  const sprite = sprites[String(model.shape === "model" ? model.key ?? model.faces[2] : model.faces[2])];
  const translucent = kind === SceneKind.Translucent;
  // Opaque sprites have no transparent texels; cutout ones are drawn where their
  // mip texels survive the alpha test, translucent ones blend by their alpha.
  const alpha = !sprite ? 1 : kind === SceneKind.Opaque || shape === Shape.Model ? 1 : (translucent ? sprite[1] : sprite[3]) / 255;
  return {
    shape, name: material.name, slot,
    solid: kind !== SceneKind.Plant && model.solid !== false,
    opaque: kind === SceneKind.Opaque && model.solid !== false,
    translucent,
    occludesAo: model.solid !== false && (kind === SceneKind.Opaque || kind === SceneKind.Cutout),
    emissive: material.emissive,
    waterBody: waterBody.has(block),
    color: sprite ? translucent ? sprite[0] : sprite[2] : fallbackColor(material.name),
    alpha,
    tinted: !!sprite && !!(model.tint & 4) && material.color !== 0xffffff,
    biomeTint: material.biomeTint
  };
}

/** Block states repeat endlessly; palette property objects keep a stable identity. */
function info(block: string, properties?: Readonly<Record<string, string>>): Info {
  let table = plain;
  if (properties) {
    table = withProperties.get(properties)!;
    if (!table) { table = new Map(); withProperties.set(properties, table); }
  }
  let value = table.get(block);
  if (!value) { value = describe(block, properties); table.set(block, value); }
  return value;
}

const palette = (biome?: string) => minecraftAssets.biomes[biome ?? "minecraft:plains"] ?? minecraftAssets.biomes["minecraft:plains"];
const NETHER_CAP = 120;

/**
 * Render a `size`×`size` area whose first chunk is (0, 0). Chunks at -1 and `size / 16`
 * may be supplied as neighbours: they feed occlusion and biome blending at the edges.
 */
export function renderSurface(chunks: readonly SurfaceChunk[], size: number, nether = false) {
  const pixels = new Uint8Array(size * size * 4);
  const heights = new Int16Array(size * size).fill(-32768);
  const span = size / 16 + 2;
  const grid: ((BlockLayer | undefined)[] | undefined)[] = new Array(span * span);
  const tops = new Int32Array(span * span).fill(-1 << 30);
  const bottoms = new Int32Array(span * span);
  for (const chunk of chunks) {
    if (chunk.x < -1 || chunk.z < -1 || chunk.x > span - 2 || chunk.z > span - 2) continue;
    const sections: (BlockLayer | undefined)[] = new Array(256);
    let top = -1 << 30, bottom = 1 << 30;
    for (const layer of chunk.layers) {
      if (layer.y < -128 || layer.y > 127) continue;
      sections[layer.y + 128] = layer;
      if (layer.empty) continue;
      top = Math.max(top, layer.y * 16 + 15); bottom = Math.min(bottom, layer.y * 16);
    }
    const slot = (chunk.z + 1) * span + chunk.x + 1;
    grid[slot] = sections;
    tops[slot] = nether ? Math.min(NETHER_CAP, top) : top;
    bottoms[slot] = bottom;
  }
  const blend = biomeBlend(chunks, size);
  const shadeTop = nether ? 0.9 : 1, shadeBottom = nether ? 0.9 : 0.5;
  const failed = new Uint8Array(span * span);

  // A cell lookup returns the block's description and leaves the rest in these
  // scratch variables, which keeps the hot loop free of allocations.
  let cellLayer: BlockLayer | undefined, cellIndex = 0, cellFluid = false;
  const cell = (x: number, y: number, z: number): Info => {
    cellLayer = undefined; cellFluid = false;
    if (x < -16 || z < -16 || x >= size + 16 || z >= size + 16) return AIR;
    const slot = ((z >> 4) + 1) * span + (x >> 4) + 1;
    if (y > tops[slot]) return AIR;
    const layer = grid[slot]?.[(y >> 4) + 128];
    if (!layer || layer.empty) return AIR;
    const index = (y & 15) * 256 + (z & 15) * 16 + (x & 15);
    let name: string, properties: Readonly<Record<string, string>> | undefined;
    try {
      name = layer.block(index); properties = layer.properties?.(index);
      cellFluid = !!(layer.fluid?.(index) ?? blockFluid(name, properties));
    } catch (error) {
      // Packed data is decoded lazily; a damaged section blanks only its own chunk.
      if (!(error instanceof Error) || error.message !== "MC_MAP_CORRUPT") throw error;
      failed[slot] = 1; cellFluid = false;
      return AIR;
    }
    cellLayer = layer; cellIndex = index;
    return info(name, properties);
  };

  // The default Nether view removes the roof down to the first empty cell, as the
  // mesher does; the removed cells also stop darkening their neighbours.
  const OPEN_STRIDE = size + 2;
  const opens = nether ? new Int32Array(OPEN_STRIDE * OPEN_STRIDE).fill(-1 << 30) : undefined;
  const openKnown = nether ? new Uint8Array(OPEN_STRIDE * OPEN_STRIDE) : undefined;
  const openY = (x: number, z: number) => {
    if (!opens) return 1 << 30;
    const slot = (z + 1) * OPEN_STRIDE + x + 1;
    if (openKnown![slot]) return opens[slot];
    const chunk = ((z >> 4) + 1) * span + (x >> 4) + 1;
    let open = -1 << 30;
    // Start at the cap: a chunk whose data ends below it is open from the top.
    for (let y = NETHER_CAP; y >= bottoms[chunk]; y--) {
      const block = cell(x, y, z);
      if (block === AIR && !cellFluid) { open = y; break; }
    }
    openKnown![slot] = 1; opens[slot] = open;
    return open;
  };
  const occludes = (x: number, y: number, z: number) => y <= openY(x, z) && cell(x, y, z).occludesAo;

  const tintOf = (block: Info, x: number, y: number, z: number, biome?: string) => {
    if (!block.tinted) return 0xffffff;
    if (block.biomeTint === undefined) return blockTintColor(block.name, palette(biome));
    // Vertex tints average the eight block centers around each corner, and the face
    // interpolates its four corners: a [1, 2, 1]² kernel over the blended field.
    let r = 0, g = 0, b = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const weight = (dx ? 1 : 2) * (dz ? 1 : 2);
      for (let dy = -1; dy <= 0; dy++) {
        const color = blend(x + dx, y + dy, z + dz, block.biomeTint);
        r += (color >> 16) * weight; g += ((color >> 8) & 255) * weight; b += (color & 255) * weight;
      }
    }
    return ((Math.round(r / 32) << 16) | (Math.round(g / 32) << 8) | Math.round(b / 32));
  };

  let red = 0, green = 0, blue = 0, transmit = 1, first = -32768;
  const face = (color: number, tint: number, alpha: number, shade: number, y: number) => {
    if (alpha <= 0) return;
    if (first === -32768) first = y;
    const weight = transmit * alpha * shade / 255;
    red += (color >> 16) * ((tint >> 16) & 255) * weight;
    green += ((color >> 8) & 255) * ((tint >> 8) & 255) * weight;
    blue += (color & 255) * (tint & 255) * weight;
    transmit *= 1 - alpha;
  };
  const water = info("minecraft:water");

  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    red = green = blue = 0; transmit = 1; first = -32768;
    const chunk = ((z >> 4) + 1) * span + (x >> 4) + 1;
    const start = Math.min(tops[chunk], openY(x, z));
    let above: Info = AIR, aboveFluid = false, waterTint = 0xffffff;
    // One step past the data: like the mesher's padding, the empty cell below the
    // lowest section still exposes the bottom faces of translucent blocks.
    for (let y = start; y >= bottoms[chunk] - 1 && transmit > 1 / 512; y--) {
      let block = cell(x, y, z);
      const layer = cellLayer, index = cellIndex, fluid = cellFluid;
      if (block.waterBody) block = AIR;
      const biome = () => layer?.biome?.(index);
      // Faces on the plane between the cell above and this one, nearest first.
      if (above.translucent && !(block.solid && (block.slot === above.slot || block.opaque))) {
        face(above.color, tintOf(above, x, y + 1, z), above.alpha, above.emissive ? 1 : shadeBottom, y + 1);
      }
      if (aboveFluid && !fluid && !block.opaque) face(water.color, waterTint, water.alpha, shadeBottom, y + 1);
      if (fluid && !aboveFluid && !block.opaque) {
        waterTint = blockTintColor("water", palette(biome()));
        face(water.color, waterTint, water.alpha, shadeTop, y);
      }
      if (block.shape === Shape.Cube && !(above.solid && (above.slot === block.slot || above.opaque))) {
        let shade = shadeTop;
        if (block.emissive) shade = 1;
        else if (!block.translucent) {
          let occlusion = 0;
          for (let corner = 0; corner < 4; corner++) {
            const a = corner === 1 || corner === 2 ? 1 : -1, b = corner >= 2 ? 1 : -1;
            const sideA = occludes(x + a, y + 1, z), sideB = occludes(x, y + 1, z + b);
            occlusion += sideA && sideB ? 3 : +sideA + +sideB + +occludes(x + a, y + 1, z + b);
          }
          shade *= 1 - occlusion * 0.05;
        }
        face(block.color, tintOf(block, x, y + 1, z, biome()), block.alpha, shade, y);
      } else if (block.shape === Shape.Ground || block.shape === Shape.Model) {
        face(block.color, tintOf(block, x, y, z, biome()), block.alpha, block.emissive ? 1 : shadeTop, y);
      }
      above = block; aboveFluid = fluid;
    }
    if (first === -32768) continue;
    const column = z * size + x, coverage = 1 - transmit;
    heights[column] = first;
    if (coverage < 1 / 255) continue;
    pixels[column * 4] = Math.min(255, Math.round(red / coverage));
    pixels[column * 4 + 1] = Math.min(255, Math.round(green / coverage));
    pixels[column * 4 + 2] = Math.min(255, Math.round(blue / coverage));
    pixels[column * 4 + 3] = Math.round(coverage * 255);
  }
  /** Chunk coordinates whose data turned out to be damaged; their columns stay empty. */
  const corrupt: { x: number; z: number }[] = [];
  for (let slot = 0; slot < failed.length; slot++) {
    if (!failed[slot]) continue;
    const chunkX = slot % span - 1, chunkZ = Math.floor(slot / span) - 1;
    corrupt.push({ x: chunkX, z: chunkZ });
    if (chunkX < 0 || chunkZ < 0 || chunkX * 16 >= size || chunkZ * 16 >= size) continue;
    for (let z = chunkZ * 16; z < chunkZ * 16 + 16; z++) {
      pixels.fill(0, (z * size + chunkX * 16) * 4, (z * size + chunkX * 16 + 16) * 4);
      heights.fill(-32768, z * size + chunkX * 16, z * size + chunkX * 16 + 16);
    }
  }
  return { pixels, heights, corrupt };
}
