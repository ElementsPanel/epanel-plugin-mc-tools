# epanel-plugin-mc-tools

Minecraft Java / Bedrock server status and saved world maps for ElementsPanel. Install and enable
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
view saved terrain in a popup. Desktop mode opens a managed map window. Drag to
pan, scroll or use the buttons to zoom, choose a world/dimension, enter X/Z to
jump, or return to spawn. The gold marker shows spawn; checkerboard areas have
no readable saved terrain. Use **Refresh** after saving changes on the server.
The viewer renders a top-down map with approximate block colors and height
shading, and only reads chunks in the visible area. It does not generate chunks.

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
appear. Map API calls require a logged-in user with access to the selected
instance. Paths are resolved inside the instance directory; world IDs returned
to the browser contain no filesystem paths. Reading does not issue server
commands or modify the save. Large Bedrock snapshots can take longer to load.

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
