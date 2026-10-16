// browserArgs from the user's config.json are screened before launch against an allowlist
// (scripts/browser-args.mjs): any other switch, a value of the wrong shape and every argument that
// isn't a switch are dropped and named; the driver's own pipe and the side panel's own extension
// switches are untouched.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenBrowserArgs, switchName, launchableBrowserArgs, allowedBrowserArg, sandboxRefusal, sandboxOffAsked, argsKey, browserArgsOf, browserSandboxOf } from "../scripts/browser-args.mjs";
import { loadConfig, CONFIG_WARNINGS } from "../scripts/paths.mjs";
import { launchArgs, launchOptions } from "../scripts/browser.mjs";
import { statusLine } from "../scripts/daemon/serve/tools/status.mjs";
import { sandboxDecision } from "../scripts/engine.mjs";

const UNSAFE = ["--remote-debugging-port=9222", "--remote-debugging-address=0.0.0.0", "--remote-debugging-pipe", "--remote-allow-origins=*", "--disable-web-security", "--disable-site-isolation-trials", "--user-data-dir=/tmp/other", "--load-extension=/tmp/evil", "--disable-extensions-except=/tmp/evil", "--allowlisted-extension-id=abc"];

test("every unsafe switch is dropped and named without its value; ordinary ones stay", () => {
  const { kept, dropped } = screenBrowserArgs(["--lang=en-US", ...UNSAFE, "--headless=new"], "darwin", { harness: false });
  assert.deepEqual(kept, ["--lang=en-US", "--headless=new"]);
  assert.equal(dropped.length, UNSAFE.length);
  assert.ok(dropped.includes("--remote-debugging-port") && !dropped.some((d) => d.includes("9222")));
});

test("other spellings the engine reads are caught too", () => {
  assert.deepEqual(screenBrowserArgs(["-remote-debugging-port=9222", "--Remote-Debugging-Port=1", "--remote-debugging-port"], "linux").kept, []);
  assert.deepEqual(screenBrowserArgs(["/remote-debugging-port=9222"], "win32").kept, []);
  assert.deepEqual(screenBrowserArgs(["/remote-debugging-port=9222"], "darwin").kept, [], "a path off Windows: not a switch, dropped too");
  assert.equal(switchName("https://example.com"), null);
  assert.deepEqual(screenBrowserArgs(null).kept, []);
});

// The switches the review found passing the old denylist: each one runs a program, weakens the
// browser or sends its traffic elsewhere.
const MISSED = ["--renderer-cmd-prefix=/bin/evil", "--utility-cmd-prefix=x", "--gpu-launcher=x", "--browser-subprocess-path=/x",
  "--ignore-certificate-errors", "--ignore-certificate-errors-spki-list=abc", "--allow-file-access-from-files",
  "--unsafely-treat-insecure-origin-as-secure=http://a.example", "--proxy-server=http://evil:8080", "--proxy-pac-url=http://x/p.pac",
  "--host-resolver-rules=MAP * 203.0.113.5", "--host-resolver-rules=MAP bank.example evil.example", "--disable-features=IsolateOrigins,site-per-process",
  "--disable-features=SitePerProcess", "--auto-open-devtools-for-tabs", "--no-zygote", "--disable-web-security=1", "--disable-web-security",
  "--disable-gpu-sandbox", "--in-process-gpu", "--single-process", "--use-fake-ui-for-media-stream", "--enable-features=Foo:param/1",
  "--webrtc-ip-handling-policy=default", "--force-webrtc-ip-handling-policy", "--kiosk", "--app=https://x.example", "--remote-debugging-port=0"];

test("an allowlist: switches it doesn't hold are dropped, whatever they are", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const { kept, dropped } = screenBrowserArgs(MISSED, platform, { harness: false });
    assert.deepEqual(kept, [], platform);
    assert.equal(dropped.length, MISSED.length, platform);
  }
});

test("a value given as the next element is a page to open: both are dropped", () => {
  const { kept, dropped } = screenBrowserArgs(["--proxy-server", "http://evil:8080", "--lang", "en", "--window-size=800,600"], "linux", { harness: false });
  assert.deepEqual(kept, ["--window-size=800,600"], "--lang takes its value after =, so alone it is dropped too");
  assert.ok(!kept.includes("http://evil:8080") && !kept.includes("en"));
  assert.ok(dropped.includes("--proxy-server") && dropped.includes("--lang"));
  assert.ok(dropped.includes("2 arguments that aren't switches"), dropped.join("; "));
  assert.ok(!dropped.some((d) => d.includes("evil")), "a dropped page address is counted, never shown");
});

test("after a bare --, nothing is a switch", () => {
  assert.deepEqual(screenBrowserArgs(["--lang=de", "--", "--lang=fr"], "linux", { harness: false }).kept, ["--lang=de"]);
});

test("allowlisted switches keep only values of their shape", () => {
  const ok = ["--lang=en-US", "--window-size=1280,800", "--window-position=-10,20", "--force-device-scale-factor=1.5", "--force-dark-mode",
    "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--disable-notifications", "--headless=new", "--headless", "--enable-features=Foo,Bar_2",
    "--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:4100", "--host-resolver-rules=MAP a.example localhost, EXCLUDE b.example", "--ozone-platform=wayland",
    "--disable-dev-shm-usage", "--font-render-hinting=none", "-lang=nl", "--no-sandbox"];
  for (const a of ok) assert.ok(allowedBrowserArg(a, "linux"), a);
  const bad = ["--lang=en;x", "--window-size=big", "--force-dark-mode=1", "--headless=x", "--enable-features=", "--host-resolver-rules=",
    "--host-resolver-rules=MAP * 10.0.0.1", "--ozone-platform=headless", "--disable-features=LocalNetworkAccessChecks", "--use-mock-keychain", "--password-store=basic"];
  for (const a of bad) assert.ok(!allowedBrowserArg(a, "linux"), a);
});

test("the test harness's own switches pass only in a helper it started", () => {
  const test = ["--disable-features=LocalNetworkAccessChecks", "--use-mock-keychain", "--password-store=basic"];
  assert.deepEqual(screenBrowserArgs(test, "darwin", { harness: true }).kept, test);
  assert.deepEqual(screenBrowserArgs(test, "darwin", { harness: false }).kept, []);
  assert.deepEqual(screenBrowserArgs(["--disable-features=SitePerProcess"], "darwin", { harness: true }).kept, [], "never site isolation");
});

test("Windows reads /switch and any case; elsewhere a /path is not a switch", () => {
  assert.deepEqual(screenBrowserArgs(["/LANG=de", "/Renderer-Cmd-Prefix=x"], "win32", { harness: false }).kept, ["/LANG=de"]);
  assert.deepEqual(screenBrowserArgs(["/lang=de"], "linux", { harness: false }).kept, []);
});

test("--no-sandbox in any spelling turns the sandbox off on Linux only, never dropped quietly", () => {
  for (const a of ["--no-sandbox", "-no-sandbox", "--No-Sandbox", "--no-sandbox=1", "--no-sandbox="]) {
    assert.equal(sandboxDecision({ browserArgs: [a] }, { platform: "linux", uid: 501 }).on, false, a);
    assert.deepEqual(launchableBrowserArgs([a, "--lang=en"], "linux", { harness: false }), ["--lang=en"], a);
    assert.deepEqual(screenBrowserArgs([a], "linux", { harness: false }), { kept: [a], dropped: [], refused: [] }, a);
  }
  assert.equal(sandboxDecision({ browserArgs: ["/no-sandbox"] }, { platform: "linux", uid: 501 }).on, true, "a path off Windows");
  assert.equal(sandboxDecision({ browserArgs: ["--", "--no-sandbox"] }, { platform: "linux", uid: 501 }).on, true, "after a bare --, never a switch");
});

test("--no-sandbox in any spelling is refused on macOS and Windows: the sandbox stays on and says why", () => {
  for (const [a, platform] of [["--no-sandbox", "darwin"], ["-no-sandbox", "darwin"], ["--NO-SANDBOX", "darwin"], ["--no-sandbox=1", "darwin"],
    ["--no-sandbox", "win32"], ["/no-sandbox", "win32"], ["/No-Sandbox=true", "win32"], ["-No-sandbox", "win32"]]) {
    const d = sandboxDecision({ browserArgs: [a] }, { platform, uid: 501 });
    assert.equal(d.on, true, a);
    assert.match(d.refused, /browserArgs has --no-sandbox: refused, the browser's sandbox always stays on on (macOS|Windows)/, a);
    const screened = screenBrowserArgs([a, "--lang=en"], platform, { harness: false });
    assert.deepEqual(screened.kept, ["--lang=en"], a);
    assert.deepEqual(screened.dropped, [], a);
    assert.deepEqual(screened.refused, [a.split("=")[0]], a);
    assert.equal(allowedBrowserArg(a, platform, { harness: true }), false, a);
  }
  const d = sandboxDecision({ browserSandbox: false }, { platform: "darwin", uid: 0 });
  assert.equal(d.on, true);
  assert.match(d.refused, /browserSandbox is false in config\.json: refused.*macOS/);
});

test("pairbrowse_status warns while the sandbox is off and names a refusal once", () => {
  const sel = { instance: null, source: "default", home: "/h" };
  assert.equal(statusLine(sel, [], { on: true, reason: null, refused: null }), "ok");
  assert.match(statusLine(sel, [], { on: false, reason: "running as root", refused: null }),
    /warning: The browser's sandbox is off: websites are less isolated from this computer \(running as root\)/);
  const refused = sandboxRefusal("browserSandbox is false in config.json", "darwin");
  assert.equal(statusLine(sel, [], { on: true, reason: null, refused }), `ok; warning: ${refused}`);
  assert.equal(statusLine(sel, [`config.json: ${refused}`], { on: true, reason: null, refused }), `ok; warning: config.json: ${refused}`, "once");
});

test("launchArgs: the user's unsafe switches never reach the browser; the panel's own extension switches do", () => {
  const args = launchArgs({ browserArgs: ["--lang=de", ...UNSAFE] });
  for (const a of UNSAFE) assert.ok(!args.includes(a), a);
  assert.ok(args.includes("--lang=de"));
  assert.ok(args.some((a) => a.startsWith("--load-extension=") && !a.includes("/tmp/evil")), "the side panel still loads");
  assert.ok(args.some((a) => a.startsWith("--allowlisted-extension-id=") && !a.endsWith("=abc")));
  assert.ok(!args.some((a) => /^--?remote-debugging-/.test(a)), "PairBrowse adds no debugging switch; the driver adds its own pipe");
});

test("--no-sandbox stays the user's sandbox choice on Linux (sandboxDecision) and is never passed raw", () => {
  const config = { browserArgs: ["--no-sandbox", "--lang=en"] };
  assert.equal(sandboxDecision(config, { platform: "linux", uid: 501 }).on, false);
  assert.equal(sandboxDecision(config, { platform: "darwin", uid: 501 }).on, true);
  assert.deepEqual(launchableBrowserArgs(config.browserArgs), ["--lang=en"]);
  assert.ok(!launchOptions(config).args.includes("--no-sandbox"), "the driver adds it from chromiumSandbox: false");
});

test("loadConfig refuses the sandbox off outside Linux and names it in pairbrowse_status", { skip: process.platform === "linux" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-sandbox-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ browserArgs: ["--No-Sandbox", "--lang=en"] }));
    const logs = [];
    const config = loadConfig(file, (l) => logs.push(l));
    assert.deepEqual(config.browserArgs, ["--lang=en"]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /browserArgs has --no-sandbox: refused, the browser's sandbox always stays on/);
    assert.ok(!/dropped/.test(logs[0]), "named as refused, not among the dropped");
    assert.match(statusLine(undefined, undefined, { on: true, reason: null, refused: null }), /warning: config\.json: browserArgs has --no-sandbox: refused/);
    writeFileSync(file, JSON.stringify({ browserSandbox: false, browserArgs: ["--no-sandbox"] }));
    const both = [];
    loadConfig(file, (l) => both.push(l));
    assert.equal(both.length, 2, "each refusal named");
    assert.match(both[0], /browserSandbox is false in config\.json: refused/);
    assert.match(both[1], /browserArgs has --no-sandbox: refused/);
  } finally { rmSync(dir, { recursive: true, force: true }); loadConfig(join(tmpdir(), "pb-none", "config.json")); }
});

test("loadConfig drops them, logs one line and pairbrowse_status names the switches", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-browserargs-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ browserArgs: ["--lang=en-US", "--remote-debugging-port=9222", "--disable-web-security"] }));
    const logged = [];
    const config = loadConfig(file, (l) => logged.push(l));
    assert.deepEqual(config.browserArgs, ["--lang=en-US"]);
    const lines = logged.filter((l) => /browserArgs/.test(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /--remote-debugging-port, --disable-web-security dropped/);
    assert.match(statusLine({}, CONFIG_WARNINGS), /warning: config\.json: browserArgs --remote-debugging-port/);
    writeFileSync(file, JSON.stringify({ browserArgs: ["--lang=en-US"] }));
    loadConfig(file);
    assert.ok(!CONFIG_WARNINGS.some((w) => /browserArgs/.test(w)), "a clean config clears the warning");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The older names chromeArgs and chromeSandbox are read while the new ones are unset, through the
// same accessor as the new ones: the same screen, the same sandbox rules, never a way around them.
test("the older names: read only while the new name is unset, and screened and refused exactly as the new ones", () => {
  assert.equal(argsKey({ chromeArgs: ["--lang=en"] }), "chromeArgs");
  assert.equal(argsKey({ browserArgs: ["--lang=de"], chromeArgs: ["--lang=en"] }), "browserArgs");
  assert.equal(argsKey({ browserArgs: null, chromeArgs: ["--lang=en"] }), "chromeArgs", "null is unset");
  assert.equal(argsKey({}), "browserArgs");
  assert.deepEqual(browserArgsOf({ chromeArgs: ["--lang=en"] }), ["--lang=en"]);
  assert.deepEqual(browserArgsOf({ browserArgs: [], chromeArgs: ["--no-sandbox"] }), [], "an empty browserArgs is set: chromeArgs isn't read");
  assert.deepEqual(browserArgsOf({ browserArgs: "--no-sandbox" }), [], "not a list: none");
  assert.equal(browserSandboxOf({ chromeSandbox: false }), false);
  assert.equal(browserSandboxOf({ browserSandbox: true, chromeSandbox: false }), true, "the new name wins");
  assert.equal(browserSandboxOf({ browserSandbox: "false" }), true, "only false turns it off");
  // The launch screens either name alike.
  const viaOld = launchArgs({ chromeArgs: ["--lang=de", ...UNSAFE] });
  const viaNew = launchArgs({ browserArgs: ["--lang=de", ...UNSAFE] });
  assert.deepEqual(viaOld, viaNew);
  for (const a of UNSAFE) assert.ok(!viaOld.includes(a), a);
  assert.ok(!launchOptions({ chromeArgs: ["--no-sandbox"] }).args.includes("--no-sandbox"));
  // --no-sandbox under either name: refused alike on macOS and Windows, the sandbox choice on Linux.
  for (const key of ["browserArgs", "chromeArgs"]) {
    for (const platform of ["darwin", "win32"]) {
      const d = sandboxDecision({ [key]: ["--No-Sandbox"] }, { platform, uid: 501 });
      assert.equal(d.on, true, `${key} ${platform}`);
      assert.match(d.refused, new RegExp(`^${key} has --no-sandbox: refused`), `${key} ${platform}`);
    }
    assert.equal(sandboxDecision({ [key]: ["--no-sandbox"] }, { platform: "linux", uid: 501 }).on, false, key);
    assert.equal(sandboxOffAsked({ [key]: ["--lang=en", "--", "--no-sandbox"] }, "linux"), null, `${key}: after a bare --`);
  }
  for (const key of ["browserSandbox", "chromeSandbox"]) {
    assert.match(sandboxDecision({ [key]: false }, { platform: "darwin", uid: 501 }).refused, new RegExp(`^${key} is false in config\\.json: refused`));
    assert.equal(sandboxDecision({ [key]: false }, { platform: "linux", uid: 501 }).on, false, key);
  }
});

test("loadConfig reads chromeArgs and chromeSandbox as browserArgs and browserSandbox, and screens them alike", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-older-args-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ chromeArgs: ["--lang=en-US", "--remote-debugging-port=9222"], chromeSandbox: true }));
    const logged = [];
    const config = loadConfig(file, (l) => logged.push(l));
    assert.deepEqual(config.browserArgs, ["--lang=en-US"]);
    assert.equal(config.browserSandbox, true);
    assert.ok(!("chromeArgs" in config) && !("chromeSandbox" in config), "one name after loading");
    assert.equal(logged.length, 1);
    assert.match(logged[0], /^config\.json: chromeArgs --remote-debugging-port dropped/, "the warning names the key as written");
    writeFileSync(file, JSON.stringify({ browserArgs: ["--lang=de"], chromeArgs: ["--remote-debugging-port=9222"] }));
    const both = [];
    assert.deepEqual(loadConfig(file, (l) => both.push(l)).browserArgs, ["--lang=de"], "the new name wins");
    assert.deepEqual(both, []);
    if (process.platform !== "linux") {
      writeFileSync(file, JSON.stringify({ chromeSandbox: false, chromeArgs: ["--no-sandbox", "--lang=en"] }));
      const refused = [];
      const c = loadConfig(file, (l) => refused.push(l));
      assert.deepEqual(c.browserArgs, ["--lang=en"]);
      assert.equal(c.browserSandbox, false, "kept as written; the launch refuses it (sandboxDecision)");
      assert.equal(sandboxDecision(c, { platform: process.platform, uid: 501 }).on, true);
      assert.equal(refused.length, 2, "each refusal named");
      assert.match(refused[0], /chromeSandbox is false in config\.json: refused/);
      assert.match(refused[1], /chromeArgs has --no-sandbox: refused/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); loadConfig(join(tmpdir(), "pb-none", "config.json")); }
});
