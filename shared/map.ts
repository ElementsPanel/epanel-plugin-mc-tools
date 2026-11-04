export const MAP_TILE_SIZE = 128;
export const MAP_WORLDS_EVENT = "mc-tools/map/worlds";
export const MAP_TILE_EVENT = "mc-tools/map/tile";
export const MAP_LIMIT = 30_000_000;

export interface MapWorld {
  id: string;
  name: string;
  dimension: string;
  spawn: { x: number; z: number };
}

export interface MapTile {
  image: string;
  chunks: number;
  warnings: number;
}

export function mapCoordinate(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > Math.ceil(MAP_LIMIT / MAP_TILE_SIZE)) {
    throw new Error("MC_MAP_INVALID");
  }
  return value;
}
