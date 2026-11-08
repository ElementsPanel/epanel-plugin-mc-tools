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
  /** False when no readable server.properties exists, so the map stays quiet. */
  rconConfigured?: boolean;
  players: MapPlayer[];
  warnings: string[];
  /** Live time of day in ticks (0–23999), keyed by saved world ID. */
  worldTimes?: Record<string, number>;
  /** Server sample identity/time; preserved by caches so clients can infer clock speed. */
  worldTimeSampledAt?: number;
}
export interface EnableRconResult { changed: boolean; restartRequested: boolean }
