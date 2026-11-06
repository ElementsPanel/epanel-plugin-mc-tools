import type { MinecraftBlock } from "./scene";

export const FIRE_DIRECTIONS = ["north", "east", "south", "west", "up"] as const;

export function fireConnections(properties?: Readonly<Record<string, string>>) {
  return FIRE_DIRECTIONS.reduce((mask, name, i) => mask | (properties?.[name] === "true" ? 1 << i : 0), 0);
}

/** Select all applicable multipart pieces; age never changes fire geometry. */
export function fireElements(model: MinecraftBlock, connections: number, seed = 0) {
  return model.fire!.flatMap((part, i) => part.connections.includes(connections)
    ? part.variants[(seed + i) % part.variants.length] : []);
}
