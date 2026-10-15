// Activity (ui/activity/, pairbrowse://activity; opened from the left dock's Activity row) over the
// pages' harness: the helper's activity lines newest first, grouped by day, each with its time, who
// (the board's or the collaboration's color dot and name), what (common.js rich, as text) and the
// tab; the filter by who (All, each agent, People); live lines from the stream with nothing ticking;
// the lines it saw kept while open; messages between participants (the log's and the board's,
// one line each, clipped when long, as text); the session's history (GET activity.json: the newest page on
// open, "Show earlier" for the next, merged with the stream's lines without duplicates; a helper
// without the route); the empty state; markup in a line stays text; the tab page's one interface
// (Session); the resting state without a helper. The common checks are in test/ui.test.mjs.
import { describe } from "node:test";
import assert from "node:assert/strict";
import { pageTest } from "./helpers/ui-page.mjs";

const scenario = (title, opts, fn) => describe(title, () => pageTest("activity", opts, fn));
const VIEW = { width: 969, height: 796 };
const DAY = 86_400_000;
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const T = (() => {
  const now = Date.now(), start = today0();
  return { a: now - 1000, b: now - 2000, y: start - 3600_000, old: start - 3 * DAY + 3600_000 };
})();
const LINES = [
  { t: T.old, who: "Claude", tab: "Docs", text: "Opened `docs.example`" },
  { t: T.y, who: "You", tab: "Shop", text: "Took over" },
  { t: T.y + 1000, who: "Alice · Codex", tab: "", text: "Typed into **Email**" },
  { t: T.b, who: "Dana", tab: "Shop", text: "Joined", from: "k1" },
  { t: T.a, who: "Claude", tab: "Shop", text: "Clicked **Pay**" },
];
const BOARD = { people: [
  { who: "Claude", kind: "agent", color: "#e9763f", status: "working" },
  { who: "Alice · Codex", kind: "agent", color: "#4fd1e8", status: "idle" },
  { who: "You", kind: "person", status: "idle" },
] };
const COLLAB = { participants: [], owner: { label: "You" }, active: null, guests: [{ label: "Dana", role: "watch" }] };
const FIX = { activity: LINES, board: BOARD, collaboration: COLLAB };

const view = () => ({
  days: [...document.querySelectorAll("#log .day")].map((d) => ({ h: d.querySelector("h2").textContent, n: d.querySelectorAll("li").length, labelled: d.querySelector("ol").getAttribute("aria-labelledby") === d.querySelector("h2").id })),
  rows: [...document.querySelectorAll("#log li")].map((li) => ({ head: li.querySelector(".who")?.textContent || "", text: li.querySelector(".what").textContent, kind: li.dataset.kind })),
  chips: [...document.querySelectorAll("#filter .chip")].map((b) => `${b.textContent}${b.getAttribute("aria-pressed") === "true" ? "*" : ""}`),
  empty: document.getElementById("empty").checkVisibility(),
});
const token = (name) => { const s = document.createElement("span"); s.style.color = `var(${name})`; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); return c; };
async function clean(ctx) {
  assert.deepEqual(ctx.errors, []);
  const bad = (await ctx.harness.log()).filter((e) => ["error", "pageerror", "rejection", "csp"].includes(e.kind));
  assert.deepEqual(bad, []);
}

scenario("activity: newest first, by day, who and where", { viewport: VIEW, fixtures: FIX }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("the lines", () => document.querySelectorAll("#log li").length === 5);
  const v = await inPage(view);
  const older = await inPage((t) => new Date(t).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) }), T.old);
  assert.deepEqual(v.days, [{ h: "Today", n: 2, labelled: true }, { h: "Yesterday", n: 2, labelled: true }, { h: older, n: 1, labelled: true }]);
  assert.deepEqual(v.rows, [
    { head: "Claude in Shop: ", text: "Claude in Shop: Clicked Pay", kind: "agent" },
    { head: "Dana in Shop: ", text: "Dana in Shop: Joined", kind: "person" },
    { head: "Alice · Codex: ", text: "Alice · Codex: Typed into Email", kind: "agent" },
    { head: "You in Shop: ", text: "You in Shop: Took over", kind: "person" },
    { head: "Claude in Docs: ", text: "Claude in Docs: Opened docs.example", kind: "agent" },
  ]);
  // The time of each line as the docks show it, with its machine-readable instant.
  const first = await inPage(() => { const t = document.querySelector("#log li time"); return { text: t.textContent, dt: t.dateTime }; });
  assert.equal(first.dt, new Date(T.a).toISOString());
  assert.match(first.text, /\d{1,2}:\d{2}:\d{2}/);
  // rich(): **bold** a strong, `code` a code, both as text.
  assert.deepEqual(await inPage(() => [...document.querySelectorAll("#log li .what strong:not(.who), #log li .what code")].map((n) => `${n.tagName}:${n.textContent}`)), ["STRONG:Pay", "STRONG:Email", "CODE:docs.example"]);
  // The who dot: the helper's color for an agent, --muted when it gives none.
  const dots = await inPage(() => [...document.querySelectorAll("#log li .dot")].map((d) => getComputedStyle(d).backgroundColor));
  const muted = await inPage(token, "--muted");
  assert.deepEqual(dots, ["rgb(233, 118, 63)", muted, "rgb(79, 209, 232)", muted, "rgb(233, 118, 63)"]);
  assert.deepEqual(v.chips, ["All*", "Claude", "Alice · Codex", "People"]);
  assert.equal(v.empty, false);
  assert.equal(await inPage(() => document.getElementById("note").checkVisibility()), true);
  assert.equal(await inPage(() => document.getElementById("note").textContent), "PairBrowse keeps this session's last 2,000 actions, up to 7 days, on this computer only.");
  assert.equal(await inPage(() => document.getElementById("earlier").checkVisibility()), false, "nothing older");
  // A tab page: the browser binds Session only, so nothing else is asked of it; one route: the log's newest page.
  assert.deepEqual((await ctx.shim.calls()).filter((c) => c.iface !== "session"), []);
  assert.deepEqual(ctx.helper.gets.filter((g) => g !== "events"), ["activity.json"]);
  assert.deepEqual(ctx.helper.activityQueries, ["limit=100"]);
  const live = await ctx.harness.live();
  assert.equal(live.intervals + live.timeouts, 0, "nothing ticks");
  await clean(ctx);
});

scenario("activity: the filter by who", { viewport: VIEW, fixtures: FIX }, async (ctx) => {
  const { until, inPage, page } = ctx;
  await until("the lines", () => document.querySelectorAll("#log li").length === 5);
  assert.equal(await inPage(() => document.getElementById("filter").getAttribute("role")), "group");
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await until("Claude's", () => document.querySelectorAll("#log li").length === 2);
  let v = await inPage(view);
  assert.deepEqual(v.rows.map((r) => r.head), ["Claude in Shop: ", "Claude in Docs: "]);
  assert.deepEqual(v.chips, ["All", "Claude*", "Alice · Codex", "People"]);
  assert.deepEqual(v.days.map((d) => d.h).slice(0, 1), ["Today"], "a day with none of them has no heading");
  assert.equal(v.days.length, 2);
  assert.equal(await inPage(() => document.activeElement?.textContent), "Claude", "the pressed chip keeps the focus");
  await page.getByRole("button", { name: "People" }).click();
  await until("people's", () => document.querySelectorAll("#log li").length === 2 && [...document.querySelectorAll("#log li")].every((li) => li.dataset.kind === "person"));
  v = await inPage(view);
  assert.deepEqual(v.rows.map((r) => r.head), ["Dana in Shop: ", "You in Shop: "]);
  // A new line of someone else keeps the filter; one of theirs shows.
  ctx.helper.push("activity", [...LINES, { t: Date.now(), who: "Alice · Codex", tab: "Shop", text: "Scrolled" }]);
  await page.waitForTimeout(200);
  assert.equal(await inPage(() => document.querySelectorAll("#log li").length), 2);
  await page.getByRole("button", { name: "All" }).click();
  await until("all", () => document.querySelectorAll("#log li").length === 6);
  assert.equal(await inPage(() => document.querySelector("#filter [aria-pressed=true]").textContent), "All");
  // Keyboard: the chips are buttons in the Tab order.
  await page.focus("#filter .chip");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await until("Alice first now", () => document.querySelector("#filter [aria-pressed=true]")?.textContent === "Alice · Codex");
  await clean(ctx);
});

scenario("activity: live lines from the stream, kept while open", { viewport: VIEW, fixtures: FIX }, async (ctx) => {
  const { until, inPage, helper } = ctx;
  await until("the lines", () => document.querySelectorAll("#log li").length === 5);
  // The helper sends its latest lines whole each time: a line already here is not shown twice,
  // and one it no longer sends stays while the page is open.
  helper.push("activity", [...LINES.slice(2), { t: Date.now(), who: "Claude", tab: "Cart", text: "Typed into **Card**" }]);
  await until("the new line on top", () => document.querySelector("#log li .who")?.textContent === "Claude in Cart: ");
  assert.equal(await inPage(() => document.querySelectorAll("#log li").length), 6);
  assert.deepEqual((await inPage(view)).rows.map((r) => r.head).slice(-2), ["You in Shop: ", "Claude in Docs: "], "the older lines stay");
  helper.push("activity", [...LINES]);
  await ctx.page.waitForTimeout(150);
  assert.equal(await inPage(() => document.querySelectorAll("#log li").length), 6, "no duplicates");
  // A color the board gives later follows.
  helper.push("board", { people: [...BOARD.people, { who: "Dana", kind: "person", color: "#d68aff" }] });
  await until("Dana's color", () => getComputedStyle([...document.querySelectorAll("#log li")].find((li) => li.dataset.who === "Dana").querySelector(".dot")).backgroundColor === "rgb(214, 138, 255)");
  await ctx.settle();
  const live = await ctx.harness.live();
  assert.equal(live.intervals + live.timeouts, 0, "no poll, no timer");
  assert.equal(live.eventSources, 1, "the one stream");
  assert.deepEqual(helper.gets.filter((g) => g !== "events"), ["activity.json"], "the log read once, on open");
  await clean(ctx);
});

// The helper's log: 330 lines a minute apart ending an hour ago, the stream's latest 30 among them
// plus one only the stream has (said after the page asked).
const HOUR = 3600_000;
const LOG = Array.from({ length: 330 }, (_, i) => ({ t: Date.now() - HOUR - (329 - i) * 60_000, who: i % 2 ? "Claude" : "Alice · Codex", tab: "Shop", text: `Step ${i}` }));
const rowsNow = () => [...document.querySelectorAll("#log li .what")].map((w) => w.textContent.replace(/^.*?: /, ""));

scenario("activity: the session's history, a page at a time, merged with the stream", { viewport: VIEW, fixtures: { history: LOG, activity: LOG.slice(-30), board: BOARD } }, async (ctx) => {
  const { until, inPage, helper, page } = ctx;
  await until("the newest page", () => document.querySelectorAll("#log li").length === 100);
  let rows = await inPage(rowsNow);
  assert.equal(rows[0], "Step 329");
  assert.equal(rows.at(-1), "Step 230");
  assert.equal(new Set(rows).size, 100, "the stream's 30 and the log's newest 100: each once");
  assert.deepEqual(helper.activityQueries, ["limit=100"]);
  const earlier = page.getByRole("button", { name: "Show earlier" });
  assert.equal(await earlier.isVisible(), true);
  // History comes in placed, never grown in like a live line.
  assert.equal(await inPage(() => document.querySelectorAll("#log li[data-entering]").length), 0);
  // A live line on top while the history is there.
  helper.push("activity", [...LOG.slice(-29), { t: Date.now(), who: "Claude", tab: "Cart", text: "Paid" }]);
  await until("the live line", () => document.querySelectorAll("#log li").length === 101);
  // Show earlier: the next 200 before the oldest shown, then the last 30; then the button goes.
  await earlier.click();
  await until("200 more", () => document.querySelectorAll("#log li").length === 301);
  assert.equal(helper.activityQueries[1], `limit=200&before=${LOG[230].t}`);
  rows = await inPage(rowsNow);
  assert.deepEqual([rows[0], rows[1], rows.at(-1)], ["Paid", "Step 329", "Step 30"]);
  assert.equal(await inPage(() => document.activeElement?.id), "earlier", "the button keeps the focus");
  await earlier.click();
  await until("all of it", () => document.querySelectorAll("#log li").length === 331);
  assert.equal(helper.activityQueries[2], `limit=200&before=${LOG[30].t}`);
  assert.equal(await inPage(() => document.getElementById("earlier").checkVisibility()), false, "nothing older now");
  assert.equal(await inPage(() => document.activeElement?.closest("li") === [...document.querySelectorAll("#log li")].at(-1)), true, "the focus on the oldest line");
  assert.equal(new Set(await inPage(rowsNow)).size, 331, "no line twice");
  // The filter works over the history too.
  await page.getByRole("button", { name: "Alice · Codex" }).click();
  await until("Alice's", () => document.querySelectorAll("#log li").length === 165);
  const live = await ctx.harness.live();
  assert.equal(live.intervals + live.timeouts, 0, "no poll, no timer");
  assert.equal(helper.gets.filter((g) => g === "activity.json").length, 3, "one read per page, nothing else");
  await clean(ctx);
});

// A helper that takes the request and never answers: the read gives up (8 s) and says so, and
// Show earlier works again; never a button busy for ever.
scenario("activity: a history read that never answers gives up and says so", { viewport: VIEW, timeout: 60_000, fixtures: { history: LOG, activity: LOG.slice(-30) } }, async (ctx) => {
  const { until, inPage, page } = ctx;
  await until("the newest page", () => document.querySelectorAll("#log li").length === 100);
  await inPage(() => {
    const real = window.fetch;
    window.__signals = [];
    window.fetch = (u, init) => {
      if (!String(u).includes("activity.json")) return real(u, init);
      window.__signals.push(!!init?.signal);
      return new Promise((_, no) => init?.signal?.addEventListener("abort", () => no(init.signal.reason)));
    };
  });
  await page.getByRole("button", { name: "Show earlier" }).click();
  await page.waitForFunction(() => document.getElementById("msg").textContent === "PairBrowse didn't send the earlier actions. Try again.", null, { timeout: 12_000 });
  assert.deepEqual(await inPage(() => window.__signals), [true]);
  assert.equal(await inPage(() => document.getElementById("earlier").getAttribute("aria-busy")), null, "not busy any more");
  await clean(ctx);
});

scenario("activity: the stream back after a drop reads the newest page again", { viewport: VIEW, fixtures: { history: LOG, activity: LOG.slice(-30) } }, async (ctx) => {
  const { until, helper } = ctx;
  await until("the newest page", () => document.querySelectorAll("#log li").length === 100);
  helper.fixtures.history = [...LOG, ...Array.from({ length: 40 }, (_, i) => ({ t: Date.now() - 1000 + i, who: "Claude", tab: "Shop", text: `Away ${i}` }))];
  helper.setDown(true);
  await until("connecting", () => document.body.dataset.s !== "live");
  helper.setDown(false);
  await until("the lines said while away", () => document.querySelectorAll("#log li").length === 140);
  assert.deepEqual(helper.activityQueries, ["limit=100", "limit=100"]);
  await clean(ctx);
});

scenario("activity: a clean session's log, and a helper without the route", { viewport: VIEW, fixtures: { activity: LINES, kept: { lines: 2000, days: 7, saved: false } } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("the note", () => document.getElementById("note").textContent.startsWith("A clean"));
  assert.equal(await inPage(() => document.getElementById("note").textContent), "A clean session's actions are kept while PairBrowse runs: the last 2,000 actions, up to 7 days.");
  await clean(ctx);
});

scenario("activity: an older helper (no activity.json): the stream's lines alone", { viewport: VIEW, fixtures: { activity: LINES, history: false } }, async (ctx) => {
  const { until, inPage, helper } = ctx;
  await until("the lines", () => document.querySelectorAll("#log li").length === 5);
  for (let i = 0; i < 100 && !helper.activityQueries.length; i++) await ctx.page.waitForTimeout(50);
  assert.equal(helper.activityQueries.length, 1);
  await ctx.settle();
  assert.deepEqual(await inPage(() => ({ note: document.getElementById("note").textContent, earlier: document.getElementById("earlier").checkVisibility(), msg: document.getElementById("msg").textContent })),
    { note: "Showing the actions PairBrowse sent while this page was open.", earlier: false, msg: "" });
  assert.deepEqual(ctx.errors.filter((e) => !/404/.test(String(e))), []);
});

scenario("activity: nothing yet", { viewport: VIEW }, async (ctx) => {
  const { until, inPage, helper } = ctx;
  await until("live", () => document.body.dataset.s === "live");
  assert.deepEqual(await inPage(() => ({ empty: document.getElementById("empty").checkVisibility(), text: document.getElementById("empty").textContent, filter: document.getElementById("filter").checkVisibility(), note: document.getElementById("note").checkVisibility(), rows: document.querySelectorAll("#log li").length })),
    { empty: true, text: "Nothing yet", filter: false, note: false, rows: 0 });
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("empty")).color), await inPage(token, "--muted"));
  helper.push("activity", [{ t: Date.now(), who: "Claude", tab: "Shop", text: "Opened the page" }]);
  await until("a line", () => document.querySelectorAll("#log li").length === 1);
  assert.deepEqual(await inPage(() => [document.getElementById("empty").checkVisibility(), document.getElementById("filter").checkVisibility()]), [false, true]);
  assert.deepEqual((await inPage(view)).chips, ["All*", "Claude"]);
  // Lines the helper would never send (no time, no text) are not drawn.
  helper.push("activity", [{ who: "Claude", text: "no time" }, { t: Date.now(), who: "Claude", text: "" }, null, "x"]);
  await ctx.page.waitForTimeout(150);
  assert.equal(await inPage(() => document.querySelectorAll("#log li").length), 1);
  await clean(ctx);
});

scenario("activity: markup in a line stays text", { viewport: VIEW, fixtures: { activity: [
  { t: Date.now(), who: "<img src=x onerror=alert(1)>", tab: "<b>Tab</b>", text: "Typed <script>alert(1)</script> and **<i>bold</i>** in `<svg onload=alert(1)>`" },
] } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("the line", () => document.querySelectorAll("#log li").length === 1);
  const got = await inPage(() => ({
    tags: [...document.querySelectorAll("#log li *")].map((n) => n.tagName),
    head: document.querySelector("#log li .who").textContent,
    strong: document.querySelector("#log li .what strong:not(.who)").textContent,
    code: document.querySelector("#log li .what code").textContent,
    chip: document.querySelectorAll("#filter .chip")[1].textContent,
  }));
  assert.deepEqual(got.tags, ["TIME", "SPAN", "SPAN", "STRONG", "STRONG", "CODE"], "no element from the line's text");
  assert.equal(got.head, "<img src=x onerror=alert(1)> in <b>Tab</b>: ");
  assert.equal(got.strong, "<i>bold</i>");
  assert.equal(got.code, "<svg onload=alert(1)>");
  assert.equal(got.chip, "<img src=x onerror=alert(1)>");
  await clean(ctx);
});

// Messages between participants: in the log as lines of their own kind, live from the board's
// messages (the helper gives each the log's time, so the two are one line).
const M = (() => { const now = Date.now(); return { a: now - 30_000, b: now - 20_000, c: now - 10_000 }; })();
const LONG = `Taking the checkout tab. ${"Then the shipping form, then billing. ".repeat(12)}Done after that.`;
const MSG_HISTORY = [
  { t: M.a, who: "Claude", tab: "Shop", text: "Clicked **Pay**" },
  { t: M.b, kind: "message", who: "Claude", to: "Alice · Codex", text: "I'll take **the checkout** tab", tab: "" },
  { t: M.c, kind: "message", who: "Alice · Codex", to: "all", text: LONG, tab: "" },
];
scenario("activity: messages between participants, by time with the rest", { viewport: VIEW, fixtures: { history: MSG_HISTORY, activity: MSG_HISTORY.slice(0, 1), board: { ...BOARD, messages: [{ from: "Claude", to: "Alice · Codex", text: "I'll take **the checkout** tab", t: M.b }] } } }, async (ctx) => {
  const { until, inPage, helper, page } = ctx;
  await until("the lines", () => document.querySelectorAll("#log li").length === 3);
  const rows = () => [...document.querySelectorAll("#log li")].map((li) => ({ type: li.dataset.type || "", kind: li.dataset.kind, head: li.querySelector(".who")?.textContent || "", said: li.querySelector(".said")?.textContent ?? null, dot: getComputedStyle(li.querySelector(".dot")).backgroundColor }));
  let v = await inPage(rows);
  assert.equal(v.length, 3, "the board's copy and the log's are one line");
  assert.deepEqual(v.map((r) => [r.type, r.head]), [["message", "Alice · Codex to everyone: "], ["message", "Claude to Alice · Codex: "], ["", "Claude in Shop: "]]);
  assert.equal(v[1].said, "I'll take **the checkout** tab", "a message's words as written, nothing styled");
  assert.equal(await inPage(() => document.querySelectorAll("#log li[data-type=message] .what strong:not(.who), #log li[data-type=message] code").length), 0);
  assert.deepEqual(v.map((r) => r.dot), ["rgb(79, 209, 232)", "rgb(233, 118, 63)", "rgb(233, 118, 63)"], "the sender's color, as other rows");
  assert.equal(v[0].kind, "agent");
  // A long one: clipped, "Show all" shows it whole, "Show less" clips it again.
  assert.ok(v[0].said.length < LONG.length && v[0].said.endsWith("…"));
  const all = page.getByRole("button", { name: "Show all" });
  assert.equal(await all.getAttribute("aria-expanded"), "false");
  await all.click();
  assert.equal(await inPage(() => document.querySelector("#log li .said").textContent), LONG);
  const less = page.getByRole("button", { name: "Show less" });
  assert.equal(await less.getAttribute("aria-expanded"), "true");
  // Whole stays whole when another line comes in (the list is redrawn).
  helper.push("board", { ...BOARD, messages: [{ from: "Claude", to: "Alice · Codex", text: "I'll take **the checkout** tab", t: M.b }, { from: "Claude", to: "all", text: "Checkout done", t: Date.now() }] });
  await until("the live message on top", () => document.querySelector("#log li .said")?.textContent === "Checkout done");
  assert.equal(await inPage(() => document.querySelectorAll("#log li").length), 4);
  assert.equal(await inPage(() => document.querySelectorAll("#log li .said")[1].textContent), LONG);
  await page.getByRole("button", { name: "Show less" }).click();
  assert.ok((await inPage(() => document.querySelectorAll("#log li .said")[1].textContent)).endsWith("…"));
  // The filter: a message is its sender's.
  await page.getByRole("button", { name: "Alice · Codex" }).click();
  await until("Alice's", () => document.querySelectorAll("#log li").length === 1);
  v = await inPage(rows);
  assert.equal(v[0].head, "Alice · Codex to everyone: ");
  const live = await ctx.harness.live();
  assert.equal(live.intervals + live.timeouts, 0, "no poll, no timer");
  await clean(ctx);
});

scenario("activity: a message's markup stays text", { viewport: VIEW, fixtures: { history: [
  { t: Date.now() - 5000, kind: "message", who: "<b>Mallory</b>", to: "<i>all</i>", text: "<img src=x onerror=\"document.title='pwned'\"> **bold** `code`", tab: "" },
], activity: [], board: { people: [], messages: [{ from: "Eve", to: "all", text: "<script>document.title='pwned'</script>", t: Date.now() }] } } }, async (ctx) => {
  const { until, inPage } = ctx;
  await until("the messages", () => document.querySelectorAll("#log li").length === 2);
  const got = await inPage(() => ({
    tags: [...document.querySelectorAll("#log li *")].map((n) => n.tagName),
    said: [...document.querySelectorAll("#log li .said")].map((n) => n.textContent),
    heads: [...document.querySelectorAll("#log li .who")].map((n) => n.textContent),
    title: document.title,
  }));
  assert.deepEqual(got.tags, ["TIME", "SPAN", "SPAN", "STRONG", "SPAN", "TIME", "SPAN", "SPAN", "STRONG", "SPAN"], "no element from a message");
  assert.deepEqual(got.said, ["<script>document.title='pwned'</script>", "<img src=x onerror=\"document.title='pwned'\"> **bold** `code`"]);
  assert.deepEqual(got.heads, ["Eve to everyone: ", "<b>Mallory</b> to <i>all</i>: "]);
  assert.equal(got.title, "Activity");
  await clean(ctx);
});

scenario("activity: no helper, the resting state", { viewport: VIEW, native: false, bridge: false }, async (ctx) => {
  const { until, inPage, helper } = ctx;
  await until("none", () => document.body.dataset.s === "none");
  assert.equal(await inPage(() => document.getElementById("sub").textContent), "No agent connected. Ask Claude Code or Codex to use PairBrowse. The session's actions show here.");
  assert.deepEqual(await inPage(() => ["log", "filter", "empty", "note", "earlier"].map((id) => document.getElementById(id).checkVisibility())), [false, false, false, false, false]);
  assert.deepEqual(helper.gets, []);
  assert.deepEqual(ctx.errors, []);
});
