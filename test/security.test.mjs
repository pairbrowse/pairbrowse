import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecrets, loadSecrets, hostAllowed, redact } from "../scripts/rules/secrets.mjs";
import { secretNamesIn, navigationProblem, looksLikeSecretName, BLOCKED_TOOLS } from "../scripts/rules/policy.mjs";

test("secrets carry their allowed domains", () => {
  const s = parseSecrets("# c\nSHOP_PW='p@ss'\nSHOP_PW_DOMAINS=accounts.shopify.com, *.example.com\nLOOSE_PW=x\nEMPTY=\n");
  assert.deepEqual(s.values, { SHOP_PW: "p@ss", LOOSE_PW: "x" });
  assert.deepEqual(s.domains.SHOP_PW, ["accounts.shopify.com", "example.com"]);
  assert.deepEqual(s.domains.LOOSE_PW, []);
});

test("a password with U+2028 or U+2029 in it reads back from the file", () => {
  assert.deepEqual(parseSecrets('SHOP_PW="a b c"\nSHOP_PW_DOMAINS=shopify.com\n').values, { SHOP_PW: "a b c" });
});

test("a password that holds a shorter one is masked whole", () => {
  assert.equal(redact("pw: hunter2hunter2!", { SHORT: "hunter2", LONG: "hunter2hunter2!" }), "pw: <secret>LONG</secret>");
  assert.equal(redact("pw: hunter2", { SHORT: "hunter2", LONG: "hunter2hunter2!" }), "pw: <secret>SHORT</secret>");
});

test("a secret is typed only on its HTTPS domains", () => {
  const d = ["accounts.shopify.com"];
  assert.equal(hostAllowed("https://accounts.shopify.com/login", d), true);
  assert.equal(hostAllowed("https://eu.accounts.shopify.com/login", d), true);
  assert.equal(hostAllowed("http://accounts.shopify.com/login", d), false, "plain http");
  assert.equal(hostAllowed("https://accounts.shopify.com.evil.io/login", d), false, "lookalike suffix");
  assert.equal(hostAllowed("https://evilaccounts.shopify.com/", d), false);
  assert.equal(hostAllowed("https://shopify-login.io/?accounts.shopify.com", d), false);
  assert.equal(hostAllowed("https://accounts.shopify.com/", []), false, "no domains, no typing");
});

test("a secrets file readable by others is refused", { skip: process.platform === "win32" }, () => {
  const f = join(mkdtempSync(join(tmpdir(), "pb-")), "secrets.env");
  writeFileSync(f, "A_PW=x\nA_PW_DOMAINS=a.com\n");
  chmodSync(f, 0o644);
  assert.match(loadSecrets(f).problem, /chmod 600/);
  assert.deepEqual(loadSecrets(f).values, {});
  chmodSync(f, 0o600);
  assert.equal(loadSecrets(f).problem, null);
  assert.equal(loadSecrets(f).values.A_PW, "x");
});

test("secret names are spotted in fills and typing", () => {
  const names = ["SHOP_PW"];
  assert.deepEqual(secretNamesIn("browser_fill_form", { fields: [{ value: "a@b.co" }, { value: "SHOP_PW" }] }, names), ["SHOP_PW"]);
  assert.deepEqual(secretNamesIn("browser_type", { text: "SHOP_PW" }, names), ["SHOP_PW"]);
  assert.deepEqual(secretNamesIn("browser_type", { text: "hello" }, names), []);
  assert.equal(looksLikeSecretName("browser_type", { text: "USA" }), false);
  assert.equal(looksLikeSecretName("browser_type", { text: "META_PASSWORD" }), true);
});

test("the daemon refuses non-web navigation and arbitrary code", () => {
  assert.equal(navigationProblem("https://x.com"), null);
  assert.equal(navigationProblem("about:blank"), null);
  assert.ok(navigationProblem("file:///etc/passwd"));
  assert.ok(navigationProblem("javascript:fetch('//evil')"));
  assert.ok(BLOCKED_TOOLS.has("browser_run_code_unsafe"));
});

test("files PairBrowse creates are private", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pb-"));
  process.env.PAIRBROWSE_HOME = home;
  const { ensureDirs } = await import("../scripts/paths.mjs?private");
  ensureDirs();
  const { statSync } = await import("node:fs");
  for (const d of ["", "profile", "run", "runs", "files/uploads"]) {
    assert.equal(statSync(join(home, d)).mode & 0o077, 0, d || "home");
  }
  writeFileSync(join(home, "x"), "y");
  assert.equal(statSync(join(home, "x")).mode & 0o077, 0, "umask applies to new files");
  assert.ok(readdirSync(home).length > 0);
});

test("tool results are trimmed to what Claude needs", async () => {
  const { trimResult, HIDDEN_TOOLS } = await import("../scripts/rules/policy.mjs");
  const raw = "### Ran Playwright code\n```js\nawait page.goto('x');\n```\n### Open tabs\n- 0: (current) [A](https://a)\n- 1: [B](https://b)\n### Page\n- Page URL: https://a\n- Console: 1 errors, 0 warnings\n### Events\n- New console entries: x.log\n";
  const navigate = trimResult("browser_navigate", raw);
  assert.ok(!navigate.includes("Open tabs") && !navigate.includes("Events") && !navigate.includes("Console:"));
  assert.ok(navigate.includes("Page URL: https://a") && navigate.includes("Ran Playwright code"));
  assert.ok(trimResult("browser_tabs", raw).includes("[B](https://b)"), "the tabs tool keeps its list");
  assert.ok(HIDDEN_TOOLS.has("browser_take_screenshot") && !HIDDEN_TOOLS.has("browser_fill_form"));
});

test("servers without a screen get a private virtual screen", async () => {
  const { needsVirtualDisplay } = await import("../scripts/display.mjs");
  const cfg = { display: "auto" };
  assert.equal(needsVirtualDisplay(cfg, {}, "linux"), true, "no screen");
  assert.equal(needsVirtualDisplay(cfg, { DISPLAY: ":0" }, "linux"), false, "desktop Linux");
  assert.equal(needsVirtualDisplay(cfg, { WAYLAND_DISPLAY: "wayland-0" }, "linux"), false);
  assert.equal(needsVirtualDisplay(cfg, {}, "darwin"), false, "macOS");
  assert.equal(needsVirtualDisplay({ ...cfg, display: "none" }, {}, "linux"), false);
  assert.equal(needsVirtualDisplay({ ...cfg, display: "xvfb" }, { DISPLAY: ":0" }, "linux"), true);
  assert.equal(needsVirtualDisplay({ ...cfg, display: "none" }, {}, "linux"), false);
});

test("only snapshot refs count as refs, not numbers or short words", async () => {
  const { isRef } = await import("../scripts/rules/policy.mjs");
  for (const ref of ["e42", "f1e7"]) assert.ok(isRef(ref), ref);
  for (const other of ["2024", "x9", "E42", "#e42", "button", "", undefined]) assert.ok(!isRef(other), String(other));
});

test("the launch self-check's virtual screen has its own X cookie, so a running browser's screen keeps working", { skip: process.platform !== "linux" || !(await import("../scripts/display.mjs")).hasCommand("Xvfb") }, async () => {
  const { startVirtualDisplay } = await import("../scripts/display.mjs");
  const { paths } = await import("../scripts/paths.mjs");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const main = await startVirtualDisplay();
  const check = await startVirtualDisplay(() => {}, { name: "Xauthority-check" });
  try {
    assert.notEqual(main.env.DISPLAY, check.env.DISPLAY);
    assert.equal(check.env.XAUTHORITY, join(paths.home, "run", "Xauthority-check"));
    assert.ok(existsSync(main.env.XAUTHORITY) && existsSync(check.env.XAUTHORITY), "both cookies stay");
  } finally {
    await main.stop();
    await check.stop();
  }
});

test("a tab list comes once: the open-tabs section is dropped when browser_tabs already lists them", async () => {
  const { trimResult } = await import("../scripts/rules/policy.mjs");
  const out = trimResult("browser_tabs", "### Result\n- 0: [A](http://a/)\n- 1: (current) [B](http://b/)\n### Open tabs\n- 0: [A](http://a/)\n- 1: (current) [B](http://b/)\n");
  assert.equal((out.match(/^- \d+: /gm) || []).length, 2, out);
  // A tab change (new, close) without its own list still shows the open tabs.
  assert.match(trimResult("browser_tabs", "### Result\nClosed tab 1\n### Open tabs\n- 0: [A](http://a/)\n"), /### Open tabs/);
  assert.doesNotMatch(trimResult("browser_click", "### Result\nok\n### Open tabs\n- 0: [A](http://a/)\n"), /Open tabs/);
});

// Test switches (PAIRBROWSE_TEST_*) never reach a helper the test harness didn't start: an
// environment a project hands down (a .claude/settings.json "env") can't turn on the test tool that
// answers approval cards as a person.
test("test switches: only a harness-started helper keeps them; the plugin's bridge drops them", async () => {
  const { harnessStarted, withoutTestSwitches } = await import("../scripts/testenv.mjs");
  const { mkdtempSync, mkdirSync, symlinkSync, realpathSync: real } = await import("node:fs");
  const { tmpdir: temp, homedir } = await import("node:os");
  const { join: j } = await import("node:path");
  const base = real(mkdtempSync(j(temp(), "pb-gate-")));
  const harness = j(base, "h"), plain = j(base, "p");
  mkdirSync(harness); mkdirSync(plain); mkdirSync(j(plain, "runtime"));
  symlinkSync(plain, j(harness, "runtime"), "dir");
  assert.equal(harnessStarted({ PAIRBROWSE_HOME: harness }), true);
  assert.equal(harnessStarted({ PAIRBROWSE_HOME: plain }), false, "an installed runtime is a folder");
  assert.equal(harnessStarted({ PAIRBROWSE_HOME: j(homedir(), ".pairbrowse") }), false, "a home outside the temp folder");
  assert.equal(harnessStarted({}), false);
  assert.deepEqual(withoutTestSwitches({ PATH: "/bin", PAIRBROWSE_TEST_APPROVAL: "1", PAIRBROWSE_HOME: "/x" }), { PATH: "/bin", PAIRBROWSE_HOME: "/x" });
  // A helper started as the plugin starts it, with the approval switch in its environment: no test tool.
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `process.env.PAIRBROWSE_TEST_APPROVAL = "1"; await import(${JSON.stringify(new URL("../scripts/test-gate.mjs", import.meta.url).href)}); console.log(process.env.PAIRBROWSE_TEST_APPROVAL ?? "gone");`],
    { env: { ...process.env, PAIRBROWSE_HOME: plain } }).toString().trim();
  assert.equal(out, "gone");
  const kept = execFileSync(process.execPath, ["--input-type=module", "-e", `process.env.PAIRBROWSE_TEST_APPROVAL = "1"; await import(${JSON.stringify(new URL("../scripts/test-gate.mjs", import.meta.url).href)}); console.log(process.env.PAIRBROWSE_TEST_APPROVAL ?? "gone");`],
    { env: { ...process.env, PAIRBROWSE_HOME: harness } }).toString().trim();
  assert.equal(kept, "1");
});

// Every test switch the helper reads is listed in testenv.mjs and read through it: production code
// reads none of them on its own (scripts/dev/ tools start test helpers and are not the helper).
test("test switches: read only through testenv.mjs, each one listed", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join: j } = await import("node:path");
  const { SWITCHES, testOn, testMs } = await import("../scripts/testenv.mjs");
  const dir = new URL("../scripts/", import.meta.url).pathname;
  const files = readdirSync(dir, { recursive: true }).filter((f) => /\.(mjs|js)$/.test(f) && !f.startsWith("dev/") && f !== "testenv.mjs");
  for (const f of files) assert.doesNotMatch(readFileSync(j(dir, f), "utf8"), /env\.PAIRBROWSE_TEST_|env\[["'`]PAIRBROWSE_TEST_/, `${f} reads a test switch itself`);
  for (const f of files) {
    for (const m of readFileSync(j(dir, f), "utf8").matchAll(/\btest(?:On|Ms|Value)\("([A-Z_]+)"/g)) assert.ok(Object.hasOwn(SWITCHES, m[1]), `${f}: ${m[1]} isn't listed`);
  }
  assert.throws(() => testOn("NOT_A_SWITCH", {}), /unknown test switch/);
  assert.equal(testMs("GONE_MS", 5, { PAIRBROWSE_TEST_GONE_MS: "7" }), 7);
  assert.equal(testMs("GONE_MS", 5, {}), 5);
});

// The proxy exit checks' stand-ins (spec server-mode C-6): a project's environment can't point a
// session's egress check at an address of its choosing, or loosen it to http.
test("NET_CHECK: listed, documented, and stripped outside the harness", async () => {
  const { readFileSync } = await import("node:fs");
  const { SWITCHES, applyTestGate } = await import("../scripts/testenv.mjs");
  const { checkTargets } = await import("../scripts/net/probe.mjs");
  assert.ok(Object.hasOwn(SWITCHES, "NET_CHECK"));
  assert.match(readFileSync(new URL("../docs/development.md", import.meta.url), "utf8"), /^\| `NET_CHECK` \| knob \|/m);
  const env = { PAIRBROWSE_HOME: "/nowhere", PAIRBROWSE_TEST_NET_CHECK: JSON.stringify({ checkUrl: "http://elsewhere.test/", ms: 100 }) };
  assert.equal(checkTargets({ checkUrl: "https://cloudflare.com/cdn-cgi/trace" }, env).checkUrl, "http://elsewhere.test/", "the switch works where it is kept");
  applyTestGate(env);
  assert.equal(env.PAIRBROWSE_TEST_NET_CHECK, undefined);
  assert.deepEqual(checkTargets({ checkUrl: "https://cloudflare.com/cdn-cgi/trace" }, env), { checkUrl: "https://cloudflare.com/cdn-cgi/trace", directUrl: "https://cloudflare.com/cdn-cgi/trace", stun: "stun:stun.cloudflare.com:3478", timeoutMs: 10_000 });
});

// The DNS leak tests' NetLog (spec server-mode C12, C-6): a project's environment can't make the
// person's browser write what it does on the network to a file.
test("NETLOG: listed, documented, and stripped outside the harness", async () => {
  const { readFileSync } = await import("node:fs");
  const { SWITCHES, applyTestGate } = await import("../scripts/testenv.mjs");
  const { withNetLog } = await import("../scripts/daemon/browser/launch.mjs");
  assert.ok(Object.hasOwn(SWITCHES, "NETLOG"));
  assert.match(readFileSync(new URL("../docs/development.md", import.meta.url), "utf8"), /^\| `NETLOG` \| knob \|/m);
  const env = { PAIRBROWSE_HOME: "/nowhere", PAIRBROWSE_TEST_NETLOG: "1" };
  assert.match(withNetLog({ args: [] }, { env }).args.join(" "), /--log-net-log=/, "the switch works where it is kept");
  applyTestGate(env);
  assert.equal(env.PAIRBROWSE_TEST_NETLOG, undefined);
  assert.deepEqual(withNetLog({ args: [] }, { env }).args, []);
  const { screenBrowserArgs } = await import("../scripts/browser-args.mjs");
  for (const harness of [false, true]) assert.deepEqual(screenBrowserArgs(["--log-net-log=/tmp/x.json"], "darwin", { harness }).kept, [], "nor can config.json's browserArgs ask for it");
});

// The exit rechecks' interval (spec server-mode C8, C-6): a project's environment can't make a
// proxied session's rechecks run every few milliseconds, or never.
test("RECHECK_MS: listed, documented, and stripped outside the harness", async () => {
  const { readFileSync } = await import("node:fs");
  const { SWITCHES, applyTestGate, testMs } = await import("../scripts/testenv.mjs");
  assert.ok(Object.hasOwn(SWITCHES, "RECHECK_MS"));
  assert.match(readFileSync(new URL("../docs/development.md", import.meta.url), "utf8"), /^\| `RECHECK_MS` \| knob \|/m);
  assert.match(readFileSync(new URL("../scripts/daemon/network.mjs", import.meta.url), "utf8"), /testMs\("RECHECK_MS", s\.net\.recheckMinutes \* 60_000\)/);
  const env = { PAIRBROWSE_HOME: "/nowhere", PAIRBROWSE_TEST_RECHECK_MS: "5" };
  assert.equal(testMs("RECHECK_MS", 600_000, env), 5, "the switch works where it is kept");
  applyTestGate(env);
  assert.equal(env.PAIRBROWSE_TEST_RECHECK_MS, undefined);
  assert.equal(testMs("RECHECK_MS", 600_000, env), 600_000);
});

// Every path under ~/.pairbrowse is built in paths.mjs (one place to see what the helper keeps):
// no other module joins onto the home or reads PAIRBROWSE_HOME itself.
test("paths under the home come from paths.mjs", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join: j } = await import("node:path");
  const dir = new URL("../scripts/", import.meta.url).pathname;
  const files = readdirSync(dir, { recursive: true }).filter((f) => /\.(mjs|js)$/.test(f) && !f.startsWith("dev/") && !["paths.mjs", "home.mjs", "testenv.mjs"].includes(f));
  for (const f of files) {
    const src = readFileSync(j(dir, f), "utf8");
    assert.doesNotMatch(src, /join\(paths\.home\b|join\(dirname\(paths\.[a-zA-Z]+\)/, `${f} builds a home path itself`);
    assert.doesNotMatch(src, /env\.PAIRBROWSE_HOME\b/, `${f} reads PAIRBROWSE_HOME itself`);
  }
});

// The Security table's first row: no remote-debugging port. The browser is launched over
// Playwright's pipe with flags of PairBrowse's own (browser.mjs launchOptions), and no script
// attaches to a browser over CDP or opens a debugging port.
test("the browser has no remote-debugging port: launched over the pipe, never attached over CDP", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join: j } = await import("node:path");
  const { launchOptions } = await import("../scripts/browser.mjs");
  const { shellFrom, EXTENSION_SHELL } = await import("../scripts/browser/choice.mjs");
  const helper = { origin: "http://127.0.0.1:4000", keyFile: "/run/helper-key-x" };
  for (const shell of [shellFrom({ chrome: 1 }), EXTENSION_SHELL]) {
    const opts = launchOptions({}, { shell, helper, env: {}, executablePath: "/b" });
    assert.ok(!opts.args.some((a) => /^--remote-debugging-(port|address)/.test(a)), "no debugging port flag");
    assert.ok(!("cdpPort" in opts) && !("port" in opts));
  }
  const dir = new URL("../scripts/", import.meta.url).pathname;
  for (const f of readdirSync(dir, { recursive: true }).filter((f) => /\.(mjs|js)$/.test(f) && !f.startsWith("dev/"))) {
    const code = readFileSync(j(dir, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /connectOverCDP|remote-debugging-port|remote-debugging-address/, `${f} attaches over CDP or opens a debugging port`);
  }
});

// The Security table's Diagnostics row: nothing but a report you send leaves the computer
// unasked. The Node modules that can reach another computer (fetch, node:https, node:tls) are
// these, each for its one purpose; a new one is a decision made here.
test("only known modules reach beyond this computer", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join: j } = await import("node:path");
  const KNOWN = {
    "daemon/phishing.mjs": "the phishing list (Phishing.Database) every 6 hours, checked on this computer",
    "daemon/notify/post.mjs": "hand-off messages to the channels you list in handoff.channels",
    "liveview/report.mjs": "a problem report you send yourself, to reportUrl",
    "net/probe.mjs": "a proxied session's exit check (network.checkUrl) through the proxy you set, and once without it, only compared",
    "sharing/join-client.mjs": "the host of a join code you entered",
    "tunnels/quick.mjs": "checks that this helper's own tunnel answers",
    "util.mjs": "pinned downloads (runtime, browser build, engine pack), checked by SHA-256",
    "ws.mjs": "the push channel of a join code you entered",
  };
  const dir = new URL("../scripts/", import.meta.url).pathname;
  const found = readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(".mjs") && !f.startsWith("dev/"))
    .filter((f) => /\bfetch\(|from "node:(https|tls)"/.test(readFileSync(j(dir, f), "utf8").replace(/^\s*\/\/.*$/gm, "")))
    .sort();
  assert.deepEqual(found, Object.keys(KNOWN).sort());
});
