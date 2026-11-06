import { MAP_MAX_Y, MAP_MIN_Y, MAP_SCENE_MAX_QUADS, MAP_SCENE_SIZE, type MapSceneTile } from "../../../../shared/map";
import { SceneKind, SCENE_EMISSIVE, SCENE_GRASS_OVERLAY, SCENE_GROUND, SCENE_MODEL } from "../../../../shared/scene";
import type { BlockLayer } from "./chunk";
import { isAir } from "./colors";
import { blockFluid, blockMaterial, blockStateKey, type Material } from "./materials";
import { biomeBlend } from "./biome-blend";
import { fireElements } from "../../../../shared/fire";

export interface SceneChunk { x: number; z: number; layers: BlockLayer[] }
const SIZE = MAP_SCENE_SIZE, AREA = SIZE * SIZE;
const STRIDE = SIZE + 2, PADDED_AREA = STRIDE * STRIDE;
/** Cull hidden voxel faces, then merge coplanar faces of the same block material. */
export async function meshScene(chunks: SceneChunk[], nether = false, disposed = () => false, neighbors: SceneChunk[] = []): Promise<Pick<MapSceneTile, "version" | "quads" | "tints" | "heights" | "limited">> {
  const cap = nether ? 120 : MAP_MAX_Y;
  const layers = chunks.flatMap(chunk => chunk.layers).filter(layer => !layer.empty && layer.y * 16 <= cap);
  const minY = layers.length ? Math.max(MAP_MIN_Y, Math.min(...layers.map(layer => layer.y * 16))) : 0;
  const maxY = layers.length ? Math.min(cap, Math.max(...layers.map(layer => layer.y * 16 + 15))) : -1;
  const height = Math.max(0, maxY - minY + 1);
  // Keep a one-block halo for face culling and AO, but emit only the owned tile.
  const voxels = new Uint16Array(PADDED_AREA * (height + 2));
  let fluids: Uint16Array | undefined;
  const indexOf = (x: number, y: number, z: number) => (y + 1) * PADDED_AREA + (z + 1) * STRIDE + x + 1;
  const materials: Material[] = [{ name: "air", color: 0xffffff, model: blockMaterial("air").model, kind: SceneKind.Opaque, emissive: false }];
  const names = new Map<string, number>();
  const base = new Map<string, Material>();
  const blend = biomeBlend([...chunks, ...neighbors]);
  const cornerTints = new Map<string, number[]>();
  const cornerTint = (x: number, y: number, z: number, source: Material) => {
    if (source.biomeTint === undefined) return [source.color >> 16, (source.color >> 8) & 255, source.color & 255];
    const key = [x, y, z, source.biomeTint].join(":");
    let rgb = cornerTints.get(key);
    if (!rgb) {
      rgb = [0, 0, 0];
      // The blended field lives at block centers. Shared vertices sample the same
      // eight centers, so adjacent blocks agree exactly at their common edge.
      for (const dx of [-1, 0]) for (const dy of [-1, 0]) for (const dz of [-1, 0]) {
        const color = blend(x + dx, y + dy, z + dz, source.biomeTint);
        rgb[0] += color >> 16; rgb[1] += (color >> 8) & 255; rgb[2] += color & 255;
      }
      rgb = rgb.map(value => Math.round(value / 8)); cornerTints.set(key, rgb);
    }
    return rgb;
  };
  const tintFace = (x: number, y: number, z: number, w: number, h: number, face: number, source: Material) => {
    const output: number[] = [], side = face < 6 ? face : 4;
    const tinted = (source.model.tint | source.model.overlay) & (1 << side);
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const point = face < 2 ? [x, y + u * w, z + v * h] : face < 4 ? [x + v * h, y, z + u * w]
        : face < 6 ? [x + u * w, y + v * h, z] : [x + (face === 7 ? 1 - u : u), y + v, z + u];
      output.push(...(tinted ? cornerTint(point[0], point[1], point[2], source) : [255, 255, 255]));
    }
    return output;
  };
  const palette = (name: string, x: number, y: number, z: number, biome?: string, properties?: Readonly<Record<string, string>>) => {
    const state = blockStateKey(name, properties);
    let source = base.get(state);
    if (!source) { source = blockMaterial(name, undefined, properties); base.set(state, source); }
    const tinted = source.color !== 0xffffff && !!(source.model.tint || source.model.overlay);
    const color = tinted && source.biomeTint !== undefined ? blend(x, y, z, source.biomeTint, biome) : undefined;
    const key = tinted ? state + "@" + (color ?? biome ?? "minecraft:plains") : state;
    let id = names.get(key);
    if (id !== undefined) return id;
    if (isAir(name)) id = 0;
    else {
      if (materials.length >= 65536) throw new Error("MC_MAP_CORRUPT");
      id = materials.length;
      const material = tinted && biome ? blockMaterial(name, biome, properties) : source;
      materials.push(color !== undefined ? { ...material, color } : material);
    }
    names.set(key, id);
    return id;
  };
  for (const chunk of [...chunks, ...neighbors]) {
    const firstX = Math.max(0, -1 - chunk.x * 16), lastX = Math.min(16, SIZE + 1 - chunk.x * 16);
    const firstZ = Math.max(0, -1 - chunk.z * 16), lastZ = Math.min(16, SIZE + 1 - chunk.z * 16);
    for (const layer of chunk.layers) {
      if (layer.empty) continue;
      if (disposed()) throw new Error("MC_MAP_UNAVAILABLE");
      for (let y = 0; y < 16; y++) {
        const worldY = layer.y * 16 + y;
        if (worldY < minY - 1 || worldY > maxY + 1 || worldY > cap) continue;
        for (let z = firstZ; z < lastZ; z++) for (let x = firstX; x < lastX; x++) {
          const index = y * 256 + z * 16 + x;
          const name = layer.block(index), biome = layer.biome?.(index), properties = layer.properties?.(index);
          const position = indexOf(chunk.x * 16 + x, worldY - minY, chunk.z * 16 + z);
          const fluid = layer.fluid?.(index) ?? blockFluid(name, properties);
          if (fluid) {
            fluids ??= new Uint16Array(voxels.length);
            fluids[position] = palette(fluid, chunk.x * 16 + x, worldY, chunk.z * 16 + z, biome);
          }
          if (!/^(?:minecraft:)?(?:flowing_water|water|bubble_column)$/.test(name)) voxels[position] = palette(name, chunk.x * 16 + x, worldY, chunk.z * 16 + z, biome, properties);
        }
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  const heights = Buffer.alloc(AREA * 2);
  for (let z = -1; z <= SIZE; z++) for (let x = -1; x <= SIZE; x++) {
    const owned = x >= 0 && x < SIZE && z >= 0 && z < SIZE, column = z * SIZE + x;
    if (owned) heights.writeInt16LE(-32768, column * 2);
    let open = !nether;
    for (let y = height - 1; y >= 0; y--) {
      const index = indexOf(x, y, z), id = voxels[index] || fluids?.[index];
      // The default Nether view opens its ceiling, as the 2D surface view does.
      if (!open) { if (!id) open = true; else { voxels[index] = 0; if (fluids) fluids[index] = 0; } continue; }
      if (id) { if (owned) heights.writeInt16LE(y + minY, column * 2); break; }
    }
  }

  const bytes = Buffer.alloc(MAP_SCENE_MAX_QUADS * 16);
  const tints = Buffer.alloc(MAP_SCENE_MAX_QUADS * 12);
  let count = 0, renderedCount = 0, limited = false;
  const quad = (x: number, y: number, z: number, width: number, tall: number, face: number, id: number, ao = 0) => {
    const source = materials[id];
    const elements = source.fire === undefined ? source.model.elements : fireElements(source.model, source.fire);
    const cost = elements?.reduce((sum, element) => sum + Object.keys(element.faces).length, 0) ?? 1;
    if (renderedCount + cost > MAP_SCENE_MAX_QUADS) { limited = true; return; }
    renderedCount += cost;
    const side = face < 6 ? face : 4, overlay = !!(source.model.overlay & (1 << side));
    const color = (source.model.tint & (1 << side)) || overlay ? source.color : 0xffffff;
    const texture = source.model.faces[side];
    const offset = count++ * 16;
    tints.set(tintFace(x, y + minY, z, width, tall, face, source), (count - 1) * 12);
    bytes[offset] = x; bytes[offset + 1] = z; bytes.writeInt16LE(y + minY, offset + 2);
    bytes.writeUInt16LE(width, offset + 4); bytes.writeUInt16LE(tall, offset + 6);
    bytes[offset + 8] = face; bytes[offset + 9] = source.kind | (overlay ? SCENE_GRASS_OVERLAY : 0) | (source.emissive ? SCENE_EMISSIVE : 0) | (source.model.shape === "ground" ? SCENE_GROUND : 0)
      | (source.model.shape === "model" ? SCENE_MODEL | ((source.model.rotation ?? 0) / 90 << 6) : 0);
    bytes.writeUInt16LE(texture, offset + 10);
    bytes[offset + 12] = color >> 16; bytes[offset + 13] = color >> 8; bytes[offset + 14] = color; bytes[offset + 15] = source.fire ?? (source.emissive ? 0 : ao);
  };
  const cell = (x: number, y: number, z: number) => x < -1 || x > SIZE || z < -1 || z > SIZE || y < -1 || y > height ? 0 : voxels[indexOf(x, y, z)];
  const fluidCell = (x: number, y: number, z: number) => x < -1 || x > SIZE || z < -1 || z > SIZE || y < -1 || y > height ? 0 : fluids?.[indexOf(x, y, z)] || 0;
  const cube = (id: number) => id && materials[id].kind !== SceneKind.Plant ? id : 0;
  const occludes = (neighbor: number, current: number) => {
    if (!neighbor) return false;
    if (neighbor === current || materials[neighbor].name === materials[current].name) return true;
    return materials[neighbor].kind === SceneKind.Opaque;
  };
  const dimensions = [SIZE, height, SIZE];
  // The cyclic U/V axes give positive-facing winding; negative faces reverse it in the viewer.
  for (const fluidPass of fluids ? [false, true] : [false]) for (let axis = 0; axis < 3 && !limited; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const width = dimensions[u], tall = dimensions[v];
    const mask = new Uint32Array(width * tall), position = [0, 0, 0];
    for (let plane = 0; plane <= dimensions[axis] && !limited; plane++) {
      if (disposed()) throw new Error("MC_MAP_UNAVAILABLE");
      for (let sign = 0; sign < 2 && !limited; sign++) {
        for (let j = 0; j < tall; j++) for (let i = 0; i < width; i++) {
          position[u] = i; position[v] = j; position[axis] = plane - 1;
          const solidA = cube(cell(position[0], position[1], position[2]));
          const a = fluidPass ? fluidCell(position[0], position[1], position[2]) : solidA;
          position[axis] = plane;
          const solidB = cube(cell(position[0], position[1], position[2]));
          const b = fluidPass ? fluidCell(position[0], position[1], position[2]) : solidB;
          const owned = sign ? plane < dimensions[axis] : plane > 0;
          const solidCurrent = sign ? solidB : solidA;
          const current = owned && !(fluidPass && solidCurrent && materials[solidCurrent].kind === SceneKind.Opaque) ? sign ? b : a : 0;
          const neighbor = (sign ? a : b) || (fluidPass ? sign ? solidA : solidB : 0);
          let ao = 0;
          if (current && !occludes(neighbor, current) && materials[current].kind !== SceneKind.Translucent && !materials[current].emissive) {
            const point = [...position]; point[axis] = sign ? plane - 1 : plane;
            const solid = (a: number, b: number) => {
              point[u] = i + a; point[v] = j + b;
              const id = cell(point[0], point[1], point[2]);
              return id && (materials[id].kind === SceneKind.Opaque || materials[id].kind === SceneKind.Cutout) ? 1 : 0;
            };
            for (let corner = 0; corner < 4; corner++) {
              const a = corner === 1 || corner === 2 ? 1 : -1, b = corner >= 2 ? 1 : -1;
              const sideA = solid(a, 0), sideB = solid(0, b), diagonal = solid(a, b);
              ao |= (sideA && sideB ? 3 : sideA + sideB + diagonal) << (corner * 2);
            }
          }
          let gradient = 0;
          if (current && !occludes(neighbor, current)) {
            position[axis] = plane;
            const colors = tintFace(position[0], position[1] + minY, position[2], 1, 1, axis * 2 + sign, materials[current]);
            if (colors.some((value, i) => value !== colors[i % 3])) gradient = 1 << 24;
          }
          mask[j * width + i] = current && !occludes(neighbor, current) ? current | (ao << 16) | gradient : 0;
        }
        for (let j = 0; j < tall && !limited; j++) for (let i = 0; i < width && !limited;) {
          const value = mask[j * width + i];
          if (!value) { i++; continue; }
          const id = value & 65535, ao = (value >>> 16) & 255, corners = [ao & 3, (ao >> 2) & 3, (ao >> 4) & 3, (ao >> 6) & 3];
          let w = 1, h = 1;
          if (!(value & (1 << 24)) && corners[0] === corners[1] && corners[2] === corners[3]) while (i + w < width && mask[j * width + i + w] === value) w++;
          outer: while (!(value & (1 << 24)) && j + h < tall && corners[0] === corners[3] && corners[1] === corners[2]) {
            for (let k = 0; k < w; k++) if (mask[(j + h) * width + i + k] !== value) break outer;
            h++;
          }
          position[axis] = plane; position[u] = i; position[v] = j;
          quad(position[0], position[1], position[2], w, h, axis * 2 + sign, id, ao);
          for (let row = 0; row < h; row++) mask.fill(0, (j + row) * width + i, (j + row) * width + i + w);
          i += w;
        }
      }
      if (plane % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  for (let y = 0; y < height && !limited; y++) {
    for (let z = 0; z < SIZE && !limited; z++) for (let x = 0; x < SIZE && !limited; x++) {
      const id = cell(x, y, z);
      if (!id || materials[id].kind !== SceneKind.Plant) continue;
      if (materials[id].model.shape === "ground" || materials[id].model.shape === "model") quad(x, y, z, 1, 1, 2, id);
      else { quad(x, y, z, 1, 1, 6, id); quad(x, y, z, 1, 1, 7, id); }
    }
    if (y % 16 === 0) {
      if (disposed()) throw new Error("MC_MAP_UNAVAILABLE");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  return { version: 1, quads: bytes.subarray(0, count * 16).toString("base64"), tints: tints.subarray(0, count * 12).toString("base64"), heights: heights.toString("base64"), limited };
}
