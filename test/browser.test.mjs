import { test } from "node:test";
import assert from "node:assert/strict";
import { panelExtensionId } from "../scripts/browser.mjs";
import { rebrandPak } from "../scripts/macos-app.mjs";

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

test("Chromium's interface text is renamed to PairBrowse, web addresses stay", () => {
  const out = rebrandPak(pak(["Quit Chromium", "See chromium.org — Chromium ❤"]));
  assert.deepEqual(read(out), ["Quit PairBrowse", "See chromium.org — PairBrowse ❤"]);
  assert.equal(out.readUInt16LE(12 + 3 * 6), 900, "aliases kept");
});

test("other pak formats are left alone", () => {
  const b = pak(["Chromium"]);
  b.writeUInt32LE(4, 0);
  assert.equal(rebrandPak(b), null);
});

test("the side panel's id comes from its manifest key like Chromium does, wherever the folder is", async () => {
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
  const copy = join(mkdtempSync(join(tmpdir(), "pb-panel-")), "0.99.0", "scripts", "browser", "panel");
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
  writeFileSync(join(profile, "Default", "Secure Preferences"), JSON.stringify({ extensions: { settings: { [old]: { path, state: 0 }, [id]: { path: "/new/scripts/browser/panel", ack_ntp_bubble: true }, keep: { path: "/elsewhere" } } },
    protection: { macs: { extensions: { settings: { [old]: "M", [id]: "N", keep: "K" } } } } }));
  writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ extensions: { pinned_extensions: [old, "keep"] } }));
  prepareProfile(profile);
  const secure = JSON.parse(readFileSync(join(profile, "Default", "Secure Preferences"), "utf8"));
  assert.deepEqual(Object.keys(secure.extensions.settings).sort(), [id, "keep"].sort());
  assert.deepEqual(Object.keys(secure.protection.macs.extensions.settings).sort(), [id, "keep"].sort());
  const prefs = JSON.parse(readFileSync(join(profile, "Default", "Preferences"), "utf8"));
  assert.deepEqual(prefs.extensions.pinned_extensions.sort(), [id, "keep"].sort());
});

test("profiles get Chromium's own navy color theme instead of the old theme extension", async () => {
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
});

test("the browser loads only the side panel extension", async () => {
  const { browserArgs, PANEL_DIR } = await import("../scripts/browser.mjs");
  const args = browserArgs();
  assert.ok(args.includes(`--load-extension=${PANEL_DIR}`));
  assert.ok(args.includes(`--disable-extensions-except=${PANEL_DIR}`));
});

test("a disabled side panel record is dropped so Chromium loads it enabled again", async () => {
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

test("Chromium acknowledges the side panel's fixed-id new tab page itself until it has", async () => {
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

test("PairBrowse, not Chrome: no Chrome sign-in, default-browser check, translate, password or autofill popups", async () => {
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
  assert.ok(launchArgs({ chromeArgs: ["--headless=new"] }).includes("--disable-notifications"));
  assert.equal(launchArgs({}).includes("--disable-notifications"), false);
});

test("hidden tabs keep foreground priority, in one --enable-features that keeps Playwright's", async () => {
  const { launchArgs } = await import("../scripts/browser.mjs");
  const args = launchArgs({ chromeArgs: ["--headless=new", "--enable-features=Foo,Bar"] });
  const enable = args.filter((a) => a.startsWith("--enable-features="));
  assert.equal(enable.length, 1, "Chrome reads only one --enable-features");
  const features = enable[0].slice("--enable-features=".length).split(",");
  for (const f of ["ForceForegroundPriorityForAllTabs", "Foo", "Bar"]) assert.ok(features.includes(f), f);
  assert.ok(args.includes("--headless=new"));
  // The features the pinned Playwright enables itself (its flag comes first, so ours replaces it).
  const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
  if (!runtime || process.env.PLAYWRIGHT_LEGACY_SCREENSHOT) return;
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const bundle = readFileSync(join(runtime, "node_modules", "playwright-core", "lib", "coreBundle.js"), "utf8");
  for (const [, list] of bundle.matchAll(/"--enable-features=([A-Za-z0-9,]+)"/g)) for (const f of list.split(",")) assert.ok(features.includes(f), `Playwright's ${f}`);
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
  const background = readFileSync(new URL("../scripts/browser/panel/background.js", import.meta.url), "utf8");
  assert.match(background, /windows\.getAll\(\)\)\.length\) await chrome\.windows\.create\(\{ url: "about:blank" \}\)/);
});
