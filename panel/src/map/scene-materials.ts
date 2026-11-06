import { Color, DataTexture, DoubleSide, FloatType, FrontSide, NearestFilter, NearestMipmapLinearFilter, NoColorSpace, RGBAFormat, ShaderMaterial, TextureLoader, Vector2 } from "three";
import { minecraftAssets, SCENE_KIND_COUNT, SceneKind } from "../../../shared/scene";
import { minecraftAtlasUrl } from "./minecraft-atlas";

/** Java-style terrain shading: atlas pixels × biome tint × face/vertex lighting. */
export function sceneMaterials(sky: number, nether: boolean, ready: () => void, failed: () => void) {
  const atlas = new TextureLoader().load(minecraftAtlasUrl(), ready, undefined, failed);
  atlas.colorSpace = NoColorSpace;
  // Filter/mipmap premultiplied texels so transparent black RGB cannot darken foliage edges.
  atlas.premultiplyAlpha = true;
  atlas.magFilter = NearestFilter; atlas.minFilter = NearestMipmapLinearFilter;
  const layout = minecraftAssets.atlas;
  const slots = layout.columns * layout.height / layout.cell;
  const width = 2 ** Math.ceil(Math.log2(slots));
  const data = new Float32Array(width * 4);
  for (const [, first, frames, duration, interpolate] of minecraftAssets.textures) data.set([first, frames, duration, Number(interpolate)], first * 4);
  const animation = new DataTexture(data, width, 1, RGBAFormat, FloatType); animation.needsUpdate = true;
  const overlay = minecraftAssets.textures.find(texture => texture[0] === "block/grass_block_side_overlay")![1];
  const uniforms = {
    uAtlas: { value: atlas }, uAnimation: { value: animation }, uAnimationWidth: { value: width },
    uAtlasSize: { value: new Vector2(layout.width, layout.height) }, uColumns: { value: layout.columns },
    uCell: { value: layout.cell }, uInner: { value: layout.inner }, uPadding: { value: layout.padding },
    uOverlay: { value: overlay }, uTime: { value: 0 },
    uVerticalShade: { value: new Vector2(nether ? 0.9 : 1, nether ? 0.9 : 0.5) },
    uFogColor: { value: new Color(sky).convertLinearToSRGB() }, uFogNear: { value: 96 }, uFogFar: { value: 220 }
  };
  const materials = Array.from({ length: SCENE_KIND_COUNT }, (_, kind) => new ShaderMaterial({
    uniforms,
    vertexShader: `
      attribute vec3 color;
      attribute vec3 aTint1;
      attribute vec3 aTint2;
      attribute vec3 aTint3;
      attribute vec3 aUvU, aUvV;
      attribute vec3 aAxisU, aAxisV;
      attribute vec3 aOrigin;
      attribute vec2 aSize;
      attribute float aFace;
      // Texture index, flags and AO share one slot. Three also declares position,
      // normal and UV inputs; the complete shader must fit WebGL2's 16 slots.
      attribute vec3 aMaterial;
      uniform vec2 uVerticalShade;
      varying vec2 vUv;
      varying vec3 vTint0, vTint1, vTint2, vTint3;
      varying vec2 vCorner;
      varying vec3 vUvU, vUvV;
      varying float vTexture;
      varying float vFlags;
      varying float vShade;
      varying float vFogDistance;
      void main() {
        vec2 corner = position.xy;
        vec4 ao = mod(floor(vec4(aMaterial.z) / vec4(1.0, 4.0, 16.0, 64.0)), 4.0);
        bool reversed = aFace < 6.0 && mod(aFace, 2.0) > 0.5;
        if ((ao.x + ao.z > ao.y + ao.w) != reversed) corner = vec2(corner.y, 1.0 - corner.x);
        if (reversed) corner.x = 1.0 - corner.x;
        vec3 vertex = aOrigin;
        if (mod(floor(aMaterial.y / 64.0), 2.0) > 0.5) vertex += aAxisU * corner.x + aAxisV * corner.y;
        else if (aFace < 2.0) vertex += vec3(0.0, corner.x * aSize.x, corner.y * aSize.y);
        else if (aFace < 4.0) vertex += vec3(corner.y * aSize.y, 0.0, corner.x * aSize.x);
        else if (aFace < 6.0) vertex += vec3(corner.x * aSize.x, corner.y * aSize.y, 0.0);
        else vertex += vec3(aFace > 6.5 ? 1.0 - corner.x : corner.x, corner.y, corner.x);
        if (mod(floor(aMaterial.y / 16.0), 2.0) > 0.5) vertex.y += 0.015625;
        vec4 world = modelMatrix * vec4(vertex, 1.0);
        vec3 relative = world.xyz - cameraPosition;
        vUv = aFace < 2.0 ? corner.yx * aSize.yx : corner * aSize;
        vTint0 = color; vTint1 = aTint1; vTint2 = aTint2; vTint3 = aTint3;
        vCorner = corner;
        vUvU = aUvU; vUvV = aUvV;
        vTexture = aMaterial.x; vFlags = aMaterial.y;
        float shade = aFace < 2.0 ? 0.6 : aFace < 2.5 ? uVerticalShade.x : aFace < 3.5 ? uVerticalShade.y : aFace < 6.0 ? 0.8 : 1.0;
        float occlusion = corner.y > 0.5 ? (corner.x > 0.5 ? ao.z : ao.w) : (corner.x > 0.5 ? ao.y : ao.x);
        vShade = mod(floor(aMaterial.y / 8.0), 2.0) > 0.5 ? 1.0 : shade * (1.0 - occlusion * 0.2);
        vFogDistance = max(length(relative.xz), abs(relative.y));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(vertex, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uAtlas;
      uniform sampler2D uAnimation;
      uniform float uAnimationWidth;
      uniform vec2 uAtlasSize;
      uniform float uColumns;
      uniform float uCell;
      uniform float uInner;
      uniform float uPadding;
      uniform float uOverlay;
      uniform float uTime;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec2 vUv;
      varying vec3 vTint0, vTint1, vTint2, vTint3;
      varying vec2 vCorner;
      varying vec3 vUvU, vUvV;
      varying float vTexture;
      varying float vFlags;
      varying float vShade;
      varying float vFogDistance;
      vec2 mappedUv() {
        vec2 local = mod(floor(vFlags / 32.0), 2.0) > 0.5 ? vCorner : fract(vUv);
        return vec2(dot(vUvU, vec3(1.0, local)), dot(vUvV, vec3(1.0, local)));
      }
      vec4 sprite(float frame, vec2 du, vec2 dv) {
        vec2 cell = vec2(mod(frame, uColumns), floor(frame / uColumns));
        vec2 local = mappedUv();
        vec2 pixel = cell * uCell + uPadding + vec2(local.x, 1.0 - local.y) * uInner;
        vec2 uv = vec2(pixel.x / uAtlasSize.x, 1.0 - pixel.y / uAtlasSize.y);
        return textureGrad(uAtlas, uv, du, dv);
      }
      vec4 animatedSprite(float index, vec2 du, vec2 dv) {
        vec4 frames = texture2D(uAnimation, vec2((index + 0.5) / uAnimationWidth, 0.5));
        float clock = uTime / max(frames.z, 0.05);
        float current = mod(floor(clock), max(frames.y, 1.0));
        vec4 color = sprite(frames.x + current, du, dv);
        if (frames.w > 0.5 && frames.y > 1.0) color = mix(color, sprite(frames.x + mod(current + 1.0, frames.y), du, dv), fract(clock));
        return color;
      }
      void main() {
        // Fire models provide their own front/back faces. Avoid drawing a
        // reversed copy over the opposite face in the double-sided plant pass.
        if (mod(floor(vFlags / 64.0), 2.0) > 0.5 && !gl_FrontFacing) discard;
        // Differentiate the unwrapped UVs so merged faces keep crisp repeating pixels.
        vec2 unwrapped = mod(floor(vFlags / 32.0), 2.0) > 0.5 ? mappedUv() : vUv;
        vec2 du = dFdx(unwrapped) * uInner / uAtlasSize;
        vec2 dv = dFdy(unwrapped) * uInner / uAtlasSize;
        float footprint = max(length(du * uAtlasSize), length(dv * uAtlasSize));
        float mipLimit = min(1.0, 8.0 / max(footprint, 0.001));
        du *= mipLimit; dv *= mipLimit;
        vec4 texel = animatedSprite(vTexture, du, dv);
        vec3 tint = mix(mix(vTint0, vTint1, vCorner.x), mix(vTint3, vTint2, vCorner.x), vCorner.y);
        texel.rgb /= max(texel.a, 0.0001);
        if (mod(floor(vFlags / 4.0), 2.0) > 0.5) {
          vec4 grass = sprite(uOverlay, du, dv);
          grass.rgb /= max(grass.a, 0.0001);
          texel.rgb = mix(texel.rgb, grass.rgb * tint, grass.a);
        } else texel.rgb *= tint;
        if (texel.a < 0.1) discard;
        vec3 color = texel.rgb * vShade;
        float fog = clamp((vFogDistance - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
        gl_FragColor = vec4(mix(color, uFogColor, fog), ${kind === SceneKind.Translucent ? "texel.a" : "1.0"});
      }
    `,
    transparent: kind === SceneKind.Translucent,
    depthWrite: kind !== SceneKind.Translucent,
    side: kind === SceneKind.Plant || kind === SceneKind.Translucent ? DoubleSide : FrontSide,
    toneMapped: false
  }));
  for (const material of materials) Object.assign(material.defaultAttributeValues, { aAxisU: [0, 0, 0], aAxisV: [0, 0, 0] });
  return materials;
}
