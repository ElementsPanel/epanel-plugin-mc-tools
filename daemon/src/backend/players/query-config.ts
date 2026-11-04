import { randomBytes } from "node:crypto";
import { isUtf8 } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";

function properties(text: string) {
  const values = new Map<string, string>();
  const entries: { key: string; start: number; end: number }[] = [];
  const decode = (value: string) => value.replace(/\\u([a-f\d]{4})|\\(.)/gi, (_, hex, character) => hex ? String.fromCharCode(parseInt(hex, 16)) : (({ t: "\t", n: "\n", r: "\r", f: "\f" } as Record<string, string>)[character] ?? character));
  const lines = [...text.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g)].filter(match => match[0].length);
  for (let index = 0; index < lines.length; index++) {
    const first = lines[index];
    let line = first[1].replace(/^\uFEFF/, ""), end = first.index! + first[1].length;
    if (/^[ \t\f]*(?:[#!]|$)/.test(line)) continue;
    while ((line.match(/\\+$/)?.[0].length || 0) % 2 && index + 1 < lines.length) {
      const next = lines[++index];
      line = line.slice(0, -1) + next[1].replace(/^[ \t\f]+/, "");
      end = next.index! + next[1].length;
    }
    const match = line.match(/^[ \t\f]*((?:\\.|[^\\:= \t\f])+)(?:[ \t\f]*[=:][ \t\f]*|[ \t\f]+)?(.*)$/);
    if (!match) continue;
    const key = decode(match[1]);
    values.set(key, decode(match[2]));
    entries.push({ key, start: first.index! + (first[1].startsWith("\uFEFF") ? 1 : 0), end });
  }
  return { values, entries };
}

async function readProperties(root: string) {
  try {
    const filename = await fs.realpath(path.join(root, "server.properties"));
    const relative = path.relative(root, filename);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) throw new Error("outside");
    const file = await fs.open(filename, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("size");
      const buffer = Buffer.alloc(stat.size);
      if ((await file.read(buffer, 0, buffer.length, 0)).bytesRead !== buffer.length) throw new Error("changed");
      const encoding = isUtf8(buffer) ? "utf8" : "latin1";
      const text = buffer.toString(encoding);
      return { filename, stat, buffer, text, encoding, ...properties(text) };
    } finally { await file.close(); }
  } catch { throw new Error("MC_PLAYERS_QUERY_CONFIG"); }
}

function configuration(values: Map<string, string>, address?: string) {
  const enabled = values.get("enable-query")?.toLowerCase() === "true";
  const value = values.get("query.port") ?? "25565", port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MC_PLAYERS_QUERY_CONFIG");
  let host = (address?.trim() || values.get("server-ip") || "127.0.0.1").replace(/^\[(.*)\]$/, "$1");
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  if (!host || host.length > 253 || /[\s/\\\x00]/.test(host)) throw new Error("MC_PLAYERS_QUERY_CONFIG");
  return { enabled, host, port };
}

export async function javaQueryConfiguration(root: string, address?: string) {
  return configuration((await readProperties(root)).values, address);
}

export async function javaQueryTarget(root: string, address?: string) {
  const { enabled, host, port } = await javaQueryConfiguration(root, address);
  if (!enabled) throw new Error("MC_PLAYERS_QUERY_DISABLED");
  return { host, port };
}

/** Write only after confirmation; preserve other properties, comments, line endings and mode. */
export async function enableJavaQuery(root: string, canWrite: () => void) {
  const source = await readProperties(root);
  if (configuration(source.values).enabled) return false;
  canWrite();
  let text = source.text;
  const entries = source.entries.filter(entry => entry.key === "enable-query");
  for (const entry of entries.reverse()) text = text.slice(0, entry.start) + "enable-query=true" + text.slice(entry.end);
  if (!entries.length) {
    const newline = text.match(/\r\n|\r|\n/)?.[0] || "\n";
    // A blank line also terminates a dangling Java-properties continuation.
    text += (text ? (/[\r\n]$/.test(text) ? newline : newline + newline) : "") + "enable-query=true" + newline;
  }
  const temporary = source.filename + ".mc-tools-" + randomBytes(8).toString("hex") + ".tmp";
  try {
    const file = await fs.open(temporary, "wx", source.stat.mode & 0o777);
    try {
      const stat = await file.stat();
      if (stat.uid !== source.stat.uid || stat.gid !== source.stat.gid) await file.chown(source.stat.uid, source.stat.gid);
      await file.writeFile(text, { encoding: source.encoding });
      await file.chmod(source.stat.mode & 0o777);
      await file.sync();
    } finally { await file.close(); }
    const latest = await readProperties(root);
    if (latest.filename !== source.filename || latest.stat.ino !== source.stat.ino || !latest.buffer.equals(source.buffer)) throw new Error("changed");
    canWrite();
    await fs.rename(temporary, source.filename);
    return true;
  } catch { throw new Error("MC_PLAYERS_QUERY_WRITE_FAILED"); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
