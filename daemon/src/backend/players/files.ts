import fs from "node:fs/promises";
import path from "node:path";
import type { ManagedPlayer } from "../../../../shared/players";

export class PlayerRecords {
  private readonly rows = new Set<ManagedPlayer>();
  private readonly identities = new Map<string, ManagedPlayer>();

  add(data: { name?: unknown; uuid?: unknown; xuid?: unknown }, flags: Partial<ManagedPlayer> = {}) {
    const name = typeof data.name === "string" && /^[\p{L}\p{N}_.-][\p{L}\p{N}_ .-]{0,31}$/u.test(data.name) ? data.name : "";
    const uuid = typeof data.uuid === "string" && /^[a-f\d-]{32,36}$/i.test(data.uuid) ? data.uuid.toLowerCase() : undefined;
    const xuid = typeof data.xuid === "string" && /^\d{1,20}$/.test(data.xuid) ? data.xuid : undefined;
    if (!name && !uuid && !xuid) return;
    const identity = uuid ? "uuid:" + uuid : xuid ? "xuid:" + xuid : "name:" + name.toLowerCase();
    const named = name ? this.identities.get("name:" + name.toLowerCase()) : undefined;
    let row = this.identities.get(identity) || (named && (!uuid || !named.uuid || named.uuid === uuid) && (!xuid || !named.xuid || named.xuid === xuid) ? named : undefined);
    if (!row) {
      row = { id: identity, name, online: false, whitelisted: false, operator: false, banned: false };
      this.rows.add(row);
    }
    if (name) row.name = name;
    if (uuid) row.uuid = uuid;
    if (xuid) row.xuid = xuid;
    if (uuid || xuid) row.id = identity;
    Object.assign(row, flags);
    this.identities.set(identity, row);
    if (name) this.identities.set("name:" + name.toLowerCase(), row);
  }

  values() { return [...this.rows]; }
}

export async function savedPlayers(root: string, edition: "java" | "bedrock", warnings: Set<string>) {
  const records = new PlayerRecords();
  async function read(name: string): Promise<Record<string, unknown>[] | undefined> {
    try {
      const real = await fs.realpath(path.join(root, name));
      const relative = path.relative(root, real);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) throw new Error("outside");
      const file = await fs.open(real, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("size");
        const buffer = Buffer.alloc(stat.size);
        if ((await file.read(buffer, 0, buffer.length, 0)).bytesRead !== buffer.length) throw new Error("changed");
        const value = JSON.parse(buffer.toString("utf8").replace(/^\uFEFF/, ""));
        if (!Array.isArray(value) || value.length > 20_000 || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("format");
        return value;
      } finally { await file.close(); }
    } catch (error: any) {
      if (error?.code !== "ENOENT") warnings.add("MC_PLAYERS_FILES_PARTIAL");
      return undefined;
    }
  }
  if (edition === "java") {
    for (const row of await read("usercache.json") || []) records.add(row);
    for (const row of await read("whitelist.json") || []) records.add(row, { whitelisted: true });
    for (const row of await read("ops.json") || []) records.add(row, { operator: true });
    for (const row of await read("banned-players.json") || []) {
      const expires = typeof row.expires === "string" ? Date.parse(row.expires) : NaN;
      if (Number.isFinite(expires) && expires <= Date.now()) continue;
      records.add(row, { banned: true, banReason: typeof row.reason === "string" ? row.reason.slice(0, 512) : "" });
    }
  } else {
    for (const row of await read("permissions.json") || []) records.add(row, { operator: row.permission === "operator" });
    const allowlist = await read("allowlist.json") ?? await read("whitelist.json") ?? [];
    for (const row of allowlist) records.add(row, { whitelisted: true });
  }
  return records;
}
