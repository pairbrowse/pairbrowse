// The settings page (ui/settings, DESIGN.md Part H): every control reads the helper's current value
// and writes through a real owner route (config, profile, joinhost, invite, diagnostics/report,
// report), and the config and invites events keep it current; saved sessions link to the sessions page.
// The common checks (CSP, names, Tab ring, hidden, reduced motion) stay in test/ui.test.mjs.
import "./helpers/home.mjs";
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
// A test that runs as the browser's own page and again as the extension's options page (plain
// The engine: no window.pairbrowse, the extension's storage holds the helper's address): every
// section works the same in both.
const both = (opts, fn) => { pageTest("settings", opts, fn); pageTest("settings", { ...opts, native: false }, fn); };
const live = () => document.body.dataset.s === "live";
const text = (id) => document.getElementById(id).textContent;

// 1. The sections, organized by what people come for, read their real values.
both({ fixtures, viewport: VIEW }, async ({ helper, until, inPage, errors }) => {
  await until("the stream", live);
  await until("the config", () => document.querySelector("input[name=browser][value=pairbrowse]").checked);
  const top = await inPage(() => ({
    ids: [...document.querySelectorAll("main > section.sec")].map((s) => s.id),
    nav: [...document.querySelectorAll(".nav a")].filter((a) => !a.hidden).map((a) => [a.textContent.trim(), a.getAttribute("href")]),
    network: [document.getElementById("network").hidden, document.getElementById("nav-network").hidden],
    host: document.body.dataset.host,
    docks: ["left", "right"].map((s) => document.querySelector(`input[name=dock-${s}]:checked`)?.value),
    docksShown: !document.getElementById("docks").hidden,
    extShown: ["docks-ext", "tool-lists"].map((id) => !document.getElementById(id).hidden),
    tl: [document.getElementById("tl-on").getAttribute("aria-checked"), document.getElementById("tl-cap").value, document.getElementById("cap-form").hidden],
    asks: !!document.getElementById("host-asks"),
    appearance: !!document.getElementById("appearance"),
    report: document.getElementById("report-open").hidden,
  }));
  assert.deepEqual(top.ids, ["general", "agents", "sharing", "network", "data", "about"]);
  assert.deepEqual(top.network, [true, true], "a helper without network.json: no Network section");
  assert.deepEqual(top.nav, [["General", "#general"], ["Agents and approvals", "#agents"], ["Sharing", "#sharing"], ["Your data", "#data"], ["About and diagnostics", "#about"], ["Browser settings", "chrome://settings"]]);
  const ext = top.host === "open";
  assert.equal(top.host, ext ? "open" : "pairbrowse");
  assert.deepEqual(top.docks, ["open", "open"]);
  // The extension has no docks: a short note says where PairBrowse is instead, and the Tools
  // tab's lists get a button that opens them in the side panel.
  assert.equal(top.docksShown, !ext);
  assert.deepEqual(top.extShown, [ext, ext]);
  assert.deepEqual(top.tl, ["true", "200", false]);
  assert.equal(top.asks, false, "join asks have one home, the agent panel");
  assert.equal(top.appearance, false, "no placeholder section");
  assert.equal(top.report, false, "the helper relays reports: Report a problem shows");

  // Saved sessions: one link to their one home, the sessions page; no list or Delete of its own.
  assert.deepEqual(await inPage(() => [...document.querySelectorAll("#sessions a, #sessions button, #sessions input, #sessions ul")].map((n) => [n.tagName, n.textContent.trim(), n.getAttribute("href")])),
    [["A", "Manage sessions…", "../sessions/index.html"]]);

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
both({ fixtures, viewport: VIEW }, async ({ page, helper, until, inPage }) => {
  await until("the config", () => document.querySelector("input[name=browser][value=pairbrowse]").checked);
  await page.click("input[name=browser][value=pairbrowse-open]");
  await posted(helper, page, "the browser", "config", { browser: "pairbrowse-open" });
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

  if (await inPage(() => document.body.dataset.host === "pairbrowse")) {
    await page.click("#docks .seg[data-side=left] label:nth-child(2)");
    await posted(helper, page, "the left dock", "config", { layout: { left: "rail" } });
    await until("docks saved", () => document.getElementById("docks-msg").textContent === "Saved. New sessions start this way.");
  }

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
both({ fixtures, viewport: VIEW }, async ({ page, helper, until, inPage, harness, errors }) => {
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
  await page.keyboard.press("Escape");
  assert.equal(await inPage(() => document.activeElement.getAttribute("aria-label")), "Delete SHOPIFY_PASSWORD", "Escape keeps it, focus back");
  assert.equal(await inPage(() => !!document.querySelector("#secrets .ask")), false, "the question is gone");
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
  const cfg = await inPage(() => [...document.querySelectorAll(".cfg-item")].map((n) => n.hidden));
  assert.ok(cfg.length >= 9 && cfg.every(Boolean), JSON.stringify(cfg));
  assert.equal(await inPage(() => document.getElementById("report-open").hidden), true, "no report relay: no button");
  await inPage(() => { location.hash = "#report"; });
  await page.waitForTimeout(150);
  assert.equal(await inPage(() => document.getElementById("report").open), false, "no report relay: #report opens nothing");
  await inPage(() => { history.replaceState(null, "", location.pathname); });
  await page.hover("#manage-sessions");
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
both({ fixtures, viewport: VIEW }, async ({ page, helper, until, inPage }) => {
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
  // The report service's wire value for the open build is "chromium" (ui/report.js).
  assert.deepEqual(before.app, { host: (await inPage(() => document.body.dataset.host)) === "pairbrowse" ? "pairbrowse" : "chromium", page: "settings", helper: "0.15.45", browser: { engine: "pairbrowse", version: "142.0.7444.59", build: "3" } });
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

// 7b. The helper away: a #report link opens nothing (it couldn't be sent); back, it opens.
pageTest("settings", { fixtures, viewport: VIEW }, async ({ helper, until, inPage, page }) => {
  await until("the button", () => !document.getElementById("report-open").hidden && !document.getElementById("report-open").disabled);
  helper.setDown(true);
  await until("away", () => document.body.dataset.s !== "live");
  await inPage(() => { location.hash = "#report"; });
  await page.waitForTimeout(150);
  assert.equal(await inPage(() => document.getElementById("report").open), false, "not connected: no report dialog");
  await inPage(() => { history.replaceState(null, "", location.pathname); });
  helper.setDown(false);
  await until("live again", live);
  await inPage(() => { location.hash = "#report"; });
  await until("the dialog", () => document.getElementById("report").open);
});

// 7b2. A save answered while the person already types elsewhere leaves them there: the detail's
// reply (late) clears its own form but never pulls the focus back to it mid-word.
pageTest("settings", { fixtures, viewport: VIEW, replies: { profile: async (body) => { if (body?.op === "setDetail") await new Promise((r) => setTimeout(r, 400)); return { status: 200, body: { ok: true } }; } } }, async ({ page, until, inPage, errors }) => {
  await until("the profile", () => document.querySelectorAll("#details .row").length === 2);
  await page.fill("#add-detail [name=label]", "Phone");
  await page.fill("#add-detail [name=value]", "+49 30 1");
  await page.press("#add-detail [name=value]", "Enter");
  await page.click("#add-secret [name=domains]");
  await page.keyboard.type("shop.example", { delay: 60 }); // spans the late reply
  await until("the reply", () => /Remembered Phone/.test(document.getElementById("profile-msg").textContent));
  assert.deepEqual(await inPage(() => [document.querySelector("#add-secret [name=domains]").value, document.querySelector("#add-detail [name=label]").value, document.activeElement?.id]), ["shop.example", "", "secret-domains"]);
  // With the focus still in its form (nobody moved on), the reply puts it back on the label.
  await page.fill("#add-detail [name=label]", "City");
  await page.fill("#add-detail [name=value]", "Berlin");
  await page.press("#add-detail [name=value]", "Enter");
  await until("the second reply", () => /Remembered City/.test(document.getElementById("profile-msg").textContent));
  assert.equal(await inPage(() => document.activeElement?.id), await inPage(() => document.querySelector("#add-detail [name=label]").id));
  assert.deepEqual(errors, []);
});

// 7c. The profile's error replies: an unreadable profile.json and a refused save say why, and the
// page never throws on a reply that isn't a profile.
pageTest("settings", { fixtures: { ...fixtures, profile: { error: "The profile file can't be read." } }, replies: { profile: () => ({ status: 500, body: { error: "The disk is full." } }) }, viewport: VIEW }, async ({ page, until, inPage, errors }) => {
  await until("the stream", live);
  await until("the load error", () => document.getElementById("profile-msg").textContent === "The profile file can't be read.");
  await page.fill("#add-detail [name=label]", "City");
  await page.fill("#add-detail [name=value]", "Oslo");
  await page.click("#add-detail button[type=submit]");
  await until("the save error", () => document.getElementById("profile-msg").textContent === "The disk is full.");
  assert.equal(await inPage(() => document.getElementById("profile-msg").dataset.kind), "error");
  assert.deepEqual(errors, []);
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

// 9. The extension's options page in the open build (no window.pairbrowse): no docks, the side
// panel named instead of the window, and Browser settings through chrome.tabs or a plain line.
pageTest("settings", { fixtures, native: false, viewport: VIEW }, async ({ page, until, inPage, errors }) => {
  await until("the config", () => document.querySelector("input[name=browser][value=pairbrowse]").checked);
  const s = await inPage(() => ({ host: document.body.dataset.host, docks: document.getElementById("docks").hidden, about: document.getElementById("about-host").textContent, invites: document.getElementById("invites-text").textContent }));
  assert.deepEqual(s, { host: "open", docks: true, about: "The PairBrowse extension", invites: "Make a join code or a watch link with Share in the PairBrowse side panel. Each one asks you before anyone gets in." });
  await page.click("#browser-settings");
  await until("the plain line", () => document.getElementById("diag-msg").textContent === "Type chrome://settings in the address bar to open the browser's settings.");
  await inPage(() => { window.__opened = []; window.chrome.tabs = { create: (o) => { window.__opened.push(o.url); } }; });
  await page.click("#browser-settings");
  assert.deepEqual(await inPage(() => window.__opened), ["chrome://settings"]);
  // Downloads, recordings and hand-offs: a person's click opens the side panel at its Tools tab
  // (the window read at load, so the click keeps its gesture); a script's click does nothing.
  await inPage(() => { window.__chromeCalls.length = 0; document.getElementById("tools-open").click(); });
  assert.deepEqual(await inPage(() => window.__chromeCalls), []);
  await page.click("#tools-open");
  assert.deepEqual(await inPage(() => window.__chromeCalls), [["sidePanel.open", { windowId: 7 }], ["storage.session.set", { panelTab: "tools" }]]);
  // Without the side panel's API: a plain line says where they are.
  await inPage(() => { delete window.chrome.sidePanel; });
  await page.click("#tools-open");
  await until("the plain line", () => document.getElementById("tools-msg").textContent === "Open the PairBrowse side panel with its toolbar button, then its Tools tab.");
  assert.deepEqual(errors, []);
});

// 10. The six config fields: read from config.json, written through POST config one at a time,
// a refusal in the item's own line, the notes on what waits for the next start, the config event.
both({ fixtures, viewport: VIEW }, async ({ page, helper, until, inPage, errors }) => {
  await until("the config", () => document.getElementById("your-name-field").value === "Alice");
  const read = () => inPage(() => ({
    ask: document.getElementById("ask-on").getAttribute("aria-checked"),
    dl: document.getElementById("dl-where").textContent, reset: document.getElementById("dl-acts").hidden,
    pics: document.getElementById("pics-on").getAttribute("aria-checked"),
    cookies: document.querySelector("input[name=cookies]:checked")?.value,
    tabs: document.getElementById("max-tabs").value, name: document.getElementById("your-name-field").value,
    shown: ["session-start", "downloads", "results", "cookie-banners", "open-tabs", "your-name"].map((id) => !document.getElementById(id).hidden),
  }));
  assert.deepEqual(await read(), { ask: "true", dl: "your Downloads folder", reset: true, pics: "true", cookies: "accept", tabs: "20", name: "Alice", shown: [true, true, true, true, true, true] });
  // What waits for the next start says so; the rest applies at once.
  assert.match(await inPage(text, "ask-state"), /next start/);
  assert.match(await inPage(() => document.querySelector("#your-name .help").textContent), /at PairBrowse's next start/);
  for (const id of ["downloads", "results", "cookie-banners", "open-tabs"]) assert.match(await inPage((i) => document.getElementById(i).textContent, id), /Applies at once/, id);

  await page.click("#ask-on");
  await posted(helper, page, "askSession", "config", { askSession: false });
  await until("ask saved", () => /next start/.test(document.getElementById("ask-msg").textContent) && document.getElementById("ask-on").getAttribute("aria-checked") === "false");

  await page.fill("#dl-path", "/opt/missing/folder");
  await page.press("#dl-path", "Enter");
  await posted(helper, page, "a bad folder", "config", { downloads: "/opt/missing/folder" });
  await until("the refusal", () => document.getElementById("dl-msg").textContent === "/opt/missing/folder isn't a folder" && document.getElementById("dl-msg").dataset.kind === "error");
  assert.equal(await inPage(() => document.getElementById("dl-path").value), "/opt/missing/folder", "what was typed stays to fix");
  await page.fill("#dl-path", "/Users/alice/Invoices");
  await page.click("#dl-form button[type=submit]");
  await posted(helper, page, "a folder", "config", { downloads: "/Users/alice/Invoices" });
  await until("saved", () => document.getElementById("dl-where").textContent === "/Users/alice/Invoices" && !document.getElementById("dl-acts").hidden);
  await page.click("#dl-reset");
  await posted(helper, page, "back to Downloads", "config", { downloads: null });
  await until("reset", () => document.getElementById("dl-where").textContent === "your Downloads folder" && document.getElementById("dl-acts").hidden);

  await page.click("#pics-on");
  await posted(helper, page, "pictures", "config", { pictures: false });
  await until("text only", () => document.getElementById("pics-msg").textContent === "Saved. Agents get text only.");
  await page.click("#cookie-banners .seg label:nth-child(2)");
  await posted(helper, page, "cookies", "config", { cookies: "reject" });
  await until("reject", () => document.getElementById("cookies-msg").textContent === "Saved. Cookie banners get Reject.");

  await page.fill("#max-tabs", "51");
  assert.equal(await inPage(() => document.getElementById("tabs-save").hidden), false, "Save shows once changed");
  await page.press("#max-tabs", "Enter");
  await until("the range", () => document.getElementById("tabs-msg").textContent === "Enter a whole number from 2 to 50.");
  assert.equal(helper.posts.some((p) => p.route === "config" && p.body?.maxTabs === 51), false, "nothing sent out of range");
  await page.fill("#max-tabs", "30");
  await page.press("#max-tabs", "Enter");
  await posted(helper, page, "maxTabs", "config", { maxTabs: 30 });
  await until("tabs saved", () => document.getElementById("tabs-msg").textContent === "Saved. At most 30 tabs stay open.");

  await page.fill("#your-name-field", "Al <b>");
  await page.press("#your-name-field", "Enter");
  await posted(helper, page, "a bad name", "config", { name: "Al <b>" });
  await until("the name refusal", () => /^name is up to 40 characters/.test(document.getElementById("name-msg").textContent));
  await page.fill("#your-name-field", "  Alice   Berg ");
  await page.click("#name-save");
  await posted(helper, page, "the name", "config", { name: "Alice Berg" });
  await until("name saved", () => /^Saved\. People see you as Alice Berg/.test(document.getElementById("name-msg").textContent));
  assert.deepEqual({ name: helper.fixtures.config.name, tabs: helper.fixtures.config.maxTabs, cookies: helper.fixtures.config.cookies, pictures: helper.fixtures.config.pictures, ask: helper.fixtures.config.askSession },
    { name: "Alice Berg", tabs: 30, cookies: "reject", pictures: false, ask: false });

  // Another page's change arrives as the config event.
  helper.push("config", { ...helper.fixtures.config, maxTabs: 12, cookies: "accept", pictures: true, askSession: true, downloads: "/Volumes/Data", name: "Al" });
  await until("the event", () => document.getElementById("max-tabs").value === "12" && document.querySelector("input[name=cookies]:checked")?.value === "accept");
  const after = await read();
  assert.deepEqual([after.ask, after.dl, after.reset, after.pics, after.name], ["true", "/Volumes/Data", false, "true", "Al"]);
  assert.deepEqual(errors, []);
});

// 11. An older helper's config.json without the new fields: those items stay off the page.
both({ fixtures, viewport: VIEW, replies: {} }, async ({ helper, until, inPage }) => {
  await until("the config", () => document.querySelector("input[name=browser][value=pairbrowse]").checked);
  const { name, downloads, pictures, cookies, maxTabs, askSession, ...old } = helper.fixtures.config;
  assert.ok(name !== undefined && downloads !== undefined && pictures !== undefined && cookies !== undefined && maxTabs !== undefined && askSession !== undefined);
  helper.push("config", old);
  await until("hidden", () => document.getElementById("your-name").hidden);
  assert.deepEqual(await inPage(() => ["session-start", "downloads", "results", "cookie-banners", "open-tabs", "your-name", "browser", "pictures"].map((id) => document.getElementById(id).hidden)),
    [true, true, true, true, true, true, false, false]);
});

// 12. Saved sessions: one home, the sessions page (DESIGN.md Part G). Settings links to it in this
// tab; it asks the helper nothing about sessions (no sessions.json, no pick).
both({ fixtures, viewport: VIEW }, async ({ page, helper, until, inPage, errors }) => {
  await until("the stream", live);
  assert.equal(await inPage(() => document.getElementById("sessions").querySelector(".help").textContent),
    "Each session is a browser of its own, with its own logins and tabs. Switch, rename or delete them on the sessions page.");
  const box = await inPage(() => { const r = document.getElementById("manage-sessions").getBoundingClientRect(); return { h: Math.round(r.height), display: getComputedStyle(document.getElementById("manage-sessions")).display }; });
  assert.deepEqual(box, { h: 32, display: "inline-flex" }, "drawn as the page's other actions");
  // The search finds it by what people come for.
  await page.fill("#search", "rename");
  await until("found", () => !document.getElementById("sessions").hidden && document.getElementById("sessions").checkVisibility());
  await page.fill("#search", "");
  assert.equal(helper.posts.some((p) => p.route === "pick"), false);
  await page.click("#manage-sessions");
  await page.waitForURL(/\/sessions\/index\.html$/);
  await until("the sessions page", () => document.querySelector("h1")?.textContent === "Sessions");
  assert.deepEqual(errors, []);
});

// 13. Invites out now: listed from invites.json (no key, code or link), Revoke after a question
// in the row posts invite { op: "revoke", id }; the invites event adds and drops rows; one already
// gone (404) says so and reloads the list.
both({ fixtures, viewport: VIEW }, async ({ page, helper, until, inPage, errors }) => {
  await until("two invites", () => document.querySelectorAll("#invite-list li").length === 2);
  const rows = await inPage(() => [...document.querySelectorAll("#invite-list li")].map((li) => [li.querySelector(".name").textContent, li.querySelector("small").textContent]));
  assert.deepEqual(rows, [["Bob", "Join code · can drive"], ["Wendy", "Link · can watch"]]);
  assert.equal(await inPage(() => document.getElementById("invites-empty").hidden), true);
  await page.click("button[aria-label='Revoke Bob']");
  assert.equal(await inPage(() => document.activeElement.textContent), "Keep");
  await page.keyboard.press("Escape");
  assert.equal(await inPage(() => document.activeElement.getAttribute("aria-label")), "Revoke Bob", "Escape keeps it, focus back");
  assert.equal(await inPage(() => !!document.querySelector("#invite-list .ask")), false);
  assert.equal(helper.posts.some((p) => p.route === "invite"), false, "Escape revokes nothing");
  await page.click("button[aria-label='Revoke Bob']");
  await page.click("button[aria-label='Yes, revoke Bob']");
  await posted(helper, page, "revoke", "invite", { op: "revoke", id: "0a1b2c3d" });
  await until("Bob gone", () => document.querySelectorAll("#invite-list li").length === 1);
  assert.equal(await inPage(text, "invites-msg"), "Revoked Bob. Anyone using it is out.");

  // A new invite made elsewhere (the Share card) arrives with the event, with when it ends.
  helper.set("invites", { items: [...helper.fixtures.invites.items, { id: "89abcdef", role: "drive", label: "Carol", share: "code", expires: Date.now() + 3 * 3600_000 + 60_000 }] });
  await until("Carol", () => [...document.querySelectorAll("#invite-list .name")].some((n) => n.textContent === "Carol"));
  assert.equal(await inPage(() => [...document.querySelectorAll("#invite-list li")].find((li) => li.dataset.id === "89abcdef").querySelector("small").textContent), "Join code · can drive · ends in 3 h");
  // One that ended meanwhile: the helper's 404, said, and the list read again.
  helper.push("invites", { items: [...helper.fixtures.invites.items, { id: "deadbeef", role: "watch", label: "Old", share: "link", expires: Date.now() + 60_000 }] });
  await until("Old", () => !!document.querySelector("button[aria-label='Revoke Old']"));
  await page.click("button[aria-label='Revoke Old']");
  await page.click("button[aria-label='Yes, revoke Old']");
  await until("the 404", () => document.getElementById("invites-msg").textContent === "No such invite (it may have expired or been revoked already).");
  await until("reloaded", () => !document.querySelector("button[aria-label='Revoke Old']"));
  helper.set("invites", { items: [] });
  await until("empty", () => !document.getElementById("invites-empty").hidden && document.getElementById("invite-list").hidden);
  assert.ok(!(await inPage(() => document.body.textContent)).includes("pb-join:"), "never a code on the page");
  assert.deepEqual(errors, []);
});

// 13b. A list read that answers after a newer list came with the event (a slow reply after a
// revoke's 404) never draws over it: the newer list stays.
pageTest("settings", { fixtures, viewport: VIEW }, async ({ page, helper, until, inPage, errors }) => {
  await until("the stream", live);
  helper.push("invites", { items: [...helper.fixtures.invites.items, { id: "deadbeef", role: "watch", label: "Old", share: "link", expires: Date.now() + 60_000 }] });
  await until("Old", () => !!document.querySelector("button[aria-label='Revoke Old']"));
  // The read after the 404 is held: it answers with the list as it was when asked.
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route("**/invites.json*", async (route) => { const response = await route.fetch(); await held; await route.fulfill({ response }); });
  await page.click("button[aria-label='Revoke Old']");
  await page.click("button[aria-label='Yes, revoke Old']");
  await until("the 404", () => document.getElementById("invites-msg").textContent === "No such invite (it may have expired or been revoked already).");
  await page.waitForTimeout(300); // the read is asked and held
  helper.set("invites", { items: [] });
  await until("empty", () => !document.getElementById("invites-empty").hidden && document.getElementById("invite-list").hidden);
  release();
  await page.waitForTimeout(500);
  assert.equal(await inPage(() => document.getElementById("invite-list").hidden), true, "the late read drew nothing over the newer list");
  await page.unroute("**/invites.json*");
  assert.deepEqual(errors, []);
});

// 14. The approve role: a shared browser code's row has "Can approve" (a toggle, pressed when the
// joiner may answer approval cards); a person's click posts invite { op: "role" }; a script's
// click posts nothing; links and follow codes have no such button.
both({ fixtures: { ...fixtures, invites: { items: [
  { id: "0a1b2c3d", role: "drive", label: "Bob", share: "code", mode: "shared", expires: Date.now() + 3600_000 },
  { id: "1a1b2c3d", role: "approve", label: "Alex", share: "code", mode: "shared", expires: Date.now() + 3600_000 },
  { id: "2a1b2c3d", role: "drive", label: "Fay", share: "code", mode: "follow", expires: Date.now() + 3600_000 },
  { id: "3a1b2c3d", role: "watch", label: "Wendy", share: "link", mode: "", expires: Date.now() + 3600_000 },
] } }, viewport: VIEW }, async ({ page, helper, until, inPage, errors }) => {
  await until("four invites", () => document.querySelectorAll("#invite-list li").length === 4);
  const rows = () => inPage(() => [...document.querySelectorAll("#invite-list li")].map((li) => [li.querySelector(".name").textContent, li.querySelector("small").textContent.split(" · ").slice(0, 2).join(" · "), [...li.querySelectorAll("button")].find((b) => b.textContent === "Can approve")?.getAttribute("aria-pressed") ?? null]));
  assert.deepEqual(await rows(), [["Bob", "Join code · can drive", "false"], ["Alex", "Join code · can drive and approve", "true"], ["Fay", "Join code · can drive", null], ["Wendy", "Link · can watch", null]]);
  await inPage(() => [...document.querySelectorAll("#invite-list li")][0].querySelector("button").click());
  assert.equal(helper.posts.some((p) => p.route === "invite"), false, "a script's click posts nothing");
  await page.locator("#invite-list li").first().getByRole("button", { name: "Can approve" }).click();
  await posted(helper, page, "role", "invite", { op: "role", id: "0a1b2c3d", role: "approve" });
  await until("Bob can approve", () => document.getElementById("invites-msg").textContent === "Bob can now also answer your approval cards.");
  await until("redrawn", () => [...document.querySelectorAll("#invite-list li")][0].querySelector("small").textContent.startsWith("Join code · can drive and approve"));
  assert.deepEqual(errors, []);
});

// ---- no helper, or none reached: the resting state, not an error ----
// The banner says it in every page's words (DESIGN.md B4: common.js NO_AGENT and noAgentLine), in
// --ink-2; About's connection reads "No agent connected" with the muted dot; nothing in red.
const restingLook = () => {
  const probe = (v, prop = "color") => { const i = document.createElement("i"); i.style[prop] = `var(--${v})`; document.body.append(i); const c = getComputedStyle(i)[prop]; i.remove(); return c; };
  const reds = [probe("bad"), probe("bad-ink")];
  const banner = document.getElementById("conn");
  return {
    s: document.body.dataset.s, banner: banner.textContent, bannerInk2: getComputedStyle(banner).color === probe("ink-2"),
    about: document.getElementById("about-conn").textContent,
    dotMuted: getComputedStyle(document.getElementById("about-conn"), "::before").backgroundColor === probe("muted", "backgroundColor"),
    red: [...document.querySelectorAll("body *")].filter((e) => e.checkVisibility() && e.textContent.trim() && reds.includes(getComputedStyle(e).color)).map((e) => e.id || e.className),
  };
};
const RESTING = { s: "closed", banner: "No agent connected. Ask Claude Code, Codex or Grok to use PairBrowse. Your settings show here.", bannerInk2: true, about: "No agent connected", dotMuted: true, red: [] };

pageTest("settings", { fixtures, viewport: VIEW, shim: { helper: null }, bridge: false }, async ({ until, inPage, helper, errors }) => {
  await until("no helper", () => document.body.dataset.s === "closed");
  assert.deepEqual(await inPage(restingLook), RESTING);
  assert.deepEqual(helper.gets, [], "nothing asked");
  assert.deepEqual(errors, []);
});

pageTest("settings", { fixtures, viewport: VIEW, native: false, bridge: false }, async ({ until, inPage, errors }) => {
  await until("no helper", () => document.body.dataset.s === "closed");
  assert.deepEqual(await inPage(restingLook), RESTING);
  assert.deepEqual(errors, []);
});

// The helper not reached, then answering: no red read errors meanwhile; once it answers the stream
// opens on its own and the settings replace the banner.
pageTest("settings", { fixtures, viewport: VIEW, down: true, timeout: 90_000 }, async ({ until, inPage, helper, errors }) => {
  await inPage(() => new Promise((r) => setTimeout(r, 300)));
  const at = await inPage(restingLook);
  assert.notEqual(at.s, "live");
  assert.deepEqual(at.red, []);
  helper.setDown(false);
  for (let i = 0; i < 160 && !(await inPage(live)); i++) await inPage(() => new Promise((r) => setTimeout(r, 50)));
  assert.equal(await inPage(live), true, "connected on its own");
  await until("the settings read", () => document.getElementById("about-conn").textContent === "Connected" && !document.getElementById("conn").checkVisibility());
  assert.deepEqual((await inPage(restingLook)).red, []);
  assert.deepEqual(errors, []);
});

// ---- inside the engine's settings (580): its PairBrowse section frames this page ----
// Framed (the harness's frame page stands for chrome://settings), the page shows none of its own
// header, menu or Browser settings link (the page around it is those), works as before, and posts
// its height to chrome://settings alone, again when it changes; its one observer stops while the
// page is hidden. Its colors follow the system's scheme; a whole tab stays dark as before.
const chromeOf = () => {
  const shown = (sel) => [...document.querySelectorAll(sel)].some((n) => n.checkVisibility());
  return {
    embedded: document.documentElement.hasAttribute("data-embedded"),
    header: shown("header.top"), nav: shown(".layout > .nav"), search: shown("#search"), browserLink: shown("#browser-settings"),
    sections: [...document.querySelectorAll("main > section.sec")].filter((s) => s.checkVisibility()).map((s) => s.id),
    dataLink: document.querySelector("[data-browser-settings]").target,
  };
};
const heights = () => window.__posted.filter((p) => p.data?.type === "pairbrowse-settings-height");
const tick = () => new Promise((r) => setTimeout(r, 50));

pageTest("settings", { fixtures, viewport: VIEW, frame: true }, async ({ until, inPage, top, harness, errors }) => {
  await until("the stream", live);
  await until("the config", () => document.querySelector("input[name=browser][value=pairbrowse]").checked);
  assert.deepEqual(await inPage(chromeOf), { embedded: true, header: false, nav: false, search: false, browserLink: false,
    sections: ["general", "agents", "sharing", "data", "about"], dataLink: "_top" });
  // Every message goes to chrome://settings only, and says nothing but the height.
  const posts = await top(() => window.__posted);
  assert.ok(posts.length > 0, "a height posted");
  for (const p of posts) {
    assert.equal(p.targetOrigin, "chrome://settings");
    assert.deepEqual(Object.keys(p.data).sort(), ["height", "type"]);
    assert.equal(p.data.type, "pairbrowse-settings-height");
  }
  // The last height is the page's own, and the frame follows it (as the engine's section does).
  const at = async () => ({ last: (await top(heights)).at(-1).data.height, frame: await top(() => Number(document.getElementById("framed").height)),
    body: await inPage(() => Math.ceil(document.body.getBoundingClientRect().height)) });
  let now = await at();
  for (let i = 0; i < 40 && now.last !== now.body; i++) { await inPage(tick); now = await at(); }
  assert.equal(now.last, now.body, "the posted height is the page's");
  assert.equal(now.frame, now.body, "the frame is as tall as the page");
  // Contents change: a new height goes.
  const before = now.last;
  await inPage(() => { document.getElementById("sharing").hidden = true; });
  for (let i = 0; i < 40 && now.last === before; i++) { await inPage(tick); now = await at(); }
  assert.ok(now.last < before, `a shorter page posts its height (${before} -> ${now.last})`);
  assert.equal(now.last, now.body);
  // Hidden, nothing observes; shown again, the one observer is back.
  await harness.setHidden(true);
  assert.equal((await harness.live()).observers, 0, "no observer while hidden");
  await harness.setHidden(false);
  assert.equal((await harness.live()).observers, 1, "one observer while shown");
  assert.deepEqual(errors, []);
});

// The scheme: framed, light under a light system and dark under a dark one, on the card's color
// (--frame); a whole tab of its own keeps its dark look whatever the system says.
for (const colorScheme of ["light", "dark"]) {
  for (const frame of [true, false]) {
    pageTest("settings", { fixtures, viewport: VIEW, frame, colorScheme }, async ({ until, inPage, errors }) => {
      await until("the stream", live);
      const look = await inPage(() => {
        const s = (n) => getComputedStyle(n);
        const item = document.querySelector("#general .item");
        return { ink: s(document.body).color, bg: s(document.body).backgroundColor, scheme: s(document.documentElement).colorScheme,
          item: [s(item).backgroundColor, s(item).borderTopWidth, s(item).borderLeftWidth], header: document.querySelector("header.top").checkVisibility() };
      });
      const light = frame && colorScheme === "light";
      assert.equal(look.ink, light ? "rgb(15, 27, 42)" : "rgb(241, 245, 250)", "--ink");
      assert.equal(look.bg, frame ? (light ? "rgb(255, 255, 255)" : "rgb(16, 29, 45)") : "rgb(11, 20, 33)", frame ? "the card's color (--frame)" : "--bg");
      assert.equal(look.scheme, frame ? "light dark" : "normal");
      // Framed, the settings are rows on that card (a hairline above each), not cards of their own.
      assert.deepEqual(look.item, frame ? ["rgba(0, 0, 0, 0)", "1px", "0px"] : ["rgb(16, 29, 45)", "1px", "1px"]);
      assert.equal(look.header, !frame);
      assert.deepEqual(errors, []);
    });
  }
}

// #report deep link, framed (pairbrowse://settings/pairbrowse#report): the review screen opens at
// the top of the section, where the engine's page shows it, not in the middle of a tall frame.
pageTest("settings", { fixtures, viewport: VIEW, frame: "report" }, async ({ until, inPage, errors }) => {
  await until("the review screen", () => document.getElementById("report").open);
  const y = await inPage(() => document.getElementById("report").getBoundingClientRect().top);
  assert.ok(y >= 16 && y <= 24, `at the top (${y})`);
  assert.deepEqual(errors, []);
});

// A build with the settings section (config.json settingsSection): framed there, the page stays
// (only a whole tab of its own goes to the section) and is embedded as in any build.
pageTest("settings", { fixtures: { ...fixtures, config: { ...fixtures.config, settingsSection: true } }, viewport: VIEW, frame: true }, async ({ until, inPage, top, errors }) => {
  await until("the stream", live);
  await until("the config", () => document.querySelector("input[name=browser][value=pairbrowse]").checked);
  assert.equal((await inPage(chromeOf)).embedded, true);
  assert.match(await top(() => document.getElementById("framed").contentWindow.location.pathname), /\/settings\/index\.html$/, "not sent anywhere");
  assert.ok((await top(heights)).length > 0);
  assert.deepEqual(errors, []);
});

// The extension's options page is never embedded, even in a frame (the open build is unchanged).
pageTest("settings", { fixtures, viewport: VIEW, frame: true, native: false }, async ({ until, inPage, top, errors }) => {
  await until("the stream", live);
  const c = await inPage(chromeOf);
  assert.deepEqual([c.embedded, c.header, c.nav, c.browserLink], [false, true, true, true]);
  assert.deepEqual(await top(() => window.__posted), [], "posts nothing");
  assert.deepEqual(errors, []);
});

// 13. Away (spec server-mode decision 8): the switch writes POST config { away } on a click; it
// can't be turned on without a ready channel (the line says so) and isn't a switch on a server;
// an older helper without it keeps the item off the page.
both({ fixtures: { ...fixtures, config: { ...fixtures.config, away: { on: false, server: false, ready: true } } }, viewport: VIEW }, async ({ page, helper, until, inPage, errors }) => {
  await until("the switch", () => !document.getElementById("away").hidden && !document.getElementById("away-on").disabled);
  assert.equal(await inPage(() => document.getElementById("away-on").getAttribute("aria-checked")), "false");
  assert.match(await inPage(text, "away-state"), /^Off: steps handed to you stay in this window\.$/);
  await page.click("#away-on");
  await posted(helper, page, "away", "config", { away: true });
  await until("on", () => document.getElementById("away-on").getAttribute("aria-checked") === "true" && /^On: steps handed to you also go to your phone/.test(document.getElementById("away-state").textContent));
  assert.equal(helper.fixtures.config.away.on, true);
  // Without a channel: on can't be chosen, and the line says why.
  helper.push("config", { ...helper.fixtures.config, away: { on: false, server: false, ready: false } });
  await until("not ready", () => document.getElementById("away-on").disabled && /hand-off channel first/.test(document.getElementById("away-state").textContent));
  // On a server: always on, not a switch.
  helper.push("config", { ...helper.fixtures.config, away: { on: false, server: true, ready: true } });
  await until("server", () => document.getElementById("away-on").disabled && document.getElementById("away-on").getAttribute("aria-checked") === "true" && /runs on a server/.test(document.getElementById("away-state").textContent));
  // An older helper: no away in its config, the item leaves.
  const { away: _away, ...old } = helper.fixtures.config;
  helper.push("config", old);
  await until("hidden", () => document.getElementById("away").hidden);
  assert.deepEqual(errors, []);
});

// 13b. The public hand-off link (spec server-mode step 21b): with a ready channel and no private
// route, a line under the switch offers it, its exposure in one sentence; a click writes POST
// config { publicLink: true }, and the line then turns it off. A private route keeps it out of sight.
both({ fixtures: { ...fixtures, config: { ...fixtures.config, away: { on: true, server: false, ready: true, publicLink: false, privateRoute: false } } }, viewport: VIEW }, async ({ page, helper, until, inPage, errors }) => {
  await until("the offer", () => document.querySelector("#away .away-offer") && !document.querySelector("#away .away-offer").hidden);
  assert.match(await inPage(() => document.querySelector("#away .away-offer").textContent), /free relay \(Cloudflare\) carries that one tab to whoever opens the link first/);
  await page.click("#away .away-offer button");
  await posted(helper, page, "the public link", "config", { publicLink: true });
  await until("on", () => /^Public link on/.test(document.querySelector("#away .away-offer").textContent) && /Stop the public link/.test(document.querySelector("#away .away-offer button").textContent));
  // A private route set, the link off: no offer.
  helper.push("config", { ...helper.fixtures.config, away: { on: true, server: false, ready: true, publicLink: false, privateRoute: true } });
  await until("no offer", () => document.querySelector("#away .away-offer").hidden);
  // On a server, without a private route: the same offer.
  helper.push("config", { ...helper.fixtures.config, away: { on: false, server: true, ready: true, publicLink: false, privateRoute: false } });
  await until("offered on a server", () => !document.querySelector("#away .away-offer").hidden);
  assert.deepEqual(errors, []);
});

// 14. Network (spec server-mode C14): the section renders the helper's proxies, the default and
// each session's choice; add and edit write POST network with the password only as typed (the
// field is write-only: emptied after each save or test, the row says "saved", never the value);
// Test shows the exit address, country, the leak verdict and a coherence warning; a SOCKS5 proxy
// with a username is refused with the U4 sentence; the default and a session's choice write too.
const NET = {
  problem: "", strict: true, default: null,
  proxies: [{ id: "us-east", type: "http", host: "203.0.113.10", port: 3128, auth: true, username: true, password: true, problem: "" }],
  sessions: [{ name: "default", choice: "default", id: null }, { name: "shop-a", choice: "direct", id: null }],
};
const TEST = { verdict: "ok", reason: "", exit: { ip: "203.0.113.7", country: "US" }, sameAsDirect: false,
  coherence: [{ id: "locale.timezone-vs-egress", severity: "error", text: "The browser's time zone Europe/Berlin is used in DE, but this proxy's exit is in US: sites can see the two don't match." }],
  locale: { timezone: "Europe/Berlin", languages: ["de-DE"] }, note: "The browser's own read, WebRTC and its name lookups are checked when a session using this proxy starts." };
both({ fixtures: { ...fixtures, network: NET, networkTest: TEST }, viewport: VIEW }, async ({ page, helper, until, inPage, errors }) => {
  await until("the section", () => !document.getElementById("network").hidden && !document.getElementById("nav-network").hidden);
  await until("the proxy row", () => document.querySelectorAll("#net-list li").length === 1);
  const row = await inPage(() => document.querySelector("#net-list li").textContent);
  assert.match(row, /us-east/);
  assert.match(row, /HTTP 203\.0\.113\.10:3128/);
  assert.match(row, /Username saved, password saved\./);
  assert.deepEqual(await inPage(() => [...document.querySelectorAll("#net-default option")].map((o) => [o.value, o.selected])), [["", true], ["us-east", false]]);
  assert.deepEqual(await inPage(() => [...document.querySelectorAll("#net-sessions li")].map((li) => [li.dataset.session, li.querySelector("select").value])), [["default", "default"], ["shop-a", "direct"]]);

  // Edit: the password field is write-only (empty, "saved" as its placeholder), and stays empty
  // after a save; only what was typed goes in the body.
  await page.click('#net-list li button[aria-label="Edit us-east"]');
  await until("the form", () => !document.getElementById("net-form").hidden);
  const form = await inPage(() => ({ id: document.getElementById("net-id").value, ro: document.getElementById("net-id").readOnly, type: document.getElementById("net-pass").type,
    pass: document.getElementById("net-pass").value, ph: document.getElementById("net-pass").placeholder, cred: document.getElementById("net-cred").textContent }));
  assert.deepEqual(form, { id: "us-east", ro: true, type: "password", pass: "", ph: "Saved: leave empty to keep", cred: "Username saved, password saved." });
  await page.fill("#net-port", "8080");
  await page.fill("#net-pass", "s3cret-new");
  await page.click("#net-save");
  await posted(helper, page, "the edit", "network", { op: "edit", id: "us-east", type: "http", host: "203.0.113.10", port: 8080, auth: true, password: "s3cret-new" });
  await until("saved", () => document.getElementById("net-msg").textContent === 'Saved proxy "us-east".' && document.getElementById("net-form").hidden);
  assert.equal(await inPage(() => document.getElementById("net-pass").value), "", "never kept in the page");
  assert.doesNotMatch(await inPage(() => document.body.innerText), /s3cret-new/);

  // Test: exit address, country, leak verdict and the coherence warning.
  await page.click('#net-list li button[aria-label="Test us-east"]');
  await posted(helper, page, "the test", "network", { op: "test", id: "us-east", type: "http", host: "203.0.113.10", port: 8080, auth: true });
  await until("the result", () => !document.getElementById("net-result").hidden);
  const res = await inPage(() => document.getElementById("net-result").innerText);
  assert.match(res, /^Passed\./);
  assert.match(res, /Exit address 203\.0\.113\.7, country US\./);
  assert.match(res, /No leak: the exit isn't this computer's own address\./);
  assert.match(res, /time zone Europe\/Berlin is used in DE, but this proxy's exit is in US/);
  assert.match(res, /checked when a session using this proxy starts/);

  // Add a SOCKS5 proxy without a username: added, and the list follows (one with a username is
  // taken like an HTTP proxy's: its credentials go to the native browser's auth file, RFC 1929).
  await page.click("#net-add");
  await page.fill("#net-id", "socks-a");
  await page.selectOption("#net-type", "socks5");
  await page.fill("#net-host", "198.51.100.4");
  await page.click("#net-save");
  await posted(helper, page, "the add", "network", { op: "add", id: "socks-a", type: "socks5", host: "198.51.100.4", port: null, auth: false });
  await until("two rows", () => document.querySelectorAll("#net-list li").length === 2);

  // The default and a session's choice.
  await page.selectOption("#net-default", "us-east");
  await posted(helper, page, "the default", "network", { op: "default", id: "us-east" });
  await page.selectOption('#net-sessions li[data-session="shop-a"] select', "proxy:socks-a");
  await posted(helper, page, "the session", "network", { op: "session", session: "shop-a", choice: "proxy", id: "socks-a" });
  await until("the session row", () => document.querySelector('#net-sessions li[data-session="shop-a"] select').value === "proxy:socks-a");
  assert.deepEqual(errors, []);
});

// A secrets.env that can't be used: the section says why, and the row doesn't claim "not set".
const SECRETS_PROBLEM = "/x/secrets.env is readable by other users; run chmod 600 on it. Secrets are disabled until then.";
both({ fixtures: { ...fixtures, network: { ...NET, secretsProblem: SECRETS_PROBLEM, proxies: [{ ...NET.proxies[0], username: false, password: false }] } }, viewport: VIEW }, async ({ until, inPage, errors }) => {
  await until("the proxy row", () => document.querySelectorAll("#net-list li").length === 1);
  assert.deepEqual(await inPage(() => [document.getElementById("net-secrets-problem").hidden, document.getElementById("net-secrets-problem").textContent]), [false, SECRETS_PROBLEM]);
  assert.match(await inPage(() => document.querySelector("#net-list li").textContent), /Username and password can't be read \(secrets\.env, above\)\./);
  assert.equal(await inPage(() => document.getElementById("net-add").disabled), false, "changes without credentials still go through");
  assert.deepEqual(errors, []);
});
