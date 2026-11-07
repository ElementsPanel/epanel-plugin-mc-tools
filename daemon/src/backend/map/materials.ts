import { minecraftAssets, SceneKind, type MinecraftBlock } from "../../../../shared/scene";
import { fireConnections } from "../../../../shared/fire";
import type { BiomeTint } from "./biome-blend";

export interface Material { name: string; color: number; model: MinecraftBlock; kind: SceneKind; emissive: boolean; biomeTint?: BiomeTint; fire?: number }

const fluidNames = new Set(["minecraft:water", "minecraft:flowing_water", "minecraft:seagrass", "minecraft:tall_seagrass",
  "minecraft:kelp", "minecraft:kelp_plant", "minecraft:bubble_column",
  // Legacy sections store bare names.
  "water", "flowing_water", "seagrass", "tall_seagrass", "kelp", "kelp_plant", "bubble_column"]);
export function blockFluid(name: string, properties?: Readonly<Record<string, string>>) {
  if (properties?.waterlogged === "true" || properties?.waterlogged === "1") return "minecraft:water";
  return fluidNames.has(name) ? "minecraft:water" : undefined;
}
const plants = /^(?:short_grass|tall_grass|fern|large_fern|dead_bush|.*sapling|dandelion|poppy|blue_orchid|allium|azure_bluet|.*tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|wheat|carrots|potatoes|beetroots|brown_mushroom|red_mushroom|sugar_cane|vine|cave_vines|kelp|seagrass|tall_seagrass)$/;
// BlockColors registers only these plants/leaves for biome tinting. In particular,
// cherry, pale oak and azalea leaves retain the colors already in their sprites.
const grassTint = new Set(["grass_block", "short_grass", "tall_grass", "fern", "large_fern", "potted_fern", "bush", "sugar_cane", "pink_petals", "wildflowers"]);
const foliageTint = new Set(["oak_leaves", "jungle_leaves", "acacia_leaves", "dark_oak_leaves", "mangrove_leaves", "vine"]);
const groundPlants = new Set(["leaf_litter", "pink_petals", "wildflowers"]);

type Properties = Readonly<Record<string, string>>;
function blockName(block: string) {
  const raw = block.replace(/^.*:/, "");
  return raw === "grass" ? "grass_block" : raw.replace(/^flowing_/, "");
}
function upperHalf(properties?: Properties) {
  return properties?.half === "upper" || properties?.upper_block_bit === "1" || properties?.upper_block_bit === "true";
}
function variantIndex(name: string, properties?: Properties) {
  const state = minecraftAssets.states?.[name];
  if (!state || !properties) return undefined;
  const key = state.properties.map((prop, i) => properties[prop] ??
    (prop === "half" && upperHalf(properties) ? "upper" : state.defaults[i])).join(",");
  return state.variants[key];
}
/** Ignore properties that do not change the material, so terrain can still merge. */
export function blockStateKey(block: string, properties?: Properties): string {
  const name = blockName(block), index = variantIndex(name, properties);
  if (name === "fire" || name === "soul_fire") return name + "[fire=" + fireConnections(properties) + "]";
  return name + (index !== undefined ? "[state=" + index + "]" : upperHalf(properties) ? "[half=upper]" : "");
}

/** Biome tint color for a block, matching BlockColors' per-block registration. */
export function blockTintColor(name: string, colors: readonly [number, number, number, number]): number {
  return name === "water" ? colors[2] : name === "leaf_litter" ? colors[3] : name === "spruce_leaves" ? 0x619961 : name === "birch_leaves" ? 0x80a755
    : foliageTint.has(name) ? colors[1] : name === "lily_pad" ? 0x208030 : name === "redstone_wire" ? 0x4c0000 : grassTint.has(name) ? colors[0] : 0xffffff;
}

const missingModel: MinecraftBlock = { faces: [0, 0, 0, 0, 0, 0], tint: 0, overlay: 0, kind: SceneKind.Opaque };
export function blockMaterial(block: string, biome = "minecraft:plains", properties?: Properties): Material {
  const name = blockName(block), index = variantIndex(name, properties);
  const sourceModel = (index !== undefined ? minecraftAssets.states[name].models[index] : undefined) ??
    (upperHalf(properties) ? minecraftAssets.blocks[name + "[half=upper]"] : undefined) ?? minecraftAssets.blocks[name] ?? missingModel;
  // Keep ground cover flat even when an older asset catalog lacks its shape.
  const model: MinecraftBlock = groundPlants.has(name) && sourceModel.shape !== "ground" ? { ...sourceModel, shape: "ground" } : sourceModel;
  const colors = minecraftAssets.biomes[biome] ?? minecraftAssets.biomes["minecraft:plains"];
  const biomeTint = name === "leaf_litter" ? 3 : foliageTint.has(name) ? 1 : grassTint.has(name) ? 0 : undefined;
  const color = blockTintColor(name, colors);
  return { name, color, model, biomeTint, kind: model.shape || plants.test(name) ? SceneKind.Plant : model.kind,
    ...(model.fire ? { fire: fireConnections(properties) } : {}),
    emissive: /^(?:fire|soul_fire|lava|glowstone|sea_lantern|shroomlight|jack_o_lantern|torch|soul_torch|lantern|soul_lantern|end_rod|ochre_froglight|verdant_froglight|pearlescent_froglight)$/.test(name) };
}

