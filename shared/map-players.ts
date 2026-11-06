export const MAP_PLAYERS_EVENT = "mc-tools/map/players";
export const MAP_RCON_ENABLE_EVENT = "mc-tools/map/rcon-enable";
export const MAP_MAX_PLAYERS = 512;

export interface MapPlayer {
  name: string;
  position?: { x: number; y: number; z: number; dimension: string; yaw?: number; world?: string };
}
export interface MapPlayerRoster {
  edition: "java" | "bedrock";
  running: boolean;
  rconEnabled: boolean;
  players: MapPlayer[];
  warnings: string[];
}
export interface EnableRconResult { changed: boolean; restartRequested: boolean }
