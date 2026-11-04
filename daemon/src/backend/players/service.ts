import fs from "node:fs/promises";
import { PLAYER_ACTIONS, playerName, playerOperation, type EnableQueryResult, type PlayerOperation, type PlayerRoster } from "../../../../shared/players";
import { onlineParser, operationParser, requestConsole, type PlayerCommandInstance } from "./console";
import { savedPlayers } from "./files";
import { requestJavaQuery } from "./query";
import { enableJavaQuery, javaQueryConfiguration } from "./query-config";

interface PlayerInstance extends PlayerCommandInstance {
  config: { type?: string; pingConfig?: { ip?: string } };
  absoluteCwdPath(): string;
  lock?: boolean;
}

export function playerCommand(operation: PlayerOperation, edition: "java" | "bedrock") {
  const target = (value: string) => {
    playerName(value);
    if (edition === "bedrock") return `"${value}"`;
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(value)) throw new Error("MC_PLAYERS_INVALID_NAME");
    return value;
  };
  const name = target(operation.player);
  const reason = operation.reason ? " " + operation.reason : "";
  switch (operation.action) {
    case "kick": return "kick " + name + reason;
    case "ban":
    case "pardon":
      if (edition === "bedrock") throw new Error("MC_PLAYERS_ACTION_UNSUPPORTED");
      return operation.action + " " + name + (operation.action === "ban" ? reason : "");
    case "whitelist-add":
    case "whitelist-remove": return (edition === "java" ? "whitelist" : "allowlist") + (operation.action === "whitelist-add" ? " add " : " remove ") + name;
    case "op":
    case "deop": return operation.action + " " + name;
    case "gamemode": return "gamemode " + operation.mode + " " + name;
    case "teleport": {
      const destination = operation.destination!;
      const location = "player" in destination ? target(destination.player) : `${destination.x} ${destination.y} ${destination.z}`;
      return "tp " + name + " " + location;
    }
  }
}

export class PlayerManagementService {
  private readonly active = new Set<string>();
  private readonly cancellations = new Set<() => void>();
  private disposed = false;

  constructor(private readonly instances: { getInstance(id: string): any }, private readonly timeout = 8000) {}

  private instance(id: string): { instance: PlayerInstance; edition: "java" | "bedrock" } {
    if (this.disposed) throw new Error("MC_PLAYERS_UNAVAILABLE");
    const instance = this.instances.getInstance(id) as PlayerInstance | undefined;
    if (!instance) throw new Error("MC_PLAYERS_INSTANCE_MISSING");
    const type = String(instance.config.type);
    if ((!type.startsWith("minecraft/java") && !type.startsWith("minecraft/bedrock")) || type.includes("bungeecord") || type.includes("velocity")) throw new Error("MC_PLAYERS_UNSUPPORTED_INSTANCE");
    return { instance, edition: type.startsWith("minecraft/bedrock") ? "bedrock" : "java" };
  }

  private async exclusive<T>(id: string, callback: () => Promise<T>) {
    if (this.disposed) throw new Error("MC_PLAYERS_UNAVAILABLE");
    if (this.active.has(id) || this.active.size >= 16) throw new Error("MC_PLAYERS_BUSY");
    this.active.add(id);
    try { return await callback(); }
    finally { this.active.delete(id); }
  }

  private async queryPlayers(instance: PlayerInstance, target: { host: string; port: number }) {
    const abort = new AbortController();
    const cancel = () => abort.abort(new Error("MC_PLAYERS_UNAVAILABLE"));
    const onExit = () => abort.abort(new Error("MC_PLAYERS_NOT_RUNNING"));
    this.cancellations.add(cancel);
    instance.on("exit", onExit);
    try {
      abort.signal.throwIfAborted();
      if (instance.status() !== 3) throw new Error("MC_PLAYERS_NOT_RUNNING");
      return await requestJavaQuery(target.host, target.port, abort.signal, this.timeout);
    } finally {
      instance.off("exit", onExit);
      this.cancellations.delete(cancel);
    }
  }

  async list(id: string): Promise<PlayerRoster> {
    return this.exclusive(id, async () => {
      const { instance, edition } = this.instance(id);
      const root = await fs.realpath(instance.absoluteCwdPath());
      const warnings = new Set<string>();
      const records = await savedPlayers(root, edition, warnings);
      if (this.disposed) throw new Error("MC_PLAYERS_UNAVAILABLE");
      let query: Awaited<ReturnType<typeof javaQueryConfiguration>> | undefined;
      let queryError: unknown;
      if (edition === "java") {
        try {
          query = await javaQueryConfiguration(root, instance.config.pingConfig?.ip);
          if (!query.enabled) throw new Error("MC_PLAYERS_QUERY_DISABLED");
        } catch (error) {
          queryError = error;
          warnings.add(error instanceof Error ? error.message : "MC_PLAYERS_QUERY_CONFIG");
        }
      }
      if (this.disposed) throw new Error("MC_PLAYERS_UNAVAILABLE");
      let running = instance.status() === 3;
      let onlineAvailable = !running, maxPlayers = 0;
      if (running) {
        try {
          if (edition === "java" && queryError) throw queryError;
          const online = edition === "java" ? await this.queryPlayers(instance, query!)
            : await requestConsole(instance, "list", onlineParser(), this.cancellations, this.timeout);
          if (this.disposed) throw new Error("MC_PLAYERS_UNAVAILABLE");
          running = instance.status() === 3;
          if (running) {
            for (const name of online.names) records.add({ name }, { online: true });
            maxPlayers = online.maxPlayers;
          }
          onlineAvailable = true;
        } catch (error) {
          if (this.disposed) throw error;
          running = instance.status() === 3;
          onlineAvailable = !running;
          if (running) {
            if (edition === "java") {
              const message = error instanceof Error ? error.message : "";
              warnings.add(/^MC_PLAYERS_QUERY_(?:CONFIG|DISABLED|RESPONSE|UNAVAILABLE)$/.test(message) ? message : "MC_PLAYERS_QUERY_UNAVAILABLE");
            } else warnings.add("MC_PLAYERS_ONLINE_UNAVAILABLE");
          }
        }
      }
      const players = records.values();
      if (!onlineAvailable) for (const player of players) player.online = null;
      players.sort((a, b) => Number(b.online) - Number(a.online) || (a.name || a.uuid || a.xuid || "").localeCompare(b.name || b.uuid || b.xuid || ""));
      const actions = PLAYER_ACTIONS.filter(action => edition === "java" || (action !== "ban" && action !== "pardon"));
      return { edition, running, onlineAvailable, maxPlayers, players, actions: [...actions], warnings: [...warnings], ...(query ? { queryEnabled: query.enabled } : {}) };
    });
  }

  async action(id: string, value: unknown) {
    // Validate before sending anything to a server, even for direct daemon callers.
    const operation = playerOperation(value);
    return this.exclusive(id, async () => {
      const { instance, edition } = this.instance(id);
      if (instance.status() !== 3) throw new Error("MC_PLAYERS_NOT_RUNNING");
      return requestConsole(instance, playerCommand(operation, edition), operationParser(operation), this.cancellations, this.timeout);
    });
  }

  async enableQuery(id: string, confirmed: unknown): Promise<EnableQueryResult> {
    if (confirmed !== true) throw new Error("MC_PLAYERS_INVALID");
    return this.exclusive(id, async () => {
      const { instance, edition } = this.instance(id);
      if (edition !== "java") throw new Error("MC_PLAYERS_ACTION_UNSUPPORTED");
      const root = await fs.realpath(instance.absoluteCwdPath());
      const ready = () => {
        if (this.disposed) throw new Error("MC_PLAYERS_UNAVAILABLE");
        if (instance.lock || ![0, 3].includes(instance.status())) throw new Error("MC_PLAYERS_BUSY");
      };
      const changed = await enableJavaQuery(root, ready);
      if (!changed) return { changed: false, restartRequested: false };
      try {
        ready();
        await instance.execPreset("restart");
      } catch { throw new Error("MC_PLAYERS_QUERY_RESTART_FAILED"); }
      return { changed: true, restartRequested: true };
    });
  }

  dispose() {
    this.disposed = true;
    for (const cancel of [...this.cancellations]) cancel();
  }
}
