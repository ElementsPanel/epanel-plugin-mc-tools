import { ctx } from "@elements-panel/sdk";
import type { MapTile, MapWorld } from "../../../shared/map";
import { t } from "../settings";

export function mapError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/\bMC_MAP_[A-Z_]+\b/)?.[0];
  return code ? t(code) : message || t("MC_MAP_READ_FAILED");
}

export function worldMapApi(instanceUuid: string, daemonId: string) {
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
  async function request<T>(route: string, values: Record<string, string>, signal: AbortSignal): Promise<T> {
    const headers = { "X-Requested-With": "XMLHttpRequest", Authorization: `Bearer ${await token(signal)}` };
    const query = new URLSearchParams({ uuid: instanceUuid, daemonId, ...values });
    const response = await fetch(`./api/mc-tools/map/${route}?${query}`, {
      credentials: "same-origin", headers, signal, cache: "no-store"
    });
    const result = await response.json();
    if (!response.ok || result.status !== 200) {
      throw new Error(typeof result.data === "string" ? result.data : "MC_MAP_READ_FAILED");
    }
    return result.data;
  }
  return {
    worlds: (signal: AbortSignal, refresh = false) => {
      if (refresh) authentication = undefined;
      return request<MapWorld[]>("worlds", { refresh: refresh ? "1" : "0" }, signal);
    },
    tile: (world: string, x: number, z: number, signal: AbortSignal, y?: number) => request<MapTile>("tile", {
      world, x: String(x), z: String(z), ...(y === undefined ? {} : { y: String(y) })
    }, signal)
  };
}
