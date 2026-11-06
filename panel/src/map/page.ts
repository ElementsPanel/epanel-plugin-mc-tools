import { MAP_LIMIT, MAP_PAGE_PATH, MAP_SETTINGS_PATH, publicMapId, type MapViewOptions } from "../../../shared/map";

export function mapPageLocation(query: Record<string, unknown>) {
  const view: MapViewOptions = {};
  const map = query.map === undefined ? undefined : publicMapId(query.map);
  if (query.render !== undefined) {
    if (query.render !== "2d" && query.render !== "3d") throw new Error("MC_MAP_INVALID");
    if (query.render === "3d") view.render = "3d";
  }
  for (const key of ["x", "z", "zoom"] as const) {
    if (query[key] === undefined) continue;
    const raw = query[key];
    if (typeof raw !== "string" || !/^-?\d+(?:\.\d+)?$/.test(raw) || raw.length > 32) throw new Error("MC_MAP_INVALID");
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error("MC_MAP_INVALID");
    if (key === "zoom") {
      if (value < 1 || value > 12) throw new Error("MC_MAP_INVALID");
    } else if (!Number.isInteger(value) || Math.abs(value) > MAP_LIMIT) throw new Error("MC_MAP_INVALID");
    view[key] = value;
  }
  if ((view.x === undefined) !== (view.z === undefined)) throw new Error("MC_MAP_INVALID");
  return { map, view };
}

export function publicMapUrl(map: string, view: MapViewOptions = {}, base = location.href) {
  const query = new URLSearchParams({ map: publicMapId(map) });
  for (const key of ["x", "z", "zoom"] as const) if (view[key] !== undefined) query.set(key, String(view[key]));
  if (view.render === "3d") query.set("render", "3d");
  const url = new URL(base);
  url.search = "";
  url.hash = MAP_PAGE_PATH + "?" + query;
  return url.href;
}

export function mapSettingsUrl(base = location.href) {
  const url = new URL(base);
  url.search = "";
  url.hash = MAP_SETTINGS_PATH;
  return url.href;
}
