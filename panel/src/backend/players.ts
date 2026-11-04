import type { MapPanelContext } from "./index";
import { PLAYERS_ACTION_EVENT, PLAYERS_ENABLE_QUERY_EVENT, PLAYERS_LIST_EVENT, playerOperation } from "../../../shared/players";

export function registerPlayerRoutes(ctx: MapPanelContext) {
  const router = ctx.koa.router("/api/mc-tools/players");
  const guards = () => [
    ctx.middleware.permission({ level: ctx.roles.USER, speedLimit: false }),
    ctx.middleware.validator({ query: { uuid: String, daemonId: String } }),
    ctx.middleware.instanceAccess
  ];
  const handler = (event: string) => async (request: any) => {
    try {
      const node = ctx.remote.services.getInstance(String(request.query.daemonId));
      if (!node?.available) throw new Error("MC_PLAYERS_NODE_OFFLINE");
      const data: Record<string, unknown> = { instanceUuid: String(request.query.uuid) };
      if (event === PLAYERS_ACTION_EVENT) data.operation = playerOperation(request.request.body);
      if (event === PLAYERS_ENABLE_QUERY_EVENT) {
        if (request.request.body?.confirmed !== true) throw new Error("MC_PLAYERS_INVALID");
        data.confirmed = true;
      }
      request.body = await new ctx.remote.Request(node).request(event, data, 15_000);
    } catch (error) { request.body = error; }
  };
  router.get("/list", ...guards(), handler(PLAYERS_LIST_EVENT));
  router.post("/action", ...guards(), handler(PLAYERS_ACTION_EVENT));
  router.post("/query/enable", ...guards(), handler(PLAYERS_ENABLE_QUERY_EVENT));
}
