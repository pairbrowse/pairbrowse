// All sessions (ui/sessions/, pairbrowse://sessions; opened from the switcher's "All sessions…") over
// the pages' harness: every saved session with when it was last used and only the actions the helper
// honours (Switch on the others, Rename on the open one and, with a helper that takes from, on the
// others but "default", Delete on the others but "default"), the
// in-row questions, the switch question while agents are at work, start fresh and join, the open
// session's line from the helper's event, the live list, the tab page's one interface (Session) and
// the resting state without a helper. The common checks are in test/ui.test.mjs.
import { describe } from "node:test";
import assert from "node:assert/strict";
import { pageTest } from "./helpers/ui-page.mjs";

const scenario = (title, opts, fn) => describe(title, () => pageTest("sessions", opts, fn));
const VIEW = { width: 969, height: 796 };
const HOUR = 3600_000;
const SESSIONS = () => ({ picking: false, sessions: [
  { name: "work", tabs: 3, sites: ["shop.example", "docs.example"], current: true, used: Date.now() - 2 * 60_000,
    live: [{ who: "Sam", app: "Claude Code", kind: "guest" }], people: [{ who: "You", kind: "you", computer: "Mac" }] },
  { name: "shop", tabs: 1, sites: ["shop.example"], used: Date.now() - 30 * HOUR, people: [] },
  { name: "default", tabs: 0, sites: [], used: 0, people: [] },
  { name: "travel", tabs: 2, sites: ["trips.example"], used: Date.now() - 5 * 60_000, people: [] },
] });
const OPEN = { name: "work", where: "Local", temporary: false, canRename: true };
const posted = (helper, route) => helper.posts.filter((p) => p.route === route).map((p) => p.body);
const rows = () => [...document.querySelectorAll("#list > li[data-name]")].filter((li) => !li.hidden).map((li) => ({
  name: li.querySelector(".name").textContent,
  badges: [...li.querySelectorAll("strong em")].map((e) => e.textContent),
  meta: li.querySelector("small").textContent,
  acts: [...li.querySelectorAll(".acts button")].map((b) => b.textContent),
}));
const msg = () => ({ text: document.getElementById("msg").textContent, kind: document.getElementById("msg").dataset.kind || "" });
async function clean(ctx) {
  assert.deepEqual(ctx.errors, []);
  const bad = (await ctx.harness.log()).filter((e) => ["error", "pageerror", "rejection", "csp"].includes(e.kind));
  assert.deepEqual(bad, []);
}
const row = (ctx, name) => ctx.page.locator(`#list > li[data-name="${name}"]`);

scenario("sessions: the list and what each row offers", { viewport: VIEW, fixtures: { sessions: SESSIONS(), session: OPEN } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("the rows", () => document.querySelectorAll("#list > li[data-name]").length === 4);
  const list = await inPage(rows);
  assert.deepEqual(list.map((r) => r.name), ["work", "shop", "Default", "travel"], "every saved session, in the helper's order");
  assert.deepEqual(list[0].badges, ["Open now", "Live · 1 other"]);
  assert.match(list[0].meta, /^Last used 2 min ago · 3 tabs · shop\.example, docs\.example$/);
  assert.match(list[1].meta, /^Last used .+ · 1 tab · shop\.example$/);
  assert.equal(list[2].meta, "Not used yet · No saved tabs");
  // Only what the helper honours: the open one is renamed (never switched to or deleted), "default"
  // is never deleted.
  assert.deepEqual(list.map((r) => r.acts), [["Rename"], ["Switch", "Delete"], ["Switch"], ["Switch", "Delete"]]);
  assert.equal(await inPage(() => document.getElementById("sub").textContent), "You're in work.");
  assert.equal(await inPage(() => document.getElementById("filter").hidden), true, "no search for four");
  assert.match(await ctx.page.locator("#list > li[data-name=shop] .acts").ariaSnapshot(), /button "Switch to shop"[\s\S]*button "Delete session shop"/);
  // A tab page: the browser binds Session only, so nothing else is asked of it.
  const others = (await ctx.shim.calls()).filter((c) => c.iface !== "session");
  assert.deepEqual(others, []);
  // The list follows the helper's sessions event, without polling.
  ctx.helper.push("sessions", { picking: false, sessions: SESSIONS().sessions.slice(0, 2) });
  await until("two rows", () => document.querySelectorAll("#list > li[data-name]").length === 2);
  const live = await ctx.harness.live();
  assert.equal(live.intervals + live.timeouts, 0, "nothing ticks");
  await clean(ctx);
});

scenario("sessions: switch, with the question while agents are at work", { viewport: VIEW, fixtures: { sessions: SESSIONS(), session: OPEN, agents: ["Claude"] } }, async (ctx) => {
  const { until, inPage, helper } = ctx;
  await until("the rows", () => document.querySelectorAll("#list > li[data-name]").length === 4);
  await row(ctx, "shop").getByRole("button", { name: "Switch to shop" }).click();
  await until("the question", () => !document.getElementById("switch-ask").hidden);
  assert.equal(await inPage(() => document.querySelector("#switch-ask strong").textContent), "Claude is using the browser. Switching closes every tab for them. Switch anyway?");
  await ctx.page.click("#switch-ask .secondary");
  await until("not switched", () => document.getElementById("msg").textContent === "Not switched.");
  await row(ctx, "shop").getByRole("button", { name: "Switch to shop" }).click();
  await until("the question again", () => !document.getElementById("switch-ask").hidden);
  await ctx.page.click("#switch-ask .primary");
  await until("switching", () => document.getElementById("msg").dataset.kind === "ok");
  assert.deepEqual(posted(helper, "pick"), [{ action: "use", name: "shop" }, { action: "use", name: "shop" }, { action: "use", name: "shop", confirm: true }]);
  assert.deepEqual(await inPage(msg), { text: 'Opening session "shop".', kind: "ok" });
  await clean(ctx);
});

scenario("sessions: delete asks in the row", { viewport: VIEW, fixtures: { sessions: SESSIONS(), session: OPEN } }, async (ctx) => {
  const { until, inPage, helper, page } = ctx;
  await until("the rows", () => document.querySelectorAll("#list > li[data-name]").length === 4);
  await row(ctx, "travel").getByRole("button", { name: "Delete session travel" }).click();
  assert.equal(await inPage(() => document.querySelector('#list > li[data-name="travel"] .question').textContent), "Delete it with its logins?");
  assert.equal(await inPage(() => document.activeElement.textContent), "Keep", "the safe answer has the focus");
  // Another row's change keeps the question where it is.
  helper.push("sessions", SESSIONS());
  await page.waitForTimeout(150);
  assert.equal(await inPage(() => !!document.querySelector('#list > li[data-name="travel"] .question')), true);
  await page.keyboard.press("Enter");
  await until("asked no more", () => !document.querySelector("#list .question"));
  assert.equal(await inPage(() => document.activeElement.getAttribute("aria-label")), "Delete session travel");
  assert.deepEqual(posted(helper, "pick"), [], "Keep deletes nothing");
  await row(ctx, "travel").getByRole("button", { name: "Delete session travel" }).click();
  await page.keyboard.press("Escape");
  await until("Escape keeps it", () => !document.querySelector("#list .question"));
  assert.equal(await inPage(() => document.activeElement.getAttribute("aria-label")), "Delete session travel");
  assert.deepEqual(posted(helper, "pick"), [], "Escape deletes nothing");
  await row(ctx, "travel").getByRole("button", { name: "Delete session travel" }).click();
  await row(ctx, "travel").getByRole("button", { name: "Yes, delete session travel" }).click();
  await until("the row gone", () => !document.querySelector('#list > li[data-name="travel"]'));
  assert.deepEqual(posted(helper, "pick"), [{ action: "delete", name: "travel" }]);
  assert.deepEqual(await inPage(msg), { text: 'Deleted session "travel" and its logins.', kind: "ok" });
  await clean(ctx);
});

scenario("sessions: rename the open session", { viewport: VIEW, fixtures: { sessions: SESSIONS(), session: OPEN } }, async (ctx) => {
  const { until, inPage, helper, page } = ctx;
  await until("the rows", () => document.querySelectorAll("#list > li[data-name]").length === 4);
  await row(ctx, "work").getByRole("button", { name: "Rename work" }).click();
  assert.deepEqual(await inPage(() => [document.activeElement.getAttribute("aria-label"), document.activeElement.value]), ["New name for work", "work"]);
  // Escape puts the row back, focus on Rename.
  await page.keyboard.press("Escape");
  await until("the row back", () => !document.querySelector("#list .rename") && document.activeElement?.textContent === "Rename");
  await row(ctx, "work").getByRole("button", { name: "Rename work" }).click();
  await page.keyboard.type("bad name!");
  await page.keyboard.press("Enter");
  assert.deepEqual(await inPage(msg), { text: "Session names use letters, numbers, - and _ (up to 40).", kind: "error" });
  assert.deepEqual(posted(helper, "session"), [], "a name the helper refuses is never sent");
  await page.fill("#list .rename input", "work-2026");
  await page.keyboard.press("Enter");
  await until("renamed", () => document.getElementById("msg").dataset.kind === "ok");
  assert.deepEqual(posted(helper, "session"), [{ op: "rename", name: "work-2026" }]);
  assert.deepEqual(await inPage(msg), { text: "Renamed to work-2026.", kind: "ok" });
  await until("the line follows the helper", () => document.getElementById("sub").textContent === "You're in work-2026.");
  await clean(ctx);
});

scenario("sessions: rename a saved session that isn't open (a helper that takes from)", { viewport: VIEW, fixtures: { sessions: SESSIONS(), session: { ...OPEN, canRenameSaved: true } } }, async (ctx) => {
  const { until, inPage, helper, page } = ctx;
  await until("the rows", () => document.querySelectorAll("#list > li[data-name]").length === 4);
  // Rename on every session the helper renames: the open one and the saved ones, never "default".
  assert.deepEqual((await inPage(rows)).map((r) => r.acts), [["Rename"], ["Switch", "Rename", "Delete"], ["Switch"], ["Switch", "Rename", "Delete"]]);
  await row(ctx, "shop").getByRole("button", { name: "Rename shop" }).click();
  assert.deepEqual(await inPage(() => [document.activeElement.getAttribute("aria-label"), document.activeElement.value]), ["New name for shop", "shop"]);
  // A name another session has: the helper's sentence, the field stays.
  await page.fill("#list .rename input", "travel");
  await page.keyboard.press("Enter");
  await until("refused", () => document.getElementById("msg").dataset.kind === "error");
  assert.deepEqual(await inPage(msg), { text: "Session \"travel\" already exists; choose another name.", kind: "error" });
  assert.equal(await inPage(() => document.activeElement?.getAttribute("aria-label")), "New name for shop");
  await page.fill("#list .rename input", "shop-old");
  await page.keyboard.press("Enter");
  await until("renamed", () => document.getElementById("msg").dataset.kind === "ok");
  assert.deepEqual(posted(helper, "session"), [{ op: "rename", name: "travel", from: "shop" }, { op: "rename", name: "shop-old", from: "shop" }]);
  assert.deepEqual(await inPage(msg), { text: "Renamed to shop-old.", kind: "ok" });
  await until("the list follows the helper", () => !!document.querySelector('#list > li[data-name="shop-old"]') && !document.querySelector('#list > li[data-name="shop"]'));
  assert.equal(await inPage(() => document.getElementById("sub").textContent), "You're in work.", "the open session stays");
  // The open one still goes without from (the browser reopens on it).
  await row(ctx, "work").getByRole("button", { name: "Rename work" }).click();
  await page.fill("#list .rename input", "work-2");
  await page.keyboard.press("Enter");
  await until("the line follows", () => document.getElementById("sub").textContent === "You're in work-2.");
  assert.deepEqual(posted(helper, "session").at(-1), { op: "rename", name: "work-2" });
  await clean(ctx);
});

scenario("sessions: no Rename where the helper says no", { viewport: VIEW, fixtures: { sessions: SESSIONS(), session: { ...OPEN, canRename: false } } }, async (ctx) => {
  await ctx.until("the rows", () => document.querySelectorAll("#list > li[data-name]").length === 4);
  assert.deepEqual((await ctx.inPage(rows))[0].acts, []);
  await clean(ctx);
});

scenario("sessions: a fresh session open, start fresh and join", { viewport: VIEW, fixtures: { sessions: { picking: false, sessions: SESSIONS().sessions.map((s) => ({ ...s, current: false })) }, session: { name: "Clean session", where: "Local", temporary: true } } }, async (ctx) => {
  const { until, inPage, helper, page } = ctx;
  await until("the line", () => document.getElementById("sub").textContent === "You're in a fresh session: it's deleted when you switch away.");
  assert.deepEqual((await inPage(rows)).map((r) => r.acts), [["Switch", "Delete"], ["Switch", "Delete"], ["Switch"], ["Switch", "Delete"]]);
  await page.click("#fresh");
  await until("asked", () => document.getElementById("msg").dataset.kind === "ok");
  assert.deepEqual(posted(helper, "pick"), [{ action: "new" }]);
  await page.click("#join summary");
  await until("the code field", () => document.activeElement?.id === "code");
  await page.keyboard.type("nope");
  await page.keyboard.press("Enter");
  assert.deepEqual(await inPage(msg), { text: "A join code starts with pb-join:", kind: "error" });
  await page.fill("#code", "pb-join:abc");
  await page.fill("#join-name", "Alice");
  await page.click("#join-form .primary");
  await until("joined", () => document.getElementById("msg").textContent === "Asked to join. They have to approve first.");
  assert.deepEqual(posted(helper, "pick").at(-1), { action: "join", code: "pb-join:abc", joinName: "Alice" });
  await clean(ctx);
});

scenario("sessions: many sessions get a search", { viewport: VIEW, fixtures: { session: OPEN, sessions: { picking: false, sessions: ["a1", "b2", "c3", "d4", "e5", "travel-x"].map((name) => ({ name, tabs: 0, sites: [], used: 0 })) } } }, async (ctx) => {
  const { until, inPage, page } = ctx;
  await until("the rows", () => document.querySelectorAll("#list > li[data-name]").length === 6);
  assert.equal(await inPage(() => document.getElementById("filter").checkVisibility()), true);
  await page.fill("#filter", "trav");
  assert.deepEqual((await inPage(rows)).map((r) => r.name), ["travel-x"]);
  await page.fill("#filter", "zzz");
  assert.equal(await inPage(() => document.getElementById("none").checkVisibility()), true);
  await clean(ctx);
});

scenario("sessions: no helper, the resting state", { viewport: VIEW, native: false, bridge: false }, async (ctx) => {
  const { until, inPage, helper } = ctx;
  await until("none", () => document.body.dataset.s === "none");
  assert.equal(await inPage(() => document.getElementById("sub").textContent), "No agent connected. Ask Claude Code or Codex to use PairBrowse. Your sessions show here.");
  assert.deepEqual(await inPage(() => [document.getElementById("saved").checkVisibility(), document.getElementById("fresh").checkVisibility()]), [false, false]);
  assert.deepEqual(helper.gets, []);
  assert.deepEqual(ctx.errors, []);
});
