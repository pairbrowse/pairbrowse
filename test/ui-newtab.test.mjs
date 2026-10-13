// The new tab page: the logo, the search pill, and chips for your other recent sessions from the
// helper's sessions.json (one press: the pick itself; while agents are at work the helper's 428
// question is asked in the page, then the same pick goes again with confirm: true). The common checks (clean
// console, names, Tab ring, hidden, reduced motion) stay in test/ui.test.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { pageTest } from "./helpers/ui-page.mjs";

const VIEW = { width: 1000, height: 700 };
const SESSIONS = {
  picking: false,
  where: "Local",
  sessions: [
    { name: "default", tabs: 3, sites: ["shop.example"], current: true, people: [], live: [] },
    { name: "Shop", tabs: 2, sites: ["shop.example"], current: false, people: [], live: [] },
    { name: "Docs", tabs: 1, sites: ["docs.example"], current: false, people: [], live: [] },
    { name: "Scratch", tabs: 0, sites: [], current: false, people: [], live: [] },
    { name: "Fifth", tabs: 4, sites: [], current: false, people: [], live: [] },
  ],
};
const CHIP_TEXTS = ["Shop · 2 tabs", "Docs · 1 tab", "Scratch · No saved tabs"];
const chipTexts = (inPage) => inPage(() => [...document.querySelectorAll("#sessions .chip")].map((b) => b.textContent));
const msg = (inPage) => inPage(() => ({ text: document.getElementById("msg").textContent, kind: document.getElementById("msg").dataset.kind ?? "" }));
const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { const parts = []; res.on("data", (c) => parts.push(c)); res.on("end", () => resolve(Buffer.concat(parts))); }).on("error", reject);
});

pageTest("newtab", { viewport: VIEW }, async ({ inPage }) => {
  const r = await inPage(() => {
    const img = document.querySelector("img.logo");
    return {
      ids: ["search", "q", "sessions", "msg"].map((id) => !!document.getElementById(id)),
      shown: [img.getBoundingClientRect().width, img.getBoundingClientRect().height], loaded: img.complete && img.naturalWidth > 0, w: img.getAttribute("width"), h: img.getAttribute("height"), src: img.src,
      h1: document.querySelector("h1").textContent,
      placeholder: document.getElementById("q").placeholder,
      pill: document.getElementById("q").getBoundingClientRect().width,
    };
  });
  assert.deepEqual(r.ids, [true, true, true, true]);
  // Drawn at 96 x 96 (the SVG's own size, its naturalWidth, is larger: the file is never changed).
  assert.deepEqual(r.shown, [96, 96]);
  assert.ok(r.loaded, "the logo loaded");
  assert.equal(r.w, "96");
  assert.equal(r.h, "96");
  assert.ok(r.src.endsWith("/logo.svg"), r.src);
  assert.equal(r.h1, "PairBrowse");
  assert.equal(r.placeholder, "Search Google or type a URL");
  assert.equal(r.pill, 560);
});

pageTest("newtab", { viewport: VIEW }, async ({ ui }) => {
  const bytes = await get(`${ui.origin}/logo.svg`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "415a3f8e100338210d7ffc070dd1d7ced24297bb682af9a4153a9f49d1bffd8a");
});

pageTest("newtab", { viewport: VIEW }, async ({ page, shim }) => {
  const calls = await shim.calls();
  assert.ok(calls.some((c) => c.iface === "session" && c.method === "helper"), "session.helper() asked");
  assert.deepEqual(calls.filter((c) => c.iface === "tabs"), [], "never a tabs.* call");
  await page.route("https://www.google.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<p>search</p>" }));
  await page.fill("#q", "hello world");
  await page.press("#q", "Enter");
  await page.waitForURL("https://www.google.com/**");
  assert.equal(page.url(), "https://www.google.com/search?q=hello%20world");
});

pageTest("newtab", { viewport: VIEW }, async ({ page, ui, shim }) => {
  const calls = await shim.calls();
  assert.ok(calls.some((c) => c.iface === "session" && c.method === "helper"));
  assert.deepEqual(calls.filter((c) => c.iface === "tabs"), []);
  await page.fill("#q", `127.0.0.1:${new URL(ui.origin).port}/picker/index.html`);
  await page.press("#q", "Enter");
  await page.waitForURL((u) => u.pathname.endsWith("/picker/index.html"));
  assert.ok(page.url().endsWith("/picker/index.html"), page.url());
});

pageTest("newtab", { viewport: VIEW, fixtures: { sessions: SESSIONS }, replies: { pick: { text: 'Opening session "Shop".' } } }, async ({ page, helper, until, inPage }) => {
  await until("the chips", () => !document.getElementById("sessions").hidden);
  assert.deepEqual(await chipTexts(inPage), CHIP_TEXTS);
  assert.equal(await inPage(() => document.body.dataset.host), "build");
  await page.click("#sessions .chip >> nth=0");
  await until("the switch", () => document.body.dataset.s === "done");
  assert.deepEqual(helper.posts.map((p) => p.route), ["pick"], "no picker step");
  assert.deepEqual(helper.posts[0].body, { action: "use", name: "Shop" });
  assert.deepEqual(await msg(inPage), { text: 'Opening session "Shop".', kind: "ok" });
  // A second press after the switch sends no second pick.
  await page.click("#sessions .chip >> nth=0");
  await inPage(() => new Promise((r) => setTimeout(r, 300)));
  assert.deepEqual(helper.posts.map((p) => p.route), ["pick"]);
});

pageTest("newtab", { viewport: VIEW, fixtures: { sessions: SESSIONS }, replies: { pick: () => ({ status: 200, body: { text: 'No session "Shop".', error: true } }) } }, async ({ page, helper, until, inPage }) => {
  await until("the chips", () => !document.getElementById("sessions").hidden);
  await page.click("#sessions .chip >> nth=0");
  await until("the error", () => document.body.dataset.s === "ready" && document.getElementById("msg").textContent !== "");
  assert.deepEqual(await msg(inPage), { text: 'No session "Shop".', kind: "error" });
  assert.deepEqual(helper.posts.map((p) => p.route), ["pick"]);
  const usable = await inPage(() => { const b = document.querySelector("#sessions .chip"); return !b.disabled && getComputedStyle(document.getElementById("sessions")).pointerEvents !== "none"; });
  assert.ok(usable, "the chips are usable again");
});

pageTest("newtab", { viewport: VIEW, fixtures: { sessions: SESSIONS }, replies: { pick: () => ({ status: 404 }) } }, async ({ page, helper, until, inPage }) => {
  await until("the chips", () => !document.getElementById("sessions").hidden);
  await page.click("#sessions .chip >> nth=0");
  await until("the error", () => document.body.dataset.s === "ready" && document.getElementById("msg").textContent !== "");
  assert.deepEqual(await msg(inPage), { text: "Couldn't reach PairBrowse. Try again.", kind: "error" });
  assert.deepEqual(helper.posts.map((p) => p.route), ["pick"]);
});

// Agents at work: the helper's 428 question, asked in the page (no confirm() dialog), naming them;
// Cancel sends nothing more, Switch anyway sends the same pick with confirm: true.
pageTest("newtab", { viewport: VIEW, fixtures: { sessions: SESSIONS, agents: ["Claude", "Codex"] } }, async ({ page, helper, until, inPage, harness, errors }) => {
  await until("the chips", () => !document.getElementById("sessions").hidden);
  await inPage(() => { window.__dialogs = 0; window.confirm = () => { window.__dialogs++; return true; }; });
  await page.click("#sessions .chip >> nth=0");
  await until("the question", () => !document.getElementById("ask").hidden);
  const ask = await inPage(() => ({
    q: document.querySelector("#ask strong").textContent, extra: !!document.querySelector("#ask .agents"),
    buttons: [...document.querySelectorAll("#ask button")].map((b) => b.textContent), focus: document.activeElement.textContent,
    s: document.body.dataset.s, msg: document.getElementById("msg").textContent,
  }));
  assert.deepEqual(ask, { q: "Claude and Codex are using the browser. Switching closes every tab for them. Switch anyway?", extra: false,
    buttons: ["Switch anyway", "Cancel"], focus: "Cancel", s: "ready", msg: "" });
  assert.deepEqual(helper.posts.map((p) => p.body), [{ action: "use", name: "Shop" }]);
  await page.keyboard.press("Enter");
  await until("cancelled", () => document.getElementById("ask").hidden);
  assert.deepEqual(await msg(inPage), { text: "Not switched.", kind: "" });
  assert.equal(helper.posts.length, 1, "Cancel sends nothing");

  await page.click("#sessions .chip >> nth=1");
  await until("asked again", () => !document.getElementById("ask").hidden);
  await page.click("#ask .primary");
  await until("the switch", () => document.body.dataset.s === "done");
  assert.deepEqual(helper.posts.map((p) => p.body), [{ action: "use", name: "Shop" }, { action: "use", name: "Docs" }, { action: "use", name: "Docs", confirm: true }]);
  assert.deepEqual(await msg(inPage), { text: 'Opening session "Docs".', kind: "ok" });
  assert.equal(await inPage(() => document.getElementById("ask").hidden), true);
  assert.equal(await inPage(() => window.__dialogs), 0, "never a confirm() dialog");
  assert.deepEqual((await harness.live()).timeouts, 0);
  assert.deepEqual(errors, []);
});

pageTest("newtab", { viewport: VIEW }, async ({ page, helper, harness, errors, inPage }) => {
  const none = () => inPage(() => ({ hidden: document.getElementById("sessions").hidden, chips: document.querySelectorAll(".chip").length, msg: document.getElementById("msg").textContent }));
  assert.deepEqual(await none(), { hidden: true, chips: 0, msg: "" });
  await helper.close();
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(300);
  assert.deepEqual(await none(), { hidden: true, chips: 0, msg: "" });
  const bad = (await harness.log()).filter((e) => ["error", "pageerror", "rejection", "csp"].includes(e.kind));
  assert.deepEqual(bad, []);
  assert.deepEqual(errors, []);
});

pageTest("newtab", { viewport: VIEW, fixtures: { sessions: SESSIONS } }, async ({ page, helper, until, inPage }) => {
  await until("the chips", () => !document.getElementById("sessions").hidden);
  const host = await inPage(async () => {
    window.pairbrowse = undefined;
    document.getElementById("sessions").replaceChildren();
    document.getElementById("sessions").hidden = true;
    const m = await import("/newtab/newtab.js");
    await m.boot();
    return document.body.dataset.host;
  });
  assert.equal(host, "extension");
  assert.deepEqual(await chipTexts(inPage), CHIP_TEXTS);
  await page.click("#sessions .chip >> nth=1");
  await until("the posts", () => document.body.dataset.s === "done" || document.body.dataset.s === "ready");
  assert.deepEqual(helper.posts.map((p) => p.route).slice(-1), ["pick"]);
  assert.deepEqual(helper.posts.at(-1).body, { action: "use", name: "Docs" });
});

pageTest("newtab", { viewport: VIEW, fixtures: { sessions: SESSIONS }, reducedMotion: "reduce" }, async ({ page, helper, harness, until, inPage }) => {
  await until("the chips", () => !document.getElementById("sessions").hidden);
  const ring = await inPage(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    document.activeElement?.blur?.();
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
    return c;
  });
  const focused = () => inPage(() => {
    const e = document.activeElement;
    const s = getComputedStyle(e);
    return { id: e.id, name: e.dataset.name ?? null, style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, offset: s.outlineOffset };
  });
  await page.keyboard.press("Tab");
  assert.deepEqual(await focused(), { id: "q", name: null, style: "solid", width: "2px", color: ring, offset: "2px" });
  await page.keyboard.press("Tab");
  assert.deepEqual(await focused(), { id: "", name: "Shop", style: "solid", width: "2px", color: ring, offset: "2px" });
  await page.keyboard.press("Enter");
  for (let i = 0; i < 100 && !helper.posts.some((p) => p.route === "pick" && p.body?.name === "Shop"); i++) await page.waitForTimeout(50);
  assert.ok(helper.posts.some((p) => p.route === "pick" && p.body?.name === "Shop"), "Enter on a chip switches");
  await page.hover("#sessions .chip >> nth=1");
  assert.deepEqual(await harness.animations(), []);
  assert.deepEqual(await harness.live(), { timeouts: 0, intervals: 0, frames: 0, observers: 0, eventSources: 0 });
  const fires0 = await harness.hiddenFires();
  await harness.setHidden(true);
  await page.waitForTimeout(400);
  assert.equal(await harness.hiddenFires(), fires0);
});
