// Hand-off grants (daemon/grants.mjs, spec server-mode B2, B3, B4): a single-use redeem key that a
// GET never uses up, a view key with one stream at a time, expiry on two clocks, one session and
// one tab plus the tabs it opened, and no key ever outside mint's and redeem's answers.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createGrants, GRANT_MINUTES } = await import("../scripts/daemon/grants.mjs");
const { createAudit } = await import("../scripts/daemon/audit.mjs");
const { roleMay } = await import("../scripts/liveview/invites.mjs");

const MIN = 60_000;
const pageAt = (url) => ({ url: () => url });
const linesOf = (f) => { try { return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// A table on clocks the test moves, with a real audit file and the log kept.
function setup() {
  const clock = { t: 1_800_000_000_000, m: 5_000 };
  const file = join(mkdtempSync(join(tmpdir(), "pb-grants-")), "audit.jsonl");
  const logged = [];
  const timers = { set: () => null, clear: () => {} };
  const audit = createAudit({ file, now: () => clock.t });
  const grants = createGrants({ now: () => clock.t, mono: () => clock.m, audit, log: (l) => logged.push(l), timers });
  return { clock, file, logged, grants, lines: () => linesOf(file) };
}

test("mint gives 8-hex id and 64-hex keys; keys never in open(), audit or log lines", () => {
  const { grants, file, logged, lines } = setup();
  const page = pageAt("https://shop.example/checkout?token=abc#x");
  const g = grants.mint({ session: "default", page, action: "payment" });
  assert.match(g.id, /^[0-9a-f]{8}$/);
  assert.match(g.redeemKey, /^[0-9a-f]{64}$/);
  assert.equal(g.expiresAt - 1_800_000_000_000, GRANT_MINUTES.default * MIN);
  const r = grants.redeem(g.redeemKey, { session: "default" });
  assert.match(r.viewKey, /^[0-9a-f]{64}$/);
  assert.notEqual(r.viewKey, g.redeemKey);
  const listed = grants.open();
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ["action", "createdAt", "expiresAt", "id", "page", "redeemed", "scope", "session", "streaming"]);
  assert.equal(listed[0].redeemed, true);
  grants.end(g.id, "done");
  const said = JSON.stringify({ listed: listed.map(({ page: _p, scope: _s, ...v }) => v), logged, audit: readFileSync(file, "utf8") });
  for (const key of [g.redeemKey, r.viewKey]) assert.equal(said.includes(key), false);
  assert.deepEqual(lines().map((l) => [l.kind, l.detail]), [["minted", "payment"], ["redeemed", null], ["ended", "done"]]);
  assert.equal(lines()[0].tab, "https://shop.example/checkout", "origin and path only");
  assert.equal(lines()[0].grant, g.id);
});

test("a link preview's match uses nothing up; the tap does, once", () => {
  const { grants } = setup();
  const page = pageAt("https://example.com/login");
  const g = grants.mint({ session: "default", page, action: "login" });
  for (let i = 0; i < 3; i++) assert.equal(grants.matchRedeem(g.redeemKey, { session: "default" })?.id, g.id);
  assert.equal(grants.redeemKey(g.id), g.redeemKey, "the one reminder can carry the link while it is unused");
  assert.ok(grants.redeem(g.redeemKey, { session: "default" }));
  assert.equal(grants.redeemKey(g.id), null);
  assert.equal(grants.matchRedeem(g.redeemKey, { session: "default" }), null);
  assert.equal(grants.matchView(g.redeemKey, { session: "default" }), null, "a redeem key is never a view key");
});

test("a second redeem is null and audits reuse", () => {
  const { grants, lines } = setup();
  const g = grants.mint({ session: "default", page: pageAt("https://example.com/"), action: "captcha" });
  const r = grants.redeem(g.redeemKey, { session: "default" });
  assert.equal(grants.redeem(g.redeemKey, { session: "default" }), null);
  assert.deepEqual(lines().at(-1), { ...lines().at(-1), kind: "reuse", grant: g.id, detail: "redeem-key" });
  // The view key works until the grant ends; after that it is reuse too.
  assert.equal(grants.matchView(r.viewKey, { session: "default" })?.id, g.id);
  grants.end(g.id, "done");
  assert.equal(grants.matchView(r.viewKey, { session: "default" }), null);
  assert.equal(lines().at(-1).kind, "reuse");
  assert.equal(lines().at(-1).detail, "view-key");
  // A key never made is answered the same, and audits nothing.
  const n = lines().length;
  assert.equal(grants.redeem("0".repeat(64), { session: "default" }), null);
  assert.equal(grants.matchView("nope", { session: "default" }), null);
  assert.equal(grants.matchView(undefined, { session: "default" }), null);
  assert.equal(lines().length, n);
});

test("expiry on wall and monotonic clocks; a clock set back never extends it", () => {
  const { grants, clock, lines } = setup();
  const a = grants.mint({ session: "default", page: pageAt("https://a.example/"), action: "2fa", minutes: 5 });
  clock.t += 5 * MIN; // the wall clock reaches it
  assert.equal(grants.matchRedeem(a.redeemKey, { session: "default" }), null);
  assert.deepEqual(lines().filter((l) => l.kind === "ended").map((l) => l.detail), ["expired"]);
  const b = grants.mint({ session: "default", page: pageAt("https://b.example/"), action: "2fa", minutes: 5 });
  clock.t -= 60 * MIN; // set back an hour
  clock.m += 5 * MIN; // while 5 minutes really pass
  assert.equal(grants.matchRedeem(b.redeemKey, { session: "default" }), null);
  assert.equal(grants.open().length, 0);
  // After expiry the used keys' hashes go too: nothing kept past the grant's life.
  const c = grants.mint({ session: "default", page: pageAt("https://c.example/"), action: "other", minutes: 1 });
  grants.redeem(c.redeemKey, { session: "default" });
  clock.m += 2 * MIN;
  const n = lines().length;
  grants.sweep();
  assert.equal(grants.redeem(c.redeemKey, { session: "default" }), null);
  assert.equal(lines().slice(n).some((l) => l.kind === "reuse"), false);
});

test("each grant ends on its own at its deadline, waking a waiter", async () => {
  const set = [];
  const clock = { t: 1_000, m: 0 };
  const grants = createGrants({ now: () => clock.t, mono: () => clock.m, timers: { set: (fn, ms) => { set.push({ fn, ms }); return set.length; }, clear: () => {} } });
  const page = pageAt("https://a.example/");
  const g = grants.mint({ session: "default", page, action: "other", minutes: 2 });
  assert.equal(set[0].ms, 2 * MIN + 50);
  const waiting = grants.ended(page);
  clock.t += 2 * MIN; clock.m += 2 * MIN;
  set[0].fn();
  assert.deepEqual(await waiting, { id: g.id, reason: "expired" });
  assert.equal(grants.ended(page), null, "nothing to wait for once no grant covers the tab");
});

test("mint's limits: minutes 1 to 120, a replacement keeps its deadline", () => {
  const { grants, clock, lines } = setup();
  const page = pageAt("https://a.example/");
  for (const minutes of [0, 121, 1.5, "x", -3]) assert.throws(() => grants.mint({ session: "default", page, action: "login", minutes }), /minutes/);
  assert.throws(() => grants.mint({ session: "../x", page, action: "login" }), /session/);
  assert.throws(() => grants.mint({ session: "default", page, action: "anything" }), /action/);
  assert.throws(() => grants.mint({ session: "default", action: "login" }), /page/);
  assert.throws(() => grants.mint({ session: "default", page, action: "login", expiresAt: clock.t }), /passed/);
  assert.throws(() => grants.mint({ session: "default", page, action: "login", expiresAt: clock.t + 121 * MIN }), /120/);
  assert.equal(grants.mint({ session: "default", page, action: "login", minutes: 120 }).expiresAt, clock.t + 120 * MIN);
  const deadline = clock.t + 7 * MIN;
  const r = grants.mint({ session: "default", page, action: "login", expiresAt: deadline, replacement: true });
  assert.equal(r.expiresAt, deadline);
  assert.deepEqual(lines().filter((l) => l.kind === "minted").at(-1).detail, ["login", "replacement"]);
  // The second mint on that page ended the first: one grant per tab handed over.
  assert.deepEqual(grants.open().map((g) => g.id), [r.id]);
  assert.equal(lines().filter((l) => l.kind === "ended").at(-1).detail, "agent");
  assert.throws(() => grants.end(r.id, "because"), /reason/);
});

test("another session's redeem is refused; a session switch or main tab close ends the grant", () => {
  const { grants, lines } = setup();
  const page = pageAt("https://a.example/");
  const a = grants.mint({ session: "work", page, action: "login" });
  assert.equal(grants.redeem(a.redeemKey, { session: "default" }), null);
  assert.equal(grants.open().length, 0, "a mismatch ends the grant");
  assert.equal(lines().filter((l) => l.kind === "ended").at(-1).detail, "session-switched");
  assert.equal(grants.redeem(a.redeemKey, { session: "work" }), null, "and its key is gone for good");
  // Through a view key too.
  const b = grants.mint({ session: "work", page, action: "login" });
  const v = grants.redeem(b.redeemKey, { session: "work" }).viewKey;
  assert.equal(grants.matchView(v, { session: "default" }), null);
  assert.equal(grants.matchView(v, { session: "work" }), null);
  // The owner's switch ends every grant of the old session.
  const c = grants.mint({ session: "work", page, action: "login" });
  const d = grants.mint({ session: "other", page: pageAt("https://d.example/"), action: "login" });
  assert.equal(grants.endWhere((g) => g.session === "work", "session-switched"), 1);
  assert.deepEqual(grants.open().map((g) => g.id), [d.id]);
  assert.equal(grants.matchRedeem(c.redeemKey, { session: "work" }), null);
  // Closing the tab handed over ends it; closing a pop-up only leaves the scope.
  const popup = pageAt("https://pay.example/3ds");
  const main = pageAt("https://shop.example/pay");
  const e = grants.mint({ session: "default", page: main, action: "payment" });
  assert.equal(grants.addToScope(main, popup), e.id);
  grants.closed(popup);
  assert.equal(grants.inScope(popup), false);
  assert.equal(grants.inScope(main, e.id), true);
  grants.closed(main);
  assert.equal(grants.inScope(main), false);
  assert.equal(lines().filter((l) => l.kind === "ended").at(-1).detail, "tab-closed");
});

test("scope: the tab handed over plus the tabs it opened while the grant was live", async () => {
  const { grants } = setup();
  const main = pageAt("https://shop.example/pay");
  const other = pageAt("https://news.example/");
  const g = grants.mint({ session: "default", page: main, action: "payment" });
  const popup = pageAt("https://bank.example/3ds");
  assert.equal(grants.addToScope(main, popup), g.id);
  const second = pageAt("https://bank.example/next");
  assert.equal(grants.addToScope(popup, second), g.id, "a pop-up's own pop-up joins too");
  assert.equal(grants.addToScope(other, pageAt("https://x.example/")), null, "a tab opened elsewhere does not");
  assert.equal(grants.addToScope(null, pageAt("https://y.example/")), null);
  assert.equal(grants.inScope(other), false);
  assert.equal(grants.forPage(popup).id, g.id);
  assert.deepEqual(grants.forPage(main).scope, [main, popup, second]);
  assert.equal(grants.forPage(other), null);
  const seen = [];
  const off = grants.onEnd((v, reason) => seen.push([v.id, reason]));
  const waiting = grants.ended(popup);
  assert.equal(grants.end(g.id, "done"), true);
  assert.equal(grants.end(g.id, "done"), false, "ends once");
  assert.deepEqual(await waiting, { id: g.id, reason: "done" });
  assert.deepEqual(seen, [[g.id, "done"]]);
  off();
  assert.equal(grants.addToScope(main, pageAt("https://z.example/")), null, "no scope grows after the end");
});

test("a view key holds one stream at a time; a reconnect after a drop works within the grant's life", () => {
  const { grants, lines } = setup();
  const g = grants.mint({ session: "default", page: pageAt("https://a.example/"), action: "captcha" });
  assert.equal(grants.openStream(g.id), null, "no stream before the tap");
  grants.redeem(g.redeemKey, { session: "default" });
  const first = grants.openStream(g.id);
  assert.ok(first);
  assert.equal(grants.open()[0].streaming, true);
  assert.equal(grants.openStream(g.id), null);
  assert.deepEqual([lines().at(-1).kind, lines().at(-1).detail], ["stream-refused", "second-stream"]);
  first.close();
  first.close();
  const again = grants.openStream(g.id);
  assert.ok(again, "the same device reconnects");
  grants.end(g.id, "revoked");
  assert.equal(grants.openStream(g.id), null);
  again.close();
});

test("a held tab keeps no keys and lets go on a new grant, a release or the session's end", () => {
  const { grants } = setup();
  const a = pageAt("https://a.example/"), b = pageAt("https://b.example/"), c = pageAt("https://c.example/");
  grants.hold(a, { session: "work" });
  grants.hold(b, { session: "work" });
  grants.hold(c, { session: "default" });
  assert.equal(grants.held(a), true);
  assert.equal(grants.inScope(a), false, "held is not handed over");
  grants.mint({ session: "work", page: a, action: "login" });
  assert.equal(grants.held(a), false, "a new you releases it");
  assert.equal(grants.release({ session: "work" }), 1);
  assert.equal(grants.held(b), false);
  assert.equal(grants.release(c), 1);
  assert.equal(grants.release(c), 0);
  assert.throws(() => grants.hold(a, { session: "" }), /session/);
});

test("grant roles: turn sees and drives the scope and its own routes, redeem only the landing page and its still", () => {
  for (const r of ["page", "events", "thumb", "state", "input", "turn"]) assert.equal(roleMay("turn", r), true, r);
  for (const r of ["tab", "profile", "approve", "invite", "tools", "session", "config", "journal", "record", "layout", "strip", "timeline", "outline", "capture", "activity"]) {
    assert.equal(roleMay("turn", r), false, `turn ${r}`);
    assert.equal(roleMay("redeem", r), false, `redeem ${r}`);
  }
  assert.equal(roleMay("redeem", "page"), true);
  assert.equal(roleMay("redeem", "thumb"), true, "the landing page's still of the tab");
  for (const r of ["events", "state", "input", "turn"]) assert.equal(roleMay("redeem", r), false, r);
  for (const role of ["owner", "drive", "watch", "approve"]) assert.equal(roleMay(role, "turn"), false, role);
});

test("onEnd reports the grant as it ended: never opened, or redeemed", () => {
  const { grants, clock } = setup();
  const seen = [];
  grants.onEnd((v, reason) => seen.push([v.id, v.redeemed, v.streaming, reason]));
  const a = grants.mint({ session: "default", page: pageAt("https://a.example/"), action: "login", minutes: 1 });
  clock.t += MIN; clock.m += MIN;
  grants.sweep();
  const b = grants.mint({ session: "default", page: pageAt("https://b.example/"), action: "login" });
  const r = grants.redeem(b.redeemKey, { session: "default" });
  assert.ok(grants.openStream(r.id));
  grants.end(b.id, "done");
  assert.deepEqual(seen, [[a.id, false, false, "expired"], [b.id, true, true, "done"]]);
});

test("a new grant on a tab in another grant's scope takes it out of that scope", () => {
  const { grants } = setup();
  const shop = pageAt("https://shop.example/checkout");
  const popup = pageAt("https://bank.example/3ds");
  const g1 = grants.mint({ session: "default", page: shop, action: "payment" });
  assert.equal(grants.addToScope(shop, popup), g1.id);
  const g2 = grants.mint({ session: "default", page: popup, action: "2fa" });
  assert.equal(grants.inScope(popup, g1.id), false);
  assert.equal(grants.inScope(popup, g2.id), true);
  assert.equal(grants.inScope(shop, g1.id), true, "the first grant keeps its own tab");
  assert.equal(grants.forPage(popup).id, g2.id);
  assert.equal(grants.open().length, 2);
});

test("a key matched without the session open now throws and ends nothing", () => {
  const { grants, lines } = setup();
  const g = grants.mint({ session: "default", page: pageAt("https://a.example/"), action: "login" });
  assert.throws(() => grants.matchRedeem(g.redeemKey), /session/);
  assert.throws(() => grants.redeem(g.redeemKey, {}), /session/);
  assert.throws(() => grants.matchView(g.redeemKey, { session: "" }), /session/);
  assert.equal(grants.open().length, 1);
  assert.deepEqual(lines().map((l) => l.kind), ["minted"]);
  assert.ok(grants.redeem(g.redeemKey, { session: "default" }));
});

test("match finds either key in one pass, a used one audited once; refused audits only a live grant's stream or input", () => {
  const { grants, lines } = setup();
  const page = pageAt("https://example.com/login");
  const g = grants.mint({ session: "default", page, action: "login" });
  assert.deepEqual([grants.match(g.redeemKey, { session: "default" }).role, grants.open()[0].redeemed], ["redeem", false], "matching uses nothing up");
  const r = grants.redeem(g.redeemKey, { session: "default" });
  assert.equal(grants.match(r.viewKey, { session: "default" }).role, "turn");
  assert.equal(grants.match(g.redeemKey, { session: "default" }), null);
  assert.equal(lines().filter((l) => l.kind === "reuse").length, 1, "one reuse line for one try");
  assert.throws(() => grants.match(r.viewKey, {}), /session/);
  assert.equal(grants.refused(g.id, "input-refused", "out-of-scope"), true);
  assert.equal(grants.refused(g.id, "ended", "done"), false, "only stream and input refusals");
  assert.equal(grants.refused("00000000", "stream-refused", "other-origin"), false);
  assert.deepEqual(lines().filter((l) => l.kind === "input-refused").map((l) => [l.grant, l.detail]), [[g.id, "out-of-scope"]]);
});
