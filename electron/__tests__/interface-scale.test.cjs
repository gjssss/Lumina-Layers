"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  SCALE_STEPS,
  createInterfaceScaleController,
  getInterfaceScale,
  interfaceScaleShortcut,
  readInterfaceScalePreference,
  resolveInitialWindowPlacement,
  resolveZoomFactor,
  setInterfaceScale,
  stepInterfaceScalePreference,
  writeInterfaceScalePreference,
} = require("../interface-scale.cjs");

// Logical sizes Electron reports for common screens.
const SCREENS = {
  fhd175: { width: 1097, height: 617 },
  fhd150: { width: 1280, height: 720 },
  fhd125: { width: 1536, height: 864 },
  fhd100: { width: 1920, height: 1080 },
  laptop1200p150: { width: 1280, height: 800 },
  qhd100: { width: 2560, height: 1440 },
  uhd100: { width: 3840, height: 2160 },
  ultrawide100: { width: 3440, height: 1440 },
};

function tempStateFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumina-interface-scale-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "interface-scale.json");
}

function display(bounds, size = { width: bounds.width, height: bounds.height }) {
  return { bounds, size, workArea: { ...bounds, height: bounds.height - 48 } };
}

function fakeScreen(displays) {
  const screen = new EventEmitter();
  screen.getPrimaryDisplay = () => displays[0];
  screen.getDisplayMatching = rect => displays.find(({ bounds }) =>
    rect.x >= bounds.x && rect.x < bounds.x + bounds.width &&
    rect.y >= bounds.y && rect.y < bounds.y + bounds.height) ?? displays[0];
  return screen;
}

function fakeWindow(bounds = { x: 0, y: 0, width: 1440, height: 900 }) {
  const window = new EventEmitter();
  window.bounds = bounds;
  window.getBounds = () => window.bounds;
  window.isDestroyed = () => false;
  const contents = new EventEmitter();
  contents.zoom = 1;
  contents.zoomCalls = [];
  contents.sent = [];
  contents.getZoomFactor = () => contents.zoom;
  contents.setZoomFactor = factor => { contents.zoom = factor; contents.zoomCalls.push(factor); };
  contents.send = (channel, payload) => contents.sent.push([channel, payload]);
  window.webContents = contents;
  return window;
}

function keyDown(key, modifiers = {}, code = "") {
  return { type: "keyDown", key, code, control: false, meta: false, alt: false, shift: false, ...modifiers };
}

test("100% follows native system scaling without compensating display resolution", () => {
  // OS DPI already maps logical pixels to physical pixels.
  assert.equal(resolveZoomFactor("100", SCREENS.fhd125), 1);
  assert.equal(resolveZoomFactor("100", SCREENS.fhd100), 1);
  assert.equal(resolveZoomFactor("100", SCREENS.qhd100), 1);
  assert.equal(resolveZoomFactor("100", SCREENS.laptop1200p150), 1);
  assert.equal(resolveZoomFactor("100", SCREENS.ultrawide100), 1);
});

test("native page zoom stays 1 across logical display sizes", () => {
  for (const size of Object.values(SCREENS)) {
    const zoom = resolveZoomFactor("100", size);
    assert.equal(zoom, 1, JSON.stringify(size));
  }
  assert.equal(resolveZoomFactor("100", SCREENS.fhd175), 1);
  assert.equal(resolveZoomFactor("100", SCREENS.uhd100), 1);
  assert.equal(resolveZoomFactor("100", { width: 0, height: 0 }), 1);
  assert.equal(resolveZoomFactor("100"), 1);
});

test("manual percentages are literal page zoom factors on every display", () => {
  assert.equal(resolveZoomFactor("80", SCREENS.fhd125), 0.8);
  assert.equal(resolveZoomFactor("110", SCREENS.fhd125), 1.1);
  assert.equal(resolveZoomFactor("175", SCREENS.qhd100), 1.75);
  for (const size of Object.values(SCREENS)) {
    const factors = SCALE_STEPS.map(step => resolveZoomFactor(step, size));
    assert.deepEqual(factors, SCALE_STEPS.map(step => Number(step) / 100));
    for (let index = 1; index < factors.length; index += 1) {
      assert.ok(factors[index] > factors[index - 1], `${JSON.stringify(size)}: ${factors}`);
    }
  }
});

test("an unknown preference falls back to native 100%", () => {
  for (const value of ["auto", "system", "300", "", null, undefined]) {
    assert.equal(resolveZoomFactor(value, SCREENS.fhd100), 1);
  }
});

test("zoom shortcuts move one step and stop at either end", () => {
  assert.equal(stepInterfaceScalePreference("100", "in"), "110");
  assert.equal(stepInterfaceScalePreference("100", "out"), "90");
  assert.equal(stepInterfaceScalePreference("175", "in"), "175");
  assert.equal(stepInterfaceScalePreference("80", "out"), "80");
  assert.equal(stepInterfaceScalePreference("150", "reset"), "100");
});

test("shortcuts use Ctrl, or Command on macOS, with plus, minus and zero", () => {
  assert.equal(interfaceScaleShortcut(keyDown("=", { control: true }), "win32"), "in");
  assert.equal(interfaceScaleShortcut(keyDown("+", { control: true, shift: true }), "win32"), "in");
  assert.equal(interfaceScaleShortcut(keyDown("-", { control: true }), "win32"), "out");
  assert.equal(interfaceScaleShortcut(keyDown("0", { control: true }), "win32"), "reset");
  // AZERTY: the zero key types "à" without Shift.
  assert.equal(interfaceScaleShortcut(keyDown("à", { control: true }, "Digit0"), "win32"), "reset");
  assert.equal(interfaceScaleShortcut(keyDown("=", { meta: true }), "darwin"), "in");
  assert.equal(interfaceScaleShortcut(keyDown("=", { control: true }), "darwin"), null);
});

test("shortcuts ignore AltGr characters, key releases and Ctrl+Insert", () => {
  assert.equal(interfaceScaleShortcut(keyDown("0", { control: true, alt: true }), "win32"), null);
  assert.equal(interfaceScaleShortcut({ ...keyDown("=", { control: true }), type: "keyUp" }, "win32"), null);
  assert.equal(interfaceScaleShortcut(keyDown("=", {}), "win32"), null);
  assert.equal(interfaceScaleShortcut(keyDown("=", { meta: true }), "win32"), null);
  assert.equal(interfaceScaleShortcut(keyDown("Insert", { control: true }, "Numpad0"), "win32"), null);
});

test("the saved preference survives restarts and falls back to 100%", t => {
  const stateFile = tempStateFile(t);
  assert.equal(readInterfaceScalePreference(stateFile), "100");
  writeInterfaceScalePreference(stateFile, "150");
  assert.equal(readInterfaceScalePreference(stateFile), "150");
  assert.deepEqual(fs.readdirSync(path.dirname(stateFile)), ["interface-scale.json"]);
  for (const contents of ["{", '{"schemaVersion":2,"preference":"150"}', '{"schemaVersion":1,"preference":"auto"}', '{"schemaVersion":1,"preference":"300"}']) {
    fs.writeFileSync(stateFile, contents);
    assert.equal(readInterfaceScalePreference(stateFile), "100");
  }
});

test("the first window is the old 1440x900 scaled by the zoom, maximized when that is too big", () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1032 };
  assert.deepEqual(resolveInitialWindowPlacement(workArea, 1), {
    maximize: false,
    bounds: { x: 240, y: 66, width: 1440, height: 900 },
  });
  assert.deepEqual(resolveInitialWindowPlacement(workArea, 1.25), {
    maximize: true,
    bounds: { x: 96, y: 52, width: 1728, height: 928 },
  });
  const laptop = { x: 492, y: 1080, width: 1280, height: 752 };
  const placement = resolveInitialWindowPlacement(laptop, 0.8);
  assert.equal(placement.maximize, true);
  assert.deepEqual(placement.bounds, { x: 556, y: 1118, width: 1152, height: 676 });
});

test("the controller applies, saves and announces a new preference", t => {
  const stateFile = tempStateFile(t);
  const screen = fakeScreen([display({ x: 0, y: 0, width: 1920, height: 1080 })]);
  const controller = createInterfaceScaleController({ screen, stateFile });
  assert.equal(controller.preference(), "100");
  assert.deepEqual(controller.initialPlacement(), {
    zoomFactor: 1,
    maximize: false,
    bounds: { x: 240, y: 66, width: 1440, height: 900 },
  });

  const window = fakeWindow({ x: 10, y: 10, width: 1600, height: 900 });
  controller.attach(window);
  assert.equal(controller.choose("150"), true);
  assert.deepEqual(window.webContents.zoomCalls, [1.5]);
  assert.deepEqual(window.webContents.sent, [["interface-scale-changed", { preference: "150" }]]);
  assert.equal(readInterfaceScalePreference(stateFile), "150");

  assert.equal(controller.choose("auto"), false);
  assert.equal(controller.preference(), "150");
  assert.deepEqual(window.webContents.zoomCalls, [1.5]);
});

test("navigation repairs inherited zoom and moving displays does not rescale the page", t => {
  const stateFile = tempStateFile(t);
  const external = display({ x: 0, y: 0, width: 1920, height: 1080 });
  const laptop = display({ x: 492, y: 1080, width: 1280, height: 800 });
  const screen = fakeScreen([external, laptop]);
  const controller = createInterfaceScaleController({ screen, stateFile });
  const window = fakeWindow({ x: 10, y: 10, width: 1600, height: 900 });
  window.webContents.zoom = 1.667; // Persisted by the former 4K / 150% calculation.
  controller.attach(window);

  window.webContents.emit("did-navigate");
  assert.deepEqual(window.webContents.zoomCalls, [1]);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  window.bounds = { x: 600, y: 1100, width: 1100, height: 700 };
  window.emit("move");
  window.emit("move");
  assert.deepEqual(window.webContents.zoomCalls, [1]);
  t.mock.timers.tick(200);
  assert.deepEqual(window.webContents.zoomCalls, [1]);

  laptop.size = { width: 1536, height: 960 };
  screen.emit("display-metrics-changed", {}, laptop, ["scaleFactor"]);
  assert.deepEqual(window.webContents.zoomCalls, [1]);

  window.emit("closed");
  assert.equal(screen.listenerCount("display-metrics-changed"), 0);
  assert.equal(screen.listenerCount("display-removed"), 0);
});

test("keyboard shortcuts step the preference and keep the key from the page", t => {
  const stateFile = tempStateFile(t);
  const screen = fakeScreen([display({ x: 0, y: 0, width: 1920, height: 1080 })]);
  const controller = createInterfaceScaleController({ screen, stateFile, platform: "win32" });
  const window = fakeWindow({ x: 10, y: 10, width: 1600, height: 900 });
  controller.attach(window);

  const press = input => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    window.webContents.emit("before-input-event", event, input);
    return event.defaultPrevented;
  };
  assert.equal(press(keyDown("=", { control: true })), true);
  assert.equal(controller.preference(), "110");
  assert.equal(press(keyDown("0", { control: true })), true);
  assert.equal(controller.preference(), "100");
  assert.equal(press(keyDown("-", { control: true })), true);
  assert.equal(controller.preference(), "90");
  assert.equal(press(keyDown("a", { control: true })), false);
  assert.equal(readInterfaceScalePreference(stateFile), "90");
  assert.deepEqual(window.webContents.zoomCalls, [1.1, 1, 0.9]);
});

test("only the trusted main frame may read or change the preference", t => {
  const stateFile = tempStateFile(t);
  const screen = fakeScreen([display({ x: 0, y: 0, width: 1920, height: 1080 })]);
  const controller = createInterfaceScaleController({ screen, stateFile });
  const mainFrame = { url: "http://127.0.0.1:4174/" };
  const webContents = { mainFrame };
  const trusted = { event: { sender: webContents, senderFrame: mainFrame }, window: { webContents }, trustedUrl: mainFrame.url };
  const workshopFrame = { ...trusted, event: { sender: webContents, senderFrame: { url: "lumina-workshop://module/" } } };

  assert.deepEqual(getInterfaceScale({ ...trusted, controller }), { status: "ok", preference: "100" });
  assert.deepEqual(getInterfaceScale({ ...workshopFrame, controller }), { status: "error", code: "denied" });
  assert.deepEqual(setInterfaceScale({ ...workshopFrame, controller, preference: "150" }), { status: "error", code: "denied" });
  assert.deepEqual(setInterfaceScale({ ...trusted, controller, preference: "300" }), { status: "error", code: "invalid" });
  assert.deepEqual(setInterfaceScale({ ...trusted, controller, preference: "125" }), { status: "ok", preference: "125" });
  assert.deepEqual(getInterfaceScale({ ...trusted, controller: null }), { status: "error", code: "unavailable" });
});
