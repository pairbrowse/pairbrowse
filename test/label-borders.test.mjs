// A pointer's name label is a clean filled pill on every surface: no border, outline or ring
// (box-shadow). The pointer arrow itself keeps its colored edge. Surfaces: the in-page agent
// cursor and other people's pointers (scripts/hud/cursor.js PILL, scripts/hud/pointers.js), the
// live view's joiner pointers (scripts/liveview.css), the joiner's picture page (ui/screen).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const RING = /\b(border|outline|box-shadow)\s*:/i;
const rule = (css, selector) => {
  const at = css.indexOf(`${selector} {`) >= 0 ? css.indexOf(`${selector} {`) : css.indexOf(`${selector}{`);
  assert.ok(at >= 0, `${selector} is styled`);
  return css.slice(at, css.indexOf("}", at));
};

test("pointer name labels have no border, outline or ring anywhere", () => {
  const cursor = read("scripts/hud/cursor.js");
  const pill = cursor.match(/const PILL = "([^"]*(?:\\"[^"]*)*)"/)?.[1];
  assert.ok(pill, "the shared pill style");
  assert.doesNotMatch(pill, RING, "the hud pill (agent cursor, people's pointers, view markers)");
  const pointers = read("scripts/hud/pointers.js");
  for (const sel of ["span{", ".p.a span{", ".v b{"]) {
    const at = pointers.indexOf(sel);
    assert.ok(at >= 0, sel);
    assert.doesNotMatch(pointers.slice(at, pointers.indexOf("}", at)).replace("${PILL}", ""), RING, `hud pointers ${sel}`);
  }
  assert.doesNotMatch(rule(read("scripts/liveview.css"), ".frame .joiner-pointer span"), RING, "the live view's joiner pointers");
  assert.doesNotMatch(rule(read("ui/screen/screen.css"), ".p span"), RING, "the joiner's picture page");
});
