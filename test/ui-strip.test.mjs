// The browser build's top strip (ui/strip): the tab row from window.pairbrowse, the pill, avatars,
// Share and the menu from the helper's stream, the switcher, the nav fragments and bubbles by
// hash, keyboard paths, drag reorder and motion. The common checks (CSP, names, Tab ring, hidden
// timers, reduced motion) are in test/ui.test.mjs.
import assert from "node:assert/strict";
import { describe } from "node:test";
import { pageTest } from "./helpers/ui-page.mjs";
import { inPage as inFrame } from "./live.mjs";

const ROW = { width: 1536, height: 44 };
const TALL = { width: 1536, height: 480 };
const ACCENT = "rgb(50, 133, 246)";
// A 1x1 PNG, a favicon the page may show under its CSP.
const FAVICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// Three of the picker's sessions (test/ui-picker.test.mjs STATE), a session already open.
const SWITCHER_SESSIONS = { picking: false, sessions: [
  { name: "work", tabs: 3, sites: ["shop.example", "docs.example"], current: true,
    live: [{ who: "Sam", app: "Claude Code", kind: "guest" }],
    people: [{ who: "You", kind: "you", computer: "Mac" }, { who: "Sam", app: "Claude Code", kind: "guest" }] },
  { name: "shop", tabs: 1, sites: ["shop.example"],
    people: [{ who: "You", kind: "you", computer: "Mac" }, { who: "Claude", app: "Claude Code", kind: "agent" }, { who: "Alice", computer: "Linux", kind: "guest" }] },
  { name: "default", tabs: 0, sites: [], people: [] },
] };

// The framed picker once it knows it is framed (and, with s, once body[data-s] is s).
async function framedPicker(page, s = null) {
  for (let i = 0; i < 100; i++) {
    const frame = page.frames().find((f) => f.url().includes("/picker/index.html"));
    if (frame) {
      const st = await inFrame(frame, () => ({ host: document.documentElement.dataset.host, s: document.body?.dataset.s })).catch(() => null);
      if (st?.host === "frame" && (!s || st.s === s)) return frame;
    }
    await page.waitForTimeout(50);
  }
  return assert.fail("the framed picker did not load");
}

// In the page: a tab's box and state by id.
const tabInfo = (id) => {
  const li = document.querySelector(`#tabs li[data-id="${id}"]`);
  if (!li) return null;
  const r = li.getBoundingClientRect();
  const s = getComputedStyle(li);
  const close = li.querySelector(".close");
  const cs = getComputedStyle(close);
  return {
    left: r.left, right: r.right, width: r.width, height: r.height, selected: li.getAttribute("aria-selected"), tabindex: li.getAttribute("tabindex"),
    label: li.getAttribute("aria-label"), bg: s.backgroundColor, image: s.backgroundImage, color: s.color, rtl: s.borderTopLeftRadius, rtr: s.borderTopRightRadius,
    top: r.top, bottom: r.bottom, borderTop: s.borderTopWidth,
    closeShown: cs.display !== "none", closeTabindex: close.getAttribute("tabindex"), closeLeft: close.getBoundingClientRect().left,
  };
};
const order = () => [...document.querySelectorAll("#tabs li")].map((li) => Number(li.dataset.id));
const callsOf = async (shim, iface, method) => (await shim.calls()).filter((c) => c.iface === iface && c.method === method).map((c) => c.args);
// From the page's own layout (a locator's boundingBox leaves an observer of Patchright's in the page).
const center = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, box: { x: r.left, y: r.top, width: r.width, height: r.height } }; }, sel);
const focusBody = () => { document.activeElement?.blur?.(); document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex"); };
const active = () => { const a = document.activeElement; return a ? (a.id || (a.dataset.id ? `tab:${a.dataset.id}` : a.className || a.tagName)) : null; };

describe("renders the tab list, its states and the drag region", () => pageTest("strip", { viewport: ROW }, async ({ page, inPage }) => {
  // renders the tab list
  assert.deepEqual(await inPage(order), [11, 12, 13]);
  const [a, b, c] = [await inPage(tabInfo, 11), await inPage(tabInfo, 12), await inPage(tabInfo, 13)];
  for (const t of [a, b, c]) {
    assert.equal(t.height, 40, "40 px tall");
    assert.equal(t.bottom, 44, "on the row's bottom edge");
    assert.ok(t.width >= 160 && t.width <= 240, `width ${t.width}`);
  }
  assert.equal(Math.round(b.left - a.right), 8);
  assert.equal(Math.round(c.left - b.right), 8);
  assert.equal(a.selected, "true");
  assert.equal(a.tabindex, "0");
  assert.equal(a.bg, "rgb(16, 29, 45)");
  assert.match(a.image, /linear-gradient/, "the active tab's light");
  assert.equal(a.rtl, "10px");
  assert.equal(a.rtr, "10px");
  for (const t of [b, c]) {
    assert.equal(t.tabindex, "-1"); assert.equal(t.color, "rgb(162, 178, 198)"); assert.equal(t.selected, "false");
    assert.equal(t.bg, "rgb(14, 24, 38)", "an inactive tab's own surface (--tab-idle)");
    assert.equal(t.rtl, "10px"); assert.equal(t.rtr, "10px");
    assert.equal(t.borderTop, "1px");
  }
  await page.hover('#tabs li[data-id="12"]');
  await page.waitForTimeout(250);
  const hovered = (await inPage(tabInfo, 12)).bg;
  assert.equal(hovered, "rgb(25, 42, 61)", "hover is --elevated");
  assert.notEqual(hovered, "rgb(36, 55, 80)");
  // the active tab's feet: 9 px curves at -9px, the ring at 8px, carrying its edge into the row's
  // bottom line: they cover the border column and end at the neighbour's edge
  const feet = await inPage(() => {
    const li = document.querySelector('#tabs li[aria-selected="true"]');
    return ["::before", "::after"].map((p) => { const s = getComputedStyle(li, p); return { w: s.width, h: s.height, left: s.left, right: s.right, image: s.backgroundImage }; });
  });
  for (const f of feet) { assert.equal(f.w, "9px"); assert.equal(f.h, "9px"); assert.match(f.image, /radial-gradient/); assert.match(f.image, /7\.5px/); assert.match(f.image, / 8px/); assert.match(f.image, / 9px/); }
  assert.equal(feet[0].left, "-9px");
  assert.equal(feet[1].right, "-9px");
  // the new tab "+" sits 8 px after the last tab, not at the far right
  const plus = await inPage(() => { const last = [...document.querySelectorAll("#tabs li")].at(-1).getBoundingClientRect(); return Math.round(document.getElementById("new").getBoundingClientRect().left - last.right); });
  assert.equal(plus, 8, "the + right after the last tab");
  // the drag region
  const regions = await inPage(() => {
    const r = (el) => getComputedStyle(el).getPropertyValue("-webkit-app-region");
    return { row: r(document.getElementById("row")), noDrag: [...document.querySelectorAll("#row button, #tabs li, .pop")].map((el) => [el.id || el.dataset.id || el.className, r(el)]).filter(([, v]) => v !== "no-drag") };
  });
  assert.equal(regions.row, "drag");
  assert.deepEqual(regions.noDrag, []);
  // no DOM observers
  assert.equal((await inPage(() => window.__harness.live())).observers, 0);
}));

describe("agent dot, loading ring, close buttons and the pinned tab", () => pageTest("strip", { viewport: ROW }, async ({ shim, inPage, until }) => {
  // agent dot and tooltip
  const dot = (id) => {
    const d = document.querySelector(`#tabs li[data-id="${id}"] .agent`);
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const close = d.parentElement.querySelector(".close").getBoundingClientRect();
    const title = d.parentElement.querySelector(".title");
    const range = document.createRange();
    range.selectNodeContents(title);
    const text = range.getBoundingClientRect();
    const li = d.parentElement.getBoundingClientRect();
    return { w: r.width, h: r.height, bg: getComputedStyle(d).backgroundColor, title: d.title, afterTitle: Math.round(r.left - Math.min(text.right, title.getBoundingClientRect().right)),
      closeEnd: Math.round(li.right - close.right), padRight: Math.round(parseFloat(getComputedStyle(d.parentElement).paddingRight) + parseFloat(getComputedStyle(d.parentElement).borderRightWidth)) };
  };
  const d11 = await inPage(dot, 11);
  const { closeEnd, padRight, ...d11rest } = d11;
  assert.deepEqual(d11rest, { w: 7, h: 7, bg: "rgb(233, 118, 63)", title: "Claude is in this tab", afterTitle: 6 }, "the owner dot 6 px after the title");
  assert.equal(closeEnd, padRight, "the close at the tab's right end");
  assert.match((await inPage(tabInfo, 11)).label, /Claude is in this tab/);
  await shim.setOwner(12, "Codex", "#7088f0");
  await until("tab 12's dot", (id) => !!document.querySelector(`#tabs li[data-id="${id}"] .agent`), 12);
  assert.equal((await inPage(dot, 12)).bg, "rgb(112, 136, 240)");
  assert.match((await inPage(tabInfo, 12)).label, /Codex is in this tab/);
  await shim.clearOwner(12);
  await until("tab 12's dot gone", (id) => !document.querySelector(`#tabs li[data-id="${id}"] .agent`), 12);

  // loading ring
  await shim.change({ id: 12, networkState: 2 });
  await until("the ring", () => !!document.querySelector('#tabs li[data-id="12"] .ring'));
  const ring = await inPage(() => {
    const r = document.querySelector('#tabs li[data-id="12"] .ring');
    const s = getComputedStyle(r);
    return { w: r.getBoundingClientRect().width, h: r.getBoundingClientRect().height, color: s.borderLeftColor, anims: r.getAnimations().length };
  });
  assert.deepEqual(ring, { w: 12, h: 12, color: ACCENT, anims: 0 });
  assert.match((await inPage(tabInfo, 12)).label, /, loading$/);
  await shim.change({ id: 12, networkState: 0 });
  await until("the icon back", () => !document.querySelector('#tabs li[data-id="12"] .ring') && !!document.querySelector('#tabs li[data-id="12"] .icon svg'));
  assert.doesNotMatch((await inPage(tabInfo, 12)).label, /loading/);

  // close buttons and the pinned tab
  const a = await inPage(tabInfo, 11), b = await inPage(tabInfo, 12);
  assert.equal(a.closeShown, true);
  assert.equal(a.closeTabindex, "0");
  assert.equal(b.closeShown, true, "the close shows on every unpinned tab");
  assert.equal(b.closeTabindex, "-1", "Tab still reaches only the active tab's close");
  await shim.change({ id: 13, pinned: true });
  await until("tab 13 pinned", () => document.querySelector('#tabs li[data-id="13"]').classList.contains("pinned"));
  const p = await inPage(tabInfo, 13);
  assert.equal(p.width, 40);
  assert.equal(p.closeShown, false);
  assert.match(p.label, /, pinned$/);
  assert.equal(await inPage(() => getComputedStyle(document.querySelector('#tabs li[data-id="13"] .title')).display), "none");

  // the icon tile: a favicon on a white 22 px tile, the globe on --elevated
  await shim.change({ id: 12, favicon: FAVICON, defaultFavicon: false });
  await until("tab 12's favicon", () => !!document.querySelector('#tabs li[data-id="12"] .icon img'));
  const tile = (id) => {
    const icon = document.querySelector(`#tabs li[data-id="${id}"] .icon`);
    const r = icon.getBoundingClientRect(), img = icon.querySelector("img");
    return { w: r.width, h: r.height, bg: getComputedStyle(icon).backgroundColor, radius: getComputedStyle(icon).borderTopLeftRadius, img: img ? [img.getBoundingClientRect().width, img.getBoundingClientRect().height] : null };
  };
  assert.deepEqual(await inPage(tile, 12), { w: 22, h: 22, bg: "rgb(255, 255, 255)", radius: "6px", img: [16, 16] });
  const generic = await inPage(tile, 11);
  assert.equal(generic.bg, "rgb(25, 42, 61)", "the globe sits on --elevated");
  assert.equal(generic.img, null);
}));

describe("owned tabs glow in the owner's color, undriven tabs stay neutral", () => pageTest("strip", { viewport: ROW }, async ({ shim, inPage, until }) => {
  const edges = (id) => {
    const li = document.querySelector(`#tabs li[data-id="${id}"]`);
    const s = getComputedStyle(li);
    return { owned: li.dataset.owned || "", owner: li.style.getPropertyValue("--owner"), top: s.borderTopColor, shadow: s.boxShadow };
  };
  // A probe of the same color expression, resolved by the page's own engine.
  const probe = (expr) => { const p = document.createElement("i"); p.style.color = expr; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
  const ACCENTS = /50, 133, 246|106, 166, 249/;
  // the active tab, Claude's: the full owner color on top, a halo carrying it
  const a = await inPage(edges, 11);
  assert.deepEqual([a.owned, a.owner], ["true", "#e9763f"]);
  assert.equal(a.top, "rgb(233, 118, 63)");
  const halo = await inPage(probe, "color-mix(in srgb, #e9763f 50%, transparent)");
  assert.ok(a.shadow.includes(halo), `the halo carries the owner color: ${a.shadow}`);
  assert.doesNotMatch(a.top + a.shadow, ACCENTS);
  // an inactive owned tab: the top edge at 60%, a weaker halo
  await shim.setOwner(12, "Codex", "#7088f0");
  await until("tab 12 owned", () => document.querySelector('#tabs li[data-id="12"]').dataset.owned === "true");
  const b = await inPage(edges, 12);
  assert.equal(b.owner, "#7088f0");
  assert.equal(b.top, await inPage(probe, "color-mix(in srgb, #7088f0 60%, transparent)"));
  const weak = await inPage(probe, "color-mix(in srgb, #7088f0 30%, transparent)");
  assert.ok(b.shadow.includes(weak), `a weaker halo in the owner color: ${b.shadow}`);
  // an undriven tab: no owner, neutral edges, no accent channels
  const c = await inPage(edges, 13);
  assert.deepEqual([c.owned, c.owner], ["", ""]);
  assert.doesNotMatch(c.top + c.shadow, ACCENTS);
  // the active tab undriven: the neutral lit top edge and halo
  await shim.clearOwner(11);
  await until("tab 11 undriven", () => !document.querySelector('#tabs li[data-id="11"]').dataset.owned);
  const d = await inPage(edges, 11);
  assert.equal(d.owner, "");
  assert.equal(d.top, await inPage(probe, "rgb(255 255 255 / 0.24)"));
  assert.doesNotMatch(d.top + d.shadow, ACCENTS);
  // a color that is not a plain #rrggbb never reaches --owner
  await shim.setOwner(13, "Odd", "red");
  await until("tab 13's dot", () => !!document.querySelector('#tabs li[data-id="13"] .agent'));
  assert.deepEqual(await inPage(edges, 13).then((e) => [e.owned, e.owner]), ["", ""]);
}));

describe("close and new tab", () => pageTest("strip", { viewport: ROW }, async ({ page, shim, inPage, until }) => {
  // close and new tab
  await page.click('#tabs li[data-id="11"] .close');
  await until("two tabs", () => document.querySelectorAll("#tabs li").length === 2);
  assert.deepEqual(await callsOf(shim, "tabs", "close"), [[11]]);
  await until("tab 12 active", () => document.querySelector('#tabs li[data-id="12"]').getAttribute("aria-selected") === "true");
  await page.click("#new");
  await until("a new tab", () => document.querySelectorAll("#tabs li").length === 3);
  assert.deepEqual(await callsOf(shim, "tabs", "create"), [["", true, 1]]);
  // a middle click closes
  const at = await center(page, '#tabs li[data-id="13"]');
  await page.mouse.click(at.x, at.y, { button: "middle" });
  await until("tab 13 closed", () => !document.querySelector('#tabs li[data-id="13"]'));
  assert.deepEqual(await callsOf(shim, "tabs", "close"), [[11], [13]]);
  // clicking a tab activates it
  const first = await inPage(() => Number(document.querySelector("#tabs li:not([aria-selected=true])").dataset.id));
  await page.click(`#tabs li[data-id="${first}"] .title`);
  await until("activated", (id) => document.querySelector(`#tabs li[data-id="${id}"]`).getAttribute("aria-selected") === "true", first);
}));

describe("reorder by drag and by keyboard", () => pageTest("strip", { viewport: ROW }, async ({ page, shim, inPage, until, harness }) => {
  // reorder by drag calls tabs.move
  const zero = (l) => l.timeouts + l.intervals + l.frames + l.observers;
  assert.equal(zero(await harness.live()), 0);
  const from = await center(page, '#tabs li[data-id="12"]');
  const onto = await center(page, '#tabs li[data-id="11"]');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 5, from.y);
  await page.mouse.move(onto.box.x + 20, from.y, { steps: 6 });
  const during = await inPage(() => {
    const li = (id) => document.querySelector(`#tabs li[data-id="${id}"]`);
    return { t11: li(11).style.transform, t13: li(13).style.transform, w12: li(12).getBoundingClientRect().width, dur: getComputedStyle(li(11)).transitionDuration, prop: getComputedStyle(li(11)).transitionProperty, dragging: document.body.dataset.dragging, live: window.__harness.live() };
  });
  assert.equal(during.t11, `translateX(${during.w12 + 8}px)`);
  assert.equal(during.t13, "");
  assert.equal(during.dragging, "true");
  const i = during.prop.split(", ").indexOf("transform");
  assert.ok(i >= 0, during.prop);
  assert.equal(during.dur.split(", ")[i], "0.16s");
  assert.equal(zero(during.live), 0, JSON.stringify(during.live));
  await page.mouse.up();
  await until("the new order", () => [...document.querySelectorAll("#tabs li")].map((li) => li.dataset.id).join() === "12,11,13");
  await page.waitForTimeout(100);
  assert.deepEqual(await callsOf(shim, "tabs", "move"), [[12, 0, -1]]);
  assert.deepEqual(await inPage(order), [12, 11, 13]);
  assert.deepEqual(await callsOf(shim, "tabs", "activate"), [], "a drag is not a click");
  assert.equal(await inPage(() => document.querySelector("#tabs li").style.transform), "");
  assert.equal(zero(await harness.live()), 0);

  // reorder by keyboard: Ctrl+Shift+Arrow
  await page.focus('#tabs li[data-id="11"]');
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await until("11 first again", () => document.querySelector("#tabs li").dataset.id === "11");
  assert.deepEqual((await callsOf(shim, "tabs", "move")).at(-1), [11, 0, -1]);
  assert.equal(await inPage(active), "tab:11", "focus stays on the moved tab");
}));

describe("keyboard paths", () => pageTest("strip", { viewport: ROW }, async ({ page, shim, inPage, until }) => {
  // keyboard paths: the Tab order, each with the 2 px --accent ring
  await inPage(focusBody);
  const seen = [];
  // In the 44 px row the menu is not shown (it has nowhere to open): Share ends the order. In a
  // taller host the menu button follows Share (the menu test).
  assert.equal(await inPage(() => document.getElementById("menu-btn").checkVisibility()), false);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    seen.push(await inPage(() => {
      const a = document.activeElement;
      const s = getComputedStyle(a);
      return { id: a.id || (a.dataset.id ? `tab:${a.dataset.id}` : a.classList.contains("close") ? `close:${a.closest("li").dataset.id}` : a.tagName), ring: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` };
    }));
  }
  assert.deepEqual(seen.map((s) => s.id), ["switch", "tab:11", "close:11", "new", "share-btn"]);
  for (const s of seen) assert.equal(s.ring, `solid 2px ${ACCENT}`, s.id);
  // arrows move focus, not the selection
  await page.focus('#tabs li[data-id="11"]');
  await page.keyboard.press("ArrowRight");
  assert.equal(await inPage(active), "tab:12");
  assert.equal((await inPage(tabInfo, 12)).tabindex, "0");
  assert.equal((await inPage(tabInfo, 11)).tabindex, "-1");
  assert.equal((await inPage(tabInfo, 11)).selected, "true");
  await page.keyboard.press("End");
  assert.equal(await inPage(active), "tab:13");
  await page.keyboard.press("Home");
  assert.equal(await inPage(active), "tab:11");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await inPage(active), "tab:13");
  assert.deepEqual(await callsOf(shim, "tabs", "activate"), []);
  // Enter and Space activate
  await page.keyboard.press("Enter");
  await until("13 active", () => document.querySelector('#tabs li[data-id="13"]').getAttribute("aria-selected") === "true");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press(" ");
  assert.deepEqual(await callsOf(shim, "tabs", "activate"), [[13], [12]]);
  // Delete and Backspace close the focused tab
  await page.focus('#tabs li[data-id="11"]');
  await page.keyboard.press("Delete");
  await until("11 gone", () => !document.querySelector('#tabs li[data-id="11"]'));
  assert.ok((await inPage(active)).startsWith("tab:"), "focus stays in the tab row");
  await page.focus('#tabs li[data-id="13"]');
  await page.keyboard.press("Backspace");
  await until("13 gone", () => !document.querySelector('#tabs li[data-id="13"]'));
  assert.deepEqual(await callsOf(shim, "tabs", "close"), [[11], [13]]);
}));

describe("the pill: Local, Live session, Reconnecting", () => pageTest("strip", { viewport: ROW }, async ({ helper, inPage, until }) => {
  // the pill: Local, Live session, Reconnecting
  const pill = () => { const p = document.getElementById("pill"); return { state: p.dataset.state, text: document.getElementById("pill-text").textContent, dot: getComputedStyle(p.querySelector(".dot")).backgroundColor, role: p.getAttribute("role"), live: p.getAttribute("aria-live"), anims: document.getAnimations().filter((a) => a.playState === "running" && a.animationName === "pulse").map((a) => [a.effect.target.className, a.effect.getTiming().duration]) }; };
  let p = await inPage(pill);
  assert.deepEqual(p, { state: "local", text: "Local", dot: "rgb(134, 153, 177)", role: "status", live: "polite", anims: [] });
  // the strip's stream is a panel stream: never a viewer, so the helper starts no screencast for it
  assert.deepEqual([...helper.streams].map((s) => [s.kind, s.panel]), [["strip", true]]);
  helper.set("collaboration", { guests: [{ label: "Ana", role: "drive" }] });
  await until("live", () => document.getElementById("pill").dataset.state === "live");
  p = await inPage(pill);
  assert.equal(p.text, "Live session");
  assert.equal(p.dot, "rgb(32, 201, 151)");
  assert.deepEqual(p.anims, [["dot live", 2000]]);
  // the live pill's static light: a green-tinted edge and a soft halo on the dot
  const lit = await inPage(() => {
    const probe = document.createElement("i");
    probe.style.borderColor = "var(--ok-edge)";
    document.body.append(probe);
    const want = getComputedStyle(probe).borderTopColor;
    probe.remove();
    const pill = document.getElementById("pill");
    return { border: getComputedStyle(pill).borderTopColor, want, dotShadow: getComputedStyle(pill.querySelector(".dot")).boxShadow };
  });
  assert.equal(lit.border, lit.want, "the pill's border is --ok-edge");
  assert.match(lit.dotShadow, /rgba?\(32, 201, 151/);
  for (const s of helper.streams) s.res.destroy();
  await until("reconnecting", () => document.getElementById("pill-text").textContent === "Reconnecting to PairBrowse");
  p = await inPage(pill);
  assert.equal(p.state, "reconnecting");
  assert.equal(p.dot, "rgb(244, 180, 93)");
}));

// No helper to ask (no browser API, no extension storage): the resting state, not an error.
// "Local" with the muted dot, as when not sharing; no --warn, and the title says why.
describe("the pill with no helper: Local, muted", () => pageTest("strip", { viewport: ROW, native: false, bridge: false }, async ({ inPage, until, errors }) => {
  await until("closed", () => document.body.dataset.s === "closed");
  const p = await inPage(() => {
    const probe = (v) => { const i = document.createElement("i"); i.style.color = `var(--${v})`; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; };
    const pill = document.getElementById("pill");
    return { state: pill.dataset.state, text: document.getElementById("pill-text").textContent, title: pill.title, dot: getComputedStyle(pill.querySelector(".dot")).backgroundColor, muted: probe("muted"), warn: probe("warn") };
  });
  assert.deepEqual({ state: p.state, text: p.text, title: p.title }, { state: "local", text: "Local", title: "No agent connected" });
  assert.equal(p.dot, p.muted, "the muted dot");
  assert.notEqual(p.dot, p.warn, "no --warn");
  assert.equal(await inPage(() => document.body.textContent.includes("Not connected")), false);
  assert.deepEqual(errors, []);
}));

describe("avatar stack with +N", () => pageTest("strip", {
  viewport: ROW,
  fixtures: {
    board: { people: [{ who: "Claude", color: "#e9763f" }, { who: "Codex", color: "#7088f0" }, { who: "Ben", color: "#4ade80" }, { who: "Dana" }, { who: "Eli", color: "#4fd1e8" }, { who: "Fay" }] },
    collaboration: { guests: [{ label: "Ana", role: "drive" }] },
  },
}, async ({ inPage, until }) => {
  // the avatar stack with +N
  await until("avatars", () => document.querySelectorAll("#avatars li").length === 5);
  const av = await inPage(() => [...document.querySelectorAll("#avatars .avatar")].map((a) => {
    const r = a.getBoundingClientRect();
    const s = getComputedStyle(a);
    return { text: a.textContent, left: r.left, w: r.width, h: r.height, weight: s.fontWeight, shadow: s.boxShadow, bg: s.backgroundColor, plain: a.classList.contains("plain"), role: a.getAttribute("role"), label: a.getAttribute("aria-label") };
  }));
  assert.deepEqual(av.slice(0, 4).map((a) => a.text), ["C", "C", "B", "D"]);
  for (const a of av.slice(0, 4)) {
    assert.equal(a.w, 28);
    assert.equal(a.h, 28);
    assert.equal(a.weight, "700");
    assert.match(a.shadow, /rgb\(11, 20, 33\) 0px 0px 0px 1\.5px/);
  }
  for (let i = 1; i < 5; i++) assert.equal(Math.round(av[i - 1].left + 28 - av[i].left), 8);
  assert.equal(av[0].bg, "rgb(233, 118, 63)");
  assert.equal(av[3].plain, true);
  assert.equal(av[3].bg, "rgb(25, 42, 61)");
  assert.deepEqual([av[4].text, av[4].role, av[4].label], ["+3", "img", "3 more"]);
}));

describe("share card opens and posts an invite", () => pageTest("strip", { viewport: TALL, replies: { invite: { ok: true, code: "pb-join:FAKE", rights: "Shared browser: they can drive." } } }, async ({ page, helper, inPage, until }) => {
  // the share card opens and posts an invite
  await page.click("#share-btn");
  const card = await inPage(() => {
    const c = document.getElementById("share-card");
    const r = c.getBoundingClientRect();
    return { hidden: c.hidden, role: c.getAttribute("role"), expanded: document.getElementById("share-btn").getAttribute("aria-expanded"), w: r.width, top: r.top, right: innerWidth - r.right, focus: document.activeElement.value };
  });
  assert.deepEqual(card, { hidden: false, role: "dialog", expanded: "true", w: 320, top: 44, right: 12, focus: "code" });
  await page.click("#share-make");
  await until("the code", () => document.getElementById("share-code").value === "pb-join:FAKE");
  assert.deepEqual(helper.posts.filter((p) => p.route === "invite").map((p) => p.body), [{ share: "code" }]);
  assert.equal(await inPage(() => document.getElementById("share-rights").textContent), "Shared browser: they can drive.");
  await page.keyboard.press("Escape");
  assert.deepEqual(await inPage(() => ({ hidden: document.getElementById("share-card").hidden, code: document.getElementById("share-code").value, focus: document.activeElement.id })), { hidden: true, code: "", focus: "share-btn" });
  // Tab out of the card closes it
  await page.click("#share-btn");
  await page.focus("#share-make");
  await page.keyboard.press("Tab");
  assert.equal(await inPage(() => document.getElementById("share-card").hidden), true);
}));

describe("menu: Record, Settings, Zoom, keyboard", () => pageTest("strip", { viewport: TALL, replies: { record: {} } }, async ({ page, helper, shim, inPage, until }) => {
  // the menu: Record, Settings, Zoom, keyboard
  assert.equal(await inPage(() => document.getElementById("menu-btn").getAttribute("aria-haspopup")), "menu");
  await page.click("#menu-btn");
  const m = await inPage(() => ({
    role: document.getElementById("menu").getAttribute("role"), hidden: document.getElementById("menu").hidden,
    items: [...document.querySelectorAll('#menu [role="menuitem"]')].map((b) => [b.querySelector("span").textContent, b.disabled]),
    key: document.getElementById("new-window-key").textContent, focus: document.activeElement.id,
  }));
  assert.equal(m.role, "menu");
  assert.equal(m.hidden, false);
  assert.deepEqual(m.items, [["New window", true], ["Zoom", false], ["Record", false], ["Settings", false], ["About PairBrowse", false]]);
  assert.match(m.key, /^(⌘N|Ctrl\+N)$/);
  assert.equal(m.focus, "zoom");
  for (const [key, want] of [["ArrowDown", "record"], ["ArrowDown", "settings"], ["ArrowUp", "record"], ["End", "about"], ["ArrowDown", "zoom"], ["Home", "zoom"], ["ArrowUp", "about"]]) {
    await page.keyboard.press(key);
    assert.equal(await inPage(() => document.activeElement.id), want, key);
  }
  await page.keyboard.press("Escape");
  assert.deepEqual(await inPage(() => [document.getElementById("menu").hidden, document.activeElement.id, document.getElementById("menu-btn").getAttribute("aria-expanded")]), [true, "menu-btn", "false"]);
  await page.click("#menu-btn");
  await page.click("#record");
  for (let i = 0; i < 40 && !helper.posts.some((p) => p.route === "record"); i++) await page.waitForTimeout(50);
  assert.deepEqual(helper.posts.filter((p) => p.route === "record").map((p) => p.body), [{ on: true }]);
  helper.push("record", { recording: true, since: Date.now() });
  await until("Stop recording", () => document.getElementById("record-text").textContent === "Stop recording");
  // Op notices carry no `recording`: a saved or removed recording leaves the indicator on.
  helper.push("record", { op: "saved", item: { id: "r1", name: "Recording 1" } });
  helper.push("record", { op: "removed", id: "r0" });
  await page.waitForTimeout(150);
  assert.equal(await inPage(() => document.getElementById("record-text").textContent), "Stop recording", "a saved notice keeps REC on");
  helper.push("record", { recording: false });
  await until("Record again", () => document.getElementById("record-text").textContent === "Record");
  await page.click("#menu-btn");
  await page.click("#settings");
  await page.click("#menu-btn");
  await page.click("#zoom");
  await page.waitForTimeout(100);
  assert.deepEqual(await callsOf(shim, "tabs", "create"), [["pairbrowse://settings", true, 1]]);
  assert.deepEqual(await callsOf(shim, "windows", "zoom"), [[1]]);
  assert.equal(await inPage(() => document.getElementById("menu").hidden), true);
}));

describe("switcher opens the picker in an iframe", () => pageTest("strip", { viewport: TALL }, async ({ page, inPage, harness }) => {
  // the switcher opens the picker in an iframe
  assert.equal(await inPage(() => document.getElementById("picker").getAttribute("src")), null);
  await page.click("#switch");
  const s = await inPage(() => {
    const d = document.getElementById("switcher");
    const f = document.getElementById("picker");
    return { hidden: d.hidden, role: d.getAttribute("role"), label: d.getAttribute("aria-label"), w: d.getBoundingClientRect().width, src: f.src, title: f.title, expanded: document.getElementById("switch").getAttribute("aria-expanded") };
  });
  assert.equal(s.hidden, false);
  assert.equal(s.role, "dialog");
  assert.equal(s.label, "Switch session");
  assert.equal(s.w, 360);
  assert.ok(s.src.endsWith("/picker/index.html"), s.src);
  assert.equal(s.title, "Session picker");
  assert.equal(s.expanded, "true");
  // The picker loads in the frame (same origin, frame-src 'self') and knows it is framed.
  const frame = await framedPicker(page);
  assert.equal(await inFrame(frame, () => window.innerWidth), 360);
  await page.focus("#switch");
  await page.keyboard.press("Escape");
  assert.deepEqual(await inPage(() => [document.getElementById("switcher").hidden, document.getElementById("picker").getAttribute("src"), document.activeElement.id]), [true, null, "switch"]);
  assert.equal(page.frames().some((f) => f.url().includes("/picker/index.html")), false, "the picker unloaded");
  assert.deepEqual(await harness.log(), []);
}));

describe("the picker's notices close the switcher; the bubble keeps it", () => pageTest("strip", { viewport: TALL, fixtures: { sessions: SWITCHER_SESSIONS } }, async (ctx) => {
  const { page, inPage, until, harness } = ctx;
  const state = () => ({ hidden: document.getElementById("switcher").hidden, src: document.getElementById("picker").getAttribute("src"), focus: document.activeElement?.id || "" });
  // (a) Escape in the framed picker: its "close" notice closes the switcher, focus on the chevron.
  await page.click("#switch");
  await framedPicker(page, "ready");
  await page.keyboard.press("Escape");
  await until("closed by the notice", () => document.getElementById("switcher").hidden);
  assert.deepEqual(await inPage(state), { hidden: true, src: null, focus: "switch" });
  // (b) A notice that is not from the frame (the strip itself posts it) does nothing.
  await page.click("#switch");
  await framedPicker(page, "ready");
  await inPage(() => window.postMessage({ source: "pairbrowse-picker", op: "close" }, location.origin));
  await page.waitForTimeout(100);
  assert.equal((await inPage(state)).hidden, false, "a notice not from the frame does nothing");
  // (c) In the #switcher bubble the host owns dismissal: Escape in the picker leaves it open.
  await inPage(() => { location.hash = "#switcher"; });
  await until("the bubble", () => document.body.dataset.mode === "switcher");
  const frame = await framedPicker(page, "ready");
  await frame.click("h1");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  assert.equal((await inPage(state)).hidden, false, "the host owns dismissal");
  // (d) Leaving the mode unloads the picker.
  await inPage(() => { location.hash = ""; });
  await until("the row", () => document.body.dataset.mode === "row");
  assert.equal((await inPage(state)).src, null);
  // (e)
  assert.deepEqual(await harness.log(), []);
  assert.deepEqual(ctx.errors, []);
}));

describe("the hash modes", () => pageTest("strip", { viewport: TALL }, async ({ page, shim, inPage, until }) => {
  // the hash modes, never a reload
  await inPage(() => { window.__sameDocument = true; });
  const shown = () => ({
    row: document.getElementById("row").checkVisibility(), left: document.getElementById("nav-left").checkVisibility(), right: document.getElementById("nav-right").checkVisibility(),
    tabs: document.getElementById("tabs").checkVisibility(), share: document.getElementById("share-card").checkVisibility(), switcher: document.getElementById("switcher").checkVisibility(), menu: document.getElementById("menu").checkVisibility(),
    mode: document.body.dataset.mode, same: window.__sameDocument === true,
  });
  const go = (h) => inPage((x) => { location.hash = x; }, h);
  await go("#nav-left");
  await until("nav-left", () => document.body.dataset.mode === "nav-left");
  assert.deepEqual(await inPage(shown), { row: false, left: true, right: false, tabs: false, share: false, switcher: false, menu: false, mode: "nav-left", same: true });
  const nav = await inPage(() => ["back", "forward", "reload"].map((id) => { const b = document.getElementById(id); return [id, b.disabled, getComputedStyle(b).color]; }));
  assert.deepEqual(nav, [["back", true, "rgb(134, 153, 177)"], ["forward", true, "rgb(134, 153, 177)"], ["reload", false, "rgb(162, 178, 198)"]]);
  await page.click("#reload");
  await page.waitForTimeout(50);
  assert.deepEqual(await callsOf(shim, "tabs", "reload"), [[11]]);
  // Back and forward follow the active tab's history as the browser reports it.
  await shim.change({ id: 11, canGoBack: true });
  await until("back on", () => !document.getElementById("back").disabled);
  assert.equal(await inPage(() => document.getElementById("forward").disabled), true);
  await page.click("#back");
  await page.waitForTimeout(50);
  assert.deepEqual(await callsOf(shim, "tabs", "goBack"), [[11]]);
  await shim.change({ id: 11, canGoBack: false, canGoForward: true });
  await until("forward on, back off", () => !document.getElementById("forward").disabled && document.getElementById("back").disabled);
  await page.click("#forward");
  await page.waitForTimeout(50);
  assert.deepEqual(await callsOf(shim, "tabs", "goForward"), [[11]]);

  await go("#nav-right");
  await until("nav-right", () => document.body.dataset.mode === "nav-right");
  const right = await inPage(() => ({ star: document.getElementById("star").disabled, find: document.getElementById("find").disabled, pressed: document.getElementById("sparkle").getAttribute("aria-pressed"), names: ["star", "find"].map((id) => document.getElementById(id).getAttribute("aria-label")) }));
  assert.equal(right.star, true);
  assert.equal(right.find, false, "find is the window's find bar");
  await page.click("#find");
  await page.waitForTimeout(50);
  assert.deepEqual(await callsOf(shim, "windows", "find"), [[1]]);
  assert.equal(right.pressed, "true");
  assert.match(right.names[0], /^Bookmark this page \((⌘D|Ctrl\+D)\)$/);
  assert.match(right.names[1], /^Find in page \((⌘F|Ctrl\+F)\)$/);
  await page.click("#sparkle");
  await until("sparkle off", () => document.getElementById("sparkle").getAttribute("aria-pressed") === "false");
  assert.equal((await callsOf(shim, "layout", "set")).at(-1)[0].right, 0);
  await shim.layout({ right: 2 });
  await until("sparkle on", () => document.getElementById("sparkle").getAttribute("aria-pressed") === "true");

  for (const [hash, key] of [["#share", "share"], ["#switcher", "switcher"], ["#menu", "menu"]]) {
    await go(hash);
    await until(hash, (m) => document.body.dataset.mode === m, key);
    const s = await inPage(shown);
    assert.equal(s[key], true, `${hash} shows its popover`);
    for (const other of ["left", "right", "tabs", "share", "switcher", "menu"]) if (other !== key) assert.equal(s[other], false, `${hash} hides ${other}`);
    // the bubble host owns dismissal
    await page.keyboard.press("Escape");
    assert.equal((await inPage(shown))[key], true, `${hash} stays open on Escape`);
  }
  await go("");
  await until("row", () => document.body.dataset.mode === "row");
  assert.deepEqual(await inPage(shown), { row: true, left: false, right: false, tabs: true, share: false, switcher: false, menu: false, mode: "row", same: true });
  assert.equal(await inPage(() => document.getElementById("picker").getAttribute("src")), null, "the picker unloads with its bubble");
}));

describe("reduced motion and no timers", () => pageTest("strip", { viewport: ROW, reducedMotion: "reduce", fixtures: { collaboration: { guests: [{ label: "Ana", role: "drive" }] } } }, async ({ page, inPage, harness }) => {
  // reduced motion: the Live dot still, no transitions
  assert.equal(await inPage(() => document.getElementById("pill").dataset.state), "live");
  await page.hover('#tabs li[data-id="12"]');
  await page.waitForTimeout(100);
  assert.deepEqual(await harness.animations(), []);
  assert.equal(await inPage(() => getComputedStyle(document.querySelector("#tabs li")).transitionDuration), "0s");
  const l = await harness.live();
  assert.equal(l.timeouts + l.intervals + l.frames + l.observers, 0);
}));

// The browser's tab-row slot is 44 px tall and clips the rest: a popover under the row would open
// unseen and take the keyboard focus with it. There the logo opens the picker as a tab, Share opens
// the workspace dock's Share card, the menu is not shown, and nothing under the row ever opens.
describe("in the 44 px row no popover opens under the row", () => pageTest("strip", { viewport: ROW, shim: { layout: { left: 1 } } }, async ({ page, shim, inPage, until }) => {
  const under = () => ["switcher", "share-card", "menu"].filter((id) => !document.getElementById(id).hidden);
  const insidePopover = () => !!document.activeElement?.closest?.("#switcher, #share-card, #menu");
  assert.equal(await inPage(() => document.getElementById("menu-btn").checkVisibility()), false, "no menu without room for it");
  for (const id of ["switch", "share-btn"]) assert.equal(await page.getAttribute(`#${id}`, "aria-expanded"), null, `${id}: no popover to expand`);
  assert.match(await page.getAttribute("#switch", "aria-label"), /opens the session picker in a new tab/);
  await page.click("#switch");
  await page.waitForTimeout(50);
  assert.deepEqual(await callsOf(shim, "tabs", "create"), [["pairbrowse://picker", true, 1]]);
  assert.deepEqual(await inPage(under), []);
  assert.equal(await inPage(insidePopover), false);
  // Share: the left dock opens (it was a rail), then its Share card is asked for this window.
  // A stand-in for the left dock answers that it opened the card (another window's answer is not
  // this strip's).
  await inPage(() => { window.__asked = []; const ch = new BroadcastChannel("pairbrowse-share"); window.__dock = ch; ch.onmessage = (e) => { window.__asked.push(e.data); if (e.data?.open === "share") { ch.postMessage({ opened: "share", window: 2 }); ch.postMessage({ opened: "share", window: e.data.window }); } }; });
  await page.click("#share-btn");
  await until("asked", () => window.__asked.length === 1);
  assert.deepEqual(await inPage(() => window.__asked), [{ open: "share", window: 1 }]);
  // The card opened elsewhere in the window: said where once the dock says so, the focus stays on Share.
  await until("the note", () => document.getElementById("share-note").textContent !== "");
  assert.deepEqual(await inPage(() => { const n = document.getElementById("share-note"); return { text: n.textContent, role: n.getAttribute("role"), live: n.getAttribute("aria-live"), focus: document.activeElement.id }; }),
    { text: "Share card opened in the workspace dock (F6)", role: "status", live: "polite", focus: "share-btn" });
  // No dock answers (it does not know its window yet): no claim that the card opened, what to do instead.
  await inPage(() => { window.__dock.onmessage = (e) => window.__asked.push(e.data); });
  await page.click("#share-btn");
  await until("the fallback", () => /^Open the workspace dock to share \((⌘⇧L|Ctrl\+Shift\+L)\)$/.test(document.getElementById("share-note").textContent));
  assert.equal(await inPage(() => (window.__dock.close(), document.activeElement.id)), "share-btn");
  assert.equal((await callsOf(shim, "layout", "set")).at(-1)[0].left, 2);
  assert.deepEqual(await inPage(under), []);
  assert.equal(await inPage(insidePopover), false);
  // A taller host (the harness, a later bubble host) gets the popovers back.
  await page.setViewportSize(TALL);
  await until("menu back", () => document.getElementById("menu-btn").checkVisibility());
  assert.equal(await page.getAttribute("#switch", "aria-expanded"), "false");
  await page.click("#menu-btn");
  assert.deepEqual(await inPage(under), ["menu"]);
}));

// The nav fragments sit in the shell's 108 x 34 nav groups: the fragment is exactly as tall as its
// slot, its buttons centered (no hover square cut off), and the page transparent so the nav row's
// own color shows through.
describe("the nav fragments fit their 34 px slots", () => pageTest("strip", { viewport: { width: 108, height: 34 } }, async ({ inPage, until }) => {
  for (const hash of ["#nav-left", "#nav-right"]) {
    await inPage((h) => { location.hash = h; }, hash);
    await until(hash, (h) => document.body.dataset.mode === h.slice(1), hash);
    const box = await inPage((id) => {
      const nav = document.getElementById(id);
      const buttons = [...nav.querySelectorAll("button")].filter((b) => b.checkVisibility()).map((b) => b.getBoundingClientRect());
      return {
        height: nav.getBoundingClientRect().height, doc: document.documentElement.scrollHeight,
        body: getComputedStyle(document.body).backgroundColor, html: getComputedStyle(document.documentElement).backgroundColor,
        tops: buttons.map((r) => r.top), bottoms: buttons.map((r) => r.bottom), lefts: buttons.map((r) => r.left), rights: buttons.map((r) => r.right),
      };
    }, hash.slice(1));
    assert.equal(box.height, 34, `${hash}: as tall as the slot`);
    assert.equal(box.doc, 34, `${hash}: the document is the slot's height`);
    assert.deepEqual([box.body, box.html], ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"], `${hash}: transparent over the nav row`);
    for (const top of box.tops) assert.equal(top, 3, `${hash}: centered`);
    for (const bottom of box.bottoms) assert.equal(bottom, 31, `${hash}: nothing cut off`);
    // nav-left centered across its slot; nav-right starts 8 px after the omnibox (its slot is wider
    // than its two or three buttons until the shell sizes it to them).
    if (hash === "#nav-left") assert.equal(Math.round(box.lefts[0] + box.rights.at(-1)), 108, `${hash}: centered across`);
    else assert.equal(Math.round(box.lefts[0]), 8, `${hash}: search 8 px from the omnibox`);
  }
}));
