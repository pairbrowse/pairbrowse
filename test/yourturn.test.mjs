// Hand-offs to the person (daemon/yourturn.mjs, spec server-mode B7, B10, B11, decision 8): the
// window as before on a desktop, a grant and one message per step when hand-offs go to the
// channels, exactly one reminder, the timeout's safe stop and held tab, and nothing the person
// types (nor the agent's own words) in a message, an audit line, a host note or the goal log.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createYourTurn, TIMEOUT_NOTE, TIMED_OUT } = await import("../scripts/daemon/yourturn.mjs");
const { createGrants } = await import("../scripts/daemon/grants.mjs");
const { createAudit } = await import("../scripts/daemon/audit.mjs");
const { createNotifier, handoffSends } = await import("../scripts/daemon/notify/index.mjs");
const { createHandoffs } = await import("../scripts/daemon/toolstab.mjs");
const { createOutput } = await import("../scripts/daemon/output.mjs");
const { CHALLENGE_TURN } = await import("../scripts/popups.mjs");
const { STATUS_STEPS } = await import("../ui/vocab.js");
const { ACTIONS, clock: utcClock } = await import("../scripts/daemon/notify/message.mjs");

const MIN = 60_000;
const CARD = "4242 4242 4242 4242";
const tick = () => new Promise((r) => setImmediate(r));
const until = async (fn, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 5))) if (fn()) return true; return false; };
const linesOf = (f) => { try { return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

function pageAt(url, tabs = []) {
  const page = Object.assign(new EventEmitter(), { url: () => url, isClosed: () => false, context: () => ({ pages: () => [...tabs, page] }) });
  return page;
}

// A helper's worth of hand-offs: real grants, audit, notifier (webhook through a stub post) and
// Tools tab list, on clocks and timers the test moves.
function setup({ enabled = true, away = true, server = false, channels = [{ type: "webhook", urlSecret: "PAIRBROWSE_WEBHOOK_URL" }], post, agentBy, extra = {} } = {}) {
  const clock = { t: 1_800_000_000_000, m: 9_000 };
  const timers = [];
  const fake = { set: (fn, ms) => { const t = { fn, at: clock.t + ms, done: false }; timers.push(t); return t; }, clear: (t) => { if (t) t.done = true; } };
  const fire = () => { for (const t of timers) if (!t.done && t.at <= clock.t) { t.done = true; t.fn(); } };
  const file = join(mkdtempSync(join(tmpdir(), "pb-yourturn-")), "audit.jsonl");
  const audit = createAudit({ file, now: () => clock.t });
  const grants = createGrants({ now: () => clock.t, mono: () => clock.m, audit, timers: { set: () => null, clear: () => {} } });
  const sent = []; // what reached the webhook
  const notifier = createNotifier({ channels: () => channels, secret: (n) => (n === "PAIRBROWSE_WEBHOOK_URL" ? "https://hooks.example.org/pb" : undefined), sendMaxMs: 1000,
    post: post || (async (url, body) => { sent.push(JSON.parse(body)); return { ok: true, status: 200 }; }) });
  const config = { handoff: { enabled, away, grantMinutes: 15, remindMinutes: 10, channels } };
  const notes = [], journal = [], badges = [], logged = [];
  const handoffs = createHandoffs();
  const hud = {
    page: null,
    badgeNow: { text: "", kind: "clear" },
    async setBadge(text, kind) { badges.push({ text, kind }); this.badgeNow = { text, kind }; },
    async setBadgeFor(p, text, kind) { badges.push({ p, text, kind }); yt.onBadge(p, { kind, text, color: "" }); },
    badge() { return this.badgeNow; },
    sparkPage() { return this.page; },
    sparkColor: () => "#E8743B",
  };
  let saved = 0, flushed = 0;
  const yt = createYourTurn({
    config, grants, notifier, audit, handoffs, hud, hostNote: (t) => notes.push(t), log: (l) => logged.push(l),
    journal: { flushNow: async () => { flushed++; }, status: (kind, text) => journal.push({ kind, text }) },
    saveTabs: async () => { saved++; return {}; }, sessionName: () => "default",
    linkFor: async (key) => `http://127.0.0.1:4100/${key}/`,
    sends: () => handoffSends(config, { server }), timers: fake, now: () => clock.t, turnMs: () => 0, ...(agentBy ? { agentBy } : {}), ...extra,
  });
  return { clock, fire, grants, yt, sent, notes, journal, badges, logged, handoffs, hud, audit: () => linesOf(file), file, config, counts: () => ({ saved, flushed }) };
}

test("the step kinds are one list: pairbrowse_status step, the messages' actions", () => {
  assert.deepEqual([...STATUS_STEPS], ACTIONS);
});

test("a desktop without Away: the step stays in the window; no grant, no message", async () => {
  const s = setup({ away: false });
  const page = pageAt("https://shop.example/login");
  s.hud.page = page;
  assert.equal(await s.yt.onStatus("p1", { kind: "you", text: "Please sign in", step: "login" }, page), "");
  s.yt.onBadge("p1", { kind: "you", text: "Please sign in" });
  assert.equal(s.grants.open().length, 0);
  assert.equal(s.sent.length, 0);
  const [entry] = s.handoffs.list();
  assert.equal(entry.kind, "login", "the Tools tab's entry, with the step's kind");
  assert.equal(entry.text, "Please sign in");
  // A CAPTCHA PairBrowse saw: the badge and the Tools tab, as before.
  s.yt.onChallenge(CHALLENGE_TURN, page);
  await tick();
  assert.deepEqual(s.badges.at(-1), { text: CHALLENGE_TURN, kind: "you" });
  assert.equal(s.grants.open().length, 0);
  s.yt.onChallengeCleared();
  assert.deepEqual(s.badges.at(-1), { text: "", kind: "clear" });
  assert.equal(s.handoffs.list().length, 1, "only the agent's entry is left");
  assert.equal(s.audit().length, 0, "nothing in the trail");
  // Enabled but no channel at all, even in server mode: no grant; the status says to tell the user.
  const t = setup({ server: true, away: false, channels: [] });
  t.hud.page = page;
  assert.match(await t.yt.onStatus("p1", { kind: "you", text: "x" }, page), /no hand-off channel can be used/);
  assert.equal(t.grants.open().length, 0);
  assert.deepEqual(t.audit().map((l) => [l.kind, l.detail]), [["notify-failed", "no-channel"]]);
});

test("the Handoff page's boxes: a step whose group is off (checks: sign-in, CAPTCHA, 2FA; submits: payment, other) stays in the window", async () => {
  const off = new Set(["login", "captcha", "2fa"]);
  const s = setup({ extra: { wants: (action) => !off.has(action) } });
  const page = pageAt("https://shop.example/login");
  s.hud.page = page;
  assert.equal(await s.yt.onStatus("p1", { kind: "you", text: "Please sign in", step: "login" }, page), "");
  assert.equal(s.grants.open().length, 0, "checks off: no grant");
  assert.equal(s.sent.length, 0);
  const line = await s.yt.onStatus("p1", { kind: "you", text: "Approve the payment", step: "payment" }, page);
  assert.equal(s.grants.open().length, 1, "submits on: a grant");
  assert.ok(line);
});

test("Away (or a server): one grant per step, a message of the step's kind, host, expiry and link only; the result names where it went, never the link", async () => {
  for (const opts of [{ away: true }, { away: false, server: true }]) {
    const s = setup(opts);
    const other = pageAt("https://news.example/");
    const page = pageAt("https://shop.example/checkout?order=77#pay", [other]);
    s.hud.page = page;
    const line = await s.yt.onStatus("p1", { kind: "you", text: `Pay with card ${CARD}, code 123456`, step: "payment" }, page);
    const [g] = s.grants.open();
    assert.ok(g, "a grant");
    assert.equal(g.page, page);
    assert.equal(g.action, "payment");
    assert.equal(g.expiresAt - s.clock.t, 15 * MIN);
    assert.equal(line, `Your turn sent (webhook): hand-off ${g.id} for tab 1, until ${utcClock(g.expiresAt)}. Don't act in this tab; wait with browser_wait_for.`);
    assert.equal(s.sent.length, 1);
    const m = s.sent[0];
    assert.deepEqual(Object.keys(m).sort(), ["event", "expiresAt", "host", "id", "kind", "link", "reason"]);
    assert.equal(m.event, "pairbrowse.turn");
    assert.equal(m.kind, "payment");
    assert.equal(m.host, "shop.example");
    assert.match(m.link, /^http:\/\/127\.0\.0\.1:4100\/[0-9a-f]{64}\/$/);
    assert.ok(!line.includes(m.link.split("/")[3]), "the link's key is never in the result");
    for (const said of [JSON.stringify(s.sent), readFileSync(s.file, "utf8"), JSON.stringify(s.logged)]) {
      assert.ok(!said.includes("4242") && !said.includes("123456") && !said.includes("Pay with card"), "never the agent's words");
    }
    assert.deepEqual(s.audit().map((l) => [l.kind, l.detail]), [["minted", "payment"], ["notified", "webhook"]]);
    assert.equal(s.audit()[0].tab, "https://shop.example/checkout");
  }
  // No step: the kind from the agent's words, as the Tools tab reads them.
  const s = setup();
  const page = pageAt("https://mail.example/");
  s.hud.page = page;
  await s.yt.onStatus("p1", { kind: "you", text: "Enter the 2FA code from your phone" }, page);
  assert.equal(s.grants.open()[0].action, "2fa");
  assert.equal(s.sent[0].kind, "2fa");
});

test("the agent's next status ends its hand-off (agent); a cleared check ends PairBrowse's own (cleared); channels hear it, Done excepted", async () => {
  const s = setup();
  const page = pageAt("https://shop.example/login");
  s.hud.page = page;
  await s.yt.onStatus("p1", { kind: "you", text: "Sign in", step: "login" }, page);
  const id = s.grants.open()[0].id;
  assert.equal(s.yt.handedOff(page), "open");
  assert.equal(await s.yt.onStatus("p1", { kind: "claude", text: "Filling the form" }, page), "");
  await tick();
  assert.equal(s.grants.open().length, 0);
  assert.deepEqual(s.sent.at(-1), { event: "pairbrowse.ended", id, kind: "login", host: "shop.example", link: null, expiresAt: s.sent[0].expiresAt, reason: "agent" });
  assert.equal(s.yt.handedOff(page), "");
  // A check on a page: a grant of kind captcha; cleared ends it.
  const check = pageAt("https://tickets.example/queue");
  s.yt.onChallenge(CHALLENGE_TURN, check);
  await tick(); await tick();
  const [c] = s.grants.open();
  assert.equal(c.action, "captcha");
  assert.equal(c.page, check);
  s.yt.onChallenge(CHALLENGE_TURN, check);
  await tick();
  assert.equal(s.grants.open().length, 1, "the same check again mints nothing new");
  s.hud.badgeNow = { text: CHALLENGE_TURN, kind: "you" };
  s.yt.onChallengeCleared();
  await tick();
  assert.equal(s.grants.open().length, 0);
  assert.equal(s.sent.at(-1).reason, "cleared");
  assert.deepEqual(s.audit().filter((l) => l.kind === "ended").map((l) => l.detail), ["agent", "cleared"]);
  // Done (the person's own press): no ended message, they know.
  await s.yt.onStatus("p1", { kind: "you", text: "Sign in" }, page);
  const n = s.sent.length;
  s.grants.end(s.grants.open()[0].id, "done");
  await tick();
  assert.equal(s.sent.length, n);
});

test("done in the window (decision 8): the person acted in the tab and it loaded its next page before anyone took the link: the hand-off ends (window); a page that moved by itself, or after Take over, doesn't", async () => {
  let acted = 0;
  const s = setup({ extra: { personActedAt: () => acted } });
  const page = pageAt("https://shop.example/login");
  s.hud.page = page;
  // The page moving on by itself (a redirect, a reload) while nobody acted: the hand-off stays.
  await s.yt.onStatus("p1", { kind: "you", text: "Sign in", step: "login" }, page);
  const [g] = s.grants.open();
  const waiting = s.yt.ended(page, "p1");
  page.emit("domcontentloaded");
  await new Promise((r) => setTimeout(r, 3400));
  assert.equal(s.grants.open().length, 1, "no person's input: still open");
  // The person signs in in the window: their click, then the next page.
  acted = Date.now();
  page.emit("domcontentloaded");
  assert.deepEqual(await waiting, { id: g.id, reason: "window" }, "the waiting agent wakes");
  assert.equal(s.grants.open().length, 0);
  await tick();
  assert.deepEqual({ event: s.sent.at(-1).event, id: s.sent.at(-1).id, reason: s.sent.at(-1).reason }, { event: "pairbrowse.ended", id: g.id, reason: "window" }, "the phone hears its link is over");
  assert.match(s.notes.at(-1), /the person did it in the PairBrowse window/);
  assert.equal(page.listenerCount("domcontentloaded"), 1, "its watch ends with it (left: the mask's wait for the next page)");
  // After Take over on the phone, the person's taps move pages as part of the step: only Done ends it.
  await s.yt.onStatus("p1", { kind: "claude", text: "Back" }, page);
  await s.yt.onStatus("p1", { kind: "you", text: "Sign in", step: "login" }, page);
  const [h] = s.grants.open();
  assert.ok(s.grants.redeem(s.grants.redeemKey(h.id), { session: "default" }));
  acted = Date.now() + 1000;
  page.emit("domcontentloaded");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.grants.open().length, 1, "taken over: still open");
  s.grants.end(h.id, "done");
});

test("exactly one reminder: the link again while unused, else 'opened already'", async () => {
  const s = setup();
  const page = pageAt("https://bank.example/verify");
  s.hud.page = page;
  await s.yt.onStatus("p1", { kind: "you", text: "Code", step: "2fa" }, page);
  s.clock.t += 10 * MIN;
  s.fire(); await tick(); await tick();
  assert.equal(s.sent.filter((m) => m.event === "pairbrowse.reminder").length, 1);
  assert.equal(s.sent.at(-1).link, s.sent[0].link, "the link again: it is unused");
  s.fire(); await tick();
  assert.equal(s.sent.filter((m) => m.event === "pairbrowse.reminder").length, 1, "once");
  assert.deepEqual(s.audit().filter((l) => l.kind === "reminded").map((l) => l.detail), ["webhook"]);
  // Opened before the reminder: no link in it.
  const t = setup();
  t.hud.page = page;
  await t.yt.onStatus("p1", { kind: "you", text: "Code", step: "2fa" }, page);
  const key = t.sent[0].link.split("/")[3];
  assert.ok(t.grants.redeem(key, { session: "default" }));
  t.clock.t += 10 * MIN;
  t.fire(); await tick(); await tick();
  const r = t.sent.at(-1);
  assert.equal(r.event, "pairbrowse.reminder");
  assert.equal(r.link, null);
  assert.deepEqual(t.audit().filter((l) => l.kind === "reminded").map((l) => l.detail), [["webhook", "already-opened"]]);
});

test("at expiry: flush, save tabs, yourTurn line, keys stop, one ended message, badge and Tools entry 'Timed out', one host note, tab held", async () => {
  const s = setup();
  const page = pageAt("https://shop.example/pay");
  s.hud.page = page;
  await s.yt.onStatus("p1", { kind: "you", text: "Pay", step: "payment" }, page);
  s.yt.onBadge("p1", { kind: "you", text: "Pay" });
  const key = s.sent[0].link.split("/")[3];
  s.clock.t += 15 * MIN + 1;
  s.grants.sweep();
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(s.counts(), { saved: 1, flushed: 1 });
  assert.deepEqual(s.journal, [{ kind: "you", text: "Not done in time: Approve a payment on shop.example" }]);
  assert.equal(s.grants.redeem(key, { session: "default" }), null, "the keys stopped");
  assert.deepEqual(s.sent.filter((m) => m.event === "pairbrowse.ended").map((m) => m.reason), ["expired"]);
  assert.deepEqual(s.badges.at(-1), { p: "p1", text: `${TIMED_OUT}: Approve a payment on shop.example`, kind: "you" });
  assert.match(s.handoffs.list()[0].text, /^Timed out/);
  assert.deepEqual(s.notes, [TIMEOUT_NOTE]);
  assert.equal(s.grants.held(page), true);
  assert.equal(s.yt.handedOff(page), "held", "agents keep out of a held tab");
  assert.equal(s.yt.masked(page), true, "and its results stay masked");
  // A new "you" mints a new grant to that same tab (and a single reminder again); the hold goes.
  await s.yt.onStatus("p1", { kind: "you", text: "Pay", step: "payment" }, page);
  assert.equal(s.grants.held(page), false);
  assert.equal(s.grants.open()[0].page, page);
  // The person's own input in a held tab releases it; so does the browser closing (session end).
  s.clock.t += 15 * MIN + 1;
  s.grants.sweep();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(s.grants.held(page), true);
  s.yt.personUsed(page);
  assert.equal(s.grants.held(page), false);
  s.grants.hold(page, { session: "default" });
  s.yt.browserClosed();
  assert.equal(s.grants.held(page), false);
  assert.equal(s.notes.length, 2, "one note per timeout");
});

test("a payment hand-off masks every agent result from scope tabs and covers pictures; the person's typed card number is in no host note, activity line, journal, audit line or message", async () => {
  const s = setup();
  const page = pageAt("https://shop.example/checkout");
  const elsewhere = pageAt("https://news.example/");
  s.hud.page = page;
  await s.yt.onStatus("p1", { kind: "you", text: "Enter the card", step: "payment" }, page);
  // The pop-up the checkout opened (3-D Secure) is in scope too.
  const popup = pageAt("https://3ds.bank.example/challenge");
  s.grants.addToScope(page, popup);
  for (const p of [page, popup]) assert.equal(s.yt.masked(p), true);
  assert.equal(s.yt.masked(elsewhere), false);
  assert.equal(s.yt.masked(null), false);
  // A result from a scope tab is masked as a joiner's agent's: the card number the person typed,
  // and the page's sensitive field values (serve/result.mjs veiled).
  const output = createOutput({ dir: tmpdir(), secretValues: () => ({}) });
  const typed = `- textbox "Card number" [ref=e5]: ${CARD}\n- textbox "CVC" [ref=e6]: 737`;
  const shown = output.forJoiner(typed, ["737"]);
  assert.ok(!shown.includes("4242 4242") && !shown.includes("737"), shown);
  // Nothing the person typed ever passes through the hand-off: done, then a timeout on another step.
  s.grants.end(s.grants.open()[0].id, "done");
  await s.yt.onStatus("p1", { kind: "you", text: "Confirm", step: "payment" }, page);
  s.clock.t += 16 * MIN;
  s.grants.sweep();
  for (let i = 0; i < 6; i++) await tick();
  const everything = JSON.stringify({ sent: s.sent, notes: s.notes, journal: s.journal, logged: s.logged, audit: s.audit(), tools: s.handoffs.list().map(({ page: _p, ...h }) => h) });
  // Random keys and ids are hex and can hold these digits by chance; the check is on the rest.
  const plain = everything.replace(/[0-9a-f]{8,}/g, "");
  assert.ok(!plain.includes("4242") && !plain.includes("737"), everything);
  // After the grant ended and the tab was released, what the person typed is still in the page's
  // fields: masked until the tab loads its next page, then the agent reads it as it is.
  s.yt.personUsed(page);
  assert.equal(s.yt.masked(page), true, "the fields the person typed in stay masked");
  assert.equal(s.yt.masked(popup), true);
  page.emit("domcontentloaded");
  assert.equal(s.yt.masked(page), false, "the next page reads as it is");
  assert.equal(s.yt.masked(elsewhere), false);
});

test("the browser closing ends hand-offs (browser-restarted); the helper stopping (helper-stopped) waits for the ended messages", async () => {
  const s = setup();
  const page = pageAt("https://shop.example/login");
  s.hud.page = page;
  await s.yt.onStatus("p1", { kind: "you", text: "Sign in", step: "login" }, page);
  s.yt.browserClosed();
  await tick();
  assert.equal(s.sent.at(-1).reason, "browser-restarted");
  await s.yt.onStatus("p1", { kind: "you", text: "Sign in", step: "login" }, page);
  await s.yt.stop();
  assert.equal(s.sent.at(-1).reason, "helper-stopped");
  assert.equal(s.grants.open().length, 0);
});

test("every channel failing: the grant stays for the window and live view; the status says to tell the user", async () => {
  const s = setup({ post: async () => ({ ok: false, status: 500, error: "HTTP 500" }) });
  const page = pageAt("https://shop.example/login");
  s.hud.page = page;
  const line = await s.yt.onStatus("p1", { kind: "you", text: "Sign in", step: "login" }, page);
  assert.match(line, /^Couldn't reach any hand-off channel \(webhook\): tell the user directly; hand-off [0-9a-f]{8} for tab 0, until/);
  assert.equal(s.grants.open().length, 1);
  assert.deepEqual(s.audit().map((l) => [l.kind, l.detail]), [["minted", "login"], ["notify-failed", "webhook"]]);
});

test("PAIRBROWSE_TEST_TURN_MS: a grant's life in ms, its reminder at two thirds", async () => {
  const s = setup();
  const page = pageAt("https://shop.example/login");
  s.hud.page = page;
  const yt2 = createYourTurn({ config: s.config, grants: s.grants, notifier: { usable: () => [1], send: async () => ({ sent: ["webhook"], failed: [], withheld: [] }) },
    handoffs: createHandoffs(), hud: s.hud, journal: { flushNow: async () => {}, status() {} }, sessionName: () => "default", sends: () => true,
    turnMs: () => 3000, now: () => s.clock.t, timers: { set: (fn, ms) => { yt2.remindIn = ms; return null; }, clear() {} } });
  await yt2.onStatus("p2", { kind: "you", text: "x", step: "other" }, page);
  assert.equal(s.grants.open()[0].expiresAt - s.clock.t, 3000);
  assert.equal(yt2.remindIn, 2000);
});

test("pairbrowse_status: the hand-off's line after the status line; the step kind reaches the Tools tab before the badge's callback", async () => {
  const { createStatusTool } = await import("../scripts/daemon/serve/tools/status.mjs");
  const s = setup();
  const page = pageAt("https://shop.example/login");
  s.hud.page = page;
  const api = {
    context: { getContext: async () => ({}), crashLoop: () => null, statusParts: () => [] },
    hud: { ...s.hud, setBadgeFor: async (p, text, kind) => s.yt.onBadge(p, { kind, text, color: "" }), hideCursor: async () => {}, sparkPage: () => page },
    journal: { status() {} }, session: { setStatus() {} }, myLabel: () => "Claude", yourTurn: s.yt,
  };
  const tool = createStatusTool({ participant: "p9", mine: page }, api);
  const r = await tool.pairbrowse_status({ kind: "you", text: "Sign in please", step: "login" });
  const [first, second] = r.text.split("\n");
  assert.match(first, /^ok/);
  assert.match(second, /^Your turn sent \(webhook\): hand-off [0-9a-f]{8} for tab 0, until \d\d:\d\d UTC\. Don't act in this tab; wait with browser_wait_for\.$/);
  assert.equal(s.handoffs.list()[0].kind, "login");
  const done = await tool.pairbrowse_status({ kind: "done", text: "Signed in" });
  assert.ok(!done.text.includes("\n"), "no hand-off line for other kinds");
  assert.equal(s.grants.open().length, 0, "and its hand-off ended");
});

test("two channels of one type: the result and the trail name the type once, so the notified and reminded lines are kept", async () => {
  const hook = { type: "webhook", urlSecret: "PAIRBROWSE_WEBHOOK_URL" };
  const s = setup({ channels: [hook, { ...hook }] });
  const page = pageAt("https://shop.example/login");
  s.hud.page = page;
  const line = await s.yt.onStatus("p1", { kind: "you", text: "Sign in", step: "login" }, page);
  assert.equal(s.sent.length, 2, "both webhooks got the message");
  assert.match(line, /^Your turn sent \(webhook\): /);
  assert.deepEqual(s.yt.open()[0].sent, ["webhook"]);
  s.clock.t += 10 * MIN;
  s.fire(); await tick(); await tick();
  const trail = s.audit().map((l) => [l.kind, l.detail]);
  assert.deepEqual(trail.filter(([k]) => k === "notified" || k === "reminded"), [["notified", "webhook"], ["reminded", "webhook"]]);
});

test("a tab on no website (about:blank, a file): the step stays in the window; no grant, no message", async () => {
  for (const url of ["about:blank", "file:///Users/me/form.html", "data:text/html,x"]) {
    const s = setup();
    const page = pageAt(url);
    s.hud.page = page;
    assert.match(await s.yt.onStatus("p1", { kind: "you", text: "Sign in", step: "login" }, page), /^Your turn shows in the PairBrowse window; this tab is on no website/, url);
    assert.equal(s.grants.open().length, 0, url);
    assert.equal(s.sent.length, 0, url);
  }
});

test("a timeout keeps the agent's name on its badge", async () => {
  const s = setup({ agentBy: (p) => ({ label: p === "p1" ? "Claude · Codex" : "Agent", color: "" }) });
  const labels = [];
  s.hud.setBadgeFor = async (p, text, kind, label) => { labels.push({ p, text, kind, label }); };
  const page = pageAt("https://shop.example/pay");
  s.hud.page = page;
  await s.yt.onStatus("p1", { kind: "you", text: "Pay", step: "payment" }, page);
  s.clock.t += 15 * MIN + 1;
  s.grants.sweep();
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(labels.at(-1), { p: "p1", text: `${TIMED_OUT}: Approve a payment on shop.example`, kind: "you", label: "Claude · Codex" });
});

test("a check that timed out: clearing it takes its 'Timed out' badge down and lets the tab go", async () => {
  const s = setup();
  const page = pageAt("https://tickets.example/queue");
  s.yt.onChallenge(CHALLENGE_TURN, page);
  await tick(); await tick();
  assert.equal(s.grants.open()[0].action, "captcha");
  s.clock.t += 15 * MIN + 1;
  s.grants.sweep();
  for (let i = 0; i < 6; i++) await tick();
  const text = `${TIMED_OUT}: ${s.journal.at(-1).text.replace(/^Not done in time: /, "")}`;
  assert.deepEqual(s.hud.badge(), { text, kind: "you" });
  assert.equal(s.grants.held(page), true);
  s.yt.onChallengeCleared();
  await tick();
  assert.deepEqual(s.hud.badge(), { text: "", kind: "clear" });
  assert.equal(s.grants.held(page), false, "the tab is the person's again");
  assert.equal(s.handoffs.list().length, 0);
  // A check cleared before its timeout's steps finish: no "Timed out" badge after it.
  const t = setup();
  t.yt.onChallenge(CHALLENGE_TURN, page);
  await tick(); await tick();
  t.clock.t += 15 * MIN + 1;
  t.grants.sweep();
  t.yt.onChallengeCleared();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(t.badges.some((b) => b.text.startsWith(TIMED_OUT)), false);
  assert.equal(t.grants.held(page), false);
});

// B10's wiring: a result from a tab handed to the person is read as a joiner's agent's is.
async function resultRig(handed) {
  const { createResult } = await import("../scripts/daemon/serve/result.mjs");
  const { coverRects } = await import("../scripts/daemon/covers.mjs");
  const seen = { covers: [], pictures: [], sent: null, frames: 0 };
  // The page's fields as sensitiveValues reads them: a filled security code.
  const frame = { evaluate: async () => { seen.frames++; return [["tel cc-csc  cvc CVC", "737"]]; }, isDetached: () => false };
  const page = { url: () => "https://shop.example/checkout", isClosed: () => false, frames: () => [frame], mainFrame: () => frame };
  const api = {
    closing: {}, config: { screenshots: true }, drainHostNotes: () => [], finish() {}, followTabs: async () => {}, internal: async () => null, log() {}, myLabel: () => "Claude", outlines: null,
    output: createOutput({ dir: tmpdir(), secretValues: () => ({}) }), pause: { noteAfter: () => ({ n: 0, text: "" }) }, personTab: () => false,
    popups: { drain: () => "", settled: async () => {}, dismissOverlay: async () => {}, checkChallenge: async () => {} },
    presence: { userNote: () => "", loadedAt: () => 0, agentActing: () => false },
    context: { openPages: async () => [page], touch() {}, setCurrentUrl() {}, current: () => null, pageAt: async () => page, currentUrl: () => page.url() },
    hud: { sparkOwner: () => null, moveSpark: async () => {}, sparkPage: () => page },
    rememberPicture: (shot) => seen.pictures.push(shot), reply() {},
    // The picture's covers are read before it only when asked; none read here (before: not a list),
    // so a covered picture is dropped (agentPicture "").
    screenshots: { take: async (_p, _who, { covers }) => { seen.covers.push(covers); return { data: "IMG", before: covers ? null : undefined }; } },
    session: { messagesNote: () => "", note: () => "" }, tabClaims: { members: () => [] }, tabNames: { strip: (t) => t },
    toClient: (m) => { seen.sent = m; }, yourTurn: { masked: (p) => handed && p === page },
  };
  const conn = { callArgs: new Map(), fieldNotes: [], ownTab: () => page, participant: "p1", refNames: { toPlain: (t) => t, plainFile() {}, unknownSeqs: () => [], learnMain() {} },
    refused: new Set(), remote: null, tabActions: new Map(), traces: new Map(), mine: page };
  return { r: createResult(conn, api), page, seen, coverRects };
}

test("B10 wiring: serve/result.mjs reads a handed-over tab's page values, masks its result as a joiner's agent's and covers or drops its picture", async () => {
  const snapshot = () => ({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: `### Page\n- Page URL: https://shop.example/checkout\n### Snapshot\n\`\`\`yaml\n- textbox "Card number" [ref=e5]: ${CARD}\n- textbox "CVC" [ref=e6]: 737\n\`\`\`` }] } });
  const handed = await resultRig(true);
  await handed.r.finishResult(snapshot(), "browser_snapshot");
  const text = handed.seen.sent.result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  assert.ok(handed.seen.frames > 0, "the page's sensitive field values were read (sensitiveValues)");
  assert.ok(!text.includes("737") && !text.includes("4242 4242"), text);
  assert.equal(handed.seen.covers[0], handed.coverRects, "the picture's covers are read");
  assert.equal(handed.seen.sent.result.content.some((c) => c.type === "image"), false, "a picture that couldn't be covered is dropped");
  assert.equal(handed.seen.pictures.length, 0);
  // The same tab not handed over: the host's agent reads it as it is, with its picture.
  const own = await resultRig(false);
  await own.r.finishResult(snapshot(), "browser_snapshot");
  const plain = own.seen.sent.result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  assert.equal(own.seen.frames, 0, "no page read for the host's own agent");
  assert.ok(plain.includes(": 737"), plain);
  assert.equal(own.seen.covers[0], null);
  assert.equal(own.seen.sent.result.content.some((c) => c.type === "image"), true);
});

test("B10 wiring: pairbrowse_click_at covers or drops the picture of a handed-over tab", async () => {
  const { createClickAtTool } = await import("../scripts/daemon/serve/tools/click-at.mjs");
  const { coverRects, NOT_COVERED_NOTE } = await import("../scripts/daemon/covers.mjs");
  const run = async (handed) => {
    const page = { url: () => "https://shop.example/checkout", isClosed: () => false, evaluate: async () => null, waitForTimeout: async () => {} };
    const covers = [], pictures = [];
    const tool = createClickAtTool({ ownTab: () => page, participant: "p1", remote: null }, {
      closing: {}, config: { screenshots: true }, myLabel: () => "Claude", rememberPicture: (s) => pictures.push(s),
      hud: { cursorTo: async () => {}, sparkPage: () => page, addActivity() {} }, popups: { dismissOverlay: async () => {}, drain: () => "" },
      screenshots: { clickAt: async () => ({ page, text: "Clicked." }), take: async (_p, _w, o) => { covers.push(o.covers); return { data: "IMG", before: o.covers ? null : undefined }; } },
      yourTurn: { masked: (p) => handed && p === page },
    });
    return { r: await tool.pairbrowse_click_at({ x: 10, y: 10, element: "the field" }), covers, pictures };
  };
  const handed = await run(true);
  assert.equal(handed.covers[0], coverRects);
  assert.equal(handed.r.content.some((c) => c.type === "image"), false);
  assert.ok(handed.r.content.some((c) => c.text === NOT_COVERED_NOTE));
  const own = await run(false);
  assert.equal(own.covers[0], null);
  assert.equal(own.r.content.some((c) => c.type === "image"), true);
  assert.equal(own.pictures.length, 1);
});

test("on every end but expired, one host note names what the person did (names only) and says to take a snapshot; ended(page) wakes a waiter", async () => {
  const s = setup({ extra: { actionsIn: () => 'typed in "Card number", clicked "Pay"' } });
  const page = pageAt("https://shop.example/checkout");
  s.hud.page = page;
  await s.yt.onStatus("p1", { kind: "you", text: "Pay", step: "payment" }, page);
  assert.equal(s.yt.ended(null, "p2"), null, "another agent has no hand-off of its own");
  const waiting = s.yt.ended(null, "p1");
  const byTab = s.yt.ended(page);
  const id = s.grants.open()[0].id;
  s.grants.end(id, "done");
  assert.deepEqual(await waiting, { id, reason: "done" });
  assert.deepEqual(await byTab, { id, reason: "done" });
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0], `Hand-off ${id} (Approve a payment on shop.example, tab 0) ended: the person pressed Done. The person there: typed in "Card number", clicked "Pay". ` +
    "Take a browser_snapshot before you go on; Done is only a hint, so check the page shows the step finished.");
  assert.equal(s.yt.ended(page), null, "nothing open now");
  // The agent's next status, a closed tab: one note each. Expiry: the timeout note alone (B11).
  await s.yt.onStatus("p1", { kind: "you", text: "Pay", step: "payment" }, page);
  await s.yt.onStatus("p1", { kind: "claude", text: "Checking" }, page);
  assert.match(s.notes.at(-1), /ended: your next status ended it\./);
  await s.yt.onStatus("p1", { kind: "you", text: "Pay", step: "payment" }, page);
  s.clock.t += 15 * MIN + 1;
  s.grants.sweep();
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(s.notes.slice(2), [TIMEOUT_NOTE]);
});

test("a fast-mode handoff step gets a grant when hand-offs go to the channels; the step's end ends it (agent)", async () => {
  const s = setup();
  const page = pageAt("https://shop.example/login");
  s.yt.onRunStatus("p1", "Sign in, then press Done", "you", page, "Claude");
  const [g] = s.grants.open();
  assert.equal(g.page, page);
  assert.equal(s.yt.handedOff(page), "open");
  const ended = s.yt.ended(page, "p1");
  s.yt.onRunStatus("p1", "", "clear", page, "Claude");
  assert.deepEqual(await ended, { id: g.id, reason: "agent" });
  assert.equal(s.handoffs.list().length, 0);
});

// B16: turn.json in a folder of the test's own; the browser's tabs as the test sets them.
function restartable(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pb-turnfile-"));
  const file = join(dir, "turn.json");
  const tabs = { list: [], successors: new Map() };
  const s = setup({ extra: { turnFile: () => file, keptAlive: () => true, successorOf: (p) => tabs.successors.get(p) || null, pagesNow: async () => tabs.list, ...extra } });
  return { s, file, tabs };
}

test("a browser restart with keepAlive mints one replacement grant with the same deadline; turn.json holds no key or link", async () => {
  const { s, file, tabs } = restartable();
  const page = pageAt("https://shop.example/login?step=2");
  s.hud.page = page;
  await s.yt.onStatus("p1", { kind: "you", text: "Sign in", step: "login" }, page);
  const [g] = s.grants.open();
  const saved = readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(saved).turns, [{ id: g.id, key: "status:p1", action: "login", host: "shop.example", url: "https://shop.example/login?step=2", expiresAt: g.expiresAt, reminded: false, sent: ["webhook"] }]);
  assert.ok(!saved.includes(s.sent[0].link.split("/")[3]), "no key");
  assert.equal((statSync(file).mode & 0o777).toString(8), "600");
  s.clock.t += 2 * MIN;
  s.yt.browserClosed();
  await tick();
  assert.equal(s.sent.filter((m) => m.event === "pairbrowse.ended").length, 0, "no ended message while the browser comes back");
  const back = pageAt("https://shop.example/login?step=2");
  tabs.successors.set(page, back);
  tabs.list = [back];
  await s.yt.recover();
  const [r] = s.grants.open();
  assert.equal(r.page, back);
  assert.equal(r.expiresAt, g.expiresAt, "the same deadline");
  assert.notEqual(r.id, g.id);
  const turn = s.sent.at(-1);
  assert.equal(turn.event, "pairbrowse.turn");
  assert.equal(turn.reason, "browser-restarted");
  assert.notEqual(turn.link, s.sent[0].link, "a new link");
  assert.deepEqual(s.audit().filter((l) => l.kind === "minted").map((l) => l.detail), ["login", ["login", "replacement"]]);
  await s.yt.recover();
  assert.equal(s.grants.open().length, 1, "once");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).turns.map((t) => t.id), [r.id]);
  // Its end (done) clears the file.
  s.grants.end(r.id, "done");
  assert.equal(existsSync(file), false);
});

test("a helper restart reissues once from turn.json before the deadline, never after; the reminder already sent isn't sent again", async () => {
  const { s, file, tabs } = restartable();
  const page = pageAt("https://bank.example/verify");
  s.hud.page = page;
  await s.yt.onStatus("p1", { kind: "you", text: "Code", step: "2fa" }, page);
  s.clock.t += 10 * MIN;
  s.fire(); await tick(); await tick();
  await s.yt.stop(); // helper-stopped: the person hears it ended; the file stays for the next helper
  assert.equal(s.sent.at(-1).reason, "helper-stopped");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).turns[0].reminded, true);
  // The next helper, the tab restored at its address.
  const next = setup({ extra: { turnFile: () => file, keptAlive: () => true, pagesNow: async () => tabs.list } });
  next.clock.t = s.clock.t + MIN;
  tabs.list = [pageAt("https://news.example/"), pageAt("https://bank.example/verify")];
  await next.yt.recover();
  const [r] = next.grants.open();
  assert.equal(r.page, tabs.list[1]);
  assert.equal(next.sent.at(-1).reason, "browser-restarted");
  next.clock.t = r.expiresAt - MIN;
  next.fire(); await tick(); await tick();
  assert.equal(next.sent.filter((m) => m.event === "pairbrowse.reminder").length, 0, "exactly one reminder in all");
  await next.yt.recover();
  assert.equal(next.grants.open().length, 1, "once");
  // After the deadline: nothing reissued; the file goes.
  await next.yt.stop();
  const late = setup({ extra: { turnFile: () => file, keptAlive: () => true, pagesNow: async () => tabs.list } });
  late.clock.t = r.expiresAt + 1;
  await late.yt.recover();
  assert.equal(late.grants.open().length, 0);
  assert.equal(late.sent.length, 0, "its end was said when the helper stopped");
  assert.equal(existsSync(file), false);
});

test("a browser restart whose tab doesn't come back, or a crash loop, ends with the stopped-safely message", async () => {
  const { s, tabs } = restartable();
  const page = pageAt("https://shop.example/login");
  s.hud.page = page;
  await s.yt.onStatus("p1", { kind: "you", text: "Sign in", step: "login" }, page);
  s.yt.browserClosed();
  tabs.list = [pageAt("https://other.example/")];
  await s.yt.recover();
  await tick();
  assert.equal(s.grants.open().length, 0);
  assert.equal(s.sent.at(-1).event, "pairbrowse.ended");
  assert.equal(s.sent.at(-1).reason, "browser-restarted");
  const t = restartable();
  t.s.hud.page = page;
  await t.s.yt.onStatus("p1", { kind: "you", text: "Sign in", step: "login" }, page);
  t.s.yt.browserClosed();
  t.s.yt.crashLoop();
  await tick();
  assert.deepEqual(t.s.sent.filter((m) => m.event === "pairbrowse.ended").map((m) => m.reason), ["browser-restarted"]);
  t.tabs.list = [page];
  await t.s.yt.recover();
  assert.equal(t.s.grants.open().length, 0, "nothing comes back after the crash loop ended it");
});

test("Fill saved card is sent only from a turn viewer's tap; no agent tool reaches it; saved card data stays out of logs and notifications", async () => {
  const { createTurnGate, FILL_CARD_WORDS } = await import("../scripts/liveview/grants.mjs");
  const { createTurnRoutes } = await import("../scripts/liveview/routes/turn.mjs");
  const { roleMay } = await import("../scripts/liveview/invites.mjs");
  const { SIGNALS, holdsCardNumber } = await import("../scripts/rules/cards.mjs");
  const s = setup();
  const page = pageAt("https://shop.example/checkout");
  const other = pageAt("https://news.example/");
  s.hud.page = page;
  await s.yt.onStatus("p1", { kind: "you", text: "Pay", step: "payment" }, page);
  const id = s.grants.open()[0].id;
  const guest = { id: `turn-${id}`, grant: id, role: "turn", label: "Hand-off" };
  const field = (signal, more = {}) => ({ signal, number: signal === SIGNALS.token("cc-number"), empty: true, first: true, numberElsewhere: false, ...more });
  let on = true, focus = field(SIGNALS.token("cc-number")), t = 0;
  const posted = [], logged = [];
  const cast = { state: { shown: { page } } };
  const gate = createTurnGate({ grants: s.grants, sessionName: () => "default", idOf: () => "aaaaaaaa", getContext: async () => null, cast, linkGuests: new Map(), clients: new Set(), viewers: new Set(),
    savedCard: () => on, humanPost: async (...a) => { posted.push(a); }, focused: async () => focus, now: () => t, log: (l) => logged.push(l) });
  const answer = () => { const r = { status: 0, body: null, writeHead(st) { this.status = st; }, setHeader() {}, end(b) { this.body = b ? JSON.parse(String(b)) : null; } }; return r; };
  const fill = async () => { const res = answer(); await gate.fillCard(res, guest); return res; };
  // The tap, with the card number field focused in the tab on screen: the person's own two keys.
  let r = await fill();
  assert.equal(r.status, 200);
  assert.deepEqual(posted, [["input", [{ type: "key", key: "ArrowDown", modifiers: 0 }, { type: "key", key: "Enter", modifiers: 0 }], "turn", "Hand-off (by hand)", `turn-${id}`]]);
  // A second tap at once is a repeat (its Enter could send the form): refused, said.
  r = await fill();
  assert.equal(r.status, 409);
  assert.equal(r.body.error, FILL_CARD_WORDS.again);
  t += 5000;
  // Another field focused, another tab on screen, or no saved card: refused with a sentence, nothing sent.
  focus = field(SIGNALS.token("cc-name"));
  assert.equal((await fill()).body.error, FILL_CARD_WORDS.field);
  // The card number holding text: the list wouldn't open and the Enter would reach the page.
  focus = field(SIGNALS.token("cc-number"), { empty: false });
  assert.equal((await fill()).body.error, FILL_CARD_WORDS.filled);
  // In a payment frame, only its card number: not the postal code after it, nor any field when the frame has a cc-number field elsewhere.
  focus = field(SIGNALS.payFrame, { first: false });
  assert.equal((await fill()).body.error, FILL_CARD_WORDS.field);
  focus = field(SIGNALS.cardFrame, { numberElsewhere: true });
  assert.equal((await fill()).body.error, FILL_CARD_WORDS.field);
  focus = null;
  assert.equal((await fill()).body.error, FILL_CARD_WORDS.field, "a page that didn't answer: nothing sent");
  assert.equal(posted.length, 1);
  focus = field(SIGNALS.cardFrame);
  assert.equal((await fill()).status, 200, "a card frame's first, empty field (a provider's form)");
  t += 5000;
  focus = field(SIGNALS.token("cc-number"));
  cast.state.shown = { page: other };
  assert.equal((await fill()).body.error, FILL_CARD_WORDS.away);
  cast.state.shown = { page };
  on = false;
  assert.equal((await fill()).body.error, FILL_CARD_WORDS.off);
  assert.equal(posted.length, 2);
  // Only a hand-off's view key reaches the route; no invite, join code or agent has the right.
  const route = createTurnRoutes(gate).find((x) => x.path === "turn-fill-card");
  assert.equal(route.right, "turn");
  for (const role of ["drive", "watch", "redeem"]) assert.equal(roleMay(role, "turn"), false, role);
  const catalog = readFileSync(new URL("../scripts/tools/catalog.mjs", import.meta.url), "utf8");
  assert.ok(!/fill-card|fill saved card|savedCard/i.test(catalog), "no agent tool names it");
  // Nothing of a card in the log, the trail or a message: the browser fills it, never this side.
  const everything = JSON.stringify({ logged, posted, sent: s.sent, audit: s.audit(), notes: s.notes });
  assert.ok(!holdsCardNumber(everything) && !everything.includes("4242"), everything);
  assert.ok(logged.every((l) => l === `hand-off ${id}: Fill saved card`), logged.join("\n"));
  gate.close();
});

test("Fill saved card reads the focused field: an empty card number goes; one holding text, or another field of a payment frame, never", async () => {
  const { fillProblem } = await import("../scripts/liveview/grants.mjs");
  const { focusedFillField } = await import("../scripts/runner/cards.mjs");
  const { cardPage } = await import("./helpers/card-page.mjs");
  const pay = { origin: "https://pay.example", allow: "payment" };
  const card = { origin: "https://js.pay.example", cardFields: true };
  const fields = {
    e1: { autocomplete: "cc-number" }, e2: { autocomplete: "cc-number", value: "4" }, e3: { autocomplete: "cc-name" }, e4: { name: "email", type: "email" },
    f1e1: { frame: pay, name: "number", placeholder: "1234 1234 1234 1234" }, f1e2: { frame: pay, name: "postal", placeholder: "ZIP" },
    f2e1: { frame: card, name: "postal" }, f3e1: { frame: { origin: "https://js.pay.example" }, autocomplete: "cc-number" },
  };
  const at = async (focused) => fillProblem(await focusedFillField(cardPage({ fields, focused })));
  assert.equal(await at("e1"), null, "the empty card number field");
  assert.equal(await at("e2"), "filled", "the card number field holding a value");
  assert.equal(await at("e3"), "field", "the name on the card");
  assert.equal(await at("e4"), "field");
  assert.equal(await at("f1e1"), null, "a payment frame's first field, empty");
  assert.equal(await at("f1e2"), "field", "a payment frame's postal code: its Enter would send the form");
  assert.equal(await at("f2e1"), "field", "a card frame's field that isn't its card number");
  assert.equal(await at("f3e1"), null, "a frame's own card number field");
  assert.equal(await at(null), "field", "nothing focused");
  assert.equal(fillProblem(null), "field", "a page that didn't answer");
});

test("the option list: a turn viewer gets the focused select's options of a scope tab and its choice goes as the person's arrow keys and Enter while the page's list is open, set on that select while closed; out of scope refused; no agent reaches it; labels never logged", async () => {
  const { createTurnGate } = await import("../scripts/liveview/grants.mjs");
  const { createTurnRoutes } = await import("../scripts/liveview/routes/turn.mjs");
  const { roleMay } = await import("../scripts/liveview/invites.mjs");
  const { pickKeys, listOf, OPTION_WORDS, OPTIONS_MAX } = await import("../scripts/liveview/options.mjs");
  const s = setup();
  const page = pageAt("https://shop.example/checkout");
  const other = pageAt("https://news.example/");
  s.hud.page = page;
  await s.yt.onStatus("p1", { kind: "you", text: "Pay", step: "payment" }, page);
  const id = s.grants.open()[0].id;
  const guest = { id: `turn-${id}`, grant: id, role: "turn", label: "Hand-off" };
  const month = (selected, open = true) => ({ label: "Expiry month", count: 4, selected, open,
    options: [{ label: "Month", disabled: true }, { label: "01 January", disabled: false }, { label: "02 February", disabled: false }, { label: "03 March", disabled: false }] });
  let sel = month(1);
  const posted = [], logged = [];
  const cast = { state: { shown: { page } } };
  const set = [];
  const gate = createTurnGate({ grants: s.grants, sessionName: () => "default", idOf: () => "aaaaaaaa", getContext: async () => null, cast, linkGuests: new Map(), clients: new Set(), viewers: new Set(),
    humanPost: async (route, keys) => { posted.push(keys.map((k) => k.key)); const downs = keys.filter((k) => k.key === "ArrowDown").length - keys.filter((k) => k.key === "ArrowUp").length; sel = { ...sel, selected: sel.selected + downs }; },
    select: async () => sel, choose: async (p, i, c) => { set.push([p === page, i, c]); return true; }, log: (l) => logged.push(l) });
  const answer = () => ({ status: 0, body: null, writeHead(st) { this.status = st; }, setHeader() {}, end(b) { this.body = b ? JSON.parse(String(b)) : null; } });
  const call = async (fn, ...a) => { const res = answer(); await gate[fn](res, guest, ...a); return res; };

  // After a tap on the select: its label, choice and options (the disabled placeholder marked).
  let r = await call("options");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { label: "Expiry month", selected: 1, options: month(1).options });
  // The choice: two enabled options down, then Enter while the list is open.
  r = await call("pick", { index: 3, count: 4 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(posted.at(-1), ["ArrowDown", "ArrowDown", "Enter"]);
  // A closed list gets no keys (Enter there sends the form on Linux; an arrow on macOS opens a menu
  // nobody sees): the choice is set on that same select.
  const sentBefore = posted.length;
  sel = month(3, false);
  r = await call("pick", { index: 1, count: 4 });
  assert.equal(r.status, 200);
  assert.equal(posted.length, sentBefore, "no keys");
  assert.deepEqual(set, [[true, 1, 4]]);
  // The disabled placeholder, a list that changed, or a page that didn't take it: refused, said.
  assert.equal((await call("pick", { index: 0, count: 4 })).body.error, OPTION_WORDS.disabled);
  assert.equal((await call("pick", { index: 2, count: 5 })).body.error, OPTION_WORDS.gone);
  const n = posted.length;
  const real = sel;
  sel = null;
  assert.equal((await call("pick", { index: 2, count: 4 })).body.error, OPTION_WORDS.gone, "no select focused any more");
  assert.deepEqual((await call("options")).body, { options: null });
  assert.equal(posted.length, n, "nothing sent");
  const stuck = createTurnGate({ grants: s.grants, sessionName: () => "default", idOf: () => "aaaaaaaa", getContext: async () => null, cast, linkGuests: new Map(), clients: new Set(), viewers: new Set(),
    humanPost: async () => {}, select: async () => sel, choose: async () => false });
  for (const open of [true, false]) {
    sel = { ...real, selected: 1, open };
    const res = answer();
    await stuck.pick(res, guest, { index: 2, count: 4 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, OPTION_WORDS.missed, "the page kept its choice: said, not claimed");
  }
  stuck.close();
  // Another tab on screen: refused and audited as out-of-scope input.
  cast.state.shown = { page: other };
  assert.equal((await call("options")).body.error, OPTION_WORDS.away);
  assert.equal((await call("pick", { index: 2, count: 4 })).body.error, OPTION_WORDS.away);
  assert.ok(s.audit().some((a) => a.kind === "input-refused" && a.detail === "out-of-scope"));
  cast.state.shown = { page };
  // A list too long to show is not listed (the type box's keys still work).
  assert.deepEqual(listOf({ ...month(1), count: OPTIONS_MAX + 1 }), { options: null });
  assert.deepEqual(pickKeys({ ...month(-1) }, 1, 4).keys.map((k) => k.key), ["ArrowDown", "Enter"], "nothing chosen yet: the first ArrowDown picks the first");
  assert.deepEqual(pickKeys(month(1, false), 2, 4), { keys: null }, "a closed list: no keys");
  // Only a hand-off's view key reaches the routes; no invite, join code or agent has the right.
  for (const path of ["turn-options", "turn-pick"]) assert.equal(createTurnRoutes(gate).find((x) => x.path === path).right, "turn", path);
  for (const role of ["drive", "watch", "redeem"]) assert.equal(roleMay(role, "turn"), false, role);
  const catalog = readFileSync(new URL("../scripts/tools/catalog.mjs", import.meta.url), "utf8");
  assert.ok(!/turn-options|turn-pick/.test(catalog), "no agent tool names it");
  // The log names the grant only, never an option.
  assert.ok(logged.length && logged.every((l) => l === `hand-off ${id}: chose from a list`), logged.join("\n"));
  assert.ok(!JSON.stringify({ logged, audit: s.audit(), sent: s.sent, notes: s.notes }).includes("January"));
  gate.close();
});

// PairBrowse's own check hands a CAPTCHA over, then the agent's status names the same step on the
// same tab: one hand-off and one message. A second grant used to end the first, whose link (on the
// phone already, or sent once the public address was up) then opened a 404.
test("the check, then the agent's status on the same tab and step: one grant, one message, the link stays live", async () => {
  const s = setup();
  const page = pageAt("https://www.google.com/recaptcha/api2/demo");
  s.yt.onChallenge(CHALLENGE_TURN, page);
  await until(() => s.sent.length === 1);
  const [g] = s.grants.open();
  const line = await s.yt.onStatus("p1", { kind: "you", text: "Solve the CAPTCHA", step: "captcha" }, page);
  assert.match(line, new RegExp(`hand-off ${g.id}`), line);
  assert.deepEqual(s.grants.open().map((x) => x.id), [g.id], "the same grant stands");
  assert.equal(s.sent.length, 1, "no second message");
  // The agent's next status ends it, as its own would.
  await s.yt.onStatus("p1", { kind: "working", text: "Going on" }, page);
  assert.equal(s.grants.open().length, 0);
});

test("a hand-off that ends while its link is starting sends nothing (its link would be dead)", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = setup({ extra: { linkFor: async (key) => { await gate; return `https://x.trycloudflare.com/${key}/`; } } });
  const page = pageAt("https://shop.example/login");
  const pending = s.yt.onStatus("p1", { kind: "you", text: "Please sign in", step: "login" }, page);
  await tick();
  const [g] = s.grants.open();
  s.grants.end(g.id, "agent");
  release();
  const line = await pending;
  assert.match(line, /ended before its message went out/, line);
  await tick();
  assert.equal(s.sent.filter((m) => m.event === "pairbrowse.turn").length, 0);
});
