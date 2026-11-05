import { BufferAttribute, InstancedBufferGeometry, Matrix4, Vector3 } from "three";

const caches = new WeakMap<InstancedBufferGeometry, {
  attributes: { name: string; source: BufferAttribute["array"]; size: number }[];
  centers: Float32Array; order: Uint32Array; depth: Float32Array; transform?: Matrix4;
}>();

/** Three sorts meshes; instanced transparent faces also need ordering within each terrain mesh. */
export function sortTransparentFaces(geometry: InstancedBufferGeometry, transform: Matrix4) {
  let cache = caches.get(geometry);
  if (!cache) {
    const count = geometry.instanceCount;
    const attributes = Object.entries(geometry.attributes).filter(([name]) => name !== "position")
      .map(([name, attribute]) => ({ name, size: attribute.itemSize, source: (attribute as BufferAttribute).array.slice() }));
    const origins = geometry.getAttribute("aOrigin"), sizes = geometry.getAttribute("aSize"), faces = geometry.getAttribute("aFace");
    const centers = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const face = faces.getX(i), w = sizes.getX(i) / 2, h = sizes.getY(i) / 2;
      centers.set([origins.getX(i) + (face < 2 ? 0 : face < 4 ? h : w),
        origins.getY(i) + (face < 2 ? w : face < 4 ? 0 : h),
        origins.getZ(i) + (face < 2 ? h : face < 4 ? w : 0)], i * 3);
    }
    cache = { attributes, centers, order: Uint32Array.from({ length: count }, (_, i) => i), depth: new Float32Array(count) };
    caches.set(geometry, cache);
  }
  if (cache.transform?.equals(transform)) return;
  cache.transform = transform.clone();
  const center = new Vector3();
  for (let i = 0; i < cache.order.length; i++) cache.depth[i] = center.fromArray(cache.centers, i * 3).applyMatrix4(transform).z;
  cache.order.sort((a, b) => cache!.depth[a] - cache!.depth[b] || a - b);
  for (const { name, source, size } of cache.attributes) {
    const attribute = geometry.getAttribute(name) as BufferAttribute;
    for (let i = 0; i < cache.order.length; i++) for (let j = 0; j < size; j++) attribute.array[i * size + j] = source[cache.order[i] * size + j];
    attribute.needsUpdate = true;
  }
}
