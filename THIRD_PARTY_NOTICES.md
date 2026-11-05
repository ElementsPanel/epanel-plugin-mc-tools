# Minecraft texture assets

The saved-world 3D viewer includes a texture atlas derived from the
user-supplied Minecraft Java Edition 26.2 client JAR. Minecraft texture artwork
is copyright Mojang Studios / Microsoft and is not covered by this plugin's
Apache-2.0 license. Minecraft is a trademark of Mojang Studios.

The import keeps the original block sprite pixels (using nearest-neighbor
resizing for sprites larger than the atlas's 16-pixel tile), transparency and
animation sequences. Padding around each sprite is extruded from its edge
pixels for mipmap sampling. The missing-texture checker is generated locally.
The source JAR and generated atlas SHA-256 hashes are recorded in
`panel/src/assets/minecraft/source.json`.

The original model JSON files supply face texture references and tint masks.
Biome colors come from the JAR's biome definitions and grass, foliage and
dry-foliage colormaps.
The preview's own renderer references the behavior of `CardinalLighting`,
`BlockModelLighter`, and the client terrain and fog shaders. The original Java
classes and client executables are not included in the plugin.
