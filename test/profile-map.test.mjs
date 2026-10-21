// A browser profile to and from a launch (spec server-mode Phase D, D1, D6, D11, D12;
// scripts/profiles/map.mjs): config.json's inventory read into the config-backed profile's
// settings with nothing dropped quietly, a record turned into switches that pass the switch screen
// unchanged and engine keys from the engine's list only, a set field the chosen browser can't apply
// refusing the launch, derived values never written into a profile, and a network change leaving
// the default profile's revision as it was.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, fromConfig, toLaunch, browserKindOf, SWITCHES, ENGINE_KEYS } from "../scripts/profiles/map.mjs";
import { checkProfile, SETTINGS } from "../scripts/profiles/schema.mjs";
import { createProfileStore } from "../scripts/profiles/store.mjs";
import { screenBrowserArgs, switchName } from "../scripts/browser-args.mjs";
import { PAIRBROWSE_ENGINE_KEYS } from "../scripts/config-schema.mjs";
import { browserChoice } from "../scripts/browser/choice.mjs";

const RECORD = JSON.parse(readFileSync(new URL("./fixtures/profiles/record-1.json", import.meta.url), "utf8"));
// The fixture with some settings changed (each object setting replaced whole).
const record = (changes = {}) => ({ ...structuredClone(RECORD), ...structuredClone(changes) });
const NATIVE = { browserKind: "pairbrowse", platform: "linux" };
const OPEN = { browserKind: "pairbrowse-open", platform: "linux" };
// Settings the record check takes: no display a switch can't force.
const LAUNCHABLE = { display: { colorScheme: "dark", reducedMotion: true } };
function makeStore() {
  let t = Date.parse("2026-10-21T10:00:00Z"), n = 0;
  return createProfileStore({ dir: join(mkdtempSync(join(tmpdir(), "pb-map-")), "browser-profiles"), now: () => (t += 1000), randomId: () => (++n).toString(16).padStart(16, "0") });
}
const fields = (items) => items.map((i) => i.field);

test("fromConfig maps the inventory", () => {
  const config = {
    browser: "pairbrowse",
    browserArgs: ["--lang=fr_FR", "--window-size=1280,800", "--force-device-scale-factor=2", "--force-dark-mode", "--force-prefers-reduced-motion",
      "--disable-gpu", "--use-angle=metal", "--remote-debugging-port=9222"],
    adBlocker: false,
    network: { proxies: { work: { server: "http://proxy.test:8080" } }, default: "work" },
    pairbrowse: {
      timezone: "Europe/Berlin", acceptLanguage: "de-DE,de;q=0.9,en;q=0.8,de", screenWidth: 1920, screenHeight: 1080, availHeight: 1050,
      fingerprint: 4242, gpuVendor: "Zq Marker GPU", hardwareConcurrency: 8, platform: "Win32", humanize: true, typingPace: 0.5,
      profileSelect: { os: "mac" }, fingerprintProfile: "x.json", lightStealth: true, notASetting: 1,
    },
  };
  const before = structuredClone(config);
  const { settings, items } = readConfig(config, { platform: "linux" });
  assert.deepEqual(config, before, "config.json's object is never changed");
  assert.deepEqual(Object.keys(settings).sort(), [...SETTINGS].sort());
  assert.deepEqual(settings, {
    browser: { kind: "pairbrowse" },
    // The block's languages win over --lang; weights and repeats dropped.
    locale: { languages: ["de-DE", "de", "en"], timezone: "Europe/Berlin", source: "set" },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1050, colorDepth: 24, devicePixelRatio: 2 },
    window: { width: 1280, height: 800 },
    display: { colorScheme: "dark", reducedMotion: true },
    // --disable-gpu stays in browserArgs as written; the backend is pairbrowse.graphics (E2).
    graphics: { backend: "auto", require: null },
    persona: { source: "seed", seed: "4242" },
    payments: { savedCard: false },
    network: null,
    adBlocker: false,
  });
  // Nothing in the block is dropped without a word; hardware stays config.json-only (U6).
  const named = fields(items);
  for (const k of ["gpuVendor", "hardwareConcurrency", "platform", "humanize", "typingPace", "profileSelect", "fingerprintProfile", "lightStealth", "notASetting"]) {
    assert.ok(named.includes(`pairbrowse.${k}`), `pairbrowse.${k} is reported`);
  }
  assert.equal(items.find((i) => i.field === "pairbrowse.gpuVendor").status, "unsupported");
  assert.ok(items.some((i) => i.field === "browserArgs" && /--use-angle/.test(i.reason)), "a backend switch is named, kept as written");
  assert.ok(items.some((i) => i.field === "browserArgs" && /--disable-gpu/.test(i.reason)), "--disable-gpu too");
  assert.ok(items.every((i) => i.requested === null && !JSON.stringify(i).includes("Zq Marker") && !JSON.stringify(i).includes("proxy.test")), "no value from config.json repeated");
  // The store takes them as the default's settings.
  const made = makeStore().configProfile(settings);
  assert.equal(made.name, "default");
  assert.deepEqual(checkProfile(made).problems, []);

  // --lang alone; "auto" is this computer (D9): the host capture on macOS, the seed persona elsewhere.
  const mac = fromConfig({ browser: "pairbrowse", browserArgs: ["--lang=sv"], pairbrowse: { profile: "auto", fingerprint: "seed-1" } }, { platform: "darwin" });
  assert.deepEqual(mac.locale, { languages: ["sv"], timezone: null, source: "set" });
  assert.deepEqual(mac.persona, { source: "host", seed: null });
  assert.deepEqual(fromConfig({ browser: "pairbrowse", pairbrowse: { profile: "local", fingerprint: "seed-1" } }, { platform: "linux" }).persona, { source: "seed", seed: "seed-1" });
  const saved = readConfig({ browser: "pairbrowse", pairbrowse: { profile: "my-persona" } }, { platform: "linux" });
  assert.equal(saved.items.find((i) => i.field === "pairbrowse.profile").status, "not-applied", "a saved persona is offered for import, not read in");

  // The open build reads no pairbrowse block (as today), and says so; its switches still count.
  const open = readConfig({ browser: "pairbrowse-open", browserArgs: ["--lang=it"], pairbrowse: { timezone: "Europe/Rome", screenWidth: 1920, screenHeight: 1080 } }, { platform: "linux" });
  assert.equal(open.settings.browser.kind, "pairbrowse-open");
  assert.deepEqual(open.settings.locale, { languages: ["it"], timezone: null, source: "set" });
  assert.equal(open.settings.screen, null);
  assert.ok(fields(open.items).includes("pairbrowse"));

  // A value that doesn't fit leaves that setting at its default, named; the rest is read.
  const odd = readConfig({ browser: "pairbrowse", browserArgs: ["--window-size=100,100"], pairbrowse: { timezone: "Mars/Olympus_Mons", screenWidth: 1920, screenHeight: 1080, availWidth: 4000 } }, { platform: "linux" });
  assert.deepEqual(odd.settings.locale, { languages: null, timezone: null, source: "system" });
  assert.equal(odd.settings.screen, null);
  assert.equal(odd.settings.window, null);
  assert.deepEqual(odd.items.filter((i) => i.severity === "warning").map((i) => i.field).sort(), ["locale", "screen", "window"]);
  assert.deepEqual(checkProfile(makeStore().configProfile(odd.settings)).problems, []);
  // Several differing copies of a switch aren't guessed between.
  assert.equal(fromConfig({ browserArgs: ["--lang=de", "--lang=fr"] }).locale.languages, null);
  assert.deepEqual(fromConfig({}), fromConfig(null), "no config: the defaults");

  // browser.kind follows browser/choice.mjs's reading of "browser" and its older names.
  for (const c of [{}, { browser: "pairbrowse" }, { browser: "pairbrowse-open" }, { browser: "chromium" }, { browser: "/opt/own/browser" }, { browser: "nonsense" },
    { browserEngine: "pairbrowse" }, { browserEngine: "chromium" }, { executablePath: "/opt/x" }, { browserEngine: "auto", executablePath: "/opt/x" },
    { browserEngine: "chromium", executablePath: "/opt/x" }, { browserEngine: null, executablePath: "/opt/x" }, { browserEngine: "pairbrowse", executablePath: "/opt/x" },
    { browserEngine: "weird", executablePath: "/opt/x" }, { browserEngine: "open", executablePath: "/opt/x" }, { browserEngine: "weird" }, { browserEngine: "auto" },
    { executablePath: "" }, { browser: 7, executablePath: "/opt/x" }]) {
    for (const native of [false, true]) {
      const chosen = browserChoice(c, { native, exists: () => true, executable: () => true }).browser;
      assert.equal(browserKindOf(c, { native }), chosen === "pairbrowse" ? "pairbrowse" : "pairbrowse-open", JSON.stringify(c));
    }
  }
});

test("toLaunch passes screenBrowserArgs unchanged", () => {
  // Software graphics are the engine's own software renderer, on Linux only (E2; refused elsewhere).
  const p = record({ ...LAUNCHABLE, graphics: { backend: "auto", require: null }, persona: { source: "seed", seed: "pinned-1" } });
  for (const platform of ["darwin", "linux", "win32"]) {
    const soft = platform === "linux";
    const out = toLaunch(soft ? { ...p, graphics: { backend: "software", require: null } } : p, { browserKind: "pairbrowse", platform });
    assert.equal(out.problem, null, out.problem);
    assert.deepEqual(out.switches, ["--lang=de-DE", "--window-size=1440,900", "--force-dark-mode", "--force-prefers-reduced-motion", ...(soft ? ["--use-angle=swiftshader"] : [])]);
    const screened = screenBrowserArgs(out.switches, platform, { harness: false });
    assert.deepEqual(screened, { kept: out.switches, dropped: [], refused: [] }, platform);
    for (const s of out.switches) assert.ok(SWITCHES.includes(switchName(s, platform)), s);
    for (const k of Object.keys(out.engineKeys)) assert.ok(ENGINE_KEYS.includes(k) && PAIRBROWSE_ENGINE_KEYS.includes(k), k);
    assert.deepEqual(out.engineKeys, { acceptLanguage: "de-DE,de,en", timezone: "Europe/Berlin", screenWidth: 1920, screenHeight: 1080,
      availWidth: 1920, availHeight: 1050, colorDepth: 24, devicePixelRatio: 1, fingerprint: "pinned-1" });
    assert.equal(out.geoip, false);
  }
  for (const k of ENGINE_KEYS) assert.ok(PAIRBROWSE_ENGINE_KEYS.includes(k), `${k} is an engine key`);
  // Every setting has its item, in D10's shape; a seed is never repeated.
  const out = toLaunch(p, NATIVE);
  for (const f of ["locale.languages", "locale.timezone", "screen", "window", "display.colorScheme", "display.reducedMotion", "graphics.backend", "persona.seed", "network"]) {
    assert.ok(fields(out.results).includes(f), f);
  }
  for (const r of out.results) assert.deepEqual(Object.keys(r), ["field", "rule", "class", "status", "requested", "measured", "severity", "reason"]);
  assert.ok(!JSON.stringify(out.results).includes("pinned-1"));
  // A first language --lang doesn't take: the native build still sends the languages.
  const odd = toLaunch(record({ ...LAUNCHABLE, locale: { languages: ["de-DE-u-co-phonebk", "de"], timezone: null, source: "set" } }), NATIVE);
  assert.equal(odd.problem, null);
  assert.ok(!odd.switches.some((s) => s.startsWith("--lang")));
  assert.equal(odd.engineKeys.acceptLanguage, "de-DE-u-co-phonebk,de");
  // The network id and the ad blocker choice go to their own parts of the launch.
  const net = toLaunch(record({ ...LAUNCHABLE, network: "work", adBlocker: false }), NATIVE);
  assert.equal(net.network, "work");
  assert.equal(net.adBlocker, false);
});

test("an explicit field the open build can't apply refuses", () => {
  const openRecord = (changes) => record({ ...LAUNCHABLE, browser: { kind: "pairbrowse-open" }, screen: null, locale: { languages: ["de-DE", "en"], timezone: null, source: "set" }, ...changes });
  // Switch-based fields apply; only the first language goes (--lang), the rest named.
  const ok = toLaunch(openRecord(), OPEN);
  assert.equal(ok.problem, null, ok.problem);
  assert.deepEqual(ok.switches, ["--lang=de-DE", "--window-size=1440,900", "--force-dark-mode", "--force-prefers-reduced-motion"]);
  assert.deepEqual(ok.engineKeys, {});
  assert.ok(ok.results.some((r) => r.field === "locale.languages" && r.status === "not-applied" && r.severity === "warning"));
  for (const [changes, field] of [
    [{ locale: { languages: null, timezone: "Europe/Berlin", source: "set" } }, "locale.timezone"],
    [{ screen: RECORD.screen }, "screen"],
    [{ persona: { source: "seed", seed: "pinned-1" } }, "persona.seed"],
    [{ locale: { languages: null, timezone: null, source: "geoip" } }, "locale.source"],
    [{ locale: { languages: ["de-DE-u-co-phonebk"], timezone: null, source: "set" } }, "locale.languages"],
    [{ graphics: { backend: "software", require: null } }, "graphics.backend"],
  ]) {
    const out = toLaunch(openRecord(changes), OPEN);
    assert.match(out.problem || "", new RegExp(`^Browser profile "berlin-desktop" can't start on the open build: ${field.replace(".", "\\.")} \\(`), field);
    assert.deepEqual([out.switches, out.engineKeys], [[], {}], `${field}: nothing to launch with`);
    assert.ok(out.results.some((r) => r.field === field && r.severity === "error" && r.status === "unsupported"));
    assert.ok(!out.problem.includes("pinned-1"));
  }
  // On either build: a scheme or motion setting no switch can force, a GPU or a graphics
  // requirement on the open build, and a profile made for the other browser.
  for (const [changes, field, options] of [
    [{ display: { colorScheme: "light", reducedMotion: true } }, "display.colorScheme", NATIVE],
    [{ display: { colorScheme: null, reducedMotion: false } }, "display.reducedMotion", OPEN],
    [{ graphics: { backend: "gpu", require: null } }, "graphics.backend", OPEN],
    [{ graphics: { backend: "auto", require: { webgl: 2, webgpu: false, platforms: [] } } }, "graphics.require", OPEN],
    [{ browser: { kind: "pairbrowse" } }, "browser.kind", OPEN],
  ]) {
    const base = options === OPEN ? openRecord(changes) : record({ ...LAUNCHABLE, ...changes });
    const out = toLaunch(base, options);
    assert.ok(out.problem, field);
    assert.ok(out.results.some((r) => r.field === field && r.severity === "error"), field);
  }
  // A saved card is a preference, never a refusal (spec B12): on the native build it maps to the
  // launch's prefs (the launch writes it only with a real key store); on the open build it is
  // named and left off. Off writes nothing.
  const card = toLaunch(record({ ...LAUNCHABLE, payments: { savedCard: true } }), NATIVE);
  assert.equal(card.problem, null, card.problem);
  assert.deepEqual(card.prefs, { savedCard: true });
  assert.ok(card.results.some((r) => r.field === "payments.savedCard" && r.status === "applied" && r.severity === "info"));
  const openCard = toLaunch(openRecord({ payments: { savedCard: true } }), OPEN);
  assert.equal(openCard.problem, null, openCard.problem);
  assert.ok(openCard.results.some((r) => r.field === "payments.savedCard" && r.status === "not-applied" && r.severity === "warning"));
  assert.deepEqual(toLaunch(record(LAUNCHABLE), NATIVE).prefs, {});
  // On the native build a GPU and a requirement map (no switch): the launch checks them against
  // the measurement and the browser's own read (daemon/browser/graphics.mjs, step 44).
  for (const graphics of [{ backend: "gpu", require: null }, { backend: "auto", require: { webgl: 2, webgpu: true, platforms: ["linux"] } }]) {
    const out = toLaunch(record({ ...LAUNCHABLE, graphics }), NATIVE);
    assert.equal(out.problem, null, out.problem);
    assert.ok(!out.switches.some((a) => /gpu|angle|use-gl/.test(a)), "nothing forced");
    const field = graphics.require ? "graphics.require" : "graphics.backend";
    assert.ok(out.results.some((r) => r.field === field && r.status === "applied" && r.severity === "info"), field);
  }
  // The fixture as it is (a light scheme, reduced motion off) names both fields in one refusal.
  assert.match(toLaunch(record(), NATIVE).problem, /display\.colorScheme .*; display\.reducedMotion /);
  // A record that isn't valid, or no browser kind: refused, never thrown.
  assert.match(toLaunch(null, NATIVE).problem, /^The browser profile can't start: /);
  assert.match(toLaunch({ ...record(LAUNCHABLE), executablePath: "/bin/sh" }, NATIVE).problem, /a profile can't name a path/);
  assert.match(toLaunch(record(LAUNCHABLE), { browserKind: "/opt/own" }).problem, /browser kind/);
});

test("derived values never written into the profile", () => {
  const p = record({ ...LAUNCHABLE, locale: { languages: null, timezone: null, source: "geoip" }, screen: null, persona: { source: "seed", seed: null } });
  const before = structuredClone(p);
  const out = toLaunch(p, NATIVE);
  assert.equal(out.problem, null);
  assert.deepEqual(p, before, "the record is never changed");
  assert.equal(out.geoip, true);
  for (const k of ["timezone", "acceptLanguage", "platform", "brandVersion", "fingerprint", "screenWidth"]) assert.ok(!(k in out.engineKeys), k);
  for (const f of ["locale.languages", "locale.timezone", "screen", "persona.seed"]) assert.equal(out.results.find((r) => r.field === f).status, "derived", f);
  assert.ok(out.results.every((r) => r.measured === null));
  // With no geoip, this computer's at launch: still nothing set.
  const host = toLaunch(record({ ...LAUNCHABLE, locale: { languages: null, timezone: null, source: "system" }, screen: null, persona: { source: "host", seed: null } }), { browserKind: "pairbrowse", platform: "darwin" });
  assert.deepEqual(host.engineKeys, {});
  assert.match(host.results.find((r) => r.field === "persona.source").reason, /host capture/);
  // config.json's geoip and Intl stay out of the default's settings, and the store keeps no derived value.
  const settings = fromConfig({ browser: "pairbrowse", pairbrowse: { geoip: true, platform: "MacIntel", brandVersion: "150.0.1.2" } }, { platform: "linux" });
  assert.deepEqual(settings.locale, { languages: null, timezone: null, source: "geoip" });
  const store = makeStore();
  const made = store.configProfile(settings);
  assert.ok(!JSON.stringify(made).includes("MacIntel") && !JSON.stringify(made).includes("150.0.1.2"));
  assert.equal(store.configProfile(fromConfig({ browser: "pairbrowse", pairbrowse: { geoip: true } }, { platform: "linux" })).revision, made.revision, "the same settings: the same revision");
});

test("a network change leaves the revision unchanged", () => {
  const store = makeStore();
  const config = { browser: "pairbrowse", browserArgs: ["--lang=de"], network: { proxies: { a: { server: "http://a.test:8080" } }, default: "a" } };
  const first = store.configProfile(fromConfig(config));
  assert.equal(first.revision, 1);
  const moved = { ...config, network: { proxies: { b: { server: "socks5://b.test:1080" } }, default: "b", sessions: { work: "b" } } };
  assert.equal(store.configProfile(fromConfig(moved)).revision, 1, "the network block is operator config, never the profile's");
  assert.equal(store.configProfile(fromConfig({ ...moved, network: null })).revision, 1);
  const changed = store.configProfile(fromConfig({ ...moved, browserArgs: ["--lang=fr"] }));
  assert.equal(changed.revision, 2);
  assert.deepEqual(changed.history.at(-1).change, ["locale"]);
  // A store profile names a network by id; what that id points to changes nothing in it.
  const p = store.create({ name: "proxied", network: "a" });
  const launch = toLaunch(store.use("proxied"), { browserKind: "pairbrowse", platform: "linux" });
  assert.equal(launch.network, "a");
  assert.equal(store.get("proxied").revision, p.revision);
});
