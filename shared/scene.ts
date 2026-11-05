import data from "./minecraft-assets.json";

export enum SceneKind { Opaque, Cutout, Translucent, Plant }
export const SCENE_KIND_COUNT = 4;
export const SCENE_GRASS_OVERLAY = 4;
export const SCENE_EMISSIVE = 8;
export const SCENE_GROUND = 16;
export interface MinecraftBlock { faces: number[]; tint: number; overlay: number; kind: SceneKind; shape?: "ground" | "cross" }
export const minecraftAssets = data as unknown as {
  version: string;
  atlas: { width: number; height: number; cell: number; inner: number; padding: number; columns: number };
  textures: [name: string, firstFrame: number, frames: number, frameTime: number, interpolate: boolean][];
  blocks: Record<string, MinecraftBlock>;
  biomes: Record<string, [grass: number, foliage: number, water: number, dryFoliage: number]>;
};
export const sceneTextures = new Map(minecraftAssets.textures.map(texture => [texture[1], texture]));
