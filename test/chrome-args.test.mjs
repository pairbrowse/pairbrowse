// chromeArgs from the user's config.json are screened before launch (scripts/chrome-args.mjs):
// a debugging surface, another profile or extension, web security off are dropped and named; the
// driver's own pipe and the side panel's own extension switches are untouched.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenChromeArgs, switchName, launchableChromeArgs } from "../scripts/chrome-args.mjs";
import { loadConfig, CONFIG_WARNINGS } from "../scripts/paths.mjs";
import { launchArgs, launchOptions } from "../scripts/browser.mjs";
import { statusLine } from "../scripts/daemon/serve/tools/status.mjs";
import { sandboxDecision } from "../scripts/engine.mjs";

const UNSAFE = ["--remote-debugging-port=9222", "--remote-debugging-address=0.0.0.0", "--remote-debugging-pipe", "--remote-allow-origins=*", "--disable-web-security", "--disable-site-isolation-trials", "--user-data-dir=/tmp/other", "--load-extension=/tmp/evil", "--disable-extensions-except=/tmp/evil", "--allowlisted-extension-id=abc"];

test("every unsafe switch is dropped and named without its value; ordinary ones stay", () => {
  const { kept, dropped } = screenChromeArgs(["--lang=en-US", ...UNSAFE, "--headless=new"], "darwin");
  assert.deepEqual(kept, ["--lang=en-US", "--headless=new"]);
  assert.equal(dropped.length, UNSAFE.length);
  assert.ok(dropped.includes("--remote-debugging-port") && !dropped.some((d) => d.includes("9222")));
});

test("other spellings Chromium reads are caught too", () => {
  assert.deepEqual(screenChromeArgs(["-remote-debugging-port=9222", "--Remote-Debugging-Port=1", "--remote-debugging-port"], "linux").kept, []);
  assert.deepEqual(screenChromeArgs(["/remote-debugging-port=9222"], "win32").kept, []);
  assert.deepEqual(screenChromeArgs(["/remote-debugging-port=9222"], "darwin").kept, ["/remote-debugging-port=9222"], "a path, not a switch, off Windows");
  assert.equal(switchName("https://example.com"), null);
  assert.deepEqual(screenChromeArgs(null).kept, []);
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
