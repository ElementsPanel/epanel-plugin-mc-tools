import { MAP_MAX_Y, MAP_MIN_Y, MAP_SCENE_MAX_QUADS, MAP_SCENE_SIZE, type MapSceneTile } from "../../../shared/map";
import { SCENE_AXES, SCENE_EMISSIVE, SCENE_GROUND, SCENE_MODEL, SCENE_KIND_COUNT, SceneKind, sceneTextures } from "../../../shared/scene";
import { modelFaces, sceneModels } from "./model-geometry";

const flowerTextures = new Map([...sceneTextures].flatMap(([sprite, [name]]) =>
  /^block\/(pink_petals|wildflowers)(_stem)?$/.test(name) ? [[sprite, !name.endsWith("_stem")] as const] : []));

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
  // Older cached scenes interleaved RGB with two light bytes. Reuse only their
  // colors; lighting is no longer read or uploaded to the renderer.
  const tintStride = tile.tints === undefined ? 5 : 3;
  const tintData = tile.tints ?? tile.shading;
  const tints = tintData === undefined ? undefined : bytes(tintData, MAP_SCENE_MAX_QUADS * 4 * tintStride);
  if (tints && tints.length !== raw.length / 16 * 4 * tintStride) throw new Error("MC_MAP_CORRUPT");
  const data = new DataView(raw.buffer), heightsData = new DataView(elevation.buffer);
  const heights = Int16Array.from({ length: MAP_SCENE_SIZE ** 2 }, (_, index) => heightsData.getInt16(index * 2, true));
  if (heights.some(value => value !== -32768 && (value < MAP_MIN_Y || value > MAP_MAX_Y))) throw new Error("MC_MAP_CORRUPT");
  const groups: number[][] = Array.from({ length: SCENE_KIND_COUNT }, () => []);
  const legacyFire = new Map<number, number[]>();
  let animated = false;
  for (let offset = 0; offset < raw.length; offset += 16) {
    const x = raw[offset], z = raw[offset + 1], y = data.getInt16(offset + 2, true);
    const w = data.getUint16(offset + 4, true), h = data.getUint16(offset + 6, true);
    const face = raw[offset + 8], flags = raw[offset + 9], kind = flags & 3, texture = data.getUint16(offset + 10, true), axis = Math.floor(face / 2);
    if (face > 7 || flags > 31 && !(flags & SCENE_MODEL) || !sceneTextures.has(texture) || x > MAP_SCENE_SIZE || z > MAP_SCENE_SIZE || y < MAP_MIN_Y || y > MAP_MAX_Y + 1 || !w || !h) throw new Error("MC_MAP_CORRUPT");
    if ((flags & SCENE_MODEL) && (kind !== SceneKind.Plant || face !== 2 || w !== 1 || h !== 1 || !sceneModels.has(texture) || x >= MAP_SCENE_SIZE || z >= MAP_SCENE_SIZE || y > MAP_MAX_Y)) throw new Error("MC_MAP_CORRUPT");
    if ((flags & SCENE_MODEL) && sceneModels.get(texture)?.fire && raw[offset + 15] > 31) throw new Error("MC_MAP_CORRUPT");
    if ((flags & SCENE_GROUND) && (face !== 2 || kind !== SceneKind.Plant || w !== 1 || h !== 1 || y > MAP_MAX_Y)) throw new Error("MC_MAP_CORRUPT");
    const valid = face >= 6 ? kind === SceneKind.Plant && w === 1 && h === 1 && x < MAP_SCENE_SIZE && z < MAP_SCENE_SIZE && y <= MAP_MAX_Y
      : axis === 0 ? y + w <= MAP_MAX_Y + 1 && z + h <= MAP_SCENE_SIZE
      : axis === 1 ? z + w <= MAP_SCENE_SIZE && x + h <= MAP_SCENE_SIZE
      : x + w <= MAP_SCENE_SIZE && y + h <= MAP_MAX_Y + 1;
    if (!valid) throw new Error("MC_MAP_CORRUPT");
    if (kind === SceneKind.Cutout && sceneModels.get(texture)?.fire) {
      // Old cached scenes represented fire as cubes, sometimes merged together.
      // Replace their top faces with individual standing flames at block height.
      if (face !== 2) continue;
      if (y <= MAP_MIN_Y) throw new Error("MC_MAP_CORRUPT");
      legacyFire.set(offset, [w, h]);
      data.setInt16(offset + 2, y - 1, true);
      data.setUint16(offset + 4, 1, true); data.setUint16(offset + 6, 1, true);
      raw[offset + 9] = SceneKind.Plant | SCENE_MODEL | SCENE_EMISSIVE;
      raw[offset + 15] = 0;
      groups[SceneKind.Plant].push(offset);
    } else if (kind === SceneKind.Cutout && flowerTextures.has(texture)) {
      // Older daemons/cached scenes sent flowerbeds as cubes. Keep only their
      // top faces and lower them to the supporting surface before uploading.
      if (face !== 2 || !flowerTextures.get(texture)) continue;
      if (y <= MAP_MIN_Y) throw new Error("MC_MAP_CORRUPT");
      data.setInt16(offset + 2, y - 1, true);
      raw[offset + 9] = SceneKind.Plant | SCENE_GROUND;
      raw[offset + 15] = 0;
      groups[SceneKind.Plant].push(offset);
    } else groups[kind].push(offset);
    animated ||= sceneTextures.get(texture)![2] > 1;
  }
  let expanded = 0;
  const meshes = groups.flatMap((offsets, kind) => {
    if (!offsets.length) return [];
    const entries: { offset: number; model?: ReturnType<typeof modelFaces>[number] }[] = [];
    for (const offset of offsets) {
      const [w, h] = legacyFire.get(offset) ?? [1, 1];
      for (let dx = 0; dx < h; dx++) for (let dz = 0; dz < w; dz++) {
        const seed = (raw[offset] + dx) * 31 + (raw[offset + 1] + dz) * 17 + Math.abs(data.getInt16(offset + 2, true));
        const models = raw[offset + 9] & SCENE_MODEL
          ? modelFaces(data.getUint16(offset + 10, true), raw[offset + 9] >> 6, raw[offset + 15], seed) : [undefined];
        if (expanded + entries.length + models.length > MAP_SCENE_MAX_QUADS) throw new Error("MC_MAP_CORRUPT");
        for (const model of models) entries.push({ offset, model: model && legacyFire.has(offset)
          ? { ...model, origin: [model.origin[0] + dx, model.origin[1], model.origin[2] + dz] } : model });
      }
    }
    const count = entries.length;
    expanded += count;
    if (expanded > MAP_SCENE_MAX_QUADS) throw new Error("MC_MAP_CORRUPT");
    const origins = new Float32Array(count * 3), sizes = new Float32Array(count * 2);
    const colors = new Uint8Array(count * 3), sprites = new Uint16Array(count);
    const cornerColors = Array.from({ length: 4 }, () => new Uint8Array(count * 3));
    const uvU = new Float32Array(count * 3), uvV = new Float32Array(count * 3);
    const axes = entries.some(entry => entry.model?.axes) ? [new Float32Array(count * 3), new Float32Array(count * 3)] : undefined;
    const faces = new Uint8Array(count), flags = new Uint8Array(count), occlusion = new Uint8Array(count);
    let minY = Infinity, maxY = -Infinity;
    entries.forEach(({ offset, model }, quad) => {
      const x = raw[offset] + (model?.origin[0] ?? 0), z = raw[offset + 1] + (model?.origin[2] ?? 0), y = data.getInt16(offset + 2, true) + (model?.origin[1] ?? 0);
      const w = model?.size[0] ?? data.getUint16(offset + 4, true), h = model?.size[1] ?? data.getUint16(offset + 6, true), face = model?.face ?? raw[offset + 8];
      origins.set([x, y, z], quad * 3); sizes.set([w, h], quad * 2);
      colors.set(raw.subarray(offset + 12, offset + 15), quad * 3);
      for (let corner = 0; corner < 4; corner++) {
        const start = (offset / 16 * 4 + corner) * tintStride;
        cornerColors[corner].set(tints ? tints.subarray(start, start + 3) : raw.subarray(offset + 12, offset + 15), quad * 3);
      }
      uvU.set(model?.uvU ?? [0, 1, 0], quad * 3); uvV.set(model?.uvV ?? [0, 0, 1], quad * 3);
      if (model?.axes) model.axes.forEach((axis, i) => axes![i].set(axis, quad * 3));
      sprites[quad] = model?.texture ?? data.getUint16(offset + 10, true); faces[quad] = face;
      flags[quad] = (raw[offset + 9] & 63) | (model?.axes ? SCENE_AXES : 0);
      occlusion[quad] = model?.axes ? 0 : raw[offset + 15];
      const baseY = data.getInt16(offset + 2, true);
      minY = Math.min(minY, model?.minY === undefined ? y : baseY + model.minY);
      maxY = Math.max(maxY, model?.maxY === undefined ? y + ((raw[offset + 9] & SCENE_GROUND) ? 1 / 64 : face < 2 ? w : face >= 4 ? h : 0) : baseY + model.maxY);
    });
    return [{ kind, origins, sizes, colors, cornerColors, uvU, uvV, axes, sprites, faces, flags, occlusion, minY, maxY, count }];
  });
  return { meshes, heights, count: meshes.reduce((count, mesh) => count + mesh.count, 0), chunks: tile.chunks, warnings: tile.warnings, limited: !!tile.limited, animated };
}
