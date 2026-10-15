// Compact layouts (scripts/daemon/reveal.mjs): how the controls that unfold a folded search box or
// menu are named to the agent. The page scan itself runs in a browser (narrow.integration.test.mjs).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { revealItem, revealNote, foldedLine, revealScan, REVEAL_MAX } from "../scripts/daemon/reveal.mjs";

const menu = { role: "button", name: "Main menu", ref: "e8", why: "a collapsed menu", tier: 5 };
const search = { role: "link", name: "Search", ref: "e18", why: "next to it", tier: 2 };

test("a control is named by role, name and ref, with why it's offered", () => {
  assert.equal(revealItem(search), 'link "Search" (ref e18, next to it)');
  assert.equal(revealItem({ role: "control", name: "", ref: "e4", why: "a collapsed menu" }), "an unnamed menu toggle (ref e4, a collapsed menu)");
  assert.equal(revealItem({ role: "button", name: "Menu", ref: "", why: "a button in the page's header" }), "button \"Menu\" (a button in the page's header)");
});

test("a failed look names the controls that may unfold it, or nothing", () => {
  assert.equal(revealNote(null), "");
  assert.equal(revealNote({ hidden: true, list: [] }), "");
  const hidden = revealNote({ hidden: true, list: [search, menu] });
  assert.match(hidden, /^ It's on the page, hidden behind a control/);
  assert.match(hidden, /Open one of these, then try again: link "Search" \(ref e18, next to it\); button "Main menu" \(ref e8, a collapsed menu\)\.$/);
  const absent = revealNote({ hidden: false, list: [menu] });
  assert.match(absent, /^ It may be behind a control that opens it/);
  assert.match(absent, /Open this, then try again: button "Main menu"/);
  const many = revealNote({ hidden: false, list: Array.from({ length: 9 }, (_, i) => ({ ...menu, ref: `e${i}` })) });
  assert.equal(many.match(/button "Main menu"/g).length, REVEAL_MAX);
});

test("a narrow page's snapshot line names only its folded menus", () => {
  assert.equal(foldedLine(null), "");
  assert.equal(foldedLine({ list: [search] }), "", "a control beside one thing asked for isn't the page's menu");
  assert.equal(foldedLine({ list: [{ role: "button", name: "Theme", ref: "e2", why: "a button in the page's header", tier: 6 }] }), "");
  assert.match(foldedLine({ list: [search, menu] }), /^- This page is laid out for a narrow window: some of it is folded behind button "Main menu" \(ref e8, a collapsed menu\)\./);
});

test("the page scan is self-contained: it names no site and no word list", () => {
  const src = String(revealScan);
  for (const word of ["wikipedia", "github", "\"menu\"", "\"search\"", "/menu", "/search"]) assert.ok(!src.toLowerCase().includes(word), word);
});
