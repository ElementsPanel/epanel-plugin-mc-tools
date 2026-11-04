import type { McToolsDaemonContext } from "./context";
import { registerMinecraftStatus } from "./mcstats";

export const inject = ["instances", "presets", "instanceLifecycle", "features"];

export function apply(ctx: McToolsDaemonContext) {
  registerMinecraftStatus(ctx);
}
