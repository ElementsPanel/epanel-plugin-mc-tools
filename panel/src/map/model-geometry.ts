import { minecraftAssets, type MinecraftBlock, type ModelElement } from "../../../shared/scene";
import { fireElements } from "../../../shared/fire";

export const sceneModels = new Map<number, MinecraftBlock>();
for (const block of [...Object.values(minecraftAssets.blocks), ...Object.values(minecraftAssets.states).flatMap(state => state.models)]) {
  if (block.elements || block.fire) sceneModels.set(block.key ?? block.faces[2], block);
}
const directions = ["east", "west", "up", "down", "south", "north"];
const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const rotate = ([x, y, z]: number[], turns: number): number[] => {
  for (let i = 0; i < turns; i++) [x, z] = [1 - z, x];
  return [x, y, z];
};

interface ModelFace {
  origin: number[]; size: number[]; face: number; texture: number; uvU: number[]; uvV: number[];
  axes?: number[][]; minY?: number; maxY?: number;
}

/** Rotated elements keep their tilted planes as arbitrary quads, not their enclosing box. */
function orientedFaces(element: ModelElement, turns: number): ModelFace[] {
  const transform = (point: number[]) => {
    const rotation = element.rotation;
    if (rotation) {
      const axis = ["x", "y", "z"].indexOf(rotation.axis), u = (axis + 1) % 3, v = (axis + 2) % 3;
      const angle = rotation.angle * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
      const delta = point.map((value, i) => value - rotation.origin[i] / 16);
      [delta[u], delta[v]] = [(delta[u] * c - delta[v] * s), (delta[u] * s + delta[v] * c)];
      if (rotation.rescale) { delta[u] /= c; delta[v] /= c; }
      point = delta.map((value, i) => value + rotation.origin[i] / 16);
    }
    return rotate(point, (turns + (element.yaw ?? 0) / 90) % 4);
  };
  return Object.entries(element.faces).map(([direction, texture]) => {
    const face = directions.indexOf(direction), axis = face >> 1, u = (axis + 1) % 3, v = (axis + 2) % 3;
    const from = element.from.map(value => value / 16), to = element.to.map(value => value / 16);
    const uv = ([cu, cv]: number[]) => {
      const local = [0, 0, 0]; local[u] = cu; local[v] = cv;
      const [x, y, z] = local;
      let [a, b] = axis === 0 ? [face === 0 ? 1 - z : z, 1 - y]
        : axis === 1 ? [x, face === 2 ? z : 1 - z] : [face === 4 ? x : 1 - x, 1 - y];
      for (let i = 0; i < (texture.rotation ?? 0) / 90; i++) [a, b] = [1 - b, a];
      return [(texture.uv[0] + (texture.uv[2] - texture.uv[0]) * a) / 16,
        1 - (texture.uv[1] + (texture.uv[3] - texture.uv[1]) * b) / 16];
    };
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([cu, cv]) => {
      const point = [...from]; point[axis] = face % 2 ? from[axis] : to[axis];
      point[u] += cu * (to[u] - from[u]); point[v] += cv * (to[v] - from[v]);
      return transform(point);
    });
    const origin = corners[0], axes = [corners[1], corners[3]].map(point => point.map((value, i) => value - origin[i]));
    const start = uv([0, 0]), alongU = uv([1, 0]), alongV = uv([0, 1]);
    return { origin, axes, size: axes.map(axis => Math.hypot(...axis)), face, texture: texture.texture,
      minY: Math.min(...corners.map(point => point[1])), maxY: Math.max(...corners.map(point => point[1])),
      uvU: [start[0], alongU[0] - start[0], alongV[0] - start[0]], uvV: [start[1], alongU[1] - start[1], alongV[1] - start[1]] };
  });
}

/** Axis-aligned boxes rotate only by blockstate yaw and stay cheap lattice quads. */
function axisFaces(element: ModelElement, turns: number): ModelFace[] {
  return Object.entries(element.faces).map(([direction, texture]) => {
    const originalFace = directions.indexOf(direction), axis = originalFace >> 1;
    const from = element.from.map(v => v / 16), to = element.to.map(v => v / 16);
    const corners: number[][] = [];
    for (const x of [from[0], to[0]]) for (const y of [from[1], to[1]]) for (const z of [from[2], to[2]]) corners.push(rotate([x, y, z], turns));
    const low = [0, 1, 2].map(a => Math.min(...corners.map(p => p[a]))), high = [0, 1, 2].map(a => Math.max(...corners.map(p => p[a])));
    const vector = rotate(normals[originalFace].map(v => .5 + v / 2), turns).map(v => Math.round((v - .5) * 2));
    const face = normals.findIndex(n => n.every((v, i) => v === vector[i])), targetAxis = face >> 1;
    const u = (targetAxis + 1) % 3, v = (targetAxis + 2) % 3;
    const origin = [...low]; origin[targetAxis] = face % 2 ? low[targetAxis] : high[targetAxis];
    const size = [high[u] - low[u], high[v] - low[v]];
    const uv = ([cu, cv]: number[]) => {
      const point = [...origin]; point[u] += cu * size[0]; point[v] += cv * size[1];
      const original = rotate(point, (4 - turns) % 4).map((p, a) => (p - from[a]) / Math.max(1e-9, to[a] - from[a]));
      const [x, y, z] = original;
      const local = axis === 0 ? [originalFace === 0 ? 1 - z : z, 1 - y]
        : axis === 1 ? [x, originalFace === 2 ? z : 1 - z] : [originalFace === 4 ? x : 1 - x, 1 - y];
      return [(texture.uv[0] + (texture.uv[2] - texture.uv[0]) * local[0]) / 16,
        1 - (texture.uv[1] + (texture.uv[3] - texture.uv[1]) * local[1]) / 16];
    };
    const start = uv([0, 0]), alongU = uv([1, 0]), alongV = uv([0, 1]);
    return { origin, size, face, texture: texture.texture,
      uvU: [start[0], alongU[0] - start[0], alongV[0] - start[0]], uvV: [start[1], alongU[1] - start[1], alongV[1] - start[1]] };
  });
}

/** Preserve the original model's fractional bounds and UVs through blockstate yaw. */
export function modelFaces(sprite: number, turns: number, connections = 0, seed = 0): ModelFace[] {
  const model = sceneModels.get(sprite)!;
  if (model.fire) return fireElements(model, connections, seed).flatMap(element => orientedFaces(element, turns));
  return model.elements!.flatMap(element => element.rotation ? orientedFaces(element, turns) : axisFaces(element, turns));
}
