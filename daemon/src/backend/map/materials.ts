import { minecraftAssets, SceneKind, type MinecraftBlock } from "../../../../shared/scene";

export interface Material { name: string; color: number; model: MinecraftBlock; kind: SceneKind; emissive: boolean }

export function blockFluid(name: string, properties?: Readonly<Record<string, string>>) {
  return properties?.waterlogged === "true" || properties?.waterlogged === "1" ||
    /^(?:minecraft:)?(?:water|flowing_water|seagrass|tall_seagrass|kelp|kelp_plant|bubble_column)$/.test(name) ? "minecraft:water" : undefined;
}
const plants = /^(?:short_grass|tall_grass|fern|large_fern|dead_bush|.*sapling|dandelion|poppy|blue_orchid|allium|azure_bluet|.*tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|wheat|carrots|potatoes|beetroots|brown_mushroom|red_mushroom|sugar_cane|vine|cave_vines|kelp|seagrass|tall_seagrass)$/;
// BlockColors registers only these plants/leaves for biome tinting. In particular,
// cherry, pale oak and azalea leaves retain the colors already in their sprites.
const grassTint = new Set(["grass_block", "short_grass", "tall_grass", "fern", "large_fern", "potted_fern", "bush", "sugar_cane", "pink_petals", "wildflowers"]);
const foliageTint = new Set(["oak_leaves", "jungle_leaves", "acacia_leaves", "dark_oak_leaves", "mangrove_leaves", "vine"]);

const missingModel: MinecraftBlock = { faces: [0, 0, 0, 0, 0, 0], tint: 0, overlay: 0, kind: SceneKind.Opaque };
export function blockMaterial(block: string, biome = "minecraft:plains", upper = false): Material {
  const raw = block.replace(/^.*:/, ""), name = raw === "grass" ? "grass_block" : raw.replace(/^flowing_/, "");
  const model = (upper ? minecraftAssets.blocks[name + "[half=upper]"] : undefined) ?? minecraftAssets.blocks[name] ?? missingModel;
  const colors = minecraftAssets.biomes[biome] ?? minecraftAssets.biomes["minecraft:plains"];
  const color = name === "water" ? colors[2] : name === "leaf_litter" ? colors[3] : name === "spruce_leaves" ? 0x619961 : name === "birch_leaves" ? 0x80a755
    : foliageTint.has(name) ? colors[1] : name === "lily_pad" ? 0x208030 : name === "redstone_wire" ? 0x4c0000 : grassTint.has(name) ? colors[0] : 0xffffff;
  return { name, color, model, kind: model.shape || plants.test(name) ? SceneKind.Plant : model.kind,
    emissive: /^(?:lava|glowstone|sea_lantern|shroomlight|jack_o_lantern|torch|soul_torch|lantern|soul_lantern|end_rod|ochre_froglight|verdant_froglight|pearlescent_froglight)$/.test(name) };
}

