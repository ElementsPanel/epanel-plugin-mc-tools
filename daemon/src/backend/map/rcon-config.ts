import { randomBytes } from "node:crypto";
import { readProperties, writeProperties } from "../players/properties";
import { javaServerRoots } from "./worlds";

function configuration(values: Map<string, string>, address?: string) {
  const value = values.get("rcon.port") ?? "25575", port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) throw new Error("MC_MAP_RCON_CONFIG");
  let host = (address?.trim() || values.get("server-ip") || "127.0.0.1").replace(/^\[(.*)\]$/, "$1");
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  if (!host || host.length > 253 || /[\s/\\\x00]/.test(host)) throw new Error("MC_MAP_RCON_CONFIG");
  const password = values.get("rcon.password") || "";
  if (Buffer.byteLength(password) > 1024 || password.includes("\0")) throw new Error("MC_MAP_RCON_CONFIG");
  return { enabled: values.get("enable-rcon")?.toLowerCase() === "true" && !!password,
    host, port, password, levelName: values.get("level-name") || "world" };
}

/** MCDR instances keep `server.properties` in a nested server root. */
async function serverRoots(instanceRoot: string) {
  try { await readProperties(instanceRoot, "MC_MAP_RCON_CONFIG"); return [instanceRoot]; }
  catch { /* Only a folder without server.properties can be an MCDR wrapper. */ }
  try { return await javaServerRoots(instanceRoot); }
  catch { return [instanceRoot]; }
}

export async function javaRconConfiguration(root: string, address?: string) {
  let fallback: ReturnType<typeof configuration> | undefined;
  let failure: Error | undefined;
  for (const serverRoot of await serverRoots(root)) {
    let source;
    try { source = await readProperties(serverRoot, "MC_MAP_RCON_CONFIG"); }
    catch (error) { failure ??= error instanceof Error ? error : new Error("MC_MAP_RCON_CONFIG"); continue; }
    try {
      const current = configuration(source.values, address);
      if (current.enabled) return current;
      fallback ??= current;
    } catch (error) { failure ??= error instanceof Error ? error : new Error("MC_MAP_RCON_CONFIG"); }
  }
  if (fallback) return fallback;
  throw failure ?? new Error("MC_MAP_RCON_CONFIG");
}

export async function enableJavaRcon(root: string, canWrite: () => void) {
  let selected: { root: string; source: Awaited<ReturnType<typeof readProperties>> } | undefined;
  for (const serverRoot of await serverRoots(root)) {
    let source;
    try { source = await readProperties(serverRoot, "MC_MAP_RCON_CONFIG"); }
    catch { continue; }
    try {
      if (configuration(source.values).enabled) return false;
      selected ??= { root: serverRoot, source };
    } catch { /* An invalid nested file does not hide a later valid one. */ }
  }
  if (!selected) throw new Error("MC_MAP_RCON_CONFIG");
  const current = configuration(selected.source.values);
  const changes: Record<string, string> = { "enable-rcon": "true" };
  if (!current.password) changes["rcon.password"] = randomBytes(24).toString("hex");
  if (!selected.source.values.has("rcon.port")) changes["rcon.port"] = "25575";
  return writeProperties(selected.root, selected.source, changes, canWrite, "MC_MAP_RCON_WRITE_FAILED");
}
