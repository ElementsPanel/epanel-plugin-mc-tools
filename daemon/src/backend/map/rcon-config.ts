import { randomBytes } from "node:crypto";
import { readProperties, writeProperties } from "../players/properties";

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

export async function javaRconConfiguration(root: string, address?: string) {
  return configuration((await readProperties(root, "MC_MAP_RCON_CONFIG")).values, address);
}

export async function enableJavaRcon(root: string, canWrite: () => void) {
  const source = await readProperties(root, "MC_MAP_RCON_CONFIG");
  const current = configuration(source.values);
  if (current.enabled) return false;
  const changes: Record<string, string> = { "enable-rcon": "true" };
  if (!current.password) changes["rcon.password"] = randomBytes(24).toString("hex");
  if (!source.values.has("rcon.port")) changes["rcon.port"] = "25575";
  return writeProperties(root, source, changes, canWrite, "MC_MAP_RCON_WRITE_FAILED");
}
