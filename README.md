# epanel-plugin-mc-tools

All plugin metadata belongs in package.json: version, description, displayName, author and keywords describe the package; elementspanel.id and elementspanel.dual define its identity and dual status. Runtime metadata belongs in elementspanel.<side>, including priority, frontendInject and elements.

Each side's plugin.json contains only execution entries such as backend and frontend. Generated CSS paths are saved in package.json under elementspanel.panel.styles.

The complete build command lives in this package's scripts.build and uses its own devDependencies. Run npm run build in this directory, or npm run build --workspace epanel-plugin-mc-tools from the project root. The prepack script runs it before publishing.

Available for: panel.
