// The browser build's top strip (ui/strip): the tab row from window.pairbrowse, the pill, avatars,
// Share and the menu from the helper's stream, the switcher, the nav fragments and bubbles by
// hash, keyboard paths, drag reorder and motion. The common checks (CSP, names, Tab ring, hidden
// timers, reduced motion) are in test/ui.test.mjs.
import assert from "node:assert/strict";
import { describe } from "node:test";
import { pageTest } from "./helpers/ui-page.mjs";
import { inPage as inFrame } from "./live.mjs";

const ROW = { width: 1536, height: 53 };
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
    assert.equal(t.height, 42, "42 px tall");
    assert.equal(t.bottom, 53, "on the row's bottom edge");
    assert.ok(t.width >= 160 && t.width <= 240, `width ${t.width}`);
  }
  // 2 px apart (the mockup: the tabs nearly touch; the active tab's feet reach over the gap)
  assert.equal(Math.round(b.left - a.right), 2);
  assert.equal(Math.round(c.left - b.right), 2);
  assert.equal(a.selected, "true");
  assert.equal(a.tabindex, "0");
  assert.equal(a.bg, "rgb(27, 40, 54)", "the active tab fades into the centre column (--column)");
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

describe("the active tab glows blue whoever drives it, the owner shows by its dot", () => pageTest("strip", { viewport: ROW }, async ({ shim, inPage, until }) => {
  const edges = (id) => {
    const li = document.querySelector(`#tabs li[data-id="${id}"]`);
    const s = getComputedStyle(li);
    return { owned: li.dataset.owned || "", owner: li.style.getPropertyValue("--owner"), side: s.borderLeftColor, top: s.borderTopColor, shadow: s.boxShadow, dot: !!li.querySelector(".agent") };
  };
  // A probe of the same color expression, resolved by the page's own engine.
  const probe = (expr) => { const p = document.createElement("i"); p.style.color = expr; document.body.append(p); const c = getComputedStyle(p).color; p.remove(); return c; };
  // The mockup's measured edge (--edge-tab, opaque) and its lit top edge (--tab-lit), 2026-10-13.
  const BLUE = { edge: "rgb(36, 147, 237)", top: "rgb(85, 186, 242)", halo: await inPage(probe, "rgb(50 133 246 / 0.45)") };
  const OWNER = /233, 118, 63|155, 123, 250/;
  // the active tab, Claude's: the blue edge, its top lit in --tab-lit, the blue halo; the owner's
  // color only on its dot
  const a = await inPage(edges, 11);
  assert.deepEqual([a.owned, a.owner, a.dot], ["", "", true]);
  assert.equal(a.side, BLUE.edge);
  assert.equal(a.top, BLUE.top);
  assert.ok(a.shadow.includes(BLUE.halo), `the blue halo: ${a.shadow}`);
  assert.doesNotMatch(a.top + a.shadow, OWNER);
  // an inactive owned tab: no glow of its owner's, the dot
  await shim.setOwner(12, "Codex", "#9b7bfa");
  await until("tab 12's dot", () => !!document.querySelector('#tabs li[data-id="12"] .agent'));
  const b = await inPage(edges, 12);
  assert.deepEqual([b.owned, b.owner], ["", ""]);
  assert.doesNotMatch(b.top + b.shadow, OWNER);
  assert.doesNotMatch(b.shadow, /50, 133, 246/, "no halo on an inactive tab");
  // the active tab undriven: the same blue edge and halo
  await shim.clearOwner(11);
  await until("tab 11 undriven", () => !document.querySelector('#tabs li[data-id="11"] .agent'));
  const d = await inPage(edges, 11);
  assert.equal(d.side, BLUE.edge);
  assert.equal(d.top, BLUE.top);
  assert.ok(d.shadow.includes(BLUE.halo), `the blue halo, undriven too: ${d.shadow}`);
  // another tab active, Codex's: blue as well
  await shim.activate(12);
  await until("tab 12 active", () => document.querySelector('#tabs li[data-id="12"]').getAttribute("aria-selected") === "true");
  const e = await inPage(edges, 12);
  assert.equal(e.top, BLUE.top);
  assert.ok(e.shadow.includes(BLUE.halo), `blue for Codex's tab: ${e.shadow}`);
  assert.doesNotMatch(e.top + e.shadow, OWNER);
  // a color that is not a plain #rrggbb never reaches a style: the dot falls back to --spark
  await shim.setOwner(13, "Odd", "red");
  await until("tab 13's dot", () => !!document.querySelector('#tabs li[data-id="13"] .agent'));
  const odd = await inPage(() => {
    const li = document.querySelector('#tabs li[data-id="13"]');
    const dot = li.querySelector(".agent");
    return { inline: dot.style.background, computed: getComputedStyle(dot).backgroundColor, owner: li.style.getPropertyValue("--owner") };
  });
  assert.equal(odd.inline, "var(--spark)");
  assert.equal(odd.computed, "rgb(233, 118, 63)", "the --spark color");
  assert.notEqual(odd.computed, "rgb(255, 0, 0)");
  assert.equal(odd.owner, "", "no inline --owner on the tab");
}));

describe("close and new tab", () => pageTest("strip", { viewport: ROW }, async ({ page, shim, inPage, until }) => {
  // close and new tab
  await page.click('#tabs li[data-id="11"] .close');
  await until("two tabs", () => document.querySelectorAll("#tabs li").length === 2);
  assert.deepEqual(await callsOf(shim, "tabs", "close"), [[11]]);
  await until("tab 12 active", () => document.querySelector('#tabs li[data-id="12"]').getAttribute("aria-selected") === "true");
  // The + sits on the tabs' centre line (the user saw it ride high on the row's).
  const mid = await inPage(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const t = r("#tabs li"), n = r("#new"); return [t.top + t.height / 2, n.top + n.height / 2]; });
  assert.ok(Math.abs(mid[0] - mid[1]) <= 1, `+ centre ${mid[1]} vs tab centre ${mid[0]}`);
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
  // In the 53 px row the menu is not shown (it has nowhere to open): Share ends the order. In a
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
  // Delete closes the focused tab; Backspace does not (Part H: too easy to press by accident)
  await page.focus('#tabs li[data-id="11"]');
  await page.keyboard.press("Delete");
  await until("11 gone", () => !document.querySelector('#tabs li[data-id="11"]'));
  assert.ok((await inPage(active)).startsWith("tab:"), "focus stays in the tab row");
  await page.focus('#tabs li[data-id="13"]');
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(100);
  assert.ok(await inPage(() => !!document.querySelector('#tabs li[data-id="13"]')), "Backspace keeps the tab");
  await page.keyboard.press("Delete");
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
    probe.style.borderColor = "var(--live-edge)";
    document.body.append(probe);
    const want = getComputedStyle(probe).borderTopColor;
    probe.remove();
    const pill = document.getElementById("pill");
    return { border: getComputedStyle(pill).borderTopColor, want, dotShadow: getComputedStyle(pill.querySelector(".dot")).boxShadow };
  });
  assert.equal(lit.border, lit.want, "the pill's border is --live-edge (the mockup's dark green pill)");
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
  // three shown, then "+N" (the mockup's C G Y +2)
  await until("avatars", () => document.querySelectorAll("#avatars li").length === 4);
  const av = await inPage(() => [...document.querySelectorAll("#avatars .avatar")].map((a) => {
    const r = a.getBoundingClientRect();
    const s = getComputedStyle(a);
    return { text: a.textContent, left: r.left, w: r.width, h: r.height, weight: s.fontWeight, shadow: s.boxShadow, bg: s.backgroundColor, plain: a.classList.contains("plain"), role: a.getAttribute("role"), label: a.getAttribute("aria-label") };
  }));
  assert.deepEqual(av.slice(0, 3).map((a) => a.text), ["C", "C", "B"]);
  for (const a of av.slice(0, 3)) {
    assert.equal(a.w, 30);
    assert.equal(a.h, 30);
    assert.equal(a.weight, "700");
    assert.match(a.shadow, /rgb\(11, 20, 33\) 0px 0px 0px 1\.5px/);
  }
  for (let i = 1; i < 4; i++) assert.equal(Math.round(av[i - 1].left + 30 - av[i].left), 2);
  assert.equal(av[0].bg, "rgb(233, 118, 63)");
  assert.equal(av[3].bg, "rgb(25, 42, 61)", "the +N chip on --elevated");
  assert.deepEqual([av[3].text, av[3].role, av[3].label], ["+4", "img", "4 more"]);
}));

describe("share card opens and posts an invite", () => pageTest("strip", { viewport: TALL, replies: { invite: { ok: true, code: "pb-join:FAKE", rights: "Shared browser: they can drive." } } }, async ({ page, helper, inPage, until, settle }) => {
  // the share card opens and posts an invite
  await page.click("#share-btn");
  await settle();
  const card = await inPage(() => {
    const c = document.getElementById("share-card");
    const r = c.getBoundingClientRect();
    return { hidden: c.hidden, role: c.getAttribute("role"), expanded: document.getElementById("share-btn").getAttribute("aria-expanded"), w: r.width, top: r.top, right: innerWidth - r.right, focus: document.activeElement.value };
  });
  assert.deepEqual(card, { hidden: false, role: "dialog", expanded: "true", w: 320, top: 53, right: 12, focus: "code" });
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

describe("menu: PairBrowse settings, found or opened", () => pageTest("strip", { viewport: TALL }, async ({ page, shim, inPage }) => {
  // Part H: the menu holds only PairBrowse settings; New window, Zoom and Record are gone.
  assert.equal(await inPage(() => document.getElementById("menu-btn").getAttribute("aria-haspopup")), "menu");
  await page.click("#menu-btn");
  const m = await inPage(() => ({
    role: document.getElementById("menu").getAttribute("role"), hidden: document.getElementById("menu").hidden,
    items: [...document.querySelectorAll('#menu [role="menuitem"]')].map((b) => [b.querySelector("span").textContent, b.disabled]),
    focus: document.activeElement.id, gone: ["new-window", "zoom", "record", "about"].filter((id) => document.getElementById(id)),
  }));
  assert.equal(m.role, "menu");
  assert.equal(m.hidden, false);
  assert.deepEqual(m.items, [["PairBrowse settings", false]]);
  assert.deepEqual(m.gone, []);
  assert.equal(m.focus, "settings");
  await page.keyboard.press("Escape");
  assert.deepEqual(await inPage(() => [document.getElementById("menu").hidden, document.activeElement.id, document.getElementById("menu-btn").getAttribute("aria-expanded")]), [true, "menu-btn", "false"]);
  await page.click("#menu-btn");
  await page.click("#settings");
  await page.waitForTimeout(100);
  assert.deepEqual(await callsOf(shim, "tabs", "create"), [["pairbrowse://settings", true, 1]]);
  assert.equal(await inPage(() => document.getElementById("menu").hidden), true);
  // An open settings tab in this window is brought forward, not opened twice.
  const id = await inPage(async () => (await window.pairbrowse.tabs.list()).tabs.find((t) => t.url === "pairbrowse://settings")?.id);
  if (id !== undefined) {
    await page.click("#menu-btn");
    await page.click("#settings");
    await page.waitForTimeout(100);
    assert.deepEqual(await callsOf(shim, "tabs", "create"), [["pairbrowse://settings", true, 1]]);
    assert.ok((await callsOf(shim, "tabs", "activate")).some((c) => c[0] === id));
  }
}));

describe("switcher opens the picker in an iframe", () => pageTest("strip", { viewport: TALL }, async ({ page, inPage, harness, until, settle }) => {
  // the switcher opens the picker in an iframe
  assert.equal(await inPage(() => document.getElementById("picker").getAttribute("src")), null);
  await page.click("#switch");
  await settle();
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
  // The frame unloads once the popover has faded out (DESIGN.md Part I).
  await until("unloaded", () => document.getElementById("picker").getAttribute("src") === null);
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
  await until("closed by the notice", () => document.getElementById("switcher").hidden && document.getElementById("picker").getAttribute("src") === null);
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
  await until("unloaded once faded", () => document.getElementById("picker").getAttribute("src") === null);
  // (e)
  assert.deepEqual(await harness.log(), []);
  assert.deepEqual(ctx.errors, []);
}));

describe("the hash modes", () => pageTest("strip", { viewport: TALL }, async ({ page, shim, inPage, until, settle }) => {
  // the hash modes, never a reload
  await inPage(() => { window.__sameDocument = true; });
  const shown = () => ({
    row: document.getElementById("row").checkVisibility(), left: document.getElementById("nav-left").checkVisibility(), right: document.getElementById("nav-right").checkVisibility(),
    tabs: document.getElementById("tabs").checkVisibility(), share: document.getElementById("share-card").checkVisibility(), switcher: document.getElementById("switcher").checkVisibility(), menu: document.getElementById("menu").checkVisibility(),
    mode: document.body.dataset.mode, same: window.__sameDocument === true,
  });
  // A popover closing fades out first (DESIGN.md Part I): each mode is read once that has settled.
  const go = async (h) => { await inPage((x) => { location.hash = x; }, h); await page.waitForTimeout(20); await settle(); };
  await go("#nav-left");
  await until("nav-left", () => document.body.dataset.mode === "nav-left");
  assert.deepEqual(await inPage(shown), { row: false, left: true, right: false, tabs: false, share: false, switcher: false, menu: false, mode: "nav-left", same: true });
  const nav = await inPage(() => ["back", "forward", "reload"].map((id) => { const b = document.getElementById(id); return [id, b.disabled, getComputedStyle(b).color]; }));
  assert.deepEqual(nav, [["back", true, "rgb(134, 153, 177)"], ["forward", true, "rgb(134, 153, 177)"], ["reload", false, "rgb(241, 245, 250)"]]);
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
  const right = await inPage(() => ({ star: !!document.getElementById("star"), find: document.getElementById("find").disabled, pressed: document.getElementById("sparkle").getAttribute("aria-pressed"), names: ["find"].map((id) => document.getElementById(id).getAttribute("aria-label")) }));
  assert.equal(right.star, false, "no placeholder star: the browser's own is in the address bar");
  assert.equal(right.find, false, "find is the window's find bar");
  // Enabled icons in --ink (the mockup's).
  assert.deepEqual(await inPage(() => ["find"].map((id) => getComputedStyle(document.getElementById(id)).color)), ["rgb(241, 245, 250)"]);
  await page.click("#find");
  await page.waitForTimeout(50);
  assert.deepEqual(await callsOf(shim, "windows", "find"), [[1]]);
  assert.equal(right.pressed, "true");
  assert.match(right.names[0], /^Find in page \((⌘F|Ctrl\+F)\)$/);
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

// The browser's tab-row slot is 53 px tall and clips the rest: a popover under the row would open
// unseen and take the keyboard focus with it. There each popover opens in the dock right under its
// trigger (DESIGN.md Part I): the logo's switcher at the top of the left dock, Share's card at the
// top of the agent panel, each asked with the trigger's place for its caret (the picker as a tab
// when no dock answers); the trigger shows the state the dock reports, and a second click or Escape
// on it closes it. The menu is not shown, and nothing under the row ever opens.
describe("in the 53 px row no popover opens under the row", () => pageTest("strip", { viewport: ROW, shim: { layout: { left: 1, right: 1 } } }, async ({ page, shim, inPage, until, harness }) => {
  const under = () => ["switcher", "share-card", "menu"].filter((id) => !document.getElementById(id).hidden);
  const insidePopover = () => !!document.activeElement?.closest?.("#switcher, #share-card, #menu");
  const asked = () => window.__asked.map(({ anchor, ...m }) => ({ ...m, anchor: anchor ? Object.keys(anchor).join() : null }));
  assert.equal(await inPage(() => document.getElementById("menu-btn").checkVisibility()), false, "no menu without room for it");
  for (const id of ["switch", "share-btn"]) {
    assert.equal(await page.getAttribute(`#${id}`, "aria-expanded"), "false", `${id}: says its popover is closed`);
    assert.equal(await page.getAttribute(`#${id}`, "aria-controls"), null, `${id}: the popover is another page's`);
  }
  assert.equal(await page.getAttribute("#switch", "aria-label"), "PairBrowse: switch session (opens under the logo, in the workspace)");
  assert.equal(await page.getAttribute("#share-btn", "title"), "Share this session (opens under Share, in the agent panel)");
  // The logo (DESIGN.md Part G: the one switch-session home): the left dock opens and its switcher
  // is asked for with the logo's place; a dock that answers keeps it there (no tab), and the logo
  // shows it open.
  await inPage(() => { window.__asked = []; const ch = new BroadcastChannel("pairbrowse-share"); window.__dock = ch; ch.onmessage = (e) => { window.__asked.push(e.data); if (e.data?.open === "switch") ch.postMessage({ opened: "switch", window: e.data.window }); if (e.data?.close === "switch") ch.postMessage({ closed: "switch", window: e.data.window }); }; });
  await page.click("#switch");
  await until("the switch ask", () => window.__asked.length === 1);
  assert.deepEqual(await inPage(asked), [{ open: "switch", window: 1, anchor: "left" }]);
  const logo = await inPage(() => { const r = document.getElementById("switch").getBoundingClientRect(); return { centre: Math.round(r.left + r.width / 2), sent: window.__asked[0].anchor.left }; });
  assert.equal(logo.sent, logo.centre, "the caret goes under the logo's centre");
  assert.equal((await callsOf(shim, "layout", "set")).at(-1)[0].left, 2, "the left dock opens first");
  await until("the logo shows it open", () => document.getElementById("switch").getAttribute("aria-expanded") === "true");
  await page.waitForTimeout(1300); // past SHARE_WAIT_MS
  assert.deepEqual(await callsOf(shim, "tabs", "create"), [], "answered: no picker tab");
  assert.equal((await harness.live()).timeouts, 0, "its one-shot timer is gone once answered");
  // A second click closes it (no second ask to open).
  await page.click("#switch");
  await until("closed", () => document.getElementById("switch").getAttribute("aria-expanded") === "false");
  assert.deepEqual((await inPage(asked)).at(-1), { close: "switch", window: 1, anchor: null });
  // No dock answers (another host, or none listening): the picker as a tab, as before.
  // Before the tab opens the ask is withdrawn, so a dock whose open layout lands later never
  // opens a second switcher.
  await inPage(() => { window.__dock.close(); window.__asked = []; const ch = new BroadcastChannel("pairbrowse-share"); window.__dock = ch; ch.onmessage = (e) => window.__asked.push(e.data); });
  await page.click("#switch");
  await until("the picker tab", () => window.__pairbrowse.calls.some((c) => c.iface === "tabs" && c.method === "create"));
  assert.deepEqual(await callsOf(shim, "tabs", "create"), [["pairbrowse://picker", true, 1]]);
  await until("the withdrawn ask", () => window.__asked.length === 2);
  assert.deepEqual(await inPage(() => { window.__dock.close(); return window.__asked.map(({ anchor, ...m }) => m); }), [{ open: "switch", window: 1 }, { cancel: "switch", window: 1 }]);
  assert.deepEqual(await inPage(under), []);
  assert.equal(await inPage(insidePopover), false);
  // Share: the agent panel opens (it was a rail), then its Share card is asked for this window
  // with Share's place, measured from the window's right edge. A stand-in for the agent panel
  // answers that it opened the card (another window's answer is not this strip's).
  await inPage(() => { window.__asked = []; const ch = new BroadcastChannel("pairbrowse-share"); window.__dock = ch; ch.onmessage = (e) => { window.__asked.push(e.data); if (e.data?.open === "share") { ch.postMessage({ opened: "share", window: 2 }); ch.postMessage({ opened: "share", window: e.data.window }); } if (e.data?.close === "share") ch.postMessage({ closed: "share", window: e.data.window }); }; });
  await page.click("#share-btn");
  await until("asked", () => window.__asked.length === 1);
  assert.deepEqual(await inPage(asked), [{ open: "share", window: 1, anchor: "right" }]);
  const share = await inPage(() => { const r = document.getElementById("share-btn").getBoundingClientRect(); return { centre: Math.round(innerWidth - r.right + r.width / 2), sent: window.__asked[0].anchor.right }; });
  assert.equal(share.sent, share.centre, "the caret goes under Share's centre (no browser ⋯ after this page in the harness)");
  assert.equal((await callsOf(shim, "layout", "set")).at(-1)[0].right, 2, "the agent panel opens first");
  // The card opened under Share: said once the dock says so, the focus stays on Share, which shows it open.
  await until("the note", () => document.getElementById("share-note").textContent !== "");
  assert.deepEqual(await inPage(() => { const n = document.getElementById("share-note"); return { text: n.textContent, role: n.getAttribute("role"), live: n.getAttribute("aria-live"), focus: document.activeElement.id, expanded: document.getElementById("share-btn").getAttribute("aria-expanded") }; }),
    { text: "Share card opened under Share, in the agent panel (F6)", role: "status", live: "polite", focus: "share-btn", expanded: "true" });
  // Escape on Share closes the card it opened; the focus stays on Share.
  await page.focus("#share-btn");
  await page.keyboard.press("Escape");
  await until("closed by Escape", () => document.getElementById("share-btn").getAttribute("aria-expanded") === "false");
  assert.deepEqual(await inPage(() => [window.__asked.at(-1), document.activeElement.id]), [{ close: "share", window: 1 }, "share-btn"]);
  // No dock answers (it does not know its window yet): no claim that the card opened, what to do instead.
  await inPage(() => { window.__dock.onmessage = (e) => window.__asked.push(e.data); });
  await page.click("#share-btn");
  await until("the fallback", () => document.getElementById("share-note").textContent === "Open the agent panel (the sparkle beside the address bar) to share");
  assert.equal(await inPage(() => (window.__dock.close(), document.activeElement.id)), "share-btn");
  assert.deepEqual(await inPage(under), []);
  assert.equal(await inPage(insidePopover), false);
  // A taller host (the harness, a later bubble host) gets the popovers back.
  await page.setViewportSize(TALL);
  await until("menu back", () => document.getElementById("menu-btn").checkVisibility());
  assert.equal(await page.getAttribute("#switch", "aria-expanded"), "false");
  assert.equal(await page.getAttribute("#switch", "aria-controls"), "switcher");
  await page.click("#menu-btn");
  assert.deepEqual(await inPage(under), ["menu"]);
}));

// The nav fragments sit in the shell's nav groups (525: 118 x 32 left, 76 x 32 right, in the 42 px
// nav row): the fragment is exactly as tall as its slot, its buttons centered (no hover square cut
// off) at the mockup's places, and the page painted in the nav row's own color (--column).
describe("the nav fragments fit their 32 px slots", () => pageTest("strip", { viewport: { width: 118, height: 32 } }, async ({ page, inPage, until }) => {
  for (const [hash, width] of [["#nav-left", 118], ["#nav-right", 76]]) {
    await page.setViewportSize({ width, height: 32 });
    await inPage((h) => { location.hash = h; }, hash);
    await until(hash, (h) => document.body.dataset.mode === h.slice(1), hash);
    const box = await inPage((id) => {
      const nav = document.getElementById(id);
      const buttons = [...nav.querySelectorAll("button")].filter((b) => b.checkVisibility()).map((b) => b.getBoundingClientRect());
      const probe = document.createElement("i"); probe.style.color = "var(--column)"; document.body.append(probe); const column = getComputedStyle(probe).color; probe.remove();
      return {
        height: nav.getBoundingClientRect().height, doc: document.documentElement.scrollHeight, column,
        body: getComputedStyle(document.body).backgroundColor,
        tops: buttons.map((r) => r.top), bottoms: buttons.map((r) => r.bottom), lefts: buttons.map((r) => r.left), rights: buttons.map((r) => r.right),
      };
    }, hash.slice(1));
    assert.equal(box.height, 32, `${hash}: as tall as the slot`);
    assert.equal(box.doc, 32, `${hash}: the document is the slot's height`);
    assert.equal(box.column, "rgb(27, 40, 54)");
    assert.equal(box.body, box.column, `${hash}: the nav row's own color (--column)`);
    for (const top of box.tops) assert.equal(top, 2, `${hash}: centered`);
    for (const bottom of box.bottoms) assert.equal(bottom, 30, `${hash}: nothing cut off`);
    for (const right of box.rights) assert.ok(right <= width, `${hash}: inside the slot`);
    // The mockup's places: back, forward and reload 41 px apart from 5 px in (centres 19, 60, 101);
    // search 8 px after the address bar, the sparkle 40 px after it (the star is the browser's).
    const centres = box.lefts.map((l, i) => Math.round((l + box.rights[i]) / 2));
    if (hash === "#nav-left") assert.deepEqual(centres, [19, 60, 101], `${hash}: the mockup's places`);
    else {
      assert.equal(Math.round(box.lefts[0]), 8, `${hash}: search 8 px from the omnibox`);
      for (let i = 1; i < centres.length; i++) assert.equal(centres[i] - centres[i - 1], 40, `${hash}: 40 px apart`);
    }
  }
}));

// The helper's agent-tabs (scripts/liveview.mjs agentTabs: { id, i, host, agent, person } per web
// page) written into the browser's owners for this window's tabs (ui/strip/strip.js): by `target`
// when the entry has one, else by a host that one tab and one target-less entry hold, while the
// browser has one window (the helper's `i` is creation order, never a tab-row place); only changes
// are written, and only owners this page set are cleared.
const sceneTab = (id, index, title, url, active) => ({
  id, index, window: 1, title, url, favicon: null, defaultFavicon: true, networkState: 0, muted: false, audible: false, pinned: false,
  group: null, groupTitle: null, groupColor: null, active, selected: active, blocked: false, width: 1280, height: 800, targetId: `T${id}`, canGoBack: false, canGoForward: false,
});
const SCENE_TABS = [sceneTab(21, 0, "Notion – New workspace", "https://www.notion.so/new-workspace", true), sceneTab(22, 1, "GitHub – pairbrowse", "https://github.com/pairbrowse", false), sceneTab(23, 2, "Calendar", "https://calendar.google.com/", false)];
const CLAUDE = { label: "Claude Code", color: "#e9763f" };
const entry = (i, host, agent = null, extra = {}) => ({ id: `a1b2c3d${i}`, i, host, agent, person: null, ...extra });
const SCENE_ENTRIES = [entry(0, "www.notion.so", CLAUDE), entry(1, "github.com"), entry(2, "calendar.google.com")];
describe("agent-tabs become the browser's owners for this window's tabs", () => pageTest("strip", { viewport: ROW, shim: { tabs: SCENE_TABS }, fixtures: { agentTabs: SCENE_ENTRIES } }, async ({ page, helper, shim, inPage, until }) => {
  const owners = async () => (await shim.calls()).filter((c) => c.iface === "agent" && (c.method === "setTabOwner" || c.method === "clear")).map((c) => [c.method, ...c.args]);
  const settle = () => page.waitForTimeout(150);
  // an index and host match: the owner set once, and its dot drawn
  await until("tab 21's dot", () => !!document.querySelector('#tabs li[data-id="21"] .agent'));
  assert.deepEqual(await owners(), [["setTabOwner", 21, "Claude Code", "#e9763f"]]);
  assert.equal(await inPage(() => document.querySelector('#tabs li[data-id="21"] .agent').title), "Claude Code is in this tab");
  // the same list again: no call
  helper.push("agent-tabs", SCENE_ENTRIES);
  await settle();
  assert.equal((await owners()).length, 1, "an unchanged list writes nothing");
  // a host that does not match the tab at that index: nothing for it
  helper.push("agent-tabs", [SCENE_ENTRIES[0], entry(1, "gitlab.com", { label: "Codex", color: "#9b7bfa" }), SCENE_ENTRIES[2]]);
  await settle();
  assert.equal((await owners()).length, 1, "a host mismatch writes nothing");
  // the entry's agent gone: the owner this page set is cleared
  helper.push("agent-tabs", [entry(0, "www.notion.so"), SCENE_ENTRIES[1], SCENE_ENTRIES[2]]);
  await until("tab 21's dot gone", () => !document.querySelector('#tabs li[data-id="21"] .agent'));
  assert.deepEqual((await owners()).slice(1), [["clear", 21]]);
  // a target id wins over the index: Gemini in the calendar tab, though its index names Notion's
  helper.push("agent-tabs", [entry(0, "www.notion.so", { label: "Gemini", color: "#4b8ffb" }, { target: "T23" }), SCENE_ENTRIES[1]]);
  await until("tab 23's dot", () => !!document.querySelector('#tabs li[data-id="23"] .agent'));
  assert.deepEqual((await owners()).slice(2), [["setTabOwner", 23, "Gemini", "#4b8ffb"]]);
  assert.equal(await inPage(() => !!document.querySelector('#tabs li[data-id="21"] .agent')), false, "not the tab at that index");
  // two windows: an index names no tab for sure, so an entry without a target writes nothing
  await shim.setWindow({ id: 2 });
  helper.push("agent-tabs", [entry(0, "www.notion.so", { label: "Gemini", color: "#4b8ffb" }, { target: "T23" }), entry(1, "github.com", CLAUDE)]);
  await settle();
  assert.equal((await owners()).length, 3, "no index match with two windows");
  // a person's own tab (no agent) is never an owner
  assert.equal(await inPage(() => !!document.querySelector('#tabs li[data-id="22"] .agent')), false);
  // no timer, no poll: one call per change
  const l = await inPage(() => window.__harness.live());
  assert.equal(l.timeouts + l.intervals + l.frames + l.observers, 0);
}));

// Without a target, the helper's `i` never picks a tab: two tabs on one host match nothing, and a
// tab that moves keeps its own owner and never takes another's.
const SAME_HOST_TABS = [sceneTab(31, 0, "Notion – New workspace", "https://www.notion.so/new-workspace", true), sceneTab(32, 1, "GitHub – a", "https://github.com/a", false), sceneTab(33, 2, "GitHub – b", "https://github.com/b", false)];
const CODEX = { label: "Codex", color: "#9b7bfa" };
const SAME_HOST_ENTRIES = [entry(0, "www.notion.so", CLAUDE), entry(1, "github.com", CODEX), entry(2, "github.com")];
describe("agent-tabs: one host on two tabs names neither, a move takes no owner", () => pageTest("strip", { viewport: ROW, shim: { tabs: SAME_HOST_TABS }, fixtures: { agentTabs: SAME_HOST_ENTRIES } }, async ({ page, helper, shim, inPage, until }) => {
  const owners = async () => (await shim.calls()).filter((c) => c.iface === "agent" && (c.method === "setTabOwner" || c.method === "clear")).map((c) => [c.method, ...c.args]);
  const dots = () => inPage(() => [...document.querySelectorAll("#tabs li")].filter((li) => li.querySelector(".agent")).map((li) => Number(li.dataset.id)));
  const settle = () => page.waitForTimeout(150);
  await until("tab 31's dot", () => !!document.querySelector('#tabs li[data-id="31"] .agent'));
  await settle();
  // Notion's host is on one tab: Claude's; github.com is on two, so Codex's `i` names neither
  assert.deepEqual(await owners(), [["setTabOwner", 31, "Claude Code", "#e9763f"]]);
  assert.deepEqual(await dots(), [31]);
  // the owned tab moves to the end: it keeps its owner, and the tab now at its old index takes none
  await shim.moveTab(31, 2);
  await until("tab 31 last", () => document.querySelector("#tabs li:last-of-type")?.dataset.id === "31");
  await settle();
  assert.deepEqual(await owners(), [["setTabOwner", 31, "Claude Code", "#e9763f"]], "a move writes nothing");
  assert.deepEqual(await dots(), [31]);
  // one github.com tab closes: the host is now on one tab, but still in two target-less entries
  await shim.removeTab(33);
  await settle();
  assert.equal((await owners()).length, 1, "two entries on one host name no tab");
  // the helper's list then says which: one github.com entry, Codex's
  helper.push("agent-tabs", [entry(0, "www.notion.so", CLAUDE), entry(1, "github.com", CODEX)]);
  await until("tab 32's dot", () => !!document.querySelector('#tabs li[data-id="32"] .agent'));
  assert.deepEqual((await owners()).slice(1), [["setTabOwner", 32, "Codex", "#9b7bfa"]]);
  const l = await inPage(() => window.__harness.live());
  assert.equal(l.timeouts + l.intervals + l.frames + l.observers, 0);
}));

// Only owners this page set are cleared: one another writer set (already as the helper says) stays
// when the helper's entry goes; one this page set before a reload is still cleared after it.
describe("agent-tabs clear only this page's owners, across a reload", () => pageTest("strip", { viewport: ROW, shim: { tabs: SCENE_TABS }, fixtures: { agentTabs: SCENE_ENTRIES } }, async ({ page, helper, shim, inPage, until }) => {
  const owners = async () => (await shim.calls()).filter((c) => c.iface === "agent" && (c.method === "setTabOwner" || c.method === "clear")).map((c) => [c.method, ...c.args]);
  const settle = () => page.waitForTimeout(150);
  await until("tab 21's dot", () => !!document.querySelector('#tabs li[data-id="21"] .agent'));
  // another writer set Gemini on the calendar tab; the helper then says the same: nothing to write
  await shim.setOwner(23, "Gemini", "#4b8ffb");
  helper.push("agent-tabs", [SCENE_ENTRIES[0], SCENE_ENTRIES[1], entry(2, "calendar.google.com", { label: "Gemini", color: "#4b8ffb" }, { target: "T23" })]);
  await settle();
  assert.deepEqual(await owners(), [["setTabOwner", 21, "Claude Code", "#e9763f"]]);
  // the helper's entry goes: the owner is not this page's, so it stays
  helper.push("agent-tabs", SCENE_ENTRIES);
  await settle();
  assert.deepEqual(await owners(), [["setTabOwner", 21, "Claude Code", "#e9763f"]], "not this page's to clear");
  assert.equal(await inPage(() => !!document.querySelector('#tabs li[data-id="23"] .agent')), true);
  // the strip reloads, and the helper's first list no longer has Claude: the owner this page set
  // before the reload is cleared
  helper.fixtures.agentTabs = [entry(0, "www.notion.so"), SCENE_ENTRIES[1], SCENE_ENTRIES[2]];
  await page.reload();
  await until("the clear", () => (window.__pairbrowse?.calls || []).some((c) => c.iface === "agent" && c.method === "clear"));
  assert.deepEqual(await owners(), [["clear", 21]]);
}));

// The tab order for the helper (scripts/daemon/taborder.mjs): every window's tabs by CDP target,
// posted once per burst of tab or focus events (a microtask, no timer), and the helper's arrange
// request moving only this window's tabs among the places they hold.
describe("reports the tab order and arranges this window's tabs", () => pageTest("strip", { viewport: ROW }, async ({ helper, shim, inPage, until, harness }) => {
  const reports = () => helper.posts.filter((p) => p.route === "tab-order").map((p) => p.body);
  for (let i = 0; i < 60 && !reports().length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(reports().length, 1, "one report once connected");
  assert.deepEqual(reports()[0], { tabs: [{ target: "T11", window: 1, index: 0, active: true }, { target: "T12", window: 1, index: 1, active: false }, { target: "T13", window: 1, index: 2, active: false }], focused: 1, last: 1 });
  // A burst: a move and an activation in one task, one report.
  await inPage(() => { window.__pairbrowse.tabs.move(13, 0, -1); window.__pairbrowse.tabs.activate(12); });
  for (let i = 0; i < 60 && reports().length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(reports().length, 2, "one report for the burst");
  assert.deepEqual(reports()[1].tabs.map((t) => [t.target, t.index, t.active]).sort(), [["T11", 1, false], ["T12", 2, true], ["T13", 0, false]]);
  // Another window's tab, then the helper asks for an order: only this window's tabs move.
  await shim.setWindow({ id: 2 });
  await shim.createTab({ url: "https://other.example/", title: "Other", window: 2, active: true });
  await new Promise((r) => setTimeout(r, 200));
  const other = (await shim.fixture()).tabs.find((t) => t.window === 2);
  helper.push("tab-order", { op: "arrange", targets: ["T12", other.targetId, "T11", "T13"] });
  await until("arranged", () => { const t = window.__pairbrowse.fixture.tabs.filter((x) => x.window === 1).sort((a, b) => a.index - b.index).map((x) => x.id); return t.join() === "12,11,13"; });
  const moves = (await shim.calls()).filter((c) => c.iface === "tabs" && c.method === "move").map((c) => c.args[0]);
  assert.ok(!moves.includes(other.id), "the other window's tab stays");
  assert.equal((await shim.fixture()).tabs.find((t) => t.id === other.id).index, 0);
  assert.equal((await harness.live()).timeouts ?? 0, 0, "no timer");
}));
