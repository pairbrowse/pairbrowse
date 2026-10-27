// A running proxied session's exit, checked again (spec server-mode C8): every recheckMinutes the
// helper reads the exit through the same proxy and compares it with the exit before; an exit that
// moved, or a recheck that fails, does what onEgressChange says ("pause" by default: every agent
// held as a person's Pause holds them, a host's state never lifting it; "notify"; "ignore" lets an address change pass, never a failure),
// once per change and once per run of failures, telling the person in the window and, where
// hand-offs go to their channels, with a "network" message naming only the proxy and what happened.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createNetwork, RECHECK_PAUSER } from "../scripts/daemon/network.mjs";
import { EXTENSION_SHELL, shellFrom } from "../scripts/browser/choice.mjs";
import { createContext } from "../scripts/daemon/context.mjs";
import { createPause } from "../scripts/daemon/pause.mjs";
import { messageProblem } from "../scripts/daemon/notify/message.mjs";
import { sendWhereHandoffsGo } from "../scripts/daemon/notify/index.mjs";
import { testHome } from "./helpers/home.mjs";

const dir = mkdtempSync(join(tmpdir(), "pb-net-recheck-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const AUTH_SHELL = shellFrom({ chrome: 1, proxyAuthFile: 1 });
const EXIT = "203.0.113.77", MOVED = "203.0.113.78", HOME_IP = "192.0.2.50";
const USER = "proxy-user-1", PASS = "s3cret-pass-word";
const MDNS = "candidate:1 1 udp 2122260223 1f4712db-ea17-4bcf-a596-105139dfd8bf.local 54321 typ host generation 0";

// Timers the test runs by hand: the one armed, its interval, and whether it was cleared.
function handTimers() {
  const t = { armed: [], cleared: [] };
  t.setTimeout = (fn, ms) => { const h = { fn, ms, unref() { h.unrefd = true; } }; t.armed.push(h); return h; };
  t.clearTimeout = (h) => { if (h) t.cleared.push(h); };
  t.fire = async () => { const h = t.armed.at(-1); await h.fn(); await new Promise((r) => setImmediate(r)); };
  return t;
}

// A network part with its own files, stub probes, a pause, the person's notes and the channels.
function setup(name, network, { secrets = null, recheckMs = 60_000, pausing = createPause() } = {}) {
  const base = join(dir, name);
  mkdirSync(base, { recursive: true });
  const configFile = join(base, "config.json"), secretsFile = join(base, "secrets.env");
  writeFileSync(configFile, JSON.stringify({ network }));
  if (secrets) writeFileSync(secretsFile, secrets, { mode: 0o600 });
  const files = (s) => join(base, s, "network.json");
  const s = { helper: { ok: true, ip: EXIT, loc: "US" }, direct: { ok: true, ip: HOME_IP, loc: "DE" }, probes: [], lines: [], notes: [], sent: [], pauses: [], now: 1_700_000_000_000, files, pausing };
  s.timers = handTimers();
  s.part = createNetwork({
    log: (l) => s.lines.push(l), notify: (text) => s.notes.push(text), configFile, secretsFile, runDir: join(base, "run"), observationsFile: files,
    now: () => s.now, recheckMs, timers: s.timers,
    pause: (who) => { s.pauses.push(who); return pausing.hold(who); },
    channels: async (message) => { s.sent.push(message); return { sent: ["webhook"], failed: [], withheld: [] }; },
    probe: async (args) => { s.probes.push(args); return args.proxy ? (typeof s.helper === "function" ? s.helper() : s.helper) : s.direct; },
    inBrowser: async () => ({ browser: { ok: true, ip: EXIT, loc: "US" }, webrtc: { ok: true, candidates: [MDNS] } }),
  });
  s.start = async (session = "shop", shell = EXTENSION_SHELL) => {
    const lp = s.part.forLaunch(session, { shell });
    const r = await s.part.checkAtLaunch({}, session, lp);
    assert.deepEqual(r, { ok: true });
    lp.started();
    lp.drop();
    s.probes.length = 0;
    return lp;
  };
  s.checks = (session = "shop") => JSON.parse(readFileSync(files(session), "utf8")).checks;
  return s;
}
const proxied = (more = {}, net = {}) => ({ proxies: { "us-east": { server: "http://203.0.113.10:3128", ...more } }, sessions: { shop: "us-east" }, ...net });
const noAddress = (text) => { for (const ip of [EXIT, MOVED, HOME_IP]) assert.ok(!String(text).includes(ip), `${ip} in: ${text}`); };

test("the running browser's rechecks: armed once it is up, every recheckMinutes, ended by its own close only", async () => {
  const s = setup("timer", proxied({}, { recheckMinutes: 7 }), { recheckMs: null });
  const lp = await s.start();
  assert.equal(s.timers.armed.length, 1);
  assert.equal(s.timers.armed[0].ms, 7 * 60_000, "recheckMinutes");
  assert.equal(s.timers.armed[0].unrefd, true, "never keeps the helper up");
  await s.timers.fire();
  assert.equal(s.probes.length, 2, "through the proxy, and this computer's own exit (no expectEgress)");
  assert.equal(s.probes[0].proxy.host, "203.0.113.10");
  assert.equal(s.probes[1].proxy, null);
  assert.equal(s.timers.armed.length, 2, "the next one armed after it");
  // Another launch's handle (an older browser closing late) leaves these rechecks on.
  const other = setup("timer-other", proxied());
  s.part.stop(await other.start());
  s.part.stop({});
  assert.equal(s.timers.cleared.length, 0);
  s.part.stop(lp);
  assert.deepEqual(s.timers.cleared, [s.timers.armed[1]]);
  assert.equal(await s.part.recheck(), null, "none running");
  // A recheck that comes back after its browser closed is dropped.
  const late = setup("late", proxied());
  const llp = await late.start();
  let answer;
  late.helper = () => new Promise((r) => { answer = r; });
  const pending = late.timers.armed[0].fn();
  late.part.stop(llp);
  answer({ ok: true, ip: MOVED, loc: "US" });
  await pending;
  assert.equal(late.checks().length, 1, "only the launch's check kept");
  assert.deepEqual([late.pauses, late.notes, late.sent], [[], [], []]);
  // RECHECK_MS (a harness-started helper only) stands in for recheckMinutes.
  process.env.PAIRBROWSE_TEST_RECHECK_MS = "250";
  try {
    const q = setup("switch", proxied(), { recheckMs: null });
    await q.start();
    assert.equal(q.timers.armed[0].ms, 250);
  } finally { delete process.env.PAIRBROWSE_TEST_RECHECK_MS; }
  // A direct session has no rechecks.
  const d = setup("direct", { proxies: {}, sessions: { shop: null } });
  await d.start();
  assert.equal(d.timers.armed.length, 0);
});

test("a passing recheck: kept as kind recheck without the browser's or this computer's address; status says when", async () => {
  const s = setup("pass", proxied());
  await s.start();
  assert.equal(await s.part.recheck(), "ok");
  const c = s.checks().at(-1);
  assert.deepEqual({ ...c, at: "t" }, { at: "t", kind: "recheck", proxy: "us-east", server: "http://203.0.113.10:3128", browser: null,
    helper: { ip: EXIT, loc: "US" }, sameAsDirect: false, webrtc: null, dns: "strict", verdict: "ok", reason: "", coherence: [] });
  assert.ok(!readFileSync(s.files("shop"), "utf8").includes(HOME_IP), "this computer's own exit is never kept");
  assert.deepEqual(s.part.statusParts("shop"), ['network "us-east" (strict): exit checked at launch, last rechecked at 22:13 UTC, country US']);
  assert.deepEqual([s.pauses, s.notes, s.sent], [[], [], []]);
});

test("an exit that moved pauses agents (the default), tells the person and the channels once per change", async () => {
  const s = setup("changed", proxied());
  await s.start();
  s.helper = { ok: true, ip: MOVED, loc: "US" };
  assert.equal(await s.part.recheck(), "changed");
  assert.deepEqual(s.pauses, [RECHECK_PAUSER]);
  assert.equal(s.pausing.view().paused, true);
  assert.equal(s.pausing.view().by, RECHECK_PAUSER);
  assert.deepEqual(s.notes, ['Session "shop": the exit address of its proxy "us-east" changed. Agents are paused until you resume them. Nothing went around the proxy. See pairbrowse_status or daemon.log.']);
  assert.deepEqual(s.sent, [{ kind: "network", network: "us-east", change: "changed", paused: true, at: s.now }]);
  assert.equal(messageProblem(s.sent[0]), "", "a message the notifier accepts");
  assert.deepEqual(s.part.statusParts("shop"), ['warning: network "us-east" (strict): its exit address changed at 22:13 UTC, country US. Agents were paused for it until a person resumes them.']);
  assert.equal(s.checks().at(-1).verdict, "changed");
  // The same new exit at the next recheck: no second pause or message.
  s.pausing.resume("Sam");
  assert.equal(await s.part.recheck(), "ok");
  assert.deepEqual([s.pauses.length, s.notes.length, s.sent.length], [1, 1, 1]);
  assert.equal(s.pausing.view().paused, false, "a person's resume holds");
  // Back to the first exit: that is a change again.
  s.helper = { ok: true, ip: EXIT, loc: "US" };
  assert.equal(await s.part.recheck(), "changed");
  assert.deepEqual([s.pauses.length, s.notes.length, s.sent.length], [2, 2, 2]);
  for (const text of [...s.notes, ...s.lines, ...s.part.statusParts("shop"), JSON.stringify(s.sent)]) noAddress(text);
});

test("a failed recheck pauses once per run of failures; a proxy back up and failing again acts again", async () => {
  const s = setup("failed", proxied());
  await s.start();
  s.helper = { ok: false, step: "connect", problem: "proxy 203.0.113.10:3128 refused the connection" };
  assert.equal(await s.part.recheck(), "failed");
  assert.deepEqual(s.pauses, [RECHECK_PAUSER]);
  assert.deepEqual(s.notes, ['Session "shop": its proxy "us-east" failed its recheck. Agents are paused until you resume them. Nothing went around the proxy. See pairbrowse_status or daemon.log.']);
  assert.deepEqual(s.sent.map((m) => [m.change, m.paused]), [["failed", true]]);
  const [warning] = s.part.statusParts("shop");
  assert.match(warning, /^warning: network "us-east" \(strict\) failed its recheck at 22:13 UTC: The check through the proxy failed: .* Agents were paused for it until a person resumes them\.$/);
  // Still down: said once.
  s.helper = { ok: false, step: "tunnel", problem: "timed out (tunnel, 10000 ms in all)", timedOut: true };
  assert.equal(await s.part.recheck(), "failed");
  assert.deepEqual([s.pauses.length, s.notes.length, s.sent.length], [1, 1, 1]);
  assert.match(s.part.statusParts("shop")[0], /timed out.*Agents were paused/);
  // Up again, then down: told again.
  s.helper = { ok: true, ip: EXIT, loc: "US" };
  assert.equal(await s.part.recheck(), "ok");
  assert.ok(s.lines.includes('network: "us-east" passed its recheck again'));
  s.helper = { ok: false, step: "connect", problem: "proxy 203.0.113.10:3128 refused the connection" };
  assert.equal(await s.part.recheck(), "failed");
  assert.deepEqual([s.pauses.length, s.notes.length, s.sent.length], [2, 2, 2]);
});

test("a recheck whose probe never answers is bounded and fails, never passes", async () => {
  process.env.PAIRBROWSE_TEST_NET_CHECK = JSON.stringify({ ms: 100 });
  try {
    const h = setup("hung", proxied());
    await h.start();
    h.helper = () => new Promise(() => {});
    const t0 = Date.now();
    assert.equal(await h.part.recheck(), "failed");
    assert.ok(Date.now() - t0 < 5000, "within the check's bound");
    assert.match(h.checks().at(-1).reason, /didn't finish/);
    assert.equal(h.pauses.length, 1);
  } finally { delete process.env.PAIRBROWSE_TEST_NET_CHECK; }
});

test("expectEgress: an exit outside it fails the recheck, and this computer's own exit isn't read", async () => {
  const s = setup("expect", proxied({ expectEgress: ["country:US"] }));
  await s.start();
  s.helper = { ok: true, ip: EXIT, loc: "FR" };
  assert.equal(await s.part.recheck(), "failed");
  assert.equal(s.probes.length, 1, "no direct probe with an expectation");
  assert.match(s.checks().at(-1).reason, /outside the addresses or countries its expectEgress lists/);
  assert.equal(s.pauses.length, 1);
  // The exit became this computer's own (no expectEgress): a failure.
  const d = setup("same", proxied());
  await d.start();
  d.helper = { ok: true, ip: HOME_IP, loc: "DE" };
  assert.equal(await d.part.recheck(), "failed");
  assert.match(d.checks().at(-1).reason, /this computer's own/);
});

test("onEgressChange notify tells without pausing; ignore lets an address change pass but still pauses on a failure", async () => {
  const n = setup("notify", proxied({ onEgressChange: "notify" }));
  await n.start();
  n.helper = { ok: true, ip: MOVED, loc: "US" };
  assert.equal(await n.part.recheck(), "changed");
  assert.deepEqual(n.pauses, []);
  assert.equal(n.pausing.view().paused, false);
  assert.deepEqual(n.notes, ['Session "shop": the exit address of its proxy "us-east" changed. Agents go on (onEgressChange "notify"). Nothing went around the proxy. See pairbrowse_status or daemon.log.']);
  assert.deepEqual(n.sent.map((m) => [m.change, m.paused]), [["changed", false]]);
  assert.match(n.part.statusParts("shop")[0], /^warning: .*changed at .* You were told; agents went on\.$/);

  const i = setup("ignore", proxied({ onEgressChange: "ignore", expectEgress: ["country:US"] }));
  await i.start();
  i.helper = { ok: true, ip: MOVED, loc: "US" };
  assert.equal(await i.part.recheck(), "changed");
  assert.deepEqual([i.pauses, i.notes, i.sent], [[], [], []]);
  assert.match(i.part.statusParts("shop")[0], /^network "us-east" \(strict\): exit checked at launch, last rechecked at/);
  assert.equal(i.checks().at(-1).verdict, "changed", "still recorded");
  i.helper = { ok: true, ip: MOVED, loc: "FR" };
  assert.equal(await i.part.recheck(), "failed");
  assert.deepEqual(i.pauses, [RECHECK_PAUSER], "outside its expectEgress: paused");
  assert.deepEqual(i.sent.map((m) => [m.change, m.paused]), [["failed", true]]);
});

test("a proxy with credentials: the recheck uses the launch's, after the auth file is gone; nothing said carries them", async () => {
  const secrets = `PAIRBROWSE_PROXY_US_EAST_USERNAME="${USER}"\nPAIRBROWSE_PROXY_US_EAST_PASSWORD="${PASS}"\n`;
  const s = setup("auth", proxied({ auth: true }), { secrets });
  await s.start("shop", AUTH_SHELL);
  assert.ok(existsSync(join(dir, "auth", "run")));
  assert.deepEqual(readdirSync(join(dir, "auth", "run")), [], "the auth file is gone once the browser is up");
  s.helper = { ok: false, step: "tunnel", problem: "proxy 203.0.113.10:3128 asked for credentials again (407)" };
  assert.equal(await s.part.recheck(), "failed");
  assert.deepEqual(s.probes[0].auth, { username: USER, password: PASS });
  const said = [...s.lines, ...s.notes, readFileSync(s.files("shop"), "utf8"), ...s.part.statusParts("shop"), JSON.stringify(s.sent)].join("\n");
  assert.ok(!said.includes(PASS) && !said.includes(USER), said);
});

test("a clean session's rechecks stay in memory only", async () => {
  const s = setup("clean", proxied({}, { sessions: { "clean-3": "us-east" } }));
  await s.start("clean-3");
  assert.equal(await s.part.recheck(), "ok");
  assert.equal(existsSync(s.files("clean-3")), false);
  assert.deepEqual(s.part.observations("clean-3").map((c) => c.kind), ["launch", "recheck"]);
});

// Through the launch (daemon/browser/launch.mjs): the rechecks start once the browser is up and end
// when it closes. adopting(ctx): what the stand-in browser does when the launch first lists its
// tabs to adopt them, after started() and before the close handler is on.
function launchThrough(name, { adopting = () => {} } = {}) {
  const cfg = join(testHome, "config.json");
  const timers = handTimers();
  const quiet = () => {};
  const said = { pauses: [], notes: [], sent: [] };
  const network = createNetwork({ configFile: cfg, runDir: join(dir, `run-${name}`), observationsFile: (s) => join(dir, name, s, "network.json"), recheckMs: 1000, timers,
    pause: (who) => { said.pauses.push(who); return true; }, notify: (t) => said.notes.push(t), channels: (m) => { said.sent.push(m); return null; },
    // The exit moved by the time any recheck reads it: one that ran would pause and tell.
    probe: async (a) => (a.proxy ? { ok: true, ip: timers.armed.length ? MOVED : EXIT, loc: "US" } : { ok: true, ip: HOME_IP, loc: "DE" }),
    inBrowser: async () => ({ browser: { ok: true, ip: EXIT, loc: "US" }, webrtc: { ok: true, candidates: [] } }) });
  const launchPersistentContext = async () => {
    const ctx = new EventEmitter();
    let listed = false;
    ctx.pages = () => { if (!listed) { listed = true; adopting(ctx); } return []; };
    ctx.addInitScript = async () => {};
    ctx.browser = () => null;
    ctx.close = async () => { ctx.emit("close"); };
    return ctx;
  };
  const context = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none", sessionPicker: false }, log: quiet, chromium: { launchPersistentContext },
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet, network,
  });
  const session = context.sessionName();
  writeFileSync(cfg, JSON.stringify({ network: { proxies: { a: { server: "http://203.0.113.10:3128" } }, sessions: { [session]: "a" } } }));
  return { context, network, timers, said, done: () => writeFileSync(cfg, JSON.stringify({})) };
}

test("through createContext: rechecks armed after the launch, ended by the browser's close", { timeout: 30_000 }, async () => {
  const l = launchThrough("ctx");
  try {
    await l.context.getContext();
    assert.equal(l.timers.armed.length, 1);
    assert.equal(l.timers.armed[0].ms, 1000);
    await l.context.close();
    assert.deepEqual(l.timers.cleared, [l.timers.armed[0]], "the close ended them");
    assert.equal(await l.network.recheck(), null, "none running");
  } finally { l.done(); }
});

// Between started() and the launch's close handler (its page script added, its tabs adopted): a
// browser that closes there, or a launch that fails there, leaves no rechecks behind to pause
// agents or tell anyone about a session that isn't running.
test("a browser closing, or a launch failing, after the rechecks start but before the close handler is on ends them", { timeout: 30_000 }, async () => {
  const closing = launchThrough("ctx-crash", { adopting: (ctx) => ctx.emit("close") });
  try {
    await closing.context.getContext().catch(() => {});
    assert.equal(closing.timers.armed.length, 1, "they had started");
    assert.deepEqual(closing.timers.cleared, [closing.timers.armed[0]], "the close ended them");
    assert.equal(await closing.network.recheck(), null);
    await closing.timers.armed[0].fn(); // a timer already on its way does nothing
    assert.deepEqual(closing.said, { pauses: [], notes: [], sent: [] });
  } finally { closing.done(); }
  const failing = launchThrough("ctx-fail", { adopting: () => { throw new Error("the tabs couldn't be listed"); } });
  try {
    await assert.rejects(failing.context.getContext(), /the tabs couldn't be listed/);
    assert.equal(failing.timers.armed.length, 1, "they had started");
    assert.deepEqual(failing.timers.cleared, [failing.timers.armed[0]], "the failed launch ended them");
    assert.equal(await failing.network.recheck(), null);
    await failing.timers.armed[0].fn();
    assert.deepEqual(failing.said, { pauses: [], notes: [], sent: [] });
  } finally { failing.done(); }
});

// Decision 8: the network message goes where hand-offs go, through the notifier, and nowhere else.
test("sendWhereHandoffsGo: a desktop with a usable channel or a server sends once; no usable channel on a desktop, or handoff not enabled, sends nothing", async () => {
  const message = { kind: "network", network: "us-east", change: "changed", paused: true, at: 1_700_000_000_000 };
  const cases = [
    { name: "desktop, no usable channel", config: { handoff: { enabled: true } }, server: false, usable: 0, sends: 0 },
    { name: "desktop, a channel (Away off is ignored)", config: { handoff: { enabled: true, away: false } }, server: false, usable: 1, sends: 1 },
    { name: "server", config: { handoff: { enabled: true, away: false } }, server: true, sends: 1 },
    { name: "handoff not enabled", config: { handoff: { enabled: false, away: true } }, server: true, sends: 0 },
  ];
  for (const c of cases) {
    const sent = [];
    const notifier = { send: async (m) => { sent.push(m); return { sent: ["webhook"], failed: [], withheld: [] }; }, usable: () => Array.from({ length: c.usable ?? 1 }, () => ({ type: "webhook" })) };
    const channels = sendWhereHandoffsGo(c.config, { server: () => c.server, notifier });
    const r = await channels(message);
    assert.equal(sent.length, c.sends, c.name);
    if (c.sends) assert.deepEqual([sent[0], r.sent], [message, ["webhook"]], c.name);
    else assert.equal(r, null, c.name);
  }
  // Read at each send: a channel linked counts at once.
  const config = { handoff: { enabled: true } };
  const sent = [];
  let usable = 0;
  const channels = sendWhereHandoffsGo(config, { server: () => false, notifier: { send: async (m) => { sent.push(m); return {}; }, usable: () => Array.from({ length: usable }, () => ({ type: "telegram" })) } });
  await channels(message);
  usable = 1;
  await channels(message);
  assert.equal(sent.length, 1);
});

test("wiring: the rechecks end with the browser that started them; daemon.mjs holds agents and sends only where hand-offs go", () => {
  const launch = readFileSync(new URL("../scripts/daemon/browser/launch.mjs", import.meta.url), "utf8");
  assert.ok(launch.includes('if (net) { net.started(); ctx.once("close", () => network.stop(net)); }'), "the close tied on as they start");
  const daemon = readFileSync(new URL("../scripts/daemon.mjs", import.meta.url), "utf8");
  assert.match(daemon, /pause: \(who\) => pause\.hold\(who\), channels: sendWhereHandoffsGo\(config, \{ server: \(\) => context\.isServer\(\), notifier \}\)/);
});
