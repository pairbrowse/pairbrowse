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

// 9. The extension's options page in plain Chromium (no window.pairbrowse): no docks, the side
// panel named instead of the window, and Browser settings through chrome.tabs or a plain line.
pageTest("settings", { fixtures, native: false, viewport: VIEW }, async ({ page, until, inPage, errors }) => {
  await until("the config", () => document.querySelector("input[name=browser][value=pairbrowse]").checked);
  const s = await inPage(() => ({ host: document.body.dataset.host, docks: document.getElementById("docks").hidden, about: document.getElementById("about-host").textContent, invites: document.getElementById("invites-text").textContent }));
  assert.deepEqual(s, { host: "chromium", docks: true, about: "PairBrowse extension in a test browser", invites: "Make a join code or a watch link with Share in the PairBrowse side panel. Each one asks you before anyone gets in." });
  await page.click("#browser-settings");
  await until("the plain line", () => document.getElementById("diag-msg").textContent === "Type chrome://settings in the address bar to open the browser's settings.");
  await inPage(() => { window.__opened = []; window.chrome.tabs = { create: (o) => { window.__opened.push(o.url); } }; });
  await page.click("#browser-settings");
  assert.deepEqual(await inPage(() => window.__opened), ["chrome://settings"]);
  assert.deepEqual(errors, []);
});

// 10. The six config fields: read from config.json, written through POST config one at a time,
// a refusal in the item's own line, the notes on what waits for the next start, the config event.
pageTest("settings", { fixtures, viewport: VIEW }, async ({ page, helper, until, inPage, errors }) => {
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
pageTest("settings", { fixtures, viewport: VIEW, replies: {} }, async ({ helper, until, inPage }) => {
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
pageTest("settings", { fixtures, viewport: VIEW }, async ({ page, helper, until, inPage, errors }) => {
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
pageTest("settings", { fixtures, viewport: VIEW }, async ({ page, helper, until, inPage, errors }) => {
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

// 14. The approve role: a shared browser code's row has "Can approve" (a toggle, pressed when the
// joiner may answer approval cards); a person's click posts invite { op: "role" }; a script's
// click posts nothing; links and follow codes have no such button.
pageTest("settings", { fixtures: { ...fixtures, invites: { items: [
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
const RESTING = { s: "closed", banner: "No agent connected. Ask Claude Code or Codex to use PairBrowse. Your settings show here.", bannerInk2: true, about: "No agent connected", dotMuted: true, red: [] };

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
