import data from "./minecraft-assets.json";

export enum SceneKind { Opaque, Cutout, Translucent, Plant }
export const SCENE_KIND_COUNT = 4;
export const SCENE_GRASS_OVERLAY = 4;
export const SCENE_EMISSIVE = 8;
export const SCENE_GROUND = 16;
export const SCENE_MODEL = 32;
// GPU-only flag; wire bits 6–7 still encode model yaw.
export const SCENE_AXES = 64;
export interface ModelElement {
  from: number[]; to: number[]; yaw?: number;
  rotation?: { origin: number[]; axis: "x" | "y" | "z"; angle: number; rescale?: boolean };
  faces: Record<string, { texture: number; uv: number[]; rotation?: number }>;
}
export interface FirePart { connections: number[]; variants: ModelElement[][] }
export interface MinecraftBlock { faces: number[]; tint: number; overlay: number; kind: SceneKind; shape?: "ground" | "cross" | "model"; elements?: ModelElement[]; rotation?: number; key?: number; solid?: boolean; fire?: FirePart[] }
export const minecraftAssets = data as unknown as {
  version: string;
  biomeVersion: string;
  atlas: { width: number; height: number; cell: number; inner: number; padding: number; columns: number };
  textures: [name: string, firstFrame: number, frames: number, frameTime: number, interpolate: boolean][];
  blocks: Record<string, MinecraftBlock>;
  states: Record<string, { properties: string[]; defaults: string[]; variants: Record<string, number>; models: MinecraftBlock[] }>;
  biomes: Record<string, [grass: number, foliage: number, water: number, dryFoliage: number]>;
};
export const sceneTextures = new Map(minecraftAssets.textures.map(texture => [texture[1], texture]));

/** A sprite's first atlas frame, resolved by name so atlas updates keep model patches valid. */
const spriteFrame = (name: string) => {
  const texture = minecraftAssets.textures.find(item => item[0] === "block/" + name);
  if (!texture) throw new Error("Missing Minecraft sprite: " + name);
  return texture[1];
};
const modelFace = (texture: number, uv: number[]) => ({ texture, uv });
/** Vanilla default UVs: an unset face uses the element's position on the 16×16 texture. */
const defaultUv = (from: number[], to: number[], direction: string) => {
  const [x1, y1, z1] = from, [x2, y2, z2] = to;
  switch (direction) {
    case "down": return [x1, 16 - z2, x2, 16 - z1];
    case "up": return [x1, z1, x2, z2];
    case "north": return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
    case "south": return [x1, 16 - y2, x2, 16 - y1];
    case "west": return [z1, 16 - y2, z2, 16 - y1];
    default: return [16 - z2, 16 - y2, 16 - z1, 16 - y1];
  }
};
function torchModel(texture: number, key: number): MinecraftBlock {
  const full = modelFace(texture, [0, 0, 16, 16]), tip = modelFace(texture, [7, 13, 9, 15]), flame = modelFace(texture, [7, 6, 9, 8]);
  return { faces: [texture, texture, texture, texture, texture, texture], tint: 0, overlay: 0, kind: SceneKind.Cutout, shape: "model", key, solid: false,
    elements: [
      { from: [7, 0, 7], to: [9, 10, 9], faces: { down: tip, up: flame } },
      { from: [7, 0, 0], to: [9, 16, 16], faces: { west: full, east: full } },
      { from: [0, 0, 7], to: [16, 16, 9], faces: { north: full, south: full } }
    ] };
}
function wallTorchModel(texture: number, key: number, rotation: number): MinecraftBlock {
  const full = modelFace(texture, [0, 0, 16, 16]), tip = modelFace(texture, [7, 13, 9, 15]), flame = modelFace(texture, [7, 6, 9, 8]);
  const tilt = { origin: [0, 3.5, 8], axis: "z" as const, angle: -22.5 };
  return { faces: [texture, texture, texture, texture, texture, texture], tint: 0, overlay: 0, kind: SceneKind.Cutout, shape: "model", key, solid: false, rotation,
    elements: [
      { from: [-1, 3.5, 7], to: [1, 13.5, 9], rotation: tilt, faces: { down: tip, up: flame } },
      { from: [-1, 3.5, 0], to: [1, 19.5, 16], rotation: tilt, faces: { west: full, east: full } },
      { from: [-8, 3.5, 7], to: [8, 19.5, 9], rotation: tilt, faces: { north: full, south: full } }
    ] };
}
function composterModel(): MinecraftBlock {
  const side = spriteFrame("composter_side"), top = spriteFrame("composter_top"), bottom = spriteFrame("composter_bottom");
  const wall = (from: number[], to: number[], directions: string[]) => ({ from, to,
    faces: Object.fromEntries(directions.map(direction => [direction, modelFace(direction === "up" ? top : side, defaultUv(from, to, direction))])) });
  return { faces: [side, side, bottom, bottom, side, side], tint: 0, overlay: 0, kind: SceneKind.Opaque, shape: "model", key: bottom,
    elements: [
      { from: [0, 0, 0], to: [16, 2, 16], faces: {
        up: modelFace(bottom, defaultUv([0, 0, 0], [16, 2, 16], "up")),
        down: modelFace(bottom, defaultUv([0, 0, 0], [16, 2, 16], "down")) } },
      wall([0, 0, 0], [2, 16, 16], ["up", "north", "south", "west", "east"]),
      wall([14, 0, 0], [16, 16, 16], ["up", "north", "south", "west", "east"]),
      wall([2, 0, 0], [14, 16, 2], ["up", "north", "south"]),
      wall([2, 0, 14], [14, 16, 16], ["up", "north", "south"])
    ] };
}

// The compact catalog stores full cubes for these thin models; patch the real elements
// at load time so the 2D/3D mesh can expand them without hand-editing generated assets.
const torchSprite = spriteFrame("torch"), soulSprite = spriteFrame("soul_torch");
const redstoneSprite = spriteFrame("redstone_torch"), redstoneOffSprite = spriteFrame("redstone_torch_off");
Object.assign(minecraftAssets.blocks, {
  torch: torchModel(torchSprite, torchSprite),
  soul_torch: torchModel(soulSprite, soulSprite),
  redstone_torch: torchModel(redstoneOffSprite, redstoneOffSprite),
  wall_torch: wallTorchModel(torchSprite, 0x8000, 0),
  soul_wall_torch: wallTorchModel(soulSprite, 0x8001, 0),
  redstone_wall_torch: wallTorchModel(redstoneOffSprite, 0x8040, 0),
  composter: composterModel()
});
const facings = [["east", 0], ["north", 270], ["south", 90], ["west", 180]] as const;
minecraftAssets.states.wall_torch = { properties: ["facing"], defaults: ["east"],
  variants: Object.fromEntries(facings.map(([facing], index) => [facing, index])),
  models: facings.map(([, rotation], index) => wallTorchModel(torchSprite, 0x8020 + index, rotation)) };
minecraftAssets.states.soul_wall_torch = { properties: ["facing"], defaults: ["east"],
  variants: Object.fromEntries(facings.map(([facing], index) => [facing, index])),
  models: facings.map(([, rotation], index) => wallTorchModel(soulSprite, 0x8030 + index, rotation)) };
minecraftAssets.states.redstone_torch.models = [torchModel(redstoneOffSprite, redstoneOffSprite), torchModel(redstoneSprite, redstoneSprite)];
const redstoneWallVariants: Record<string, number> = {}, redstoneWallModels: MinecraftBlock[] = [];
for (const [facing, rotation] of facings) for (const lit of ["false", "true"]) {
  redstoneWallVariants[facing + "," + lit] = redstoneWallModels.length;
  redstoneWallModels.push(wallTorchModel(lit === "true" ? redstoneSprite : redstoneOffSprite, 0x8041 + redstoneWallModels.length, rotation));
}
minecraftAssets.states.redstone_wall_torch = { properties: ["facing", "lit"], defaults: ["east", "false"],
  variants: redstoneWallVariants, models: redstoneWallModels };
// The thin shelf keeps behaving like a plant rather than a solid cube.
for (const shelf of [minecraftAssets.blocks.shelf_mushroom, ...(minecraftAssets.states.shelf_mushroom?.models ?? [])]) shelf.solid = false;
