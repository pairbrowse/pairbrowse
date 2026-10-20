// A session's network at launch (spec server-mode C1, C5; section 3.2 step 3): the driver's proxy
// option with this computer's own addresses always around it, strict mode's switches on both
// builds (a user's --host-resolver-rules dropped, for SOCKS5 the helper's rule last), credentials
// only through an owner-only auth file on a build that reads one, a refusal (never a direct
// launch) when the network can't be used, and profile files untouched by a proxy change.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { launchPart, applyLaunchPart, networkFor, STRICT_WEBRTC, STRICT_WEBRTC_OPEN, DRIVER_LOOPBACK, resolverRule, PROXY_AUTH_SWITCH } from "../scripts/net/config.mjs";
import { createNetwork, writeProxyAuthFile, PROXY_AUTH_PREFIX } from "../scripts/daemon/network.mjs";
import { EXTENSION_SHELL, shellFrom } from "../scripts/browser/choice.mjs";
import { launchArgs } from "../scripts/browser.mjs";
import { createContext } from "../scripts/daemon/context.mjs";
import { testHome } from "./helpers/home.mjs";

const dir = mkdtempSync(join(tmpdir(), "pb-net-launch-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const AUTH_SHELL = shellFrom({ chrome: 1, proxyAuthFile: 1 });
const PAGES_SHELL = shellFrom({ chrome: 1 });
const USER = "proxy-user-1", PASS = "s3cret-pass-word";
const net = (proxies, more = {}) => ({ proxies, sessions: { shop: Object.keys(proxies)[0] }, ...more });
const forShop = (network, session = "shop") => networkFor({ network }, session);
const LOOPBACK = DRIVER_LOOPBACK.join(",");

test("strict switches on both builds; a user's host-resolver-rules dropped; non-loopback bypass refused", () => {
  const n = forShop(net({ us: { server: "http://203.0.113.10:3128" } }));
  const rule = "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 203.0.113.10, EXCLUDE localhost";
  for (const shell of [EXTENSION_SHELL, PAGES_SHELL, AUTH_SHELL]) {
    // A native build (any shell): the engine's spelling only. native-engine.mjs drops any other
    // WebRTC policy switch (and logs it as the user's), so the open build's spelling never goes there.
    const part = launchPart(n, { shell, native: true });
    assert.equal(part.problem, undefined);
    assert.deepEqual(part.proxy, { server: "http://203.0.113.10:3128", bypass: LOOPBACK });
    assert.deepEqual(part.args, [rule, STRICT_WEBRTC]);
    assert.equal(part.authFile, null);
  }
  // The open build (or another browser on its engine): its browser ignores STRICT_WEBRTC and reads
  // the policy only as --force-webrtc-ip-handling-policy, so both go (step 28's finding).
  for (const opts of [{ shell: EXTENSION_SHELL }, { shell: EXTENSION_SHELL, native: false }, {}]) {
    const part = launchPart(n, opts);
    assert.deepEqual(part.args, [rule, STRICT_WEBRTC, STRICT_WEBRTC_OPEN]);
  }
  assert.equal(STRICT_WEBRTC_OPEN, "--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  // The user's resolver rule (it passes the browserArgs screen: names kept on this computer) goes,
  // in any spelling; the helper's comes last, so the engine takes it.
  const user = launchArgs({ browserArgs: ["--host-resolver-rules=MAP dev.test 127.0.0.1", "--lang=de"] });
  assert.ok(user.includes("--host-resolver-rules=MAP dev.test 127.0.0.1"), "the screen keeps a local rule");
  const { options, dropped } = applyLaunchPart({ args: [...user, "-host-resolver-rules=EXCLUDE a.test"], headless: false }, launchPart(n, { shell: EXTENSION_SHELL }));
  assert.deepEqual(dropped, ["--host-resolver-rules", "-host-resolver-rules"]);
  assert.equal(options.args.filter((a) => /host-resolver-rules/.test(a)).length, 1);
  assert.deepEqual(options.args.slice(-3), [resolverRule("203.0.113.10"), STRICT_WEBRTC, STRICT_WEBRTC_OPEN]);
  assert.ok(options.args.includes("--lang=de"), "other switches stay");
  assert.equal(options.headless, false, "other options stay");
  assert.deepEqual(options.proxy, { server: "http://203.0.113.10:3128", bypass: LOOPBACK });
  // A bypass going around the proxy is refused in strict mode (net/config.mjs), so no launch has it.
  const wide = launchPart(forShop(net({ us: { server: "http://203.0.113.10:3128", bypass: ["*.example.com"] } })), { shell: EXTENSION_SHELL });
  assert.match(wide.problem, /^Session "shop" doesn't start: network\.proxies\.us\.bypass has "\*\.example\.com", which strict mode doesn't allow/);
  assert.equal(wide.proxy, undefined);
});

test("loopback bypass always passed; for SOCKS5 the helper's resolver rule is last; not strict, no switches for http", () => {
  const loose = forShop(net({ lab: { server: "http://proxy.example.com:8080", bypass: ["*.intranet.test", "::1", "LOCALHOST", "10.0.0.0/8"] } }, { strict: false }));
  const part = launchPart(loose, { shell: EXTENSION_SHELL });
  assert.deepEqual(part.proxy, { server: "http://proxy.example.com:8080", bypass: `${LOOPBACK},*.intranet.test,10.0.0.0/8` });
  assert.deepEqual(part.args, [], "not strict: the switches are the person's choice");
  assert.deepEqual(part.drop, []);
  // The driver adds its own SOCKS rule (and a user's local rule would replace it): ours comes last.
  for (const strict of [true, false]) {
    const socks = launchPart(forShop(net({ s: { server: "socks5://[2001:db8::7]:1080" } }, { strict })), { shell: EXTENSION_SHELL });
    assert.equal(socks.args[0], "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE [2001:db8::7], EXCLUDE localhost");
    assert.equal(socks.args.includes(STRICT_WEBRTC), strict);
    assert.equal(socks.args.includes(STRICT_WEBRTC_OPEN), strict);
    assert.deepEqual(socks.drop, ["host-resolver-rules"]);
    const { options } = applyLaunchPart({ args: ["--host-resolver-rules=MAP x.test 127.0.0.1"] }, socks);
    assert.equal(options.args.filter((a) => /host-resolver-rules/.test(a)).length, 1);
    assert.equal(options.args[0], socks.args[0]);
  }
  // A direct session: nothing added, nothing dropped, no proxy option.
  const direct = launchPart(forShop(net({ us: { server: "http://203.0.113.10:3128" } }, { sessions: { shop: null } })), { shell: EXTENSION_SHELL });
  assert.deepEqual(direct, { proxy: null, args: [], authFile: null, drop: [] });
  const { options, dropped } = applyLaunchPart({ args: ["--host-resolver-rules=MAP x.test 127.0.0.1"] }, direct);
  assert.deepEqual([options.args, dropped, "proxy" in options], [["--host-resolver-rules=MAP x.test 127.0.0.1"], [], false]);
});

test("credentials reach a launch only as the auth file's content, on a build that reads one", () => {
  const n = forShop(net({ "us-east": { server: "https://proxy.example.com", auth: true } }));
  const secrets = { values: { PAIRBROWSE_PROXY_US_EAST_USERNAME: USER, PAIRBROWSE_PROXY_US_EAST_PASSWORD: PASS }, problem: null };
  // The open build, and a build without proxyAuthFile: refused, never argv or the driver.
  for (const shell of [EXTENSION_SHELL, PAGES_SHELL, null]) {
    const part = launchPart(n, { shell, secrets });
    assert.match(part.problem, /^Session "shop" doesn't start: network "us-east" needs a username and password, and this browser can't take them/);
    assert.ok(!part.problem.includes(USER) && !part.problem.includes(PASS));
  }
  const part = launchPart(n, { shell: AUTH_SHELL, secrets });
  assert.deepEqual(part.authFile, { server: "https://proxy.example.com:443", username: USER, password: PASS });
  assert.deepEqual(part.proxy, { server: "https://proxy.example.com:443", bypass: LOOPBACK }, "the driver's option has no credential");
  assert.ok(!JSON.stringify([part.proxy, part.args]).includes(PASS));
  // Missing, short or unreadable: refused with the names, never a value.
  const missing = launchPart(n, { shell: AUTH_SHELL, secrets: { values: { PAIRBROWSE_PROXY_US_EAST_USERNAME: USER } } });
  assert.equal(missing.problem, 'Session "shop" doesn\'t start: network "us-east" needs PAIRBROWSE_PROXY_US_EAST_USERNAME and _PASSWORD in secrets.env.');
  const short = launchPart(n, { shell: AUTH_SHELL, secrets: { values: { PAIRBROWSE_PROXY_US_EAST_USERNAME: USER, PAIRBROWSE_PROXY_US_EAST_PASSWORD: "abc" } } });
  assert.match(short.problem, /PAIRBROWSE_PROXY_US_EAST_PASSWORD in secrets\.env is shorter than 4 characters/);
  assert.ok(!short.problem.includes(USER));
  const unreadable = launchPart(n, { shell: AUTH_SHELL, secrets: { values: {}, problem: "/x/secrets.env is a link; ... Secrets are disabled until then." } });
  assert.match(unreadable.problem, /and secrets\.env can't be used: \/x\/secrets\.env is a link; \.\.\. Secrets are disabled until then\.$/);
});

test("a refused network refuses the launch: an unknown id, a bad entry, a config.json that can't be read", () => {
  assert.match(launchPart(forShop(net({ us: { server: "http://203.0.113.10:3128" } }, { sessions: { shop: "eu" } })), {}).problem, /network\.sessions\.shop names "eu", which network\.proxies in config\.json doesn't define/);
  assert.match(launchPart(forShop(net({ us: { server: "socks4://203.0.113.10:1080" } })), {}).problem, /SOCKS4/);
  const cfg = join(dir, "broken.json");
  writeFileSync(cfg, "{ not json");
  const network = createNetwork({ configFile: cfg, runDir: join(dir, "run-a") });
  assert.throws(() => network.forLaunch("shop", { shell: EXTENSION_SHELL }), { message: 'Session "shop" doesn\'t start: config.json isn\'t valid JSON, so the session\'s network isn\'t known.' });
  assert.equal(network.current(), null);
});

test("forLaunch: the file read at each launch, the auth file owner-only and gone after, nothing logged with an address or credential", () => {
  const cfg = join(dir, "config.json"), secretsFile = join(dir, "secrets.env"), runDir = join(dir, "run");
  const lines = [];
  const network = createNetwork({ log: (l) => lines.push(l), configFile: cfg, secretsFile, runDir });
  // No file, no block: direct, and nothing said.
  const direct = network.forLaunch("shop", { shell: AUTH_SHELL });
  assert.deepEqual([direct.id, direct.source, direct.proxy, direct.strict, network.strict()], [null, "direct", null, false, false]);
  direct.started();
  assert.equal(network.current().source, "direct");
  assert.deepEqual(direct.apply({ args: ["--lang=en"] }), { args: ["--lang=en"] });
  assert.deepEqual(lines, []);
  // The block changes between launches: the next launch reads it.
  writeFileSync(cfg, JSON.stringify({ network: net({ "us-east": { server: "http://203.0.113.10:3128", auth: true } }) }));
  writeFileSync(secretsFile, `PAIRBROWSE_PROXY_US_EAST_USERNAME="${USER}"\nPAIRBROWSE_PROXY_US_EAST_PASSWORD="${PASS}"\n`, { mode: 0o600 });
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(runDir, `${PROXY_AUTH_PREFIX}left-by-a-killed-helper`), "{}", { mode: 0o600 });
  const lp = network.forLaunch("shop", { shell: AUTH_SHELL });
  assert.deepEqual([lp.id, lp.source, lp.strict, network.strict()], ["us-east", "session", true, false], "not the running browser's until it is up");
  assert.equal(network.current(), null, "a launch attempt clears the earlier browser's record");
  lp.started();
  assert.equal(network.strict(), true);
  const files = readdirSync(runDir).filter((f) => f.startsWith(PROXY_AUTH_PREFIX));
  assert.equal(files.length, 1, "an older auth file is swept");
  const path = join(runDir, files[0]);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify({ server: "http://203.0.113.10:3128", username: USER, password: PASS })}\n`, "one line of JSON (the engine contract)");
  const options = lp.apply({ args: ["--host-resolver-rules=MAP dev.test 127.0.0.1"] });
  assert.ok(options.args.includes(`${PROXY_AUTH_SWITCH}=${path}`), "the switch names the file, never its content");
  assert.ok(!JSON.stringify(options).includes(PASS) && !JSON.stringify(options).includes(USER));
  lp.drop();
  assert.equal(existsSync(path), false, "gone once the browser is up (or its launch failed)");
  lp.drop(); // twice: nothing to do
  assert.ok(lines.some((l) => l === 'launch: network "us-east" (session, strict, auth file)'), lines.join("\n"));
  assert.ok(lines.some((l) => /--host-resolver-rules in browserArgs dropped/.test(l)));
  for (const l of lines) assert.ok(!/203\.0\.113|proxy-user|s3cret/.test(l), l);
  // On a build that can't read the file: refused, no file written, secrets.env not read for it.
  assert.throws(() => network.forLaunch("shop", { shell: PAGES_SHELL }), /can't take them/);
  assert.deepEqual([network.current(), network.strict()], [null, false], "a refused launch leaves no record");
  assert.deepEqual(readdirSync(runDir).filter((f) => f.startsWith(PROXY_AUTH_PREFIX)), []);
});

test("writeProxyAuthFile never reuses a name and writes only the three fields", () => {
  const runDir = join(dir, "run-w");
  const a = writeProxyAuthFile({ server: "http://h:1", username: USER, password: PASS, extra: "x" }, runDir);
  assert.deepEqual(JSON.parse(readFileSync(a, "utf8")), { server: "http://h:1", username: USER, password: PASS });
  const b = writeProxyAuthFile({ server: "http://h:1", username: USER, password: PASS }, runDir);
  assert.notEqual(a, b);
  assert.equal(existsSync(a), false);
});

// The launch itself (daemon/browser/launch.mjs), with a driver that records what it was given.
function recordingDriver() {
  const calls = [];
  const launchPersistentContext = async (profile, options) => {
    calls.push({ profile, options });
    const ctx = new EventEmitter();
    ctx.pages = () => [];
    ctx.addInitScript = async () => {};
    ctx.newPage = async () => { throw new Error("no pages here"); };
    ctx.browser = () => null;
    ctx.close = async () => { ctx.emit("close"); };
    return ctx;
  };
  return { chromium: { launchPersistentContext }, calls };
}
const quiet = () => {};
const makeContext = (chromium, network) => createContext({
  config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none", sessionPicker: false }, log: quiet, chromium,
  hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
  presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
  shuttingDown: () => false, onStarted: quiet, onClosed: quiet, network,
});
const snapshot = (root) => {
  const out = {};
  for (const f of readdirSync(root, { recursive: true })) {
    const p = join(root, f);
    if (statSync(p).isFile()) out[f] = readFileSync(p, "base64");
  }
  return out;
};

test("a launch carries the session's proxy and switches; switching a proxy leaves PairBrowse-written profile files byte for byte the same", { timeout: 30_000 }, async () => {
  const cfg = join(testHome, "config.json");
  const write = (network) => writeFileSync(cfg, JSON.stringify({ network }));
  const d = recordingDriver();
  // The egress check (net-refuse.test.mjs) passes here: each proxy answers as its own exit.
  const exitOf = (proxy) => ({ ok: true, ip: proxy.host, loc: "US" });
  const context = makeContext(d.chromium, createNetwork({ configFile: cfg, runDir: join(dir, "run-l"), observationsFile: (s) => join(dir, "obs-l", s, "network.json"),
    probe: async (a) => (a.proxy ? exitOf(a.proxy) : { ok: false, problem: "no direct exit here" }),
    inBrowser: async () => { const server = d.calls.at(-1).options.proxy.server; return { browser: exitOf({ host: new URL(server).hostname }), webrtc: { ok: true, candidates: [] } }; } }));
  const session = context.sessionName();
  write({ proxies: { a: { server: "http://203.0.113.10:3128" }, b: { server: "socks5://198.51.100.7:1080" } }, sessions: { [session]: "a" } });
  await context.getContext();
  const first = d.calls.at(-1).options;
  assert.deepEqual(first.proxy, { server: "http://203.0.113.10:3128", bypass: LOOPBACK });
  // After the user's switches (the driver's own come before every one of these).
  // The open build's engine here, so strict mode's WebRTC policy in both spellings.
  assert.deepEqual(first.args.filter((a) => /host-resolver-rules|webrtc/.test(a)), [resolverRule("203.0.113.10"), STRICT_WEBRTC, STRICT_WEBRTC_OPEN]);
  assert.equal(first.chromiumSandbox, true, "the sandbox untouched");
  const profileFiles = snapshot(d.calls.at(-1).profile);
  assert.ok(Object.keys(profileFiles).length > 0, "the launch wrote its profile files");
  await context.close();
  write({ proxies: { a: { server: "http://203.0.113.10:3128" }, b: { server: "socks5://198.51.100.7:1080" } }, sessions: { [session]: "b" } });
  await context.getContext();
  const second = d.calls.at(-1).options;
  assert.deepEqual(second.proxy, { server: "socks5://198.51.100.7:1080", bypass: LOOPBACK });
  assert.deepEqual(second.args.filter((a) => /host-resolver-rules/.test(a)), [resolverRule("198.51.100.7")]);
  assert.deepEqual(snapshot(d.calls.at(-1).profile), profileFiles, "no profile file follows the proxy");
  await context.close();
  // A refusal: the browser never starts, and the next start (fixed) goes on.
  write({ proxies: {}, sessions: { [session]: "gone" } });
  const calls = d.calls.length;
  await assert.rejects(context.getContext(), /doesn't start: network\.sessions\.\S+ names "gone"/);
  assert.equal(d.calls.length, calls, "no launch");
  write(null);
  await context.getContext();
  assert.equal(d.calls.at(-1).options.proxy, undefined, "direct");
  assert.ok(!d.calls.at(-1).options.args.some((a) => /host-resolver-rules|webrtc/.test(a)));
  await context.close();
});

test("launch wiring follows section 3.2: screen, profile, network, then the browser; the auth file dropped either way", () => {
  const src = readFileSync(new URL("../scripts/daemon/browser/launch.mjs", import.meta.url), "utf8");
  const screen = src.indexOf("const screen = await api.ensureScreen();");
  const chosen = src.indexOf("const chosen = api.profiles.forLaunch(st.session, {");
  const network = src.indexOf("net = network ? network.forLaunch(st.session, { profileNetwork: chosen.network, shell: st.shell, native }) : null;");
  const engine = src.indexOf("ctx = await launchEngine(");
  assert.ok(screen > 0 && chosen > screen && network > chosen && engine > network, "ensureScreen, profiles.forLaunch, network.forLaunch, launchEngine");
  // The session's network applied to the launch options, then (a test run only) the NetLog switch.
  assert.match(src.slice(engine), /^ctx = await launchEngine\(browserType\(\), \{ \.\.\.next, browserProfile: chosen\.engine, virtualDisplay: screen\?\.geometry \?\? null \}, profile\(\), withNetLog\(net \? net\.apply\(options\) : options\),/);
  assert.match(src, /finally \{ net\?\.drop\(\);/);
  // forLaunch inside the try that drops its auth file; the network recorded only once the browser is up.
  assert.ok(src.lastIndexOf("try {", network) > src.indexOf("let ctx, net = null;"), "forLaunch inside the try");
  assert.ok(src.indexOf("net.started();") > engine, "started() after launchEngine");
  const daemon = readFileSync(new URL("../scripts/daemon.mjs", import.meta.url), "utf8");
  assert.match(daemon, /network: createNetwork\(\{ log, readSecrets: \(\) => secrets\.reload\(\), notify: \(text\) => panel\.notify\(text\), /, "the helper always passes its network part (null is for tests only), reading secrets.env through its store");
});
