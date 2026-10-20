// Compatibility failures vs site verification (spec server-mode B14, with C13, D16 and E13's
// coherence rules, scripts/rules/coherence.mjs): when a hand-off starts, the open compatibility
// items (the session's network verdict and coherence items, the running profile's) are reported
// apart from the site's own verification, as PairBrowse's to fix. A setup problem never mints a
// grant, never sends a your-turn message and is never handed to the person to work around; a
// site's verification is handed over once and never retried.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createYourTurn } from "../scripts/daemon/yourturn.mjs";
import { createGrants } from "../scripts/daemon/grants.mjs";
import { createNotifier, handoffSends } from "../scripts/daemon/notify/index.mjs";
import { createHandoffs } from "../scripts/daemon/toolstab.mjs";
import { createNetwork } from "../scripts/daemon/network.mjs";
import { EXTENSION_SHELL } from "../scripts/browser/choice.mjs";
import { CHALLENGE_TURN } from "../scripts/popups.mjs";

const dir = mkdtempSync(join(tmpdir(), "pb-compat-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const EXIT = "203.0.113.77";
const BERLIN = { timezone: "Europe/Berlin", languages: ["de-DE", "de"], geoip: { timezone: false, languages: false } };
const tick = () => new Promise((r) => setImmediate(r));
let n = 0;

// A tab that counts every way it could be retried (reload, navigation, going back).
function pageAt(url) {
  const page = { retries: 0, url: () => url, isClosed: () => false, context: () => ({ pages: () => [page] }) };
  for (const m of ["reload", "goto", "goBack", "goForward"]) page[m] = async () => { page.retries++; };
  return page;
}

// The session's network, launched behind a US exit with a Berlin browser (C13): its check passes
// and its coherence items stay open. recheck: what the next recheck's probe answers.
async function berlinBehindUs() {
  const base = join(dir, `net-${++n}`);
  mkdirSync(base, { recursive: true });
  const configFile = join(base, "config.json");
  writeFileSync(configFile, JSON.stringify({ network: { proxies: { "us-east": { server: "http://203.0.113.10:3128", onEgressChange: "notify" } }, sessions: { default: "us-east" } } }));
  const t = { helper: { ok: true, ip: EXIT, loc: "US" } };
  const networkMessages = [];
  const part = createNetwork({ log: () => {}, notify: () => {}, configFile, secretsFile: join(base, "secrets.env"), runDir: join(base, "run"),
    observationsFile: (s) => join(base, s, "network.json"), now: () => 1_000_000, recheckMs: 3_600_000, channels: (m) => { networkMessages.push(m); return null; },
    timers: { setTimeout: () => null, clearTimeout: () => {} },
    probe: async (args) => (args.proxy ? t.helper : { ok: true, ip: "192.0.2.50", loc: "DE" }),
    inBrowser: async () => ({ browser: { ok: true, ip: EXIT, loc: "US" }, webrtc: { ok: true, candidates: [] } }) });
  const lp = part.forLaunch("default", { shell: EXTENSION_SHELL, locale: BERLIN });
  const r = await part.checkAtLaunch({}, "default", lp);
  assert.deepEqual(r, { ok: true }, "a setup problem never stops the launch by itself");
  lp.started();
  lp.drop();
  return { part, t, networkMessages };
}

// Hand-offs on a server (they go to the channels: a webhook through a stub post), reading the
// session's open compatibility items as the helper does (context.compatibility).
function handoffs({ compatibility, server = true }) {
  const clock = { t: 1_800_000_000_000, m: 9_000 };
  const grants = createGrants({ now: () => clock.t, mono: () => clock.m, timers: { set: () => null, clear: () => {} } });
  const channels = [{ type: "webhook", urlSecret: "PAIRBROWSE_WEBHOOK_URL" }];
  const sent = [];
  const notifier = createNotifier({ channels: () => channels, secret: (k) => (k === "PAIRBROWSE_WEBHOOK_URL" ? "https://hooks.example.org/pb" : undefined), sendMaxMs: 1000,
    post: async (url, body) => { sent.push(JSON.parse(body)); return { ok: true, status: 200 }; } });
  const config = { handoff: { enabled: true, away: false, grantMinutes: 15, remindMinutes: 10, channels } };
  const notes = [];
  const hud = { page: null, async setBadge() {}, async setBadgeFor() {}, badge: () => ({ text: "", kind: "clear" }), sparkPage() { return this.page; }, sparkColor: () => "" };
  const yt = createYourTurn({ config, grants, notifier, handoffs: createHandoffs(), hud, hostNote: (x) => notes.push(x), journal: { flushNow: async () => {}, status: () => {} },
    sessionName: () => "default", linkFor: async (key) => `http://127.0.0.1:4100/${key}/`, sends: () => handoffSends(config, { server }),
    timers: { set: () => null, clear: () => {} }, now: () => clock.t, turnMs: () => 0, compatibility });
  return { yt, grants, sent, notes, hud };
}

test("a CAPTCHA with a time zone vs egress mismatch reports the mismatch under PairBrowse setup problems and the CAPTCHA under site verification, mints one grant for the CAPTCHA and never retries", async () => {
  const net = await berlinBehindUs();
  const s = handoffs({ compatibility: () => net.part.compatibility("default") });
  const page = pageAt("https://shop.example/checkout");
  s.hud.page = page;
  // The agent hands the CAPTCHA over.
  const line = await s.yt.onStatus("p1", { kind: "you", text: "Please solve the CAPTCHA", step: "captcha" }, page);
  const [first, verification, setup] = line.split("\n");
  assert.match(first, /^Your turn sent \(webhook\): hand-off [0-9a-f]{8} for tab 0/);
  assert.equal(verification, "Site verification (yours to do): CAPTCHA on shop.example.");
  assert.equal(setup, "PairBrowse setup problems (PairBrowse's to fix, not the user's to work around): time zone Europe/Berlin vs egress US; languages for DE vs egress US.");
  assert.ok(!line.includes(EXIT), "no address in the report");
  // One grant, for the CAPTCHA; one message, of the CAPTCHA's kind, naming no setup problem.
  const open = s.grants.open();
  assert.deepEqual(open.map((g) => [g.action, g.page === page]), [["captcha", true]]);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].kind, "captcha");
  assert.ok(!JSON.stringify(s.sent[0]).includes("Berlin") && !JSON.stringify(s.sent[0]).includes("time zone"), "the person is never asked to fix the setup");
  assert.equal(page.retries, 0, "the check is never retried");

  // PairBrowse's own check on another tab: the same two lists, to the agent in a host note.
  const other = pageAt("https://login.example/");
  s.yt.onChallenge(CHALLENGE_TURN, other);
  await tick(); await tick();
  s.yt.onChallenge(CHALLENGE_TURN, other); // seen again: the same hand-off, never a second
  await tick(); await tick();
  const checks = s.grants.open().filter((g) => g.page === other);
  assert.deepEqual(checks.map((g) => g.action), ["captcha"]);
  assert.equal(s.sent.filter((m) => m.host === "login.example").length, 1);
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0], /Site verification \(yours to do\): CAPTCHA on login\.example\. PairBrowse setup problems \(PairBrowse's to fix, not the user's to work around\): time zone Europe\/Berlin vs egress US/);
  assert.match(s.notes[0], /Don't retry the check or work around it\./);
  assert.equal(other.retries, 0);

  // A fast-mode run's hand-off step: no status result, so the same lists go in a host note.
  const run = pageAt("https://bank.example/verify");
  s.yt.onRunStatus("p2", "Enter the verification code from your phone", "you", run, "Agent");
  await tick(); await tick();
  assert.deepEqual(s.grants.open().filter((g) => g.page === run).map((g) => g.action), ["2fa"]);
  assert.equal(s.notes.length, 2);
  assert.match(s.notes[1], /^A fast-mode step handed this page to the user \(hand-off [0-9a-f]{8}\)\. Site verification \(yours to do\): a 2FA code on bank\.example\. PairBrowse setup problems \(PairBrowse's to fix, not the user's to work around\): time zone Europe\/Berlin vs egress US/);
  assert.match(s.notes[1], /Don't retry the step or work around it\.$/);
  assert.ok(!s.notes[1].includes(EXIT));
  assert.equal(run.retries, 0);

  // Nothing open: the result is the hand-off line alone.
  const clean = handoffs({ compatibility: () => [] });
  const p2 = pageAt("https://shop.example/");
  clean.hud.page = p2;
  assert.doesNotMatch(await clean.yt.onStatus("p1", { kind: "you", text: "x", step: "captcha" }, p2), /setup problems|Site verification/);
});

test("a compatibility problem alone mints no grant and sends no your-turn message", async () => {
  const net = await berlinBehindUs();
  // A recheck that moved the exit is a network verdict item too (onEgressChange "notify": told once).
  net.t.helper = { ok: true, ip: "198.51.100.9", loc: "FR" };
  assert.equal(await net.part.recheck(), "changed");
  const items = net.part.compatibility("default");
  assert.deepEqual(items.map((i) => i.id), ["network.verdict", "locale.timezone-vs-egress", "locale.language-vs-egress"]);
  assert.match(items[1].words, /time zone Europe\/Berlin vs egress FR/);
  assert.deepEqual(net.networkMessages.map((m) => m.kind), ["network"], "the network's own message, not a your-turn one");
  const s = handoffs({ compatibility: () => net.part.compatibility("default") });
  const page = pageAt("https://shop.example/");
  s.hud.page = page;
  // The agent works on, says it is done, the badge changes: no hand-off from any of it.
  assert.equal(await s.yt.onStatus("p1", { kind: "claude", text: "Filling the form" }, page), "");
  assert.equal(await s.yt.onStatus("p1", { kind: "done", text: "Done" }, page), "");
  s.yt.onBadge("p1", { kind: "claude", text: "Filling the form" });
  await s.yt.recover();
  await tick();
  assert.deepEqual([s.grants.open().length, s.sent.length, s.notes.length], [0, 0, 0]);
  assert.equal(page.retries, 0);
  // On a desktop without Away a hand-off stays in the window (decision 8): no grant, no report.
  const desk = handoffs({ compatibility: () => net.part.compatibility("default"), server: false });
  desk.hud.page = page;
  assert.equal(await desk.yt.onStatus("p1", { kind: "you", text: "Sign in", step: "login" }, page), "");
  assert.deepEqual([desk.grants.open().length, desk.sent.length], [0, 0]);
  // A compatibility reader that throws never stops a hand-off.
  const broken = handoffs({ compatibility: () => { throw new Error("boom"); } });
  broken.hud.page = page;
  assert.match(await broken.yt.onStatus("p1", { kind: "you", text: "Sign in", step: "login" }, page), /^Your turn sent/);
  assert.equal(broken.grants.open().length, 1);
});
