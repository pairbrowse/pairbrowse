// The browser build's top strip (ui/strip): the tab row from window.pairbrowse, the pill, avatars,
// Share and the menu from the helper's stream, the switcher, the nav fragments and bubbles by
// hash, keyboard paths, drag reorder and motion. The common checks (CSP, names, Tab ring, hidden
// timers, reduced motion) are in test/ui.test.mjs.
import assert from "node:assert/strict";
import { describe } from "node:test";
import { pageTest } from "./helpers/ui-page.mjs";

const ROW = { width: 1536, height: 44 };
const TALL = { width: 1536, height: 480 };
const ACCENT = "rgb(50, 133, 246)";

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
    label: li.getAttribute("aria-label"), bg: s.backgroundColor, color: s.color, rtl: s.borderTopLeftRadius, rtr: s.borderTopRightRadius,
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
    assert.equal(t.height, 44);
    assert.ok(t.width >= 160 && t.width <= 240, `width ${t.width}`);
  }
  assert.equal(Math.round(b.left - a.right), 8);
  assert.equal(Math.round(c.left - b.right), 8);
  assert.equal(a.selected, "true");
  assert.equal(a.tabindex, "0");
  assert.equal(a.bg, "rgb(16, 29, 45)");
  assert.equal(a.rtl, "10px");
  assert.equal(a.rtr, "10px");
  for (const t of [b, c]) { assert.equal(t.tabindex, "-1"); assert.equal(t.color, "rgb(162, 178, 198)"); assert.equal(t.selected, "false"); }
  await page.hover('#tabs li[data-id="12"]');
  await page.waitForTimeout(250);
  assert.equal((await inPage(tabInfo, 12)).bg, "rgb(36, 55, 80)");
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
    return { w: r.width, h: r.height, bg: getComputedStyle(d).backgroundColor, title: d.title, gap: Math.round(close.left - r.right) };
  };
  const d11 = await inPage(dot, 11);
  assert.deepEqual(d11, { w: 7, h: 7, bg: "rgb(233, 118, 63)", title: "Claude is in this tab", gap: 4 });
  assert.match((await inPage(tabInfo, 11)).label, /Claude is in this tab/);
  await shim.setOwner(12, "Codex", "#a78bfa");
  await until("tab 12's dot", (id) => !!document.querySelector(`#tabs li[data-id="${id}"] .agent`), 12);
  assert.equal((await inPage(dot, 12)).bg, "rgb(167, 139, 250)");
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
  assert.equal(b.closeShown, false);
  assert.equal(b.closeTabindex, "-1");
  await shim.change({ id: 13, pinned: true });
  await until("tab 13 pinned", () => document.querySelector('#tabs li[data-id="13"]').classList.contains("pinned"));
  const p = await inPage(tabInfo, 13);
  assert.equal(p.width, 40);
  assert.equal(p.closeShown, false);
  assert.match(p.label, /, pinned$/);
  assert.equal(await inPage(() => getComputedStyle(document.querySelector('#tabs li[data-id="13"] .title')).display), "none");
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
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    seen.push(await inPage(() => {
      const a = document.activeElement;
      const s = getComputedStyle(a);
      return { id: a.id || (a.dataset.id ? `tab:${a.dataset.id}` : a.classList.contains("close") ? `close:${a.closest("li").dataset.id}` : a.tagName), ring: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` };
    }));
  }
  assert.deepEqual(seen.map((s) => s.id), ["switch", "tab:11", "close:11", "new", "share-btn", "menu-btn"]);
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
  for (const s of helper.streams) s.res.destroy();
  await until("reconnecting", () => document.getElementById("pill-text").textContent === "Reconnecting to PairBrowse");
  p = await inPage(pill);
  assert.equal(p.state, "reconnecting");
  assert.equal(p.dot, "rgb(244, 180, 93)");
}));

describe("avatar stack with +N", () => pageTest("strip", {
  viewport: ROW,
  fixtures: {
    board: { people: [{ who: "Claude", color: "#e9763f" }, { who: "Codex", color: "#a78bfa" }, { who: "Ben", color: "#4ade80" }, { who: "Dana" }, { who: "Eli", color: "#4fd1e8" }, { who: "Fay" }] },
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
  await page.focus("#switch");
  await page.keyboard.press("Escape");
  assert.deepEqual(await inPage(() => [document.getElementById("switcher").hidden, document.getElementById("picker").getAttribute("src"), document.activeElement.id]), [true, null, "switch"]);
  // The harness CSP has no frame-src yet (the lead's shared addition): those entries only.
  const bad = (await harness.log()).filter((e) => !(e.kind === "csp" && e.violatedDirective === "frame-src"));
  assert.deepEqual(bad, []);
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

  await go("#nav-right");
  await until("nav-right", () => document.body.dataset.mode === "nav-right");
  const right = await inPage(() => ({ star: document.getElementById("star").disabled, find: document.getElementById("find").disabled, pressed: document.getElementById("sparkle").getAttribute("aria-pressed"), names: ["star", "find"].map((id) => document.getElementById(id).getAttribute("aria-label")) }));
  assert.equal(right.star, true);
  assert.equal(right.find, true);
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
