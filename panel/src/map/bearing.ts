/** Clockwise radians from north (-Z). */
export const normalizeBearing = (angle: number) => ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

export function screenToWorld(x: number, y: number, bearing = 0) {
  const c = Math.cos(bearing), s = Math.sin(bearing);
  return { x: c * x - s * y, z: s * x + c * y };
}

export function worldToScreen(x: number, z: number, bearing = 0) {
  const c = Math.cos(bearing), s = Math.sin(bearing);
  return { x: c * x + s * z, y: -s * x + c * z };
}

export function rotatedSize(width: number, height: number, bearing = 0) {
  const c = Math.abs(Math.cos(bearing)), s = Math.abs(Math.sin(bearing));
  return { width: width * c + height * s, height: width * s + height * c };
}

/** Screen-axis separating tests supplement the world-axis bounds of rotated coverage. */
export function tileInView(x: number, z: number, size: number, camera: { x: number; z: number }, halfWidth: number, halfHeight: number, bearing: number) {
  const center = worldToScreen(x + size / 2 - camera.x, z + size / 2 - camera.z, bearing);
  const radius = size / 2 * (Math.abs(Math.cos(bearing)) + Math.abs(Math.sin(bearing)));
  return Math.abs(center.x) <= halfWidth + radius + 1e-6 && Math.abs(center.y) <= halfHeight + radius + 1e-6;
}
