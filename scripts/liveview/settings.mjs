// The settings the browser's own pages read and change (the owner-only live view routes
// GET config.json and POST config, liveview.mjs): the fields of config.json below and nothing else.
//
// GET config.json answers exactly:
//   { browser: "pairbrowse" | "pairbrowse-open" | "<absolute path>",  which browser runs (browserChoice)
//     timeline: { on: boolean, cap: 1..200 },                   the session's pictures kept
//     layout: { left, right, strip },                           where the docks start
//     name: string,                                             participantName: your name in shared sessions ("" unset)
//     downloads: string | null,                                 downloadsDir: where downloads go (null: your Downloads folder)
//     pictures: boolean,                                        screenshots: a picture with each result agents get
//     cookies: "accept" | "reject",                             cookieChoice: what agents press on cookie banners
//     maxTabs: integer,                                         maxTabs: tabs kept open (POST: 2..50)
//     askSession: boolean,                                      sessionPicker: ask which session when the browser starts
//     native: boolean,                                          a PairBrowse build is pinned for this computer
//     chosen: boolean,                                          a person recorded the browser choice
//     report: boolean,                                          Report a problem is relayed (a valid reportUrl is set; never the address)
//     away: { on, server, ready, publicLink, privateRoute } }   handoff.away: hand-offs go to your phone while you are away (decision 8);
//                                                               server: always on (server mode); ready: handoff.enabled with a usable channel;
//                                                               publicLink: handoff.publicLink (step 21b); privateRoute: inviteBaseUrl is set
// POST config takes any subset of { browser, timeline: { on?, cap? }, layout: { left?, right?,
// strip? }, name, downloads, pictures, cookies, maxTabs, askSession, away, publicLink } and answers the same body
// plus restart: true while "browser" differs from the browser of the window open now (it takes
// effect when the browser next starts; no window: false). pictures, cookies, maxTabs, downloads and
// the timeline apply at once; name applies to joins at once and to your label in this browser from
// the helper's next start; askSession from the next start; away at once (only handoff.away is
// written, the rest of handoff as config.json has it; turning it on needs a ready channel, and on a
// server it can't be changed: hand-offs always go there; publicLink at once, on a server too, only
// handoff.publicLink written). Anything else in the body, or an
// invalid value, is refused (409, { error }) and nothing is written. Tunnel tokens, join
// addresses, the report address and every other setting are never in an answer.
// The Network section (config.json's network and the proxies' credentials) has routes of its own:
// createSettings answers it as `network` (liveview/network.mjs, liveview/routes/network.mjs).
import { isAbsolute, dirname, basename } from "node:path";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { within } from "../util.mjs";
import { folderOf, checkDownloads, downloadsProblem } from "../rules/downloads.mjs";
import { browserChoice } from "../browser.mjs";
import { isOpenBrowser, OPEN_BROWSER } from "../browser/choice.mjs";
import { saveConfig, paths } from "../paths.mjs";
import { readJson } from "../util.mjs";
import { configProblem, wrongValue } from "../config-schema.mjs";
import { cleanName } from "../sharing/join.mjs";
import { readLayout, layoutFrom } from "./layout.mjs";
import { reportUrlFrom } from "./report.mjs";
import { createNetworkSettings, localeOf } from "./network.mjs";

export const SETTINGS_KEYS = ["browser", "timeline", "layout", "name", "downloads", "pictures", "cookies", "maxTabs", "askSession", "away", "publicLink"];
export const CAP_MIN = 1, CAP_MAX = 200;
export const TABS_MIN = 2, TABS_MAX = 50;
export const NAME_MAX = 40;
const PATH_MAX = 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
// The route's own ranges, worded as config-schema.mjs words a refused config.json value.
const BOOL = { type: "boolean" }, COOKIES = { values: ["accept", "reject"] };
const CAP = { type: "integer", min: CAP_MIN, max: CAP_MAX }, TABS = { type: "integer", min: TABS_MIN, max: TABS_MAX };

const capOf = (v) => (Number.isInteger(v) && v >= CAP_MIN && v <= CAP_MAX ? v : CAP_MAX);
const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// File checks for a path (tests pass stand-ins; browserChoice's own by default).
const checksOf = (exists, executable) => ({ ...(exists ? { exists } : {}), ...(executable ? { executable } : {}) });

// The downloads folder's checks live in rules/downloads.mjs (folderOf is the stand-in in tests).
export { downloadsProblem };

// A browser of your own chosen in Settings: one this computer vouches for. On macOS an app (the
// path inside a .app bundle's Contents/MacOS) whose code signature verifies; elsewhere a file only
// its owner (you or root) can change, in a folder only they can change. A reason, or "".
const run = (file, args, ms) => new Promise((done) => execFile(file, args, { timeout: ms }, (error) => done(!error)));
export async function browserProblem(path, { platform = process.platform, verify = (app) => run("codesign", ["--verify", "--strict", app], 20_000), stat = statSync, uid = process.getuid?.() } = {}) {
  if (platform === "darwin") {
    const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(path);
    if (!m) return `${path} isn't an app's program (choose the app: …/Name.app/Contents/MacOS/Name).`;
    return (await within(25_000, Promise.resolve().then(() => verify(m[1])).catch(() => false))) === true ? "" : `${basename(m[1])}'s code signature doesn't verify: PairBrowse only starts a browser app macOS can vouch for.`;
  }
  if (platform === "win32") return "";
  try {
    for (const p of [path, dirname(path)]) {
      const s = stat(p);
      if (s.mode & 0o022) return `${p} can be changed by other accounts: PairBrowse doesn't start a browser from there.`;
      if (uid !== undefined && s.uid !== 0 && s.uid !== uid) return `${p} belongs to another account.`;
    }
  } catch { return `${path} can't be read.`; }
  return "";
}

// The Away switch's state (decision 8): on (handoff.away), server (server mode: hand-offs always go
// to the channels, the switch can't change that) and ready (handoff.enabled with at least one channel
// that can be used), with the public link (step 21b: handoff.publicLink, a hand-off link through
// the hand-off's own tunnel) and whether a private route is set (privateRoute: inviteBaseUrl, so a
// phone on the tailnet reaches the link without it). away: { server, enabled, channels,
// privateRoute } as the helper sees them now.
export const awayState = (config, away = {}) => ({ on: config.handoff?.away === true, server: away.server === true, ready: away.enabled === true && Number(away.channels) > 0,
  publicLink: config.handoff?.publicLink === true, privateRoute: away.privateRoute === true });

// config: the settings with the older names as the person wrote them (context.choiceConfig()).
// exists / executable: as applySettings. away: as awayState.
export function readSettings(config, { native = false, exists, executable, settingsSection = false, away = {} } = {}) {
  const choice = browserChoice(config, { native, ...checksOf(exists, executable) });
  return {
    browser: choice.browser, timeline: { on: config.timeline !== false, cap: capOf(config.timelineCap) }, layout: layoutFrom(config.layout),
    name: typeof config.participantName === "string" ? cleanName(config.participantName, "") : "",
    downloads: typeof config.downloadsDir === "string" && config.downloadsDir ? config.downloadsDir : null,
    pictures: config.screenshots !== false,
    cookies: config.cookieChoice === "reject" ? "reject" : "accept",
    maxTabs: Math.max(2, Number(config.maxTabs) || 20),
    askSession: config.sessionPicker !== false,
    native: !!native, chosen: choice.set,
    report: reportUrlFrom(config.reportUrl) !== null,
    // The browser's settings are the engine settings' PairBrowse section (a build that declares
    // it, 580): where the pages open Settings. Never a path or address.
    settingsSection: !!settingsSection,
    away: awayState(config, away),
  };
}

// given (the POST body, parsed) checked against config: { fields } (only the config keys given:
// browser, timeline, timelineCap, layout, participantName, downloadsDir, screenshots, cookieChoice,
// maxTabs, sessionPicker) or { error }. exists / executable: file checks for a path (tests pass
// stand-ins; browserChoice's own by default). folder(path): the real folder at path, or null
// (statSync's by default). home: the helper's home, which no downloads folder may be in.
// away: as awayState (Away is refused on a server, and turned on only with a ready channel; its
// field is awayOn, which createSettings writes into handoff).
export function applySettings(given, config, { native = false, exists, executable, folder = folderOf, home = paths.home, user = homedir(), away = {} } = {}) {
  if (!plainObject(given)) return { error: `Settings are { ${SETTINGS_KEYS.join(", ")} }.` };
  for (const k of Object.keys(given)) if (!SETTINGS_KEYS.includes(k)) return { error: `Unknown setting "${k}"` };
  const fields = {};
  if (given.browser !== undefined) {
    const b = given.browser;
    if (typeof b !== "string") return { error: 'browser is "pairbrowse", "pairbrowse-open" or an absolute path.' };
    if (b === "pairbrowse") {
      if (!native) return { error: "There's no PairBrowse browser build for this computer yet. Choose PairBrowse as an extension for now." };
    } else if (!isOpenBrowser(b)) {
      if (!isAbsolute(b) || b.length > PATH_MAX || CONTROL.test(b)) return { error: 'browser is "pairbrowse", "pairbrowse-open" or an absolute path.' };
      if (browserChoice({ browser: b }, checksOf(exists, executable)).browser !== b) return { error: `${b} isn't an executable file. Choose the browser app itself.` };
    }
    fields.browser = isOpenBrowser(b) ? OPEN_BROWSER : b;
  }
  if (given.timeline !== undefined) {
    const t = given.timeline;
    if (!plainObject(t)) return { error: "timeline is { on, cap }." };
    for (const k of Object.keys(t)) if (k !== "on" && k !== "cap") return { error: `Unknown setting "timeline.${k}"` };
    if (t.on !== undefined && typeof t.on !== "boolean") return { error: `${wrongValue("timeline.on", BOOL, t.on)}.` };
    if (t.cap !== undefined && (!Number.isInteger(t.cap) || t.cap < CAP_MIN || t.cap > CAP_MAX)) return { error: `${wrongValue("timeline.cap", CAP, t.cap)}.` };
    if (t.on !== undefined) fields.timeline = t.on;
    if (t.cap !== undefined) fields.timelineCap = t.cap;
  }
  if (given.layout !== undefined) {
    if (plainObject(given.layout)) for (const k of Object.keys(given.layout)) if (!["left", "right", "strip"].includes(k)) return { error: `Unknown setting "layout.${k}"` };
    const next = readLayout(given.layout, layoutFrom(config.layout));
    if (next.error) return { error: next.error };
    fields.layout = next;
  }
  if (given.name !== undefined) {
    // Kept as the person typed it (spaces run together), or refused: never quietly changed.
    const t = typeof given.name === "string" && given.name.length <= NAME_MAX * 4 ? given.name.trim().replace(/\s+/g, " ") : null;
    if (t === null || t.length > NAME_MAX || (t && cleanName(t, "") !== t)) return { error: `name is up to ${NAME_MAX} characters, without < > " ' \` or control characters ("" for none).` };
    fields.participantName = t || null;
  }
  if (given.downloads !== undefined) {
    const d = given.downloads;
    if (d === null || d === "") fields.downloadsDir = null;
    else {
      if (typeof d !== "string" || !isAbsolute(d) || d.length > PATH_MAX || CONTROL.test(d)) return { error: "downloads is an absolute path to a folder, or null for your Downloads folder." };
      const { problem } = checkDownloads(d, { home, user, folder });
      if (problem) return { error: problem };
      fields.downloadsDir = d;
    }
  }
  if (given.pictures !== undefined) {
    if (typeof given.pictures !== "boolean") return { error: `${wrongValue("pictures", BOOL, given.pictures)}.` };
    fields.screenshots = given.pictures;
  }
  if (given.cookies !== undefined) {
    if (given.cookies !== "accept" && given.cookies !== "reject") return { error: `${wrongValue("cookies", COOKIES, given.cookies)}.` };
    fields.cookieChoice = given.cookies;
  }
  if (given.maxTabs !== undefined) {
    if (!Number.isInteger(given.maxTabs) || given.maxTabs < TABS_MIN || given.maxTabs > TABS_MAX) return { error: `${wrongValue("maxTabs", TABS, given.maxTabs)}.` };
    fields.maxTabs = given.maxTabs;
  }
  if (given.askSession !== undefined) {
    if (typeof given.askSession !== "boolean") return { error: `${wrongValue("askSession", BOOL, given.askSession)}.` };
    fields.sessionPicker = given.askSession;
  }
  if (given.away !== undefined) {
    if (typeof given.away !== "boolean") return { error: `${wrongValue("away", BOOL, given.away)}.` };
    const st = awayState(config, away);
    if (st.server) return { error: "This browser runs on a server: hand-offs always go to your channels there." };
    if (given.away && !st.ready) return { error: "Away needs a hand-off channel first: set handoff in config.json (enabled, and a channel with its PAIRBROWSE_ secret saved). See docs/configuration.md." };
    fields.awayOn = given.away;
  }
  if (given.publicLink !== undefined) {
    if (typeof given.publicLink !== "boolean") return { error: `${wrongValue("publicLink", BOOL, given.publicLink)}.` };
    fields.publicLinkOn = given.publicLink;
  }
  return { fields };
}

// The live view's settings dep ({ read(), write(given) }). config: the running config (changed in
// place, so the timeline and the docks' default follow at once); choiceConfig(): the settings the
// browser choice is read from; browserInUse(): the browser of the window open now, or null;
// settingsSection(): the browser's build has its settings as the engine settings' section.
// save(fields): writes config.json (saveConfig: a temp file and a rename).
// folder / home: as applySettings. onChange(fields): after a write (the helper passes it on).
// vouch(path): browserProblem's check for a browser path of your own (tests pass a stand-in).
// away(): { server, enabled, channels } now (the Away switch). savedHandoff(): config.json's own
// handoff (read for the write, so the running config's filled-in defaults never land in the file).
// secrets: the helper's secret store (rules/secrets.mjs secretStore), for the Network section
// (network, liveview/network.mjs: proxies in config.json's network, their credentials in
// secrets.env); null: no Network section. networkDeps: that part's other deps (tests).
export function createSettings({ config, choiceConfig = () => config, native = false, settingsSection = () => false, browserInUse = () => null, save = (fields) => saveConfig(fields), exists, executable, folder, home, user, vouch = (p) => browserProblem(p), onChange = () => {},
  away = () => ({}), savedHandoff = () => readJson(paths.config)?.handoff, secrets = null, log = () => {}, networkDeps = {} }) {
  const read = () => readSettings(choiceConfig(), { native, exists, executable, settingsSection: settingsSection(), away: away() });
  // The browser's time zone and languages for the Test's coherence items: the native build's own
  // settings when it is the browser chosen, else this computer's.
  const locale = () => localeOf(choiceConfig(), { native: read().browser === "pairbrowse" });
  return {
    read,
    network: secrets ? createNetworkSettings({ secrets, locale, log, ...networkDeps }) : null,
    async write(given) {
      const r = applySettings(given, choiceConfig(), { native, exists, executable, ...(folder ? { folder } : {}), ...(home ? { home } : {}), ...(user ? { user } : {}), away: away() });
      if (r.error) return r;
      // Away and the public link: only handoff.away and handoff.publicLink change, in the file's
      // handoff and in the running config's.
      const { awayOn, publicLinkOn, ...rest } = r.fields;
      if (awayOn !== undefined || publicLinkOn !== undefined) {
        const saved = savedHandoff();
        rest.handoff = { ...(saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {}), ...(awayOn !== undefined ? { away: awayOn } : {}), ...(publicLinkOn !== undefined ? { publicLink: publicLinkOn } : {}) };
      }
      r.fields = rest;
      // A path of your own: checked before anything is written (defense in depth: the route is the
      // owner's alone already).
      if (typeof r.fields.browser === "string" && isAbsolute(r.fields.browser)) {
        const why = await vouch(r.fields.browser);
        if (why) return { error: why };
      }
      // The schema config.json is read with (config-schema.mjs), with the same message as a load's:
      // whatever passed the checks above still never writes a value loadConfig would refuse.
      const problem = configProblem(r.fields);
      if (problem) return { error: problem };
      try { save(r.fields); } catch (e) { return { error: `Couldn't write config.json: ${e?.message || e}. Check that PairBrowse's folder can be written, then save again.` }; }
      const { handoff, ...plain } = r.fields;
      Object.assign(config, plain);
      if (handoff) config.handoff = { ...config.handoff, ...(awayOn !== undefined ? { away: awayOn } : {}), ...(publicLinkOn !== undefined ? { publicLink: publicLinkOn } : {}) };
      try { onChange(r.fields); } catch {}
      const body = read();
      const running = browserInUse();
      // (A browser window open now that isn't the chosen one: the choice waits for its next start.)
      return { ...body, restart: running !== null && body.browser !== running };
    },
  };
}
