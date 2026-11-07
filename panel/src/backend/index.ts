import type { Context } from "cordis";
import { MAP_TILE_EVENT, MAP_WORLDS_EVENT, MAP_SCENE_EVENT, mapCoordinate, mapSceneCoordinate } from "../../../shared/map";
import { registerPlayerRoutes } from "./players";
import { registerMapPlayerRoutes } from "./map-players";
import { registerMapSettings, type MapSettingsContext } from "./settings";
import { localeMessages } from "../i18n";
import { registerPublicMapRoutes, type PublicMapContext } from "./public-map";
import { registerMapEditorRoutes, type MapEditorContext } from "./map-settings";

export interface MapPanelContext extends Context {
  koa: { router(prefix: string): { get(path: string, ...handlers: any[]): void; post(path: string, ...handlers: any[]): void; put(path: string, ...handlers: any[]): void } };
  roles: { USER: number };
  middleware: {
    permission(options: { level: number; speedLimit: boolean }): any;
    validator(options: unknown): any;
    instanceAccess: any;
  };
  remote: {
    services: { getInstance(id: string): { available: boolean } | undefined };
    Request: new (service: unknown) => { request(event: string, data: unknown, timeout?: number): Promise<unknown> };
  };
}

export const inject = ["koa", "middleware", "roles", "remote", "i18n", "storage", "settingsForm", "identity"];

export async function apply(ctx: PublicMapContext & MapEditorContext & MapSettingsContext & { i18n: { define(messages: typeof localeMessages): unknown } }) {
  ctx.i18n.define(localeMessages);
  const settings = await registerMapSettings(ctx);
  registerWorldMapRoutes(ctx);
  registerPublicMapRoutes(ctx, settings.read);
  registerMapEditorRoutes(ctx, settings);
  registerPlayerRoutes(ctx);
  registerMapPlayerRoutes(ctx);
}

export function registerWorldMapRoutes(ctx: MapPanelContext) {
  const router = ctx.koa.router("/api/mc-tools/map");
  const { permission, validator, instanceAccess } = ctx.middleware;
  for (const [route, event] of [["/worlds", MAP_WORLDS_EVENT], ["/tile", MAP_TILE_EVENT], ["/scene", MAP_SCENE_EVENT]]) {
    router.get(route,
      permission({ level: ctx.roles.USER, speedLimit: false }),
      validator({ query: { uuid: String, daemonId: String } }),
      instanceAccess,
      async (request: any) => {
        try {
          const node = ctx.remote.services.getInstance(String(request.query.daemonId));
          if (!node?.available) throw new Error("MC_MAP_NODE_OFFLINE");
          const data: Record<string, unknown> = { instanceUuid: String(request.query.uuid) };
          if (event !== MAP_WORLDS_EVENT) {
            if (typeof request.query.world !== "string" || !/^[a-f0-9]{24}$/.test(request.query.world)) throw new Error("MC_MAP_INVALID");
            const coordinate = (value: unknown) => {
              if (typeof value !== "string" || !/^-?\d{1,6}$/.test(value)) throw new Error("MC_MAP_INVALID");
              return (event === MAP_SCENE_EVENT ? mapSceneCoordinate : mapCoordinate)(Number(value));
            };
            Object.assign(data, { world: request.query.world, x: coordinate(request.query.x), z: coordinate(request.query.z) });
            if (event === MAP_SCENE_EVENT) data.compress = request.query.compress !== "0";
          } else data.refresh = request.query.refresh === "1";
          request.body = await new ctx.remote.Request(node).request(event, data, 30_000);
        } catch (error) { request.body = error; }
      }
    );
  }
}
