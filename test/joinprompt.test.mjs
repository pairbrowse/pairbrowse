// A join request's alert, the helper side (daemon/joinprompt.mjs): the bottom bar or a
// notification (one at a time), where the bar asks, and which answers count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApprovals, newJoinerId } from "../scripts/join.mjs";
import { createJoinPrompt, shouldNotify, ARM_MS, FOCUS_POLL_MS } from "../scripts/daemon/joinprompt.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakePage = (name) => ({ name, closed: false, isClosed() { return this.closed; } });

function setup({ front = null, byPerson = () => true, focus = { now: true } } = {}) {
  const approvals = createApprovals();
  const calls = [];
  const answers = new Map(); // page -> the chain the page script would hand over
  const show = async (page, value, kind) => {
    calls.push({ page: page.name, value, kind });
    if (kind === "join") return true;
    if (kind === "join-answers") { const a = answers.get(page) || null, gone = page.gone || ""; answers.delete(page); page.gone = ""; return { a, open: 1, gone }; }
    return true;
  };
  const notes = [], cleared = [];
  const prompt = createJoinPrompt({ approvals, front: async () => front, focused: async () => focus.now, show, byPerson, notify: (n) => notes.push(n), clear: (id) => cleared.push(id) });
  // As sharing.mjs does: the request, then its alert.
  const ask = (name = "Sam", role = "drive") => { const { entry } = approvals.check({ id: "i1", role }, newJoinerId(), name, "claude-code"); prompt.alert(entry); return entry.id; };
  return { approvals, calls, answers, prompt, ask, notes, cleared };
}

test("a request shows once, in the tab in front, with who asks and how", async () => {
  const front = fakePage("front");
  const { calls, prompt, ask } = setup({ front });
  const id = ask("Sam", "watch");
  await prompt.refresh();
  const shown = calls.filter((c) => c.kind === "join");
  assert.deepEqual(shown, [{ page: "front", value: { id, who: "Sam (Claude Code)", role: "watch" }, kind: "join" }]);
  await prompt.refresh();
  assert.equal(calls.filter((c) => c.kind === "join").length, 1, "never shown twice");
});

test("no tab in front: nothing shown (the side panel still asks)", async () => {
  const { calls, prompt, ask } = setup({ front: null });
  ask();
  await prompt.refresh();
  assert.equal(calls.length, 0);
  assert.deepEqual(prompt.shown(), []);
});

test("only a person's click, in that tab, once armed, for a waiting request, answers it", async () => {
  const front = fakePage("front"), other = fakePage("other");
  let person = true;
  const { approvals, prompt, ask } = setup({ front, byPerson: () => person });
  const id = ask();
  await prompt.refresh();
  const now = Date.now();
  assert.equal(prompt.answer("join-allow", id, front, now), null, "too soon after it showed");
  await sleep(ARM_MS + 50);
  assert.equal(prompt.answer("join-allow", id, other, Date.now()), null, "another tab");
  assert.equal(prompt.answer("join-allow", "r000000", front, Date.now()), null, "another request");
  assert.equal(prompt.answer("approve", id, front, Date.now()), null, "an unknown kind");
  person = false;
  assert.equal(prompt.answer("join-allow", id, front, Date.now()), null, "an agent's or replayed click");
  person = true;
  assert.equal(prompt.answer("join-allow", id, front, Date.now() + 60_000)?.state, "approved", "a time from the future counts as now");
  assert.equal(approvals.pending().length, 0, "let in");
  assert.equal(approvals.list()[0].state, "approved");
  assert.equal(prompt.answer("join-deny", id, front, Date.now()), null, "answered already");
});

test("answered elsewhere: the prompt comes down; a Deny from it turns them away", async () => {
  const front = fakePage("front");
  const { approvals, calls, answers, prompt, ask } = setup({ front });
  const a = ask("Ann"), b = ask("Bo");
  await prompt.refresh();
  approvals.approve(a); // the side panel's Allow
  await prompt.refresh();
  assert.ok(calls.some((c) => c.kind === "join-off" && c.value === a));
  await sleep(ARM_MS + 50);
  // The page hands over a Deny (as hud.js records it): read by the helper's poll.
  answers.set(front, { t: Date.now(), kind: "join-deny", what: b, next: null });
  await sleep(700);
  assert.equal(approvals.list().find((r) => r.id === b).state, "denied");
  await prompt.refresh();
  assert.ok(calls.some((c) => c.kind === "join-off" && c.value === b));
  assert.deepEqual(prompt.shown(), []);
});

test("one alert at a time: the rule", () => {
  assert.equal(shouldNotify({ focused: true, shown: true }), false, "looking at the browser, the bar asked");
  assert.equal(shouldNotify({ focused: false, shown: false }), true, "another app in front, or minimized");
  assert.equal(shouldNotify({ focused: true, shown: false }), true, "no web page in front");
  assert.equal(shouldNotify({ focused: null, shown: true }), true, "the browser can't say: both");
});

test("focused, a web page in front: the bar asks, no notification", async () => {
  const front = fakePage("front");
  const { calls, prompt, ask, notes } = setup({ front });
  const id = ask();
  await prompt.refresh();
  assert.deepEqual(prompt.shown(), [id]);
  assert.equal(calls.filter((c) => c.kind === "join").length, 1);
  assert.deepEqual(notes, []);
});

test("not focused: a notification (once), and the bar asks once the browser comes to the front", async () => {
  const front = fakePage("front");
  const focus = { now: false };
  const { approvals, calls, prompt, ask, notes, cleared } = setup({ front, focus });
  const id = ask("Ann", "watch");
  await prompt.refresh();
  assert.deepEqual(notes, [{ who: "Ann (Claude Code)", role: "watch", request: id }]);
  assert.equal(calls.filter((c) => c.kind === "join").length, 0, "nothing in a page no one looks at");
  assert.deepEqual(prompt.unseen(), [id]);
  await prompt.refresh();
  assert.equal(notes.length, 1, "never twice");
  focus.now = true; // the person comes back: the focus poll finds it
  await sleep(FOCUS_POLL_MS + 300);
  assert.deepEqual(prompt.shown(), [id], "the bar asks for the request still waiting");
  assert.equal(notes.length, 1);
  approvals.deny(id); // answered (here: the side panel): the notification goes too
  await prompt.refresh();
  assert.deepEqual(cleared, [id]);
});

test("focused but no web page in front (a new tab page, the picker): a notification", async () => {
  const { prompt, ask, notes } = setup({ front: null });
  const id = ask();
  await prompt.refresh();
  assert.deepEqual(notes.map((n) => n.request), [id]);
});

test("answered while the person was away: the bar never asks", async () => {
  const focus = { now: false };
  const { approvals, calls, prompt, ask } = setup({ front: fakePage("front"), focus });
  const id = ask();
  await prompt.refresh();
  approvals.approve(id);
  focus.now = true;
  await prompt.refresh();
  assert.equal(calls.filter((c) => c.kind === "join").length, 0);
  assert.deepEqual(prompt.unseen(), []);
});

test("its time in the bar ran out while the browser wasn't focused: it asks again on return; not when it was", async () => {
  const front = fakePage("front");
  const focus = { now: true };
  const { calls, prompt, ask, notes } = setup({ front, focus });
  const asks = () => calls.filter((c) => c.kind === "join").length;
  const id = ask();
  await prompt.refresh();
  assert.equal(asks(), 1);
  focus.now = false; // the person went to another app
  await sleep(FOCUS_POLL_MS + 300);
  front.gone = id; // the page reports its time ran out
  await sleep(700);
  assert.deepEqual(prompt.shown(), []);
  assert.deepEqual(prompt.unseen(), [id], "waits for the person to come back");
  await sleep(FOCUS_POLL_MS + 300);
  assert.deepEqual(notes.map((n) => n.request), [id], "out of the bar unanswered while away: now a notification");
  focus.now = true; // back in the browser
  await sleep(FOCUS_POLL_MS + 300);
  assert.equal(asks(), 2, "asked again");
  assert.equal(notes.length, 1, "never a second notification");
  // Its time runs out while the person looks at it: not again.
  front.gone = id;
  await sleep(700);
  await sleep(FOCUS_POLL_MS + 300);
  assert.equal(asks(), 2);
  assert.deepEqual(prompt.unseen(), []);
});

// The side panel extension's worker (browser/panel/background.js), with a stand-in for chrome.
async function worker({ view = "http://127.0.0.1:9/k3y/", focused = true, state = "normal" } = {}) {
  const { readFileSync } = await import("node:fs");
  const on = {}, made = [], cleared = [], posts = [], updates = [];
  const listen = (name) => ({ addListener: (fn) => { on[name] = fn; } });
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} }, commands: { onCommand: { addListener() {} } }, runtime: { getPlatformInfo() {} },
    storage: { session: { set: async () => {}, get: async (k) => (k === "view" ? { view } : { started: true }) } },
    windows: { getAll: async () => [{}], getLastFocused: async () => ({ id: 7, focused, state }), update: async (id, o) => { updates.push([id, o]); } },
    notifications: {
      create: async (id, o) => { made.push({ id, ...o }); return id; }, clear: async (id) => { cleared.push(id); return true; },
      onButtonClicked: listen("button"), onClicked: listen("click"), onClosed: listen("closed"),
    },
  };
  const fetch = async (url, o) => { posts.push({ url, body: JSON.parse(o.body) }); return { ok: true }; };
  const g = {};
  new Function("globalThis", "chrome", "setInterval", "fetch", "console", readFileSync(new URL("../scripts/browser/panel/background.js", import.meta.url), "utf8"))(g, chrome, () => 0, fetch, { log() {}, warn() {} });
  return { g, on, made, cleared, posts, updates };
}

test("a join notification has Allow and Deny; a press answers only its own request", async () => {
  const { g, on, made, cleared, posts } = await worker();
  assert.equal(g.pbNotifyJoin("PairBrowse needs you", "Sam wants to join (drive).", "r00aa01"), "queued");
  assert.equal(g.pbNotifyJoin("PairBrowse needs you", "again", "r00aa01"), "already shown");
  assert.equal(g.pbNotifyJoin("t", "m", "not-an-id"), "bad request");
  assert.equal(g.pbNotifyJoin("t", "m", "r00aa02"), "queued");
  assert.deepEqual(made.map((n) => [n.id, n.buttons.map((b) => b.title)]), [["pbjoin-r00aa01", ["Allow", "Deny"]], ["pbjoin-r00aa02", ["Allow", "Deny"]]]);
  assert.deepEqual(g.pbJoinNotes(), ["r00aa01", "r00aa02"]);
  // Allow on the first: the live view's approve, with the owner's key, for that request only.
  on.button("pbjoin-r00aa01", 0);
  await sleep(10);
  assert.deepEqual(posts.map((p) => [p.url, p.body]), [["http://127.0.0.1:9/k3y/approve", { id: "r00aa01", allow: true }]]);
  assert.ok(cleared.includes("pbjoin-r00aa01"));
  // Pressed again, another notification, an unknown button: nothing more.
  on.button("pbjoin-r00aa01", 0);
  on.button("pbjoin-r00zz99", 0);
  on.button("other-notification", 1);
  on.button("pbjoin-r00aa02", 5);
  await sleep(10);
  assert.equal(posts.length, 1);
  // Deny on the second.
  on.button("pbjoin-r00aa02", 1);
  await sleep(10);
  assert.deepEqual(posts[1].body, { id: "r00aa02", allow: false });
  assert.deepEqual(g.pbJoinNotes(), []);
});

test("a join notification's body brings the browser to the front; answered elsewhere, it goes", async () => {
  const { g, on, updates, cleared, posts } = await worker({ focused: false, state: "minimized" });
  assert.equal(await g.pbFocused(), false, "minimized: not looking at it");
  g.pbNotifyJoin("t", "m", "r00aa03");
  on.click("pbjoin-r00aa03");
  await sleep(10);
  assert.deepEqual(updates, [[7, { focused: true, state: "normal" }]]);
  assert.equal(posts.length, 0, "the body answers nothing");
  assert.equal(g.pbClearJoin("r00aa03"), true);
  assert.ok(cleared.includes("pbjoin-r00aa03"));
  assert.equal(g.pbClearJoin("r00aa03"), false);
  assert.equal(await (await worker({ focused: true })).g.pbFocused(), true);
  assert.equal(await (await worker({ focused: false, state: "normal" })).g.pbFocused(), false, "another app in front");
});
