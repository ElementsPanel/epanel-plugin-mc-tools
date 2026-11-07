import { MAP_WORLDS_EVENT, parseMapSource, type MapInstance, type MapWorld } from "../../../shared/map";
import type { MapPanelContext } from "./index";
import type { registerMapSettings } from "./settings";

export interface MapEditorContext extends MapPanelContext {
  roles: { USER: number; ADMIN: number };
  identity: { of(request: any): { elevated: boolean } };
  remote: MapPanelContext["remote"] & {
    services: MapPanelContext["remote"]["services"] & {
      services: Map<string, { available: boolean; config: { remarks?: string } }>;
    };
  };
}

type Settings = Awaited<ReturnType<typeof registerMapSettings>>;
const identifier = (value: unknown) => {
  if (typeof value !== "string" || !/^[\w-]{1,128}$/.test(value)) throw new Error("MC_MAP_INVALID");
  return value;
};
const instance = (item: any): MapInstance[] => {
  const type = String(item?.config?.type ?? "");
  if (!item || typeof item.instanceUuid !== "string" || item.instanceUuid === "global0001" ||
    !/^[\w-]{1,128}$/.test(item.instanceUuid) ||
    !/^minecraft\/(java|bedrock)(\/|$)/.test(type) || /bungeecord|velocity/.test(type)) return [];
  return [{ id: item.instanceUuid, name: String(item.config.nickname || item.instanceUuid) }];
};

export function registerMapEditorRoutes(ctx: MapEditorContext, settings: Settings) {
  const router = ctx.koa.router("/api/mc-tools/map/config");
  const admin = ctx.middleware.permission({ level: ctx.roles.ADMIN, speedLimit: false });
  const check = (request: any) => {
    if (!ctx.identity.of(request).elevated) throw new Error("MC_MAP_SETTINGS_FORBIDDEN");
  };
  const handler = (run: (request: any) => unknown | Promise<unknown>) => async (request: any) => {
    request.set("Cache-Control", "no-store");
    try { check(request); request.body = await run(request); }
    catch (error) {
      request.body = new Error(error instanceof Error && /^MC_MAP_[A-Z_]+$/.test(error.message) ? error.message : "MC_MAP_READ_FAILED");
    }
  };
  const remote = (daemonId: string) => {
    const node = ctx.remote.services.getInstance(daemonId);
    if (!node?.available) throw new Error("MC_MAP_NODE_OFFLINE");
    return new ctx.remote.Request(node);
  };
  // The editor only owns the allowlist; embed origins live in the plugin form.
  const editorView = (value: { mapPageEnabled: boolean; publicMaps: unknown[] }) => ({ mapPageEnabled: value.mapPageEnabled, publicMaps: value.publicMaps });
  router.get("/settings", admin, handler(() => editorView(settings.read())));
  router.put("/settings", admin, handler(async (request) => editorView(await settings.write(request.request.body, async (next) => {
    check(request);
    const existing = new Set(settings.read().publicMaps.map((map) => map.source));
    const worlds = new Map<string, MapWorld[]>();
    for (const map of next.publicMaps) {
      // Retain and remove existing entries even when their node is offline.
      if (existing.has(map.source)) continue;
      const source = parseMapSource(map.source);
      const key = source.daemonId + "/" + source.instanceUuid;
      if (!worlds.has(key)) {
        const result = await remote(source.daemonId).request(MAP_WORLDS_EVENT, { instanceUuid: source.instanceUuid }, 30_000);
        if (!Array.isArray(result)) throw new Error("MC_MAP_READ_FAILED");
        worlds.set(key, result);
      }
      if (!worlds.get(key)!.some((world) => world.id === source.world)) throw new Error("MC_MAP_WORLD_MISSING");
    }
    check(request);
  }))));
  router.get("/nodes", admin, handler(() => Array.from(ctx.remote.services.services, ([id, node]) => ({
    id, name: node.config.remarks || id, available: node.available
  }))));
  router.get("/instances", admin, handler(async (request) => {
    const daemonId = identifier(request.query.daemonId);
    const rawPage = request.query.page ?? "1";
    const search = request.query.search ?? "";
    if (typeof rawPage !== "string" || !/^[1-9]\d{0,4}$/.test(rawPage) || Number(rawPage) > 10000 ||
      typeof search !== "string" || search.length > 100) throw new Error("MC_MAP_INVALID");
    const selected = request.query.selected === undefined ? undefined : identifier(request.query.selected);
    const client = remote(daemonId);
    const result: any = await client.request("instance/select", {
      page: Number(rawPage), pageSize: 50, condition: { instanceName: search.trim() }
    }, 30_000);
    if (!Array.isArray(result?.data) || !Number.isInteger(result.maxPage) || result.maxPage < 0) throw new Error("MC_MAP_READ_FAILED");
    const data = result.data.flatMap(instance);
    let current = data.find((item: MapInstance) => item.id === selected);
    if (selected && !current) {
      const response = await client.request("instance/section", { instanceUuids: [selected] }, 30_000);
      if (Array.isArray(response)) current = response.flatMap(instance).find((item) => item.id === selected);
    }
    check(request);
    return { page: Number(rawPage), maxPage: result.maxPage, data, ...(current ? { selected: current } : {}) };
  }));
}
