# epanel-plugin-mc-tools

Minecraft Java / Bedrock server status, saved world maps and player management for ElementsPanel. Install and enable
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

Open **存档地图 / Saved World Map** in the instance console's function group to
view saved terrain in a popup. Desktop mode opens a managed map window. The
button at the top left opens the map settings sidebar, which starts closed in
both the console and public map. Choose the current world/dimension, coordinates,
view mode and height there. Close it with its close button or Escape. Drag to
pan, scroll or use the buttons to zoom, choose a world/dimension, enter X/Z to
jump, or return to spawn. The gold marker shows spawn; checkerboard areas have
no readable saved terrain. Use **Refresh** after saving changes on the server.
The viewer renders a top-down map with approximate block colors and height
shading, and only reads chunks in the visible area. It does not generate chunks.

Choose **水平切面 / Horizontal slice** in the view selector to inspect the blocks
at a specific Y coordinate. Drag the slider next to the view selector to move
through layers in steps of one block, or enter Y and press Enter or leave the
field. The map blends between layers while retaining the previous terrain
during loading, and reuses recently viewed layers when dragging back. Negative
heights are supported; the reader accepts Y from -2048 to 2047 for custom worlds.
The slider starts with the dimension's usual height range and expands for a
manually entered height outside that range. Layers outside the saved terrain
appear empty. Air stays transparent, so a slice does not show blocks above or
below the selected layer. Checkerboard
areas indicate air or unsaved chunks. Layer changes preserve position and zoom;
choose **地表 / Surface** to return to the terrain overview. Both Java and
Bedrock saves support slices, including the Nether ceiling.

Java saves use Anvil `.mca` regions, including legacy numeric blocks and modern
NBT palettes with negative heights. Legacy `Name` palettes and the 26.x string,
`id`/`properties`, and mixed NBT palette encodings are supported. Overworld,
Nether, End, Bukkit world folders and custom dimension folders are discovered
within the instance directory. Both the older `region` / `DIM-1` / `DIM1`
layout and the 26.x `dimensions/minecraft/{overworld,the_nether,the_end}` layout
are supported. If both layouts exist for a dimension, its newer directory takes
precedence. Spawn coordinates support both `SpawnX`/`SpawnZ` and `spawn.pos`,
including the dimension in `spawn.dimension`.
Gzip, zlib and uncompressed chunks, including external `.mcc` records, are
supported. LZ4-compressed chunks and older `.mcr` worlds are not supported. In
the Nether the viewer looks below the ceiling for exposed terrain.

Bedrock saves are discovered under `worlds/`, from `server.properties`, or in
the instance directory. The viewer reads LevelDB subchunks with persistent NBT
palettes (versions 1, 8 and 9, plus version 0 numeric blocks), supports negative
heights, and offers all three dimensions. Unvisited dimensions appear empty.
Older monolithic chunk formats are not supported. Unknown or damaged subchunks
are skipped with a warning instead of failing the whole map.

Bedrock requires the `leveldb-zlib` native dependency on the daemon. Install the
package's dependencies normally; platforms without a compatible prebuilt binary
require its native build tools. The live database is never opened by the
viewer. It copies a temporary snapshot, preferring filesystem copy-on-write,
and opens that copy so a running server retains its own database lock. Without
copy-on-write, the node's OS temporary directory needs room for a copy of the
world database. Refresh replaces the snapshot; snapshots are removed after
two idle minutes or when the plugin unloads. If compaction changes the database
during copying, snapshot creation retries and reports an error if it cannot
obtain a consistent file set.

Both panel and daemon must have this plugin enabled for the map action to
appear. The instance map and its private API require a logged-in user with access to the selected
instance. Paths are resolved inside the instance directory; world IDs returned
to the browser contain no filesystem paths. Reading does not issue server
commands or modify the save. Large Bedrock snapshots can take longer to load.

To offer a standalone map without requiring visitors to log in, open the panel's
**插件配置 / Plugin Configuration**, select **mc-tools**, and open
**添加/管理实例地图 / Add / manage instance maps**. Add a map by selecting its
node, Minecraft instance, and saved world/dimension. Instance names can be searched
and paginated. Give each map a public display name and, optionally, a stable URL
alias. An empty alias is generated when saving. Additions and edits stay as drafts
until **保存配置 / Save settings** is clicked. Turn on **启用存档地图公开页面 / Enable
the public saved-world map page** in either the plugin configuration or this map
management page and save.

The public page fills the screen with the map. Its map selector, coordinate controls,
layer slider and view link are inside the same floating sidebar used by the console
map, including on mobile screens. Both map views omit the direction indicator.
The catalogue is available at `https://your-panel/#/mc-tools/map`, or under
the panel's existing base path. A single map can be opened with
`#/mc-tools/map?map=alias`. **当前视图链接 / Link to this view** retains the map's
position, zoom and horizontal slice, including Y=0 and negative heights. The
instance map also shows a standalone-page link for worlds that have been opened
to the public, and administrators can open map management directly from it.

Public access defaults to disabled with no maps selected. Only the explicitly
listed saves/dimensions are exposed; selecting an instance does not automatically
publish its other worlds. Public links and map responses contain no private node,
instance or world identifiers. Configuration and map selection require an
administrator. Saving a removal or disabling public access stops subsequent and
in-flight map responses; images already downloaded by visitors cannot be recalled.
Visitors may refresh saved terrain, with forced snapshot refresh limited to once
per instance every 30 seconds. Normal private map refresh remains available.

Open **玩家管理 / Player Management** in the instance console's function group
to view online and known players, search by name/UUID/XUID, and filter allowlists,
operators and bans. Normal mode opens a dialog with a footer close button;
desktop mode opens a managed window. Lists refresh every 15 seconds while the
window is visible. Select **Manage** on a row or enter a player name, choose an
action, and execute it. Actions include kick, ban/unban, allowlist add/remove,
operator grant/revoke, all four game modes, and teleporting to coordinates or
another player. Bedrock's dedicated server has no built-in ban/unban commands,
so those actions are only offered for Java.

Java online lists use the GameSpy4 **Query full-stat protocol** over UDP,
without sending `list` to the console. When opening player management for a
Java instance with Query disabled, a dialog asks whether to enable it and
restart. **Cancel** leaves the configuration and process unchanged. Confirming
**Enable and restart** sets `enable-query=true` in the instance's
`server.properties` and requests a restart through the host's existing preset.
The dialog appears once per window opening, including for stopped instances;
instances that already enable Query do not prompt or restart again. The file's
other properties, comments, line endings and permissions are preserved. Saving
errors prevent restarting; restart request errors explicitly ask for a manual
restart. Alternatively, enable Query manually and restart the Minecraft server:

```properties
enable-query=true
query.port=25565
```

The daemon reads `query.port` (default `25565`, independent of the game/Ping
port). It uses the address from Minecraft Status settings when supplied,
otherwise `server-ip`, otherwise local loopback. Query's UDP port must be
reachable from the daemon; containers may require a UDP port mapping. The
plugin changes the enable flag and requests a restart only after confirmation. Disabled,
unreachable, malformed or incomplete Query responses show a warning and
unknown online status; Java does not fall back to console polling. Bedrock
continues to obtain its online list through the console `list` command.

Management actions use the instance's existing console command preset and
require no extra RCON configuration. They listen for native command responses,
report rejections, and do not claim success when a command is not confirmed.
Servers or plugins that change the standard English console responses may need
their console checked manually. Saved Java player caches, allowlists, operators
and active bans, plus Bedrock allowlists and XUID permissions, remain readable
while stopped; actions require a running server. These files are never edited
by the plugin. All player routes require access to the selected instance, and
commands validate player names, reasons, modes and teleport destinations on
both the panel and daemon. Closing the view cancels its refresh timer and HTTP
requests; daemon requests clean up their sockets/listeners on response, timeout, stop
or plugin unload.

Older instance packages (including `@elementspanel/epanel-plugin-instance@1.0.11`)
already supply `refreshPlayers` and the `mcstats` action. When either is present,
mc-tools retains that existing contribution to avoid duplicate presets, buttons
and polling. Hosts with those contributions removed use this package's migrated
implementation. Updating only the external plugin does not remove code from an
already installed instance package.

Run `npm test --workspace epanel-plugin-mc-tools` for protocol, lifecycle, map
readers, snapshot isolation, permissions and frontend integration checks.
Run `npm run build --workspace epanel-plugin-mc-tools`
to generate this plugin's panel/frontend and daemon/backend assets. `prepack`
also builds the plugin before publishing. Package metadata lives in
`package.json`; each side's `plugin.json` contains execution entries only.
