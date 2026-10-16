import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEngine, engineProfile, launchEngine, sandboxDecision, SANDBOX } from "../scripts/engine.mjs";

test("only the standard and native engines exist", () => {
  assert.equal(validateEngine({}), "open");
  assert.equal(validateEngine({ browserEngine: "open" }), "open");
  assert.equal(validateEngine({ browserEngine: "chromium" }), "open", "the older name");
  assert.throws(() => validateEngine({ browserEngine: "typo" }), /Unknown/);
  assert.throws(() => validateEngine({ browserEngine: "pairbrowse" }, "18.0.0"), /Node.js 20/);
  assert.throws(() => validateEngine({ browserEngine: "pairbrowse" }, "22.0.0"), /executablePath/);
});

test("the native engine keeps its own profile", () => {
  assert.equal(engineProfile({}, "/profiles/a"), "/profiles/a");
  assert.equal(engineProfile({ browserEngine: "pairbrowse" }, "/profiles/a"), "/profiles/a/pairbrowse-native");
});

test("standard engine removes automation signals without loading the engine pack", async () => {
  const options = { headless: false };
  const result = await launchEngine({ launchPersistentContext: async (profile, opts) => ({ profile, opts }) }, {}, "/a", options, undefined, () => { throw Error("unexpected engine pack load"); });
  assert.equal(result.profile, "/a");
  assert.equal(result.opts.headless, false);
  assert.deepEqual(result.opts.ignoreDefaultArgs, ["--enable-automation"]);
  assert.deepEqual(result.opts.args, ["--disable-blink-features=AutomationControlled"]);
});

test("the browser's sandbox is on unless config, root on Linux, or the system turns it off", async () => {
  assert.equal(sandboxDecision({}, { platform: "darwin", uid: 501 }).on, true);
  assert.equal(sandboxDecision({}, { platform: "linux", uid: 1000 }).on, true);
  assert.equal(sandboxDecision({}, { platform: "darwin", uid: 0 }).on, true);
  assert.match(sandboxDecision({}, { platform: "linux", uid: 0 }).reason, /root/);
  assert.equal(sandboxDecision({ browserSandbox: false }, { platform: "linux", uid: 501 }).on, false);
  assert.equal(sandboxDecision({ browserArgs: ["--no-sandbox"] }, { platform: "linux", uid: 501 }).on, false);
  assert.equal(sandboxDecision({ chromeSandbox: false }, { platform: "linux", uid: 501 }).on, false, "the older name");
  assert.equal(sandboxDecision({ chromeArgs: ["--no-sandbox"] }, { platform: "linux", uid: 501 }).on, false, "the older name");
  // The new name wins over the older one when both are set.
  assert.equal(sandboxDecision({ browserSandbox: true, chromeSandbox: false }, { platform: "linux", uid: 501 }).on, true);
  assert.equal(sandboxDecision({ browserArgs: ["--lang=en"], chromeArgs: ["--no-sandbox"] }, { platform: "linux", uid: 501 }).on, true);
  // Never off on macOS or Windows, whatever config says: refused, with the reason.
  for (const platform of ["darwin", "win32"]) {
    assert.equal(sandboxDecision({ browserSandbox: false }, { platform, uid: 501 }).on, true, platform);
    assert.equal(sandboxDecision({ browserArgs: ["--no-sandbox"] }, { platform, uid: 501 }).on, true, platform);
    // The older names are held to the same rule.
    assert.equal(sandboxDecision({ chromeSandbox: false }, { platform, uid: 501 }).on, true, platform);
    assert.equal(sandboxDecision({ chromeArgs: ["--no-sandbox"] }, { platform, uid: 501 }).on, true, platform);
    assert.match(sandboxDecision({ chromeArgs: ["--no-sandbox"] }, { platform, uid: 501 }).refused, /^chromeArgs has --no-sandbox: refused/, platform);
    assert.equal(sandboxDecision({}, { platform, uid: 501 }).refused, null, platform);
  }
  const tries = [];
  const logs = [];
  const fake = { launchPersistentContext: async (profile, opts) => {
    tries.push(opts.chromiumSandbox);
    if (opts.chromiumSandbox) throw new Error("Chromium sandboxing failed!\nNo usable sandbox!");
    return { opts };
  } };
  const result = await launchEngine(fake, {}, "/a", {}, (m) => logs.push(m), undefined, { platform: "linux" });
  const expected = process.platform === "linux" && process.getuid?.() === 0 ? [false] : [true, false];
  assert.deepEqual(tries, expected);
  assert.equal(result.opts.chromiumSandbox, false);
  assert.equal(logs.filter((m) => /sandbox is off/.test(m)).length, 1);
  // No user namespaces, so the engine tried its setuid helper, which an unpacked browser can't have.
  const suid = [];
  await launchEngine({ launchPersistentContext: async (profile, opts) => {
    suid.push(opts.chromiumSandbox);
    if (opts.chromiumSandbox) throw new Error("browserType.launchPersistentContext: Target page, context or browser has been closed\n[err] FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] The SUID sandbox helper binary was found, but is not configured correctly. Rather than run without sandboxing I'm aborting now.");
    return { opts };
  } }, {}, "/a", {}, undefined, undefined, { platform: "linux" });
  assert.deepEqual(suid, expected);
  const other = { launchPersistentContext: async () => { throw new Error("profile in use"); } };
  if (expected.length === 2) await assert.rejects(launchEngine(other, {}, "/a", {}, undefined, undefined, { platform: "linux" }), /profile in use/);
  // macOS and Windows never fall back: the sandbox failure is the error, and no launch runs without it.
  for (const platform of ["darwin", "win32"]) {
    const seen = [];
    await assert.rejects(launchEngine({ launchPersistentContext: async (profile, opts) => {
      seen.push(opts.chromiumSandbox);
      throw new Error("Chromium sandboxing failed!\nNo usable sandbox!");
    } }, {}, "/a", {}, () => {}, undefined, { platform }), /sandboxing failed/);
    assert.deepEqual(seen, [true], platform);
  }
});

test("macOS and Windows launch with the sandbox on whatever config asks, strip every --no-sandbox, and log the refusal", async () => {
  for (const platform of ["darwin", "win32"]) {
    const logs = [];
    const result = await launchEngine({ launchPersistentContext: async (profile, opts) => ({ opts }) },
      { browserSandbox: false, browserArgs: ["--no-sandbox"] }, "/a", { args: ["--no-sandbox", "-No-Sandbox=1", "--lang=en", ...(platform === "win32" ? ["/NO-SANDBOX"] : [])] }, (m) => logs.push(m), undefined, { platform });
    assert.equal(result.opts.chromiumSandbox, true, platform);
    assert.deepEqual(result.opts.args, ["--lang=en", "--disable-blink-features=AutomationControlled"], platform);
    assert.equal(SANDBOX.on, true);
    assert.match(SANDBOX.refused, /refused/);
    assert.ok(logs.some((m) => /The browser's sandbox stays on: browserSandbox is false in config\.json: refused/.test(m)), platform);
    assert.ok(!logs.some((m) => /sandbox is off/.test(m)), platform);
  }
});

test("Linux: the sandbox off only when asked, and SANDBOX says so for the status and the bar", async () => {
  const result = await launchEngine({ launchPersistentContext: async (profile, opts) => ({ opts }) },
    { browserSandbox: false }, "/a", { args: ["--lang=en"] }, () => {}, undefined, { platform: "linux" });
  assert.equal(result.opts.chromiumSandbox, false);
  assert.equal(SANDBOX.on, false);
  assert.match(SANDBOX.reason, /browserSandbox is false/);
  if (process.getuid?.() !== 0) {
    const on = await launchEngine({ launchPersistentContext: async (profile, opts) => ({ opts }) }, {}, "/a", { args: ["--no-sandbox"] }, () => {}, undefined, { platform: "linux" });
    assert.equal(on.opts.chromiumSandbox, true);
    assert.deepEqual(on.opts.args, ["--disable-blink-features=AutomationControlled"], "a stray --no-sandbox never rides a sandboxed launch");
    assert.equal(SANDBOX.on, true);
  }
});
