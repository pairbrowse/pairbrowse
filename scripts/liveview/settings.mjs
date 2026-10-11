// The settings the browser's own pages read and change (the owner-only live view routes
// GET config.json and POST config, liveview.mjs): three fields of config.json and nothing else.
//
// GET config.json answers exactly:
//   { browser: "pairbrowse" | "chromium" | "<absolute path>",  which browser runs (browserChoice)
//     timeline: { on: boolean, cap: 1..200 },                   the session's pictures kept
//     layout: { left, right, strip },                           where the docks start
//     native: boolean,                                          a PairBrowse build is pinned for this computer
//     chosen: boolean }                                         a person recorded the browser choice
// POST config takes any subset of { browser, timeline: { on?, cap? }, layout: { left?, right?,
// strip? } } and answers the same body plus restart: true while "browser" differs from the browser
// of the window open now (it takes effect when the browser next starts; no window: false). Anything else in the body,
// or an invalid value, is refused (409, { error }) and nothing is written. Tunnel tokens, join
// addresses, names and every other setting are never in an answer.
import { isAbsolute } from "node:path";
import { browserChoice } from "../browser.mjs";
import { saveConfig } from "../paths.mjs";
import { readLayout, layoutFrom } from "./layout.mjs";

export const SETTINGS_KEYS = ["browser", "timeline", "layout"];
export const CAP_MIN = 1, CAP_MAX = 200;
const PATH_MAX = 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;

const capOf = (v) => (Number.isInteger(v) && v >= CAP_MIN && v <= CAP_MAX ? v : CAP_MAX);
const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// File checks for a path (tests pass stand-ins; browserChoice's own by default).
const checksOf = (exists, executable) => ({ ...(exists ? { exists } : {}), ...(executable ? { executable } : {}) });

// config: the settings with the older names as the person wrote them (context.choiceConfig()).
// exists / executable: as applySettings.
export function readSettings(config, { native = false, exists, executable } = {}) {
  const choice = browserChoice(config, { native, ...checksOf(exists, executable) });
  return { browser: choice.browser, timeline: { on: config.timeline !== false, cap: capOf(config.timelineCap) }, layout: layoutFrom(config.layout), native: !!native, chosen: choice.set };
}

// given (the POST body, parsed) checked against config: { fields } (only the config keys given:
// browser, timeline, timelineCap, layout) or { error }. exists / executable: file checks for a
// path (tests pass stand-ins; browserChoice's own by default).
export function applySettings(given, config, { native = false, exists, executable } = {}) {
  if (!plainObject(given)) return { error: "Settings are { browser, timeline, layout }." };
  for (const k of Object.keys(given)) if (!SETTINGS_KEYS.includes(k)) return { error: `Unknown setting "${k}"` };
  const fields = {};
  if (given.browser !== undefined) {
    const b = given.browser;
    if (typeof b !== "string") return { error: 'browser is "pairbrowse", "chromium" or an absolute path.' };
    if (b === "pairbrowse") {
      if (!native) return { error: "There's no PairBrowse browser build for this computer yet" };
    } else if (b !== "chromium") {
      if (!isAbsolute(b) || b.length > PATH_MAX || CONTROL.test(b)) return { error: 'browser is "pairbrowse", "chromium" or an absolute path.' };
      if (browserChoice({ browser: b }, checksOf(exists, executable)).browser !== b) return { error: `${b} isn't an executable file` };
    }
    fields.browser = b;
  }
  if (given.timeline !== undefined) {
    const t = given.timeline;
    if (!plainObject(t)) return { error: "timeline is { on, cap }." };
    for (const k of Object.keys(t)) if (k !== "on" && k !== "cap") return { error: `Unknown setting "timeline.${k}"` };
    if (t.on !== undefined && typeof t.on !== "boolean") return { error: "timeline.on is true or false." };
    if (t.cap !== undefined && (!Number.isInteger(t.cap) || t.cap < CAP_MIN || t.cap > CAP_MAX)) return { error: `timeline.cap is a whole number from ${CAP_MIN} to ${CAP_MAX}.` };
    if (t.on !== undefined) fields.timeline = t.on;
    if (t.cap !== undefined) fields.timelineCap = t.cap;
  }
  if (given.layout !== undefined) {
    if (plainObject(given.layout)) for (const k of Object.keys(given.layout)) if (!["left", "right", "strip"].includes(k)) return { error: `Unknown setting "layout.${k}"` };
    const next = readLayout(given.layout, layoutFrom(config.layout));
    if (next.error) return { error: next.error };
    fields.layout = next;
  }
  return { fields };
}

// The live view's settings dep ({ read(), write(given) }). config: the running config (changed in
// place, so the timeline and the docks' default follow at once); choiceConfig(): the settings the
// browser choice is read from; browserInUse(): the browser of the window open now, or null.
// save(fields): writes config.json (saveConfig: a temp file and a rename).
export function createSettings({ config, choiceConfig = () => config, native = false, browserInUse = () => null, save = (fields) => saveConfig(fields), exists, executable }) {
  const read = () => readSettings(choiceConfig(), { native, exists, executable });
  return {
    read,
    write(given) {
      const r = applySettings(given, choiceConfig(), { native, exists, executable });
      if (r.error) return r;
      try { save(r.fields); } catch (e) { return { error: `Couldn't write config.json: ${e?.message || e}` }; }
      Object.assign(config, r.fields);
      const body = read();
      const running = browserInUse();
      // (A browser window open now that isn't the chosen one: the choice waits for its next start.)
      return { ...body, restart: running !== null && body.browser !== running };
    },
  };
}
