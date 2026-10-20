// Property-based fuzzing of the browserArgs allowlist (scripts/browser-args.mjs): every spelling
// the engine reads of a switch the list doesn't hold ("--x", "-x", "/x" on Windows, any case, with
// or without "=value", its value as the next element) is dropped; an allowlisted switch with a
// value of its shape passes in any spelling; nothing that isn't a switch ever passes; and what
// passes is always a switch on the list. Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { screenBrowserArgs, switchName, allowedBrowserArg, ALLOWED, withoutNoSandbox } from "../../scripts/browser-args.mjs";
import { sandboxDecision } from "../../scripts/engine.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
const check = (property) => fc.assert(property, { numRuns: RUNS });
const platform = fc.constantFrom("darwin", "linux", "win32");
const prefix = (p) => fc.constantFrom(...(p === "win32" ? ["--", "-", "/"] : ["--", "-"]));
const recase = (name) => fc.array(fc.boolean(), { minLength: name.length, maxLength: name.length })
  .map((up) => [...name].map((c, i) => (up[i] ? c.toUpperCase() : c)).join(""));
const anyText = fc.string({ unit: "binary", maxLength: 40 });

// Switches that run a program, weaken the browser, send traffic elsewhere or open a debugging
// surface, plus names nobody has listed.
const BLOCKED = ["remote-debugging-port", "remote-debugging-pipe", "remote-debugging-address", "remote-allow-origins", "renderer-cmd-prefix",
  "utility-cmd-prefix", "gpu-launcher", "browser-subprocess-path", "ignore-certificate-errors", "ignore-certificate-errors-spki-list",
  "allow-file-access-from-files", "unsafely-treat-insecure-origin-as-secure", "proxy-server", "proxy-pac-url", "auto-open-devtools-for-tabs",
  "no-zygote", "disable-web-security", "disable-site-isolation-trials", "user-data-dir", "load-extension", "disable-extensions-except",
  "allowlisted-extension-id", "webrtc-ip-handling-policy", "force-webrtc-ip-handling-policy", "disable-gpu-sandbox", "single-process",
  "use-fake-ui-for-media-stream", "kiosk", "app"];
const unlisted = fc.oneof(fc.constantFrom(...BLOCKED), fc.stringMatching(/^[a-z][a-z0-9-]{0,30}$/))
  .filter((n) => !Object.hasOwn(ALLOWED, n));

// Property: a switch the list doesn't hold never passes, in any spelling, with any value, at any
// place, for a helper the harness started or not; nor does the element after it.
test("no spelling of an unlisted switch survives", () => {
  check(fc.property(platform, fc.boolean(), fc.array(fc.constantFrom("--lang=en", "--mute-audio"), { maxLength: 3 }), (p, harness, around) => {
    return fc.assert(fc.property(unlisted.chain((n) => fc.tuple(prefix(p), recase(n))), fc.option(anyText, { nil: undefined }), fc.option(anyText, { nil: undefined }),
      ([pre, name], value, next) => {
        const arg = pre + name + (value === undefined ? "" : `=${value}`);
        const args = [...around, arg, ...(next === undefined ? [] : [next])];
        const { kept } = screenBrowserArgs(args, p, { harness });
        assert.ok(!kept.includes(arg), `${p}: ${arg}`);
        if (next !== undefined && switchName(next, p) === null) assert.ok(!kept.includes(next), `${p}: ${next}`);
      }), { numRuns: 20 });
  }), { numRuns: Math.max(1, Math.floor(RUNS / 20)) });
});

// Property: an arg that isn't a switch never passes.
test("nothing that isn't a switch passes", () => {
  check(fc.property(platform, fc.boolean(), fc.oneof(anyText, fc.webUrl(), fc.constantFrom("--", "-", "/", "", "=x", "--=x")), (p, harness, arg) => {
    if (switchName(arg, p) !== null && arg !== "--") return;
    assert.deepEqual(screenBrowserArgs([arg], p, { harness }).kept, []);
  }));
});

// Property: whatever passes is a switch on the list, and its value is one the list takes.
test("what passes is always a listed switch with a value of its shape", () => {
  const listed = fc.constantFrom(...Object.keys(ALLOWED));
  const arg = fc.tuple(fc.constantFrom("--", "-", "/"), listed, fc.option(fc.oneof(anyText, fc.constantFrom("new", "en-US", "1280,800", "1.5", "Foo,Bar", "basic", "MAP * 127.0.0.1", "MAP * 10.0.0.1", "SitePerProcess", "LocalNetworkAccessChecks")), { nil: undefined }))
    .map(([pre, n, v]) => pre + n + (v === undefined ? "" : `=${v}`));
  check(fc.property(platform, fc.boolean(), fc.array(fc.oneof(arg, anyText), { maxLength: 6 }), (p, harness, args) => {
    for (const a of screenBrowserArgs(args, p, { harness }).kept) {
      const name = switchName(a, p);
      assert.ok(name !== null && Object.hasOwn(ALLOWED, name), a);
      assert.ok(allowedBrowserArg(a, p, { harness }), a);
      if (name === "disable-features") assert.ok(harness && a.endsWith("=LocalNetworkAccessChecks"), a);
      if (name === "host-resolver-rules") assert.ok(!/\b10\.0\.0\.1\b/.test(a), a);
    }
  }));
});

// Property: allowlisted switches with a good value pass in every spelling the engine reads.
test("allowlisted switches pass in any spelling", () => {
  const good = fc.constantFrom(["lang", "en-US"], ["window-size", "1280,800"], ["mute-audio", null], ["hide-scrollbars", null], ["enable-features", "Foo,Bar"],
    ["host-resolver-rules", "MAP *.pbtest.example 127.0.0.1:4100"], ["force-device-scale-factor", "2"], ["disable-notifications", null]);
  check(fc.property(platform, good, (p, [n, v]) => fc.assert(fc.property(prefix(p), p === "win32" ? recase(n) : fc.constant(n), (pre, name) => {
    const arg = pre + name + (v === null ? "" : `=${v}`);
    assert.deepEqual(screenBrowserArgs([arg], p, { harness: false }).kept, [arg]);
  }), { numRuns: 5 })), { numRuns: Math.max(1, Math.floor(RUNS / 5)) });
});

// Property: any spelling of --no-sandbox the engine reads (prefix, case, any value) turns the sandbox
// off on Linux, and is refused on macOS and Windows: the sandbox stays on, the refusal says why, and
// the switch is never kept nor dropped quietly.
test("every spelling of --no-sandbox: off on Linux, refused on macOS and Windows", () => {
  check(fc.property(platform, (p) => fc.assert(fc.property(prefix(p), recase("no-sandbox"), fc.option(anyText, { nil: undefined }), (pre, name, value) => {
    const arg = pre + name + (value === undefined ? "" : `=${value}`);
    const d = sandboxDecision({ browserArgs: [arg] }, { platform: p, uid: 501 });
    // The older name chromeArgs gets the same decision (only the key named in the refusal differs).
    const older = sandboxDecision({ chromeArgs: [arg] }, { platform: p, uid: 501 });
    assert.equal(older.on, d.on, arg);
    assert.equal(older.refused?.replace(/^chromeArgs/, "browserArgs") ?? null, d.refused, arg);
    assert.ok(!withoutNoSandbox([arg], p).length, arg);
    if (p === "linux") { assert.equal(d.on, false, arg); return; }
    assert.equal(d.on, true, arg);
    assert.match(d.refused, /refused/, arg);
    const s = screenBrowserArgs([arg], p, { harness: true });
    assert.deepEqual(s.kept, [], arg);
    assert.deepEqual(s.refused, [arg.split("=")[0]], arg);
  }), { numRuns: 10 })), { numRuns: Math.max(1, Math.floor(RUNS / 10)) });
});

// Property: other sandbox-weakening switches are never kept, in any spelling, on any platform.
test("no other sandbox switch passes", () => {
  const names = fc.constantFrom("disable-setuid-sandbox", "disable-gpu-sandbox", "no-zygote-sandbox", "disable-seccomp-filter-sandbox", "disable-namespace-sandbox", "no-zygote", "single-process", "in-process-gpu");
  check(fc.property(platform, names, (p, n) => fc.assert(fc.property(prefix(p), recase(n), fc.option(anyText, { nil: undefined }), (pre, name, value) => {
    const arg = pre + name + (value === undefined ? "" : `=${value}`);
    assert.deepEqual(screenBrowserArgs([arg], p, { harness: true }).kept, [], arg);
  }), { numRuns: 5 })), { numRuns: Math.max(1, Math.floor(RUNS / 5)) });
});
