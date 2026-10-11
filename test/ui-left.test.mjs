// The left dock (ui/left, DESIGN.md B3) over the pages' harness: the dock state reflected from the
// layout, the nav rows and what they open, the tab count, the agents and who it is shared with,
// the activity list, the storage figure (only when the helper reports one) and the keyboard.
// The common checks are in test/ui.test.mjs.
import { describe } from "node:test";
import assert from "node:assert/strict";
import { pageTest } from "./helpers/ui-page.mjs";

// Each case its own pageTest under a suite that names it, so a failure says which.
const scenario = (title, opts, fn) => describe(title, () => pageTest("left", opts, fn));

const OPEN = { width: 200, height: 936 };
const BOARD = { people: [
  { who: "Claude", kind: "agent", color: "#e9763f", status: "working", tab: "Shop" },
  { who: "Alice · Codex", kind: "agent", color: "#4fd1e8", status: "you" },
  { who: "Bob", kind: "person", status: "idle" },
] };
const TWO_TABS = { owners: { agents: { 11: "Claude", 12: "Claude" }, colors: { 11: "#e9763f", 12: "#e9763f" } } };

async function clean(ctx) {
  assert.deepEqual(ctx.errors, []);
  const bad = (await ctx.harness.log()).filter((e) => ["error", "pageerror", "rejection", "csp"].includes(e.kind));
  assert.deepEqual(bad, []);
}
const calls = async (ctx, iface, method) => (await ctx.shim.calls()).filter((c) => c.iface === iface && c.method === method);
const rows = () => [...document.querySelectorAll("#agents li")].map((li) => ({
  state: li.dataset.state || "", name: li.querySelector("strong")?.textContent || "", line: li.querySelector("small")?.textContent || li.textContent,
  title: li.title, bg: li.querySelector(".avatar") ? getComputedStyle(li.querySelector(".avatar")).backgroundColor : "",
}));

scenario("left: open, rail, hidden", { viewport: OPEN }, async (ctx) => {
  const { until, inPage } = ctx;
  assert.equal(await inPage(() => document.body.dataset.dock), "open");
  assert.equal((await calls(ctx, "layout", "get")).length, 1);
  assert.equal((await calls(ctx, "layout", "addObserver")).length, 1);
  await ctx.shim.layout({ left: 1 });
  await until("the rail", () => document.body.dataset.dock === "rail");
  assert.equal(await inPage(() => document.querySelector("#nav-browser .label").checkVisibility()), false);
  assert.match(await inPage(() => document.getElementById("nav-browser").title), /^Browser · 3 open tabs$/);
  assert.equal(await inPage(() => document.getElementById("nav-tools").title), "Tools");
  assert.equal(await inPage(() => document.getElementById("workspace").title), "Workspace: switch session");
  // The dock's stream carries panel=1, so today's helper never counts it as a viewer (no screencast).
  assert.deepEqual([...ctx.helper.streams].map((st) => ({ kind: st.kind, panel: st.panel })), [{ kind: "left", panel: true }]);
  // A fresh activity line arms the one drive timer; hiding the dock stops it.
  ctx.helper.push("activity", [{ t: Date.now(), who: "Claude", text: "typed" }]);
  for (let i = 0; i < 40 && (await ctx.harness.live()).timeouts !== 1; i++) await ctx.page.waitForTimeout(50);
  assert.equal((await ctx.harness.live()).timeouts, 1);
  await ctx.shim.layout({ left: 0 });
  await until("hidden", () => document.body.dataset.dock === "hidden");
  assert.deepEqual(await inPage(() => ["main", "workspace", "settings"].map((id) => document.getElementById(id).inert)), [true, true, true]);
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
  assert.deepEqual(await inPage(() => [...document.querySelectorAll(".nav .row")].map((b) => b.id)), ["nav-browser", "nav-sessions", "nav-history", "nav-activity", "nav-tools"]);
  assert.equal(await inPage(() => document.getElementById("nav-browser").getAttribute("aria-current")), "page");
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
  await clean(ctx);
});

scenario("left: agents rows with their state in words", { viewport: OPEN, fixtures: { board: BOARD }, shim: TWO_TABS }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("three rows", () => document.querySelectorAll("#agents li[data-state]").length === 3);
  const [claude, alice, bob] = await inPage(rows);
  assert.deepEqual([claude.state, claude.name, claude.line, claude.bg], ["working", "Claude", "Working · 2 tabs", "rgb(233, 118, 63)"]);
  assert.deepEqual([alice.state, alice.name, alice.line], ["waiting", "Alice · Codex", "Waiting for you"]);
  assert.equal(await inPage(() => document.querySelector("#agents li:nth-child(2) strong .app").textContent), " · Codex");
  assert.equal(await inPage(() => getComputedStyle(document.querySelector("#agents li:nth-child(2) strong .app")).color === getComputedStyle(document.querySelector("#nav-tools")).color), true, "the app in --ink-2");
  assert.deepEqual([bob.state, bob.line], ["online", "Online"]);
  assert.equal(await inPage(() => document.querySelector("#agents li").getBoundingClientRect().height), 44);
  const dot = (state) => getComputedStyle(document.querySelector(`#agents li[data-state="${state}"] .dot`)).backgroundColor;
  const token = (name) => { const s = document.createElement("span"); s.style.color = `var(${name})`; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; };
  assert.equal(await inPage(dot, "working"), await inPage(token, "--ok"));
  assert.equal(await inPage(dot, "waiting"), await inPage(token, "--warn"));
  ctx.helper.set("board", { people: [{ who: "Claude", kind: "agent", status: "idle" }] });
  await until("Active", () => document.querySelector("#agents li small")?.textContent === "Active · 2 tabs");
  assert.equal((await inPage(rows))[0].bg, "rgb(233, 118, 63)", "the owner's color");
  await ctx.shim.removeTab(12);
  await until("one tab", () => document.querySelector("#agents li small")?.textContent === "Active · 1 tab");
  await ctx.shim.clearOwner(11);
  await until("Idle", () => document.querySelector("#agents li small")?.textContent === "Idle");
  assert.equal(await inPage(() => document.querySelector("#agents li").dataset.state), "idle");
  assert.equal(await inPage(dot, "idle"), await inPage(token, "--muted"));
  await ctx.shim.setOwner(13, "Codex", "#4fd1e8");
  await until("a Codex row", () => [...document.querySelectorAll("#agents li")].some((li) => li.querySelector("strong")?.textContent === "Codex" && li.querySelector("small").textContent === "Active · 1 tab"));
  assert.equal(await inPage(() => document.querySelectorAll('#agents li[data-state="failed"]').length), 0);
  ctx.helper.set("board", { people: [] });
  await ctx.shim.clearOwner(13);
  await until("no agent", () => document.querySelector("#agents li.empty")?.textContent === "No agent yet");
  await clean(ctx);
});

scenario("left: the Activity list", { viewport: OPEN, fixtures: { board: { people: [{ who: "Claude", kind: "agent", status: "idle" }] } } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("Active", () => /^Active/.test(document.querySelector("#agents li small")?.textContent || ""));
  await ctx.page.focus("#nav-activity");
  await ctx.page.keyboard.press("Enter");
  await until("expanded, empty", () => document.getElementById("nav-activity").getAttribute("aria-expanded") === "true" && !document.getElementById("activity-list").hidden);
  assert.equal(await inPage(() => document.querySelector("#activity-list li.empty")?.textContent), "Nothing yet");
  const token = (name) => { const s = document.createElement("span"); s.style.color = `var(${name})`; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; };
  assert.equal(await inPage(() => getComputedStyle(document.querySelector("#activity-list li.empty")).color), await inPage(token, "--muted"), "the placeholder in --muted");
  ctx.helper.push("activity", [{ t: Date.now(), who: "Claude", tab: "Shop", text: "clicked **Pay**" }]);
  await until("Working", () => /^Working/.test(document.querySelector("#agents li small")?.textContent || ""));
  assert.equal((await ctx.harness.live()).timeouts, 1);
  const li = await inPage(() => { const l = document.querySelector("#activity-list li"); return { n: document.querySelectorAll("#activity-list li").length, time: l.querySelector("time").textContent, strong: [...l.querySelectorAll("strong")].map((s) => s.textContent) }; });
  assert.equal(li.n, 1);
  assert.match(li.time, /\d/);
  assert.deepEqual(li.strong, ["Claude in Shop: ", "Pay"]);
  await ctx.harness.setHidden(true);
  assert.equal((await ctx.harness.live()).timeouts, 0);
  await ctx.harness.setHidden(false);
  assert.match(await inPage(() => document.querySelector("#agents li small").textContent), /^(Working|Active)/);
  await ctx.page.keyboard.press("Enter");
  await until("folded", () => document.getElementById("activity-list").hidden);
  await clean(ctx);
});

scenario("left: shared with", { viewport: OPEN, fixtures: { collaboration: { guests: [{ label: "Dana", role: "drive" }, { label: "Dana", role: "drive" }, { label: "Eve", role: "watch" }] } } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("shared", () => !document.getElementById("shared").hidden);
  const got = await inPage(() => [...document.querySelectorAll("#guests li")].map((li) => ({
    text: `${li.querySelector("strong").textContent} · ${li.querySelector("small").textContent}`, icon: !!li.querySelector(".avatar.plain svg use"),
    size: li.querySelector(".avatar").getBoundingClientRect().width,
  })));
  assert.deepEqual(got, [{ text: "Dana · 2 online · can drive", icon: true, size: 32 }, { text: "Eve · 1 online · watching", icon: true, size: 32 }]);
  ctx.helper.set("collaboration", { guests: [] });
  await until("not shared", () => document.getElementById("shared").hidden);
  await clean(ctx);
});

scenario("left: storage row only with a figure", { viewport: OPEN }, async (ctx) => {
  const { until, inPage } = ctx;
  assert.equal(await inPage(() => document.getElementById("storage").hidden), true);
  ctx.helper.push("session", { name: "default", where: "Local", diskBytes: 2576980378 });
  await until("storage", () => !document.getElementById("storage").hidden);
  const read = () => { const b = document.getElementById("storage-bar"); return { text: document.getElementById("storage-text").textContent, now: b.getAttribute("aria-valuenow"), said: b.getAttribute("aria-valuetext"), width: document.getElementById("storage-fill").style.width, over: b.dataset.over }; };
  assert.deepEqual(await inPage(read), { text: "2.4 GB / 10 GB", now: "2576980378", said: "2.4 GB of a 10 GB guide", width: "24%", over: "false" });
  ctx.helper.push("session", { name: "default", where: "Local", diskBytes: 16106127360 });
  await until("over", () => document.getElementById("storage-bar").dataset.over === "true");
  assert.deepEqual(await inPage(read), { text: "15.0 GB / 10 GB", now: "10737418240", said: "15.0 GB, over the 10 GB guide", width: "100%", over: "true" });
  ctx.helper.push("session", { name: "default", where: "Local", diskBytes: 0 });
  await until("zero", () => document.getElementById("storage-text").textContent === "0 MB / 10 GB");
  assert.equal(await inPage(() => document.getElementById("storage-fill").style.width), "0%");
  ctx.helper.push("session", { name: "default", where: "Local" });
  await until("hidden again", () => document.getElementById("storage").hidden);
  await clean(ctx);
});

scenario("left: keyboard", { viewport: OPEN, shim: { layout: { right: 1 } } }, async (ctx) => {
  const { until, inPage } = ctx;
  await inPage(() => { document.activeElement?.blur?.(); document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex"); });
  const order = [];
  for (let i = 0; i < 8; i++) { await ctx.page.keyboard.press("Tab"); order.push(await inPage(() => document.activeElement.id)); }
  assert.deepEqual(order, ["workspace", "nav-browser", "nav-sessions", "nav-history", "nav-activity", "nav-tools", "add-agent", "settings"]);
  await ctx.page.focus("#nav-sessions");
  await ctx.page.keyboard.press("Enter");
  for (let i = 0; i < 40 && !ctx.helper.posts.some((p) => p.route === "picker"); i++) await ctx.page.waitForTimeout(50);
  assert.ok(ctx.helper.posts.some((p) => p.route === "picker"), "the picker route");
  const fixture = await inPage(() => ({ ...window.__pairbrowse.fixture.layout }));
  await ctx.page.focus("#nav-tools");
  await ctx.page.keyboard.press("Enter");
  await until("a layout.set", () => window.__pairbrowse.calls.some((c) => c.iface === "layout" && c.method === "set"));
  assert.deepEqual((await calls(ctx, "layout", "set"))[0].args[0], { ...fixture, right: 2 });
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
  await clean(ctx);
});

scenario("left: rail at 44 px", { viewport: { width: 44, height: 936 }, shim: { layout: { left: 1 } }, fixtures: { board: BOARD } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("the rail", () => document.body.dataset.dock === "rail");
  await until("the agents", () => document.querySelectorAll("#agents li[data-state]").length === 3);
  const seen = await inPage(() => ({
    labels: [...document.querySelectorAll(".label, .ws-label, .badge, h2, .add, .hint, .conn, .activity, #storage")].filter((n) => n.checkVisibility()).length,
    clipped: [...document.querySelectorAll(".people strong, .people small")].map((n) => n.getBoundingClientRect().width <= 1),
    width: document.documentElement.scrollWidth,
    gear: document.getElementById("settings").checkVisibility(),
    avatars: [...document.querySelectorAll("#agents .avatar")].map((a) => [a.checkVisibility(), a.querySelector(".dot").checkVisibility(), a.getBoundingClientRect().width]),
    titles: [...document.querySelectorAll("#agents li")].map((li) => li.title),
    rows: [...document.querySelectorAll(".nav .row")].map((r) => r.title),
  }));
  assert.equal(seen.labels, 0);
  assert.ok(seen.clipped.length > 0 && seen.clipped.every(Boolean), "names and states clipped, not removed");
  assert.ok(seen.width <= 44, `scrollWidth ${seen.width}`);
  assert.equal(seen.gear, true);
  assert.deepEqual(seen.avatars, [[true, true, 28], [true, true, 28], [true, true, 28]]);
  assert.deepEqual(seen.titles, ["Claude · Working · 1 tab", "Alice · Codex · Waiting for you", "Bob · Online"]);
  assert.deepEqual(seen.rows, ["Browser · 3 open tabs", "Sessions", "History", "Activity", "Tools"]);
  await clean(ctx);
});

scenario("left: reduced motion", { viewport: OPEN, reducedMotion: "reduce" }, async (ctx) => {
  await ctx.shim.layout({ left: 1 });
  await ctx.until("the rail", () => document.body.dataset.dock === "rail");
  await ctx.page.hover("#nav-browser");
  await ctx.page.waitForTimeout(50);
  assert.deepEqual(await ctx.harness.animations(), []);
  await clean(ctx);
});
