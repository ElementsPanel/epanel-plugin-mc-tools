import { ctx } from "@elements-panel/sdk";
import type { MapInstances, MapNode, MapSettings, MapTile, MapSceneTile, MapWorld, PublicMapCatalog, PublicMapLinks } from "../../../shared/map";
import { t } from "../settings";

export function mapError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/\bMC_MAP_[A-Z_]+\b/)?.[0];
  return code ? t(code) : message || t("MC_MAP_READ_FAILED");
}

function authenticatedRequests() {
  let authentication: Promise<string> | undefined;
  async function token(signal: AbortSignal) {
    if (!authentication) authentication = (async () => {
      const user = ctx.get("user");
      const info = user && (await user.api.userInfoApi().execute({ signal })).value;
      if (!info?.token) throw new Error("MC_MAP_SESSION");
      return String(info.token);
    })().catch((error) => { authentication = undefined; throw error; });
    return authentication;
  }
  async function request<T>(route: string, values: Record<string, string>, signal: AbortSignal, body?: unknown): Promise<T> {
    const headers = { "X-Requested-With": "XMLHttpRequest", Authorization: `Bearer ${await token(signal)}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) };
    const query = new URLSearchParams(values);
    const response = await fetch(`./api/mc-tools/map/${route}?${query}`, {
      credentials: "same-origin", headers, signal, cache: "no-store",
      ...(body === undefined ? {} : { method: "PUT", body: JSON.stringify(body) })
    });
    const result = await response.json();
    if (!response.ok || result.status !== 200) {
      throw new Error(typeof result.data === "string" ? result.data : "MC_MAP_READ_FAILED");
    }
    return result.data;
  }
  return { request, reset: () => { authentication = undefined; } };
}

export function worldMapApi(instanceUuid: string, daemonId: string) {
  const api = authenticatedRequests();
  const scope = { uuid: instanceUuid, daemonId };
  return {
    publicLinks: (signal: AbortSignal) => api.request<PublicMapLinks>("public/links", scope, signal),
    worlds: (signal: AbortSignal, refresh = false) => {
      if (refresh) api.reset();
      return api.request<MapWorld[]>("worlds", { ...scope, refresh: refresh ? "1" : "0" }, signal);
    },
    scene: (world: string, x: number, z: number, signal: AbortSignal, y?: number) => api.request<MapSceneTile>("scene", {
      ...scope, world, x: String(x), z: String(z), ...(y === undefined ? {} : { y: String(y) })
    }, signal),
    tile: (world: string, x: number, z: number, signal: AbortSignal, y?: number) => api.request<MapTile>("tile", {
      ...scope, world, x: String(x), z: String(z), ...(y === undefined ? {} : { y: String(y) })
    }, signal)
  };
}

export function mapSettingsApi() {
  const { request } = authenticatedRequests();
  return {
    read: (signal: AbortSignal) => request<MapSettings>("config/settings", {}, signal),
    save: (values: MapSettings, signal: AbortSignal) => request<MapSettings>("config/settings", {}, signal, values),
    nodes: (signal: AbortSignal) => request<MapNode[]>("config/nodes", {}, signal),
    instances: (daemonId: string, page: number, search: string, selected: string, signal: AbortSignal) => request<MapInstances>("config/instances", {
      daemonId, page: String(page), search, ...(selected ? { selected } : {})
    }, signal),
    worlds: (daemonId: string, instanceUuid: string, signal: AbortSignal) => request<MapWorld[]>("worlds", { daemonId, uuid: instanceUuid }, signal)
  };
}

async function publicRequest<T>(route: string, values: Record<string, string>, signal: AbortSignal): Promise<T> {
  const response = await fetch(`./api/mc-tools/map/public/${route}?${new URLSearchParams(values)}`, {
    credentials: "omit", headers: { "X-Requested-With": "XMLHttpRequest" }, signal, cache: "no-store"
  });
  const result = await response.json();
  if (!response.ok || result.status !== 200) throw new Error(typeof result.data === "string" ? result.data : "MC_MAP_READ_FAILED");
  return result.data;
}

export const publicMapCatalog = (signal: AbortSignal) => publicRequest<PublicMapCatalog>("maps", {}, signal);

export function publicWorldMapApi(map: string) {
  return {
    worlds: (signal: AbortSignal, refresh = false) => publicRequest<MapWorld[]>("worlds", { map, refresh: refresh ? "1" : "0" }, signal),
    scene: (_world: string, x: number, z: number, signal: AbortSignal, y?: number) => publicRequest<MapSceneTile>("scene", {
      map, x: String(x), z: String(z), ...(y === undefined ? {} : { y: String(y) })
    }, signal),
    tile: (_world: string, x: number, z: number, signal: AbortSignal, y?: number) => publicRequest<MapTile>("tile", {
      map, x: String(x), z: String(z), ...(y === undefined ? {} : { y: String(y) })
    }, signal)
  };
}
