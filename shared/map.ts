export const MAP_TILE_SIZE = 128;
export const MAP_WORLDS_EVENT = "mc-tools/map/worlds";
export const MAP_TILE_EVENT = "mc-tools/map/tile";
export const MAP_LIMIT = 30_000_000;
// Both save readers address sections with a signed byte (16 blocks per section).
export const MAP_MIN_Y = -2048;
export const MAP_MAX_Y = 2047;

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

/** Omitting Y keeps the surface view; a number selects an exact horizontal slice. */
export function mapHeight(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MAP_MIN_Y || value > MAP_MAX_Y) {
    throw new Error("MC_MAP_INVALID");
  }
  return value;
}
