import type { McToolsDaemonContext } from "../context";
import { PLAYERS_ACTION_EVENT, PLAYERS_ENABLE_QUERY_EVENT, PLAYERS_LIST_EVENT } from "../../../../shared/players";
import { PlayerManagementService } from "./service";

export function registerPlayerManagement(ctx: McToolsDaemonContext) {
  const service = new PlayerManagementService(ctx.instances.subsystem);
  ctx.features.add("mcPlayers");
  ctx.on("dispose", () => service.dispose());
  for (const event of [PLAYERS_LIST_EVENT, PLAYERS_ACTION_EVENT, PLAYERS_ENABLE_QUERY_EVENT]) {
    ctx.protocol.on(event, async (request, value) => {
      try {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MC_PLAYERS_INVALID");
        const data = value as Record<string, unknown>;
        if (typeof data.instanceUuid !== "string" || !data.instanceUuid || data.instanceUuid.length > 128) throw new Error("MC_PLAYERS_INVALID");
        const result = event === PLAYERS_LIST_EVENT ? await service.list(data.instanceUuid)
          : event === PLAYERS_ENABLE_QUERY_EVENT ? await service.enableQuery(data.instanceUuid, data.confirmed)
          : await service.action(data.instanceUuid, data.operation);
        ctx.protocol.response(request, result);
      } catch (error) {
        const message = error instanceof Error && /^MC_PLAYERS_[A-Z_]+$/.test(error.message) ? error.message : "MC_PLAYERS_READ_FAILED";
        ctx.protocol.responseError(request, new Error(message), { disablePrint: true });
      }
    });
  }
}
