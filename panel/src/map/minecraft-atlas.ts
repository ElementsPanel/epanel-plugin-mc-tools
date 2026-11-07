export const minecraftAtlasUrl = () => new URL("../assets/minecraft/atlas.png", import.meta.url).href;
/** The straw bed ships at 64×64; keep it out of the 16×16 atlas so its detail survives. */
export const strawBedUrl = () => new URL("../assets/minecraft/straw_bed.png", import.meta.url).href;
