// The left dock (ui/left, DESIGN.md B3) over the pages' harness: the dock state reflected from the
// layout, the nav rows and what they open, the tab count, the agents and who it is shared with,
// the activity list, no Storage row (PairBrowse Pro's), the Shared-with "+" and its Share card, the
// collapse and expand buttons (native and over the helper's route) and the keyboard.
// The common checks are in test/ui.test.mjs.
import { describe } from "node:test";
import assert from "node:assert/strict";
import { pageTest } from "./helpers/ui-page.mjs";
import { inPage as inFrame } from "./live.mjs";

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
      const st = await inFrame(frame, () => ({ host: document.documentElement.dataset.host, s: document.body?.dataset.s })).catch(() => null);
      if (st?.host === "frame" && (!s || st.s === s)) return frame;
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
const shown = () => ({ collapse: document.getElementById("dock-collapse").checkVisibility(), expand: document.getElementById("dock-expand").checkVisibility() });
const token = (name) => { const s = document.createElement("span"); s.style.color = `var(${name})`; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; };
const calls = async (ctx, iface, method) => (await ctx.shim.calls()).filter((c) => c.iface === iface && c.method === method);
const rows = () => [...document.querySelectorAll("#agents li")].map((li) => ({
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
  assert.equal(await inPage(() => document.getElementById("nav-tools").title), "Tools");
  assert.equal(await inPage(() => document.getElementById("workspace").title), "Workspace: switch session");
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
  assert.deepEqual(await inPage(() => ["main", "workspace", "settings", "dock-collapse", "dock-expand"].map((id) => document.getElementById(id).inert)), [true, true, true, true, true]);
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
  assert.deepEqual(await inPage(() => [...document.querySelectorAll(".nav .row")].map((b) => b.id)), ["nav-browser", "nav-sessions", "nav-history", "nav-activity", "nav-tools"]);
  assert.equal(await inPage(() => document.getElementById("nav-browser").getAttribute("aria-current")), "page");
  // The active row, as the mockup draws it: the --nav-active fill, no gradient, the soft blue glow.
  const look = await inPage(() => { const p = document.createElement("i"); p.style.backgroundColor = "var(--nav-active)"; document.body.append(p); const want = getComputedStyle(p).backgroundColor; p.remove(); const s = getComputedStyle(document.getElementById("nav-browser")); return { bg: s.backgroundColor === want, image: s.backgroundImage, shadow: s.boxShadow }; });
  assert.deepEqual({ ...look, shadow: look.shadow !== "none" }, { bg: true, image: "none", shadow: true });
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
  const all = await inPage(rows);
  // The agents, then the owner ("You · Online", the mockup); another person (Bob) is never a row here.
  assert.deepEqual(all.map((r) => r.name), ["Claude", "Alice · Codex", "You"], "agents, then you; no other person");
  assert.deepEqual(all.filter((r) => r.state === "online").map((r) => [r.name, r.line]), [["You", "Online"]]);
  const [claude, alice] = all;
  // An agent in tabs reads "Active · N tabs" (the mockup); its working state is the row's state and dot.
  assert.deepEqual([claude.state, claude.name, claude.line, claude.bg], ["working", "Claude", "Active · 2 tabs", "rgb(233, 118, 63)"]);
  assert.deepEqual([alice.state, alice.name, alice.line], ["waiting", "Alice · Codex", "Waiting for you"]);
  assert.equal(await inPage(() => document.querySelector("#agents li:nth-child(2) strong .app").textContent), " · Codex");
  assert.equal(await inPage(() => { const s = document.createElement("span"); s.style.color = "var(--ink-2)"; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return getComputedStyle(document.querySelector("#agents li:nth-child(2) strong .app")).color === c; }), true, "the app in --ink-2");
  assert.equal(await inPage(() => document.querySelector("#agents li").getBoundingClientRect().height), 50);
  const dot = (state) => getComputedStyle(document.querySelector(`#agents li[data-state="${state}"] .dot`)).backgroundColor;
  const token = (name) => { const s = document.createElement("span"); s.style.color = `var(${name})`; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; };
  assert.equal(await inPage(dot, "working"), await inPage(token, "--ok"));
  assert.equal(await inPage(dot, "waiting"), await inPage(token, "--warn"));
  ctx.helper.set("board", { people: [{ who: "Claude", kind: "agent", status: "idle" }] });
  await until("Active", () => document.querySelector("#agents li small")?.textContent === "Active · 2 tabs");
  assert.deepEqual((await inPage(rows)).map((r) => r.name), ["Claude"], "an agent-only board renders its row");
  assert.equal((await inPage(rows))[0].bg, "rgb(233, 118, 63)", "the owner's color");
  await ctx.shim.removeTab(12);
  await until("one tab", () => document.querySelector("#agents li small")?.textContent === "Active · 1 tab");
  await ctx.shim.clearOwner(11);
  await until("Idle", () => document.querySelector("#agents li small")?.textContent === "Idle");
  assert.equal(await inPage(() => document.querySelector("#agents li").dataset.state), "idle");
  assert.equal(await inPage(dot, "idle"), await inPage(token, "--accent"), "idle: the mockup's blue dot");
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
  await until("working", () => document.querySelector("#agents li")?.dataset.state === "working");
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
  assert.equal(await inPage(() => document.getElementById("shared").checkVisibility()), true, "the section stays, with its +");
  assert.equal(await inPage(() => document.getElementById("guests-empty").textContent), "Not shared yet");
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
      fill: Math.round(document.getElementById("storage-bar").getBoundingClientRect().width / bar.getBoundingClientRect().width * 100), beforeGear: document.getElementById("storage").nextElementSibling?.id };
  });
  assert.deepEqual(row, { text: "2.4 GB / 10 GB", label: "2.4 GB of 10 GB used", role: "img", fill: 24, beforeGear: "settings" });
  ctx.helper.push("session", { name: "default", where: "Local" });
  await until("no row", () => !document.getElementById("storage"));
  await clean(ctx);
});

scenario("left: Shared with +", { viewport: OPEN }, async (ctx) => {
  const { until, inPage, page, helper } = ctx;
  const add = await inPage(() => { const b = document.getElementById("share-add"), r = b.getBoundingClientRect(); return { w: r.width, h: r.height, expanded: b.getAttribute("aria-expanded"), label: b.getAttribute("aria-label") }; });
  assert.deepEqual(add, { w: 28, h: 26, expanded: "false", label: "Share this session" });
  await page.focus("#share-add");
  await page.keyboard.press("Enter");
  await until("the share card", () => !document.getElementById("share-card").hidden && document.activeElement?.name === "share" && document.activeElement.value === "code");
  assert.equal(await page.getAttribute("#share-add", "aria-expanded"), "true");
  const inside = await inPage(() => { const c = document.getElementById("share-card").getBoundingClientRect(); return c.left >= 0 && c.right <= innerWidth && c.top > document.getElementById("share-add").getBoundingClientRect().top; });
  assert.equal(inside, true, "under the + inside the dock");
  // A synthetic click makes nothing; a person's click asks the helper.
  await inPage(() => document.getElementById("share-make").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(helper.posts.filter((p) => p.route === "invite").length, 0, "a synthetic click invites nobody");
  await page.click("#share-make");
  for (let i = 0; i < 40 && !helper.posts.some((p) => p.route === "invite"); i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(helper.posts.filter((p) => p.route === "invite").map((p) => p.body), [{ share: "code" }]);
  // The helper asks for a name first; with it, the code and Copy fit the open dock's 200 px.
  await until("the name field", () => document.activeElement?.id === "share-name");
  await page.keyboard.type("Sam");
  await page.keyboard.press("Enter");
  await until("the code", () => !document.getElementById("share-result").hidden && document.getElementById("share-code").value === "pb-join:FAKE");
  const fit = await inPage(() => {
    const card = document.getElementById("share-card").getBoundingClientRect(), copy = document.getElementById("share-copy").getBoundingClientRect(), code = document.getElementById("share-code").getBoundingClientRect();
    return { right: card.right, vw: innerWidth, copyIn: copy.left >= card.left && copy.right <= card.right && copy.left >= 0 && copy.right <= innerWidth && copy.width > 0, code: code.width };
  });
  assert.ok(fit.right <= fit.vw, `the card inside the dock: ${fit.right} <= ${fit.vw}`);
  assert.equal(fit.copyIn, true, "Copy fully visible");
  assert.ok(fit.code > 80, `the code field readable: ${fit.code}px`);
  await page.focus("#share-make");
  await page.keyboard.press("Escape");
  await until("closed, focus back on +", () => document.getElementById("share-card").hidden && document.activeElement?.id === "share-add");
  assert.equal(await page.getAttribute("#share-add", "aria-expanded"), "false");
  await clean(ctx);
});

scenario("left: keyboard", { viewport: OPEN, shim: { layout: { right: 1 } } }, async (ctx) => {
  const { until, inPage } = ctx;
  await inPage(() => { document.activeElement?.blur?.(); document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute("tabindex"); });
  const order = [];
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  for (let i = 0; i < 10; i++) { await ctx.page.keyboard.press("Tab"); order.push(await inPage(() => document.activeElement.id)); }
  assert.deepEqual(order, ["workspace", "dock-collapse", "nav-browser", "nav-sessions", "nav-history", "nav-activity", "nav-tools", "add-agent", "share-add", "settings"]);
  await ctx.page.focus("#nav-sessions");
  await ctx.page.keyboard.press("Enter");
  // The Sessions row opens the switcher: the picker in a same-origin frame, no picker route.
  assert.deepEqual(await inPage(() => ({ hidden: document.getElementById("switcher").hidden, expanded: document.getElementById("nav-sessions").getAttribute("aria-expanded"),
    src: document.getElementById("picker").src.endsWith("/picker/index.html") })), { hidden: false, expanded: "true", src: true });
  await framedPicker(ctx.page);
  assert.equal(ctx.helper.posts.some((p) => p.route === "picker"), false, "no picker route");
  await ctx.page.keyboard.press("Escape");
  await until("the switcher closed", () => document.getElementById("switcher").hidden && document.activeElement?.id === "nav-sessions");
  const fixture = await inPage(() => ({ ...window.__pairbrowse.fixture.layout }));
  await ctx.page.focus("#nav-tools");
  await ctx.page.keyboard.press("Enter");
  await until("a layout.set", () => window.__pairbrowse.calls.some((c) => c.iface === "layout" && c.method === "set"));
  assert.deepEqual((await calls(ctx, "layout", "set"))[0].args[0], { ...fixture, right: 2 });
  // The right dock lands on its Tools tab: the helper relays POST layout's tab to it.
  const layouts = () => ctx.helper.posts.filter((p) => p.route === "layout");
  for (let i = 0; i < 60 && !layouts().length; i++) await ctx.page.waitForTimeout(50);
  assert.deepEqual(layouts().map((p) => p.body), [{ tab: "tools" }], "the tab only: the dock opens through the mojom");
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

scenario("left: the session switcher", { viewport: { width: 420, height: 936 }, fixtures: { sessions: SWITCHER_SESSIONS } }, async (ctx) => {
  const { page, until, inPage, helper } = ctx;
  const live = await ctx.harness.live();
  const state = () => ({ hidden: document.getElementById("switcher").hidden, src: document.getElementById("picker").getAttribute("src"), focus: document.activeElement?.id || "" });
  await page.click("#workspace");
  const box = await inPage(() => {
    const d = document.getElementById("switcher"), r = d.getBoundingClientRect();
    return { role: d.getAttribute("role"), label: d.getAttribute("aria-label"), left: r.left, top: r.top, width: r.width, height: r.height,
      shadow: getComputedStyle(d).boxShadow, expanded: document.getElementById("workspace").getAttribute("aria-expanded") };
  });
  assert.equal(box.role, "dialog");
  assert.equal(box.label, "Switch session");
  assert.deepEqual([box.left, box.top, box.width, box.height], [8, 44, 360, 560]);
  assert.match(box.shadow, /rgb\(41, 59, 80\)/, "the 1 px edge ring");
  assert.equal(box.expanded, "true");
  const frame = await framedPicker(page, "ready");
  assert.equal(await inFrame(frame, () => window.innerWidth), 360);
  // A pick: the picker's "picked" notice closes the switcher, focus back on the header.
  await clickInFrame(page, frame, "#sessions > li:first-child button");
  for (let i = 0; i < 60 && !helper.posts.some((p) => p.route === "pick"); i++) await page.waitForTimeout(50);
  assert.deepEqual(helper.posts.filter((p) => p.route === "pick").map((p) => p.body), [{ action: "use", name: "work" }]);
  await until("closed after the pick", () => document.getElementById("switcher").hidden && document.activeElement?.id === "workspace");
  assert.deepEqual(await inPage(state), { hidden: true, src: null, focus: "workspace" });
  assert.equal(pickerFrames(page), 0, "the picker unloaded");
  // The Sessions row opens the same popover; a click outside closes it without moving focus there.
  await page.click("#nav-sessions");
  assert.equal(await inPage(() => document.getElementById("nav-sessions").getAttribute("aria-expanded")), "true");
  await framedPicker(page);
  await page.mouse.click(100, 700);
  await until("closed by a click outside", () => document.getElementById("switcher").hidden);
  assert.notEqual((await inPage(state)).focus, "nav-sessions");
  assert.equal(await inPage(() => document.getElementById("nav-sessions").getAttribute("aria-expanded")), "false");
  // Hiding the dock closes and unloads it.
  await page.click("#workspace");
  await framedPicker(page);
  await ctx.shim.layout({ left: 0 });
  await until("hidden", () => document.body.dataset.dock === "hidden" && document.getElementById("switcher").hidden);
  assert.equal((await inPage(state)).src, null);
  assert.equal(pickerFrames(page), 0);
  // The rail's Workspace button opens it too; Escape closes it.
  await ctx.shim.layout({ left: 1 });
  await until("the rail", () => document.body.dataset.dock === "rail");
  await page.click("#workspace");
  await framedPicker(page, "ready");
  await page.keyboard.press("Escape");
  await until("closed by Escape", () => document.getElementById("switcher").hidden && document.activeElement?.id === "workspace");
  assert.equal(helper.posts.some((p) => p.route === "picker"), false, "no picker route at any point");
  assert.deepEqual(await ctx.harness.live(), live, "nothing new runs once it is closed");
  await clean(ctx);
});

scenario("left: the session switcher under reduced motion", { viewport: { width: 420, height: 936 }, reducedMotion: "reduce", fixtures: { sessions: SWITCHER_SESSIONS } }, async (ctx) => {
  await ctx.page.click("#workspace");
  await framedPicker(ctx.page);
  assert.equal(await ctx.inPage(() => getComputedStyle(document.getElementById("switcher")).animationName), "none");
  await clean(ctx);
});

scenario("left: rail at 44 px", { viewport: { width: 44, height: 936 }, shim: { layout: { left: 1 } }, fixtures: { board: BOARD } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("the rail", () => document.body.dataset.dock === "rail");
  await until("the agents", () => document.querySelectorAll("#agents li[data-state]").length === 3);
  const seen = await inPage(() => ({
    labels: [...document.querySelectorAll(".label, .ws-label, .badge, h2, .add, .hint, .conn, .activity, #storage, #share-add, .empty-note, .share-card")].filter((n) => n.checkVisibility()).length,
    clipped: [...document.querySelectorAll(".people strong, .people small")].map((n) => n.getBoundingClientRect().width <= 1),
    width: document.documentElement.scrollWidth,
    gear: document.getElementById("settings").checkVisibility(),
    avatars: [...document.querySelectorAll("#agents .avatar")].map((a) => [a.checkVisibility(), a.querySelector(".dot").checkVisibility(), a.getBoundingClientRect().width]),
    titles: [...document.querySelectorAll("#agents li")].map((li) => li.title),
    rows: [...document.querySelectorAll(".nav .row")].map((r) => r.title),
    expand: (() => { const b = document.getElementById("dock-expand"), r = b.getBoundingClientRect(); return { shown: b.checkVisibility(), width: r.width, left: r.left, top: r.top }; })(),
    collapse: document.getElementById("dock-collapse").checkVisibility(),
    workspace: document.getElementById("workspace").checkVisibility(),
  }));
  assert.deepEqual(seen.expand, { shown: true, width: 24, left: 10, top: 10 });
  assert.equal(seen.collapse, false);
  assert.equal(seen.workspace, true);
  assert.equal(seen.labels, 0);
  assert.ok(seen.clipped.length > 0 && seen.clipped.every(Boolean), "names and states clipped, not removed");
  assert.ok(seen.width <= 44, `scrollWidth ${seen.width}`);
  assert.equal(seen.gear, true);
  assert.deepEqual(seen.avatars, [[true, true, 28], [true, true, 28], [true, true, 28]]);
  assert.deepEqual(seen.titles, ["Claude · Active · 1 tab", "Alice · Codex · Waiting for you", "You · Online"]);
  assert.deepEqual(seen.rows, ["Browser · 3 open tabs", "Sessions", "History", "Activity", "Tools"]);
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

scenario("left: collapse and expand", { viewport: OPEN }, async (ctx) => {
  const { until, inPage, page } = ctx;
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  const box = await inPage(() => {
    const b = document.getElementById("dock-collapse"), r = b.getBoundingClientRect();
    return { width: r.width, height: r.height, right: r.right, label: b.getAttribute("aria-label"), expanded: b.getAttribute("aria-expanded"), expand: document.getElementById("dock-expand").checkVisibility() };
  });
  assert.deepEqual(box, { width: 24, height: 24, right: 194, label: "Collapse the workspace", expanded: "true", expand: false });
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
  assert.deepEqual(expand, { label: "Expand the workspace", expanded: "false", top: 10, collapse: false });
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

scenario("left: Tools over the helper's route", { viewport: OPEN, native: false }, async (ctx) => {
  const { until, page, helper } = ctx;
  await until("live", () => document.body.dataset.s === "live");
  await page.click("#nav-tools");
  for (let i = 0; i < 60 && !helper.posts.some((p) => p.route === "layout"); i++) await page.waitForTimeout(50);
  await page.waitForTimeout(300);
  assert.deepEqual(helper.posts.filter((p) => p.route === "layout").map((p) => p.body), [{ right: "open", tab: "tools" }], "one POST: the right dock open, on Tools");
  assert.deepEqual(helper.fixtures.layout, { left: "open", right: "open", strip: 88 }, "the tab is never kept");
  await clean(ctx);
});

scenario("left: a failed collapse takes no focus later", { viewport: OPEN, native: false, replies: { layout: () => ({ status: 500, body: { error: "no" } }) } }, async (ctx) => {
  const { until, inPage, page, helper } = ctx;
  await until("the collapse button", () => document.getElementById("dock-collapse").checkVisibility());
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/layout"));
  await page.click("#dock-collapse");
  assert.equal((await answered).status(), 500);
  assert.equal(await inPage(() => document.body.dataset.dock), "open", "a refused collapse leaves the dock open");
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

// The strip's Share in the browser (its own card has no room in the 44 px row) opens this dock's
// Share card for the same window only.
scenario("left: the strip's Share opens the Share card here", { viewport: OPEN }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("live", () => document.body.dataset.s === "live");
  await inPage(() => new Promise((r) => setTimeout(r, 100))); // windows.list has answered
  await inPage(() => { const ch = new BroadcastChannel("pairbrowse-share"); ch.postMessage({ open: "share", window: 2 }); ch.close(); });
  await inPage(() => new Promise((r) => setTimeout(r, 100)));
  assert.equal(await inPage(() => document.getElementById("share-card").hidden), true, "another window's ask is not this dock's");
  await inPage(() => { window.__heard = []; const ch = new BroadcastChannel("pairbrowse-share"); ch.onmessage = (e) => window.__heard.push(e.data); window.__strip = ch; ch.postMessage({ open: "share", window: 1 }); });
  await until("the card", () => !document.getElementById("share-card").hidden);
  assert.equal(await inPage(() => document.getElementById("share-add").getAttribute("aria-expanded")), "true");
  // It tells the strip the card opened, for this window (the strip's note says so only then).
  await until("the answer", () => window.__heard.length === 1);
  assert.deepEqual(await inPage(() => (window.__strip.close(), window.__heard)), [{ opened: "share", window: 1 }]);
  // Asked while the dock is a rail (the strip's open has not landed yet): the card waits for the
  // open layout, then opens in the open dock.
  await inPage(() => document.getElementById("share-add").click());
  await until("the card closes", () => document.getElementById("share-card").hidden);
  await ctx.shim.layout({ left: 1 });
  await until("the rail", () => document.body.dataset.dock === "rail");
  await inPage(() => { const ch = new BroadcastChannel("pairbrowse-share"); ch.postMessage({ open: "share", window: 1 }); ch.close(); });
  await inPage(() => new Promise((r) => setTimeout(r, 100)));
  assert.equal(await inPage(() => document.getElementById("share-card").hidden), true, "no card in a rail");
  await ctx.shim.layout({ left: 2 });
  await until("the card once open", () => document.body.dataset.dock === "open" && !document.getElementById("share-card").hidden);
  await clean(ctx);
});

// Before the dock knows its window (the list has not answered): no ask is taken as this window's.
scenario("left: no Share card before the window is known", { viewport: OPEN, shim: { windows: [] } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("live", () => document.body.dataset.s === "live");
  await inPage(() => { const ch = new BroadcastChannel("pairbrowse-share"); ch.postMessage({ open: "share", window: 1 }); ch.close(); });
  await inPage(() => new Promise((r) => setTimeout(r, 100)));
  assert.equal(await inPage(() => document.getElementById("share-card").hidden), true);
  await clean(ctx);
});
