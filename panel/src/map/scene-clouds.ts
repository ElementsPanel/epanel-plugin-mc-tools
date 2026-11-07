import { BufferAttribute, FrontSide, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial, Sphere, Vector3, Vector4 } from "three";
import clouds from "../../../shared/clouds.json";

/*
 * Minecraft's "fancy" clouds, ported from net.minecraft.client.renderer.CloudRenderer
 * and the core/clouds shaders of the client the atlas comes from (26.x):
 *
 * - textures/environment/clouds.png is a wrapping grid of 12×12-block cells, 4 blocks
 *   tall; a pixel with alpha < 10 is empty.
 * - The grid scrolls 0.03 blocks per game tick along +X of the texture (clouds drift
 *   west) and sits 3.96 blocks north; the overworld's cloud_height is 192.33.
 * - Cells are emitted in near-to-far diamond rings within ceil(range / 12) cells, so
 *   with depth writes the nearest translucent face wins.
 * - Top faces only when the camera is not below the layer, bottom faces only when it
 *   is not above it; sides only towards the camera and only next to an empty cell;
 *   the 3×3 cells around the camera also get inward-facing faces.
 * - Face shades: bottom 0.7, top 1, north/south 0.8, west/east 0.9, times the
 *   dimension's cloud_color #ccffffff; alpha fades linearly to zero at the cloud fog
 *   end, min(cloud range 128 chunks × 16, 2048).
 */
export const CLOUD_CELL_SIZE = 12;
export const CLOUD_THICKNESS = 4;
export const CLOUD_BLOCKS_PER_TICK = 0.030000001;
export const CLOUD_TICKS_PER_CELL = 400;
export const CLOUD_Z_OFFSET = 3.96;
export const CLOUD_HEIGHT = 192.33;
export const CLOUD_COLOR = [1, 1, 1, 0.8] as const;
export const CLOUD_RANGE = 2048;
export const TICKS_PER_SECOND = 20;
/** Blocks below the cloud base over which the map fades the layer out (not vanilla). */
export const CLOUD_FADE = 16;

export const enum CloudCamera { Above, Below, Inside }
export const enum CloudFace { Down, Up, North, South, West, East }
export const CLOUD_INSIDE_FACE = 16;
const NORTH_EMPTY = 8, EAST_EMPTY = 4, SOUTH_EMPTY = 2, WEST_EMPTY = 1, FILLED = 16;

export interface CloudTexture { width: number; height: number; cells: Uint8Array }

/** Mirror CloudRenderer.prepare: each filled cell records which neighbours are empty. */
export function cloudTexture(data: { width: number; height: number; cells: string } = clouds): CloudTexture {
  const { width, height } = data;
  const raw = atob(data.cells), filled = (x: number, z: number) => {
    const index = ((x % width + width) % width) + ((z % height + height) % height) * width;
    return (raw.charCodeAt(index >> 3) >> (index & 7)) & 1;
  };
  const cells = new Uint8Array(width * height);
  for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) {
    if (!filled(x, z)) continue;
    cells[x + z * width] = FILLED | (filled(x, z - 1) ? 0 : NORTH_EMPTY) | (filled(x + 1, z) ? 0 : EAST_EMPTY)
      | (filled(x, z + 1) ? 0 : SOUTH_EMPTY) | (filled(x - 1, z) ? 0 : WEST_EMPTY);
  }
  return { width, height, cells };
}

export function cloudCamera(cameraY: number, height = CLOUD_HEIGHT) {
  const below = height - cameraY;
  return below + CLOUD_THICKNESS < 0 ? CloudCamera.Above : below > 0 ? CloudCamera.Below : CloudCamera.Inside;
}

/** The texture cell under the camera and the camera's offset inside it, as CloudRenderer.prepare. */
export function cloudScroll(texture: CloudTexture, cameraX: number, cameraZ: number, ticks: number) {
  const scrolled = ticks % (texture.width * CLOUD_TICKS_PER_CELL);
  let x = cameraX + scrolled * CLOUD_BLOCKS_PER_TICK, z = cameraZ + CLOUD_Z_OFFSET;
  const width = texture.width * CLOUD_CELL_SIZE, depth = texture.height * CLOUD_CELL_SIZE;
  x -= Math.floor(x / width) * width; z -= Math.floor(z / depth) * depth;
  const cellX = Math.floor(x / CLOUD_CELL_SIZE), cellZ = Math.floor(z / CLOUD_CELL_SIZE);
  return { cellX, cellZ, offsetX: x - cellX * CLOUD_CELL_SIZE, offsetZ: z - cellZ * CLOUD_CELL_SIZE };
}

/** Faces as (cell dx, cell dz, direction | flags) triples, in CloudRenderer.buildMesh order. */
export function cloudFaces(texture: CloudTexture, cellX: number, cellZ: number, camera: CloudCamera, radius = Math.ceil(CLOUD_RANGE / CLOUD_CELL_SIZE)) {
  const faces: number[] = [];
  const emit = (dx: number, dz: number, face: number) => faces.push(dx, dz, face);
  const cell = (dx: number, dz: number) => {
    const data = texture.cells[((cellX + dx) % texture.width + texture.width) % texture.width + (((cellZ + dz) % texture.height + texture.height) % texture.height) * texture.width];
    if (!data) return;
    if (camera !== CloudCamera.Below) emit(dx, dz, CloudFace.Up);
    if (camera !== CloudCamera.Above) emit(dx, dz, CloudFace.Down);
    if (data & NORTH_EMPTY && dz > 0) emit(dx, dz, CloudFace.North);
    if (data & SOUTH_EMPTY && dz < 0) emit(dx, dz, CloudFace.South);
    if (data & WEST_EMPTY && dx > 0) emit(dx, dz, CloudFace.West);
    if (data & EAST_EMPTY && dx < 0) emit(dx, dz, CloudFace.East);
    if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) for (let face = 0; face < 6; face++) emit(dx, dz, face | CLOUD_INSIDE_FACE);
  };
  for (let ring = 0; ring <= radius * 2; ring++) for (let dx = -ring; dx <= ring; dx++) {
    const dz = ring - Math.abs(dx);
    if (dz < 0 || dz > radius || dx * dx + dz * dz > radius * radius) continue;
    if (dz !== 0) cell(dx, -dz);
    cell(dx, dz);
  }
  return new Float32Array(faces);
}

const vertexShader = `
  attribute vec3 aCell;
  uniform vec3 uOffset;
  uniform vec3 uCellSize;
  uniform vec4 uColor;
  varying float vDistance;
  varying vec4 vColor;
  // core/clouds.vsh packs its 24 face corners into three bit masks.
  const int packedX = 0xF03CC3;
  const int packedY = 0x6666F0;
  const int packedZ = 0xC3F066;
  vec3 corner(int index) {
    return vec3(float((packedX >> index) & 1), float((packedY >> index) & 1), float((packedZ >> index) & 1));
  }
  const vec4 faceColors[6] = vec4[6](
    vec4(0.7, 0.7, 0.7, 1.0), vec4(1.0, 1.0, 1.0, 1.0),
    vec4(0.8, 0.8, 0.8, 1.0), vec4(0.8, 0.8, 0.8, 1.0),
    vec4(0.9, 0.9, 0.9, 1.0), vec4(0.9, 0.9, 0.9, 1.0)
  );
  void main() {
    int quadVertex = int(position.x + 0.5);
    int flags = int(aCell.z + 0.5);
    int direction = flags & 7;
    bool inside = (flags & ${CLOUD_INSIDE_FACE}) != 0;
    vec3 face = corner(direction * 4 + (inside ? 3 - quadVertex : quadVertex));
    vec3 pos = face * uCellSize + vec3(aCell.x, 0.0, aCell.y) * uCellSize + uOffset;
    gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
    vDistance = length(pos - cameraPosition);
    vColor = faceColors[direction] * uColor;
  }
`;
const fragmentShader = `
  uniform float uFogEnd;
  uniform float uOpacity;
  varying float vDistance;
  varying vec4 vColor;
  void main() {
    vec4 color = vColor;
    // core/clouds.fsh: color.a *= 1 - linear_fog_value(distance, 0, FogCloudsEnd).
    color.a *= 1.0 - clamp(vDistance / uFogEnd, 0.0, 1.0);
    gl_FragColor = vec4(color.rgb, color.a * uOpacity);
  }
`;

/** The overworld cloud layer for one viewport; it follows the perspective camera. */
export class SceneClouds {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly texture = cloudTexture();
  private key = "";

  constructor() {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]), 3));
    // Minecraft draws quads; its sequential index buffer splits them as 0-1-2, 2-3-0.
    geometry.setIndex([0, 1, 2, 2, 3, 0]);
    geometry.setAttribute("aCell", new InstancedBufferAttribute(new Float32Array(3), 3));
    geometry.instanceCount = 0;
    const material = new ShaderMaterial({
      uniforms: {
        uOffset: { value: new Vector3() },
        uCellSize: { value: new Vector3(CLOUD_CELL_SIZE, CLOUD_THICKNESS, CLOUD_CELL_SIZE) },
        uColor: { value: new Vector4(...CLOUD_COLOR) },
        uFogEnd: { value: CLOUD_RANGE },
        uOpacity: { value: 1 }
      },
      vertexShader, fragmentShader,
      // RenderPipelines.CLOUDS: translucent blending, default depth test and write, back-face culling.
      transparent: true, depthWrite: true, depthTest: true, side: FrontSide, toneMapped: false
    });
    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    // After the terrain's translucent faces, as the level renderer draws clouds late.
    this.mesh.renderOrder = 1;
  }

  /** `camera` is in scene coordinates, which are world coordinates minus `origin`. */
  update(camera: Vector3, origin: { x: number; z: number }, ticks: number, opacity: number) {
    const scroll = cloudScroll(this.texture, camera.x + origin.x, camera.z + origin.z, ticks);
    const relative = cloudCamera(camera.y);
    const key = scroll.cellX + ":" + scroll.cellZ + ":" + relative;
    const geometry = this.mesh.geometry;
    if (key !== this.key) {
      this.key = key;
      const faces = cloudFaces(this.texture, scroll.cellX, scroll.cellZ, relative);
      geometry.setAttribute("aCell", new InstancedBufferAttribute(faces, 3));
      geometry.instanceCount = faces.length / 3;
    }
    const uniforms = this.mesh.material.uniforms;
    uniforms.uOffset.value.set(camera.x - scroll.offsetX, CLOUD_HEIGHT, camera.z - scroll.offsetZ);
    // Map-specific: a zoomed-out orbit can rise through the layer, where vanilla would
    // lay cloud tops over the whole map. Fade out over the last blocks below the base.
    opacity *= Math.max(0, Math.min(1, (CLOUD_HEIGHT - camera.y) / CLOUD_FADE));
    uniforms.uOpacity.value = opacity;
    geometry.boundingSphere = new Sphere(camera.clone(), CLOUD_RANGE + CLOUD_CELL_SIZE * 2);
    this.mesh.visible = opacity > 0.001 && geometry.instanceCount > 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
