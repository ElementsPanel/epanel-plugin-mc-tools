import { Matrix4 } from "three";

export const PERSPECTIVE_TRANSITION_MS = 800;
export const MAP_FOV = 55;

export function transitionPose(height: number, zoom: number, progress: number, topDistance?: number,
  orbit = { polar: Math.acos(1 / Math.sqrt(3)), azimuth: Math.PI / 4 }) {
  const p = Math.max(0, Math.min(1, progress));
  const eased = p * p * (3 - 2 * p);
  const tangent = Math.tan(MAP_FOV * Math.PI / 360);
  const start = topDistance ?? height / (2 * zoom * tangent), end = 160 / zoom;
  const distance = start * Math.pow(end / start, eased);
  const halfHeight = height / (2 * zoom) * Math.pow(end * tangent / (height / (2 * zoom)), eased);
  return { progress: eased, distance, halfHeight, polar: orbit.polar * eased, azimuth: orbit.azimuth * eased };
}

/** Normalize both projections at the target plane before blending homogeneous coordinates. */
export function transitionProjection(perspective: Matrix4, aspect: number, near: number, far: number, pose: ReturnType<typeof transitionPose>) {
  const h = pose.halfHeight;
  const matrix = new Matrix4().makeOrthographic(-h * aspect, h * aspect, h, -h, near, far);
  for (let i = 0; i < 16; i++) matrix.elements[i] = matrix.elements[i] * (1 - pose.progress) + perspective.elements[i] / pose.distance * pose.progress;
  return matrix;
}
