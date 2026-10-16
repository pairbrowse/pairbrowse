// chromeArgs from the user's config.json are screened before launch against an allowlist
// (scripts/chrome-args.mjs): any other switch, a value of the wrong shape and every argument that
// isn't a switch are dropped and named; the driver's own pipe and the side panel's own extension
// switches are untouched.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenChromeArgs, switchName, launchableChromeArgs, allowedChromeArg } from "../scripts/chrome-args.mjs";
import { loadConfig, CONFIG_WARNINGS } from "../scripts/paths.mjs";
import { launchArgs, launchOptions } from "../scripts/browser.mjs";
import { statusLine } from "../scripts/daemon/serve/tools/status.mjs";
import { sandboxDecision } from "../scripts/engine.mjs";

const UNSAFE = ["--remote-debugging-port=9222", "--remote-debugging-address=0.0.0.0", "--remote-debugging-pipe", "--remote-allow-origins=*", "--disable-web-security", "--disable-site-isolation-trials", "--user-data-dir=/tmp/other", "--load-extension=/tmp/evil", "--disable-extensions-except=/tmp/evil", "--allowlisted-extension-id=abc"];

test("every unsafe switch is dropped and named without its value; ordinary ones stay", () => {
  const { kept, dropped } = screenChromeArgs(["--lang=en-US", ...UNSAFE, "--headless=new"], "darwin", { harness: false });
  assert.deepEqual(kept, ["--lang=en-US", "--headless=new"]);
  assert.equal(dropped.length, UNSAFE.length);
  assert.ok(dropped.includes("--remote-debugging-port") && !dropped.some((d) => d.includes("9222")));
});

test("other spellings Chromium reads are caught too", () => {
  assert.deepEqual(screenChromeArgs(["-remote-debugging-port=9222", "--Remote-Debugging-Port=1", "--remote-debugging-port"], "linux").kept, []);
  assert.deepEqual(screenChromeArgs(["/remote-debugging-port=9222"], "win32").kept, []);
  assert.deepEqual(screenChromeArgs(["/remote-debugging-port=9222"], "darwin").kept, [], "a path off Windows: not a switch, dropped too");
  assert.equal(switchName("https://example.com"), null);
  assert.deepEqual(screenChromeArgs(null).kept, []);
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
    const { kept, dropped } = screenChromeArgs(MISSED, platform, { harness: false });
    assert.deepEqual(kept, [], platform);
    assert.equal(dropped.length, MISSED.length, platform);
  }
});

test("a value given as the next element is a page to open: both are dropped", () => {
  const { kept, dropped } = screenChromeArgs(["--proxy-server", "http://evil:8080", "--lang", "en", "--window-size=800,600"], "linux", { harness: false });
  assert.deepEqual(kept, ["--window-size=800,600"], "--lang takes its value after =, so alone it is dropped too");
  assert.ok(!kept.includes("http://evil:8080") && !kept.includes("en"));
  assert.ok(dropped.includes("--proxy-server") && dropped.includes("--lang"));
  assert.ok(dropped.includes("2 arguments that aren't switches"), dropped.join("; "));
  assert.ok(!dropped.some((d) => d.includes("evil")), "a dropped page address is counted, never shown");
});

test("after a bare --, nothing is a switch", () => {
  assert.deepEqual(screenChromeArgs(["--lang=de", "--", "--lang=fr"], "linux", { harness: false }).kept, ["--lang=de"]);
});

test("allowlisted switches keep only values of their shape", () => {
  const ok = ["--lang=en-US", "--window-size=1280,800", "--window-position=-10,20", "--force-device-scale-factor=1.5", "--force-dark-mode",
    "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--disable-notifications", "--headless=new", "--headless", "--enable-features=Foo,Bar_2",
    "--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:4100", "--host-resolver-rules=MAP a.example localhost, EXCLUDE b.example", "--ozone-platform=wayland",
    "--disable-dev-shm-usage", "--font-render-hinting=none", "-lang=nl", "--no-sandbox"];
  for (const a of ok) assert.ok(allowedChromeArg(a, "linux"), a);
  const bad = ["--lang=en;x", "--window-size=big", "--force-dark-mode=1", "--headless=x", "--enable-features=", "--host-resolver-rules=",
    "--host-resolver-rules=MAP * 10.0.0.1", "--ozone-platform=headless", "--disable-features=LocalNetworkAccessChecks", "--use-mock-keychain", "--password-store=basic"];
  for (const a of bad) assert.ok(!allowedChromeArg(a, "linux"), a);
});

test("the test harness's own switches pass only in a helper it started", () => {
  const test = ["--disable-features=LocalNetworkAccessChecks", "--use-mock-keychain", "--password-store=basic"];
  assert.deepEqual(screenChromeArgs(test, "darwin", { harness: true }).kept, test);
  assert.deepEqual(screenChromeArgs(test, "darwin", { harness: false }).kept, []);
  assert.deepEqual(screenChromeArgs(["--disable-features=SitePerProcess"], "darwin", { harness: true }).kept, [], "never site isolation");
});

test("Windows reads /switch and any case; elsewhere a /path is not a switch", () => {
  assert.deepEqual(screenChromeArgs(["/LANG=de", "/Renderer-Cmd-Prefix=x"], "win32", { harness: false }).kept, ["/LANG=de"]);
  assert.deepEqual(screenChromeArgs(["/lang=de"], "linux", { harness: false }).kept, []);
});

test("--no-sandbox in any spelling turns the sandbox off, never dropped quietly", () => {
  for (const [a, platform] of [["--no-sandbox", "linux"], ["-no-sandbox", "linux"], ["--No-Sandbox", "linux"], ["/no-sandbox", "win32"], ["--no-sandbox=1", "darwin"]]) {
    assert.equal(sandboxDecision({ chromeArgs: [a] }, { platform, uid: 501 }).on, false, a);
    assert.deepEqual(launchableChromeArgs([a, "--lang=en"], platform, { harness: false }), ["--lang=en"], a);
  }
  assert.equal(sandboxDecision({ chromeArgs: ["/no-sandbox"] }, { platform: "linux", uid: 501 }).on, true, "a path off Windows");
});

test("launchArgs: the user's unsafe switches never reach the browser; the panel's own extension switches do", () => {
  const args = launchArgs({ chromeArgs: ["--lang=de", ...UNSAFE] });
  for (const a of UNSAFE) assert.ok(!args.includes(a), a);
  assert.ok(args.includes("--lang=de"));
  assert.ok(args.some((a) => a.startsWith("--load-extension=") && !a.includes("/tmp/evil")), "the side panel still loads");
  assert.ok(args.some((a) => a.startsWith("--allowlisted-extension-id=") && !a.endsWith("=abc")));
  assert.ok(!args.some((a) => /^--?remote-debugging-/.test(a)), "PairBrowse adds no debugging switch; the driver adds its own pipe");
});

test("--no-sandbox stays the user's sandbox choice (sandboxDecision) and is not passed raw", () => {
  const config = { chromeArgs: ["--no-sandbox", "--lang=en"] };
  assert.equal(sandboxDecision(config, { platform: "darwin", uid: 501 }).on, false);
  assert.deepEqual(launchableChromeArgs(config.chromeArgs), ["--lang=en"]);
  assert.ok(!launchOptions(config).args.includes("--no-sandbox"), "the driver adds it from chromiumSandbox: false");
});

test("loadConfig drops them, logs one line and pairbrowse_status names the switches", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-chromeargs-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ chromeArgs: ["--lang=en-US", "--remote-debugging-port=9222", "--disable-web-security"] }));
    const logged = [];
    const config = loadConfig(file, (l) => logged.push(l));
    assert.deepEqual(config.chromeArgs, ["--lang=en-US"]);
    const lines = logged.filter((l) => /chromeArgs/.test(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /--remote-debugging-port, --disable-web-security dropped/);
    assert.match(statusLine({}, CONFIG_WARNINGS), /warning: config\.json: chromeArgs --remote-debugging-port/);
    writeFileSync(file, JSON.stringify({ chromeArgs: ["--lang=en-US"] }));
    loadConfig(file);
    assert.ok(!CONFIG_WARNINGS.some((w) => /chromeArgs/.test(w)), "a clean config clears the warning");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
