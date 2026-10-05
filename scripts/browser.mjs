// The PairBrowse browser: a normal headed Chromium the daemon drives over a private pipe (no
// debugging port). On macOS it's a pinned ungoogled-chromium build, which has a switch to hide the
// profile button, copied once into ~/.pairbrowse/browser under the name
// PairBrowse with the PairBrowse icon. Elsewhere it's Playwright's own Chromium. It loads one
// extension of its own and no others: scripts/browser/panel (the PairBrowse side panel, which
// talks only to the key-protected live view on 127.0.0.1). Its colors come from Chromium's own
// color theme, set in the profile (profilePreferences), so there's no "Installed theme" bar.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, loadConfig } from "./paths.mjs";
import { validateBrowserDriver } from "./driver.mjs";
import { ICON, rebrandInterfaceText, registerApp } from "./macos-app.mjs";
import { downloadPinned, readJson } from "./util.mjs";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const nativeTarget = join(paths.home, "browser", "PairBrowse.app");
// Earlier versions colored the window with a theme extension in scripts/browser/theme. Profiles
// that used it get the color theme instead, wherever that copy of PairBrowse was (plugin installs
// live in versioned folders, so the path, and the extension id derived from it, change).
const OLD_THEME_DIR = join(here, "browser", "theme");
// (Chromium records the theme's folder, or its compiled pack file inside it.)
const isOldThemePath = (p) => typeof p === "string" && /[\/\\]scripts[\/\\]browser[\/\\]theme([\/\\](Cached Theme\.pak)?)?$/.test(p);
export const PANEL_DIR = join(here, "browser", "panel");

// The origin a page of the extension sends (URL.origin is "null" for chrome-extension: URLs).
export const extensionOrigin = (url) => `chrome-extension://${new URL(url).host}`;

// Chromium's extension ID scheme: SHA-256 of the input, first 32 hex digits written as a-p.
const idFrom = (data) => [...createHash("sha256").update(data).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

// The side panel's extension ID. Its manifest carries a public "key", so Chromium derives the ID
// from that key (SHA-256 of the DER public key) rather than from the folder path. Plugin installs
// live in versioned folders, and a path-derived ID changed with every update, which brought back
// the "Did you mean to change this page?" dialog (its acknowledgement is per ID).
const panelIds = new Map();
export function panelExtensionId(dir = PANEL_DIR) {
  if (!panelIds.has(dir)) {
    const key = readJson(join(dir, "manifest.json"), {}).key;
    panelIds.set(dir, key ? idFrom(Buffer.from(key, "base64")) : idFrom(dir));
  }
  return panelIds.get(dir);
}

// Earlier versions' side panel had no key, so its ID came from its folder path.
const pathPanelId = (dir = PANEL_DIR) => idFrom(dir);
// (Any copy of PairBrowse: Chromium records an unpacked extension's folder as its path.)
const isPanelPath = (p) => typeof p === "string" && /[\/\\]scripts[\/\\]browser[\/\\]panel[\/\\]?$/.test(p);
// The IDs of earlier side panel copies recorded in a profile's Secure Preferences (parsed).
export const oldPanelIds = (secure, panelId = panelExtensionId()) => Object.entries(secure?.extensions?.settings || {})
  .filter(([id, entry]) => id !== panelId && (id === pathPanelId() || isPanelPath(entry?.path))).map(([id]) => id);

// The ungoogled-chromium build PairBrowse uses on macOS. Pinned: a new version is a deliberate
// change here, with the SHA-256 from its GitHub release. Builds are notarized by the project.
export const UNGOOGLED = {
  version: "154.0.8037.57-1.1",
  arm64: { file: "ungoogled-chromium_154.0.8037.57-1.1_arm64-macos.dmg", sha256: "20b9b3104032c2011c89c8356fd94169565f3c9880ae281119ea189634a85e00" },
  x64: { file: "ungoogled-chromium_154.0.8037.57-1.1_x86_64-macos.dmg", sha256: "58ee9436dcbc457fe6634bbc247ad03e0d1609ed5ce9954106ddce89944eb2ff" },
};

// Chromium flags for the PairBrowse browser: load its side panel, and nothing else. On
// macOS (ungoogled-chromium) also hide the profile button. The side panel opens from its pinned
// toolbar button or with Cmd+Shift+Y.
// firstRun (a new profile, on macOS): the browser starts with no window and the side panel opens
// the first one (background.js). Chromium acknowledges new tab page extensions at the first tab
// shown in a profile, and a startup tab comes before the panel is loaded, so new users would get
// "Did you mean to change this page?". Only for new profiles: there the panel's worker always
// starts (its install); in an existing one it may not, and the launch would wait for a window.
export const browserArgs = ({ firstRun = false } = {}) => [
  `--disable-extensions-except=${PANEL_DIR}`, `--load-extension=${PANEL_DIR}`,
  ...(process.platform === "darwin" ? ["--show-avatar-button=never", ...(firstRun ? ["--no-startup-window"] : [])] : []),
];

// The PairBrowse colors: Chromium's built-in color theme (Settings > Appearance), navy from the
// PairBrowse logo, dark, tonal. Keys from Chromium 150 chrome/common/pref_names.h; the color is an
// SkColor (ARGB) stored as a signed 32-bit integer.
export const THEME_COLOR = 0xff4e6498 | 0;
const USER_COLOR_THEME_ID = "user_color_theme_id";

// The profile settings PairBrowse needs, applied to a profile's Default/Preferences (parsed).
// Run before every launch and by the install step; keeps everything else the user set.
export function profilePreferences(prefs = {}, panelId = panelExtensionId(), oldPanels = []) {
  // Chrome starts on a blank tab (its own restore would reload every tab during startup);
  // PairBrowse then brings the tabs back itself, one by one (see tabs.mjs).
  prefs.session = { ...(prefs.session || {}), restore_on_startup: 5 };
  // The PairBrowse side panel's button stays pinned in the toolbar.
  // Earlier copies' buttons go (their path-derived IDs).
  const pinned = new Set(prefs.extensions?.pinned_extensions || []);
  for (const id of [pathPanelId(), ...oldPanels]) if (id !== panelId) pinned.delete(id);
  pinned.add(panelId);
  // Keyboard shortcuts: drop the side panel's old one (it went through the hidden toolbar button)
  // so its own "open-panel" command can take the same keys.
  const commands = Object.fromEntries(Object.entries(prefs.extensions?.commands || {}).filter(([, c]) => !(c.extension === panelId && c.command_name === "_execute_action")));
  prefs.extensions = { ...(prefs.extensions || {}), pinned_extensions: [...pinned].filter((id) => id !== panelExtensionId(OLD_THEME_DIR)), commands };
  // The color theme, unless the user picked another one (a theme, or Default: id ""). The old
  // theme extension's entry goes: Chromium would keep drawing its saved theme pack.
  const theme = prefs.extensions.theme;
  if (!theme || theme.id === undefined || theme.id === panelExtensionId(OLD_THEME_DIR) || isOldThemePath(theme.pack)) {
    prefs.extensions.theme = { id: USER_COLOR_THEME_ID };
    const browserTheme = { ...(prefs.browser?.theme || {}), user_color2: THEME_COLOR, color_variant2: 1, color_scheme2: 2, follows_system_colors: false };
    prefs.browser = { ...(prefs.browser || {}), theme: browserTheme };
    prefs.syncing_theme_prefs_migrated_to_non_syncing = true; // don't copy older synced colors over it
  }
  // Notification and location requests never pop up: Chromium's quiet prompts show them only as
  // an icon in the address bar. Sites see the normal "ask" state, as in an everyday Chrome
  // (a flat "denied" is a known automation tell); earlier versions blocked both outright.
  const defaults = { ...(prefs.profile?.default_content_setting_values || {}) };
  for (const k of ["notifications", "geolocation"]) if (defaults[k] === 2) delete defaults[k];
  const contentSettings = prefs.profile?.content_settings || {};
  prefs.profile = { ...(prefs.profile || {}), default_content_setting_values: defaults,
    content_settings: { ...contentSettings, enable_quiet_permission_ui: { ...(contentSettings.enable_quiet_permission_ui || {}), notifications: true, geolocation: true } } };
  // No Energy Saver (its popup and leaf icon); PairBrowse needs full rendering for the live view.
  prefs.performance_tuning = { ...(prefs.performance_tuning || {}), battery_saver_mode: { ...(prefs.performance_tuning?.battery_saver_mode || {}), state: 0 } };
  // No footer under the PairBrowse new tab page (the extension link and "Customize" button).
  prefs.ntp_footer = { ...(prefs.ntp_footer || {}), settings: { ...(prefs.ntp_footer?.settings || {}), extension_attribution: false, management_notice: false } };
  // PairBrowse, not Chrome: no Chrome sign-in or sync (signing into Google on websites works as on
  // any site), no default-browser check, no translate bubble, and no password or autofill popups
  // over forms (PairBrowse fills forms itself and keeps passwords in its own secrets file).
  prefs.signin = { ...(prefs.signin || {}), allowed: false };
  prefs.browser = { ...(prefs.browser || {}), check_default_browser: false };
  prefs.translate = { ...(prefs.translate || {}), enabled: false };
  prefs.credentials_enable_service = false;
  prefs.credentials_enable_autosignin = false;
  prefs.autofill = { ...(prefs.autofill || {}), profile_enabled: false, credit_card_enabled: false };
  return prefs;
}

// The extension records PairBrowse needs fixed in a profile's Default/Secure Preferences (parsed).
// Chromium keeps a command-line extension's disabled state across launches, and a disabled side
// panel has no worker (no live view address, no notifications) and no toolbar button. Its record,
// and the old theme extension's, are removed with their MACs: Chromium then loads the side panel
// as a fresh install, enabled. Returns true when something changed (only then is the file written,
// since Chromium re-signs the file afterwards).
export function profileSecurePreferences(secure, panelId = panelExtensionId()) {
  const settings = secure?.extensions?.settings;
  if (!settings) return false;
  const macs = secure.protection?.macs?.extensions?.settings || {};
  const old = oldPanelIds(secure, panelId);
  let changed = false;
  for (const [id, entry] of Object.entries(settings)) {
    const disabled = entry?.state === 0 || (Array.isArray(entry?.disable_reasons) && entry.disable_reasons.length > 0);
    // Old path-derived side panel records would linger as duplicate, disabled extensions.
    if ((id === panelId && disabled) || old.includes(id) || id === panelExtensionId(OLD_THEME_DIR) || isOldThemePath(entry?.path)) {
      delete settings[id];
      delete macs[id];
      changed = true;
    }
  }
  return changed;
}

// The side panel provides the new tab page, so Chromium (on macOS) would ask "Did you mean to change
// this page?" until the panel is acknowledged. The acknowledgement sits in the sealed Secure
// Preferences, which only Chromium may write; but once per profile Chromium acknowledges every
// extension already providing the new tab page, tracked by this plain preference. Clearing it
// while the panel isn't acknowledged has Chromium do that before it would show the dialog.
function acknowledgeNewTabPage(prefs, secure, panelId) {
  if (secure?.extensions?.settings?.[panelId]?.ack_ntp_bubble === true) return prefs;
  return { ...prefs, ack_existing_ntp_extensions: false };
}

// Browser-wide settings in Local State. PairBrowse has its own sessions, so no guest or added Chrome
// profiles. And Chromium stores a profile's default name ("Your Chromium") when it creates the
// profile and never updates it: a default name becomes "Your PairBrowse"; a name the user chose stays.
export function localStatePreferences(state) {
  let changed = false;
  const profile = (state.profile ||= {});
  for (const key of ["browser_guest_enabled", "add_person_enabled"]) if (profile[key] !== false) { profile[key] = false; changed = true; }
  for (const entry of Object.values(state?.profile?.info_cache || {})) {
    if (entry?.is_using_default_name && /^Your (Chromium|Chrome)$/.test(entry.name)) { entry.name = "Your PairBrowse"; changed = true; }
  }
  return changed;
}

// Writes the settings above into a profile folder (before a launch, and when installing).
// Returns true for a new profile (Chromium hasn't run in it yet): launchArgs' firstRun.
export function prepareProfile(profile, panelId = panelExtensionId()) {
  const dir = join(profile, "Default");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "Preferences");
  const secureFile = join(dir, "Secure Preferences");
  const firstRun = !existsSync(secureFile);
  const prefs = readJson(file, {});
  const secure = readJson(secureFile, null);
  const oldPanels = oldPanelIds(secure, panelId);
  if (secure && profileSecurePreferences(secure, panelId)) writeFileSync(secureFile, JSON.stringify(secure));
  writeFileSync(file, JSON.stringify(acknowledgeNewTabPage(profilePreferences(prefs, panelId, oldPanels), secure, panelId)));
  const localStateFile = join(profile, "Local State");
  const localState = readJson(localStateFile, null);
  if (localState && localStatePreferences(localState)) writeFileSync(localStateFile, JSON.stringify(localState));
  return firstRun;
}

// Agents work in tabs nobody is looking at. macOS still runs a hidden tab's renderer (and the
// side panel's worker) at background priority despite --disable-renderer-backgrounding, and on a
// busy computer it then answers nothing for a minute or more: every tool call that reads that
// tab hangs. Chrome reads only one --enable-features, so Playwright's own goes in it too.
const FEATURES = ["ForceForegroundPriorityForAllTabs", ...(process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? [] : ["CDPScreenshotNewSurface"])];
const ENABLE = "--enable-features=";

// Every flag the daemon launches the PairBrowse browser with (the install self-check uses the same).
export function launchArgs(config = {}, { firstRun = false } = {}) {
  const extra = config.chromeArgs || [];
  const features = [...FEATURES, ...extra.filter((a) => a.startsWith(ENABLE)).flatMap((a) => a.slice(ENABLE.length).split(","))];
  return [
    "--window-size=1366,900", "--hide-crash-restore-bubble",
    // Playwright runs Chrome without its sandbox (--no-sandbox); this hides Chrome's
    // "unsupported command-line flag" bar about it.
    "--test-type",
    // Keep rendering when the window is behind other windows, so the live view stays live.
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    // Shared browser mode: PairBrowse's own extension (and no other, nor any page) may capture a
    // tab for the people the user let in, without the user clicking the extension first.
    `--allowlisted-extension-id=${panelExtensionId()}`,
    ENABLE + [...new Set(features.filter(Boolean))].join(","),
    ...browserArgs({ firstRun }),
    // Only test runs are headless, and nobody is there to see a notification: without this the
    // first one starts the test browser's notification helper and macOS asks to allow it.
    ...(extra.some((a) => a.startsWith("--headless")) ? ["--disable-notifications"] : []),
    ...extra.filter((a) => !a.startsWith(ENABLE)),
  ];
}

// The page script (scripts/hud.js: bottom bar, badge, cursor, tab spark, your-activity recorder)
// with fresh random names: the window function it answers on, the key it needs, and the names
// of its three page elements. New ones each time the helper starts, so no fixed name gives
// PairBrowse away to a page (and a page can't drive the badge).
const randomLetters = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + randomInt(26))).join("");
export function hudScript() {
  const name = randomLetters(1) + randomBytes(6).toString("hex");
  const token = randomBytes(24).toString("hex");
  const tags = { hud: "", bar: "", cursor: "" };
  const used = new Set();
  for (const k of Object.keys(tags)) {
    let tag;
    do tag = `${randomLetters(4 + (randomBytes(1)[0] % 4))}-${randomLetters(3 + (randomBytes(1)[0] % 4))}`; while (used.has(tag));
    used.add(tag);
    tags[k] = tag;
  }
  const source = readFileSync(join(here, "hud.js"), "utf8").replaceAll("__PB_NAME__", name).replaceAll("__PB_TOKEN__", token)
    .replaceAll("__PB_TAG_HUD__", tags.hud).replaceAll("__PB_TAG_BAR__", tags.bar).replaceAll("__PB_TAG_CURSOR__", tags.cursor);
  if (source.includes("__PB_")) throw new Error("pairbrowse: page script placeholders not replaced");
  return { source, name, token, tags };
}

// The pinned ungoogled-chromium app: downloaded once, checked against its SHA-256 and its
// notarization, then copied out of the disk image.
async function ungoogledApp(log) {
  const dir = join(paths.home, "browser", `ungoogled-${UNGOOGLED.version}`);
  const app = join(dir, "Chromium.app");
  if (existsSync(join(app, "Contents", "Info.plist"))) return app;
  const asset = UNGOOGLED[process.arch === "arm64" ? "arm64" : "x64"];
  const dmg = join(paths.home, "downloads", asset.file);
  if (!existsSync(dmg)) log(`downloading ungoogled-chromium ${UNGOOGLED.version} (about 150 MB, once)`);
  await downloadPinned(`https://github.com/ungoogled-software/ungoogled-chromium-macos/releases/download/${UNGOOGLED.version}/${asset.file}`, dmg, asset.sha256);
  const { stdout } = await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", dmg]);
  const mount = stdout.trim().split("\n").at(-1).split("\t").at(-1).trim();
  try {
    await run("spctl", ["-a", "-t", "install", join(mount, "Chromium.app")]); // notarized, or this throws
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await run("cp", ["-R", join(mount, "Chromium.app"), app]);
  } finally {
    await run("hdiutil", ["detach", mount, "-quiet"]).catch(() => {});
  }
  rmSync(dmg, { force: true }); // copied out: the disk image isn't needed any more
  return app;
}

// The installer of the browser driver PairBrowse runs with (config browserDriver).
export const driverCli = () => join(paths.runtime, "node_modules", validateBrowserDriver(loadConfig()), "cli.js");

// Path of the browser to launch: on macOS the branded copy of ungoogled-chromium (built first when
// it's missing or out of date), elsewhere Playwright's Chromium (downloaded once if missing).
// chromium: Playwright's chromium launcher (from the pinned runtime). log: progress messages.
export async function ensureBrowser(chromium, log = () => {}) {
  if (process.platform !== "darwin") {
    if (!existsSync(chromium.executablePath())) {
      log("downloading Chromium for the PairBrowse browser (about 100 MB, once)");
      // The driver in use installs its own build: patchright and Playwright pin different ones.
      await run(process.execPath, [driverCli(), "install", "chromium"], { timeout: 600_000 });
      if (!existsSync(chromium.executablePath())) throw new Error(`Chromium didn't install at ${chromium.executablePath()}. Run: node ${driverCli()} install --with-deps chromium`);
    }
    return chromium.executablePath();
  }
  const sourceApp = await ungoogledApp(log);
  // The native PairBrowse build (scripts/native-install.mjs) lives at the usual place; this one
  // then goes next to it, so switching browserEngine back never overwrites the native app.
  const target = existsSync(join(nativeTarget, "Contents", "Resources", "PairBrowse-build.json")) ? join(dirname(nativeTarget), "PairBrowse Chromium.app") : nativeTarget;
  const exec = join(target, "Contents", "MacOS", "pairbrowse");
  const stamp = createHash("sha256").update(`branding v6 ${sourceApp} ${target}` + readFileSync(ICON).toString("base64")).digest("hex");
  const stampFile = join(paths.home, "browser", "build.sha256");
  if (existsSync(exec) && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) return exec;

  log("building the PairBrowse browser");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  await run("cp", ["-Rc", sourceApp, target]); // a clone on APFS: instant, no extra disk
  const plist = join(target, "Contents", "Info.plist");
  for (const [k, v] of [["CFBundleName", "PairBrowse"], ["CFBundleDisplayName", "PairBrowse"], ["CFBundleIdentifier", "dev.pairbrowse.browser"], ["CFBundleExecutable", "pairbrowse"]]) {
    await run("plutil", ["-replace", k, "-string", v, plist]);
  }
  // The program itself is named PairBrowse too (Activity Monitor, some macOS prompts). The
  // framework and helper file names stay: Chromium has those paths built in.
  await run("mv", [join(target, "Contents", "MacOS", "Chromium"), exec]);
  await run("/usr/libexec/PlistBuddy", ["-c", "Delete :CFBundleIconName", plist]).catch(() => {}); // use the .icns, not the asset catalog
  copyFileSync(ICON, join(target, "Contents", "Resources", "app.icns"));
  // The notification helpers: macOS shows their name and icon for notifications. Chromium finds
  // them by the main app's bundle ID plus ".framework.AlertNotificationService".
  const helpers = join(target, "Contents", "Frameworks", "Chromium Framework.framework", "Versions", "Current", "Helpers");
  for (const helper of ["Chromium Helper (Alerts).app", "Chromium Helper (Aperitif Alerts).app"]) {
    const hp = join(helpers, helper, "Contents", "Info.plist");
    if (!existsSync(hp)) continue;
    for (const [k, v] of [["CFBundleName", "PairBrowse"], ["CFBundleDisplayName", "PairBrowse"], ["CFBundleIdentifier", "dev.pairbrowse.browser.framework.AlertNotificationService"]]) {
      await run("plutil", ["-replace", k, "-string", v, hp]);
    }
    await run("plutil", ["-remove", "CFBundleIconName", hp]).catch(() => {});
    copyFileSync(ICON, join(helpers, helper, "Contents", "Resources", "app.icns"));
    // An English name as well: with only "base", macOS falls back to "Chromium" in its prompts.
    const en = join(helpers, helper, "Contents", "Resources", "en.lproj");
    mkdirSync(en, { recursive: true });
    writeFileSync(join(en, "InfoPlist.strings"), '"CFBundleDisplayName" = "PairBrowse";\n"CFBundleName" = "PairBrowse";\n');
  }
  // Localized names ("Chromium" in every language folder).
  const { stdout: strings } = await run("find", [target, "-name", "InfoPlist.strings"], { maxBuffer: 4 << 20 });
  for (const f of strings.trim().split("\n").filter(Boolean)) {
    for (const k of ["CFBundleDisplayName", "CFBundleName"]) await run("plutil", ["-replace", k, "-string", "PairBrowse", f]).catch(() => {});
  }
  await rebrandInterfaceText(target);
  await run("xattr", ["-cr", target]); // Finder info from the disk image blocks signing
  // The changed bundles need fresh (ad-hoc) signatures, nested helpers first (--deep).
  await run("codesign", ["--force", "--deep", "--sign", "-", target], { timeout: 300_000 });
  await registerApp(target);
  writeFileSync(stampFile, stamp);
  return exec;
}
