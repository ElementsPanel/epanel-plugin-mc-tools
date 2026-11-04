export const PLAYERS_LIST_EVENT = "mc-tools/players/list";
export const PLAYERS_ACTION_EVENT = "mc-tools/players/action";
export const PLAYERS_ENABLE_QUERY_EVENT = "mc-tools/players/query-enable";

export const PLAYER_ACTIONS = ["kick", "ban", "pardon", "whitelist-add", "whitelist-remove", "op", "deop", "gamemode", "teleport"] as const;
export const PLAYER_GAME_MODES = ["survival", "creative", "adventure", "spectator"] as const;
export type PlayerAction = typeof PLAYER_ACTIONS[number];
export type PlayerGameMode = typeof PLAYER_GAME_MODES[number];

export interface PlayerOperation {
  action: PlayerAction;
  player: string;
  reason?: string;
  mode?: PlayerGameMode;
  destination?: { player: string } | { x: number; y: number; z: number };
}

export interface ManagedPlayer {
  id: string;
  name: string;
  uuid?: string;
  xuid?: string;
  online: boolean | null;
  whitelisted: boolean;
  operator: boolean;
  banned: boolean;
  banReason?: string;
}

export interface PlayerRoster {
  edition: "java" | "bedrock";
  running: boolean;
  onlineAvailable: boolean;
  maxPlayers: number;
  players: ManagedPlayer[];
  actions: PlayerAction[];
  warnings: string[];
  queryEnabled?: boolean;
}

export interface EnableQueryResult { changed: boolean; restartRequested: boolean }

export interface PlayerOperationResult { ok: boolean; message: string }

export function playerName(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !/^[\p{L}\p{N}_.-][\p{L}\p{N}_ .-]{0,31}$/u.test(value)) throw new Error("MC_PLAYERS_INVALID_NAME");
  return value;
}

export function playerOperation(value: unknown): PlayerOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MC_PLAYERS_INVALID");
  const data = value as Record<string, unknown>;
  if (!PLAYER_ACTIONS.includes(data.action as PlayerAction)) throw new Error("MC_PLAYERS_INVALID");
  const result: PlayerOperation = { action: data.action as PlayerAction, player: playerName(data.player) };
  if (result.action === "kick" || result.action === "ban") {
    if (data.reason !== undefined && (typeof data.reason !== "string" || data.reason.length > 200 || /[\x00-\x1f\x7f\u2028\u2029]/.test(data.reason))) throw new Error("MC_PLAYERS_INVALID_REASON");
    result.reason = typeof data.reason === "string" ? data.reason.trim() : "";
  }
  if (result.action === "gamemode") {
    if (!PLAYER_GAME_MODES.includes(data.mode as PlayerGameMode)) throw new Error("MC_PLAYERS_INVALID");
    result.mode = data.mode as PlayerGameMode;
  }
  if (result.action === "teleport") {
    if (!data.destination || typeof data.destination !== "object" || Array.isArray(data.destination)) throw new Error("MC_PLAYERS_INVALID_COORDINATES");
    const target = data.destination as Record<string, unknown>;
    if (Object.hasOwn(target, "player")) result.destination = { player: playerName(target.player) };
    else {
      const coordinate = (name: "x" | "y" | "z") => {
        const number = target[name];
        if (typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > (name === "y" ? 2048 : 30_000_000)) throw new Error("MC_PLAYERS_INVALID_COORDINATES");
        return number;
      };
      result.destination = { x: coordinate("x"), y: coordinate("y"), z: coordinate("z") };
    }
  }
  return result;
}
