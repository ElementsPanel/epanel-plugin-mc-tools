import type { McToolsDaemonContext } from "../context";
import { MAP_TILE_EVENT, MAP_WORLDS_EVENT, MAP_SCENE_EVENT, mapCoordinate, mapSceneCoordinate } from "../../../../shared/map";
import { WorldMapService } from "./service";
import { MapPlayerService } from "./players";
import { MAP_PLAYERS_EVENT, MAP_RCON_ENABLE_EVENT } from "../../../../shared/map-players";

export function registerWorldMap(ctx: McToolsDaemonContext) {
  const service = new WorldMapService(ctx.instances.subsystem);
  const players = new MapPlayerService(ctx.instances.subsystem, id => service.worlds(id), { storage: ctx.storage });
  // Chat only reaches the console, so every Java instance is watched up front.
  for (const instance of ctx.instances.subsystem.getInstances()) players.track(instance);
  ctx.features.add("mcWorldMap");
  ctx.on("dispose", () => { players.dispose(); return service.dispose(); });
  for (const event of [MAP_WORLDS_EVENT, MAP_TILE_EVENT, MAP_SCENE_EVENT, MAP_PLAYERS_EVENT, MAP_RCON_ENABLE_EVENT]) {
    ctx.protocol.on(event, async (request, value) => {
      try {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MC_MAP_INVALID");
        const data = value as Record<string, unknown>;
        if (typeof data.instanceUuid !== "string" || !data.instanceUuid || data.instanceUuid.length > 128) throw new Error("MC_MAP_INVALID");
        if (event === MAP_RCON_ENABLE_EVENT) ctx.protocol.response(request, await players.enable(data.instanceUuid, data.confirmed));
        else if (event === MAP_PLAYERS_EVENT) {
          if (data.world !== undefined && (typeof data.world !== "string" || !/^[a-f0-9]{24}$/.test(data.world))) throw new Error("MC_MAP_INVALID");
          ctx.protocol.response(request, await players.list(data.instanceUuid, data.world as string | undefined, { time: data.time !== false }));
        } else if (event === MAP_WORLDS_EVENT) {
          const worlds = await service.worlds(data.instanceUuid, data.refresh === true);
          ctx.protocol.response(request, worlds.map(({ id, name, dimension, spawn }) => ({ id, name, dimension, spawn })));
        } else {
          if (typeof data.world !== "string" || !/^[a-f0-9]{24}$/.test(data.world)) throw new Error("MC_MAP_INVALID");
          const scene = event === MAP_SCENE_EVENT;
          const coordinate = scene ? mapSceneCoordinate : mapCoordinate;
          const x = coordinate(data.x), z = coordinate(data.z);
          // Browsers without DecompressionStream ask for the raw tile instead.
          ctx.protocol.response(request, scene
            ? await service.scene(data.instanceUuid, data.world, x, z, { compress: data.compress !== false })
            : await service.tile(data.instanceUuid, data.world, x, z));
        }
      } catch (error) {
        const message = error instanceof Error && /^MC_MAP_[A-Z_]+$/.test(error.message) ? error.message : "MC_MAP_READ_FAILED";
        ctx.protocol.responseError(request, new Error(message), { disablePrint: true });
      }
    });
  }
}
