import { MAP_TILE_EVENT, MAP_WORLDS_EVENT, mapCoordinate, mapHeight, parseMapSource, publicMapId, type MapTile, type MapWorld } from "../../../shared/map";
import type { MapPanelContext } from "./index";
import type { McToolsSettings } from "./settings";

export interface PublicMapContext extends MapPanelContext {
  identity: { of(request: any): { elevated: boolean } };
}

export function registerPublicMapRoutes(ctx: PublicMapContext, settings: () => McToolsSettings) {
  const router = ctx.koa.router("/api/mc-tools/map/public");
  const { permission, validator, instanceAccess } = ctx.middleware;
  const refreshed = new Map<string, number>();
  const noStore = (request: any, next: () => Promise<void>) => {
    request.set("Cache-Control", "no-store");
    return next();
  };
  const fail = (request: any, error: unknown) => {
    request.body = new Error(error instanceof Error && /^MC_MAP_[A-Z_]+$/.test(error.message) ? error.message : "MC_MAP_READ_FAILED");
  };
  const configured = (value: unknown) => {
    const config = settings();
    if (!config.mapPageEnabled) throw new Error("MC_MAP_PAGE_DISABLED");
    const id = publicMapId(value);
    const map = config.publicMaps.find((item) => item.id === id);
    if (!map) throw new Error("MC_MAP_PUBLIC_NOT_FOUND");
    return map;
  };
  const integer = (value: unknown, height = false) => {
    if (typeof value !== "string" || !/^-?\d{1,6}$/.test(value)) throw new Error("MC_MAP_INVALID");
    return height ? mapHeight(Number(value))! : mapCoordinate(Number(value));
  };

  router.get("/maps", noStore, (request: any) => {
    const config = settings();
    request.body = { enabled: config.mapPageEnabled, maps: config.mapPageEnabled ? config.publicMaps.map(({ id, name }) => ({ id, name })) : [] };
  });

  // Only an authorized instance viewer can look up private world IDs or copy a source.
  router.get("/links", noStore, permission({ level: ctx.roles.USER, speedLimit: false }),
    validator({ query: { uuid: String, daemonId: String } }), instanceAccess, (request: any) => {
      const config = settings();
      request.body = {
        enabled: config.mapPageEnabled, canConfigure: ctx.identity.of(request).elevated,
        maps: config.mapPageEnabled ? config.publicMaps.flatMap((item) => {
          const source = parseMapSource(item.source);
          return source.daemonId === request.query.daemonId && source.instanceUuid === request.query.uuid
            ? [{ id: item.id, name: item.name, world: source.world }] : [];
        }) : []
      };
    });

  for (const [route, event] of [["/worlds", MAP_WORLDS_EVENT], ["/tile", MAP_TILE_EVENT]]) {
    router.get(route, noStore, async (request: any) => {
      try {
        const map = configured(request.query.map);
        const source = parseMapSource(map.source);
        const node = ctx.remote.services.getInstance(source.daemonId);
        if (!node?.available) throw new Error("MC_MAP_NODE_OFFLINE");
        const data: Record<string, unknown> = { instanceUuid: source.instanceUuid };
        if (event === MAP_TILE_EVENT) {
          Object.assign(data, { world: source.world, x: integer(request.query.x), z: integer(request.query.z) });
          if (request.query.y !== undefined) data.y = integer(request.query.y, true);
        } else if (request.query.refresh === "1") {
          const key = source.daemonId + "/" + source.instanceUuid;
          const now = Date.now();
          // Bound anonymous snapshot copies while still allowing saved changes to be refreshed.
          if (!refreshed.has(key) || now - refreshed.get(key)! >= 30_000) {
            data.refresh = true;
            refreshed.set(key, now);
            if (refreshed.size > 64) refreshed.delete(refreshed.keys().next().value!);
          }
        }
        const response = await new ctx.remote.Request(node).request(event, data, 30_000);
        const current = configured(map.id);
        if (current.source !== map.source) throw new Error("MC_MAP_PUBLIC_NOT_FOUND");
        if (event === MAP_WORLDS_EVENT) {
          if (!Array.isArray(response)) throw new Error("MC_MAP_READ_FAILED");
          const world = (response as MapWorld[]).find((item) => item.id === source.world);
          if (!world) throw new Error("MC_MAP_WORLD_MISSING");
          request.body = [{ id: map.id, name: current.name, dimension: world.dimension, spawn: { x: world.spawn.x, z: world.spawn.z } }];
        } else {
          const tile = response as MapTile;
          request.body = { image: tile.image, chunks: tile.chunks, warnings: tile.warnings };
        }
      } catch (error) { fail(request, error); }
    });
  }
}
