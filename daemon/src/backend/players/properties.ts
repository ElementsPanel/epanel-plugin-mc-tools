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

export async function readProperties(root: string, errorCode = "MC_PLAYERS_QUERY_CONFIG") {
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
  } catch { throw new Error(errorCode); }
}


const writing = new Set<string>();

export async function writeProperties(root: string, source: Awaited<ReturnType<typeof readProperties>>, changes: Record<string, string>, canWrite: () => void, errorCode = "MC_PLAYERS_QUERY_WRITE_FAILED") {
  if (writing.has(source.filename)) throw new Error(errorCode);
  writing.add(source.filename);
  try {
    canWrite();
    let text = source.text;
    const entries = source.entries.filter(entry => Object.hasOwn(changes, entry.key));
    for (const entry of entries.reverse()) text = text.slice(0, entry.start) + entry.key + "=" + changes[entry.key] + text.slice(entry.end);
    const newline = text.match(/\r\n|\r|\n/)?.[0] || "\n";
    for (const [key, value] of Object.entries(changes)) if (!entries.some(entry => entry.key === key)) {
      text += (text ? (/[\r\n]$/.test(text) ? newline : newline + newline) : "") + key + "=" + value + newline;
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
      const latest = await readProperties(root, errorCode);
      if (latest.filename !== source.filename || latest.stat.ino !== source.stat.ino || !latest.buffer.equals(source.buffer)) throw new Error("changed");
      canWrite();
      await fs.rename(temporary, source.filename);
      return true;
    } catch { throw new Error(errorCode); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  } finally { writing.delete(source.filename); }
}
