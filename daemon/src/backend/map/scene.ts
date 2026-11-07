import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { MAP_MAX_Y, MAP_MIN_Y, MAP_SCENE_MAX_QUADS, MAP_SCENE_SIZE, type MapSceneTile } from "../../../../shared/map";
import { SceneKind, SCENE_EMISSIVE, SCENE_GRASS_OVERLAY, SCENE_GROUND, SCENE_MODEL } from "../../../../shared/scene";
import type { BlockLayer } from "./chunk";
import { isAir } from "./colors";
import { blockFluid, blockMaterial, blockStateKey, type Material } from "./materials";
import { biomeBlend } from "./biome-blend";
import { fireElements } from "../../../../shared/fire";

export interface SceneChunk { x: number; z: number; layers: BlockLayer[] }
const CORNERS: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
/** Blocks the fluid pass owns; a regex per voxel was measurable on its own. */
const waterBody = new Set(["minecraft:water", "water", "minecraft:flowing_water", "flowing_water", "minecraft:bubble_column", "bubble_column"]);
const SIZE = MAP_SCENE_SIZE, AREA = SIZE * SIZE;
const STRIDE = SIZE + 2, PADDED_AREA = STRIDE * STRIDE;
/** Cull hidden voxel faces, then merge coplanar faces of the same block material. */
const deflate = promisify(gzip);

export async function meshScene(chunks: SceneChunk[], nether = false, disposed = () => false, neighbors: SceneChunk[] = [], compress = false): Promise<Pick<MapSceneTile, "version" | "quads" | "tints" | "heights" | "gzip" | "payload" | "limited">> {
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
  // Resolving a block state costs a few lookups and string operations; doing it per
  // voxel dominated the mesh. Properties objects come straight from the palette, so
  // their identity is a safe cache key.
  const plainStates = new Map<string, { source: Material; state: string; tinted: boolean }>();
  const propertyStates = new WeakMap<object, Map<string, { source: Material; state: string; tinted: boolean }>>();
  const blend = biomeBlend([...chunks, ...neighbors]);
  const cornerTints = new Map<number, number[]>();
  // Vertex tint is memoised per padded position and biome slot; the numeric key keeps
  // the lookup allocation-free on the hottest path of the mesh.
  const cornerKey = (x: number, y: number, z: number, tint: number) => (((y + 1) * STRIDE + (z + 1)) * STRIDE + (x + 1)) * 4 + tint;
  const cornerTint = (x: number, y: number, z: number, source: Material) => {
    if (source.biomeTint === undefined) return [source.color >> 16, (source.color >> 8) & 255, source.color & 255];
    const key = cornerKey(x, y, z, source.biomeTint);
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
  const tintScratch = new Uint8Array(12);
  const tintFace = (x: number, y: number, z: number, w: number, h: number, face: number, source: Material) => {
    const side = face < 6 ? face : 4;
    const tinted = (source.model.tint | source.model.overlay) & (1 << side);
    for (let corner = 0; corner < 4; corner++) {
      const u = CORNERS[corner][0], v = CORNERS[corner][1];
      let px: number, py: number, pz: number;
      if (face < 2) { px = x; py = y + u * w; pz = z + v * h; }
      else if (face < 4) { px = x + v * h; py = y; pz = z + u * w; }
      else if (face < 6) { px = x + u * w; py = y + v * h; pz = z; }
      else { px = x + (face === 7 ? 1 - u : u); py = y + v; pz = z + u; }
      if (tinted) {
        const rgb = cornerTint(px, py, pz, source);
        tintScratch[corner * 3] = rgb[0]; tintScratch[corner * 3 + 1] = rgb[1]; tintScratch[corner * 3 + 2] = rgb[2];
      } else tintScratch[corner * 3] = tintScratch[corner * 3 + 1] = tintScratch[corner * 3 + 2] = 255;
    }
    return tintScratch;
  };
  const stateOf = (name: string, properties?: Readonly<Record<string, string>>) => {
    let table = plainStates;
    if (properties) {
      table = propertyStates.get(properties)!;
      if (!table) { table = new Map(); propertyStates.set(properties, table); }
    }
    let cached = table.get(name);
    if (!cached) {
      const source = blockMaterial(name, undefined, properties);
      cached = {
        source, state: blockStateKey(name, properties),
        tinted: source.color !== 0xffffff && !!(source.model.tint || source.model.overlay)
      };
      table.set(name, cached);
    }
    return cached;
  };
  const palette = (name: string, x: number, y: number, z: number, biome?: string, properties?: Readonly<Record<string, string>>) => {
    const { source, state, tinted } = stateOf(name, properties);
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
          if (!waterBody.has(name)) voxels[position] = palette(name, chunk.x * 16 + x, worldY, chunk.z * 16 + z, biome, properties);
        }
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  // Materials are final here; the scan below runs hundreds of thousands of times, so
  // kind checks and model costs move into flat arrays.
  const OPAQUE = SceneKind.Opaque, PLANT = SceneKind.Plant, CUTOUT = SceneKind.Cutout, TRANSLUCENT = SceneKind.Translucent;
  const total = materials.length;
  const solidOf = new Uint16Array(total), opaqueOf = new Uint8Array(total), occludesAoOf = new Uint8Array(total);
  const translucentOf = new Uint8Array(total), emissiveOf = new Uint8Array(total), nameOf = new Uint16Array(total);
  const costOf = new Uint32Array(total);
  const nameSlots = new Map<string, number>();
  for (let id = 1; id < total; id++) {
    const material = materials[id];
    solidOf[id] = material.kind === PLANT ? 0 : id;
    opaqueOf[id] = material.kind === OPAQUE ? 1 : 0;
    occludesAoOf[id] = material.kind === OPAQUE || material.kind === CUTOUT ? 1 : 0;
    translucentOf[id] = material.kind === TRANSLUCENT ? 1 : 0;
    emissiveOf[id] = material.emissive ? 1 : 0;
    let slot = nameSlots.get(material.name);
    if (slot === undefined) { slot = nameSlots.size; nameSlots.set(material.name, slot); }
    nameOf[id] = slot;
    const elements = material.fire === undefined ? material.model.elements : fireElements(material.model, material.fire);
    costOf[id] = elements?.reduce((sum, element) => sum + Object.keys(element.faces).length, 0) ?? 1;
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
    const cost = costOf[id];
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
  const occludes = (neighbor: number, current: number) =>
    neighbor !== 0 && (neighbor === current || nameOf[neighbor] === nameOf[current] || opaqueOf[neighbor] === 1);
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
          const solidA = solidOf[cell(position[0], position[1], position[2])];
          const a = fluidPass ? fluidCell(position[0], position[1], position[2]) : solidA;
          position[axis] = plane;
          const solidB = solidOf[cell(position[0], position[1], position[2])];
          const b = fluidPass ? fluidCell(position[0], position[1], position[2]) : solidB;
          const owned = sign ? plane < dimensions[axis] : plane > 0;
          const solidCurrent = sign ? solidB : solidA;
          const current = owned && !(fluidPass && solidCurrent && opaqueOf[solidCurrent] === 1) ? sign ? b : a : 0;
          const neighbor = (sign ? a : b) || (fluidPass ? sign ? solidA : solidB : 0);
          let ao = 0;
          if (current && !occludes(neighbor, current) && !translucentOf[current] && !emissiveOf[current]) {
            const point = [...position]; point[axis] = sign ? plane - 1 : plane;
            const solid = (a: number, b: number) => {
              point[u] = i + a; point[v] = j + b;
              return occludesAoOf[cell(point[0], point[1], point[2])];
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
            // Any corner colour deviating from the first one forces a per-corner quad.
            for (let corner = 1; corner < 4 && !gradient; corner++) {
              if (colors[corner * 3] !== colors[0] || colors[corner * 3 + 1] !== colors[1] || colors[corner * 3 + 2] !== colors[2]) gradient = 1 << 24;
            }
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
      if (!id || materials[id].kind !== PLANT) continue;
      if (materials[id].model.shape === "ground" || materials[id].model.shape === "model") quad(x, y, z, 1, 1, 2, id);
      else { quad(x, y, z, 1, 1, 6, id); quad(x, y, z, 1, 1, 7, id); }
    }
    if (y % 16 === 0) {
      if (disposed()) throw new Error("MC_MAP_UNAVAILABLE");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  const quadBytes = bytes.subarray(0, count * 16), tintBytes = tints.subarray(0, count * 12);
  if (!compress) {
    return { version: 1, quads: quadBytes.toString("base64"), tints: tintBytes.toString("base64"), heights: heights.toString("base64"), limited };
  }
  // Raw geometry compresses about ten times, which matters far more than the CPU cost.
  const header = Buffer.alloc(12);
  header.writeUInt32LE(quadBytes.length, 0); header.writeUInt32LE(tintBytes.length, 4); header.writeUInt32LE(heights.length, 8);
  const payload = await deflate(Buffer.concat([header, quadBytes, tintBytes, heights]), { level: 6 });
  return { version: 1, gzip: true, payload: payload.toString("base64"), limited };
}
