const directions: Record<string, readonly [number, number]> = {
  KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0]
};

export function keyboardPan(event: KeyboardEvent) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  return directions[event.code];
}
