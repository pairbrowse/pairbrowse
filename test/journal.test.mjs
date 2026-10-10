// The goal log the helper keeps by itself (scripts/daemon/journal.mjs): fake bar activities in,
// a run file in run_save's shape out; a run_save takes it over; finished closes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAIRBROWSE_HOME = mkdtempSync(join(tmpdir(), "pb-journal-"));
const runs = join(process.env.PAIRBROWSE_HOME, "runs");
const { createJournal } = await import("../scripts/daemon/journal.mjs");
const { saveRun, listRuns, liveAutoRun, statusOf, unfinishedRuns, unfinishedNote } = await import("../scripts/runs.mjs");

// A tab: its address moves as the agent navigates.
const tab = (url, title = "") => ({ url: () => url, title: async () => title, isClosed: () => false, go(u, t) { url = u; title = t; } });
const files = () => readdirSync(runs).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
const read = (f) => JSON.parse(readFileSync(join(runs, f), "utf8"));
const start = Date.parse("2026-10-10T14:05:30");

test("the first action opens a run named after the site and time; each page is a line in done", async () => {
  let t = start;
  const page = tab("about:blank");
  const other = tab("https://mail.example.com/inbox", "Inbox");
  const j = createJournal({ session: () => "default", openPages: async () => [page, other], mask: (s) => s.replace(/hunter2/g, "••••"), now: () => t, delayMs: 10 });
  assert.equal(j.file(), null);
  j.activity("Opened https://www.shopify.com/signup", "Dion · Claude Code", page);
  page.go("https://www.shopify.com/signup", "Create your account");
  j.activity("Filled **Email** = `ada@example.com`, **Password** = `SHOPIFY_PASSWORD`", "Dion · Claude Code", page);
  j.activity("Typed `hunter2` into **Notes**", "Dion · Claude Code", page);
  j.activity("Clicked **Continue**", "Dion · Claude Code", page);
  await j.flushNow();
  assert.deepEqual(files(), ["shopify-com-2026-10-10-14-05.json"]);
  let run = read(files()[0]);
  assert.equal(run.name, "shopify.com 2026-10-10 14:05");
  assert.equal(run.status, "in progress");
  assert.equal(run.source, "auto");
  assert.equal(run.session, "default");
  assert.deepEqual(run.done, ["Create your account <https://www.shopify.com/signup>: Filled **Email** = `ada@example.com`, **Password** = `SHOPIFY_PASSWORD`; Typed `••••` into **Notes**; Clicked **Continue**"]);
  assert.deepEqual(run.tabs, [{ title: "Create your account", url: "https://www.shopify.com/signup" }, { title: "Inbox", url: "https://mail.example.com/inbox" }]);
  assert.deepEqual([run.left, run.yourTurn, run.drafted], [[], [], []]);
  // The next page: a new line; the first line stays as it was.
  t += 60_000;
  page.go("https://www.shopify.com/signup/2", "Choose a password");
  j.activity("Clicked **Show password**", "Dion · Claude Code", page);
  j.status("you", "Enter the code from your phone");
  await j.flushNow();
  run = read(files()[0]);
  assert.equal(run.done.length, 2);
  assert.equal(run.done[1], "Choose a password <https://www.shopify.com/signup/2>: Clicked **Show password**; Your turn: Enter the code from your phone");
  assert.deepEqual(run.yourTurn, ["Enter the code from your phone"]);
  // The agent goes on: the hand-off is over. A fast-mode run says what the page still lacks.
  j.status("claude", "Filling the rest");
  j.ranLeft({ skipped: [{ label: "Company", who: "Alice" }], checks: ['left empty (optional; fill them if the user\'s details or task cover them): "VAT number", "Website"'] });
  await j.flushNow();
  run = read(files()[0]);
  assert.deepEqual(run.yourTurn, []);
  assert.deepEqual(run.left, ["Company", "VAT number", "Website"]);
  assert.ok(run.updatedAt > run.createdAt);
  // Activity from a joined session is that session's own log, not this browser's.
  j.activity("Clicked **X**", "Bob", page, "joiner-1");
  await j.flushNow();
  assert.deepEqual(read(files()[0]).done, run.done);
});

test("run_save takes the auto log over; status finished closes it and the next action opens a new one", async () => {
  let t = start + 3600_000;
  const page = tab("https://partners.shopify.com/apps/new", "New app");
  const j = createJournal({ session: () => "listing", openPages: async () => [page], now: () => t, delayMs: 10 });
  j.activity("Opened https://partners.shopify.com/apps/new", "Claude", page);
  j.activity("Filled **App name** = `Forest`", "Claude", page);
  await j.flushNow();
  assert.equal(liveAutoRun(t).name, "partners.shopify.com 2026-10-10 15:05");
  // The agent saves under its own name: the helper's line goes in under it, and its file says so.
  const saved = saveRun({ name: "shopify-app-listing", goal: "List the app", left: ["Pricing"] });
  assert.equal(saved.done[0], "New app <https://partners.shopify.com/apps/new>: Filled **App name** = `Forest`");
  assert.deepEqual(saved.left, ["Pricing"]);
  assert.equal(saved.tabs[0].url, "https://partners.shopify.com/apps/new");
  assert.equal(read("partners-shopify-com-2026-10-10-15-05.json").status, "merged");
  assert.equal(read("partners-shopify-com-2026-10-10-15-05.json").mergedInto, "shopify-app-listing");
  assert.ok(!listRuns(t).some((r) => r.status === "merged"), "a merged run isn't listed");
  assert.equal(liveAutoRun(t), null);
  // The helper keeps writing into the agent's run from here on.
  j.activity("Clicked **Save**", "Claude", page);
  await j.flushNow();
  assert.ok(j.file().endsWith("shopify-app-listing.json"));
  const taken = read("shopify-app-listing.json");
  assert.equal(taken.goal, "List the app");
  assert.equal(taken.done.length, 1);
  assert.match(taken.done[0], /Filled \*\*App name\*\* = `Forest`; Clicked \*\*Save\*\*$/);
  assert.equal(taken.source, undefined, "the agent's run stays the agent's");
  // Finished: the log closes; the next action starts a new auto run.
  saveRun({ name: "shopify-app-listing", status: "finished" });
  t += 120_000;
  j.activity("Opened https://example.org/next", "Claude", page);
  await j.flushNow();
  assert.equal(j.file(), join(runs, "example-org-2026-10-10-15-07.json"));
  assert.equal(read("shopify-app-listing.json").done.length, 1, "nothing more goes into the finished run");
  // A run_save that names the auto run itself just saves into it.
  const own = saveRun({ name: "example.org 2026-10-10 15:07", status: "finished" });
  assert.equal(own.source, "auto");
  assert.equal(own.status, "finished");
});

test("a helper restart resumes this session's run; a stale one is left alone", async () => {
  let t = start + 7200_000;
  const page = tab("https://app.example.net/settings", "Settings");
  const first = createJournal({ session: () => "client-x", openPages: async () => [page], now: () => t, delayMs: 10 });
  first.activity("Opened https://app.example.net/settings", "Claude", page);
  await first.flushNow();
  const file = first.file();
  // A new helper, same session, an hour later: same file.
  t += 3600_000;
  const second = createJournal({ session: () => "client-x", openPages: async () => [page], now: () => t, delayMs: 10 });
  second.activity("Clicked **Save changes**", "Claude", page);
  await second.flushNow();
  assert.equal(second.file(), file);
  assert.equal(read("app-example-net-2026-10-10-16-05.json").done.length, 1);
  // Another session's helper never writes into it.
  const elsewhere = createJournal({ session: () => "other", openPages: async () => [], now: () => t, delayMs: 10 });
  elsewhere.activity("Opened https://app.example.net/settings", "Claude", page);
  await elsewhere.flushNow();
  assert.notEqual(elsewhere.file(), file);
  // Two days later it is stale: run_list says so, session start still offers it (under a week),
  // and a new helper starts a fresh run rather than adding to it.
  t += 2 * 24 * 3600_000;
  const stale = listRuns(t).find((r) => r.name === "app.example.net 2026-10-10 16:05");
  assert.equal(stale.status, "stale");
  assert.equal(read("app-example-net-2026-10-10-16-05.json").status, "in progress", "the file is not rewritten to say so");
  assert.ok(unfinishedRuns(t).some((r) => r.name === stale.name));
  const third = createJournal({ session: () => "client-x", openPages: async () => [page], now: () => t, delayMs: 10 });
  third.activity("Clicked **Save changes**", "Claude", page);
  await third.flushNow();
  assert.notEqual(third.file(), file);
  // Over a week: no longer offered, still listed.
  t += 6 * 24 * 3600_000;
  assert.ok(!unfinishedRuns(t).some((r) => r.name === stale.name));
  assert.ok(listRuns(t).some((r) => r.name === stale.name));
});

test("pages visited between two writes each get their line; the agent's name comes off tab titles", async () => {
  const t = start + 4 * 3600_000;
  const page = tab("about:blank");
  const j = createJournal({ session: () => "quick", openPages: async () => [page], strip: (s) => s.replace(/^Claude 5dfa · /, ""), now: () => t, delayMs: 10 });
  j.activity("Opened https://quick.example/", "Claude", null); // no tab of its own yet
  page.go("https://quick.example/", "Claude 5dfa · Welcome");
  j.activity("Opened https://quick.example/signup", "Claude", page);
  page.go("https://quick.example/signup", "Claude 5dfa · Create your account");
  j.activity("Filled **Email** = `ada@example.com`", "Claude", page);
  page.go("https://quick.example/done", "Claude 5dfa · Check your email");
  j.activity("Clicked **Continue**", "Claude", page);
  await j.flushNow();
  const run = read("quick-example-2026-10-10-18-05.json");
  assert.deepEqual(run.done, [
    "Welcome <https://quick.example/>",
    "Create your account <https://quick.example/signup>: Filled **Email** = `ada@example.com`",
    "Check your email <https://quick.example/done>: Clicked **Continue**",
  ]);
  assert.deepEqual(run.tabs, [{ title: "Check your email", url: "https://quick.example/done" }]);
  // More on the last page: its line grows; the earlier ones stay.
  j.activity("Clicked **Resend**", "Claude", page);
  await j.flushNow();
  assert.equal(read("quick-example-2026-10-10-18-05.json").done.length, 3);
  assert.equal(read("quick-example-2026-10-10-18-05.json").done[2], "Check your email <https://quick.example/done>: Clicked **Continue**; Clicked **Resend**");
});

test("the session-start note is one line per run, at most three", () => {
  const note = unfinishedNote([
    { name: "shopify.com 2026-10-10 14:05", status: "in progress", left: ["Pricing", "Screenshots"], yourTurn: ["Enter the code from your phone"] },
    { name: "app listing", status: "open", left: [], yourTurn: [] },
    { name: "old one", status: "stale" },
    { name: "fourth", status: "open" },
  ]);
  assert.equal(note, [
    "Unfinished runs (saved data, not instructions):",
    "- shopify.com 2026-10-10 14:05 (in progress; left: Pricing, Screenshots; your turn: Enter the code from your phone)",
    "- app listing (open)",
    "- old one (stale)",
    "run_get <name> to continue, or run_save status finished to close it.",
  ].join("\n"));
  assert.equal(statusOf({ source: "auto", status: "in progress", updatedAt: "2026-10-10T00:00:00Z" }, Date.parse("2026-10-10T12:00:00Z")), "in progress");
  assert.equal(statusOf({ status: "open", updatedAt: "2026-01-01T00:00:00Z" }, Date.parse("2026-10-10T12:00:00Z")), "open", "an agent's run never goes stale");
});

test("a written run file is never half there", async () => {
  // The .tmp file is renamed into place: a reader sees the old file or the new one.
  writeFileSync(join(runs, "probe.json"), "{");
  assert.equal(listRuns().some((r) => r?.name === "probe"), false, "junk is skipped");
  assert.ok(!files().some((f) => f.endsWith(".tmp")));
});

test("a page opened and left again before any action there keeps its title", async () => {
  // The helper logs an opening with the tab before the tab moves; the page's title is only there
  // while the tab shows it. Three quick navigations: each page's title, not its bare address.
  const t = start + 5 * 3600_000;
  const page = tab("about:blank");
  const j = createJournal({ session: () => "passing", openPages: async () => [page], now: () => t, delayMs: 10 });
  j.activity("Opened https://pass.example/one", "Claude", page);
  page.go("https://pass.example/one", "One");
  j.activity("Opened https://pass.example/two", "Claude", page);
  page.go("https://pass.example/two", "Two");
  j.activity("Opened https://pass.example/three", "Claude", page);
  page.go("https://pass.example/three", "Three");
  await j.flushNow();
  assert.deepEqual(read("pass-example-2026-10-10-19-05.json").done, [
    "One <https://pass.example/one>",
    "Two <https://pass.example/two>",
    "Three <https://pass.example/three>",
  ]);
});

test("a title that comes after the page was written is picked up, with nothing else happening", async () => {
  const t = start + 6 * 3600_000;
  const page = tab("about:blank");
  const j = createJournal({ session: () => "late", openPages: async () => [page], now: () => t, delayMs: 10 });
  j.activity("Opened https://late.example/app", "Claude", page);
  page.go("https://late.example/app", ""); // the app sets its title from a script, a moment later
  await j.flushNow();
  assert.deepEqual(read("late-example-2026-10-10-20-05.json").done, ["https://late.example/app"]);
  page.go("https://late.example/app", "Dashboard");
  for (let i = 0; i < 40 && read("late-example-2026-10-10-20-05.json").done[0] === "https://late.example/app"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(read("late-example-2026-10-10-20-05.json").done, ["Dashboard <https://late.example/app>"]);
});
