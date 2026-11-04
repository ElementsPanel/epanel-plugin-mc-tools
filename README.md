# epanel-plugin-mc-tools

Minecraft Java / Bedrock server status for ElementsPanel. Install and enable
`mc-tools` on the panel and on each daemon that hosts Minecraft instances.

Open **Minecraft 状态获取 / Minecraft Status** in the instance actions (normal or
desktop mode), enter the game port and optionally the server address, then save.
An empty address uses `localhost` on the daemon. Running Minecraft instances are
queried every minute; their existing status display receives online/max players,
version and latency. An empty port or `0` disables querying. Java uses the legacy
TCP server-list ping; Bedrock uses RakNet UDP ping and reports latency as `0`, as
in the original implementation. A failed query clears the previous status.

The implementation was migrated from ElementsPanel's
`plugins/instance/daemon/src/backend/mcstats.ts`, `core/common/src/mcping.ts`, and
`plugins/instance/panel/src/mcstats/`. It uses the host's instance, preset,
lifecycle and frontend action services, and the existing permission-checked
instance configuration API. It has no runtime imports from the source checkout.
Translations for all 12 panel languages are included.

Older instance packages (including `@elementspanel/epanel-plugin-instance@1.0.11`)
already supply `refreshPlayers` and the `mcstats` action. When either is present,
mc-tools retains that existing contribution to avoid duplicate presets, buttons
and polling. Hosts with those contributions removed use this package's migrated
implementation. Updating only the external plugin does not remove code from an
already installed instance package.

Run `npm test --workspace epanel-plugin-mc-tools` for protocol, lifecycle and
frontend integration checks. Run `npm run build --workspace epanel-plugin-mc-tools`
to generate this plugin's panel/frontend and daemon/backend assets. `prepack`
also builds the plugin before publishing. Package metadata lives in
`package.json`; each side's `plugin.json` contains execution entries only.
