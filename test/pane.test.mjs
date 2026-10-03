import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Load the geometry from the macOS pane script with the macOS-only bits stubbed out.
const src = readFileSync(new URL("../scripts/dock/dock-mac.js", import.meta.url), "utf8");
const paneFrame = new Function("ObjC", "$", "Application", src + "\nreturn paneFrame;")({ import() {} }, {}, () => ({}));
const screen = { x: 0, y: 25, w: 1728, h: 1080 };

test("the pane attaches beside the Claude window when the screen has room", () => {
  const f = paneFrame({ x: 40, y: 60, w: 1000, h: 900 }, screen, { width: 0, top: 52 });
  assert.equal(f.mode, "beside");
  assert.equal(f.x, 1040, "flush against Claude's right edge");
  assert.deepEqual([f.y, f.h], [60, 900], "same top and height as the window");
  assert.equal(f.w, 460);
});

test("without room it sits inside the right edge, below Claude's header", () => {
  const f = paneFrame({ x: 0, y: 25, w: 1728, h: 1080 }, screen, { width: 0, top: 52 });
  assert.equal(f.mode, "inside");
  assert.equal(f.x + f.w, 1728, "flush with the window's right edge");
  assert.deepEqual([f.y, f.h], [77, 1028]);
});

test("no pane on a window too small to share", () => {
  assert.equal(paneFrame({ x: 1000, y: 25, w: 700, h: 600 }, screen, { width: 0, top: 52 }), null);
});
