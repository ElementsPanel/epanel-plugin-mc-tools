import type { PanelFrontendPluginContext } from "@elements-panel/sdk";
import McPingSettings from "./McPingSettings.vue";
import DesktopMcPing from "./DesktopMcPing.vue";
import { localeMessages } from "./i18n";

export const inject = ["console", "i18n", "actions", "instance"];

export function apply(ctx: PanelFrontendPluginContext) {
  ctx.i18n.define(localeMessages);
  // Older instance packages already contribute the same action.
  if (ctx.actions.instances.some((action) => action.id === "mcstats")) return;
  ctx.actions.instance({
    id: "mcstats",
    title: () => ctx.i18n.translate("TXT_CODE_40241d8e"),
    icon: "mdi-chart-line",
    mdiIcon: "mdi-chart-line",
    normalComponent: McPingSettings,
    desktopComponent: DesktopMcPing,
    condition: ({ instanceId, daemonId, isGlobalTerminal, instanceInfo, daemon }) => {
      const type = String((instanceInfo as any)?.config?.type ?? "");
      return !isGlobalTerminal && Boolean(instanceId && daemonId) &&
        Boolean((daemon as any)?.features?.mcstats) &&
        (type.startsWith("minecraft/java") || type.startsWith("minecraft/bedrock"));
    },
    desktopInitialWidth: 500,
    desktopInitialHeight: 400
  });
}
