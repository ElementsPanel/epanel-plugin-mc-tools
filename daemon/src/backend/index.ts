import type { McToolsDaemonContext } from "./context";
import { registerMinecraftStatus } from "./mcstats";
import { registerWorldMap } from "./map";

export const inject = ["instances", "presets", "instanceLifecycle", "features", "protocol"];

export function apply(ctx: McToolsDaemonContext) {
  registerMinecraftStatus(ctx);
  registerWorldMap(ctx);
}
