const named: Record<string, number> = {
  grass_block: 0x7eaa42, grass: 0x7eaa42, moss_block: 0x6c8c35, pale_moss_block: 0x909887,
  water: 0x376eb8, flowing_water: 0x376eb8, lava: 0xe76c16, flowing_lava: 0xe76c16, sand: 0xd8cb8e, red_sand: 0xb66532,
  snow: 0xf3f7fb, snow_block: 0xf3f7fb, powder_snow: 0xe9f0f5,
  stone: 0x858581, cobblestone: 0x777975, bedrock: 0x545454,
  deepslate: 0x515157, tuff: 0x66695d, gravel: 0x8b857e,
  dirt: 0x8e6548, coarse_dirt: 0x80583d, rooted_dirt: 0x987252,
  podzol: 0x705035, mycelium: 0x8c778a, mud: 0x48443b,
  clay: 0x9ea4b0, ice: 0x91b9e4, packed_ice: 0x80a4ce, blue_ice: 0x709dd5,
  netherrack: 0x7e3637, nether_bricks: 0x382027, soul_sand: 0x554132,
  soul_soil: 0x514035, crimson_nylium: 0x8f252e, warped_nylium: 0x29796d,
  end_stone: 0xd9dca0, obsidian: 0x272039, crying_obsidian: 0x493467,
  calcite: 0xd8d4ca, diorite: 0xb6b5ad, granite: 0x956b58, andesite: 0x90918a,
  redstone_block: 0xad1912, gold_block: 0xf1d54e, iron_block: 0xd7d7d0,
  diamond_block: 0x62d8cd, emerald_block: 0x36bc64, lapis_block: 0x3156a1,
  copper_block: 0xb56c4d, oxidized_copper: 0x55947c, amethyst_block: 0x8a64b7,
  dirt_path: 0xa38b50, farmland: 0x715138, bricks: 0x9b5e4b,
  prismarine: 0x639c91, dark_prismarine: 0x365f50, sea_lantern: 0xc0d9cb,
  basalt: 0x505153, blackstone: 0x35323a, glowstone: 0xc5a16a,
  pumpkin: 0xc17a1a, melon: 0x92a234, hay_block: 0xc9aa38,
  short_grass: 0x7eaa42, tall_grass: 0x7eaa42, fern: 0x6d9a3a,
  lily_pad: 0x47813c, kelp: 0x487b34, seagrass: 0x376eb8
};
const dyes: Record<string, number> = {
  white: 0xe5e3dd, orange: 0xd47b25, magenta: 0xb34bb3, light_blue: 0x65a5cf,
  yellow: 0xe2c745, lime: 0x80b63c, pink: 0xd68ca7, gray: 0x464a4e,
  light_gray: 0x9e9d96, cyan: 0x287e8f, purple: 0x7c42ac, blue: 0x394d96,
  brown: 0x775337, green: 0x587331, red: 0xa93d35, black: 0x24262b
};
const woods: Record<string, number> = {
  oak: 0xa48650, spruce: 0x725237, birch: 0xc5b376, jungle: 0xa97952,
  acacia: 0xa6603c, dark_oak: 0x503b22, mangrove: 0x7d3c35, cherry: 0xd7a7a1,
  bamboo: 0xb6a35b, crimson: 0x71364c, warped: 0x33776d, pale_oak: 0xddd7bc
};
const legacy: Record<number, string> = {
  1: "stone", 2: "grass_block", 3: "dirt", 4: "cobblestone", 5: "oak_planks",
  7: "bedrock", 8: "water", 9: "water", 10: "lava", 11: "lava", 12: "sand",
  13: "gravel", 17: "oak_log", 18: "oak_leaves", 20: "glass", 24: "sandstone",
  35: "white_wool", 45: "bricks", 49: "obsidian", 79: "ice", 80: "snow_block",
  81: "cactus", 82: "clay", 87: "netherrack", 88: "soul_sand", 89: "glowstone",
  98: "stone_bricks", 110: "mycelium", 112: "nether_bricks", 121: "end_stone",
  159: "terracotta", 161: "oak_leaves", 162: "oak_log", 172: "terracotta"
};

export const legacyBlockName = (id: number) => id === 0 ? "air" : legacy[id] || "stone";

// The surface scan asks these two questions once per block column, so the answers
// are cached: a regex per block was a tenth of the whole tile.
const airs = new Set(["air", "cave_air", "void_air", "structure_void", "light", "barrier"]);
const air: Record<string, boolean> = {};
export function isAir(name: string) {
  const cached = air[name];
  if (cached !== undefined) return cached;
  const bare = name.replace(/^minecraft:/, "");
  const value = airs.has(bare);
  air[name] = value;
  return value;
}

const colorCache = new Map<string, number>();
export function blockColor(block: string): number {
  const cached = colorCache.get(block);
  if (cached !== undefined) return cached;
  const value = colorOf(block);
  if (colorCache.size > 4096) colorCache.clear();
  colorCache.set(block, value);
  return value;
}

function colorOf(block: string): number {
  const name = block.replace(/^.*:/, "");
  if (named[name] !== undefined) return named[name];
  if (name.includes("cherry_leaves")) return 0xd99bb6;
  if (name.includes("pale_oak_leaves")) return 0x8f9783;
  if (/leaves|vine|azalea|moss|grass|sapling|cactus/.test(name)) return 0x568a37;
  for (const [wood, color] of Object.entries(woods)) if (name.startsWith(wood + "_") || name.startsWith("stripped_" + wood + "_")) return color;
  for (const [dye, color] of Object.entries(dyes)) if (name.startsWith(dye + "_")) return color;
  if (/sandstone/.test(name)) return 0xd0bd83;
  if (/terracotta/.test(name)) return 0x986349;
  if (/quartz/.test(name)) return 0xe5dfd0;
  if (/purpur/.test(name)) return 0xa87da8;
  if (/glass/.test(name)) return 0xc1d6d6;
  if (/planks|log|wood|chest|barrel|bookshelf/.test(name)) return 0x97794b;
  if (/stone|ore|brick|slab|stairs|wall|concrete/.test(name)) return 0x858581;
  return 0x9c9988;
}
