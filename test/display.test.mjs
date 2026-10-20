// The private virtual screen (scripts/display.mjs): its geometry from config.json's virtualScreen,
// filled and bounded by the schema, the Xvfb arguments it gives, and server mode (own Xvfb or
// server.keepAlive, never a desktop).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../scripts/paths.mjs";
import { hasCommand, screenGeometry, serverMode, startVirtualDisplay, xvfbArgs } from "../scripts/display.mjs";

const cfg = DEFAULT_CONFIG;

test("screenGeometry fills defaults", () => {
  assert.deepEqual(screenGeometry(cfg), { width: 1366, height: 900, depth: 24 }, "today's screen by default");
  assert.deepEqual(screenGeometry({}), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(screenGeometry(undefined), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: null }), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: { width: 1280, height: 800 } }), { width: 1280, height: 800, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: { depth: 16 } }), { width: 1366, height: 900, depth: 16 });
  // Each field out of bounds or of the wrong type takes its own default; the others stay.
  assert.deepEqual(screenGeometry({ virtualScreen: { width: 799, height: 4321, depth: 30 } }), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: { width: 7680, height: 600, depth: "24" } }), { width: 7680, height: 600, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: { width: 1280.5, height: "800", depth: 24 } }), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: { width: 1e9, height: -1, depth: null } }), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(screenGeometry({ virtualScreen: [1280, 800] }), { width: 1366, height: 900, depth: 24 });
  assert.deepEqual(Object.keys(screenGeometry({ virtualScreen: { width: 1280, extra: 1 } })), ["width", "height", "depth"], "nothing else passes");
});

test("the virtual screen gets the configured geometry", () => {
  const args = xvfbArgs(99, screenGeometry({ virtualScreen: { width: 1280, height: 800, depth: 16 } }), "/x/run/Xauthority");
  assert.deepEqual(args, [":99", "-screen", "0", "1280x800x16", "-auth", "/x/run/Xauthority", "-nolisten", "tcp"]);
  assert.deepEqual(xvfbArgs(100, screenGeometry(cfg), "a"), [":100", "-screen", "0", "1366x900x24", "-auth", "a", "-nolisten", "tcp"], "today's arguments by default");
});

test("the virtual screen started reports its display, pid and geometry", { skip: process.platform !== "linux" || !hasCommand("Xvfb") || !hasCommand("xauth") }, async () => {
  const screen = await startVirtualDisplay(() => {}, { name: "Xauthority-geometry", geometry: { width: 1280, height: 800, depth: 24 } });
  try {
    assert.deepEqual(screen.geometry, { width: 1280, height: 800, depth: 24 });
    assert.equal(screen.env.DISPLAY, screen.display);
    assert.ok(Number.isInteger(screen.pid) && screen.pid > 0);
  } finally {
    screen.stop();
  }
});

test("serverMode: own Xvfb or keepAlive, never with display none or a desktop DISPLAY", () => {
  const keep = { ...cfg, server: { keepAlive: true } };
  assert.equal(serverMode(cfg, {}, "linux"), true, "no screen: its own Xvfb");
  assert.equal(serverMode({ ...cfg, display: "xvfb" }, { DISPLAY: ":0" }, "linux"), true, "xvfb always");
  assert.equal(serverMode(cfg, { DISPLAY: ":0" }, "linux"), false, "desktop Linux");
  assert.equal(serverMode(cfg, { WAYLAND_DISPLAY: "wayland-0" }, "linux"), false);
  assert.equal(serverMode({ ...cfg, display: "none" }, {}, "linux"), false, "display none");
  assert.equal(serverMode(cfg, {}, "darwin"), false, "macOS");
  assert.equal(serverMode(cfg, {}, "win32"), false, "Windows");
  // keepAlive says this is a server, screen or not.
  assert.equal(serverMode(keep, { DISPLAY: ":0" }, "linux"), true);
  assert.equal(serverMode({ ...keep, display: "none" }, {}, "linux"), true);
  assert.equal(serverMode(keep, {}, "darwin"), true);
  // Only a true keepAlive counts.
  for (const server of [{ keepAlive: false }, { keepAlive: "true" }, { keepAlive: 1 }, {}, null, undefined]) {
    assert.equal(serverMode({ ...cfg, server }, { DISPLAY: ":0" }, "linux"), false, JSON.stringify(server));
  }
});
