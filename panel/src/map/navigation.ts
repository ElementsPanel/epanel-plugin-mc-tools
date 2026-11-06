const directions: Record<string, readonly [number, number]> = {
  KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0]
};

const SPEED = 320; // CSS pixels per second, converted by each renderer's projection.
const ACCELERATION_TIME = .08;

/** Held keys drive the renderer's animation loop; OS key-repeat never drives movement. */
export class KeyboardNavigation {
  private readonly keys = new Set<string>();
  private speed = 0;
  private time?: number;
  private disposed = false;
  private readonly document: Document | undefined;
  private readonly window: Window | null | undefined;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly enabled: () => boolean, private readonly wake: () => void) {
    this.document = canvas.ownerDocument;
    this.window = this.document?.defaultView;
    canvas.addEventListener("keydown", this.down);
    canvas.addEventListener("keyup", this.up);
    canvas.addEventListener("blur", this.clear);
    this.window?.addEventListener("blur", this.clear);
    this.document?.addEventListener("visibilitychange", this.visibility);
  }

  private direction() {
    const held = [...this.keys].map(key => directions[key]);
    const x = Number(held.some(value => value[0] > 0)) - Number(held.some(value => value[0] < 0));
    const y = Number(held.some(value => value[1] > 0)) - Number(held.some(value => value[1] < 0));
    const length = Math.hypot(x, y) || 1;
    return { x: x / length, y: y / length };
  }

  private down = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) { this.clear(); return; }
    if (this.disposed || event.defaultPrevented || !directions[event.code] || !this.enabled() || this.document?.hidden) return;
    event.preventDefault();
    // After blur or a mode switch, require a fresh press rather than resuming a lost key.
    if (this.keys.has(event.code) || event.repeat) return;
    this.keys.add(event.code);
    this.time ??= performance.now();
    this.wake();
  };

  private up = (event: KeyboardEvent) => {
    if (!this.keys.delete(event.code)) return;
    const direction = this.direction();
    if (!direction.x && !direction.y) { this.speed = 0; this.time = undefined; }
    else { this.time ??= performance.now(); this.wake(); }
  };

  private visibility = () => { if (this.document?.hidden) this.clear(); };
  clear = () => { this.keys.clear(); this.speed = 0; this.time = undefined; };

  advance(time: number) {
    if (this.disposed || !this.enabled() || this.document?.hidden) { this.clear(); return; }
    const direction = this.direction();
    if (!direction.x && !direction.y) { this.speed = 0; this.time = undefined; return; }
    const elapsed = Math.max(0, Math.min(.05, (time - (this.time ?? time)) / 1000));
    this.time = time;
    // Integrate acceleration exactly so 30/60/144 Hz displays travel the same distance.
    const decay = Math.exp(-elapsed / ACCELERATION_TIME);
    const distance = SPEED * elapsed + (this.speed - SPEED) * ACCELERATION_TIME * (1 - decay);
    this.speed = SPEED + (this.speed - SPEED) * decay;
    return { x: direction.x * distance, y: direction.y * distance };
  }

  dispose() {
    this.disposed = true; this.clear();
    this.canvas.removeEventListener("keydown", this.down);
    this.canvas.removeEventListener("keyup", this.up);
    this.canvas.removeEventListener("blur", this.clear);
    this.window?.removeEventListener("blur", this.clear);
    this.document?.removeEventListener("visibilitychange", this.visibility);
  }
}
