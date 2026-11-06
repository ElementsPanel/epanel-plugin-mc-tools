import { readProperties, writeProperties } from "./properties";

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
  return writeProperties(root, source, { "enable-query": "true" }, canWrite);
}
