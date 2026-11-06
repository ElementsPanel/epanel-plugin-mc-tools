const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loader } = require("./helpers.cjs");
const { KeyboardNavigation } = loader()("panel/src/map/navigation.ts");
const near = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

function fixture(t) {
  const window = new EventTarget(), document = Object.assign(new EventTarget(), { defaultView: window, hidden: false });
  const canvas = Object.assign(new EventTarget(), { ownerDocument: document });
  let now = 0, enabled = true, wakes = 0;
  t.mock.method(performance, "now", () => now);
  const navigation = new KeyboardNavigation(canvas, () => enabled, () => wakes++);
  t.after(() => navigation.dispose());
  const key = (type, code, extras = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { code, ...extras });
    canvas.dispatchEvent(event); return event.defaultPrevented;
  };
  return { navigation, canvas, document, window, key,
    advance(time) { now = time; return navigation.advance(time); },
    enable(value) { enabled = value; }, wakes: () => wakes,
    reset() { navigation.clear(); now = 0; }
  };
}

test("held keys accelerate smoothly with equal travel at 30, 60 and 144 Hz and normalized combinations", t => {
  const f = fixture(t);
  function travel(codes, fps, repeat = false) {
    f.reset(); codes.forEach(code => assert(f.key("keydown", code)));
    const total = { x: 0, y: 0 }, steps = [];
    for (let frame = 1; frame <= fps; frame++) {
      if (repeat) codes.forEach(code => f.key("keydown", code, { repeat: true }));
      const delta = f.advance(frame * 1000 / fps); assert(delta);
      total.x += delta.x; total.y += delta.y; steps.push(Math.hypot(delta.x, delta.y));
    }
    return { ...total, steps };
  }
  const straight = travel(["KeyW"], 60);
  assert(straight.steps[0] > 0 && straight.steps[0] < straight.steps[1]);
  assert(straight.steps[1] < straight.steps[2]);
  assert(-straight.y > 250 && -straight.y < 320, "steady walking speed after a gentle start");
  for (const fps of [30, 60, 144]) {
    near(travel(["KeyW"], fps).y, straight.y);
    near(travel(["KeyW"], fps, true).y, straight.y);
    near(travel(["KeyW", "ArrowUp"], fps).y, straight.y);
    const diagonal = travel(["KeyW", "KeyA"], fps);
    near(diagonal.x, diagonal.y); near(Math.hypot(diagonal.x, diagonal.y), -straight.y);
  }
});

test("opposite keys cancel, releasing one direction preserves the other, and release stops immediately", t => {
  const f = fixture(t);
  f.key("keydown", "KeyW"); f.key("keydown", "KeyS");
  assert.equal(f.advance(16), undefined);
  f.key("keyup", "KeyS"); assert(f.advance(32).y < 0);
  f.key("keydown", "KeyA"); const diagonal = f.advance(48);
  assert(diagonal.x < 0 && diagonal.y < 0);
  f.key("keyup", "KeyW"); const left = f.advance(64);
  assert(left.x < 0); assert.equal(left.y, 0);
  f.key("keyup", "KeyA"); assert.equal(f.advance(80), undefined);
  assert.equal(f.advance(96), undefined);
  f.key("keydown", "KeyD"); const first = f.advance(112);
  assert(first.x > 0 && first.x < -left.x, "a fresh press accelerates from rest");
  const delayed = f.advance(10_000);
  assert(delayed.x > 0 && delayed.x <= 16, "a stalled frame cannot teleport the camera");
});

test("blur, hidden tabs and disabled views clear movement, and key repeats cannot restart it", t => {
  const f = fixture(t);
  const exits = [
    () => f.canvas.dispatchEvent(new Event("blur")),
    () => f.window.dispatchEvent(new Event("blur")),
    () => { f.document.hidden = true; f.document.dispatchEvent(new Event("visibilitychange")); },
    () => f.enable(false)
  ];
  for (const leave of exits) {
    f.reset(); f.key("keydown", "KeyW"); assert(f.advance(16).y < 0);
    leave(); assert.equal(f.advance(32), undefined);
    f.document.hidden = false; f.enable(true);
    f.key("keydown", "KeyW", { repeat: true }); assert.equal(f.advance(48), undefined);
    f.key("keydown", "KeyW"); assert(f.advance(64).y < 0);
  }
});

test("navigation preserves shortcuts and disposed inputs no longer intercept keys or wake frames", t => {
  const f = fixture(t);
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
    f.reset(); f.key("keydown", "KeyW"); assert(f.advance(16).y < 0);
    assert.equal(f.key("keydown", "KeyA", modifiers), false); assert.equal(f.advance(32), undefined);
  }
  assert.equal(f.key("keydown", "Space"), false);
  f.enable(false); assert.equal(f.key("keydown", "KeyW"), false); f.enable(true);
  f.key("keydown", "KeyW"); const wakes = f.wakes(); f.navigation.dispose();
  assert.equal(f.key("keydown", "KeyD"), false); f.key("keyup", "KeyW");
  assert.equal(f.advance(64), undefined); assert.equal(f.wakes(), wakes);
});

test("shared map input drives only the enabled renderer even when both listen on the same canvas", t => {
  const f = fixture(t); let sceneEnabled = false, sceneWakes = 0;
  const scene = new KeyboardNavigation(f.canvas, () => sceneEnabled, () => sceneWakes++);
  t.after(() => scene.dispose());
  f.key("keydown", "KeyW"); assert(f.advance(16).y < 0);
  assert.equal(scene.advance(16), undefined); assert.equal(sceneWakes, 0);
  f.navigation.clear(); f.enable(false); sceneEnabled = true;
  f.key("keydown", "KeyA"); assert.equal(f.advance(32), undefined);
  assert(scene.advance(32).x < 0); assert.equal(sceneWakes, 1);
  scene.clear(); sceneEnabled = false; f.enable(true);
  f.key("keydown", "KeyD"); assert(f.advance(48).x > 0); assert.equal(scene.advance(48), undefined);
});
