import { randomUUID } from "node:crypto";
import { MAP_PAGE_PATH, MAP_SETTINGS_PATH, mapSource, parseMapSource, publicMapId, type MapSettings, type PublicMapSetting } from "../../../shared/map";

export class McToolsSettings {
  mapPageEnabled = false;
  publicMaps: PublicMapSetting[] = [];
}

export interface MapSettingsContext {
  i18n: { $t(key: string): string };
  storage: { getStorage(): {
    load(category: string, type: typeof McToolsSettings, id: string): Promise<McToolsSettings | null>;
    store(category: string, id: string, value: McToolsSettings): Promise<unknown>;
  } };
  settingsForm: { declare(value: {
    fields(): Record<string, unknown>[];
    read(): Pick<McToolsSettings, "mapPageEnabled">;
    write(values: Record<string, unknown>): Promise<void>;
  }): unknown };
}

export async function registerMapSettings(ctx: MapSettingsContext) {
  const storage = ctx.storage.getStorage();
  const stored = await storage.load("McToolsSettings", McToolsSettings, "config");
  let settings = new McToolsSettings();
  function maps(value: unknown, generateIds: boolean): PublicMapSetting[] {
    if (!Array.isArray(value) || value.length > 32) throw new Error("MC_MAP_PAGE_SETTINGS_INVALID");
    const result = value.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).some((key) => !["id", "name", "source"].includes(key)) ||
        typeof item.name !== "string" || !item.name.trim() || item.name.length > 100 || /[\x00-\x1f\x7f]/.test(item.name)) {
        throw new Error("MC_MAP_PAGE_SETTINGS_INVALID");
      }
      const source = parseMapSource(item.source);
      const id = generateIds && (item.id === undefined || item.id === "") ? randomUUID().replace(/-/g, "") : publicMapId(item.id);
      return { id, name: item.name.trim(), source: mapSource(source.daemonId, source.instanceUuid, source.world) };
    });
    if (new Set(result.map((item) => item.id)).size !== result.length) throw new Error("MC_MAP_PAGE_SETTINGS_INVALID");
    return result;
  }
  try {
    settings = { mapPageEnabled: stored?.mapPageEnabled === true, publicMaps: maps(stored?.publicMaps ?? [], false) };
  } catch { /* A damaged allowlist must not open unconfigured worlds. */ }
  const snapshot = () => ({ ...settings, publicMaps: settings.publicMaps.map((item) => ({ ...item })) });
  // Both the host form and the map editor use this queue; a failed save cannot
  // replace active settings or block later changes.
  let pending = Promise.resolve();
  const write = (values: Record<string, unknown>, validate?: (next: MapSettings) => Promise<void>) => {
    const save = pending.then(async () => {
      if (!values || typeof values !== "object" || Array.isArray(values) ||
        Object.keys(values).some((key) => !["mapPageEnabled", "publicMaps"].includes(key)) ||
        (values.mapPageEnabled !== undefined && typeof values.mapPageEnabled !== "boolean")) {
        throw new Error(ctx.i18n.$t("MC_MAP_PAGE_SETTINGS_INVALID"));
      }
      let next: McToolsSettings;
      try {
        next = {
          mapPageEnabled: values.mapPageEnabled === undefined ? settings.mapPageEnabled : values.mapPageEnabled as boolean,
          publicMaps: values.publicMaps === undefined ? snapshot().publicMaps : maps(values.publicMaps, true)
        };
      } catch { throw new Error(ctx.i18n.$t("MC_MAP_PAGE_SETTINGS_INVALID")); }
      if (validate) await validate(next);
      await storage.store("McToolsSettings", "config", next);
      settings = next;
      return snapshot();
    });
    pending = save.then(() => {}, () => {});
    return save;
  };
  ctx.settingsForm.declare({
    fields: () => [
      { key: "mapPageEnabled", type: "boolean", title: ctx.i18n.$t("MC_MAP_PAGE_ENABLE"), description: ctx.i18n.$t("MC_MAP_PAGE_ENABLE_HINT") },
      { type: "link", title: ctx.i18n.$t("MC_MAP_MANAGE"), route: MAP_SETTINGS_PATH },
      { type: "link", title: ctx.i18n.$t("MC_MAP_PUBLIC_OPEN"), route: MAP_PAGE_PATH }
    ],
    // The generic form must not resubmit a stale map list after editor changes.
    read: () => ({ mapPageEnabled: settings.mapPageEnabled }),
    write: async (values) => {
      if (!values || Object.keys(values).some((key) => key !== "mapPageEnabled")) {
        throw new Error(ctx.i18n.$t("MC_MAP_PAGE_SETTINGS_INVALID"));
      }
      await write(values);
    }
  });
  return { read: snapshot, write };
}
