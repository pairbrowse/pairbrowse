import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { panelExtensionId, browserChoice } from "../scripts/browser.mjs";
import { rebrandPak } from "../scripts/native/macos-app.mjs";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// fn() as in a helper the test harness started (its home's runtime link, scripts/testenv.mjs
// harnessStarted): only there does a --headless in browserArgs pass.
function inHarness(fn) {
  const before = process.env.PAIRBROWSE_HOME;
  const home = mkdtempSync(join(tmpdir(), "pb-harness-"));
  symlinkSync(tmpdir(), join(home, "runtime"), "dir");
  process.env.PAIRBROWSE_HOME = home;
  try { return fn(); } finally { process.env.PAIRBROWSE_HOME = before; }
}

// A minimal version 5 pak: two strings and one alias.
function pak(strings) {
  const count = strings.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(5, 0); head[4] = 1; head.writeUInt16LE(count, 8); head.writeUInt16LE(1, 10);
  const data = strings.map((s) => Buffer.from(s, "utf8"));
  const table = Buffer.alloc((count + 1) * 6);
  const aliases = Buffer.alloc(4);
  aliases.writeUInt16LE(900, 0); aliases.writeUInt16LE(0, 2);
  let offset = 12 + table.length + aliases.length;
  for (let i = 0; i <= count; i++) {
    table.writeUInt16LE(100 + i, i * 6);
    table.writeUInt32LE(offset, i * 6 + 2);
    if (i < count) offset += data[i].length;
  }
  return Buffer.concat([head, table, aliases, ...data]);
}
const read = (buf) => {
  const count = buf.readUInt16LE(8), start = 12;
  return Array.from({ length: count }, (_, i) => buf.subarray(buf.readUInt32LE(start + i * 6 + 2), buf.readUInt32LE(start + (i + 1) * 6 + 2)).toString("utf8"));
};

test("the engine's interface text is renamed to PairBrowse, web addresses stay", () => {
  const out = rebrandPak(pak(["Quit Chromium", "See chromium.org — Chromium ❤"]));
  assert.deepEqual(read(out), ["Quit PairBrowse", "See chromium.org — PairBrowse ❤"]);
  assert.equal(out.readUInt16LE(12 + 3 * 6), 900, "aliases kept");
});

test("other pak formats are left alone", () => {
  const b = pak(["Chromium"]);
  b.writeUInt32LE(4, 0);
  assert.equal(rebrandPak(b), null);
});

test("the side panel's id comes from its manifest key like the engine does, wherever the folder is", async () => {
  const { readFileSync, mkdtempSync, cpSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { PANEL_DIR } = await import("../scripts/browser.mjs");
  const key = JSON.parse(readFileSync(join(PANEL_DIR, "manifest.json"), "utf8")).key;
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  const id = [...hex].map((c) => "abcdefghijklmnop"[parseInt(c, 16)]).join("");
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(panelExtensionId(), id);
  const copy = join(mkdtempSync(join(tmpdir(), "pb-panel-")), "0.99.0", "ui");
  cpSync(PANEL_DIR, copy, { recursive: true });
  assert.equal(panelExtensionId(copy), id, "another copy (a plugin update) keeps the id");
  assert.notEqual(panelExtensionId("/tmp/x"), panelExtensionId("/tmp/y"), "a folder without a key falls back to its path");
});

test("earlier copies' path-derived side panel records and buttons are removed", async () => {
  const { prepareProfile } = await import("../scripts/browser.mjs");
  const { mkdtempSync, writeFileSync, readFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const profile = mkdtempSync(join(tmpdir(), "pb-old-"));
  mkdirSync(join(profile, "Default"));
  const id = panelExtensionId();
  const old = "abcdabcdabcdabcdabcdabcdabcdabcd";
  const path = "/Users/x/.claude/plugins/cache/pairbrowse/pairbrowse/0.14.1/scripts/browser/panel";
  writeFileSync(join(profile, "Default", "Secure Preferences"), JSON.stringify({ extensions: { settings: { [old]: { path, state: 0 }, [id]: { path: "/new/ui", ack_ntp_bubble: true }, keep: { path: "/elsewhere" } } },
    protection: { macs: { extensions: { settings: { [old]: "M", [id]: "N", keep: "K" } } } } }));
  writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ extensions: { pinned_extensions: [old, "keep"] } }));
  prepareProfile(profile);
  const secure = JSON.parse(readFileSync(join(profile, "Default", "Secure Preferences"), "utf8"));
  assert.deepEqual(Object.keys(secure.extensions.settings).sort(), [id, "keep"].sort());
  assert.deepEqual(Object.keys(secure.protection.macs.extensions.settings).sort(), [id, "keep"].sort());
  const prefs = JSON.parse(readFileSync(join(profile, "Default", "Preferences"), "utf8"));
  assert.deepEqual(prefs.extensions.pinned_extensions.sort(), [id, "keep"].sort());
});

test("this checkout's keyless panel id from before ui/ (scripts/browser/panel) counts as an earlier copy", async () => {
  const { oldPanelIds } = await import("../scripts/browser.mjs");
  // No manifest there any more, so the id is the one the engine derived from the folder path.
  const before = panelExtensionId(new URL("../scripts/browser/panel", import.meta.url).pathname);
  const secure = { extensions: { settings: { [before]: { state: 0 }, [panelExtensionId()]: { path: "/new/ui" }, keep: { path: "/elsewhere" } } } };
  assert.deepEqual(oldPanelIds(secure), [before]);
});

test("profiles get the engine's own navy color theme instead of the old theme extension", async () => {
  const { profilePreferences, THEME_COLOR } = await import("../scripts/browser.mjs");
  const old = { extensions: { theme: { id: panelExtensionId(new URL("../scripts/browser/theme", import.meta.url).pathname), pack: "x" }, pinned_extensions: [] } };
  for (const prefs of [{}, old]) {
    const out = profilePreferences(prefs);
    assert.deepEqual(out.extensions.theme, { id: "user_color_theme_id" });
    assert.equal(out.browser.theme.user_color2, THEME_COLOR);
    assert.equal(out.browser.theme.color_scheme2, 2);
    assert.ok(out.extensions.pinned_extensions.includes(panelExtensionId()));
    assert.equal(out.session.restore_on_startup, 5);
  }
  // A theme the user chose themselves (or Default, id "") stays.
  const own = profilePreferences({ extensions: { theme: { id: "" } }, browser: { theme: { user_color2: 5 } } });
  assert.deepEqual(own.extensions.theme, { id: "" });
  assert.equal(own.browser.theme.user_color2, 5);
  // A color the user picked in the engine's own color theme stays; PairBrowse's old seed moves on.
  const picked = profilePreferences({ extensions: { theme: { id: "user_color_theme_id" } }, browser: { theme: { user_color2: 0xff00aa00 | 0 } } });
  assert.equal(picked.browser.theme.user_color2, 0xff00aa00 | 0);
  const stale = profilePreferences({ extensions: { theme: { id: "user_color_theme_id" } }, browser: { theme: { user_color2: 0xff4e6498 | 0, color_scheme2: 2 } } });
  assert.equal(stale.browser.theme.user_color2, THEME_COLOR);
  // Moving the old seed keeps the scheme the user chose (light, or following the system).
  const light = profilePreferences({ extensions: { theme: { id: "user_color_theme_id" } }, browser: { theme: { user_color2: 0xff4e6498 | 0, color_scheme2: 1, follows_system_colors: true, color_variant2: 3 } } });
  assert.equal(light.browser.theme.user_color2, THEME_COLOR);
  assert.equal(light.browser.theme.color_scheme2, 1);
  assert.equal(light.browser.theme.follows_system_colors, true);
  assert.equal(light.browser.theme.color_variant2, 3);
  assert.deepEqual(light.extensions.theme, { id: "user_color_theme_id" });
});

test("the browser loads only the side panel extension", async () => {
  const { shellArgs, PANEL_DIR } = await import("../scripts/browser.mjs");
  const args = shellArgs();
  assert.ok(args.includes(`--load-extension=${PANEL_DIR}`));
  assert.ok(args.includes(`--disable-extensions-except=${PANEL_DIR}`));
});

test("a build with its own pages: no extension, no theme seed, two helper switches, never the key", async () => {
  const { launchArgs, shellArgs } = await import("../scripts/browser.mjs");
  const noExtension = (args) => !args.some((a) => /^--(load-extension|disable-extensions-except|allowlisted-extension-id)=/.test(a));
  const helperSwitches = (args) => args.filter((a) => /^--pairbrowse-helper/.test(a));
  const pages = launchArgs({}, { browserPages: true, helper: { origin: "http://127.0.0.1:4321", keyFile: "/k/helper-key-ab" } });
  assert.deepEqual(helperSwitches(pages), ["--pairbrowse-helper=http://127.0.0.1:4321", "--pairbrowse-helper-key-file=/k/helper-key-ab"]);
  assert.ok(noExtension(pages));
  // The old "<origin>#<key>" string form is never passed through: the key never rides the command line.
  assert.deepEqual(helperSwitches(launchArgs({}, { browserPages: true, helper: "http://127.0.0.1:4321#k" })), [], "a string helper: no switch");
  assert.deepEqual(helperSwitches(launchArgs({}, { browserPages: true, helper: { origin: "http://127.0.0.1:4321" } })), [], "no key file: no switch");
  const first = launchArgs({}, { browserPages: true, firstRun: true });
  assert.ok(!first.includes("--no-startup-window"), "the browser opens its own window");
  assert.deepEqual(helperSwitches(first), [], "no helper given: no switch");
  assert.deepEqual(shellArgs({ browserPages: true, firstRun: true }), process.platform === "darwin" ? ["--show-avatar-button=never"] : []);
  // Today's builds: the extension as before, never the switch.
  for (const args of [launchArgs({}), launchArgs({}, { firstRun: true }), launchArgs({}, { helper: { origin: "http://127.0.0.1:1", keyFile: "/k/f" } }), launchArgs({}, { helper: "http://127.0.0.1:1#k" })]) {
    assert.deepEqual(helperSwitches(args), []);
    assert.ok(!noExtension(args));
  }
  // The --enable-features merge and the headless notifications rule hold in this mode too.
  const merged = inHarness(() => launchArgs({ browserArgs: ["--headless=new", "--enable-features=Foo"] }, { browserPages: true, helper: { origin: "h", keyFile: "f" } }));
  const enable = merged.filter((a) => a.startsWith("--enable-features="));
  assert.equal(enable.length, 1);
  assert.ok(enable[0].includes("ForceForegroundPriorityForAllTabs") && enable[0].includes("Foo"));
  assert.ok(merged.includes("--disable-notifications"));
  assert.ok(!launchArgs({}, { browserPages: true }).includes("--disable-notifications"));
});

test("the helper key file: 0600, the key alone, a fresh name per start, swept and dropped", async () => {
  const { launchArgs, writeHelperKeyFile, dropHelperKeyFile } = await import("../scripts/browser.mjs");
  const { mkdtempSync, readFileSync, statSync, existsSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { randomBytes } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "pb-key-"));
  try {
    const key = randomBytes(32).toString("base64url");
    const p1 = writeHelperKeyFile(key, dir);
    assert.match(p1, /helper-key-[0-9a-f]{32}$/);
    assert.equal(dirname(p1), dir);
    // The key alone, no newline, no origin: patch 510's ParseHelperKey accepts exactly this.
    assert.equal(readFileSync(p1, "utf8"), key);
    assert.match(readFileSync(p1, "utf8"), /^[A-Za-z0-9_-]{1,256}$/);
    if (process.platform !== "win32") assert.equal(statSync(p1).mode & 0o777, 0o600);
    const p2 = writeHelperKeyFile(key, dir);
    assert.notEqual(p2, p1, "a fresh name per start");
    assert.ok(!existsSync(p1), "the earlier file is swept");
    assert.ok(existsSync(p2));
    for (const bad of ["a:b", "x".repeat(257)]) {
      const before = readdirSync(dir).sort();
      assert.throws(() => writeHelperKeyFile(bad, dir), (e) => !e.message.includes(bad));
      assert.deepEqual(readdirSync(dir).sort(), before, "a refused key leaves no new file");
    }
    dropHelperKeyFile(p2);
    assert.ok(!existsSync(p2));
    assert.doesNotThrow(() => dropHelperKeyFile(p2));
    assert.doesNotThrow(() => dropHelperKeyFile(null));
    const args = launchArgs({}, { browserPages: true, helper: { origin: "http://127.0.0.1:4321", keyFile: p1 } });
    assert.ok(!args.some((a) => a.includes(key)), "the key is never a launch argument");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a build with its own pages: the profile gets the docks' layout, no extension or theme settings", async () => {
  const { profilePreferences, prepareProfile } = await import("../scripts/browser.mjs");
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const given = { left: "rail", right: "open", strip: 100 };
  const out = profilePreferences({ autofill: { last_version_deduped: 1 } }, undefined, [], { browserPages: true, layout: given });
  assert.deepEqual(out.pairbrowse.layout, given);
  assert.equal(out.extensions, undefined, "no pinned button, no theme");
  assert.equal(out.browser.theme, undefined);
  assert.equal(out.ntp_footer, undefined);
  assert.equal(out.signin.allowed, false);
  assert.equal(out.profile.content_settings.enable_quiet_permission_ui.notifications, true);
  assert.equal(out.session.restore_on_startup, 5);
  assert.equal(out.autofill.last_version_deduped, 1);
  const kept = { left: "hidden", right: "rail", strip: 44 };
  assert.deepEqual(profilePreferences({ pairbrowse: { layout: kept } }, undefined, [], { browserPages: true, layout: given }).pairbrowse.layout, kept, "the browser's own layout stays");
  assert.deepEqual(profilePreferences({}, undefined, [], { browserPages: true, layout: { left: "wide" } }).pairbrowse.layout, { left: "open", right: "open", strip: 88 });
  assert.equal(profilePreferences({}).pairbrowse, undefined, "with the extension: no layout pref");
  const dir = mkdtempSync(join(tmpdir(), "pb-chrome-prof-"));
  assert.equal(prepareProfile(dir, undefined, { browserPages: true, layout: null }), true, "a new profile");
  const prefs = JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8"));
  assert.deepEqual(prefs.pairbrowse.layout, { left: "open", right: "open", strip: 88 });
  assert.equal("ack_existing_ntp_extensions" in prefs, false);
  const secureFile = join(dir, "Default", "Secure Preferences");
  const secure = JSON.stringify({ extensions: { settings: { [panelExtensionId()]: { disable_reasons: [1] } } } });
  writeFileSync(secureFile, secure);
  assert.equal(prepareProfile(dir, undefined, { browserPages: true }), false);
  assert.equal(readFileSync(secureFile, "utf8"), secure, "Secure Preferences untouched");
});

test("a disabled side panel record is dropped so the engine loads it enabled again", async () => {
  const { profileSecurePreferences } = await import("../scripts/browser.mjs");
  const id = panelExtensionId();
  const secure = { extensions: { settings: { [id]: { disable_reasons: [1] }, other: { disable_reasons: [1] } } }, protection: { macs: { extensions: { settings: { [id]: "A", other: "B" } } } } };
  assert.equal(profileSecurePreferences(secure), true);
  assert.deepEqual(Object.keys(secure.extensions.settings), ["other"], "other extensions untouched");
  assert.deepEqual(Object.keys(secure.protection.macs.extensions.settings), ["other"]);
  const enabled = { extensions: { settings: { [id]: { disable_reasons: [] } } } };
  assert.equal(profileSecurePreferences(enabled), false, "an enabled side panel is left alone");
});

test("the old theme extension is recognized wherever that copy of PairBrowse lived", async () => {
  const { profilePreferences, profileSecurePreferences } = await import("../scripts/browser.mjs");
  const pack = "/Users/x/.claude/plugins/cache/pairbrowse/pairbrowse/0.11.0/scripts/browser/theme";
  assert.deepEqual(profilePreferences({ extensions: { theme: { id: "abcdefghabcdefghabcdefghabcdefgh", pack } } }).extensions.theme, { id: "user_color_theme_id" });
  assert.deepEqual(profilePreferences({ extensions: { theme: { id: "x", pack: `${pack}/Cached Theme.pak` } } }).extensions.theme, { id: "user_color_theme_id" }, "the compiled pack file form too");
  assert.deepEqual(profilePreferences({ extensions: { theme: { id: "y", pack: "/somewhere/else/theme" } } }).extensions.theme, { id: "y", pack: "/somewhere/else/theme" }, "another theme stays");
  const secure = { extensions: { settings: { abcdefghabcdefghabcdefghabcdefgh: { path: pack }, keep: { path: "/elsewhere/ext" } } }, protection: { macs: { extensions: { settings: { abcdefghabcdefghabcdefghabcdefgh: "M", keep: "K" } } } } };
  assert.equal(profileSecurePreferences(secure), true);
  assert.deepEqual(Object.keys(secure.extensions.settings), ["keep"]);
  assert.deepEqual(Object.keys(secure.protection.macs.extensions.settings), ["keep"]);
});

test("prepareProfile writes Preferences and rewrites Secure Preferences only when needed", async () => {
  const { prepareProfile } = await import("../scripts/browser.mjs");
  const { mkdtempSync, writeFileSync, readFileSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pb-prof-"));
  prepareProfile(dir);
  assert.equal(JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8")).extensions.theme.id, "user_color_theme_id");
  const secureFile = join(dir, "Default", "Secure Preferences");
  writeFileSync(secureFile, JSON.stringify({ extensions: { settings: { [panelExtensionId()]: { disable_reasons: [] } } } }));
  const before = statSync(secureFile).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  prepareProfile(dir);
  assert.equal(statSync(secureFile).mtimeMs, before, "left alone");
  writeFileSync(secureFile, JSON.stringify({ extensions: { settings: { [panelExtensionId()]: { disable_reasons: [1] } } } }));
  prepareProfile(dir);
  assert.deepEqual(JSON.parse(readFileSync(secureFile, "utf8")).extensions.settings, {});
});

test("site notification and location requests are quiet, not denied", async () => {
  const { profilePreferences } = await import("../scripts/browser.mjs");
  const out = profilePreferences({ profile: { default_content_setting_values: { notifications: 2, geolocation: 2, cookies: 1 } } });
  assert.deepEqual(out.profile.default_content_setting_values, { cookies: 1 }, "the old block is removed, other settings stay");
  assert.deepEqual(out.profile.content_settings.enable_quiet_permission_ui, { notifications: true, geolocation: true });
  // Never quiet and predicted prompts at once (the engine's Settings page crashes on it).
  assert.deepEqual(out.profile.content_settings.enable_cpss, { notifications: false, geolocation: false });
});

test("a profile's default name says PairBrowse; a chosen name stays", async () => {
  const { localStatePreferences } = await import("../scripts/browser.mjs");
  const state = { profile: { info_cache: {
    Default: { name: "Your Chromium", is_using_default_name: true },
    "Profile 1": { name: "Work", is_using_default_name: false },
    "Profile 2": { name: "Your Chromium", is_using_default_name: false },
  } } };
  assert.equal(localStatePreferences(state), true);
  assert.equal(state.profile.browser_guest_enabled, false);
  assert.equal(state.profile.add_person_enabled, false);
  assert.equal(state.profile.info_cache.Default.name, "Your PairBrowse");
  assert.equal(state.profile.info_cache["Profile 1"].name, "Work");
  assert.equal(state.profile.info_cache["Profile 2"].name, "Your Chromium", "the user's own choice");
  assert.equal(localStatePreferences(state), false, "nothing left to change");
});

test("the engine acknowledges the side panel's fixed-id new tab page itself until it has", async () => {
  const { prepareProfile, panelExtensionId, PANEL_DIR } = await import("../scripts/browser.mjs");
  const { mkdtempSync, readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const profile = mkdtempSync(join(tmpdir(), "pb-ntp-"));
  mkdirSync(join(profile, "Default"));
  const id = panelExtensionId();
  assert.equal(id, panelExtensionId(PANEL_DIR + "/"), "keyed, not path-derived");
  writeFileSync(join(profile, "Default", "Secure Preferences"), JSON.stringify({ extensions: { settings: { [id]: { state: 1 } } } }));
  writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ ack_existing_ntp_extensions: true }));
  prepareProfile(profile);
  assert.equal(JSON.parse(readFileSync(join(profile, "Default", "Preferences"), "utf8")).ack_existing_ntp_extensions, false);
  writeFileSync(join(profile, "Default", "Secure Preferences"), JSON.stringify({ extensions: { settings: { [id]: { state: 1, ack_ntp_bubble: true } } } }));
  writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ ack_existing_ntp_extensions: true }));
  prepareProfile(profile);
  assert.equal(JSON.parse(readFileSync(join(profile, "Default", "Preferences"), "utf8")).ack_existing_ntp_extensions, true, "acknowledged: left alone");
});

test("PairBrowse, not a Google browser: no browser sign-in, default-browser check, translate, password or autofill popups", async () => {
  const { profilePreferences } = await import("../scripts/browser.mjs");
  const prefs = profilePreferences({ autofill: { last_version_deduped: 1 } });
  assert.equal(prefs.signin.allowed, false);
  assert.equal(prefs.browser.check_default_browser, false);
  assert.equal(prefs.translate.enabled, false);
  assert.equal(prefs.credentials_enable_service, false);
  assert.equal(prefs.autofill.profile_enabled, false);
  assert.equal(prefs.autofill.last_version_deduped, 1, "other settings stay");
});

test("headless test browsers send no notifications; the visible browser keeps them", async () => {
  const { launchArgs } = await import("../scripts/browser.mjs");
  // Otherwise each test run's browser starts its notification helper and macOS asks to allow it.
  assert.ok(inHarness(() => launchArgs({ browserArgs: ["--headless=new"] })).includes("--disable-notifications"));
  assert.equal(launchArgs({}).includes("--disable-notifications"), false);
  // Outside the harness a user's --headless is dropped (browser-args.mjs), so the browser stays headed
  // and keeps its notifications.
  const user = launchArgs({ browserArgs: ["--headless=new"] });
  assert.ok(!user.includes("--headless=new") && !user.includes("--disable-notifications"));
});

test("hidden tabs keep foreground priority, in one --enable-features that keeps the driver's", async () => {
  const { launchArgs } = await import("../scripts/browser.mjs");
  const args = inHarness(() => launchArgs({ browserArgs: ["--headless=new", "--enable-features=Foo,Bar"] }));
  const enable = args.filter((a) => a.startsWith("--enable-features="));
  assert.equal(enable.length, 1, "Chrome reads only one --enable-features");
  const features = enable[0].slice("--enable-features=".length).split(",");
  for (const f of ["ForceForegroundPriorityForAllTabs", "Foo", "Bar"]) assert.ok(features.includes(f), f);
  assert.ok(args.includes("--headless=new"));
  // The features the pinned driver (Patchright) enables itself (its flag comes first, so ours replaces it).
  const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
  if (!runtime || process.env.PLAYWRIGHT_LEGACY_SCREENSHOT) return;
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const bundle = readFileSync(join(runtime, "node_modules", "patchright-core", "lib", "coreBundle.js"), "utf8");
  for (const [, list] of bundle.matchAll(/"--enable-features=([A-Za-z0-9,]+)"/g)) for (const f of list.split(",")) assert.ok(features.includes(f), `Patchright's ${f}`);
});

test("a new profile starts without a window on macOS, so the side panel opens the first one", async () => {
  const { launchArgs, prepareProfile } = await import("../scripts/browser.mjs");
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const profile = mkdtempSync(join(tmpdir(), "pb-first-"));
  assert.equal(prepareProfile(profile), true, "no Secure Preferences yet: a new profile");
  writeFileSync(join(profile, "Default", "Secure Preferences"), "{}");
  assert.equal(prepareProfile(profile), false, "Chromium has run in it");
  const mac = process.platform === "darwin";
  assert.equal(launchArgs({}, { firstRun: true }).includes("--no-startup-window"), mac);
  // An existing profile keeps its startup tab: the panel's worker may not start there to open one.
  assert.ok(!launchArgs({}).includes("--no-startup-window"));
  assert.ok(!launchArgs({}, { firstRun: false }).includes("--no-startup-window"));
  // The window the panel opens instead, only when there is none.
  const background = readFileSync(new URL("../ui/background.js", import.meta.url), "utf8");
  assert.match(background, /windows\.getAll\(\)\)\.length\) await chrome\.windows\.create\(\{ url: "about:blank" \}\)/);
});

test("the side panel worker declares the build it's made from: a hash of its file with the value blanked", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { PANEL_DIR, panelBuild, panelBuildOf } = await import("../scripts/browser.mjs");
  const source = readFileSync(join(PANEL_DIR, "background.js"), "utf8");
  assert.equal(panelBuild(), panelBuildOf(source), `background.js changed: set its PB_BUILD to "${panelBuildOf(source)}"`);
  assert.notEqual(panelBuildOf(source.replace("pbNotifyJoin", "pbNotifyJoin2")), panelBuild(), "any change gives another build");
  assert.equal(panelBuild("/nonexistent"), null);
});

test("an old side panel worker: what the helper makes of the build the running worker reports", async () => {
  const { workerFreshness } = await import("../scripts/daemon/panel.mjs");
  assert.equal(workerFreshness({ running: "abc", expected: "abc" }), "current");
  assert.equal(workerFreshness({ running: null, expected: "abc" }), "stale", "an earlier version's worker reports none");
  assert.equal(workerFreshness({ running: "old", expected: "abc" }), "stale");
  assert.equal(workerFreshness({ running: undefined, expected: "abc" }), "unknown", "no answer: asked again later");
  assert.equal(workerFreshness({ running: null, expected: null }), "current", "nothing on disk to compare with");
});

test("without a side panel (a build with its own pages), a call to it fails at once", async () => {
  const { createPanel } = await import("../scripts/daemon/panel.mjs");
  const panel = createPanel({ context: async () => null, liveViewUrl: async () => "x", log: () => {}, available: () => false });
  const started = Date.now();
  await assert.rejects(panel.call(() => 1, null, 15000), /no side panel/);
  assert.ok(Date.now() - started < 200, "no retries");
});

test("before a launch, a profile's stored workers go when the side panel's build changed, once", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { panelWorkerStale, resetPanelWorker, forgetPanelBuild } = await import("../scripts/browser.mjs");
  assert.equal(panelWorkerStale({ recorded: null, build: "b", stored: true }), true, "a profile from before builds were recorded");
  assert.equal(panelWorkerStale({ recorded: "a", build: "b", stored: true }), true);
  assert.equal(panelWorkerStale({ recorded: "b", build: "b", stored: true }), false);
  assert.equal(panelWorkerStale({ recorded: null, build: "b", stored: false }), false, "a new profile has none");
  assert.equal(panelWorkerStale({ recorded: "a", build: null, stored: true }), false);
  const profile = mkdtempSync(join(tmpdir(), "pb-sw-"));
  try {
    const workers = join(profile, "Default", "Service Worker");
    const make = () => { for (const part of ["Database", "ScriptCache", "CacheStorage"]) { mkdirSync(join(workers, part), { recursive: true }); writeFileSync(join(workers, part, "x"), "1"); } };
    make();
    assert.equal(resetPanelWorker(profile, "b1"), true);
    assert.equal(existsSync(join(workers, "Database")), false);
    assert.equal(existsSync(join(workers, "ScriptCache")), false);
    assert.equal(existsSync(join(workers, "CacheStorage", "x")), true, "sites' caches stay");
    make();
    assert.equal(resetPanelWorker(profile, "b1"), false, "the same build: nothing goes");
    assert.equal(existsSync(join(workers, "Database")), true);
    assert.equal(resetPanelWorker(profile, "b2"), true, "an update");
    make();
    forgetPanelBuild(profile); // the running worker turned out old
    assert.equal(resetPanelWorker(profile, "b2"), true);
  } finally { rmSync(profile, { recursive: true, force: true }); }
});

test("the browser setting: pairbrowse, pairbrowse-open (or chromium), a path of your own, and the fallback", () => {
  const calls = { exists: 0, executable: 0 };
  const files = new Map([["/opt/brave/brave", true], ["/opt/notes.txt", false]]); // path -> executable
  const deps = (native = true) => ({
    native,
    exists: (p) => { calls.exists++; return files.has(p); },
    executable: (p) => { calls.executable++; return files.get(p) === true; },
  });
  const pick = (config, native) => browserChoice(config, deps(native));
  assert.deepEqual(pick({ browser: "pairbrowse" }), { browser: "pairbrowse", set: true, executablePath: null, problem: null });
  assert.deepEqual(pick({ browser: "pairbrowse-open" }), { browser: "pairbrowse-open", set: true, executablePath: null, problem: null });
  assert.deepEqual(pick({ browser: "chromium" }), { browser: "pairbrowse-open", set: true, executablePath: null, problem: null }, "the older name");
  assert.deepEqual(pick({ browser: "/opt/brave/brave" }), { browser: "/opt/brave/brave", set: true, executablePath: "/opt/brave/brave", problem: null });
  // A missing or non-executable path, a relative path or another word: the open build, with a line for the log.
  for (const [given, line] of [["/nowhere/chromium", "browser: /nowhere/chromium isn't an executable file; using PairBrowse as an extension instead"],
    ["/opt/notes.txt", "browser: /opt/notes.txt isn't an executable file; using PairBrowse as an extension instead"],
    ["brave", 'browser must be "pairbrowse", "pairbrowse-open" or an absolute path; using PairBrowse as an extension'],
    ["../x", 'browser must be "pairbrowse", "pairbrowse-open" or an absolute path; using PairBrowse as an extension'],
    ["Chromium", 'browser must be "pairbrowse", "pairbrowse-open" or an absolute path; using PairBrowse as an extension']]) {
    assert.deepEqual(pick({ browser: given }), { browser: "pairbrowse-open", set: true, executablePath: null, problem: line }, given);
  }
  // Unset: PairBrowse where a build is pinned, the open build elsewhere; nobody chose.
  assert.deepEqual(pick({}, true), { browser: "pairbrowse", set: false, executablePath: null, problem: null });
  assert.deepEqual(pick({ browser: null }, false), { browser: "pairbrowse-open", set: false, executablePath: null, problem: null });
  assert.deepEqual(pick({ browserEngine: "auto" }, false), { browser: "pairbrowse-open", set: false, executablePath: null, problem: null });
  // The older names map as before, and their paths aren't checked (the stubs aren't called).
  const before = { ...calls };
  assert.deepEqual(pick({ browserEngine: "pairbrowse" }, false), { browser: "pairbrowse", set: true, executablePath: null, problem: null });
  assert.deepEqual(pick({ browserEngine: "pairbrowse", executablePath: "/my/native/pairbrowse" }), { browser: "pairbrowse", set: true, executablePath: "/my/native/pairbrowse", problem: null });
  assert.deepEqual(pick({ browserEngine: "chromium" }), { browser: "pairbrowse-open", set: true, executablePath: null, problem: null });
  assert.deepEqual(pick({ browserEngine: "chromium", executablePath: "/fake/chrome" }), { browser: "/fake/chrome", set: true, executablePath: "/fake/chrome", problem: null });
  assert.deepEqual(pick({ browserEngine: "auto", executablePath: "/fake/chrome" }), { browser: "/fake/chrome", set: true, executablePath: "/fake/chrome", problem: null });
  assert.deepEqual(pick({ executablePath: "/fake/chrome" }), { browser: "/fake/chrome", set: true, executablePath: "/fake/chrome", problem: null });
  assert.deepEqual(calls, before, "legacy paths are never checked on disk");
  // "browser" wins over the older names.
  assert.equal(pick({ browser: "chromium", browserEngine: "pairbrowse", executablePath: "/fake/chrome" }).browser, "pairbrowse-open");
});

test("payment autofill stays off by default and turns on only for a savedCard profile with a real key store; the open build and a fixed key refuse it with a status line", async () => {
  const { profilePreferences, prepareProfile, launchOptions } = await import("../scripts/browser.mjs");
  const { safeStorageFor, savedCardFor, SAVED_CARD_REFUSED } = await import("../scripts/browser/safe-storage.mjs");
  const { readFileSync, mkdtempSync: mk } = await import("node:fs");
  // By default (and for every profile that doesn't ask): off, addresses and password saving too.
  for (const prefs of [profilePreferences({}), profilePreferences({ autofill: { credit_card_enabled: true } }, undefined, [], { browserPages: true })]) {
    assert.equal(prefs.autofill.credit_card_enabled, false);
    assert.equal(prefs.autofill.profile_enabled, false);
    assert.equal(prefs.credentials_enable_service, false);
  }
  // A saved card the launch honors: payment autofill on, and nothing else.
  const on = profilePreferences({}, undefined, [], { browserPages: true, savedCard: true });
  assert.equal(on.autofill.credit_card_enabled, true);
  assert.equal(on.autofill.profile_enabled, false);
  assert.equal(on.credentials_enable_service, false);
  assert.equal(on.credentials_enable_autosignin, false);
  // The launch's decision: the profile's prefs, the key store, the build.
  const key = join(mk(join(tmpdir(), "pb-card-key-")), "safe-storage-key");
  const can = { kind: "pages", ownPages: true, safeStorageKeyFile: true };
  const real = safeStorageFor({}, can, key, "linux");
  assert.equal(savedCardFor({ asked: true, native: true, storage: real, platform: "linux" }).on, true);
  for (const [why, card] of [
    ["the open build", savedCardFor({ asked: true, native: false, storage: real, platform: "linux" })],
    ["a fixed key", savedCardFor({ asked: true, native: true, storage: safeStorageFor({}, { ...can, safeStorageKeyFile: false }, key, "linux"), platform: "linux" })],
  ]) {
    assert.equal(card.on, false, why);
    assert.ok(card.line.startsWith(SAVED_CARD_REFUSED), why);
  }
  // Written into the profile folder at the launch, and off again at the next launch that doesn't honor it.
  const dir = mkdtempSync(join(tmpdir(), "pb-card-prof-"));
  prepareProfile(dir, undefined, { browserPages: true, savedCard: true });
  assert.equal(JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8")).autofill.credit_card_enabled, true);
  prepareProfile(dir, undefined, { browserPages: true });
  assert.equal(JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8")).autofill.credit_card_enabled, false);
  // The key store the preference counted on is the one the browser gets (launchOptions takes it as read).
  const given = { keyFile: key, mock: true };
  assert.ok(launchOptions({}, { shell: can, platform: "linux", storage: given }).args.includes(`--pairbrowse-safe-storage-key-file=${key}`));
});
