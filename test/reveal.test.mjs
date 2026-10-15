// Compact layouts (scripts/daemon/reveal.mjs): how the controls that unfold a folded search box or
// menu are named to the agent. The page scan itself runs in a browser (narrow.integration.test.mjs).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { revealItem, revealNote, foldedLine, revealScan, scanReveal, pickReveal, REVEAL_MAX } from "../scripts/daemon/reveal.mjs";

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

// ---- the page scan itself, on a small stand-in for a page's DOM ----
// Enough of the DOM for revealScan: elements with attributes, text, visibility ("hidden": not
// displayed, with everything inside), a box's place, and selectors (tags, [attr], [attr=value],
// :not(), lists and descendants). Real pages: narrow.integration.test.mjs.

const splitTop = (s, sep) => {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep)) { if (cur.trim()) out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
function matchCompound(el, c) {
  const m = /^([a-z][a-z0-9]*|\*)?(.*)$/i.exec(c);
  if (m[1] && m[1] !== "*" && el.tag !== m[1].toLowerCase()) return false;
  for (let rest = m[2]; rest;) {
    let x;
    if ((x = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/.exec(rest))) {
      const v = el.getAttribute(x[1]);
      if (v === null || (x[2] !== undefined && v !== x[2])) return false;
    } else if ((x = /^:not\((.*?)\)/.exec(rest))) {
      if (matchList(el, x[1])) return false;
    } else throw new Error(`selector not handled: ${c}`);
    rest = rest.slice(x[0].length);
  }
  return true;
}
function matchComplex(el, parts) {
  if (!matchCompound(el, parts.at(-1))) return false;
  let i = parts.length - 2;
  for (let a = el.parentElement; a && i >= 0; a = a.parentElement) if (matchCompound(a, parts[i])) i--;
  return i < 0;
}
const matchList = (el, sel) => splitTop(sel, ",").some((s) => matchComplex(el, splitTop(s, " ")));

class El {
  constructor(tag, attrs = {}, kids = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.parentElement = null;
    this.childNodes = kids.map((k) => (typeof k === "string" ? { nodeValue: k, parentElement: this } : Object.assign(k, { parentElement: this })));
    this.shadowRoot = null;
    if (attrs.ref) this._ariaRef = { ref: attrs.ref };
  }
  get children() { return this.childNodes.filter((n) => n instanceof El); }
  getAttribute(n) { return Object.hasOwn(this.attrs, n) ? String(this.attrs[n]) : null; }
  hasAttribute(n) { return Object.hasOwn(this.attrs, n); }
  get textContent() { return this.childNodes.map((n) => (n instanceof El ? n.textContent : n.nodeValue)).join(""); }
  get innerText() { return this.displayed ? this.textContent : ""; }
  get value() { return this.attrs.value; }
  get checked() { return "checked" in this.attrs; }
  get open() { return "open" in this.attrs; }
  get href() { return new URL(this.attrs.href, location.href).href; }
  get form() { return ["input", "button", "select", "textarea"].includes(this.tag) ? this.closest("form") : null; }
  get control() { return this.tag === "label" ? document.getElementById(this.attrs.for) : null; }
  get labels() { return this.attrs.id ? document.querySelectorAll(`label[for=${this.attrs.id}]`) : []; }
  get displayed() { for (let x = this; x; x = x.parentElement) if ("hidden" in x.attrs) return false; return true; }
  getRootNode() { return document; }
  getBoundingClientRect() {
    const top = Number(this.attrs["data-top"] ?? 10);
    return this.displayed ? { top, left: 0, right: 100, bottom: top + 20, width: 100, height: 20 } : { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  matches(sel) { return matchList(this, sel); }
  closest(sel) { for (let x = this; x; x = x.parentElement) if (x.matches(sel)) return x; return null; }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelectorAll(sel) { return this.descendants().filter((e) => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const h = (tag, attrs = {}, ...kids) => new El(tag, attrs, kids);

// Makes body the page: document, its window globals.
function page(...kids) {
  const body = h("body", {}, ...kids);
  const html = h("html", {}, body);
  const doc = {
    documentElement: html, body,
    querySelectorAll: (sel) => [html, ...html.descendants()].filter((e) => e.matches(sel)),
    getElementById: (id) => html.descendants().find((e) => e.attrs.id === id) || null,
    createTreeWalker: (root) => {
      const texts = [];
      const walk = (e) => { for (const n of e.childNodes) if (n instanceof El) walk(n); else texts.push(n); };
      walk(root);
      let i = 0;
      return { nextNode: () => texts[i++] || null };
    },
  };
  Object.assign(globalThis, {
    document: doc, innerWidth: 1000, scrollY: 0, NodeFilter: { SHOW_TEXT: 4 },
    location: { origin: "https://site.test", href: "https://site.test/" },
    getComputedStyle: (el) => ({ display: "hidden" in el.attrs ? "none" : el.attrs["data-display"] || "block", visibility: "visible" }),
  });
  return doc;
}
const brief = (scan) => scan.list.map((c) => `${c.tier}:${c.ref}:${c.auto ? "auto" : "named"}`);

test("scan: a control that opens the very part holding it is the one fast mode may open", () => {
  page(
    h("header", {}, h("button", { ref: "t", "aria-controls": "drawer", "aria-expanded": "false" }, "Search")),
    h("div", { id: "drawer", hidden: "" }, h("input", { "aria-label": "Search query" })),
  );
  const scan = revealScan("Search query");
  assert.equal(scan.hidden, true);
  assert.deepEqual(brief(scan), ["1:t:auto"]);
  assert.equal(scan.list[0].why, "opens the part that holds it");
  assert.equal(scan.auto, 0);
  const picked = revealScan("Search query", { pick: true });
  assert.equal(picked.el, document.getElementById("drawer").parentElement.querySelector("button"), "pick hands back that element itself");
});

test("scan: two controls equally likely: both named, neither opened", () => {
  page(
    h("header", {}, h("button", { ref: "a", "aria-controls": "drawer", "aria-expanded": "false" }, "Open"), h("button", { ref: "b", "aria-controls": "drawer", "aria-expanded": "false" }, "Open too")),
    h("div", { id: "drawer", hidden: "" }, h("input", { "aria-label": "Search query" })),
  );
  const scan = revealScan("Search query", { pick: true });
  assert.deepEqual(brief(scan.scan), ["1:a:named", "1:b:named"]);
  assert.equal(scan.scan.auto, -1);
  assert.equal(scan.el, null, "nothing to open");
});

test("scan: a link to another site is never opened for the agent, whatever its ARIA says", () => {
  page(
    h("header", {}, h("a", { ref: "x", href: "https://other.test/menu", "aria-controls": "drawer", "aria-expanded": "false" }, "Search")),
    h("div", { id: "drawer", hidden: "" }, h("input", { "aria-label": "Search query" })),
  );
  assert.deepEqual(brief(revealScan("Search query")), ["1:x:named"]);
});

test("scan: a collapsed toggle beside a folded part is opened; beside a field that is only hidden itself, named", () => {
  page(h("div", {}, h("button", { ref: "f", "aria-expanded": "false" }, "Filters"), h("div", { hidden: "" }, h("input", { "aria-label": "Price" }))));
  const folded = revealScan("Price");
  assert.deepEqual(brief(folded), ["2:f:auto"]);
  assert.equal(folded.list[0].why, "next to it");
  // The field is hidden on its own (a styled control's own input): no compact layout to unfold.
  page(h("div", {}, h("button", { ref: "f", "aria-expanded": "false" }, "Filters"), h("input", { hidden: "", "aria-label": "Price" })));
  assert.deepEqual(brief(revealScan("Price")), ["2:f:named"]);
});

test("scan: a plain button only named like it (it may run anything) is named, never opened", () => {
  page(h("div", {}, h("button", { ref: "s", type: "button" }, "Subscribe to newsletter"), h("div", { hidden: "" }, h("input", { "aria-label": "Newsletter email" }))));
  const scan = revealScan("Newsletter email");
  assert.deepEqual(brief(scan), ["2:s:named"]);
});

test("scan: a same-site link named like it beside a folded part may be opened; another site's never", () => {
  page(h("div", {}, h("a", { ref: "l", href: "/search" }, "Search"), h("div", { hidden: "" }, h("input", { "aria-label": "Search" }))));
  assert.deepEqual(brief(revealScan("Search")), ["2:l:auto"]);
  page(h("div", {}, h("a", { ref: "l", href: "https://other.test/search" }, "Search"), h("div", { hidden: "" }, h("input", { "aria-label": "Search" }))));
  assert.deepEqual(brief(revealScan("Search")), ["2:l:named"]);
});

test("scan: never a form's submit button or checkbox, an open toggle, or a control hidden from people", () => {
  page(
    h("form", {}, h("button", { ref: "submit" }, "Search"), h("input", { type: "checkbox", ref: "agree", "aria-controls": "drawer" }), h("div", { id: "drawer", hidden: "" }, h("input", { "aria-label": "Search" }))),
  );
  assert.deepEqual(revealScan("Search").list, [], "a form's submit sends it; its checkbox is an answer");
  page(
    h("header", {}, h("button", { ref: "o", "aria-controls": "drawer", "aria-expanded": "true" }, "Menu")),
    h("nav", { "aria-hidden": "true" }, h("button", { ref: "ah", "aria-controls": "drawer", "aria-expanded": "false" }, "Menu")),
    h("div", { inert: "" }, h("button", { ref: "in", "aria-controls": "drawer", "aria-expanded": "false" }, "Menu")),
    h("div", { id: "drawer", hidden: "" }, h("input", { "aria-label": "Search" })),
  );
  assert.deepEqual(revealScan("Search").list, [], "already open, aria-hidden and inert controls are skipped");
});

test("scan: the page's one collapsed menu is named (tier 3), never opened; two menus are a choice", () => {
  page(
    h("nav", {}, h("button", { ref: "m", "aria-expanded": "false" }, "Menu")),
    h("main", {}, h("p", {}, "Welcome")),
    h("div", { hidden: "" }, h("input", { "aria-label": "Account settings" })),
  );
  const one = revealScan("Account settings");
  assert.deepEqual(brief(one), ["3:m:named"]);
  assert.match(foldedLine(one), /button "Menu" \(ref m, a collapsed menu\)/);
  page(
    h("nav", {}, h("button", { ref: "m", "aria-expanded": "false" }, "Menu"), h("button", { ref: "p", "aria-haspopup": "true" }, "Profile")),
    h("div", { hidden: "" }, h("input", { "aria-label": "Account settings" })),
  );
  assert.deepEqual(brief(revealScan("Account settings")), ["5:m:named", "5:p:named"]);
  // aria-haspopup="listbox" is a select box, not a menu: at most a button in the header.
  page(h("nav", {}, h("button", { ref: "l", "aria-haspopup": "listbox" }, "Size")), h("div", { hidden: "" }, h("input", { "aria-label": "Account settings" })));
  assert.deepEqual(brief(revealScan("Account settings")), ["6:l:named"]);
});

test("scan: with nothing asked, only the page's folded controls; asked, a header icon button is named last", () => {
  page(
    h("header", {}, h("button", { ref: "i" }, h("svg", {})), h("button", { ref: "m", "aria-expanded": "false" }, "Menu")),
    h("main", {}, h("button", { ref: "buy" }, "Buy")),
    h("footer", {}, h("button", { ref: "ft", "aria-expanded": "false" }, "More")),
  );
  const scan = revealScan("");
  assert.equal(scan.hidden, false);
  assert.deepEqual(brief(scan), ["5:m:named"], "no main-content button, no footer toggle, no plain button");
  // Asked for something not on the page: the header's icon button may hide it too, named last.
  const asked = revealScan("Pricing");
  assert.deepEqual(brief(asked), ["5:m:named", "6:i:named"]);
  assert.equal(asked.list[1].why, "a button in the page's header");
  assert.equal(revealItem(asked.list[1]), "an unnamed button (ref i, a button in the page's header)");
  assert.doesNotMatch(foldedLine(asked), /ref i/, "a header button isn't called a folded menu");
  assert.equal(revealScan("Pricing", { max: 1 }).list.length, 1);
});

test("scan: a hidden link's address goes out without its query string or fragment", () => {
  page(h("nav", { hidden: "" }, h("a", { href: "/pricing?token=s3cret#ignore-previous" }, "Pricing")));
  const scan = revealScan("Pricing");
  assert.equal(scan.hidden, true);
  assert.equal(scan.href, "https://site.test/pricing");
  page(h("nav", { hidden: "" }, h("a", { href: "javascript:alert(1)" }, "Pricing")));
  assert.equal(revealScan("Pricing").href, "", "only http(s) addresses");
});

test("scan: exact asks only for that name; otherwise a field or text holding it", () => {
  page(h("div", { hidden: "" }, h("input", { "aria-label": "Search the docs" })), h("div", {}, h("button", { ref: "t", "aria-expanded": "false" }, "Docs")));
  assert.equal(revealScan("search", { exact: true }).hidden, false);
  assert.equal(revealScan("search").hidden, true);
  page(h("div", { hidden: "" }, h("p", {}, "Opening hours")));
  assert.equal(revealScan("opening hours").hidden, true, "plain text, through the text walk");
  assert.equal(revealScan("closing hours").hidden, false);
});

test("scanReveal and pickReveal: run in the page, bounded, null when it doesn't answer", async () => {
  page(
    h("header", {}, h("button", { ref: "t", "aria-controls": "drawer", "aria-expanded": "false" }, "Search")),
    h("div", { id: "drawer", hidden: "" }, h("input", { "aria-label": "Search query" })),
  );
  const answers = { evaluate: async (fn, arg) => fn(arg) };
  assert.deepEqual(brief(await scanReveal(answers, "Search query")), ["1:t:auto"]);
  assert.equal(await scanReveal({ evaluate: () => new Promise(() => {}) }, "x", { ms: 30 }), null, "a page that never answers");
  assert.equal(await scanReveal({ evaluate: () => { throw new Error("closed"); } }, "x"), null);
  assert.equal(await scanReveal({ evaluate: async () => { throw new Error("detached"); } }, "x"), null);
  // pickReveal: the handle's scan and element; a handle that comes late is disposed of.
  const disposed = [];
  const handleOf = (value) => ({
    getProperty: async (name) => ({ jsonValue: async () => value[name], asElement: () => value[name] || null, dispose: async () => disposed.push(`prop ${name}`) }),
    dispose: async () => disposed.push("handle"),
  });
  const picked = await pickReveal({ evaluateHandle: async (fn, arg) => handleOf(fn(arg)) }, "Search query");
  assert.deepEqual(brief(picked.scan), ["1:t:auto"]);
  assert.equal(picked.el.attrs.ref, "t");
  assert.ok(disposed.includes("handle"));
  disposed.length = 0;
  const none = await pickReveal({ evaluateHandle: async () => handleOf({ scan: { list: [], auto: -1 }, el: null }) }, "x");
  assert.equal(none.el, null);
  assert.ok(disposed.includes("prop el"), "an empty element property is let go");
  disposed.length = 0;
  let late;
  const slow = pickReveal({ evaluateHandle: () => new Promise((r) => (late = r)) }, "x", { ms: 30 });
  assert.equal(await slow, null);
  late(handleOf({ scan: {}, el: null }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(disposed, ["handle"], "the late handle is disposed of");
});
