export const MAP_TILE_SIZE = 128;
export const MAP_WORLDS_EVENT = "mc-tools/map/worlds";
export const MAP_TILE_EVENT = "mc-tools/map/tile";
export const MAP_SCENE_EVENT = "mc-tools/map/scene";
export const MAP_SCENE_SIZE = 32;
export const MAP_SCENE_MAX_QUADS = 65_536;
export const MAP_LIMIT = 30_000_000;
// Both save readers address sections with a signed byte (16 blocks per section).
export const MAP_MIN_Y = -2048;
export const MAP_MAX_Y = 2047;
export const MAP_PAGE_PATH = "/mc-tools/map";
export const MAP_SETTINGS_PATH = "/mc-tools/map/settings";

export interface MapViewOptions {
  world?: string;
  x?: number;
  z?: number;
  zoom?: number;
  render?: "3d";
}

export interface MapPageStatus { enabled: boolean }
export interface PublicMap { id: string; name: string }
export interface PublicMapSetting extends PublicMap { source: string }
export interface MapSettings { mapPageEnabled: boolean; publicMaps: PublicMapSetting[] }
export interface MapNode { id: string; name: string; available: boolean }
export interface MapInstance { id: string; name: string }
export interface MapInstances { page: number; maxPage: number; data: MapInstance[]; selected?: MapInstance }
export interface PublicMapCatalog extends MapPageStatus {
  maps: PublicMap[];
  /** Origins allowed to drive the embedded map; empty disables the bridge. */
  embedOrigins?: string[];
}
export interface PublicMapLinks extends MapPageStatus {
  canConfigure: boolean;
  maps: (PublicMap & { world: string })[];
}

export function mapSource(daemonId: string, instanceUuid: string, world: string) {
  return `${daemonId}/${instanceUuid}/${world}`;
}

export function parseMapSource(value: unknown) {
  if (typeof value !== "string") throw new Error("MC_MAP_PAGE_SETTINGS_INVALID");
  const parts = value.trim().split("/");
  if (parts.length !== 3 || !/^[\w-]{1,128}$/.test(parts[0]) || !/^[\w-]{1,128}$/.test(parts[1]) || !/^[a-f0-9]{24}$/.test(parts[2])) {
    throw new Error("MC_MAP_PAGE_SETTINGS_INVALID");
  }
  return { daemonId: parts[0], instanceUuid: parts[1], world: parts[2] };
}

export function publicMapId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error("MC_MAP_INVALID");
  return value;
}

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

/** Local block geometry, independent of private world/instance identifiers. */
export interface MapSceneTile {
  version: 1;
  // Each 16-byte quad: x:u8, z:u8, y:i16le, width:u16le, height:u16le,
  // face:u8 (+X,-X,+Y,-Y,+Z,-Z,cross A,cross B), flags:u8, atlas sprite:u16le,
  // biome tint RGB:u8[3], four corner occlusion values packed as u2[4].
  // Fire model markers use the occlusion byte for north/east/south/west/up attachment bits.
  quads?: string;
  // Optional 12 bytes per quad: four RGB corners in order 00,10,11,01.
  tints?: string;
  // Legacy cached format: four (RGB, skylight, blocklight) corners. Only RGB is used.
  shading?: string;
  // 32 × 32 surface heights, signed i16le; -32768 denotes an empty column.
  heights?: string;
  // Compressed form: base64 gzip of u32le quadBytes, u32le tintBytes, u32le heightBytes
  // followed by the three buffers. A tile carries either this or the three fields above.
  gzip?: true;
  payload?: string;
  chunks: number;
  warnings: number;
  limited: boolean;
}

export function mapSceneCoordinate(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > Math.ceil(MAP_LIMIT / MAP_SCENE_SIZE)) {
    throw new Error("MC_MAP_INVALID");
  }
  return value;
}

export function mapCoordinate(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > Math.ceil(MAP_LIMIT / MAP_TILE_SIZE)) {
    throw new Error("MC_MAP_INVALID");
  }
  return value;
}
