import { stripVTControlCharacters } from "node:util";
import type { PlayerOperation, PlayerOperationResult } from "../../../../shared/players";

export interface PlayerCommandInstance {
  status(): number;
  execPreset(name: string, parameter?: unknown): Promise<unknown>;
  on(event: string, callback: (...args: any[]) => void): unknown;
  off(event: string, callback: (...args: any[]) => void): unknown;
}

export function consoleLine(value: string) {
  return stripVTControlCharacters(value).replace(/§[0-9a-fk-orx]/gi, "").trim()
    .replace(/^>\s*/, "")
    // Vanilla uses `[HH:mm:ss] [thread/INFO]:`; Spigot, Paper and Velocity merge the
    // level into the time bracket as `[HH:mm:ss INFO]:`; Forge starts with `[06Nov2026 20:51:01.533]`.
    .replace(/^(?:\[(?:\d{2}:\d{2}:\d{2}(?:\s+[A-Z]{3,8})?|\d{2}[A-Z]{3}\d{4}\s[^\]\r\n]*|[^\]\r\n]{0,80}\/[^\]\r\n]{0,40}|(?:INFO|WARN|ERROR)|\d{4}-\d{2}-\d{2}[^\]\r\n]*)\]\s*:?\s*)+/i, "");
}

export interface OnlinePlayers { names: string[]; maxPlayers: number }

/** The list response can span multiple lines on Bedrock and arrive in fragments. */
export function onlineParser() {
  let count: number | undefined, maximum = 0;
  const names: string[] = [];
  return (line: string): OnlinePlayers | undefined => {
    const header = line.match(/^There are (\d+)(?: of a max of | out of maximum |\/)(\d+) players? online:\s*(.*)$/i);
    if (header) {
      count = Number(header[1]); maximum = Number(header[2]); names.length = 0;
      if (count > 10_000 || maximum > 1_000_000) throw new Error("MC_PLAYERS_INVALID_RESPONSE");
      line = header[3];
    } else if (count === undefined) return;
    if (line) {
      const items = line.split(/,\s*/).map(name => name.trim()).filter(Boolean);
      if (items.some(name => !/^[\p{L}\p{N}_.-][\p{L}\p{N}_ .-]{0,31}$/u.test(name))) return;
      names.push(...items);
    }
    if (count !== undefined && names.length === count) return { names: [...new Set(names)], maxPlayers: maximum };
  };
}

const failure = /^(?:Unknown (?:or incomplete )?command|Incorrect argument|Invalid |Usage:|Syntax error|No (?:player|entity|targets?) (?:was |were )?(?:found|matched)|No targets matched|Player .* (?:not found|does not exist)|That player does not exist|Could not |Cannot |Can't |Nothing changed|You do not have permission|You don't have permission|Commands are not enabled|(?:That |The )?player is (?:already|not)|.+ is (?:already|not) (?:on|in|an operator|banned)|.+ is not a valid)/i;

export function operationParser(operation: PlayerOperation) {
  const verbs: Record<PlayerOperation["action"], RegExp> = {
    kick: /^Kicked\b/i,
    ban: /^Banned\b/i,
    pardon: /^(?:Unbanned|Pardoned)\b/i,
    "whitelist-add": /^(?:Added\b.*\b(?:whitelist|allowlist)|Player added to (?:the )?(?:whitelist|allowlist))/i,
    "whitelist-remove": /^(?:Removed\b.*\b(?:whitelist|allowlist)|Player removed from (?:the )?(?:whitelist|allowlist))/i,
    op: /^(?:Made\b(?!.*\bno longer\b).*\ba server operator|Opped\b|Gave operator status\b)/i,
    deop: /^(?:Made\b.*\bno longer a server operator|De-?opped\b|Revoked operator status\b)/i,
    gamemode: /^Set\b.*\bgame\s?mode\b/i,
    teleport: /^Teleported\b/i
  };
  return (line: string): PlayerOperationResult | undefined => {
    if (/^(?:<|\[Not Secure\]|\[Server\])/.test(line)) return;
    if (failure.test(line)) return { ok: false, message: line.slice(0, 512) };
    const target = operation.player.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mentionsPlayer = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${target}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(line);
    const bedrockAllowlist = /^Player (?:added to|removed from) (?:the )?(?:whitelist|allowlist)\.?$/i.test(line);
    if (verbs[operation.action].test(line) && (mentionsPlayer || bedrockAllowlist)) return { ok: true, message: line.slice(0, 512) };
  };
}

/** Listen before sending, and own every listener/timer until a response or unload. */
export function requestConsole<T>(instance: PlayerCommandInstance, command: string, parse: (line: string) => T | undefined, cancellations: Set<() => void>, timeout = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    let buffer = "", size = 0, settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      instance.off("data", onData);
      instance.off("exit", onExit);
      cancellations.delete(cancel);
    };
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve(value!);
    };
    const read = (text: string) => {
      try {
        const value = parse(consoleLine(text));
        if (value !== undefined) finish(undefined, value);
      } catch (error) { finish(error instanceof Error ? error : new Error("MC_PLAYERS_INVALID_RESPONSE")); }
    };
    const onData = (chunk: unknown) => {
      if (settled) return;
      const text = String(chunk);
      size += text.length;
      if (size > 256 * 1024) { finish(new Error("MC_PLAYERS_NO_RESPONSE")); return; }
      buffer += text;
      let end: number;
      while (!settled && (end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); read(line);
      }
    };
    const onExit = () => finish(new Error("MC_PLAYERS_NOT_RUNNING"));
    const cancel = () => finish(new Error("MC_PLAYERS_UNAVAILABLE"));
    const timer = setTimeout(() => {
      if (buffer) read(buffer);
      if (!settled) finish(new Error("MC_PLAYERS_NO_RESPONSE"));
    }, timeout);
    cancellations.add(cancel);
    instance.on("data", onData);
    instance.on("exit", onExit);
    Promise.resolve().then(() => {
      if (settled) return;
      if (instance.status() !== 3) { onExit(); return; }
      return instance.execPreset("command", command);
    }).catch(() => finish(new Error("MC_PLAYERS_COMMAND_FAILED")));
  });
}
