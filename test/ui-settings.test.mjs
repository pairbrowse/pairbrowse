// The settings page (ui/settings, DESIGN.md Part H): every control reads the helper's current value
// and writes through a real owner route (config, profile, joinhost, diagnostics/report, report).
// The common checks (CSP, names, Tab ring, hidden, reduced motion) stay in test/ui.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pageTest } from "./helpers/ui-page.mjs";

const FX = JSON.parse(readFileSync(new URL("./fixtures/ui-settings.json", import.meta.url), "utf8"));
const fixtures = FX.helper;
const VIEW = { width: 1100, height: 900 };
const has = (posts, route, body) => posts.some((p) => p.route === route && JSON.stringify(p.body) === JSON.stringify(body));
async function posted(helper, page, what, route, body) {
  for (let i = 0; i < 100; i++) { if (has(helper.posts, route, body)) return; await page.waitForTimeout(50); }
  assert.fail(`no post for ${what}: ${JSON.stringify(helper.posts)}`);
}
const live = () => document.body.dataset.s === "live";
const text = (id) => document.getElementById(id).textContent;

// 1. The sections, organized by what people come for, read their real values.
pageTest("settings", { fixtures, viewport: VIEW }, async ({ helper, until, inPage, errors }) => {
  await until("the stream", live);
  await until("the config", () => document.querySelector("input[name=browser][value=pairbrowse]").checked);
  const top = await inPage(() => ({
    ids: [...document.querySelectorAll("main > section.sec")].map((s) => s.id),
    nav: [...document.querySelectorAll(".nav a")].map((a) => [a.textContent.trim(), a.getAttribute("href")]),
    host: document.body.dataset.host,
    docks: ["left", "right"].map((s) => document.querySelector(`input[name=dock-${s}]:checked`)?.value),
    docksShown: !document.getElementById("docks").hidden,
    tl: [document.getElementById("tl-on").getAttribute("aria-checked"), document.getElementById("tl-cap").value, document.getElementById("cap-form").hidden],
    asks: !!document.getElementById("host-asks"),
    appearance: !!document.getElementById("appearance"),
    report: document.getElementById("report-open").hidden,
  }));
  assert.deepEqual(top.ids, ["general", "agents", "sharing", "data", "about"]);
  assert.deepEqual(top.nav, [["General", "#general"], ["Agents and approvals", "#agents"], ["Sharing", "#sharing"], ["Your data", "#data"], ["About and diagnostics", "#about"], ["Browser settings", "chrome://settings"]]);
  assert.equal(top.host, "pairbrowse");
  assert.deepEqual(top.docks, ["open", "open"]);
  assert.equal(top.docksShown, true);
  assert.deepEqual(top.tl, ["true", "200", false]);
  assert.equal(top.asks, false, "join asks have one home, the agent panel");
  assert.equal(top.appearance, false, "no placeholder section");
  assert.equal(top.report, false, "the helper relays reports: Report a problem shows");

  await until("two session rows", () => document.querySelectorAll("#session-list li").length === 2);
  const rows = await inPage(() => [...document.querySelectorAll("#session-list li")].map((li) => ({
    name: li.querySelector(".name").textContent, badges: [...li.querySelectorAll("em")].map((e) => e.textContent), controls: li.querySelectorAll("button, input, a").length,
  })));
  assert.deepEqual(rows.map((r) => [r.name, r.badges]), [["Default", ["This session"]], ["checkout-test", ["Live · 1 other"]]]);
  assert.ok(rows.every((r) => r.controls === 0));

  await until("the profile", () => document.querySelectorAll("#details .row").length === 2);
  await until("the host rows", () => document.querySelectorAll("#host-list li").length === 1);
  assert.equal(await inPage(() => document.getElementById("hosts-empty").hidden), true);
  await until("the picture count", () => document.getElementById("tl-state").textContent === "1 picture kept in this session");
  await until("the versions", () => document.getElementById("about-helper").textContent === "0.15.45 · Node 22.11.0");
  assert.equal(await inPage(text, "about-browser"), "PairBrowse 142.0.7444.59 build 3");
  assert.equal(await inPage(text, "about-conn"), "Connected");
  assert.equal(await inPage(text, "about-agents"), "1 agent · 1 person joined · 0 viewers");
  assert.match(await inPage(text, "errors"), /tunnel: The Quick Tunnel didn't answer/);
  const [stream] = [...helper.streams];
  assert.equal(stream.panel, true);

  helper.set("joinhost", { hosts: [] });
  await until("the empty line", () => !document.getElementById("hosts-empty").hidden);
  assert.deepEqual(errors, []);
});

// 2. General and the pictures write through POST config; a refusal says why and keeps the helper's value.
pageTest("settings", { fixtures, viewport: VIEW }, async ({ page, helper, until, inPage }) => {
  await until("the config", () => document.querySelector("input[name=browser][value=pairbrowse]").checked);
  await page.click("input[name=browser][value=chromium]");
  await posted(helper, page, "the browser", "config", { browser: "chromium" });
  await until("restart note", () => document.getElementById("browser-msg").textContent === "Saved. PairBrowse uses it from the browser's next start.");

  await page.click("input[name=browser][value=path]");
  assert.equal(await inPage(() => document.activeElement.id), "path");
  await page.fill("#path", "/opt/missing/chrome");
  await page.press("#path", "Enter");
  await posted(helper, page, "a bad path", "config", { browser: "/opt/missing/chrome" });
  await until("the refusal", () => document.getElementById("browser-msg").textContent === "/opt/missing/chrome isn't an executable file");
  assert.equal(await inPage(() => document.getElementById("browser-msg").dataset.kind), "error");
  await page.fill("#path", "/opt/chromium/chrome");
  await page.click("#path-form button[type=submit]");
  await posted(helper, page, "a path", "config", { browser: "/opt/chromium/chrome" });
  await until("saved", () => /^Saved/.test(document.getElementById("browser-msg").textContent));
  assert.equal(helper.fixtures.config.browser, "/opt/chromium/chrome");

  await page.click("#docks .seg[data-side=left] label:nth-child(2)");
  await posted(helper, page, "the left dock", "config", { layout: { left: "rail" } });
  await until("docks saved", () => document.getElementById("docks-msg").textContent === "Saved. New sessions start this way.");

  await page.click("#tl-on");
  await posted(helper, page, "pictures off", "config", { timeline: { on: false } });
  await until("off", () => document.getElementById("tl-on").getAttribute("aria-checked") === "false" && document.getElementById("cap-form").hidden);
  await page.click("#tl-on");
  await until("on", () => document.getElementById("tl-on").getAttribute("aria-checked") === "true");
  await page.fill("#tl-cap", "50");
  assert.equal(await inPage(() => document.getElementById("cap-save").hidden), false);
  await page.press("#tl-cap", "Enter");
  await posted(helper, page, "the cap", "config", { timeline: { cap: 50 } });
  await until("cap saved", () => document.getElementById("pictures-msg").textContent === "Saved. At most 50 pictures per session.");
  // Another page's change arrives as the config event.
  helper.push("config", { ...helper.fixtures.config, layout: { left: "hidden", right: "rail", strip: 88 } });
  await until("the event", () => document.querySelector("input[name=dock-left]:checked")?.value === "hidden" && document.querySelector("input[name=dock-right]:checked")?.value === "rail");
});

// 3. Your data: the profile forms, an in-row delete question, and Remove for a join address.
pageTest("settings", { fixtures, viewport: VIEW }, async ({ page, helper, until, inPage, harness, errors }) => {
  await until("the profile", () => document.querySelectorAll("#details .row").length === 2);
  await page.fill("#add-detail [name=label]", "Phone");
  await page.fill("#add-detail [name=value]", "+49 30 1");
  await page.press("#add-detail [name=value]", "Enter");
  await posted(helper, page, "setDetail", "profile", { op: "setDetail", label: "Phone", value: "+49 30 1" });

  await page.fill("#add-secret [name=label]", "Shop");
  await page.fill("#add-secret [name=value]", "hunter2");
  await page.fill("#add-secret [name=domains]", "shop.example");
  await page.click("#add-secret button[type=submit]");
  await posted(helper, page, "setSecret", "profile", { op: "setSecret", name: "SHOP_PASSWORD", value: "hunter2", domains: "shop.example" });
  await until("the result", () => /Saved SHOP_PASSWORD/.test(document.getElementById("profile-msg").textContent));
  assert.equal(await inPage(() => [...document.querySelectorAll("input")].some((i) => i.value === "hunter2") || document.body.textContent.includes("hunter2")), false);

  await page.click("button[aria-label='Delete SHOPIFY_PASSWORD']");
  assert.equal(await inPage(() => document.activeElement.textContent), "Keep");
  await page.keyboard.press("Enter");
  assert.equal(await inPage(() => document.activeElement.getAttribute("aria-label")), "Delete SHOPIFY_PASSWORD", "Keep puts focus back");
  await page.click("button[aria-label='Delete SHOPIFY_PASSWORD']");
  await page.click("button[aria-label='Yes, delete SHOPIFY_PASSWORD']");
  await posted(helper, page, "deleteSecret", "profile", { op: "deleteSecret", name: "SHOPIFY_PASSWORD" });

  await page.click("button[aria-label='Remove tunnel.example.com']");
  await posted(helper, page, "Remove", "joinhost", { op: "forget", host: "tunnel.example.com" });
  assert.deepEqual(errors, []);
  assert.deepEqual((await harness.log()).filter((e) => ["error", "pageerror", "rejection", "csp"].includes(e.kind)), []);
});

// 4. Search, "/" and Escape; the keyboard in the nav; the focus ring.
pageTest("settings", { fixtures, viewport: VIEW }, async ({ page, until, inPage }) => {
  await until("the config", () => document.querySelector("input[name=browser][value=pairbrowse]").checked);
  const ring = await inPage(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  const focusRing = () => inPage(() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, s.outlineWidth, s.outlineColor]; });
  await page.keyboard.press("/");
  assert.equal(await inPage(() => document.activeElement.id), "search");
  await page.keyboard.type("password");
  const shown = await inPage(() => [...document.querySelectorAll("main .item")].filter((i) => getComputedStyle(i).display !== "none").map((i) => i.id));
  assert.ok(shown.includes("passwords"));
  assert.ok(!shown.includes("browser") && !shown.includes("docks") && !shown.includes("versions"), shown.join());
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("general")).display), "none");
  await page.keyboard.press("Enter");
  assert.ok(await inPage(() => document.getElementById("passwords").contains(document.activeElement)), "Enter goes to the first match");
  await page.focus("#search");
  await page.fill("#search", "zzz");
  await until("no match", () => !document.getElementById("no-match").hidden && /No settings match “zzz”/.test(document.getElementById("no-match").textContent));
  await page.keyboard.press("Escape");
  assert.equal(await inPage(() => document.getElementById("search").value), "");
  assert.equal(await inPage(() => document.getElementById("no-match").hidden), true);

  await page.focus(".nav a[href='#general']");
  assert.deepEqual(await focusRing(), ["solid", "2px", ring]);
  await page.keyboard.press("ArrowDown");
  assert.equal(await inPage(() => document.activeElement.getAttribute("href")), "#agents");
  await page.keyboard.press("End");
  assert.equal(await inPage(() => document.activeElement.id), "browser-settings");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await until("current", () => document.querySelector(".nav a[aria-current=true]")?.getAttribute("href") === "#agents");

  await page.focus("#tl-on");
  assert.deepEqual(await focusRing(), ["solid", "2px", ring]);
  await page.focus("input[name=dock-left][value=rail]");
  assert.deepEqual(await inPage(() => { const s = getComputedStyle(document.activeElement.parentElement); return [s.outlineStyle, s.outlineWidth]; }), ["solid", "2px"]);
});

// 5. Reduced motion and a hidden page; a helper without config.json or a timeline: the settings it
// can't change are not on the page and a line says why.
pageTest("settings", { fixtures: { ...fixtures, timeline: null, config: null }, reducedMotion: "reduce", viewport: VIEW }, async ({ page, until, inPage, harness }) => {
  await until("the stream", live);
  await until("the missing line", () => !document.querySelector(".cfg-missing").hidden);
  assert.deepEqual(await inPage(() => [...document.querySelectorAll(".cfg-item")].map((n) => n.hidden)), [true, true, true]);
  assert.equal(await inPage(() => document.getElementById("report-open").hidden), true, "no report relay: no button");
  await page.hover("#session-list li:first-child");
  assert.deepEqual(await harness.animations(), []);
  const fires0 = await harness.hiddenFires();
  await harness.setHidden(true);
  await page.waitForTimeout(400);
  const { timeouts, intervals, frames, observers, eventSources } = await harness.live();
  assert.deepEqual({ timeouts, intervals, frames, observers, eventSources }, { timeouts: 0, intervals: 0, frames: 0, observers: 0, eventSources: 1 });
  assert.equal(await harness.hiddenFires(), fires0);
  await harness.setHidden(false);
});

// 6. Open settings from the agent panel lands on Passwords, clear of the sticky header.
pageTest("settings", { fixtures, viewport: VIEW }, async ({ until, inPage }) => {
  await until("the stream", live);
  await inPage(() => { location.hash = "#passwords"; });
  await until("current", () => document.querySelector(".nav a[aria-current=true]")?.getAttribute("href") === "#data");
  await until("scrolled", () => document.getElementById("passwords").getBoundingClientRect().top < 200);
  assert.ok(await inPage(() => document.getElementById("passwords").getBoundingClientRect().top >= document.querySelector(".top").getBoundingClientRect().bottom));
});

// 7. Report a problem: the review screen shows exactly what is sent, the tab only when ticked
// (without its query), Send posts it to the helper's report route; Copy instead is the fallback.
pageTest("settings", { fixtures, viewport: VIEW }, async ({ page, helper, until, inPage }) => {
  await until("the button", () => !document.getElementById("report-open").hidden && !document.getElementById("report-open").disabled);
  await until("the versions", () => document.getElementById("about-helper").textContent !== "Not reported");
  await page.click("#report-open");
  await until("the dialog", () => document.getElementById("report").open && document.activeElement.id === "report-what");
  await page.click("#report-send");
  await until("asks for words", () => document.getElementById("report-msg").textContent === "Say in a few words what happened first.");
  assert.equal(has(helper.posts, "report", undefined) || helper.posts.some((p) => p.route === "report"), false);
  await page.fill("#report-what", "The switcher said a session is already chosen.");
  const before = await inPage(() => JSON.parse(document.getElementById("report-preview").textContent));
  assert.equal(before.what, "The switcher said a session is already chosen.");
  assert.equal(before.tab, null);
  assert.equal(before.schema, "pairbrowse-report/1");
  assert.deepEqual(before.app, { host: "pairbrowse", page: "settings", helper: "0.15.45", browser: { engine: "pairbrowse", version: "142.0.7444.59", build: "3" } });
  assert.equal(before.diagnostics, "PairBrowse diagnostics\nhelper 0.15.45\n");
  assert.equal(before.helperState.connection, "live");
  for (const k of ["profile", "secrets", "details", "cookies", "tabs"]) assert.ok(!(k in before), k);
  assert.equal(await inPage(text, "report-tab-url"), "https://shop.example/checkout", "no query string");
  await page.check("#report-tab");
  const after = await inPage(() => JSON.parse(document.getElementById("report-preview").textContent));
  assert.deepEqual(after.tab, { url: "https://shop.example/checkout" });
  await page.click("#report-copy");
  await until("copied", () => typeof window.__copied === "string" && window.__copied.includes("already chosen"));
  await page.click("#report-send");
  await until("sent", () => document.getElementById("report-msg").textContent === "Sent. Your reference is PB-1042.");
  const sent = helper.posts.find((p) => p.route === "report").body;
  assert.deepEqual({ ...sent, createdAt: "" }, { ...JSON.parse(await inPage(() => document.getElementById("report-preview").textContent)), createdAt: "" });
  assert.equal(await inPage(() => document.getElementById("report-send").disabled), true);
  await page.keyboard.press("Escape");
  await until("closed, focus back", () => !document.getElementById("report").open && document.activeElement.id === "report-open");
});

// 8. A failed send says so and keeps the report to copy.
pageTest("settings", { fixtures: { ...fixtures, sent: { status: 502, body: { error: "The report server didn't answer." } } }, viewport: VIEW }, async ({ page, until }) => {
  await until("the button", () => !document.getElementById("report-open").hidden && !document.getElementById("report-open").disabled);
  await page.click("#report-open");
  await until("the dialog", () => document.getElementById("report").open);
  await page.fill("#report-what", "It froze.");
  await page.click("#report-send");
  await until("failed", () => document.getElementById("report-msg").textContent === "Not sent: The report server didn't answer. Copy it instead and email it to the PairBrowse team.");
  await until("retry", () => document.getElementById("report-send").textContent === "Try again" && !document.getElementById("report-send").disabled);
});

// 9. The extension's options page in plain Chromium (no window.pairbrowse): no docks, the side
// panel named instead of the window, and Browser settings through chrome.tabs or a plain line.
pageTest("settings", { fixtures, native: false, viewport: VIEW }, async ({ page, until, inPage, errors }) => {
  await until("the config", () => document.querySelector("input[name=browser][value=pairbrowse]").checked);
  const s = await inPage(() => ({ host: document.body.dataset.host, docks: document.getElementById("docks").hidden, about: document.getElementById("about-host").textContent, invites: document.getElementById("invites-text").textContent }));
  assert.deepEqual(s, { host: "chromium", docks: true, about: "Chromium with the PairBrowse extension", invites: "Make a join code or a watch link with Share in the PairBrowse side panel. Each one asks you before anyone gets in." });
  await page.click("#browser-settings");
  await until("the plain line", () => document.getElementById("diag-msg").textContent === "Type chrome://settings in the address bar to open the browser's settings.");
  await inPage(() => { window.__opened = []; window.chrome.tabs = { create: (o) => { window.__opened.push(o.url); } }; });
  await page.click("#browser-settings");
  assert.deepEqual(await inPage(() => window.__opened), ["chrome://settings"]);
  assert.deepEqual(errors, []);
});
