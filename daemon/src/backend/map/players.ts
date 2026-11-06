import fs from "node:fs/promises";
import path from "node:path";
import { MAP_MAX_PLAYERS, type EnableRconResult, type MapPlayer, type MapPlayerRoster } from "../../../../shared/map-players";
import { consoleLine, onlineParser, type PlayerCommandInstance } from "../players/console";
import { javaRconConfiguration, enableJavaRcon } from "./rcon-config";
import { RconConnection, type RconTarget } from "./rcon";
import type { SavedWorld } from "./worlds";

interface Instance extends PlayerCommandInstance {
  config: { type?: string; pingConfig?: { ip?: string } };
  absoluteCwdPath(): string;
  lock?: boolean;
}
interface Session {
  instance: Instance; root: string; target: RconTarget; abort: AbortController;
  connection: RconConnection; onExit(): void;
}

function entityValues(text: string, names: Set<string>) {
  const values = new Map<string, string>();
  // Vanilla RCON can concatenate command messages without newline separators.
  const pattern = /([\p{L}\p{N}_.-]{1,32}) has the following entity data:\s*(\[[^\]\r\n]*\]|"(?:\\.|[^"\\])*"|-?\d+)/gu;
  for (const match of consoleLine(text).matchAll(pattern)) if (names.has(match[1])) values.set(match[1], match[2]);
  return values;
}

function numbers(value: string | undefined, length: number) {
  if (!value?.startsWith("[")) return;
  const values = value.slice(1, -1).replace(/^[DF];\s*/i, "").split(",").map(part => part.trim());
  if (values.length !== length || values.some(part => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[df]?$/i.test(part))) return;
  const result = values.map(part => Number(part.replace(/[df]$/i, "")));
  return result.every(Number.isFinite) ? result : undefined;
}

export async function readRconPlayers(command: (value: string) => Promise<string>) {
  const parse = onlineParser();
  let online: ReturnType<typeof parse>;
  for (const line of (await command("list")).split(/\r?\n/)) online = parse(consoleLine(line)) ?? online;
  if (!online) throw new Error("MC_MAP_RCON_RESPONSE");
  const names = new Set(online.names.slice(0, MAP_MAX_PLAYERS));
  const players: MapPlayer[] = [...names].map(name => ({ name }));
  const warnings: string[] = online.names.length > MAP_MAX_PLAYERS ? ["MC_MAP_PLAYERS_LIMIT"] : [];
  if (!players.length) return { players, warnings };
  const values = async (field: string) => {
    let result = entityValues(await command("execute as @a run data get entity @s " + field), names);
    if (!result.size) result = entityValues(await command("execute as @a run data get entity @s " + field.toLowerCase()), names);
    return result;
  };
  const positions = await values("Pos"), dimensions = await values("Dimension"), rotations = await values("Rotation");
  for (const player of players) {
    const xyz = numbers(positions.get(player.name), 3), rotation = numbers(rotations.get(player.name), 2);
    let dimension = dimensions.get(player.name);
    if (dimension?.startsWith('"')) { try { dimension = JSON.parse(dimension); } catch { dimension = undefined; } }
    else dimension = ({ "0": "minecraft:overworld", "-1": "minecraft:the_nether", "1": "minecraft:the_end" } as Record<string, string>)[dimension ?? ""];
    if (xyz && Math.abs(xyz[0]) <= 30_000_000 && Math.abs(xyz[2]) <= 30_000_000 && Math.abs(xyz[1]) <= 2048
      && dimension && /^[a-z0-9_.-]+:[a-z0-9_./-]{1,128}$/.test(dimension)) {
      player.position = { x: xyz[0], y: xyz[1], z: xyz[2], dimension, ...(rotation ? { yaw: ((rotation[0] % 360) + 360) % 360 } : {}) };
    }
  }
  if (players.some(player => !player.position)) warnings.push("MC_MAP_PLAYERS_POSITION_UNAVAILABLE");
  return { players, warnings };
}

function playerWorld(worlds: SavedWorld[], dimension: string, levelName: string) {
  const candidates = worlds.filter(world => world.dimension === dimension);
  const suffix = dimension === "minecraft:the_nether" ? "_nether" : dimension === "minecraft:the_end" ? "_the_end" : "";
  return candidates.find(world => {
    const relative = path.relative(world.root, world.directory).split(path.sep).join("/");
    return [levelName, levelName + suffix].some(name => relative === name || relative.startsWith(name + "/"));
  }) ?? (candidates.length === 1 ? candidates[0] : undefined);
}

export class MapPlayerService {
  private disposed = false;
  private revision = 0;
  private readonly enabling = new Set<string>();
  private readonly pending = new Map<string, Promise<MapPlayerRoster>>();
  private readonly cache = new Map<string, { at: number; value: MapPlayerRoster }>();
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly instances: { getInstance(id: string): any }, private readonly worlds: (id: string) => Promise<SavedWorld[]>, private readonly timeout = 8000) {}

  private instance(id: string) {
    if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
    const instance = this.instances.getInstance(id) as Instance | undefined;
    if (!instance) throw new Error("MC_MAP_INSTANCE_MISSING");
    const type = instance.config.type || "";
    if (!/^minecraft\/(?:java|bedrock)/.test(type) || /bungeecord|velocity/.test(type)) throw new Error("MC_MAP_UNSUPPORTED_INSTANCE");
    return instance;
  }

  private closeSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.instance.off("exit", session.onExit);
    session.abort.abort(); session.connection.close();
  }

  private session(id: string, instance: Instance, root: string, target: RconTarget) {
    if (this.disposed || instance.status() !== 3) throw new Error("MC_MAP_RCON_UNAVAILABLE");
    if (this.enabling.has(id)) throw new Error("MC_MAP_RCON_BUSY");
    const current = this.sessions.get(id);
    if (current && !current.connection.closed && current.instance === instance && current.root === root
      && current.target.host === target.host && current.target.port === target.port && current.target.password === target.password) return current;
    this.closeSession(id);
    const abort = new AbortController();
    const connection = new RconConnection(target, abort.signal, this.timeout);
    const onExit = () => {
      this.closeSession(id);
      this.revision++;
      for (const key of this.cache.keys()) if (key.startsWith(id + ":")) this.cache.delete(key);
    };
    const session = { instance, root, target, abort, connection, onExit };
    this.sessions.set(id, session); instance.on("exit", onExit);
    return session;
  }

  async list(id: string, worldId?: string): Promise<MapPlayerRoster> {
    const instance = this.instance(id), key = id + ":" + instance.absoluteCwdPath();
    if (this.enabling.has(id)) throw new Error("MC_MAP_RCON_BUSY");
    const cached = this.cache.get(key);
    let value: MapPlayerRoster;
    if (cached && Date.now() - cached.at < 2000 && cached.value.running === (instance.status() === 3)) value = cached.value;
    else {
      let pending = this.pending.get(key);
      if (!pending) {
        if (this.pending.size >= 16) throw new Error("MC_MAP_RCON_BUSY");
        const revision = this.revision;
        pending = this.read(id, instance).then(value => {
          if (!this.disposed && revision === this.revision) {
            this.cache.set(key, { at: Date.now(), value });
            if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
          }
          return value;
        }).finally(() => { if (this.pending.get(key) === pending) this.pending.delete(key); });
        this.pending.set(key, pending);
      }
      value = await pending;
    }
    if (!worldId) return value;
    if (!(await this.worlds(id)).some(world => world.id === worldId)) throw new Error("MC_MAP_WORLD_MISSING");
    return { ...value, players: value.players.filter(player => player.position?.world === worldId) };
  }

  private async read(id: string, instance: Instance): Promise<MapPlayerRoster> {
    const edition = instance.config.type?.startsWith("minecraft/bedrock") ? "bedrock" : "java";
    const roster: MapPlayerRoster = { edition, running: instance.status() === 3, rconEnabled: false, players: [], warnings: [] };
    if (edition === "bedrock") { this.closeSession(id); roster.warnings.push("MC_MAP_RCON_UNSUPPORTED"); return roster; }
    let root: string, target: Awaited<ReturnType<typeof javaRconConfiguration>>;
    try {
      root = await fs.realpath(instance.absoluteCwdPath());
      target = await javaRconConfiguration(root, instance.config.pingConfig?.ip);
    } catch (error) { this.closeSession(id); throw error; }
    roster.rconEnabled = target.enabled;
    if (!target.enabled || !roster.running) { this.closeSession(id); return roster; }
    let session: Session | undefined;
    try {
      session = this.session(id, instance, root, target);
      Object.assign(roster, await session.connection.run(readRconPlayers));
      const worlds = await this.worlds(id);
      session.abort.signal.throwIfAborted();
      for (const player of roster.players) if (player.position) player.position.world = playerWorld(worlds, player.position.dimension, target.levelName)?.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      roster.players = [];
      roster.warnings.push(/^MC_MAP_RCON_[A-Z_]+$/.test(message) ? message : "MC_MAP_RCON_UNAVAILABLE");
    } finally { if (session?.connection.closed && this.sessions.get(id) === session) this.closeSession(id); }
    roster.running = instance.status() === 3;
    if (!roster.running) { roster.players = []; roster.warnings = []; }
    if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
    return roster;
  }

  async enable(id: string, confirmed: unknown): Promise<EnableRconResult> {
    if (confirmed !== true) throw new Error("MC_MAP_INVALID");
    const instance = this.instance(id);
    if (!instance.config.type?.startsWith("minecraft/java")) throw new Error("MC_MAP_RCON_UNSUPPORTED");
    if (this.enabling.has(id) || this.enabling.size >= 16) throw new Error("MC_MAP_RCON_BUSY");
    this.enabling.add(id);
    const key = id + ":" + instance.absoluteCwdPath();
    this.revision++;
    this.pending.delete(key); this.cache.delete(key);
    try {
      const ready = () => {
        if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
        if (instance.lock || ![0, 3].includes(instance.status())) throw new Error("MC_MAP_RCON_BUSY");
      };
      ready();
      const changed = await enableJavaRcon(await fs.realpath(instance.absoluteCwdPath()), ready);
      if (!changed) return { changed: false, restartRequested: false };
      this.closeSession(id);
      try { ready(); await instance.execPreset("restart"); }
      catch { throw new Error("MC_MAP_RCON_RESTART_FAILED"); }
      return { changed: true, restartRequested: true };
    } finally { this.enabling.delete(id); }
  }

  dispose() { this.disposed = true; for (const id of this.sessions.keys()) this.closeSession(id); this.cache.clear(); }
}
