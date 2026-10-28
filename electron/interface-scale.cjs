"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { isTrustedMainFrameSender } = require("./generated-file-directory.cjs");

const STATE_VERSION = 1;
// Electron already applies native OS DPI. Display size is not a page zoom input.
const DEFAULT_PREFERENCE = "100";
// Explicit user-selected percentages, relative to native 100%.
const SCALE_STEPS = Object.freeze(["80", "90", "100", "110", "125", "150", "175"]);
const PREFERENCES = new Set(SCALE_STEPS);
const DEFAULT_WINDOW_SIZE = { width: 1440, height: 900 };
const MAX_WINDOWED_SHARE = 0.9;
const MOVE_SETTLE_MS = 200;
const DISPLAY_EVENTS = ["display-metrics-changed", "display-added", "display-removed"];

function isInterfaceScalePreference(value) {
  return typeof value === "string" && PREFERENCES.has(value);
}

/**
 * Resolve literal user zoom without compensating native display scaling.
 * 按用户选择解析页面比例，不再额外补偿系统缩放或显示器分辨率。
 * The second argument remains accepted for existing callers.
 */
function resolveZoomFactor(preference, displaySize) {
  const percent = isInterfaceScalePreference(preference)
    ? Number(preference)
    : Number(DEFAULT_PREFERENCE);
  return percent / 100;
}

/** Next preference for a zoom shortcut; stays put at either end. */
function stepInterfaceScalePreference(preference, direction) {
  if (direction === "reset") return DEFAULT_PREFERENCE;
  const index = SCALE_STEPS.indexOf(isInterfaceScalePreference(preference) ? preference : DEFAULT_PREFERENCE);
  const next = Math.min(SCALE_STEPS.length - 1, Math.max(0, index + (direction === "in" ? 1 : -1)));
  return SCALE_STEPS[next];
}

/**
 * Maps Ctrl (Command on macOS) with +, - or 0 to a zoom direction. Alt is
 * excluded because AltGr arrives as Ctrl+Alt on Windows keyboard layouts.
 */
function interfaceScaleShortcut(input, platform) {
  if (input?.type !== "keyDown" || input.alt) return null;
  if (!(platform === "darwin" ? input.meta : input.control)) return null;
  if (input.key === "+" || input.key === "=") return "in";
  if (input.key === "-" || input.key === "_") return "out";
  if (input.key === "0" || input.code === "Digit0") return "reset";
  return null;
}

function readInterfaceScalePreference(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (parsed?.schemaVersion === STATE_VERSION && isInterfaceScalePreference(parsed.preference)) {
      return parsed.preference;
    }
  } catch (_) { /* Missing or unreadable state falls back to 100%. */ }
  return DEFAULT_PREFERENCE;
}

function writeInterfaceScalePreference(stateFile, preference) {
  const temporary = `${stateFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: STATE_VERSION, preference })}\n`, { flag: "wx" });
    fs.renameSync(temporary, stateFile);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) { /* Already renamed into place. */ }
  }
}

/**
 * The historical 1440×900 default scaled by the zoom. Windows that would take
 * more than 90% of the work area start maximized; the centered bounds are
 * what un-maximizing restores.
 */
function resolveInitialWindowPlacement(workArea, zoomFactor) {
  const wantedWidth = Math.round(DEFAULT_WINDOW_SIZE.width * zoomFactor);
  const wantedHeight = Math.round(DEFAULT_WINDOW_SIZE.height * zoomFactor);
  const maxWidth = Math.floor(workArea.width * MAX_WINDOWED_SHARE);
  const maxHeight = Math.floor(workArea.height * MAX_WINDOWED_SHARE);
  const width = Math.min(wantedWidth, maxWidth);
  const height = Math.min(wantedHeight, maxHeight);
  return {
    maximize: wantedWidth > maxWidth || wantedHeight > maxHeight,
    bounds: {
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + Math.round((workArea.height - height) / 2),
      width,
      height,
    },
  };
}

/**
 * Owns the saved preference and keeps the main window's page zoom in line
 * with it and with the display the window is on.
 */
function createInterfaceScaleController({
  screen,
  stateFile,
  platform = process.platform,
  log = () => {},
  logError = () => {},
}) {
  let preference = readInterfaceScalePreference(stateFile);
  let window = null;
  let settleTimer = null;

  const isLive = () => Boolean(window && !window.isDestroyed());
  const currentDisplay = () => (isLive()
    ? screen.getDisplayMatching(window.getBounds())
    : screen.getPrimaryDisplay());

  function apply() {
    if (!isLive()) return;
    const display = currentDisplay();
    const factor = resolveZoomFactor(preference, display.size);
    if (Math.abs(window.webContents.getZoomFactor() - factor) < 0.001) return;
    window.webContents.setZoomFactor(factor);
    log(`Interface scale ${preference}: zoom ${factor} on a ${display.size.width}x${display.size.height} display`);
  }

  function choose(next) {
    if (!isInterfaceScalePreference(next)) return false;
    if (next !== preference) {
      preference = next;
      try {
        writeInterfaceScalePreference(stateFile, next);
      } catch (error) {
        logError(`Interface scale not saved: ${error.code || error.message}`);
      }
    }
    apply();
    if (isLive()) window.webContents.send("interface-scale-changed", { preference });
    return true;
  }

  function attach(target) {
    window = target;
    const reapply = () => apply();
    const reapplyAfterMove = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(reapply, MOVE_SETTLE_MS);
    };
    for (const name of DISPLAY_EVENTS) screen.on(name, reapply);
    target.on("move", reapplyAfterMove);
    // setZoomFactor is ignored until the first navigation commits.
    target.webContents.on("did-navigate", reapply);
    target.webContents.on("before-input-event", (event, input) => {
      const direction = interfaceScaleShortcut(input, platform);
      if (!direction) return;
      event.preventDefault();
      choose(stepInterfaceScalePreference(preference, direction));
    });
    target.once("closed", () => {
      clearTimeout(settleTimer);
      for (const name of DISPLAY_EVENTS) screen.off(name, reapply);
      window = null;
    });
  }

  function initialPlacement() {
    const display = screen.getPrimaryDisplay();
    const zoomFactor = resolveZoomFactor(preference, display.size);
    return { zoomFactor, ...resolveInitialWindowPlacement(display.workArea, zoomFactor) };
  }

  return { attach, choose, initialPlacement, preference: () => preference };
}

function getInterfaceScale({ event, window, trustedUrl, controller }) {
  if (!controller) return { status: "error", code: "unavailable" };
  if (!isTrustedMainFrameSender(event, window, trustedUrl)) return { status: "error", code: "denied" };
  return { status: "ok", preference: controller.preference() };
}

function setInterfaceScale({ event, window, trustedUrl, controller, preference }) {
  if (!controller) return { status: "error", code: "unavailable" };
  if (!isTrustedMainFrameSender(event, window, trustedUrl)) return { status: "error", code: "denied" };
  return controller.choose(preference)
    ? { status: "ok", preference: controller.preference() }
    : { status: "error", code: "invalid" };
}

module.exports = {
  SCALE_STEPS,
  createInterfaceScaleController,
  getInterfaceScale,
  interfaceScaleShortcut,
  isInterfaceScalePreference,
  readInterfaceScalePreference,
  resolveInitialWindowPlacement,
  resolveZoomFactor,
  setInterfaceScale,
  stepInterfaceScalePreference,
  writeInterfaceScalePreference,
};
