import type { McToolsDaemonContext } from "./context";
import { registerMinecraftStatus } from "./mcstats";
import { registerWorldMap } from "./map";
import { registerPlayerManagement } from "./players";

// Storage only holds the `$mapos` choice, so a host without it keeps every map working.
export const inject = { required: ["instances", "presets", "instanceLifecycle", "features", "protocol"], optional: ["storage"] };

export function apply(ctx: McToolsDaemonContext) {
  registerMinecraftStatus(ctx);
  registerWorldMap(ctx);
  registerPlayerManagement(ctx);
}
