// Property-based fuzzing of a browser profile on its way to a launch (scripts/profiles/schema.mjs
// checkProfile, scripts/profiles/map.mjs toLaunch and readConfig; spec server-mode D6, D11): no
// checked profile yields a switch outside the mapper's list (each passing the switch screen as it
// is), an engine key outside PAIRBROWSE_ENGINE_KEYS or a launch option, on either browser and every
// platform; a launch the profile can't have is refused with a problem and nothing to start with;
// and whatever config.json holds, readConfig gives settings the store takes. Nothing throws.
// Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { checkProfile, SETTINGS, SCHEMA_VERSION, profileDefaults } from "../../scripts/profiles/schema.mjs";
import { toLaunch, readConfig, SWITCHES, ENGINE_KEYS } from "../../scripts/profiles/map.mjs";
import { screenBrowserArgs, switchName } from "../../scripts/browser-args.mjs";
import { PAIRBROWSE_ENGINE_KEYS } from "../../scripts/config-schema.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 3000;
const check = (property, runs = RUNS) => fc.assert(property, { numRuns: runs });
const RECORD = JSON.parse(readFileSync(new URL("../fixtures/profiles/record-1.json", import.meta.url), "utf8"));
const PLATFORMS = ["darwin", "linux", "win32"];
const KINDS = ["pairbrowse", "pairbrowse-open"];
// What a launch option looks like in any key of the engine keys (D6's names).
const LAUNCH_WORDS = /path|exec|extension|proxy|server|args|switch|sandbox|headless|env|channel|debug|bridge/i;

const maybe = (arb) => fc.option(arb, { nil: null });
const screenSide = fc.oneof(fc.integer({ min: 320, max: 16384 }), fc.integer({ min: -10, max: 20000 }));
const settings = fc.record({
  browser: fc.record({ kind: fc.constantFrom(...KINDS, "other-browser") }),
  locale: fc.record({
    languages: maybe(fc.array(fc.constantFrom("de-DE", "en", "fr-CA", "zh-Hans-CN", "de-DE-u-co-phonebk", "x", "en_US", "--lang=x"), { maxLength: 12 })),
    timezone: maybe(fc.constantFrom("Europe/Berlin", "America/New_York", "UTC", "Mars/Base", "../etc")),
    source: fc.constantFrom("set", "system", "geoip", "other"),
  }),
  screen: maybe(fc.record({ width: screenSide, height: screenSide, availWidth: screenSide, availHeight: screenSide,
    colorDepth: fc.constantFrom(16, 24, 30, 32, 8), devicePixelRatio: fc.constantFrom(0.5, 1, 1.25, 2, 5, 0, 7) })),
  window: maybe(fc.record({ width: screenSide, height: screenSide })),
  display: fc.record({ colorScheme: fc.constantFrom(null, "light", "dark", "blue"), reducedMotion: fc.constantFrom(null, true, false, "yes") }),
  graphics: fc.record({ backend: fc.constantFrom("auto", "software", "gpu", "metal"), require: fc.constantFrom(null, { webgl: 2, webgpu: true, platforms: ["linux"] }) }),
  persona: fc.record({ source: fc.constantFrom("seed", "host"), seed: maybe(fc.constantFrom("pinned-1", "off", "a b", "x".repeat(129), "42")) }),
  payments: fc.record({ savedCard: fc.boolean() }),
  network: maybe(fc.constantFrom("work", "Work", "a/b")),
  adBlocker: fc.constantFrom(null, true, false),
});
// Settings a launch can take on either build or on the native one, so the yes path is tried as often as the no.
const side = fc.integer({ min: 320, max: 4000 });
const launchable = fc.record({
  browser: fc.record({ kind: fc.constantFrom(...KINDS) }),
  locale: fc.record({ languages: maybe(fc.array(fc.constantFrom("de-DE", "en", "fr-CA", "zh-Hans-CN"), { minLength: 1, maxLength: 4 })), timezone: maybe(fc.constantFrom("Europe/Berlin", "UTC")), source: fc.constantFrom("set", "system", "geoip") }),
  screen: maybe(fc.tuple(side, side).map(([w, h]) => ({ width: w, height: h, availWidth: w, availHeight: h, colorDepth: 24, devicePixelRatio: 2 }))),
  window: maybe(fc.record({ width: side, height: side })),
  display: fc.record({ colorScheme: fc.constantFrom(null, "dark"), reducedMotion: fc.constantFrom(null, true) }),
  graphics: fc.record({ backend: fc.constantFrom("auto", "software"), require: fc.constant(null) }),
  persona: fc.oneof(fc.record({ source: fc.constant("seed"), seed: maybe(fc.constantFrom("pinned-1", "42")) }), fc.constant({ source: "host", seed: null })),
  payments: fc.constant({ savedCard: false }),
  network: maybe(fc.constantFrom("work", "home-2")),
  adBlocker: fc.constantFrom(null, true, false),
});
// A record around generated settings, sometimes with a key a profile can never hold.
const extra = fc.constantFrom(null, ["executablePath", "/bin/sh"], ["browserArgs", ["--remote-debugging-port=9222"]], ["proxy", "http://x"], ["canvasBridge", true], ["gpuVendor", "X"]);
const records = fc.tuple(fc.oneof(settings, launchable, launchable), fc.oneof(fc.constant(null), fc.constant(null), extra)).map(([s, more]) => {
  const r = { ...structuredClone(RECORD), ...s, schema: SCHEMA_VERSION };
  if (more) r[more[0]] = more[1];
  return r;
});

test("no checked profile yields a switch outside the mapper's list, an engine key outside PAIRBROWSE_ENGINE_KEYS or a launch option", () => {
  let launched = 0;
  check(fc.property(records, fc.constantFrom(...KINDS), fc.constantFrom(...PLATFORMS), (raw, browserKind, platform) => {
    const valid = !!checkProfile(raw).profile;
    const out = toLaunch(raw, { browserKind, platform });
    assert.deepEqual(Object.keys(out).sort(), ["adBlocker", "engineKeys", "geoip", "network", "prefs", "problem", "results", "switches"]);
    if (!valid) assert.ok(out.problem, "a record that isn't valid never launches");
    if (out.problem) {
      assert.deepEqual([out.switches, out.engineKeys], [[], {}]);
      return;
    }
    launched++;
    assert.equal(raw.browser.kind, browserKind, "a profile only starts the browser it is for");
    assert.deepEqual(screenBrowserArgs(out.switches, platform, { harness: false }), { kept: out.switches, dropped: [], refused: [] });
    for (const sw of out.switches) assert.ok(SWITCHES.includes(switchName(sw, platform)), sw);
    for (const [k, v] of Object.entries(out.engineKeys)) {
      assert.ok(ENGINE_KEYS.includes(k) && PAIRBROWSE_ENGINE_KEYS.includes(k), k);
      assert.ok(!LAUNCH_WORDS.test(k), k);
      assert.ok(typeof v === "string" || typeof v === "number", `${k} is a plain value`);
    }
    if (browserKind === "pairbrowse-open") assert.deepEqual(out.engineKeys, {}, "the open build applies switches only");
    // prefs: only the native build's color scheme and the profile's saved card (asked for on either
    // build; the launch honors it only with a real key store), each the profile's own.
    const scheme = raw.display.colorScheme;
    assert.deepEqual(out.prefs, { ...(browserKind === "pairbrowse" && scheme ? { colorScheme: scheme } : {}), ...(raw.payments.savedCard === true ? { savedCard: true } : {}) });
    assert.ok(out.results.every((r) => r.severity !== "error"));
  }));
  assert.ok(launched > RUNS / 50, `some generated profiles launch (${launched})`);
});

// config.json as anything: a random object around the keys readConfig reads.
const cfgValue = fc.oneof(fc.constant(null), fc.boolean(), fc.integer({ min: -5, max: 20000 }), fc.double(), fc.constantFrom("de-DE,de;q=0.9", "Europe/Berlin", "auto", "local", "off", "/x", "pairbrowse", "pairbrowse-open", "software", "gpu"), fc.string({ maxLength: 8 }));
const cfgKeys = ["acceptLanguage", "timezone", "geoip", "screenWidth", "screenHeight", "availWidth", "availHeight", "colorDepth", "devicePixelRatio", "fingerprint", "profile", "graphics", "gpuVendor", "humanize", "__proto__", "constructor"];
const config = fc.record({
  browser: cfgValue,
  browserArgs: fc.oneof(cfgValue, fc.array(fc.oneof(fc.constantFrom("--lang=de", "--lang=fr_FR", "--window-size=1280,800", "--window-size=10,10", "--force-dark-mode", "--force-device-scale-factor=2",
    "--force-prefers-reduced-motion", "--disable-gpu", "--use-gl=egl", "--", "--no-sandbox", "--proxy-server=x"), fc.string({ maxLength: 12 })), { maxLength: 6 })),
  adBlocker: cfgValue,
  pairbrowse: fc.oneof(cfgValue, fc.dictionary(fc.constantFrom(...cfgKeys), cfgValue, { maxKeys: 8 })),
}, { requiredKeys: [] });

test("whatever config.json holds, readConfig gives settings that make a valid record, and reports without repeating a string", () => {
  check(fc.property(config, fc.boolean(), fc.constantFrom(...PLATFORMS), (cfg, native, platform) => {
    const { settings: s, items } = readConfig(cfg, { native, platform });
    assert.deepEqual(Object.keys(s).sort(), [...SETTINGS].sort());
    const record = { schema: SCHEMA_VERSION, id: "p-0000000000000000", name: "default", kind: "config", revision: 1, status: "active", created: "2026-01-01T00:00:00Z", engine: null, ...profileDefaults(), ...s };
    assert.deepEqual(checkProfile(record).problems, []);
    for (const i of items) assert.equal(i.requested, null);
  }));
});
