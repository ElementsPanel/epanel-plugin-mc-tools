import { MAP_MAX_Y, MAP_MIN_Y, MAP_SCENE_MAX_QUADS, MAP_SCENE_SIZE, type MapSceneTile } from "../../../shared/map";
import { SCENE_GROUND, SCENE_KIND_COUNT, SceneKind, sceneTextures } from "../../../shared/scene";

function bytes(value: string, maximum: number) {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4) throw new Error("MC_MAP_CORRUPT");
  try { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
  catch { throw new Error("MC_MAP_CORRUPT"); }
}

/** Validate the bounded wire format before allocating GPU buffers. */
export function decodeScene(tile: MapSceneTile) {
  if (tile?.version !== 1 || !Number.isInteger(tile.chunks) || tile.chunks < 0 || tile.chunks > 4 || !Number.isInteger(tile.warnings) || tile.warnings < 0) throw new Error("MC_MAP_CORRUPT");
  const raw = bytes(tile.quads, MAP_SCENE_MAX_QUADS * 16), elevation = bytes(tile.heights, MAP_SCENE_SIZE ** 2 * 2);
  if (raw.length % 16 || raw.length > MAP_SCENE_MAX_QUADS * 16 || elevation.length !== MAP_SCENE_SIZE ** 2 * 2) throw new Error("MC_MAP_CORRUPT");
  const data = new DataView(raw.buffer), heightsData = new DataView(elevation.buffer);
  const heights = Int16Array.from({ length: MAP_SCENE_SIZE ** 2 }, (_, index) => heightsData.getInt16(index * 2, true));
  if (heights.some(value => value !== -32768 && (value < MAP_MIN_Y || value > MAP_MAX_Y))) throw new Error("MC_MAP_CORRUPT");
  const groups: number[][] = Array.from({ length: SCENE_KIND_COUNT }, () => []);
  let animated = false;
  for (let offset = 0; offset < raw.length; offset += 16) {
    const x = raw[offset], z = raw[offset + 1], y = data.getInt16(offset + 2, true);
    const w = data.getUint16(offset + 4, true), h = data.getUint16(offset + 6, true);
    const face = raw[offset + 8], flags = raw[offset + 9], kind = flags & 3, texture = data.getUint16(offset + 10, true), axis = Math.floor(face / 2);
    if (face > 7 || flags > 31 || !sceneTextures.has(texture) || x > MAP_SCENE_SIZE || z > MAP_SCENE_SIZE || y < MAP_MIN_Y || y > MAP_MAX_Y + 1 || !w || !h) throw new Error("MC_MAP_CORRUPT");
    if ((flags & SCENE_GROUND) && (face !== 2 || kind !== SceneKind.Plant || w !== 1 || h !== 1 || y > MAP_MAX_Y)) throw new Error("MC_MAP_CORRUPT");
    const valid = face >= 6 ? kind === SceneKind.Plant && w === 1 && h === 1 && x < MAP_SCENE_SIZE && z < MAP_SCENE_SIZE && y <= MAP_MAX_Y
      : axis === 0 ? y + w <= MAP_MAX_Y + 1 && z + h <= MAP_SCENE_SIZE
      : axis === 1 ? z + w <= MAP_SCENE_SIZE && x + h <= MAP_SCENE_SIZE
      : x + w <= MAP_SCENE_SIZE && y + h <= MAP_MAX_Y + 1;
    if (!valid) throw new Error("MC_MAP_CORRUPT");
    groups[kind].push(offset);
    animated ||= sceneTextures.get(texture)![2] > 1;
  }
  const meshes = groups.flatMap((offsets, kind) => {
    if (!offsets.length) return [];
    const origins = new Float32Array(offsets.length * 3), sizes = new Float32Array(offsets.length * 2);
    const colors = new Uint8Array(offsets.length * 3), sprites = new Uint16Array(offsets.length);
    const faces = new Uint8Array(offsets.length), flags = new Uint8Array(offsets.length), occlusion = new Uint8Array(offsets.length);
    let minY = Infinity, maxY = -Infinity;
    offsets.forEach((offset, quad) => {
      const x = raw[offset], z = raw[offset + 1], y = data.getInt16(offset + 2, true);
      const w = data.getUint16(offset + 4, true), h = data.getUint16(offset + 6, true), face = raw[offset + 8];
      origins.set([x, y, z], quad * 3); sizes.set([w, h], quad * 2);
      colors.set(raw.subarray(offset + 12, offset + 15), quad * 3);
      sprites[quad] = data.getUint16(offset + 10, true); faces[quad] = face;
      flags[quad] = raw[offset + 9]; occlusion[quad] = raw[offset + 15];
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y + ((raw[offset + 9] & SCENE_GROUND) ? 1 / 64 : face < 2 ? w : face >= 4 ? h : 0));
    });
    return [{ kind, origins, sizes, colors, sprites, faces, flags, occlusion, minY, maxY, count: offsets.length }];
  });
  return { meshes, heights, count: raw.length / 16, chunks: tile.chunks, warnings: tile.warnings, limited: !!tile.limited, animated };
}
