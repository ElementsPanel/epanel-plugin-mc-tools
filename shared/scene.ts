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
const modelFace = (texture: number, uv: number[], rotation?: number) => rotation ? { texture, uv, rotation } : { texture, uv };
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

function campfireModel(log: number, litLog: number | undefined, fire: number | undefined, key: number, rotation: number): MinecraftBlock {
  const wood = (uv: number[], turn?: number) => modelFace(log, uv, turn);
  const hot = (uv: number[], turn?: number) => modelFace(litLog ?? log, uv, turn);
  const elements: ModelElement[] = [
    { from: [1, 0, 0], to: [5, 4, 16], faces: { north: wood([0, 4, 4, 8]), east: hot([0, 1, 16, 5]), south: wood([0, 4, 4, 8]), west: wood([16, 0, 0, 4]), up: wood([0, 0, 16, 4], 90), down: wood([0, 0, 16, 4], 90) } },
    { from: [0, 3, 11], to: [16, 7, 15], faces: { north: hot([16, 0, 0, 4]), east: wood([0, 4, 4, 8]), south: hot([0, 0, 16, 4]), west: wood([0, 4, 4, 8]), up: wood([0, 0, 16, 4], 180), down: hot([0, 4, 16, 8]) } },
    { from: [11, 0, 0], to: [15, 4, 16], faces: { north: wood([0, 4, 4, 8]), east: wood([0, 0, 16, 4]), south: wood([0, 4, 4, 8]), west: hot([16, 1, 0, 5]), up: wood([0, 0, 16, 4], 90), down: wood([0, 0, 16, 4], 90) } },
    { from: [0, 3, 1], to: [16, 7, 5], faces: { north: hot([0, 0, 16, 4]), east: wood([0, 4, 4, 8]), south: hot([16, 0, 0, 4]), west: wood([0, 4, 4, 8]), up: wood([0, 0, 16, 4], 180), down: hot([0, 4, 16, 8]) } },
    { from: [5, 0, 0], to: [11, 1, 16], faces: { north: wood([0, 15, 6, 16]), south: wood([10, 15, 16, 16]), up: hot([0, 8, 16, 14], 90), down: wood([0, 8, 16, 14], 90) } }
  ];
  if (fire !== undefined) {
    const flame = modelFace(fire, [0, 0, 16, 16]), tilt = { origin: [8, 8, 8], axis: "y" as const, angle: 45, rescale: true };
    elements.push(
      { from: [0.8, 1, 8], to: [15.2, 17, 8], rotation: tilt, faces: { north: flame, south: flame } },
      { from: [8, 1, 0.8], to: [8, 17, 15.2], rotation: tilt, faces: { west: flame, east: flame } }
    );
  }
  return { faces: [log, log, log, log, log, log], tint: 0, overlay: 0, kind: SceneKind.Cutout, shape: "model", key, solid: false, rotation, elements };
}

function strawBedFoot(key: number, rotation: number): MinecraftBlock {
  const t = spriteFrame("straw_bed"), f = (uv: number[], turn?: number) => modelFace(t, uv, turn);
  return { faces: [t, t, t, t, t, t], tint: 0, overlay: 0, kind: SceneKind.Cutout, shape: "model", key, solid: false, rotation,
    elements: [
      { from: [0, 0, 0], to: [16, 4, 16], faces: { north: f([4, 10.25, 8, 11.25]), east: f([0, 10.25, 4, 11.25]), west: f([8, 10.25, 12, 11.25]), up: f([8, 10.25, 4, 6.25]), down: f([12, 6.25, 8, 10.25]) } },
      { from: [0, 0.125, -3], to: [16, 0.125, 0], faces: { up: f([0, 11.25, 4, 12], 180), down: f([0, 12.75, 4, 12], 180) } },
      { from: [16, 0.105, 0], to: [19, 0.105, 16], faces: { up: f([12, 6.25, 12.75, 10.25], 180), down: f([12.75, 10.25, 13.5, 6.25], 180) } },
      { from: [-3, 0.115, 0], to: [0, 0.115, 16], faces: { up: f([13.5, 10.25, 14.25, 6.25], 180), down: f([14.25, 6.25, 15, 10.25], 180) } }
    ] };
}

function strawBedHead(key: number, rotation: number): MinecraftBlock {
  const t = spriteFrame("straw_bed"), f = (uv: number[], turn?: number) => modelFace(t, uv, turn);
  return { faces: [t, t, t, t, t, t], tint: 0, overlay: 0, kind: SceneKind.Cutout, shape: "model", key, solid: false, rotation,
    elements: [
      { from: [0, 0, 0], to: [16, 4, 8], faces: { north: f([2, 5.25, 6, 6.25]), east: f([0, 5.25, 2, 6.25]), south: f([8, 5.25, 12, 6.25]), west: f([6, 5.25, 8, 6.25]), up: f([6, 5.25, 2, 3.25]), down: f([10, 3.25, 6, 5.25]) } },
      { from: [-2, 0.065, 8], to: [0, 0.065, 16], faces: { up: f([1.5, 8.25, 1, 6.25]), down: f([2, 6.25, 1.5, 8.25]) } },
      { from: [-2, 4.96, 8], to: [0, 4.96, 16], faces: { up: f([10.5, 2, 10, 0]), down: f([11, 0, 10.5, 2]) } },
      { from: [-2, 0.065, 8.025], to: [0, 4.95, 8.025], faces: { north: f([1, 8.25, 1.5, 9.48125]), south: f([2, 8.25, 1.5, 9.48125]) } },
      { from: [-2, 0.065, 15.985], to: [0, 4.95, 15.985], faces: { north: f([10, 3.25, 10.5, 4.48125]), south: f([10.5, 3.25, 11, 4.48125]) } },
      { from: [16, 0.05, 8], to: [18, 0.05, 16], faces: { up: f([0.5, 8.25, 0, 6.25]), down: f([0.5, 6.25, 1, 8.25]) } },
      { from: [16, 4.975, 8], to: [18, 4.975, 16], faces: { up: f([0.5, 2, 0, 0]), down: f([0.5, 0, 1, 2]) } },
      { from: [16, 0.05, 8], to: [18, 4.975, 8], faces: { north: f([0, 8.25, 0.5, 9.48125]), south: f([1, 8.25, 0.5, 9.48125]) } },
      { from: [16, 0.05, 15.975], to: [18, 4.975, 15.975], faces: { north: f([0, 3.25, 0.5, 4.48125]), south: f([1, 3.25, 0.5, 4.48125]) } },
      { from: [0, 0, 8], to: [16, 5, 16], faces: { north: f([2, 2, 6, 3.25]), east: f([0, 2, 2, 3.25]), south: f([8, 2, 12, 3.25]), west: f([6, 2, 8, 3.25]), up: f([6, 2, 2, 0]), down: f([10, 0, 6, 2]) } },
      { from: [16, 0.05, 0], to: [19, 0.05, 8], faces: { up: f([12.75, 6.25, 12, 4.25]), down: f([13.5, 4.25, 12.75, 6.25]) } },
      { from: [-3, 0.065, 0], to: [0, 0.065, 8], faces: { up: f([14.25, 6.25, 13.5, 4.25]), down: f([15, 4.25, 14.25, 6.25]) } }
    ] };
}

const campfireLog = spriteFrame("campfire_log"), campfireLit = spriteFrame("campfire_log_lit"), campfireFire = spriteFrame("campfire_fire");
const soulCampfireLit = spriteFrame("soul_campfire_log_lit"), soulCampfireFire = spriteFrame("soul_campfire_fire");
const facingYaw = [["south", 0], ["west", 90], ["north", 180], ["east", 270]] as const;
Object.assign(minecraftAssets.blocks, {
  campfire: campfireModel(campfireLog, undefined, undefined, 0xA010, 0),
  soul_campfire: campfireModel(campfireLog, undefined, undefined, 0xA011, 0),
  straw_bed: strawBedFoot(0xA000, 0)
});
for (const [type, lit, wood, fire] of [["campfire", campfireLit, campfireLog, campfireFire],
  ["soul_campfire", soulCampfireLit, campfireLog, soulCampfireFire]] as const) {
  Object.assign(minecraftAssets.blocks[type], { key: type === "campfire" ? 0xA010 : 0xA011 });
  const variants: Record<string, number> = {}, models: MinecraftBlock[] = [];
  for (const [facing, rotation] of facingYaw) for (const state of ["false", "true"]) {
    variants[facing + "," + state] = models.length;
    models.push(campfireModel(wood, state === "true" ? lit : undefined, state === "true" ? fire : undefined,
      state === "true" ? (type === "campfire" ? 0xA013 : 0xA015) : (type === "campfire" ? 0xA012 : 0xA014), rotation));
  }
  minecraftAssets.states[type] = { properties: ["facing", "lit"], defaults: ["south", "false"], variants, models };
}
const bedVariants: Record<string, number> = {}, bedModels: MinecraftBlock[] = [];
for (const [facing, rotation] of facingYaw) {
  bedVariants[facing + ",foot"] = bedModels.length; bedModels.push(strawBedFoot(0xA000, rotation));
  bedVariants[facing + ",head"] = bedModels.length; bedModels.push(strawBedHead(0xA001, rotation));
}
minecraftAssets.states.straw_bed = { properties: ["facing", "part"], defaults: ["south", "foot"], variants: bedVariants, models: bedModels };

function dirtPathModel(): MinecraftBlock {
  const side = spriteFrame("dirt_path_side"), top = spriteFrame("dirt_path_top"), bottom = spriteFrame("dirt");
  // Inset the sides slightly so the surrounding block's face wins the depth test
  // and fills the 1-pixel step, instead of z-fighting or leaving an empty rim.
  return { faces: [side, side, top, bottom, side, side], tint: 0, overlay: 0, kind: SceneKind.Opaque, shape: "model", key: 0xB000, solid: false,
    elements: [{ from: [0.001, 0, 0.001], to: [15.999, 15, 15.999], faces: {
      down: modelFace(bottom, [0, 0, 16, 16]), up: modelFace(top, [0, 0, 16, 16]),
      north: modelFace(side, [0, 1, 16, 16]), south: modelFace(side, [0, 1, 16, 16]),
      west: modelFace(side, [0, 1, 16, 16]), east: modelFace(side, [0, 1, 16, 16]) } }] };
}
Object.assign(minecraftAssets.blocks, { dirt_path: dirtPathModel() });

function snowLayerModel(layers: number): MinecraftBlock {
  const texture = spriteFrame("snow"), height = layers * 2;
  const side = modelFace(texture, [0, 16 - height, 16, 16]);
  return { faces: [texture, texture, texture, texture, texture, texture], tint: 0, overlay: 0, kind: SceneKind.Opaque,
    shape: "model", key: 0xC000 + layers - 1, solid: layers === 8,
    elements: [{ from: [0, 0, 0], to: [16, height, 16], faces: {
      down: modelFace(texture, [0, 0, 16, 16]), up: modelFace(texture, [0, 0, 16, 16]),
      north: side, south: side, west: side, east: side } }] };
}
const snowModels = Array.from({ length: 8 }, (_, index) => snowLayerModel(index + 1));
Object.assign(minecraftAssets.blocks, { snow: snowModels[0] });
minecraftAssets.states.snow = { properties: ["layers"], defaults: ["1"],
  variants: Object.fromEntries(snowModels.map((_, index) => [String(index + 1), index])), models: snowModels };

/** Vanilla lantern: a 6×6 body under a smaller cap, plus crossed chain planes. */
function lanternModel(texture: number, hanging: boolean, key: number): MinecraftBlock {
  const face = (uv: number[]) => modelFace(texture, uv);
  const body = face([0, 2, 6, 9]), cap = face([1, 0, 5, 2]), tilt = { origin: [8, 8, 8], axis: "y" as const, angle: 45 };
  const elements: ModelElement[] = [
    { from: hanging ? [5, 1, 5] : [5, 0, 5], to: hanging ? [11, 8, 11] : [11, 7, 11],
      faces: { north: body, south: body, west: body, east: body, up: face([0, 9, 6, 15]), down: face([0, 9, 6, 15]) } },
    { from: hanging ? [6, 8, 6] : [6, 7, 6], to: hanging ? [10, 10, 10] : [10, 9, 10],
      faces: hanging ? { north: cap, south: cap, west: cap, east: cap, up: face([1, 10, 5, 14]), down: face([1, 10, 5, 14]) }
        : { north: cap, south: cap, west: cap, east: cap, up: face([1, 10, 5, 14]) } },
    { from: hanging ? [6.5, 11, 8] : [6.5, 9, 8], to: hanging ? [9.5, 15, 8] : [9.5, 11, 8], rotation: tilt,
      faces: { north: face(hanging ? [14, 1, 11, 5] : [14, 1, 11, 3]), south: face(hanging ? [11, 1, 14, 5] : [11, 1, 14, 3]) } },
    { from: hanging ? [8, 10, 6.5] : [8, 9, 6.5], to: hanging ? [8, 16, 9.5] : [8, 11, 9.5], rotation: tilt,
      faces: { west: face(hanging ? [14, 6, 11, 12] : [14, 10, 11, 12]), east: face(hanging ? [11, 6, 14, 12] : [11, 10, 14, 12]) } }
  ];
  return { faces: [texture, texture, texture, texture, texture, texture], tint: 0, overlay: 0, kind: SceneKind.Cutout, shape: "model", key, solid: false, elements };
}

/** Vanilla standing sign: a 4-pixel post under a board. The board and post tilt by
 *  ±22.5° for the diagonal rotations, so the tilt is baked into the elements. */
function standingSignModel(texture: number, key: number, tilt: number, yaw: number): MinecraftBlock {
  const face = (uv: number[]) => modelFace(texture, uv);
  const rotation = tilt ? { origin: [8, 0, 8], axis: "y" as const, angle: tilt } : undefined;
  const post: ModelElement = { from: [7.33333, 0, 7.33333], to: [8.66667, 9.33333, 8.66667], ...(rotation ? { rotation } : {}),
    faces: { north: face([14, 8, 15, 15]), east: face([15, 0, 16, 7]), south: face([14, 0, 15, 7]), west: face([15, 8, 16, 15]), down: face([14, 15, 15, 16]) } };
  const board: ModelElement = { from: [0, 9.33333, 7.33333], to: [16, 17.33333, 8.66667], ...(rotation ? { rotation } : {}),
    faces: { north: face([0, 8, 12, 14]), east: face([12, 1, 13, 7]), south: face([0, 1, 12, 7]), west: face([12, 8, 13, 14]), up: face([0, 0, 12, 1]), down: face([0, 14, 12, 15]) } };
  return { faces: [texture, texture, texture, texture, texture, texture], tint: 0, overlay: 0, kind: SceneKind.Cutout,
    shape: "model", key, solid: false, rotation: yaw, elements: [post, board] };
}

/** Vanilla wall sign geometry points south; the blockstate yaw orients the others. */
function wallSignModel(texture: number, key: number, yaw: number): MinecraftBlock {
  const face = (uv: number[]) => modelFace(texture, uv);
  return { faces: [texture, texture, texture, texture, texture, texture], tint: 0, overlay: 0, kind: SceneKind.Cutout,
    shape: "model", key, solid: false, rotation: yaw,
    elements: [{ from: [0, 4.33333, 0.33333], to: [16, 12.33333, 1.66667],
      faces: { north: face([0, 8, 12, 14]), east: face([12, 1, 13, 7]), south: face([0, 1, 12, 7]), west: face([12, 8, 13, 14]),
        up: face([0, 0, 12, 1]), down: face([0, 14, 12, 15]) } }] };
}

// Synthetic model keys stay above the atlas sprite indices and clear of the other patches.
let customModelKey = 0xE000;
const lanternNames = ["lantern", "soul_lantern", "copper_lantern", "exposed_copper_lantern", "weathered_copper_lantern", "oxidized_copper_lantern"];
for (const name of lanternNames) {
  const block = minecraftAssets.blocks[name];
  if (!block) continue;
  const texture = spriteFrame(name), standing = lanternModel(texture, false, customModelKey++), hanging = lanternModel(texture, true, customModelKey++);
  Object.assign(block, { faces: [texture, texture, texture, texture, texture, texture], shape: "model", solid: false, key: standing.key, elements: standing.elements });
  minecraftAssets.states[name] = { properties: ["hanging"], defaults: ["false"],
    variants: { false: 0, true: 1 }, models: [standing, hanging] };
}

const signTilts = [0, -22.5, -45, -67.5], wallSignYaw: Record<string, number> = { south: 0, west: 90, north: 180, east: 270 };
const signWoods = new Set<string>();
for (const name of Object.keys(minecraftAssets.blocks)) {
  if (name.endsWith("_wall_sign")) signWoods.add(name.slice(0, -10));
  else if (name.endsWith("_sign") && !name.includes("hanging")) signWoods.add(name.slice(0, -5));
}
for (const wood of signWoods) {
  if (!minecraftAssets.blocks[wood + "_sign"] || !minecraftAssets.blocks[wood + "_wall_sign"]) continue;
  const texture = spriteFrame(wood + "_sign");
  const standing = Array.from({ length: 16 }, (_, rotation) =>
    standingSignModel(texture, customModelKey++, signTilts[rotation % 4], Math.floor(rotation / 4) * 90));
  const wall = Object.entries(wallSignYaw).map(([, yaw]) => wallSignModel(texture, customModelKey++, yaw));
  Object.assign(minecraftAssets.blocks[wood + "_sign"],
    { faces: [texture, texture, texture, texture, texture, texture], shape: "model", solid: false, rotation: 0, key: standing[0].key, elements: standing[0].elements });
  Object.assign(minecraftAssets.blocks[wood + "_wall_sign"],
    { faces: [texture, texture, texture, texture, texture, texture], shape: "model", solid: false, rotation: 0, key: wall[0].key, elements: wall[0].elements });
  minecraftAssets.states[wood + "_sign"] = { properties: ["rotation"], defaults: ["0"],
    variants: Object.fromEntries(standing.map((_, index) => [String(index), index])), models: standing };
  minecraftAssets.states[wood + "_wall_sign"] = { properties: ["facing"], defaults: ["south"],
    variants: Object.fromEntries(Object.keys(wallSignYaw).map((facing, index) => [facing, index])), models: wall };
}

// The enchanting table is a 12-pixel cube with distinct top, side and bottom sprites.
const tableSide = spriteFrame("enchanting_table_side"), tableTop = spriteFrame("enchanting_table_top"), tableBottom = spriteFrame("enchanting_table_bottom");
Object.assign(minecraftAssets.blocks.enchanting_table, { faces: [tableSide, tableSide, tableTop, tableBottom, tableSide, tableSide],
  shape: "model", solid: false, key: customModelKey++,
  elements: [{ from: [0, 0, 0], to: [16, 12, 16], faces: {
    down: modelFace(tableBottom, [0, 0, 16, 16]), up: modelFace(tableTop, [0, 0, 16, 16]),
    north: modelFace(tableSide, [0, 4, 16, 16]), south: modelFace(tableSide, [0, 4, 16, 16]),
    west: modelFace(tableSide, [0, 4, 16, 16]), east: modelFace(tableSide, [0, 4, 16, 16]) } }] });
