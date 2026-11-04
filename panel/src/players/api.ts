import { ctx } from "@elements-panel/sdk";
import { playerOperation, type EnableQueryResult, type PlayerOperation, type PlayerOperationResult, type PlayerRoster } from "../../../shared/players";
import { t } from "../settings";

export function playersError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/\bMC_PLAYERS_[A-Z_]+\b/)?.[0];
  return code ? t(code) : message || t("MC_PLAYERS_READ_FAILED");
}

export function playersApi(instanceUuid: string, daemonId: string) {
  let authentication: Promise<string> | undefined;
  async function token(signal: AbortSignal) {
    if (!authentication) authentication = (async () => {
      const user = ctx.get("user");
      const info = user && (await user.api.userInfoApi().execute({ signal })).value;
      if (!info?.token) throw new Error("MC_PLAYERS_SESSION");
      return String(info.token);
    })().catch(error => { authentication = undefined; throw error; });
    return authentication;
  }
  async function request<T>(route: string, signal: AbortSignal, operation?: PlayerOperation | { confirmed: true }): Promise<T> {
    const headers: Record<string, string> = { "X-Requested-With": "XMLHttpRequest", Authorization: `Bearer ${await token(signal)}` };
    if (operation) headers["Content-Type"] = "application/json";
    const query = new URLSearchParams({ uuid: instanceUuid, daemonId });
    const response = await fetch(`./api/mc-tools/players/${route}?${query}`, {
      method: operation ? "POST" : "GET", headers, credentials: "same-origin", cache: "no-store", signal,
      ...(operation ? { body: JSON.stringify(operation) } : {})
    });
    const result = await response.json();
    if (!response.ok || result.status !== 200) {
      authentication = undefined;
      throw new Error(typeof result.data === "string" ? result.data : "MC_PLAYERS_READ_FAILED");
    }
    return result.data;
  }
  return {
    list: (signal: AbortSignal) => request<PlayerRoster>("list", signal),
    action: (operation: PlayerOperation, signal: AbortSignal) => request<PlayerOperationResult>("action", signal, playerOperation(operation)),
    enableQuery: (signal: AbortSignal) => request<EnableQueryResult>("query/enable", signal, { confirmed: true })
  };
}
