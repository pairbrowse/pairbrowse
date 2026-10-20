// A session's egress check at launch (spec server-mode C6, C7, C9; section 3.2 step 6): the helper's
// probe through the proxy, this computer's own exit (only without expectEgress), the browser's own
// read and its WebRTC gathering, judged together; anything but a pass fails closed (the browser
// closed before any tab is adopted, the session's starts refused with the reason for a while,
// pairbrowse_status naming it, the person told once), and each check kept apart from the profile
// in network.json without this computer's own address or a credential.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createNetwork, HOLD_MS, OBSERVATIONS_MAX } from "../scripts/daemon/network.mjs";
import { EXTENSION_SHELL, shellFrom } from "../scripts/browser/choice.mjs";
import { createContext } from "../scripts/daemon/context.mjs";
import { statusLine } from "../scripts/daemon/serve/tools/status.mjs";
import { testHome } from "./helpers/home.mjs";

const dir = mkdtempSync(join(tmpdir(), "pb-net-refuse-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const AUTH_SHELL = shellFrom({ chrome: 1, proxyAuthFile: 1 });
const EXIT = "203.0.113.77", OTHER = "198.51.100.9", HOME_IP = "192.0.2.50";
const USER = "proxy-user-1", PASS = "s3cret-pass-word";
const SRFLX = `candidate:2 1 udp 1686052607 ${HOME_IP} 50000 typ srflx raddr 0.0.0.0 rport 0 generation 0`;
const MDNS = "candidate:1 1 udp 2122260223 1f4712db-ea17-4bcf-a596-105139dfd8bf.local 54321 typ host generation 0";

// A network part with its own files, stub probes and browser check, and a clock.
function setup(name, network, { helper = { ok: true, ip: EXIT, loc: "US" }, direct = { ok: true, ip: HOME_IP, loc: "DE" },
  browser = { ok: true, ip: EXIT, loc: "US" }, webrtc = { ok: true, candidates: [MDNS] }, secrets = null } = {}) {
  const base = join(dir, name);
  const configFile = join(base, "config.json"), secretsFile = join(base, "secrets.env");
  const files = (s) => join(base, s, "network.json");
  const probes = [], lines = [], notes = [];
  const t = { now: 1_000_000, helper, direct, browser, webrtc, inBrowserCalls: 0 };
  const write = (n) => writeFileSync(configFile, JSON.stringify({ network: n }));
  mkdirSync(base, { recursive: true });
  {
    write(network);
    if (secrets) writeFileSync(secretsFile, secrets, { mode: 0o600 });
    const part = createNetwork({
      log: (l) => lines.push(l), notify: (text) => notes.push(text), configFile, secretsFile, runDir: join(base, "run"),
      observationsFile: files, now: () => t.now,
      probe: async (args) => { probes.push(args); return args.proxy ? t.helper : t.direct; },
      inBrowser: async () => { t.inBrowserCalls++; return { browser: t.browser, webrtc: t.webrtc }; },
    });
    return { part, t, probes, lines, notes, files, write, configFile };
  }
}
const proxied = (more = {}, net = {}) => ({ proxies: { "us-east": { server: "http://203.0.113.10:3128", ...more } }, sessions: { shop: "us-east" }, ...net });
const launch = async (s, session = "shop", shell = EXTENSION_SHELL) => {
  const lp = s.part.forLaunch(session, { shell });
  const r = await s.part.checkAtLaunch({}, session, lp);
  if (r.ok) lp.started();
  lp.drop();
  return r;
};
const noAddress = (text) => { for (const ip of [EXIT, OTHER, HOME_IP]) assert.ok(!String(text).includes(ip), `${ip} in: ${text}`); };

test("a passing check: kept in network.json (0600) without this computer's address; status names the network and country only", async () => {
  const s = setup("pass", proxied());
  assert.deepEqual(await launch(s), { ok: true });
  // Through the proxy, and this computer's own exit (no expectEgress), each with the check bound.
  assert.equal(s.probes.length, 2);
  assert.equal(s.probes[0].proxy.host, "203.0.113.10");
  assert.equal(s.probes[1].proxy, null);
  const file = s.files("shop");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const kept = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(kept.version, 1);
  const [c] = kept.checks;
  assert.deepEqual({ ...c, at: "t" }, { at: "t", kind: "launch", proxy: "us-east", server: "http://203.0.113.10:3128", browser: { ip: EXIT, loc: "US" },
    helper: { ip: EXIT, loc: "US" }, sameAsDirect: false, webrtc: { candidates: [{ type: "host", kind: "mdns" }], verdict: "ok" }, dns: "strict", verdict: "ok", reason: "" });
  assert.ok(!readFileSync(file, "utf8").includes(HOME_IP), "the direct address is never kept");
  assert.deepEqual(s.part.statusParts("shop"), ['network "us-east" (strict): exit checked at launch, country US']);
  assert.deepEqual(s.part.statusParts("other"), []);
  assert.equal(s.part.refusal("shop"), null);
  assert.deepEqual(s.notes, []);
  for (const l of s.lines) noAddress(l);
  // The last OBSERVATIONS_MAX only.
  for (let i = 0; i < OBSERVATIONS_MAX + 3; i++) await launch(s);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).checks.length, OBSERVATIONS_MAX);
});

test("a direct session runs no check and keeps nothing", async () => {
  const s = setup("direct", { proxies: {}, sessions: { shop: null } });
  assert.deepEqual(await launch(s), { ok: true });
  assert.deepEqual([s.probes.length, s.t.inBrowserCalls], [0, 0]);
  assert.equal(existsSync(s.files("shop")), false);
  assert.deepEqual(s.part.statusParts("shop"), []);
});

test("C7: each failure fails closed with a reason naming no address", async () => {
  const cases = [
    ["unreachable proxy", { helper: { ok: false, step: "connect", problem: "proxy 203.0.113.10:3128 refused the connection" } }, /check through the proxy failed/],
    ["a probe that timed out", { helper: { ok: false, step: "tunnel", problem: "timed out (tunnel, 10000 ms in all)", timedOut: true } }, /timed out/],
    ["the browser's check timed out", { browser: { ok: false, step: "load", problem: "timed out (load, 10000 ms)", timedOut: true } }, /browser's own check timed out/],
    ["the browser leaves elsewhere", { browser: { ok: true, ip: OTHER, loc: "US" } }, /different address than the proxy's/],
    ["the exit is this computer's", { helper: { ok: true, ip: HOME_IP, loc: "DE" }, browser: { ok: true, ip: HOME_IP, loc: "DE" } }, /this computer's own/],
    ["a WebRTC leak", { webrtc: { ok: true, candidates: [MDNS, SRFLX] } }, /WebRTC shows an address/],
    ["a WebRTC gathering that didn't finish", { webrtc: { ok: false, problem: "the WebRTC gathering didn't finish within 5000 ms", timedOut: true } }, /WebRTC check didn't finish/],
  ];
  for (const [name, stubs, reason] of cases) {
    const s = setup(`c7-${name.replace(/\W+/g, "-")}`, proxied(), stubs);
    const r = await launch(s);
    assert.equal(r.ok, false, name);
    assert.match(r.refusal, /^Session "shop" doesn't start: network "us-east" failed its check before any saved tab opened, so the browser closed\. /, name);
    assert.match(r.refusal, reason, name);
    noAddress(r.refusal.replace("203.0.113.10:3128", "")); // a probe's problem may name the proxy itself, never an exit
    assert.equal(JSON.parse(readFileSync(s.files("shop"), "utf8")).checks.at(-1).verdict, "failed", name);
  }
  // expectEgress: an exit outside it fails, and this computer's own exit isn't probed at all.
  const s = setup("expect", proxied({ expectEgress: ["country:FR"] }));
  const r = await launch(s);
  assert.match(r.refusal, /outside the addresses or countries its expectEgress lists/);
  assert.equal(s.probes.length, 1, "no direct probe with an expectation");
  assert.equal(JSON.parse(readFileSync(s.files("shop"), "utf8")).checks[0].sameAsDirect, null);
  // A browser check that threw counts as failed, never as a pass.
  const t = setup("threw", proxied());
  t.part.forLaunch("shop", { shell: EXTENSION_SHELL });
  const broken = createNetwork({ configFile: t.configFile, runDir: join(dir, "threw", "run"), observationsFile: t.files, probe: async () => ({ ok: true, ip: EXIT, loc: "US" }), inBrowser: async () => { throw new Error("boom"); } });
  const blp = broken.forLaunch("shop", { shell: EXTENSION_SHELL });
  assert.equal((await broken.checkAtLaunch({}, "shop", blp)).ok, false);
});

test("the check is tied to its launch: a later forLaunch, another session's, a lost or reused handle all fail closed", async () => {
  const s = setup("tied", proxied({}, { sessions: { shop: "us-east", other: null } }));
  // A second forLaunch for the same session before the first launch's check: each checks its own.
  const first = s.part.forLaunch("shop", { shell: EXTENSION_SHELL });
  const second = s.part.forLaunch("shop", { shell: EXTENSION_SHELL });
  s.t.helper = { ok: false, step: "connect", problem: "refused the connection" }; // both probes already ran: neither sees this
  assert.equal(s.t.inBrowserCalls, 0);
  assert.deepEqual(await s.part.checkAtLaunch({}, "shop", first), { ok: true });
  assert.equal(s.t.inBrowserCalls, 1, "the proxied launch ran its check");
  assert.deepEqual(await s.part.checkAtLaunch({}, "shop", second), { ok: true });
  assert.equal(s.t.inBrowserCalls, 2);
  // A handle checked already, none, one this part didn't make, or another session's: no pass.
  const refused = /^Session "shop" doesn't start: its network check had no record of this launch, so the browser closed. /;
  assert.match((await s.part.checkAtLaunch({}, "shop", first)).refusal, refused);
  assert.match((await s.part.checkAtLaunch({}, "shop")).refusal, refused);
  assert.match((await s.part.checkAtLaunch({}, "shop", { proxy: null })).refusal, refused);
  const proxiedLaunch = s.part.forLaunch("shop", { shell: EXTENSION_SHELL });
  s.part.forLaunch("other", { shell: EXTENSION_SHELL }); // a direct session's launch in between
  const otherLaunch = s.part.forLaunch("other", { shell: EXTENSION_SHELL });
  assert.equal((await s.part.checkAtLaunch({}, "other", proxiedLaunch)).ok, false, "shop's launch isn't other's");
  assert.equal((await s.part.checkAtLaunch({}, "shop", proxiedLaunch)).ok, false, "a handle given to the wrong session is spent");
  assert.equal(s.t.inBrowserCalls, 2, "none of these ran a browser check");
  // The direct session's own handle still passes without a check.
  assert.deepEqual(await s.part.checkAtLaunch({}, "other", otherLaunch), { ok: true });
  assert.equal(s.t.inBrowserCalls, 2);
});

test("without strict mode WebRTC is recorded, not judged", async () => {
  const s = setup("loose", proxied({}, { strict: false }), { webrtc: { ok: true, candidates: [SRFLX] } });
  assert.deepEqual(await launch(s), { ok: true });
  const [c] = JSON.parse(readFileSync(s.files("shop"), "utf8")).checks;
  assert.deepEqual([c.verdict, c.webrtc.verdict, c.dns], ["ok", "leak", "local"]);
  assert.deepEqual(s.part.statusParts("shop"), ['network "us-east": exit checked at launch, country US']);
});

test("a failed check refuses tools; status names network state without secrets; the person is told once", async () => {
  const secrets = `PAIRBROWSE_PROXY_US_EAST_USERNAME="${USER}"\nPAIRBROWSE_PROXY_US_EAST_PASSWORD="${PASS}"\n`;
  const s = setup("hold", proxied({ auth: true }), { browser: { ok: true, ip: OTHER, loc: "US" }, secrets });
  const r = await launch(s, "shop", AUTH_SHELL);
  assert.equal(r.ok, false);
  // The probe through the proxy got the credentials; nothing said or kept carries them.
  assert.deepEqual(s.probes[0].auth, { username: USER, password: PASS });
  const said = [r.refusal, ...s.lines, ...s.notes, readFileSync(s.files("shop"), "utf8"), ...s.part.statusParts("shop")].join("\n");
  assert.ok(!said.includes(PASS) && !said.includes(USER), said);
  noAddress(said.replace(/"ip": "[^"]*"/g, "")); // the exits stay in network.json's ip fields only
  // Held: the next start is refused with the same reason, without a check.
  assert.equal(s.part.refusal("shop"), r.refusal);
  assert.equal(s.part.refusal("other"), null, "another session isn't held");
  assert.deepEqual(s.part.statusParts("shop"), [`warning: ${r.refusal}`]);
  const line = statusLine({}, [], { on: true }, "", s.part.statusParts("shop"));
  assert.ok(line.startsWith("ok; warning: Session \"shop\" doesn't start: network \"us-east\" failed its check"), line);
  assert.deepEqual(s.notes, ['Session "shop" doesn\'t start: its proxy "us-east" failed the check. Nothing went around it. See pairbrowse_status or daemon.log.']);
  // The same failure again (after the hold): no second notification.
  s.t.now += HOLD_MS;
  assert.equal(s.part.refusal("shop"), null, "the hold ends after HOLD_MS");
  assert.equal((await launch(s, "shop", AUTH_SHELL)).ok, false);
  assert.equal(s.notes.length, 1, "told once");
  // A change to config.json ends the hold at once.
  assert.ok(s.part.refusal("shop"));
  const later = new Date(Date.now() + 5000);
  utimesSync(s.configFile, later, later);
  assert.equal(s.part.refusal("shop"), null, "config.json changed: the next start checks again");
  // Fixed: the check passes, nothing holds, and a new failure is told again.
  s.t.browser = { ok: true, ip: EXIT, loc: "US" };
  assert.deepEqual(await launch(s, "shop", AUTH_SHELL), { ok: true });
  assert.equal(s.part.refusal("shop"), null);
  s.t.browser = { ok: true, ip: OTHER, loc: "US" };
  await launch(s, "shop", AUTH_SHELL);
  assert.equal(s.notes.length, 2);
});

test("a clean session's checks stay in memory only", async () => {
  const s = setup("clean", proxied({}, { sessions: { "clean-3": "us-east" } }));
  assert.deepEqual(await launch(s, "clean-3"), { ok: true });
  assert.equal(existsSync(s.files("clean-3")), false);
  assert.equal(s.part.observations("clean-3").length, 1);
});

// Through the launch (daemon/browser/launch.mjs): the check before any tab is adopted; a failure
// closes the browser (no crash, no onClosed), fails the launch and holds the next start.
function recordingDriver() {
  const calls = [];
  const launchPersistentContext = async (profile, options) => {
    const ctx = new EventEmitter();
    calls.push({ profile, options, ctx, closed: false });
    const call = calls.at(-1);
    ctx.pages = () => [];
    ctx.addInitScript = async () => {};
    ctx.browser = () => null;
    ctx.close = async () => { call.closed = true; ctx.emit("close"); };
    return ctx;
  };
  return { chromium: { launchPersistentContext }, calls };
}

test("the launch checks before adopting any tab; a failure closes the browser, fails the launch and holds the next start", { timeout: 30_000 }, async () => {
  const cfg = join(testHome, "config.json");
  const d = recordingDriver();
  const t = { browser: { ok: true, ip: OTHER, loc: "US" }, seen: [] };
  const events = [];
  const quiet = () => {};
  const network = createNetwork({ configFile: cfg, runDir: join(dir, "run-ctx"), observationsFile: (s) => join(dir, "ctx", s, "network.json"),
    probe: async (a) => (a.proxy ? { ok: true, ip: EXIT, loc: "US" } : { ok: true, ip: HOME_IP, loc: "DE" }),
    inBrowser: async (ctx) => { t.seen.push(ctx); events.push("check"); return { browser: t.browser, webrtc: { ok: true, candidates: [] } }; } });
  const context = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none", sessionPicker: false }, log: quiet, chromium: d.chromium,
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: () => events.push("started"), onClosed: () => events.push("closed"), network,
  });
  const session = context.sessionName();
  writeFileSync(cfg, JSON.stringify({ network: { proxies: { a: { server: "http://203.0.113.10:3128" } }, sessions: { [session]: "a" } } }));
  await assert.rejects(context.getContext(), /failed its check before any saved tab opened/);
  assert.equal(d.calls.length, 1);
  assert.equal(t.seen[0], d.calls[0].ctx, "checked in the browser just started");
  assert.equal(d.calls[0].closed, true, "closed");
  assert.deepEqual(events, ["check"], "never started, and the close is no crash or end of the browser");
  assert.equal(network.current(), null, "a failed check leaves no running network");
  // Held: refused without a launch, and status says why.
  await assert.rejects(context.getContext(), /failed its check/);
  assert.equal(d.calls.length, 1, "no new launch while it holds");
  assert.match(context.networkRefusal(), /failed its check/);
  assert.equal(context.networkStrict(), false, "no strict session runs: none was started");
  assert.ok(context.statusParts().some((p) => /^warning: Session .* failed its check/.test(p)));
  // Fixed (config.json written again): the next start checks and goes on.
  t.browser = { ok: true, ip: EXIT, loc: "US" };
  const later = new Date(Date.now() + 5000);
  utimesSync(cfg, later, later);
  await context.getContext();
  assert.equal(d.calls.length, 2);
  assert.deepEqual(events.slice(1), ["check", "started"]);
  assert.equal(context.networkRefusal(), null);
  assert.equal(context.networkStrict(), true, "a strict proxied session runs: shared browser mode sends pictures only (C11)");
  assert.ok(context.statusParts().includes('network "a" (strict): exit checked at launch, country US'), context.statusParts().join("; "));
  await context.close();
  writeFileSync(cfg, JSON.stringify({}));
});

test("launch wiring: the check after the screen check and before the browser is used", () => {
  const src = readFileSync(new URL("../scripts/daemon/browser/launch.mjs", import.meta.url), "utf8");
  const engine = src.indexOf("ctx = await launchEngine(");
  const screen = src.indexOf("if (screen && st.screen !== screen) {");
  const check = src.indexOf("await network.checkAtLaunch(ctx, st.session, net)");
  assert.ok(engine > 0 && screen > engine && check > screen, "launchEngine, the screen check, then the egress check");
  for (const later of ["net.started();", "await addPageScript(ctx, driver", "api.adopt(p, ctx)", "ctx.on(\"page\"", "ctx.on(\"close\"", "api.restore(ctx"]) {
    assert.ok(src.indexOf(later) > check, `${later} after the check`);
  }
  assert.match(src, /const held = !st\.contextPromise && network\?\.refusal\(st\.session\);/);
  const status = readFileSync(new URL("../scripts/daemon/serve/tools/status.mjs", import.meta.url), "utf8");
  assert.match(status, /!context\.networkRefusal\?\.\(\)/, "pairbrowse_status answers while a failed check holds");
});
