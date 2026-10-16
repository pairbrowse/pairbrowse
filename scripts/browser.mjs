// The PairBrowse browser: a normal headed Chromium the daemon drives over a private pipe (no
// debugging port). On macOS it's a pinned ungoogled-chromium build, which has a switch to hide the
// profile button, copied once into ~/.pairbrowse/browser under the name
// PairBrowse with the PairBrowse icon. Elsewhere it's Playwright's own Chromium; where a native
// PairBrowse build is pinned (macOS, Linux), that build is the default (browser/choice.mjs). It loads one
// extension of its own and no others: ui/ (the PairBrowse side panel and pages, which
// talks only to the key-protected live view on 127.0.0.1). Its colors come from Chromium's own
// color theme, set in the profile (profilePreferences), so there's no "Installed theme" bar.
// A native build that declares its own pages (chrome://pairbrowse, its manifest's `chrome` field)
// loads no extension: those pages take the side panel's place, with the live view's address in
// --pairbrowse-helper and their key in an owner-only file named by --pairbrowse-helper-key-file
// (never on the command line), and the build draws its own colors.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, chmodSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, loadConfig } from "./paths.mjs";
import { launchableChromeArgs, switchName } from "./chrome-args.mjs";
import { validateBrowserDriver, patchrightNodeMinimum } from "./driver.mjs";
import { createMotion } from "./motion.mjs";
import { hudSource } from "./hud/assemble.mjs";
import { ICON, rebrandInterfaceText, registerApp } from "./native/macos-app.mjs";
import { downloadPinned, readJson, writeJsonAtomic, sha256 } from "./util.mjs";
import { withInstallLock } from "./install-lock.mjs";
import { layoutFrom } from "./liveview/layout.mjs";
import { AGENT_COLOR } from "../ui/vocab.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const nativeTarget = paths.nativeApp;
// Earlier versions colored the window with a theme extension in scripts/browser/theme. Profiles
// that used it get the color theme instead, wherever that copy of PairBrowse was (plugin installs
// live in versioned folders, so the path, and the extension id derived from it, change).
const OLD_THEME_DIR = join(here, "browser", "theme");
// (Chromium records the theme's folder, or its compiled pack file inside it.)
const isOldThemePath = (p) => typeof p === "string" && /[/\\]scripts[/\\]browser[/\\]theme([/\\](Cached Theme\.pak)?)?$/.test(p);
export const PANEL_DIR = join(here, "..", "ui");

// The origin a page of the extension sends (URL.origin is "null" for chrome-extension: URLs): ui/urls.js.
export { extensionOrigin } from "../ui/urls.js";

// Chromium's extension ID scheme: SHA-256 of the input, first 32 hex digits written as a-p.
const idFrom = (data) => [...sha256(data).slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

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

// The side panel worker's build. Chromium keeps an extension's service worker script in the
// profile (its "Service Worker" folder) and goes on running that copy after the file on disk
// changed (an update), whatever the manifest's version or path; neither chrome.runtime.reload
// (it leaves a command-line extension disabled) nor the browser's own update calls replace it.
// So the worker reports the build it was made from (PB_BUILD in background.js; the helper checks
// it, daemon/panel.mjs), and before a launch whose build differs from the profile's last one the
// stored worker registrations go (resetPanelWorker). The value is a hash of background.js with
// the value itself blanked (test/browser.test.mjs keeps it true).
const BUILD_LINE = /(const PB_BUILD = ")([0-9a-f]*)(";)/;
export const panelBuildOf = (source) => sha256(String(source).replace(BUILD_LINE, "$1$3")).slice(0, 16);
// The build the file on disk declares (null: none, an earlier version's file).
export const panelBuild = (dir = PANEL_DIR) => {
  try { return readFileSync(join(dir, "background.js"), "utf8").match(BUILD_LINE)?.[2] || null; } catch { return null; }
};
const PANEL_BUILD_FILE = "PairBrowse panel build"; // in the profile folder: the build it last ran
// Whether a profile's stored worker must go: it has stored workers (stored) and its last build
// (recorded: null if none, as in profiles from before builds were recorded) isn't this one.
export const panelWorkerStale = ({ recorded, build, stored }) => !!stored && !!build && recorded !== build;
// Before a launch (the browser not running in this profile): drops the stored service worker
// registrations if the side panel's build changed, so the browser registers its worker from disk.
// Sites' registrations go too (they register again on the next visit); their caches stay
// (CacheStorage). Returns true if it dropped them.
export function resetPanelWorker(profile, build = panelBuild()) {
  const marker = join(profile, PANEL_BUILD_FILE);
  const workers = join(profile, "Default", "Service Worker");
  let recorded = null;
  try { recorded = readFileSync(marker, "utf8").trim(); } catch {}
  if (!build || recorded === build) return false;
  const stale = panelWorkerStale({ recorded, build, stored: existsSync(join(workers, "Database")) || existsSync(join(workers, "ScriptCache")) });
  if (stale) for (const part of ["Database", "ScriptCache"]) rmSync(join(workers, part), { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  writeFileSync(marker, build);
  return stale;
}
// The running worker turned out old (daemon/panel.mjs): the next launch drops it.
export const forgetPanelBuild = (profile) => rmSync(join(profile, PANEL_BUILD_FILE), { force: true });

// Earlier versions' side panel had no key, so its ID came from its folder path: the folder
// earlier versions loaded the keyless panel from (a checkout updated in place keeps that path).
const pathPanelId = (dir = join(here, "browser", "panel")) => idFrom(dir);
// (Any copy of PairBrowse: Chromium records an unpacked extension's folder as its path.)
const isPanelPath = (p) => typeof p === "string" && /[/\\]scripts[/\\]browser[/\\]panel[/\\]?$/.test(p);
// The IDs of earlier side panel copies recorded in a profile's Secure Preferences (parsed).
export const oldPanelIds = (secure, panelId = panelExtensionId()) => Object.entries(secure?.extensions?.settings || {})
  .filter(([id, entry]) => id !== panelId && (id === pathPanelId() || isPanelPath(entry?.path))).map(([id]) => id);

// Which browser PairBrowse runs (config "browser") and its older names: browser/choice.mjs, the one
// place they are read.
export { browserChoice } from "./browser/choice.mjs";

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
// chromePages (a build with its own pages): no extension, and the browser opens its own window.
export const browserArgs = ({ firstRun = false, chromePages = false } = {}) => (chromePages
  ? (process.platform === "darwin" ? ["--show-avatar-button=never"] : [])
  : [
    `--disable-extensions-except=${PANEL_DIR}`, `--load-extension=${PANEL_DIR}`,
    ...(process.platform === "darwin" ? ["--show-avatar-button=never", ...(firstRun ? ["--no-startup-window"] : [])] : []),
  ]);

// The PairBrowse colors: Chromium's built-in color theme (Settings > Appearance), the sheet's
// chrome navy (ui/tokens.css --chrome), dark, tonal: Chromium's tonal palette
// takes the hue. Keys from Chromium 150 chrome/common/pref_names.h; the color is an SkColor (ARGB)
// stored as a signed 32-bit integer.
export const THEME_COLOR = 0xff101d2d | 0;
// The seed PairBrowse set before 0.15.43: a profile still on it (never a color the user picked)
// moves to the sheet's navy at the next start.
const OLD_THEME_COLOR = 0xff4e6498 | 0;
const USER_COLOR_THEME_ID = "user_color_theme_id";

// The side panel extension's settings (pinned button, its shortcut) and the color theme: only
// with the extension (a build with its own pages has neither).
function extensionPreferences(prefs, panelId, oldPanels) {
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
  const ownOldSeed = theme?.id === USER_COLOR_THEME_ID && prefs.browser?.theme?.user_color2 === OLD_THEME_COLOR;
  if (ownOldSeed) {
    // Only the seed moves: the scheme (light, dark or the system's) the user chose stays.
    prefs.browser = { ...prefs.browser, theme: { ...prefs.browser.theme, user_color2: THEME_COLOR } };
  } else if (!theme || theme.id === undefined || theme.id === panelExtensionId(OLD_THEME_DIR) || isOldThemePath(theme.pack)) {
    prefs.extensions.theme = { id: USER_COLOR_THEME_ID };
    const browserTheme = { ...(prefs.browser?.theme || {}), user_color2: THEME_COLOR, color_variant2: 1, color_scheme2: 2, follows_system_colors: false };
    prefs.browser = { ...(prefs.browser || {}), theme: browserTheme };
    prefs.syncing_theme_prefs_migrated_to_non_syncing = true; // don't copy older synced colors over it
  }
}

// The profile settings PairBrowse needs, applied to a profile's Default/Preferences (parsed).
// Run before every launch and by the install step; keeps everything else the user set.
// chromePages (a build with its own pages): no extension or theme settings; the docks' layout
// starts from config.layout (layout) the first time, and the browser keeps its own after that.
export function profilePreferences(prefs = {}, panelId = panelExtensionId(), oldPanels = [], { chromePages = false, layout = null } = {}) {
  // Chrome starts on a blank tab (its own restore would reload every tab during startup);
  // PairBrowse then brings the tabs back itself, one by one (see tabs.mjs).
  prefs.session = { ...(prefs.session || {}), restore_on_startup: 5 };
  if (chromePages) prefs.pairbrowse = { ...(prefs.pairbrowse || {}), layout: prefs.pairbrowse?.layout ?? layoutFrom(layout) };
  else extensionPreferences(prefs, panelId, oldPanels);
  // Notification and location requests never pop up: Chromium's quiet prompts show them only as
  // an icon in the address bar. Sites see the normal "ask" state, as in an everyday Chrome
  // (a flat "denied" is a known automation tell); earlier versions blocked both outright.
  const defaults = { ...(prefs.profile?.default_content_setting_values || {}) };
  for (const k of ["notifications", "geolocation"]) if (defaults[k] === 2) delete defaults[k];
  const contentSettings = prefs.profile?.content_settings || {};
  prefs.profile = { ...(prefs.profile || {}), default_content_setting_values: defaults,
    content_settings: { ...contentSettings, enable_quiet_permission_ui: { ...(contentSettings.enable_quiet_permission_ui || {}), notifications: true, geolocation: true },
      // Quiet prompts and Chrome's predicted prompts (CPSS, on by default) are one choice: both on
      // at once is a state Chromium's own settings page refuses (it crashed opening Settings).
      enable_cpss: { ...(contentSettings.enable_cpss || {}), notifications: false, geolocation: false } } };
  // No Energy Saver (its popup and leaf icon); PairBrowse needs full rendering for the live view.
  prefs.performance_tuning = { ...(prefs.performance_tuning || {}), battery_saver_mode: { ...(prefs.performance_tuning?.battery_saver_mode || {}), state: 0 } };
  // No footer under the PairBrowse new tab page (the extension link and "Customize" button).
  if (!chromePages) prefs.ntp_footer = { ...(prefs.ntp_footer || {}), settings: { ...(prefs.ntp_footer?.settings || {}), extension_attribution: false, management_notice: false } };
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
// chromePages, layout: as profilePreferences (no extension records then: Secure Preferences and the
// new tab acknowledgement are left alone).
export function prepareProfile(profile, panelId = panelExtensionId(), { chromePages = false, layout = null } = {}) {
  const dir = join(profile, "Default");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "Preferences");
  const secureFile = join(dir, "Secure Preferences");
  const firstRun = !existsSync(secureFile);
  const prefs = readJson(file, {});
  const secure = readJson(secureFile, null);
  const oldPanels = oldPanelIds(secure, panelId);
  if (chromePages) writeJsonAtomic(file, profilePreferences(prefs, panelId, oldPanels, { chromePages, layout }), { indent: 0 });
  else {
    if (secure && profileSecurePreferences(secure, panelId)) writeJsonAtomic(secureFile, secure, { indent: 0 });
    writeJsonAtomic(file, acknowledgeNewTabPage(profilePreferences(prefs, panelId, oldPanels), secure, panelId), { indent: 0 });
  }
  const localStateFile = join(profile, "Local State");
  const localState = readJson(localStateFile, null);
  if (localState && localStatePreferences(localState)) writeJsonAtomic(localStateFile, localState, { indent: 0 });
  return firstRun;
}

// Agents work in tabs nobody is looking at. macOS still runs a hidden tab's renderer (and the
// side panel's worker) at background priority despite --disable-renderer-backgrounding, and on a
// busy computer it then answers nothing for a minute or more: every tool call that reads that
// tab hangs. Chrome reads only one --enable-features, so Playwright's own goes in it too.
const FEATURES = ["ForceForegroundPriorityForAllTabs", ...(process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? [] : ["CDPScreenshotNewSurface"])];
const ENABLE = "--enable-features=";

const helperGiven = (h) => !!h && typeof h === "object" && typeof h.origin === "string" && !!h.origin && typeof h.keyFile === "string" && !!h.keyFile;

// The pages' key reaches a build with its own pages through a file, never the command line (where
// ps, /proc/<pid>/cmdline, chrome://version and crash dumps would show it): the key alone, in a
// file only this account can read, under ~/.pairbrowse/run with a fresh name at each browser start.
// The browser (patch 510's ParseHelperKey) takes only 1-256 characters of [A-Za-z0-9_-] and refuses
// a file group or others could read. The daemon deletes it once used, and with its browser.
export const HELPER_KEY_PREFIX = "helper-key-";
// The capture page's own key (a build whose capture page reads one) goes the same way, in a file
// of its own (CAPTURE_KEY_PREFIX) that --pairbrowse-capture-key-file names.
export const CAPTURE_KEY_PREFIX = "capture-key-";
export function writeHelperKeyFile(key, dir = paths.run, prefix = HELPER_KEY_PREFIX) {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(key)) throw new Error("the helper key has a form the browser refuses");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // One helper per home, and the previous browser is closed when a launch starts: anything left
  // is from a helper that was killed.
  for (const f of readdirSync(dir)) if (f.startsWith(prefix)) rmSync(join(dir, f), { force: true });
  const path = join(dir, prefix + randomBytes(16).toString("hex"));
  writeFileSync(path, key, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") chmodSync(path, 0o600); // a umask can strip owner bits
  return path;
}
export function dropHelperKeyFile(path) {
  if (!path) return;
  try { rmSync(path, { force: true }); } catch { /* gone or unreachable: nothing to do */ }
}

// Every flag the daemon launches the PairBrowse browser with (the install self-check uses the same).
// chromePages (a build with its own pages): no extension switches; helper ({ origin, keyFile }):
// the live view's address goes in --pairbrowse-helper and the path of the owner-only file holding
// the pages' key in --pairbrowse-helper-key-file. The key itself is never on the command line.
export function launchArgs(config = {}, { firstRun = false, chromePages = false, helper = null } = {}) {
  // The user's chromeArgs, screened (chrome-args.mjs): no debugging surface, no other profile or
  // extension, no web security off; --no-sandbox goes through sandboxDecision instead.
  const extra = launchableChromeArgs(config.chromeArgs || []);
  // Any spelling of --enable-features ("-enable-features=..." too) joins the one merged switch.
  const isEnable = (a) => switchName(a) === "enable-features";
  const features = [...FEATURES, ...extra.filter(isEnable).flatMap((a) => a.slice(a.indexOf("=") + 1).split(","))];
  return [
    "--window-size=1366,900", "--hide-crash-restore-bubble",
    // Hides Chrome's "unsupported command-line flag" bar (about --no-sandbox where the sandbox is
    // off, see sandboxDecision in engine.mjs, and the other launch flags).
    "--test-type",
    // Keep rendering when the window is behind other windows, so the live view stays live.
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
    // Shared browser mode: PairBrowse's own extension (and no other, nor any page) may capture a
    // tab for the people the user let in, without the user clicking the extension first.
    ...(chromePages ? [] : [`--allowlisted-extension-id=${panelExtensionId()}`]),
    ENABLE + [...new Set(features.filter(Boolean))].join(","),
    ...browserArgs({ firstRun, chromePages }),
    ...(chromePages && helperGiven(helper) ? [`--pairbrowse-helper=${helper.origin}`, `--pairbrowse-helper-key-file=${helper.keyFile}`] : []),
    ...(chromePages && helperGiven(helper) && typeof helper.captureKeyFile === "string" && helper.captureKeyFile ? [`--pairbrowse-capture-key-file=${helper.captureKeyFile}`] : []),
    // Only test runs are headless, and nobody is there to see a notification: without this the
    // first one starts the test browser's notification helper and macOS asks to allow it.
    ...(extra.some((a) => switchName(a) === "headless") ? ["--disable-notifications"] : []),
    ...extra.filter((a) => !isEnable(a)),
  ];
}

// The launch options every launch of the PairBrowse browser shares, built once here: the helper's
// (daemon/context.mjs, which adds its own signal handling) and the install self-check's
// (native/check.mjs). shell: the browser's (browser/choice.mjs). Its own side panel is the only
// extension a browser loads; a build with its own pages loads none and opens its startup page
// (PairBrowse's new tab page), not the driver's about:blank (plans/555 D1.2), unless blankStart
// (the self-check, which drives its first tab to a page of its own). firstRun: a new profile
// (prepareProfile). helper: { origin, keyFile, captureKeyFile? } for the browser's own pages, or
// null (the self-check has no live view). env, executablePath: as Playwright takes them.
export function launchOptions(config = {}, { shell, firstRun = false, helper = null, env, executablePath, blankStart = false } = {}) {
  const ownPages = !!shell?.ownPages;
  return {
    headless: false,
    env,
    executablePath,
    viewport: null,
    ignoreDefaultArgs: ownPages && !blankStart ? ["--disable-extensions", "about:blank"] : ["--disable-extensions"],
    args: launchArgs(config, { firstRun, chromePages: ownPages, helper }),
  };
}

// The page script (scripts/hud/, joined into one: bottom bar, badge, cursor, tab spark, your-activity recorder)
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
  const source = hudSource().replaceAll("__PB_NAME__", name).replaceAll("__PB_TOKEN__", token)
    .replaceAll("__PB_TAG_HUD__", tags.hud).replaceAll("__PB_TAG_BAR__", tags.bar).replaceAll("__PB_TAG_CURSOR__", tags.cursor)
    // Claude's own orange, from ui/vocab.js (the one copy the helper and the pages read too).
    .replaceAll("__PB_AGENT_COLOR__", AGENT_COLOR)
    // The agent cursor's motion model (scripts/motion.mjs), the same code the helper uses.
    .replace('"__PB_MOTION__"', () => `(${createMotion.toString()})()`);
  if (source.includes("__PB_")) throw new Error("pairbrowse: page script placeholders not replaced");
  return { source, name, token, tags };
}

// The pinned ungoogled-chromium app: downloaded once, checked against its SHA-256 and its
// notarization, then copied out of the disk image.
async function ungoogledApp(log) {
  const dir = join(paths.browser, `ungoogled-${UNGOOGLED.version}`);
  const app = join(dir, "Chromium.app");
  if (existsSync(join(app, "Contents", "Info.plist"))) return app;
  const asset = UNGOOGLED[process.arch === "arm64" ? "arm64" : "x64"];
  const dmg = join(paths.downloads, asset.file);
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
export const driverCli = () => join(paths.runtime, "node_modules", validateBrowserDriver(loadConfig(), process.versions.node, patchrightNodeMinimum(paths.runtime)), "cli.js");

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
  // One install at a time in the shared installs' home (instances share the app).
  return withInstallLock(() => brandedApp(log), { say: log });
}

async function brandedApp(log) {
  const sourceApp = await ungoogledApp(log);
  // The native PairBrowse build (scripts/native-install.mjs) lives at the usual place; this one
  // then goes next to it, so switching "browser" to chromium never overwrites the native app.
  const target = existsSync(join(nativeTarget, "Contents", "Resources", "PairBrowse-build.json")) ? join(dirname(nativeTarget), "PairBrowse Chromium.app") : nativeTarget;
  const exec = join(target, "Contents", "MacOS", "pairbrowse");
  const stamp = sha256(`branding v6 ${sourceApp} ${target}` + readFileSync(ICON).toString("base64"));
  const stampFile = paths.buildStamp;
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
