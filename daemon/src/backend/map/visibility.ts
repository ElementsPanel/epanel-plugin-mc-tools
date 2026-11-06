import { consoleLine } from "../players/console";

/** One entity holds the hidden players of every instance, keyed by instance UUID. */
const CATEGORY = "McToolsMapVisibility";
const ENTITY = "hidden-players";
const MAX_INSTANCES = 256;
const MAX_HIDDEN = 512;
const MAX_LINE = 4096;
const PLAYER_NAME = /^[\p{L}\p{N}_.-]{1,32}$/u;
const NONE: ReadonlyMap<string, string> = new Map();

export interface VisibilityInstance {
  on(event: string, callback: (...args: any[]) => void): unknown;
  off(event: string, callback: (...args: any[]) => void): unknown;
}

/** The daemon's `ctx.storage` service; it writes atomically and synchronously. */
export interface VisibilityStorage {
  load<T>(category: string, type: new () => T, entity: string): T | null;
  store(category: string, entity: string, value: unknown): unknown;
}

export class MapVisibilityState {
  entries: { instanceUuid: string; names: string[] }[] = [];
}

export interface VisibilityHooks {
  /** The roster for this instance changed and its cache must be dropped. */
  changed(instanceId: string): void;
  /** The player asked for a state, so they get a private confirmation. */
  confirm(instanceId: string, name: string, hidden: boolean): void;
}

interface Entry {
  instance: VisibilityInstance;
  buffer: string;
  onData(chunk: unknown): void;
  onExit(): void;
}

/** Chat reaches the console as `<Player> text`, optionally behind log prefixes and `[Not Secure]`. */
export function mapCommand(text: string) {
  if (!text.includes("$mappos")) return;
  const match = consoleLine(text)
    .match(/^(?:\[[^\]\r\n]{0,120}\]\s*:?\s*){0,4}<([\p{L}\p{N}_.-]{1,32})>\s*\$mappos\s+(on|off)\s*$/iu);
  return match ? { name: match[1], hidden: match[2].toLowerCase() === "off" } : undefined;
}

/** Tracks `$mappos on|off` typed in chat, one console listener per instance. */
export class MapPlayerVisibility {
  private readonly listeners = new Map<string, Entry>();
  private readonly hidden = new Map<string, Map<string, string>>();
  private disposed = false;

  constructor(private readonly hooks: VisibilityHooks, private readonly storage?: VisibilityStorage) {
    this.restore();
  }

  track(instanceId: string, instance: VisibilityInstance) {
    if (this.disposed || !instanceId || this.listeners.has(instanceId)) return;
    const entry: Entry = {
      instance, buffer: "",
      onData: chunk => this.receive(instanceId, String(chunk)),
      onExit: () => { entry.buffer = ""; }
    };
    this.listeners.set(instanceId, entry);
    instance.on("data", entry.onData);
    instance.on("exit", entry.onExit);
  }

  /** Lower-cased names that asked to stay off the map. */
  hiddenPlayers(instanceId: string): ReadonlyMap<string, string> {
    return this.hidden.get(instanceId) ?? NONE;
  }

  dispose() {
    this.disposed = true;
    for (const [id, entry] of this.listeners) {
      entry.instance.off("data", entry.onData);
      entry.instance.off("exit", entry.onExit);
      this.listeners.delete(id);
    }
    this.hidden.clear();
  }

  private restore() {
    if (!this.storage) return;
    try {
      const state = this.storage.load(CATEGORY, MapVisibilityState, ENTITY);
      for (const entry of (state?.entries ?? []).slice(0, MAX_INSTANCES)) {
        if (typeof entry?.instanceUuid !== "string" || !entry.instanceUuid) continue;
        const names = new Map<string, string>();
        for (const name of (Array.isArray(entry.names) ? entry.names : []).slice(0, MAX_HIDDEN)) {
          if (typeof name !== "string" || !PLAYER_NAME.test(name) || names.has(name.toLowerCase())) continue;
          names.set(name.toLowerCase(), name);
        }
        if (names.size) this.hidden.set(entry.instanceUuid, names);
      }
    } catch { /* A damaged entity simply starts empty. */ }
  }

  private persist() {
    if (!this.storage) return;
    try {
      const state = new MapVisibilityState();
      state.entries = [...this.hidden].map(([instanceUuid, names]) => ({ instanceUuid, names: [...names.values()] }));
      this.storage.store(CATEGORY, ENTITY, state);
    } catch { /* Keep the in-memory state when the disk is not writable. */ }
  }

  private receive(instanceId: string, text: string) {
    const entry = this.listeners.get(instanceId);
    if (this.disposed || !entry) return;
    entry.buffer += text;
    // A single console line never exceeds the RCON command limit; drop runaway output.
    if (entry.buffer.length > MAX_LINE * 4) entry.buffer = entry.buffer.slice(-MAX_LINE);
    let end: number;
    while ((end = entry.buffer.indexOf("\n")) !== -1) {
      const line = entry.buffer.slice(0, end);
      entry.buffer = entry.buffer.slice(end + 1);
      if (line.length > MAX_LINE) continue;
      const command = mapCommand(line);
      if (command) this.apply(instanceId, command.name, command.hidden);
    }
  }

  private apply(instanceId: string, name: string, hidden: boolean) {
    const key = name.toLowerCase(), names = this.hidden.get(instanceId);
    const changed = hidden ? !names?.has(key) : !!names?.has(key);
    if (changed) {
      if (hidden) {
        const target = names ?? new Map<string, string>();
        if (target.size >= MAX_HIDDEN) return;
        target.set(key, name);
        this.hidden.set(instanceId, target);
      } else {
        names!.delete(key);
        if (!names!.size) this.hidden.delete(instanceId);
      }
      this.persist();
      this.hooks.changed(instanceId);
    }
    this.hooks.confirm(instanceId, name, hidden);
  }
}
