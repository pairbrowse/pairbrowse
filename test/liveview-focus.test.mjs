// The part of a handed-over tab the phone viewer opens zoomed to (liveview/focus.mjs): only a sane
// rectangle inside the viewport passes; a page that doesn't answer gives none.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanFocus, focusOf } from "../scripts/liveview/focus.mjs";

test("cleanFocus keeps a rectangle inside the viewport and nothing else", () => {
  assert.deepEqual(cleanFocus({ x: 440.4, y: 180, w: 400, h: 520, vw: 1280, vh: 813, kind: "frame" }), { x: 440, y: 180, w: 400, h: 520, vw: 1280, vh: 813, kind: "frame" });
  assert.equal(cleanFocus({ x: 440, y: 180, w: 400, h: 520, vw: 1280, vh: 813, kind: "<b>" }).kind, "fields");
  for (const bad of [null, "x", {}, { x: -1, y: 0, w: 10, h: 10, vw: 100, vh: 100 }, { x: 0, y: 0, w: 200, h: 10, vw: 100, vh: 100 }, { x: 0, y: 0, w: 0, h: 10, vw: 100, vh: 100 }, { x: 0, y: 0, w: 10, h: 10, vw: 0, vh: 100 }, { x: "1", y: 0, w: 10, h: 10, vw: 100, vh: 100 }]) {
    assert.equal(cleanFocus(bad), null, JSON.stringify(bad));
  }
});

test("focusOf: a closed tab or a page that doesn't answer gives null, an answer is cleaned", async () => {
  assert.equal(await focusOf(null), null);
  assert.equal(await focusOf({ isClosed: () => true }), null);
  assert.equal(await focusOf({ evaluate: () => Promise.reject(new Error("gone")) }), null);
  assert.deepEqual(await focusOf({ evaluate: async () => ({ x: 1, y: 2, w: 3, h: 4, vw: 10, vh: 10, kind: "field" }) }), { x: 1, y: 2, w: 3, h: 4, vw: 10, vh: 10, kind: "field" });
});
