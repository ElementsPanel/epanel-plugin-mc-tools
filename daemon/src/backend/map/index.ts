import type { McToolsDaemonContext } from "../context";
import { MAP_TILE_EVENT, MAP_WORLDS_EVENT, MAP_SCENE_EVENT, mapCoordinate, mapSceneCoordinate, mapHeight } from "../../../../shared/map";
import { WorldMapService } from "./service";

export function registerWorldMap(ctx: McToolsDaemonContext) {
  const service = new WorldMapService(ctx.instances.subsystem);
  ctx.features.add("mcWorldMap");
  ctx.on("dispose", () => service.dispose());
  for (const event of [MAP_WORLDS_EVENT, MAP_TILE_EVENT, MAP_SCENE_EVENT]) {
    ctx.protocol.on(event, async (request, value) => {
      try {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MC_MAP_INVALID");
        const data = value as Record<string, unknown>;
        if (typeof data.instanceUuid !== "string" || !data.instanceUuid || data.instanceUuid.length > 128) throw new Error("MC_MAP_INVALID");
        if (event === MAP_WORLDS_EVENT) {
          const worlds = await service.worlds(data.instanceUuid, data.refresh === true);
          ctx.protocol.response(request, worlds.map(({ id, name, dimension, spawn }) => ({ id, name, dimension, spawn })));
        } else {
          if (typeof data.world !== "string" || !/^[a-f0-9]{24}$/.test(data.world)) throw new Error("MC_MAP_INVALID");
          const scene = event === MAP_SCENE_EVENT;
          const coordinate = scene ? mapSceneCoordinate : mapCoordinate;
          ctx.protocol.response(request, await service[scene ? "scene" : "tile"](data.instanceUuid, data.world, coordinate(data.x), coordinate(data.z), mapHeight(data.y)));
        }
      } catch (error) {
        const message = error instanceof Error && /^MC_MAP_[A-Z_]+$/.test(error.message) ? error.message : "MC_MAP_READ_FAILED";
        ctx.protocol.responseError(request, new Error(message), { disablePrint: true });
      }
    });
  }
}
