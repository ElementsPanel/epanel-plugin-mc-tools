import type { McToolsDaemonContext } from "./context";
import { registerMinecraftStatus } from "./mcstats";
import { registerWorldMap } from "./map";
import { registerPlayerManagement } from "./players";

export const inject = ["instances", "presets", "instanceLifecycle", "features", "protocol"];

export function apply(ctx: McToolsDaemonContext) {
  registerMinecraftStatus(ctx);
  registerWorldMap(ctx);
  registerPlayerManagement(ctx);
}
