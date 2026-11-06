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
export interface MinecraftBlock { faces: number[]; tint: number; overlay: number; kind: SceneKind; shape?: "ground" | "cross" | "model"; elements?: ModelElement[]; rotation?: number; fire?: FirePart[] }
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
