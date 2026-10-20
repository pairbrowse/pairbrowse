// The left dock (ui/left, DESIGN.md B3) over the pages' harness: the dock state reflected from the
// layout, the nav rows and what they open, the tab count, the agents and who it is shared with,
// the Activity row (its page), no Storage row (PairBrowse Pro's), the Share card the strip's Share opens, the
// Sessions row (the one door to sessions: the open session's name, the switcher, "All sessions…"),
// the collapse and expand buttons at the foot (native and over the helper's route) and the keyboard.
// The common checks are in test/ui.test.mjs.
import "./helpers/home.mjs";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { pageTest } from "./helpers/ui-page.mjs";
import { inPage as inFrame } from "./helpers/live.mjs";

// Each case its own pageTest under a suite that names it, so a failure says which.
const scenario = (title, opts, fn) => describe(title, () => pageTest("left", opts, fn));

const OPEN = { width: 200, height: 936 };
// The dock's inner edge (DESIGN.md B3): the body's box-shadow and --edge as a computed color.
const innerEdge = () => { const p = document.createElement("i"); p.style.color = "var(--edge)"; document.body.append(p); const edge = getComputedStyle(p).color; p.remove(); return { shadow: getComputedStyle(document.body).boxShadow, edge }; };
const BOARD = { people: [
  { who: "Claude", kind: "agent", color: "#e9763f", status: "working", tab: "Shop" },
  { who: "Alice · Codex", kind: "agent", color: "#4fd1e8", status: "you" },
  { who: "Bob", kind: "person", status: "idle" },
  { who: "You", kind: "person", status: "idle" },
] };
const TWO_TABS = { owners: { agents: { 11: "Claude", 12: "Claude" }, colors: { 11: "#e9763f", 12: "#e9763f" } } };

async function clean(ctx) {
  assert.deepEqual(ctx.errors, []);
  const bad = (await ctx.harness.log()).filter((e) => ["error", "pageerror", "rejection", "csp"].includes(e.kind));
  assert.deepEqual(bad, []);
}
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
      const st = await inFrame(frame, () => ({ mount: document.documentElement.dataset.mount, s: document.body?.dataset.s })).catch(() => null);
      if (st?.mount === "frame" && (!s || st.s === s)) return frame;
    }
    await page.waitForTimeout(50);
  }
  return assert.fail("the framed picker did not load");
}
// A click in the frame by the mouse at its place in the window: Patchright's frame.click leaves an
// observer of its own in the parent page, which would blur the parent's live() counts.
async function clickInFrame(page, frame, sel) {
  const at = await inFrame(page, () => { const r = document.getElementById("picker").getBoundingClientRect(); return { x: r.left, y: r.top }; });
  const r = await inFrame(frame, (q) => { const b = document.querySelector(q).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, sel);
  await page.mouse.click(at.x + r.x, at.y + r.y);
}
const pickerFrames = (page) => page.frames().filter((f) => f.url().includes("/picker/")).length;
// The picker's frames once they have had a moment to go: a frame whose src was taken away can
// still be listed briefly (a slow machine), so this waits up to 3 s for none.
async function pickerFramesGone(page) {
  for (let i = 0; i < 60 && pickerFrames(page); i++) await page.waitForTimeout(50);
  return pickerFrames(page);
}
const shown = () => ({ collapse: document.getElementById("dock-collapse").checkVisibility(), expand: document.getElementById("dock-expand").checkVisibility() });
const token = (name) => { const s = document.createElement("span"); s.style.color = `var(${name})`; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; };
const calls = async (ctx, iface, method) => (await ctx.shim.calls()).filter((c) => c.iface === iface && c.method === method);
// The rows that stay: one that leaves folds away first (common.js leave, data-leaving).
const rows = () => [...document.querySelectorAll("#agents li:not([data-leaving])")].map((li) => ({
  state: li.dataset.state || "", name: li.querySelector("strong")?.textContent || "", line: li.querySelector("small")?.textContent || li.textContent,
  title: li.title, bg: li.querySelector(".avatar") ? getComputedStyle(li.querySelector(".avatar")).backgroundColor : "",
}));

scenario("left: open, rail, hidden", { viewport: OPEN }, async (ctx) => {
  const { until, inPage } = ctx;
  assert.equal(await inPage(() => document.body.dataset.dock), "open");
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  assert.deepEqual(await inPage(shown), { collapse: true, expand: false });
  let e = await inPage(innerEdge);
  assert.equal(e.shadow, `${e.edge} -1px 0px 0px 0px inset`, "open: 1 px --edge on the inner (right) side");
  assert.equal((await calls(ctx, "layout", "get")).length, 1);
  assert.equal((await calls(ctx, "layout", "addObserver")).length, 1);
  await ctx.shim.layout({ left: 1 });
  await until("the rail", () => document.body.dataset.dock === "rail");
  assert.equal(await inPage(() => document.querySelector("#nav-browser .label").checkVisibility()), false);
  assert.match(await inPage(() => document.getElementById("nav-browser").title), /^Browser · 3 open tabs$/);
  // No Workspace header (2026-10-14): the Sessions row names itself in the rail, the open session's
  // name after it once the helper says one.
  assert.equal(await inPage(() => document.getElementById("workspace")), null);
  assert.equal(await inPage(() => document.getElementById("nav-sessions").title), "Sessions");
  ctx.helper.push("session", { name: "work", where: "Local" });
  await until("the session in the rail's tooltip", () => document.getElementById("nav-sessions").title === "Sessions · work");
  assert.deepEqual(await inPage(shown), { collapse: false, expand: true });
  e = await inPage(innerEdge);
  assert.equal(e.shadow, `${e.edge} -1px 0px 0px 0px inset`, "rail: the same inner edge");
  // The dock's stream carries panel=1, so today's helper never counts it as a viewer (no screencast).
  assert.deepEqual([...ctx.helper.streams].map((st) => ({ kind: st.kind, panel: st.panel })), [{ kind: "left", panel: true }]);
  // A fresh activity line arms the one drive timer; hiding the dock stops it.
  ctx.helper.push("activity", [{ t: Date.now(), who: "Claude", text: "typed" }]);
  for (let i = 0; i < 40 && (await ctx.harness.live()).timeouts !== 1; i++) await ctx.page.waitForTimeout(50);
  assert.equal((await ctx.harness.live()).timeouts, 1);
  await ctx.shim.layout({ left: 0 });
  await until("hidden", () => document.body.dataset.dock === "hidden");
  assert.deepEqual(await inPage(() => ["main", "settings", "dock-collapse", "dock-expand"].map((id) => document.getElementById(id).inert)), [true, true, true, true]);
  assert.deepEqual(await inPage(shown), { collapse: false, expand: false });
  assert.equal((await inPage(innerEdge)).shadow, "none", "hidden: no edge");
  await ctx.page.keyboard.press("Tab");
  assert.equal(await inPage(() => document.activeElement === document.body || document.activeElement === null), true, "nothing focusable while hidden");
  const live = await ctx.harness.live();
  assert.equal(live.eventSources, 1, "the stream stays open");
  assert.equal(live.timeouts, 0, "no drive timer while hidden");
  assert.equal(live.timeouts + live.intervals + live.frames + live.observers, 0);
  await ctx.shim.layout({ left: 2 });
  await until("open again", () => document.body.dataset.dock === "open");
  assert.equal((await ctx.harness.live()).timeouts, 1, "the drive timer again while the line is fresh");
  assert.equal(await inPage(() => document.querySelector("#nav-browser .label").checkVisibility()), true);
  assert.equal(await inPage(() => document.getElementById("nav-browser").hasAttribute("title")), false);
  assert.equal(await inPage(() => document.getElementById("main").inert), false);
  assert.equal((await calls(ctx, "layout", "set")).length, 0, "the page never sets the layout on its own");
  await clean(ctx);
});

scenario("left: nav rows, active state, History and Browser", { viewport: OPEN }, async (ctx) => {
  const { until, inPage } = ctx;
  assert.deepEqual(await inPage(() => [...document.querySelectorAll(".nav .row")].map((b) => b.id)), ["nav-browser", "nav-sessions", "nav-history", "nav-activity"]);
  // Tools is the agent panel's tab: no row here opens the other dock (DESIGN.md Part I).
  assert.equal(await inPage(() => document.getElementById("nav-tools")), null);
  assert.equal(await inPage(() => document.getElementById("nav-browser").getAttribute("aria-current")), "page");
  // The active row, as the mockup draws it: the --nav-active fill, no gradient, the soft blue glow.
  const look = await inPage(() => { const p = document.createElement("i"); p.style.backgroundColor = "var(--nav-active)"; document.body.append(p); const want = getComputedStyle(p).backgroundColor; p.remove(); const s = getComputedStyle(document.getElementById("nav-browser")); return { bg: s.backgroundColor === want, image: s.backgroundImage, shadow: s.boxShadow }; });
  assert.deepEqual({ ...look, shadow: look.shadow !== "none" }, { bg: true, image: "none", shadow: true });
  // No Workspace header (2026-10-14): the Sessions row carries the workspace icon. The first row is
  // on the back button's line (2026-10-17): centred in the 42 px nav row, 3 px under the dock's top.
  assert.deepEqual(await inPage(() => [document.getElementById("workspace"), document.querySelector(".head")]), [null, null]);
  assert.equal(await inPage(() => { const r = document.getElementById("nav-browser").getBoundingClientRect(); return r.top + r.height / 2; }), 21);
  assert.equal(await inPage(() => document.querySelector("#nav-sessions .ic use").getAttribute("href")), "#i-workspace");
  await ctx.page.click("#nav-history");
  await until("a history tab", () => window.__pairbrowse.calls.some((c) => c.iface === "tabs" && c.method === "create"));
  assert.deepEqual((await calls(ctx, "tabs", "create"))[0].args, ["chrome://history", true, 1]);
  await until("History current", () => document.getElementById("nav-history").getAttribute("aria-current") === "page" && !document.getElementById("nav-browser").hasAttribute("aria-current"));
  const historyId = await inPage(() => window.__pairbrowse.fixture.tabs.find((t) => t.url === "chrome://history").id);
  await ctx.page.click("#nav-browser");
  await until("Browser current", () => document.getElementById("nav-browser").getAttribute("aria-current") === "page");
  assert.deepEqual((await calls(ctx, "tabs", "activate")).at(-1).args, [11]);
  await ctx.page.click("#nav-history");
  await until("History again", () => document.getElementById("nav-history").getAttribute("aria-current") === "page");
  assert.deepEqual((await calls(ctx, "tabs", "activate")).at(-1).args, [historyId]);
  assert.equal((await calls(ctx, "tabs", "create")).length, 1, "no second history tab");
  await clean(ctx);
});

// Settings is found by its address under either spelling, with or without a section after "#"
// (the report offer's link, as its tab reports it: the tab page's in an older build, the engine
// settings' PairBrowse section's in one with it): the tab comes forward, none is opened.
for (const url of ["chrome://pairbrowse/settings#report", "chrome://settings/pairbrowse#report"]) scenario(`left: Settings finds a Settings tab open at a section (${url})`, { viewport: OPEN }, async (ctx) => {
  const { until } = ctx;
  const id = await ctx.shim.createTab({ url, title: "Settings", active: false });
  await until("the tab", (u) => window.__pairbrowse.fixture.tabs.some((t) => t.url === u), url);
  await ctx.page.click("#settings");
  await until("Settings forward", () => window.__pairbrowse.calls.some((c) => c.iface === "tabs" && c.method === "activate"));
  assert.deepEqual((await calls(ctx, "tabs", "activate")).at(-1).args, [id]);
  assert.equal((await calls(ctx, "tabs", "create")).length, 0, "no second Settings tab");
  await clean(ctx);
});

// No Settings tab: one opens at the tab page's own address in every build (one with the engine
// settings' PairBrowse section, 580, sends it there), whatever the helper says.
for (const [section, url] of [[false, "chrome://pairbrowse/settings"], [true, "chrome://pairbrowse/settings"]]) scenario(`left: Settings opens ${url} (${section ? "the settings section" : "an older build"})`, { viewport: OPEN, fixtures: { config: { settingsSection: section } } }, async (ctx) => {
  await ctx.until("the stream", () => document.body.dataset.s === "live" || !!window.__pairbrowse);
  await ctx.page.click("#settings");
  await ctx.until("a Settings tab", () => window.__pairbrowse.calls.some((c) => c.iface === "tabs" && c.method === "create"));
  assert.deepEqual((await calls(ctx, "tabs", "create")).map((c) => c.args[0]), [url]);
  await clean(ctx);
});

scenario("left: tab count", { viewport: OPEN }, async (ctx) => {
  const { until, inPage } = ctx;
  const count = () => [document.getElementById("tab-count").textContent, document.getElementById("tab-count-words").textContent];
  assert.deepEqual(await inPage(count), ["3", "3 open tabs"]);
  await ctx.shim.createTab({});
  await until("4 tabs", () => document.getElementById("tab-count").textContent === "4");
  assert.deepEqual(await inPage(count), ["4", "4 open tabs"]);
  await ctx.shim.removeTab(12);
  await until("3 tabs", () => document.getElementById("tab-count").textContent === "3");
  assert.deepEqual(await inPage(count), ["3", "3 open tabs"]);
  // Another window's tab is not this dock's (Part H): the badge counts this window only.
  await ctx.shim.createTab({ window: 2 });
  await ctx.page.waitForTimeout(150);
  assert.deepEqual(await inPage(count), ["3", "3 open tabs"]);
  await clean(ctx);
});

scenario("left: agents rows with their state in words", { viewport: OPEN, fixtures: { board: BOARD }, shim: TWO_TABS }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("three rows", () => document.querySelectorAll("#agents li[data-state]").length === 3);
  const all = await inPage(rows);
  // The agents, then the owner ("You · Online", the mockup); another person (Bob) is never a row here.
  assert.deepEqual(all.map((r) => r.name), ["Claude", "Alice · Codex", "You"], "agents, then you; no other person");
  assert.deepEqual(all.filter((r) => r.state === "online").map((r) => [r.name, r.line]), [["You", "Online"]]);
  const [claude, alice] = all;
  // The state is the helper's (the board's status), its tabs after it: one truth with the right dock.
  assert.deepEqual([claude.state, claude.name, claude.line, claude.bg], ["working", "Claude", "Working · 2 tabs", "rgb(233, 118, 63)"]);
  assert.deepEqual([alice.state, alice.name, alice.line], ["waiting", "Alice · Codex", "Waiting for you"]);
  assert.equal(await inPage(() => document.querySelector("#agents li:nth-child(2) strong .app").textContent), " · Codex");
  assert.equal(await inPage(() => { const s = document.createElement("span"); s.style.color = "var(--ink-2)"; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return getComputedStyle(document.querySelector("#agents li:nth-child(2) strong .app")).color === c; }), true, "the app in --ink-2");
  assert.equal(await inPage(() => document.querySelector("#agents li").getBoundingClientRect().height), 44, "B3's 44 px rows (--row-person)");
  // The shared content edge (545): every avatar starts 20 px in from the dock's outer edge.
  assert.deepEqual(await inPage(() => [...document.querySelectorAll("#agents li .avatar")].map((a) => a.getBoundingClientRect().left)), [20, 20, 20]);
  const dot = (state) => getComputedStyle(document.querySelector(`#agents li[data-state="${state}"] .dot`)).backgroundColor;
  const token = (name) => { const s = document.createElement("span"); s.style.color = `var(${name})`; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; };
  assert.equal(await inPage(dot, "working"), await inPage(token, "--ok"));
  assert.equal(await inPage(dot, "waiting"), await inPage(token, "--warn"));
  ctx.helper.set("board", { people: [{ who: "Claude", kind: "agent", status: "idle" }] });
  // Idle in the helper's words, in tabs or not (never "Active" beside the right dock's "Idle").
  await until("Idle in tabs", () => document.querySelector("#agents li small")?.textContent === "Idle · 2 tabs");
  assert.equal(await inPage(() => document.querySelector("#agents li").dataset.state), "idle");
  assert.deepEqual((await inPage(rows)).map((r) => r.name), ["Claude"], "an agent-only board renders its row");
  assert.equal((await inPage(rows))[0].bg, "rgb(233, 118, 63)", "the owner's color");
  await ctx.shim.removeTab(12);
  await until("one tab", () => document.querySelector("#agents li small")?.textContent === "Idle · 1 tab");
  await ctx.shim.clearOwner(11);
  await until("Idle", () => document.querySelector("#agents li small")?.textContent === "Idle");
  assert.equal(await inPage(() => document.querySelector("#agents li").dataset.state), "idle");
  assert.equal(await inPage(dot, "idle"), await inPage(token, "--muted"), "idle: B3's --muted dot (the words say Idle)");
  await ctx.shim.setOwner(13, "Codex", "#4fd1e8");
  await until("a Codex row", () => [...document.querySelectorAll("#agents li")].some((li) => li.querySelector("strong")?.textContent === "Codex" && li.querySelector("small").textContent === "Idle · 1 tab"));
  assert.equal(await inPage(() => document.querySelectorAll('#agents li[data-state="failed"]').length), 0);
  ctx.helper.set("board", { people: [] });
  await ctx.shim.clearOwner(13);
  await until("no agent", () => document.querySelector("#agents li.empty")?.textContent === "No agent yet");
  // Said once (DESIGN.md Part G): in the browser the right dock's empty state says it; here the
  // Agents section keeps only its label and its "+".
  assert.equal(await inPage(() => document.querySelector("#agents li.empty").checkVisibility()), false);
  assert.deepEqual(await inPage(() => ["agents-h", "add-agent"].map((id) => document.getElementById(id).checkVisibility())), [true, true]);
  await clean(ctx);
});

// Activity opens the session's activity page in the contents (pairbrowse://activity), as History
// opens chrome://history: found or opened in this window, the row current while it is the active
// tab; the list itself is the page's (test/ui-activity.test.mjs). The dock still counts an agent's
// last action for "Working".
scenario("left: Activity opens the activity page", { viewport: OPEN, fixtures: { board: { people: [{ who: "Claude", kind: "agent", status: "idle" }] } } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("Idle", () => /^Idle/.test(document.querySelector("#agents li small")?.textContent || ""));
  assert.deepEqual(await inPage(() => { const r = document.getElementById("nav-activity"); return [r.getAttribute("aria-expanded"), r.getAttribute("aria-controls"), !!document.getElementById("activity-list"), !!document.querySelector(".activity")]; }),
    [null, null, false, false], "no inline fold");
  await ctx.page.focus("#nav-activity");
  await ctx.page.keyboard.press("Enter");
  await until("an activity tab", () => window.__pairbrowse.calls.some((c) => c.iface === "tabs" && c.method === "create"));
  assert.deepEqual((await calls(ctx, "tabs", "create")).map((c) => c.args), [["pairbrowse://activity", true, 1]], "in this dock's window");
  await until("Activity current", () => document.getElementById("nav-activity").getAttribute("aria-current") === "page" && !document.getElementById("nav-browser").hasAttribute("aria-current") && !document.getElementById("nav-history").hasAttribute("aria-current"));
  const activityId = await inPage(() => window.__pairbrowse.fixture.tabs.find((t) => t.url === "pairbrowse://activity").id);
  // Browser brings the last web tab back, not the activity page.
  await ctx.page.click("#nav-browser");
  await until("Browser current", () => document.getElementById("nav-browser").getAttribute("aria-current") === "page" && !document.getElementById("nav-activity").hasAttribute("aria-current"));
  assert.deepEqual((await calls(ctx, "tabs", "activate")).at(-1).args, [11]);
  // Again: the open page comes forward, no second one.
  await ctx.page.click("#nav-activity");
  await until("Activity again", () => document.getElementById("nav-activity").getAttribute("aria-current") === "page");
  assert.deepEqual((await calls(ctx, "tabs", "activate")).at(-1).args, [activityId]);
  assert.equal((await calls(ctx, "tabs", "create")).length, 1, "no second activity tab");
  // The page as the browser may show its address internally counts the same.
  await ctx.shim.change({ id: activityId, url: "chrome://pairbrowse/activity/" });
  await ctx.page.waitForTimeout(150);
  assert.equal(await inPage(() => document.getElementById("nav-activity").getAttribute("aria-current")), "page");
  // An agent's fresh line still makes it "Working" here, with the one drive timer.
  ctx.helper.push("activity", [{ t: Date.now(), who: "Claude", tab: "Shop", text: "clicked **Pay**" }]);
  await until("working", () => document.querySelector("#agents li")?.dataset.state === "working");
  assert.equal((await ctx.harness.live()).timeouts, 1);
  await ctx.harness.setHidden(true);
  assert.equal((await ctx.harness.live()).timeouts, 0);
  await ctx.harness.setHidden(false);
  assert.match(await inPage(() => document.querySelector("#agents li small").textContent), /^Working/);
  assert.equal((await calls(ctx, "layout", "set")).length, 0, "the dock's state stays");
  await clean(ctx);
});

scenario("left: Activity from the rail opens the page, the dock stays a rail", { viewport: { width: 44, height: 936 }, shim: { layout: { left: 1 } } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("the rail", () => document.body.dataset.dock === "rail");
  assert.equal(await inPage(() => document.getElementById("nav-activity").title), "Activity");
  await ctx.page.click("#nav-activity");
  await until("an activity tab", () => window.__pairbrowse.calls.some((c) => c.iface === "tabs" && c.method === "create"));
  assert.deepEqual((await calls(ctx, "tabs", "create")).map((c) => c.args), [["pairbrowse://activity", true, 1]]);
  assert.equal((await calls(ctx, "layout", "set")).length, 0, "no dock change");
  assert.equal(ctx.helper.posts.some((p) => p.route === "layout"), false);
  assert.equal(await inPage(() => document.body.dataset.dock), "rail");
  await clean(ctx);
});

// Served without the browser's API: the activity page's file in a new tab.
scenario("left: Activity served without the browser's API", { viewport: OPEN, native: false }, async (ctx) => {
  const { page, inPage } = ctx;
  assert.equal(await inPage(() => document.getElementById("nav-activity").disabled), false);
  const opened = page.context().waitForEvent("page");
  await page.click("#nav-activity");
  const tab = await opened;
  await tab.waitForLoadState("load");
  assert.match(tab.url(), /\/activity\/index\.html$/);
  await tab.close();
  await clean(ctx);
});

scenario("left: shared with", { viewport: OPEN, fixtures: { collaboration: { guests: [{ label: "Dana", role: "drive" }, { label: "Dana", role: "drive" }, { label: "Eve", role: "watch" }] } } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("guests", () => document.querySelectorAll("#guests li").length === 2);
  assert.equal(await inPage(() => document.getElementById("shared").checkVisibility()), true);
  assert.equal(await inPage(() => document.getElementById("guests-empty").hidden), true, "no empty line with guests");
  const got = await inPage(() => [...document.querySelectorAll("#guests li")].map((li) => ({
    text: `${li.querySelector("strong").textContent} · ${li.querySelector("small").textContent}`, icon: !!li.querySelector(".avatar.guest svg use"),
    filled: !li.querySelector(".avatar.plain") && !["rgba(0, 0, 0, 0)", "rgb(25, 42, 61)"].includes(getComputedStyle(li.querySelector(".avatar")).backgroundColor), // not clear, not --elevated
    ink: getComputedStyle(li.querySelector(".avatar svg")).color, // --bg: dark ink
    size: li.querySelector(".avatar").getBoundingClientRect().width, title: li.title, sr: li.querySelector(".sr")?.textContent, srHidden: (li.querySelector(".sr")?.getBoundingClientRect().width ?? 9) <= 1,
  })));
  assert.deepEqual(got, [
    // neutral group circles with the icon in --ink when the helper sends no color (the mockup's Team row)
    { text: "Dana · 2 online", icon: true, filled: false, ink: "rgb(241, 245, 250)", size: 36, title: "Dana · 2 online · can drive", sr: ", can drive", srHidden: true },
    { text: "Eve · 1 online", icon: true, filled: false, ink: "rgb(241, 245, 250)", size: 36, title: "Eve · 1 online · watching", sr: ", watching", srHidden: true },
  ], "'N online' on screen; the role in the title and, for readers, in words");
  ctx.helper.set("collaboration", { guests: [] });
  await until("not shared", () => document.querySelectorAll("#guests li").length === 0 && !document.getElementById("guests-empty").hidden);
  assert.equal(await inPage(() => document.getElementById("shared").checkVisibility()), true, "the section stays");
  // One trigger (DESIGN.md Part G): the strip's Share; the note says where it is, and no "+" here.
  assert.equal(await inPage(() => document.getElementById("guests-empty").textContent), "Not shared yet: use Share at the top");
  assert.equal(await inPage(() => !!document.getElementById("share-add") || !!document.querySelector("#shared .add")), false, "no + beside Shared with");
  await clean(ctx);
});

scenario("left: no Storage row (Pro only), even when the session event carries diskBytes", { viewport: OPEN }, async (ctx) => {
  const { inPage } = ctx;
  const none = () => ["storage", "storage-bar", "storage-text"].every((id) => !document.getElementById(id));
  assert.equal(await inPage(none), true);
  ctx.helper.push("session", { name: "default", where: "Local", diskBytes: 2576980378 });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await inPage(none), true, "still none");
  assert.equal(await inPage(() => [...document.querySelectorAll("body *")].some((n) => n.children.length === 0 && /GB/.test(n.textContent))), false, "no figure anywhere");
  await clean(ctx);
});

scenario("left: the Storage row when the session event carries storage (Pro's figure), gone without it", { viewport: OPEN }, async (ctx) => {
  const { until, inPage } = ctx;
  ctx.helper.push("session", { name: "default", where: "Local", storage: { used: 2400000000, limit: 10000000000 } });
  await until("the row", () => !!document.getElementById("storage"));
  const row = await inPage(() => {
    const bar = document.querySelector("#storage .bar");
    return { text: document.getElementById("storage-text").textContent, label: bar.getAttribute("aria-label"), role: bar.getAttribute("role"),
      fill: Math.round(document.getElementById("storage-bar").getBoundingClientRect().width / bar.getBoundingClientRect().width * 100), beforeGear: document.getElementById("storage").nextElementSibling?.querySelector("#settings")?.id };
  });
  assert.deepEqual(row, { text: "2.4 GB / 10 GB", label: "2.4 GB of 10 GB used", role: "img", fill: 24, beforeGear: "settings" });
  ctx.helper.push("session", { name: "default", where: "Local" });
  await until("no row", () => !document.getElementById("storage"));
  await clean(ctx);
});

// Share is the strip's (DESIGN.md Part G) and its card opens under it, at the top of the agent panel
// (Part I): nothing of it opens here, whoever asks; the section keeps its line.
scenario("left: Shared with: no Share card here", { viewport: OPEN }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("live", () => document.body.dataset.s === "live");
  await inPage(() => new Promise((r) => setTimeout(r, 100))); // windows.list has answered
  assert.equal(await inPage(() => !!document.getElementById("share-card") || !!document.getElementById("share-add")), false, "no card and no + of its own");
  await inPage(() => { window.__heard = []; const ch = new BroadcastChannel("pairbrowse-share"); ch.onmessage = (e) => window.__heard.push(e.data); ch.postMessage({ open: "share", window: 1 }); window.__strip = ch; });
  await inPage(() => new Promise((r) => setTimeout(r, 200)));
  assert.deepEqual(await inPage(() => (window.__strip.close(), window.__heard)), [], "the agent panel answers Share, not this dock");
  assert.equal(await inPage(() => document.querySelector("dialog, [role=dialog]:not([hidden])")), null);
  await clean(ctx);
});

scenario("left: keyboard", { viewport: OPEN, shim: { layout: { right: 1 } } }, async (ctx) => {
  const { until, inPage } = ctx;
  await inPage(() => { document.activeElement?.blur?.(); document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex"); });
  const order = [];
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  for (let i = 0; i < 7; i++) { await ctx.page.keyboard.press("Tab"); order.push(await inPage(() => document.activeElement.id)); }
  // Share is the strip's (DESIGN.md Part G) and Tools the agent panel's tab (Part I): neither is a
  // stop; the collapse chevron sits at the foot after the gear (2026-10-14).
  assert.deepEqual(order, ["nav-browser", "nav-sessions", "nav-history", "nav-activity", "add-agent", "settings", "dock-collapse"]);
  await ctx.page.focus("#nav-sessions");
  await ctx.page.keyboard.press("Enter");
  // In the browser the Sessions row opens the sessions page as a tab (a page of its own reaches
  // the helper; a frame here gets no bindings): no frame, no picker route.
  await until("the sessions tab", () => window.__pairbrowse.calls.some((c) => c.iface === "tabs" && c.method === "create" && c.args[0] === "pairbrowse://sessions"));
  assert.deepEqual(await inPage(() => ({ hidden: document.getElementById("switcher").hidden, src: document.getElementById("picker").getAttribute("src"), focus: document.activeElement?.id })),
    { hidden: true, src: null, focus: "nav-sessions" });
  assert.equal(await pickerFramesGone(ctx.page), 0);
  assert.equal(ctx.helper.posts.some((p) => p.route === "picker"), false, "no picker route");
  await ctx.page.focus("#add-agent");
  await ctx.page.keyboard.press("Enter");
  await until("the hint", () => !document.getElementById("hint").hidden && document.getElementById("add-agent").getAttribute("aria-expanded") === "true");
  await ctx.page.keyboard.press("Escape");
  await until("hint closed", () => document.getElementById("hint").hidden && document.activeElement?.id === "add-agent");
  await ctx.page.click("#add-agent");
  await until("the hint again", () => !document.getElementById("hint").hidden);
  await ctx.page.mouse.click(100, 20);
  await until("closed by a click outside", () => document.getElementById("hint").hidden);
  assert.equal(await inPage(() => document.querySelectorAll("#hint code").length), 4);
  assert.deepEqual(await calls(ctx, "layout", "set"), [], "nothing here opens or moves another dock");
  await clean(ctx);
});

// The framed switcher: served without the browser's API (a plain browser, where the frame reads the
// extension's storage for the helper's address). In the browser the row opens the browser's bubble
// (below).
scenario("left: the session switcher", { viewport: { width: 420, height: 936 }, native: false, fixtures: { sessions: SWITCHER_SESSIONS } }, async (ctx) => {
  const { page, until, inPage, helper, settle } = ctx;
  const live = await ctx.harness.live();
  const state = () => ({ hidden: document.getElementById("switcher").hidden, src: document.getElementById("picker").getAttribute("src"), focus: document.activeElement?.id || "" });
  // The Sessions row is the one door (2026-10-14): no header, and the strip's logo is a brand mark.
  assert.equal(await inPage(() => document.getElementById("workspace")), null);
  await until("the layout", () => document.body.dataset.dock === "open");
  await page.click("#nav-sessions");
  await settle();
  const box = await inPage(() => {
    const d = document.getElementById("switcher"), r = d.getBoundingClientRect();
    return { role: d.getAttribute("role"), label: d.getAttribute("aria-label"), left: r.left, top: r.top, width: r.width, height: r.height,
      shadow: getComputedStyle(d).boxShadow, expanded: document.getElementById("nav-sessions").getAttribute("aria-expanded"),
      caret: d.style.getPropertyValue("--caret-x"), icon: document.querySelector("#nav-sessions .ic").getBoundingClientRect().left, row: document.getElementById("nav-sessions").getBoundingClientRect().bottom };
  });
  assert.equal(box.role, "dialog");
  assert.equal(box.label, "Switch session");
  // At its trigger (DESIGN.md Part I): it hangs 8 px under the Sessions row, its caret at the row's
  // icon.
  assert.deepEqual([box.left, box.top, box.width, box.height], [8, box.row + 8, 360, 560]);
  assert.equal(box.caret, `${box.icon}px`);
  assert.match(box.shadow, /rgb\(41, 59, 80\)/, "the 1 px edge ring");
  assert.equal(box.expanded, "true");
  const frame = await framedPicker(page, "ready");
  assert.equal(await inFrame(frame, () => window.innerWidth), 360);
  // A pick: the picker's "picked" notice closes the switcher, focus back on the row that opened it.
  await clickInFrame(page, frame, "#sessions > li:first-child button");
  for (let i = 0; i < 60 && !helper.posts.some((p) => p.route === "pick"); i++) await page.waitForTimeout(50);
  assert.deepEqual(helper.posts.filter((p) => p.route === "pick").map((p) => p.body), [{ action: "use", name: "work" }]);
  // The frame unloads once the switcher has faded out (DESIGN.md Part I).
  await until("closed after the pick", () => document.getElementById("switcher").hidden && document.activeElement?.id === "nav-sessions" && document.getElementById("picker").getAttribute("src") === null);
  assert.deepEqual(await inPage(state), { hidden: true, src: null, focus: "nav-sessions" });
  assert.equal(await pickerFramesGone(page), 0, "the picker unloaded");
  // Again; a click outside closes it without moving focus there.
  await page.click("#nav-sessions");
  assert.equal(await inPage(() => document.getElementById("nav-sessions").getAttribute("aria-expanded")), "true");
  await framedPicker(page);
  await page.mouse.click(100, 700);
  await until("closed by a click outside", () => document.getElementById("switcher").hidden);
  assert.notEqual((await inPage(state)).focus, "nav-sessions");
  assert.equal(await inPage(() => document.getElementById("nav-sessions").getAttribute("aria-expanded")), "false");
  // Hiding the dock closes and unloads it.
  await page.click("#nav-sessions");
  await framedPicker(page);
  helper.push("layout", { left: "hidden", right: "open", strip: 88 });
  await until("hidden", () => document.body.dataset.dock === "hidden" && document.getElementById("switcher").hidden && document.getElementById("picker").getAttribute("src") === null);
  assert.equal(await pickerFramesGone(page), 0);
  // The rail's Sessions row opens the dock first (44 px leaves the switcher no room), then the
  // switcher (Part H); Escape closes it.
  helper.push("layout", { left: "rail", right: "open", strip: 88 });
  await until("the rail", () => document.body.dataset.dock === "rail");
  await page.click("#nav-sessions");
  for (let i = 0; i < 60 && !helper.posts.some((p) => p.route === "layout" && p.body?.left === "open"); i++) await page.waitForTimeout(50);
  assert.ok(helper.posts.some((p) => p.route === "layout" && p.body?.left === "open"), "the rail asked the dock open");
  helper.push("layout", { left: "open", right: "open", strip: 88 });
  await until("the dock opened", () => document.body.dataset.dock === "open");
  await framedPicker(page, "ready");
  await page.keyboard.press("Escape");
  await until("closed by Escape", () => document.getElementById("switcher").hidden && document.activeElement?.id === "nav-sessions");
  assert.equal(helper.posts.some((p) => p.route === "picker"), false, "no picker route at any point");
  assert.deepEqual(await ctx.harness.live(), live, "nothing new runs once it is closed");
  await clean(ctx);
});

// Agents at work: the switcher (the picker in its dock slot frame, where confirm() gets no
// dialog) asks in its own card, naming them; the switcher stays open on Cancel, and Switch anyway
// resends the pick with confirm: true and closes it.
scenario("left: the switcher asks while agents are at work", { viewport: { width: 420, height: 936 }, native: false, fixtures: { sessions: SWITCHER_SESSIONS, agents: ["Claude", "Codex"] } }, async (ctx) => {
  const { page, until, helper } = ctx;
  await page.click("#nav-sessions");
  const frame = await framedPicker(page, "ready");
  await clickInFrame(page, frame, "#sessions > li:nth-child(2) button");
  let q = null;
  for (let i = 0; i < 60 && !q; i++) { q = await inFrame(frame, () => (document.getElementById("switch-ask").hidden ? null : document.querySelector("#switch-ask strong").textContent)); if (!q) await page.waitForTimeout(50); }
  assert.equal(q, "Claude and Codex are using the browser. Switching closes every tab for them. Switch anyway?");
  assert.deepEqual(helper.posts.filter((p) => p.route === "pick").map((p) => p.body), [{ action: "use", name: "shop" }]);
  assert.equal(await inFrame(page, () => document.getElementById("switcher").hidden), false, "the switcher stays open on the question");
  await clickInFrame(page, frame, "#switch-ask .secondary");
  for (let i = 0; i < 40 && (await inFrame(frame, () => document.getElementById("msg").textContent)) !== "Not switched."; i++) await page.waitForTimeout(50);
  assert.equal(await inFrame(frame, () => document.getElementById("msg").textContent), "Not switched.");
  assert.equal(await inFrame(page, () => document.getElementById("switcher").hidden), false, "Cancel keeps the switcher");
  await clickInFrame(page, frame, "#sessions > li:nth-child(2) button");
  for (let i = 0; i < 60 && (await inFrame(frame, () => document.getElementById("switch-ask").hidden)); i++) await page.waitForTimeout(50);
  await clickInFrame(page, frame, "#switch-ask .primary");
  await until("closed after the switch", () => document.getElementById("switcher").hidden);
  assert.deepEqual(helper.posts.filter((p) => p.route === "pick").map((p) => p.body),
    [{ action: "use", name: "shop" }, { action: "use", name: "shop" }, { action: "use", name: "shop", confirm: true }]);
  await clean(ctx);
});

scenario("left: the session switcher under reduced motion", { viewport: { width: 420, height: 936 }, native: false, reducedMotion: "reduce", fixtures: { sessions: SWITCHER_SESSIONS } }, async (ctx) => {
  await ctx.page.click("#nav-sessions");
  await framedPicker(ctx.page, "ready");
  // Instant: no transition opens it, nothing runs, and closing unloads the picker at once.
  assert.deepEqual(await ctx.inPage(() => { const s = getComputedStyle(document.getElementById("switcher")); return [s.animationName, s.transitionDuration, s.opacity]; }), ["none", "0s", "1"]);
  assert.deepEqual(await ctx.harness.animations(), []);
  await ctx.page.keyboard.press("Escape");
  // The frame's Escape reaches the dock as a message (a task of its own): closed and unloaded at once
  // when it lands, with no fade in between.
  await ctx.until("closed and unloaded", () => document.getElementById("switcher").hidden);
  assert.deepEqual(await ctx.inPage(() => [document.getElementById("switcher").hidden, document.getElementById("picker").getAttribute("src"), document.activeElement?.id]), [true, null, "nav-sessions"]);
  await clean(ctx);
});

scenario("left: rail at 44 px", { viewport: { width: 44, height: 936 }, shim: { layout: { left: 1 } }, fixtures: { board: BOARD, session: { name: "work", where: "Local" } } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("the rail", () => document.body.dataset.dock === "rail");
  await until("the agents", () => document.querySelectorAll("#agents li[data-state]").length === 3);
  const seen = await inPage(() => ({
    labels: [...document.querySelectorAll(".label, .current, .badge, h2, .add, .hint, .conn, #storage, .empty-note, .share-card")].filter((n) => n.checkVisibility()).length,
    clipped: [...document.querySelectorAll(".people strong, .people small")].map((n) => n.getBoundingClientRect().width <= 1),
    width: document.documentElement.scrollWidth,
    gear: document.getElementById("settings").checkVisibility(),
    avatars: [...document.querySelectorAll("#agents .avatar")].map((a) => [a.checkVisibility(), a.querySelector(".dot").checkVisibility(), a.getBoundingClientRect().width]),
    titles: [...document.querySelectorAll("#agents li")].map((li) => li.title),
    rows: [...document.querySelectorAll(".nav .row")].map((r) => r.title),
    expand: (() => { const b = document.getElementById("dock-expand"), r = b.getBoundingClientRect(), g = document.getElementById("settings").getBoundingClientRect(); return { shown: b.checkVisibility(), width: r.width, left: r.left, underGear: r.top >= g.bottom, gearLeft: g.left, inView: r.bottom <= innerHeight }; })(),
    collapse: document.getElementById("dock-collapse").checkVisibility(),
    sessions: (() => { const r = document.getElementById("nav-sessions"); return { shown: r.checkVisibility(), name: r.querySelector(".current").textContent, words: r.textContent }; })(),
  }));
  // The foot: the gear, the expand chevron under it, both --ctl-sm and centred in the 44 px rail.
  assert.deepEqual(seen.expand, { shown: true, width: 28, left: 8, underGear: true, gearLeft: 8, inView: true });
  assert.equal(seen.collapse, false);
  assert.deepEqual(seen.sessions, { shown: true, name: "work", words: "Sessionswork, work" }, "the icon, the name in words for readers");
  assert.equal(seen.labels, 0);
  assert.ok(seen.clipped.length > 0 && seen.clipped.every(Boolean), "names and states clipped, not removed");
  assert.ok(seen.width <= 44, `scrollWidth ${seen.width}`);
  assert.equal(seen.gear, true);
  assert.deepEqual(seen.avatars, [[true, true, 28], [true, true, 28], [true, true, 28]]);
  assert.deepEqual(seen.titles, ["Claude · Working · 1 tab", "Alice · Codex · Waiting for you", "You · Online"]);
  assert.deepEqual(seen.rows, ["Browser · 3 open tabs", "Sessions · work", "History", "Activity"]);
  await clean(ctx);
});

scenario("left: reduced motion", { viewport: OPEN, reducedMotion: "reduce" }, async (ctx) => {
  await ctx.shim.layout({ left: 1 });
  await ctx.until("the rail", () => document.body.dataset.dock === "rail");
  await ctx.page.hover("#nav-browser");
  await ctx.page.waitForTimeout(50);
  assert.deepEqual(await ctx.harness.animations(), []);
  await ctx.until("the expand button", () => document.getElementById("dock-expand").checkVisibility());
  await ctx.page.hover("#dock-expand");
  await ctx.page.waitForTimeout(50);
  assert.equal(await ctx.inPage(() => getComputedStyle(document.getElementById("dock-expand")).transitionDuration), "0s");
  assert.deepEqual(await ctx.harness.animations(), []);
  await clean(ctx);
});

// The browser narrows the dock to a rail as the window narrows, and opens it again as it widens
// (native 565), with no click: a focused control the new state no longer shows hands the focus to
// the dock's own button, and nothing is asked of the layout.
scenario("left: the window narrows and widens the dock with the focus in it", { viewport: OPEN }, async (ctx) => {
  const { until, inPage, page } = ctx;
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  await page.focus("#dock-collapse");
  await ctx.shim.layout({ left: 1 });
  await until("the rail, focus on expand", () => document.body.dataset.dock === "rail" && document.activeElement?.id === "dock-expand");
  await ctx.shim.layout({ left: 2 });
  await until("open, focus on collapse", () => document.body.dataset.dock === "open" && document.activeElement?.id === "dock-collapse");
  // A control both states show keeps the focus.
  await page.focus("#nav-browser");
  await ctx.shim.layout({ left: 1 });
  await until("the rail", () => document.body.dataset.dock === "rail");
  assert.equal(await inPage(() => document.activeElement?.id), "nav-browser");
  // Focus nowhere in the dock: none is taken.
  await inPage(() => document.activeElement.blur());
  await ctx.shim.layout({ left: 2 });
  await until("open", () => document.body.dataset.dock === "open");
  assert.equal(await inPage(() => document.activeElement === document.body), true);
  assert.deepEqual(await calls(ctx, "layout", "set"), []);
  await clean(ctx);
});

scenario("left: collapse and expand", { viewport: OPEN }, async (ctx) => {
  const { until, inPage, page } = ctx;
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  const box = await inPage(() => {
    const b = document.getElementById("dock-collapse"), r = b.getBoundingClientRect();
    return { width: r.width, height: r.height, right: r.right, label: b.getAttribute("aria-label"), expanded: b.getAttribute("aria-expanded"), expand: document.getElementById("dock-expand").checkVisibility() };
  });
  // --ctl-sm at the foot, beside the gear (2026-10-14), its right edge on the sections' "+" (20 px in
  // from the dock's inner edge), on the gear's line.
  assert.deepEqual(box, { width: 28, height: 28, right: 180, label: "Collapse the workspace", expanded: "true", expand: false });
  assert.equal(await inPage(() => document.querySelector("#add-agent").getBoundingClientRect().right), 180, "the + on the same right edge");
  assert.deepEqual(await inPage(() => { const g = document.getElementById("settings").getBoundingClientRect(), c = document.getElementById("dock-collapse").getBoundingClientRect(); return [c.top === g.top, !!document.getElementById("dock-collapse").closest(".foot"), g.left]; }), [true, true, 20]);
  // Hover: --hover under --ink, over the 120 ms transition.
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("dock-collapse")).transitionDuration), "0.12s, 0.12s");
  await page.hover("#dock-collapse");
  await until("the hover colors", () => { const cs = getComputedStyle(document.getElementById("dock-collapse")); const t = (n) => { const s = document.createElement("span"); s.style.color = `var(${n})`; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; }; return cs.backgroundColor === t("--hover") && cs.color === t("--ink"); });
  await page.mouse.move(100, 600);
  const live = await ctx.harness.live();
  const fixture = await inPage(() => ({ ...window.__pairbrowse.fixture.layout }));
  await page.focus("#dock-collapse");
  await page.keyboard.press("Enter");
  await until("the rail, focus on expand", () => document.body.dataset.dock === "rail" && document.activeElement?.id === "dock-expand");
  const sets = await calls(ctx, "layout", "set");
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].args[0], { ...fixture, left: 1 });
  const expand = await inPage(() => {
    const b = document.getElementById("dock-expand"), cs = getComputedStyle(b);
    return { label: b.getAttribute("aria-label"), expanded: b.getAttribute("aria-expanded"), top: b.getBoundingClientRect().top, collapse: document.getElementById("dock-collapse").checkVisibility(),
      ring: [cs.outlineStyle, cs.outlineWidth, cs.outlineOffset, cs.outlineColor] };
  });
  assert.deepEqual(expand.ring, ["solid", "2px", "2px", await inPage(token, "--accent")], "the 2 px accent focus ring");
  delete expand.ring;
  assert.ok(expand.top > 800, `the expand chevron at the rail's foot (${expand.top})`);
  delete expand.top;
  assert.deepEqual(expand, { label: "Expand the workspace", expanded: "false", collapse: false });
  await page.keyboard.press("Enter");
  await until("open, focus on collapse", () => document.body.dataset.dock === "open" && document.activeElement?.id === "dock-collapse");
  const all = await calls(ctx, "layout", "set");
  assert.equal(all.length, 2);
  assert.equal(all[1].args[0].left, 2);
  assert.ok(all.every((c) => c.args[0].left !== 0 && c.args[0].right !== 0), "no button hides a dock");
  assert.deepEqual(await ctx.harness.live(), live, "nothing new runs after the round trip");
  await clean(ctx);
});

scenario("left: collapse and expand over the helper's route", { viewport: OPEN, native: false }, async (ctx) => {
  const { until, inPage, page, helper } = ctx;
  assert.equal(await inPage(() => typeof window.pairbrowse), "undefined");
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  await page.click("#dock-collapse");
  await until("the rail, focus on expand", () => document.body.dataset.dock === "rail" && document.activeElement?.id === "dock-expand");
  assert.deepEqual(helper.posts.filter((p) => p.route === "layout").map((p) => p.body), [{ left: "rail" }]);
  await page.click("#dock-expand");
  await until("open, focus on collapse", () => document.body.dataset.dock === "open" && document.activeElement?.id === "dock-collapse");
  assert.deepEqual(helper.posts.filter((p) => p.route === "layout").map((p) => p.body), [{ left: "rail" }, { left: "open" }]);
  await clean(ctx);
});

scenario("left: a failed collapse takes no focus later", { viewport: OPEN, native: false, replies: { layout: () => ({ status: 500, body: { error: "no" } }) } }, async (ctx) => {
  const { until, inPage, page, helper } = ctx;
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/layout"));
  await page.click("#dock-collapse");
  assert.equal((await answered).status(), 500);
  assert.equal(await inPage(() => document.body.dataset.dock), "open", "a refused collapse leaves the dock open");
  // The focus leaves the collapse button first: one that is still focused when the dock becomes a
  // rail hands it to the expand button (the window's narrowing, native 565), which is not this.
  await inPage(() => document.activeElement.blur());
  helper.set("layout", { left: "rail", right: "open", strip: 88 });
  await until("the rail", () => document.body.dataset.dock === "rail");
  assert.notEqual(await inPage(() => document.activeElement?.id), "dock-expand", "a later rail never pulls focus onto the expand button");
  await clean(ctx);
});

scenario("left: no dock button before the layout is known", { viewport: OPEN, native: false, fixtures: { layout: null } }, async (ctx) => {
  const { until, inPage, helper } = ctx;
  await until("live", () => document.body.dataset.s === "live");
  assert.deepEqual(await inPage(() => ["dock-collapse", "dock-expand"].map((id) => document.getElementById(id).hidden)), [true, true]);
  helper.set("layout", { left: "open", right: "open", strip: 88 });
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  assert.equal(await inPage(() => document.getElementById("dock-expand").hidden), true);
  await clean(ctx);
});

// No browser API and no extension storage: nobody to connect to. The state shows once (the
// strip's pill says Local, the right dock says what to do), so no connection line here.
scenario("left: no API and no storage shows no connection line", { viewport: OPEN, native: false, bridge: false }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("closed", () => document.body.dataset.s === "closed");
  assert.equal(await inPage(() => document.getElementById("conn").checkVisibility()), false, "no connection line");
  assert.equal(await inPage(() => document.body.textContent.includes("Not connected")), false);
  // The Agents section: only its label and its + button.
  assert.deepEqual(await inPage(() => [...document.querySelector('section[aria-labelledby="agents-h"]').children].filter((e) => e.checkVisibility() && e.getBoundingClientRect().height > 0).map((e) => e.className)), ["sec-head"]);
  assert.deepEqual(await inPage(() => ["agents-h", "add-agent"].map((id) => document.getElementById(id).checkVisibility())), [true, true]);
  assert.equal(await inPage(() => document.documentElement.dataset.host), "extension");
  // Nothing claimed about agents or sharing without a helper.
  const shown = (t) => [...document.querySelectorAll("#agents li, #guests-empty")].some((e) => e.textContent === t && e.checkVisibility());
  assert.equal(await inPage(shown, "No agent yet"), false);
  assert.equal(await inPage(shown, "Not shared yet"), false);
  assert.deepEqual(ctx.errors, []);
});

// The strip's logo opens its own switcher (the browser's bubble, or the picker as a tab): it no
// longer asks this dock over the pairbrowse-share channel, and an ask there opens nothing.
scenario("left: the logo's old ask opens nothing here", { viewport: { width: 420, height: 936 }, fixtures: { sessions: SWITCHER_SESSIONS } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("live", () => document.body.dataset.s === "live");
  await inPage(() => new Promise((r) => setTimeout(r, 100))); // windows.list has answered
  await inPage(() => { window.__heard = []; const ch = new BroadcastChannel("pairbrowse-share"); ch.onmessage = (e) => window.__heard.push(e.data); ch.postMessage({ open: "switch", window: 1 }); window.__strip = ch; });
  await inPage(() => new Promise((r) => setTimeout(r, 200)));
  assert.equal(await inPage(() => document.getElementById("switcher").hidden), true);
  assert.equal(await pickerFramesGone(ctx.page), 0);
  assert.deepEqual(await inPage(() => (window.__strip.close(), window.__heard)), []);
  await clean(ctx);
});

// In the browser the strip's pill says the connection (Local, Live session, Reconnecting): the
// dock shows no connection line, connecting or not (DESIGN.md Part G).
scenario("left: no connection line in the browser", { viewport: OPEN, fixtures: { board: BOARD } }, async (ctx) => {
  const { until, inPage } = ctx;
  assert.equal(await inPage(() => document.documentElement.dataset.host), "native");
  assert.equal(await inPage(() => document.getElementById("conn").checkVisibility()), false, "none while it connects or once live");
  await until("live", () => document.body.dataset.s === "live");
  assert.equal(await inPage(() => document.getElementById("conn").checkVisibility()), false);
  await clean(ctx);
});

// ---- no helper: the switcher opens on the picker's resting state, never its question ----
// DESIGN.md B3/B4: no agent waits, so no "Which session?" and no "Your agent waits…", and an
// absent helper is not an error (nothing in red). The dock tells the frame by its address only
// (#none: no key, no name). Served without the browser's API (the framed switcher's host).
const NO_AGENT_FRAME = () => {
  const probe = (v) => { const i = document.createElement("i"); i.style.color = `var(--${v})`; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; };
  const reds = [probe("bad"), probe("bad-ink")];
  return {
    hash: location.hash, s: document.body.dataset.s, title: document.getElementById("title").textContent, sub: document.getElementById("sub").textContent,
    list: document.getElementById("choices").checkVisibility(), msg: document.getElementById("msg").textContent,
    red: [...document.querySelectorAll("body *")].filter((e) => e.checkVisibility() && e.textContent.trim() && reds.includes(getComputedStyle(e).color)).map((e) => e.id || e.className),
    question: document.body.textContent.includes("Which session?") || document.body.textContent.includes("Your agent waits"),
  };
};
const RESTING_FRAME = { hash: "#none", s: "none", title: "No agent connected", sub: "Ask Claude Code, Codex or Grok to use PairBrowse. Your sessions show here.", list: false, msg: "", red: [], question: false };

scenario("left: no helper, the switcher at rest", { viewport: { width: 420, height: 936 }, native: false, bridge: false, fixtures: { sessions: SWITCHER_SESSIONS } }, async (ctx) => {
  const { page, until, inPage, helper } = ctx;
  await until("no helper", () => document.body.dataset.s === "closed");
  await page.click("#nav-sessions");
  const frame = await framedPicker(page, "none");
  assert.deepEqual(await inFrame(frame, NO_AGENT_FRAME), RESTING_FRAME);
  assert.equal((await inFrame(frame, () => window.__harness.live())).intervals, 0, "the frame refreshes nothing");
  assert.deepEqual(helper.gets, [], "nothing asked of a helper");
  // The Agents section keeps only its label and its + (B3): no wait, no error line.
  assert.deepEqual(await inPage(() => ({ conn: document.getElementById("conn").checkVisibility(), empty: document.querySelector("#agents li.empty")?.checkVisibility() ?? false })), { conn: false, empty: false });
  await clean(ctx);
});

scenario("left: a helper that never answers, then does", { viewport: { width: 420, height: 936 }, native: false, fixtures: { sessions: SWITCHER_SESSIONS }, down: true, timeout: 90_000 }, async (ctx) => {
  const { page, until, inPage, helper } = ctx;
  await page.click("#nav-sessions");
  let frame = await framedPicker(page, "none");
  assert.deepEqual(await inFrame(frame, NO_AGENT_FRAME), RESTING_FRAME);
  await page.keyboard.press("Escape");
  await until("closed", () => document.getElementById("switcher").hidden);
  // The helper comes up: the dock's stream opens on its own (EventSource's own retry, no poll of
  // the page's), and the switcher then opens on the list.
  helper.setDown(false);
  for (let i = 0; i < 160 && (await inPage(() => document.body.dataset.s)) !== "live"; i++) await page.waitForTimeout(50);
  assert.equal(await inPage(() => document.body.dataset.s), "live");
  await until("the frame unloaded", () => document.getElementById("picker").getAttribute("src") === null);
  await page.click("#nav-sessions");
  frame = await framedPicker(page, "ready");
  assert.deepEqual(await inFrame(frame, () => ({ hash: location.hash, title: document.getElementById("title").textContent, sub: document.getElementById("sub").textContent, rows: document.querySelectorAll("#sessions > li").length })),
    { hash: "", title: "Which session?", sub: "Switch to another session, or start one.", rows: 3 });
  await clean(ctx);
});
// ---- in the browser: the Sessions row opens the sessions page in the contents (2026-10-14) ----
// A page rather than a popup (the user's choice), as History and Activity: found or opened in this
// dock's window, current while shown, from the open dock and the rail alike; no bubble, no frame.
scenario("left: the Sessions row opens the sessions page", { viewport: OPEN, shim: { bubbles: true } }, async (ctx) => {
  const { page, until, inPage } = ctx;
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  assert.deepEqual(await inPage(() => ["aria-haspopup", "aria-controls", "aria-expanded"].map((a) => document.getElementById("nav-sessions").hasAttribute(a))), [false, false, false]);
  await page.click("#nav-sessions");
  await until("a sessions tab", () => window.__pairbrowse.calls.some((c) => c.iface === "tabs" && c.method === "create"));
  assert.deepEqual((await calls(ctx, "tabs", "create")).map((c) => c.args), [["pairbrowse://sessions", true, 1]], "in this dock's window");
  assert.deepEqual(await calls(ctx, "bubbles", "open"), [], "no popup");
  assert.deepEqual(await inPage(() => [document.getElementById("switcher").hidden, document.getElementById("picker").getAttribute("src")]), [true, null], "no frame");
  assert.equal(await pickerFramesGone(page), 0);
  await until("Sessions current", () => document.getElementById("nav-sessions").getAttribute("aria-current") === "page" && !document.getElementById("nav-browser").hasAttribute("aria-current"));
  const sessionsId = await inPage(() => window.__pairbrowse.fixture.tabs.find((t) => t.url === "pairbrowse://sessions").id);
  // Browser brings the last web tab back; Sessions again brings the open page forward, no second one.
  await page.click("#nav-browser");
  await until("Browser current", () => document.getElementById("nav-browser").getAttribute("aria-current") === "page" && !document.getElementById("nav-sessions").hasAttribute("aria-current"));
  await page.click("#nav-sessions");
  await until("Sessions again", () => document.getElementById("nav-sessions").getAttribute("aria-current") === "page");
  assert.deepEqual((await calls(ctx, "tabs", "activate")).at(-1).args, [sessionsId]);
  assert.equal((await calls(ctx, "tabs", "create")).length, 1, "no second sessions tab");
  assert.equal((await calls(ctx, "layout", "set")).length, 0, "the dock's state stays");
  await clean(ctx);
});

scenario("left: Sessions from the rail opens the page, the dock stays a rail", { viewport: { width: 44, height: 936 }, shim: { layout: { left: 1 }, bubbles: true } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("the rail", () => document.body.dataset.dock === "rail");
  await ctx.page.click("#nav-sessions");
  await until("a sessions tab", () => window.__pairbrowse.calls.some((c) => c.iface === "tabs" && c.method === "create"));
  assert.deepEqual((await calls(ctx, "tabs", "create")).map((c) => c.args), [["pairbrowse://sessions", true, 1]]);
  assert.deepEqual(await calls(ctx, "bubbles", "open"), [], "no popup");
  assert.equal((await calls(ctx, "layout", "set")).length, 0, "no dock change");
  assert.equal(await inPage(() => document.body.dataset.dock), "rail");
  await clean(ctx);
});


// ---- the Sessions row names the open session (2026-10-14), live from the helper's session event ----
const sessionRow = () => {
  const row = document.getElementById("nav-sessions"), cur = row.querySelector(".current"), label = row.querySelector(".label");
  const s = getComputedStyle(cur);
  return { name: cur.textContent, shown: cur.checkVisibility(), words: document.getElementById("session-words").textContent, temporary: cur.hasAttribute("data-temporary"),
    cut: cur.scrollWidth > cur.clientWidth, ellipsis: s.textOverflow, muted: s.color, label: label.scrollWidth <= label.clientWidth, right: Math.round(row.getBoundingClientRect().right - cur.getBoundingClientRect().right) };
};
scenario("left: the Sessions row shows the open session", { viewport: OPEN, fixtures: { session: { name: "default", where: "Local" } } }, async (ctx) => {
  const { until, inPage, helper } = ctx;
  await until("Default", () => document.querySelector("#nav-sessions .current").textContent === "Default");
  let r = await inPage(sessionRow);
  assert.deepEqual({ name: r.name, shown: r.shown, words: r.words, temporary: r.temporary, right: r.right }, { name: "Default", shown: true, words: ", Default", temporary: false, right: 12 }, "at the row's end, where Browser has its count");
  assert.equal(r.muted, await inPage(token, "--muted"), "muted");
  assert.match(await ctx.page.locator("#nav-sessions").ariaSnapshot(), /Sessions ?, Default/, "the row's name says the session");
  assert.equal(await inPage(() => document.getElementById("nav-sessions").hasAttribute("title")), false, "no tooltip in the open dock");
  // A switch: the name follows the helper's event, no polling.
  helper.push("session", { name: "quarterly-planning-research", where: "Local" });
  await until("the new name", () => document.querySelector("#nav-sessions .current").textContent === "quarterly-planning-research");
  r = await inPage(sessionRow);
  assert.deepEqual([r.cut, r.ellipsis, r.label], [true, "ellipsis", true], "a long name is cut with an ellipsis, Sessions never");
  // A fresh (temporary) session is marked as such.
  helper.push("session", { name: "Clean session", where: "Local", temporary: true });
  await until("Fresh", () => document.querySelector("#nav-sessions .current").textContent === "Fresh");
  r = await inPage(sessionRow);
  assert.deepEqual([r.words, r.temporary], [", Fresh session (temporary)", true]);
  await ctx.shim.layout({ left: 1 });
  await until("the rail", () => document.body.dataset.dock === "rail");
  assert.equal(await inPage(() => document.getElementById("nav-sessions").title), "Sessions · Fresh session (temporary)");
  assert.equal(await inPage(() => document.querySelector("#nav-sessions .current").checkVisibility()), false, "the rail shows the icon only");
  helper.push("session", { name: "work", where: "Local" });
  await until("the rail's tooltip follows", () => document.getElementById("nav-sessions").title === "Sessions · work");
  // A named instance (several PairBrowse helpers on one computer) leads the name.
  helper.push("session", { name: "default", where: "Local", instance: "client-a" });
  await until("the instance", () => document.getElementById("nav-sessions").title === "Sessions · Default, instance client-a");
  assert.equal(await inPage(() => document.querySelector("#nav-sessions .current").textContent), "client-a · Default");
  const live = await ctx.harness.live();
  assert.equal(live.intervals, 0, "no polling");
  await clean(ctx);
});

// Served without the browser's API (a plain browser): the framed switcher's "All sessions…" opens the
// sessions page as a new tab and the switcher closes.
scenario("left: All sessions from the framed switcher", { viewport: { width: 420, height: 936 }, native: false, fixtures: { sessions: SWITCHER_SESSIONS } }, async (ctx) => {
  const { page, until } = ctx;
  await page.click("#nav-sessions");
  const frame = await framedPicker(page, "ready");
  assert.deepEqual(await inFrame(frame, () => { const a = document.getElementById("all"); return [a.checkVisibility(), a.getAttribute("href"), a.target]; }), [true, "../sessions/index.html", "_blank"]);
  const opened = page.context().waitForEvent("page");
  await clickInFrame(page, frame, "#all");
  const tab = await opened;
  await tab.waitForLoadState("load");
  assert.match(tab.url(), /\/sessions\/index\.html$/);
  await until("the switcher closed", () => document.getElementById("switcher").hidden);
  await tab.close();
  await clean(ctx);
});
