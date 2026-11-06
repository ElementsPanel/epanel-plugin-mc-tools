import { MAP_PLAYERS_EVENT, MAP_RCON_ENABLE_EVENT } from "../../../shared/map-players";
import type { MapPanelContext } from "./index";
import { PlayerSkinService } from "./player-skins";

export function registerMapPlayerRoutes(ctx: MapPanelContext) {
  const router = ctx.koa.router("/api/mc-tools/map");
  const guards = () => [ctx.middleware.permission({ level: ctx.roles.USER, speedLimit: false }),
    ctx.middleware.validator({ query: { uuid: String, daemonId: String } }), ctx.middleware.instanceAccess];
  const handler = (enable: boolean) => async (request: any) => {
    request.set?.("Cache-Control", "no-store");
    try {
      const node = ctx.remote.services.getInstance(String(request.query.daemonId));
      if (!node?.available) throw new Error("MC_MAP_NODE_OFFLINE");
      const data: Record<string, unknown> = { instanceUuid: String(request.query.uuid) };
      if (enable) {
        if (request.request.body?.confirmed !== true) throw new Error("MC_MAP_INVALID");
        data.confirmed = true;
      }
      request.body = await new ctx.remote.Request(node).request(enable ? MAP_RCON_ENABLE_EVENT : MAP_PLAYERS_EVENT, data, 15_000);
    } catch (error) { request.body = error; }
  };
  router.get("/players", ...guards(), handler(false));
  router.post("/rcon/enable", ...guards(), handler(true));
  const skins = new PlayerSkinService();
  ctx.on("dispose", () => skins.dispose());
  router.get("/skin", async (request: any) => {
    const skin = await skins.get(request.query.name);
    request.set("Cache-Control", `public, max-age=${skin ? 21600 : 300}`);
    request.body = { skin };
  });
}
