import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { LevelDB } from "leveldb-zlib";
import { readSmall, safePath, type SavedWorld } from "./worlds";

interface Snapshot { db: LevelDB; directory: string }
interface Entry {
  promise: Promise<Snapshot>;
  users: number;
  usedAt: number;
  retired: boolean;
  closing?: Promise<void>;
}

async function copyLog(source: string, destination: string) {
  const input = await fs.open(source, "r");
  try {
    const stat = await input.stat();
    if (!stat.isFile()) throw new Error("MC_MAP_SNAPSHOT");
    const output = await fs.open(destination, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
        if (!bytesRead) throw new Error("MC_MAP_SNAPSHOT");
        let written = 0;
        while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written, offset + written)).bytesWritten;
        offset += bytesRead;
      }
    } finally { await output.close(); }
  } finally { await input.close(); }
}

/** Never open the live database: LevelDB recovery writes manifests and takes an exclusive lock. */
async function createSnapshot(world: SavedWorld): Promise<Snapshot> {
  let Constructor: typeof LevelDB;
  try { Constructor = (await import("leveldb-zlib")).LevelDB; }
  catch { throw new Error("MC_MAP_BEDROCK_READER"); }
  for (let attempt = 0; attempt < 3; attempt++) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "epanel-mc-map-"));
    let db: LevelDB | undefined;
    try {
      const source = await safePath(world.root, world.directory, "db");
      const current = await readSmall(world.root, path.join(source, "CURRENT"), 1024);
      const manifestName = current.toString("utf8").trim();
      if (!/^MANIFEST-\d+$/.test(manifestName)) throw new Error("MC_MAP_SNAPSHOT");
      const manifest = await readSmall(world.root, path.join(source, manifestName), 64 * 1024 * 1024);
      for (const item of await fs.readdir(source, { withFileTypes: true })) {
        if (!/^\d+\.(?:ldb|sst|log)$/.test(item.name)) continue;
        if (!item.isFile()) throw new Error("MC_MAP_SNAPSHOT");
        const filename = await safePath(world.root, source, item.name);
        const destination = path.join(directory, item.name);
        if (item.name.endsWith(".log")) await copyLog(filename, destination);
        else await fs.copyFile(filename, destination, constants.COPYFILE_FICLONE);
      }
      // A compaction or log rotation during copying requires a fresh file set.
      if (!(await readSmall(world.root, path.join(source, "CURRENT"), 1024)).equals(current) ||
          !(await readSmall(world.root, path.join(source, manifestName), 64 * 1024 * 1024)).equals(manifest)) throw new Error("MC_MAP_SNAPSHOT");
      await fs.writeFile(path.join(directory, "CURRENT"), current, { mode: 0o600 });
      await fs.writeFile(path.join(directory, manifestName), manifest, { mode: 0o600 });
      db = new Constructor(directory, { createIfMissing: false });
      await db.open();
      return { db, directory };
    } catch {
      try { await db?.close(); }
      finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
  }
  throw new Error("MC_MAP_SNAPSHOT");
}

export class BedrockSnapshots {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  private readonly timer = setInterval(() => this.expire(), 60_000).unref();

  async use<T>(world: SavedWorld, read: (db: LevelDB, stamp: string) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
    const key = world.directory;
    let entry = this.entries.get(key);
    if (!entry) {
      this.expire();
      if (this.entries.size >= 4) {
        const idle = [...this.entries].filter(([, value]) => !value.users).sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
        if (!idle) throw new Error("MC_MAP_BUSY");
        this.retire(idle[0], idle[1]);
      }
      entry = { promise: createSnapshot(world), users: 0, usedAt: Date.now(), retired: false };
      this.entries.set(key, entry);
    }
    entry.users++;
    try {
      const snapshot = await entry.promise;
      if (this.disposed) throw new Error("MC_MAP_UNAVAILABLE");
      return await read(snapshot.db, snapshot.directory);
    } catch (error) {
      this.retire(key, entry);
      throw error;
    } finally {
      entry.users--;
      entry.usedAt = Date.now();
      if (entry.retired && !entry.users) await this.close(entry);
    }
  }

  invalidate(root: string) {
    for (const [key, entry] of this.entries) if (key === root || key.startsWith(root + path.sep)) this.retire(key, entry);
  }

  async dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    const entries = [...this.entries];
    for (const [key, entry] of entries) this.retire(key, entry);
    await Promise.all(entries.filter(([, entry]) => !entry.users).map(([, entry]) => this.close(entry)));
  }

  private expire() {
    for (const [key, entry] of this.entries) if (!entry.users && Date.now() - entry.usedAt > 120_000) this.retire(key, entry);
  }

  private retire(key: string, entry: Entry) {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    entry.retired = true;
    if (!entry.users) void this.close(entry);
  }

  private close(entry: Entry) {
    return entry.closing ??= entry.promise.then(async ({ db, directory }) => {
      try { await db.close(); }
      finally { await fs.rm(directory, { recursive: true, force: true }); }
    }, () => {}).catch(() => {});
  }
}
