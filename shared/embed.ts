import { MAP_LIMIT, MAP_MAX_Y, MAP_MIN_Y } from "./map";

/** `?embed=1` turns the public map page into an embeddable widget. */
export const EMBED_QUERY = "embed";
export const EMBED_ORIGIN_LIMIT = 16;
export const EMBED_MARKER_LIMIT = 200;
export const EMBED_MENU_LIMIT = 50;
export const EMBED_LABEL_LIMIT = 80;

const IDENTIFIER = /^[\w.:-]{1,64}$/;
const ICON = /^mdi-[a-z0-9-]{1,64}$/;
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
const WORLD = /^[a-f0-9]{24}$/;

export interface MapMarker {
  id: string;
  x: number;
  z: number;
  y?: number;
  world?: string;
  icon?: string;
  color?: string;
  label?: string;
}

export interface MapMenuItem {
  id: string;
  label: string;
  icon?: string;
  x?: number;
  z?: number;
  world?: string;
  zoom?: number;
}

export interface EmbedFocus {
  x: number;
  z: number;
  world?: string;
  zoom?: number;
  render?: "2d" | "3d";
}

export type EmbedCommand =
  | { type: "mcmap:hello" }
  | { type: "mcmap:markers"; markers: MapMarker[] }
  | { type: "mcmap:menu"; items: MapMenuItem[] }
  | { type: "mcmap:focus"; focus: EmbedFocus };

export interface EmbedReady {
  type: "mcmap:ready";
  map: string;
  worlds: { id: string; name: string }[];
  embed: boolean;
}

export interface EmbedView {
  type: "mcmap:view";
  map: string;
  world?: string;
  x: number;
  z: number;
  zoom: number;
  render: "2d" | "3d";
}

export type EmbedEvent =
  | EmbedReady
  | EmbedView
  | { type: "mcmap:marker"; id: string }
  | { type: "mcmap:menu"; id: string }
  | { type: "mcmap:error"; code: string };

/** `https://example.com` only: no paths, credentials, wildcards or query strings. */
function origin(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (url.username || url.password || url.search || url.hash) return;
  if (url.pathname !== "" && url.pathname !== "/") return;
  return url.origin;
}

/**
 * Normalizes the configured embed allowlist. Strict mode rejects anything that is
 * not a bare origin so a typo cannot silently disable or open the bridge.
 */
export function embedOrigins(value: unknown, strict = false): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  if (value !== undefined && !Array.isArray(value) && typeof value !== "string") {
    if (strict) throw new Error("MC_MAP_EMBED_INVALID");
    return [];
  }
  const origins: string[] = [];
  for (const item of items) {
    if (typeof item !== "string" || !item.trim()) continue;
    const normalized = origin(item.trim());
    if (!normalized) { if (strict) throw new Error("MC_MAP_EMBED_INVALID"); continue; }
    if (!origins.includes(normalized)) origins.push(normalized);
  }
  if (origins.length > EMBED_ORIGIN_LIMIT) {
    if (strict) throw new Error("MC_MAP_EMBED_INVALID");
    origins.length = EMBED_ORIGIN_LIMIT;
  }
  return origins;
}

const round = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  const rounded = Math.round(value);
  return Math.abs(rounded) <= MAP_LIMIT ? rounded : undefined;
};

const label = (value: unknown) => {
  if (typeof value !== "string") return;
  const text = value.trim().replace(/[\x00-\x1f\x7f]/g, "");
  return text ? text.slice(0, EMBED_LABEL_LIMIT) : undefined;
};

function marker(item: unknown): MapMarker | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return;
  const value = item as Record<string, unknown>;
  if (typeof value.id !== "string" || !IDENTIFIER.test(value.id)) return;
  const x = round(value.x), z = round(value.z);
  if (x === undefined || z === undefined) return;
  const result: MapMarker = { id: value.id, x, z };
  if (typeof value.y === "number" && Number.isInteger(value.y) && value.y >= MAP_MIN_Y && value.y <= MAP_MAX_Y) result.y = value.y;
  if (typeof value.world === "string" && WORLD.test(value.world)) result.world = value.world;
  if (typeof value.icon === "string" && ICON.test(value.icon)) result.icon = value.icon;
  if (typeof value.color === "string" && COLOR.test(value.color)) result.color = value.color;
  const text = label(value.label);
  if (text) result.label = text;
  return result;
}

function menuItem(item: unknown): MapMenuItem | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return;
  const value = item as Record<string, unknown>;
  if (typeof value.id !== "string" || !IDENTIFIER.test(value.id)) return;
  const text = label(value.label);
  if (!text) return;
  const result: MapMenuItem = { id: value.id, label: text };
  if (typeof value.icon === "string" && ICON.test(value.icon)) result.icon = value.icon;
  if (typeof value.world === "string" && WORLD.test(value.world)) result.world = value.world;
  if (typeof value.zoom === "number" && Number.isFinite(value.zoom) && value.zoom >= 1 && value.zoom <= 12) result.zoom = value.zoom;
  const x = round(value.x), z = round(value.z);
  if (x !== undefined && z !== undefined) Object.assign(result, { x, z });
  return result;
}

function focus(value: Record<string, unknown>): EmbedFocus | undefined {
  const x = round(value.x), z = round(value.z);
  if (x === undefined || z === undefined) return;
  const result: EmbedFocus = { x, z };
  if (typeof value.world === "string" && WORLD.test(value.world)) result.world = value.world;
  if (typeof value.zoom === "number" && Number.isFinite(value.zoom) && value.zoom >= 1 && value.zoom <= 12) result.zoom = value.zoom;
  if (value.render === "3d" || value.render === "2d") result.render = value.render;
  return result;
}

/** Accepts only the documented messages; unknown or malformed entries are dropped. */
export function embedCommand(value: unknown): EmbedCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (data.type === "mcmap:hello") return { type: "mcmap:hello" };
  if (data.type === "mcmap:markers") {
    if (!Array.isArray(data.markers) || data.markers.length > EMBED_MARKER_LIMIT) return;
    return { type: "mcmap:markers", markers: data.markers.map(marker).filter(Boolean) as MapMarker[] };
  }
  if (data.type === "mcmap:menu") {
    if (!Array.isArray(data.items) || data.items.length > EMBED_MENU_LIMIT) return;
    return { type: "mcmap:menu", items: data.items.map(menuItem).filter(Boolean) as MapMenuItem[] };
  }
  if (data.type === "mcmap:focus") {
    const target = focus(data);
    return target ? { type: "mcmap:focus", focus: target } : undefined;
  }
}
