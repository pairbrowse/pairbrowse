// Another device's description, read for its settings only (spec server-mode D-AP2, D15). Two of
// the import formats describe a device rather than a PairBrowse profile: the engine pack's
// collector output (`engine-device/1`, what scripts/native-engine.mjs captureMacHost reads on this
// Mac) and an engine persona file (`engine-persona`, `{ name, options }`). From either, only what
// a person could choose is taken: the screen, the languages, the time zone and, from a persona, its
// seed. Everything that describes that device's hardware (GPU, WebGL, WebGPU, fonts, audio, voices,
// codecs, memory, cores, touch points, canvas) is reported `unsupported` and never applied: on this
// computer those are measured from the real runtime (Phase E), never imported. Version identity
// (user agent, client hints, platform) is the engine build's own, reported `derived`.
//
// Every top-level section of a file is classed, one report item each in the shape Phase E shares
// (D10: { field, rule, class, status, requested, measured, severity, reason }); `field` names the
// file's own key. A value is repeated only when it is applied (a setting); nothing else in the file
// (a proxy's credentials, a page address, an unknown key's value) reaches a report or a message.
//
// Pure; Node's standard library only.
import { PAIRBROWSE_ENGINE_KEYS } from "../config-schema.mjs";
import { forbiddenWhy } from "./schema.mjs";

// The collector's own format version (its meta.schema_version; absent in early captures).
export const DEVICE_SCHEMA_VERSION = 1;
const HARDWARE = "another device's hardware: on this computer it is measured from the real runtime, never imported (spec D-AP2)";
const IDENTITY = "the engine build's own version identity (user agent, client hints, platform)";

// Each top-level section the collector writes: its class in the property matrix (spec section 9:
// C configurable, M measured, D derived, U unavailable), what an import does with it, and the
// native engine patch behind it where the property matrix names one. navigator, screen and intl
// are read field by field (deviceSettings).
export const DEVICE_SECTIONS = Object.freeze({
  meta: { class: "D", status: "not-applied", patch: null, reason: "the file's own details; its collection time is kept in provenance" },
  navigator: { class: "D", status: "derived", patch: null, reason: IDENTITY },
  screen: { class: "C", status: "applied", patch: "140", reason: "imported into screen" },
  intl: { class: "C", status: "applied", patch: null, reason: "its time zone imported into locale.timezone" },
  hardware_concurrency: { class: "D", status: "unsupported", patch: "002", reason: HARDWARE },
  device_memory: { class: "D", status: "unsupported", patch: "002", reason: HARDWARE },
  max_touch_points: { class: "D", status: "unsupported", patch: "002", reason: HARDWARE },
  webgl: { class: "M", status: "unsupported", patch: "002", reason: HARDWARE },
  webgpu: { class: "M", status: "unsupported", patch: "961", reason: HARDWARE },
  fonts: { class: "M", status: "unsupported", patch: "040", reason: HARDWARE },
  audio: { class: "M", status: "unsupported", patch: null, reason: HARDWARE },
  speech: { class: "D", status: "unsupported", patch: null, reason: HARDWARE },
  codecs: { class: "M", status: "unsupported", patch: "147", reason: HARDWARE },
  perf_memory: { class: "D", status: "unsupported", patch: "146", reason: HARDWARE },
  media_devices: { class: "U", status: "unsupported", patch: null, reason: HARDWARE },
  canvas: { class: "M", status: "unsupported", patch: null, reason: HARDWARE },
  client_rects: { class: "M", status: "unsupported", patch: null, reason: HARDWARE },
  battery: { class: "U", status: "unsupported", patch: null, reason: HARDWARE },
  keyboard: { class: "U", status: "unsupported", patch: null, reason: HARDWARE },
  math: { class: "D", status: "derived", patch: null, reason: "the engine build's and this computer's own" },
  plugins: { class: "D", status: "derived", patch: null, reason: IDENTITY },
  mime_types: { class: "D", status: "derived", patch: null, reason: IDENTITY },
  css: { class: "M", status: "not-applied", patch: null, reason: "measured on this computer; a color scheme or reduced motion is chosen in display" },
  webrtc: { class: "M", status: "not-applied", patch: null, reason: "measured through the session's network (Phase C)" },
  connection: { class: "M", status: "not-applied", patch: null, reason: "measured through the session's network (Phase C)" },
  network: { class: "M", status: "not-applied", patch: null, reason: "measured through the session's network (Phase C)" },
  permissions: { class: "U", status: "not-applied", patch: null, reason: "the browser's own state, kept in the session" },
  do_not_track: { class: "U", status: "not-applied", patch: null, reason: "the browser's own setting, kept in the session" },
});

// navigator's own fields: hardware ones unsupported, languages imported, the rest version identity.
const NAVIGATOR_HARDWARE = ["hardware_concurrency", "device_memory", "max_touch_points"];
const NAVIGATOR_SETTINGS = ["do_not_track", "cookie_enabled", "pdf_viewer_enabled", "webdriver"];

// An engine persona's options (`{ name, options }`): where each applied one goes in a profile.
export const PERSONA_APPLIED = Object.freeze({
  timezone: "locale.timezone", acceptLanguage: "locale.languages", screenWidth: "screen.width", screenHeight: "screen.height",
  availWidth: "screen.availWidth", availHeight: "screen.availHeight", colorDepth: "screen.colorDepth",
  devicePixelRatio: "screen.devicePixelRatio", fingerprint: "persona.seed",
});
// Options that describe another device or reach outside the browser: never applied (D15).
const PERSONA_UNSUPPORTED = {
  gpuVendor: HARDWARE, gpuRenderer: HARDWARE, gpuStringSpoof: HARDWARE, disableGpuFingerprint: HARDWARE,
  hardwareConcurrency: HARDWARE, deviceMemory: HARDWARE, maxTouchPoints: HARDWARE, fingerprintVoices: HARDWARE,
  platform: "another device's platform: the engine build's own is used",
  fingerprintProfile: "a profile from a library of other devices: PairBrowse never picks one (spec D9)",
  webrtcIp: "measured through the session's network (Phase C), never set", location: "measured through the session's network (Phase C), never set",
  proxy: "a proxy is chosen in config.json's network, never in a profile; nothing of it is kept",
  canvasBridge: "the canvas bridge is refused (spec E1)",
};
const PERSONA_DERIVED = { platformVersion: IDENTITY, brand: IDENTITY, brandVersion: IDENTITY };

const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// A key named in a report only when it looks like a field name; others are counted.
const NAMED = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
export const reportable = (k) => NAMED.test(k);

// One report item (D10's shape). requested: only an applied setting's value.
export const item = (field, status, cls, reason, { requested = null, severity = "info", rule = "import.fields" } = {}) =>
  ({ field, rule, class: cls, status, requested, measured: null, severity, reason });

// Keys that can't be named, as one item.
function unnamedItem(count, where) {
  return count ? [item(where ? `${where}.(unnamed)` : "(unnamed)", "not-applied", "U", `${count} key${count > 1 ? "s" : ""} with names that aren't field names; not read`)] : [];
}

// One collector section's items (no values but applied ones). value: the section as written.
export function classifySection(key, value) {
  const known = Object.hasOwn(DEVICE_SECTIONS, key) ? DEVICE_SECTIONS[key] : null;
  if (!known) return [item(key, "not-applied", "U", "a section PairBrowse doesn't know; not read")];
  if (key === "navigator" && plainObject(value)) {
    const out = [];
    const present = Object.keys(value);
    for (const k of NAVIGATOR_HARDWARE) if (present.includes(k)) out.push(item(`navigator.${k}`, "unsupported", "D", HARDWARE));
    if (present.includes("languages")) out.push(item("navigator.languages", "applied", "C", "imported into locale.languages"));
    const settings = present.filter((k) => NAVIGATOR_SETTINGS.includes(k));
    if (settings.length) out.push(item("navigator", "not-applied", "U", `${settings.join(", ")}: the browser's own settings, kept in the session`));
    const identity = present.filter((k) => !NAVIGATOR_HARDWARE.includes(k) && !NAVIGATOR_SETTINGS.includes(k) && k !== "languages" && k !== "language");
    if (identity.length || present.includes("language")) out.push(item("navigator", "derived", "D", `${identity.length} field${identity.length === 1 ? "" : "s"} of ${IDENTITY}; navigator.language follows the languages`));
    return out;
  }
  if (key === "intl" && plainObject(value)) {
    const out = [];
    if (typeof value.timeZone === "string") out.push(item("intl.timeZone", "applied", "C", "imported into locale.timezone"));
    if (Object.keys(value).some((k) => k !== "timeZone")) out.push(item("intl", "derived", "D", "date, number and calendar formats follow the languages and time zone"));
    return out;
  }
  return [item(key, known.status, known.class, known.patch ? `${known.reason} (engine patch ${known.patch})` : known.reason)];
}

// A value the file left out (missing or null) as undefined; any other is passed on as written, for
// the record check to refuse by name when it isn't of the right shape.
const num = (v) => (v === null ? undefined : v);

// A screen from width and height plus the optional rest: the record's whole screen, with an item
// for each value not in the file (avail taken as the whole screen, colour depth 24, ratio 1).
function wholeScreen(given, where) {
  const screen = { width: given.width, height: given.height };
  const filled = [];
  const take = (k, v, fallback, why) => {
    if (v === undefined) { screen[k] = fallback; filled.push(item(`${where}.${k}`, "derived", "C", `not in the file; ${why}`)); } else screen[k] = v;
  };
  take("availWidth", given.availWidth, given.width, "the whole screen's width");
  take("availHeight", given.availHeight, given.height, "the whole screen's height");
  take("colorDepth", given.colorDepth, 24, "24");
  take("devicePixelRatio", given.devicePixelRatio, 1, "1");
  return { screen, filled };
}

// The language tags of an Accept-Language value ("de-DE,de;q=0.9,en") in order, weights dropped.
export function languagesOf(value) {
  if (typeof value !== "string") return value;
  return value.split(",").map((part) => part.split(";")[0].trim()).filter(Boolean);
}
// Tags without repeats, first ten kept: { languages, dropped }.
function firstTen(list) {
  if (!Array.isArray(list)) return { languages: list, dropped: 0 };
  const seen = new Set(), out = [];
  for (const t of list) {
    const key = typeof t === "string" ? t.toLowerCase() : t;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return { languages: out.slice(0, 10), dropped: Math.max(0, out.length - 10) };
}

// The locale part of the settings from languages and a time zone (either may be missing).
function localeOf(languages, timezone) {
  const set = languages !== undefined || timezone !== undefined;
  return { languages: languages ?? null, timezone: timezone ?? null, source: set ? "set" : "system" };
}

// A collector file's settings and report: { settings, items, collectedAt }. settings holds only
// locale and screen (and screen only when the file has a width and height); values that aren't of
// the right shape are passed on as they are, for the record check to refuse by name.
export function deviceSettings(raw) {
  const items = [];
  const settings = {};
  const named = Object.keys(raw).filter(reportable);
  for (const k of named) items.push(...classifySection(k, raw[k]));
  items.push(...unnamedItem(Object.keys(raw).length - named.length));

  const nav = plainObject(raw.navigator) ? raw.navigator : {};
  const { languages, dropped } = firstTen(nav.languages === null ? undefined : nav.languages);
  if (dropped) items.push(item("navigator.languages", "not-applied", "C", `${dropped} more language${dropped > 1 ? "s" : ""} past the first ten; a profile holds ten`));
  const intl = plainObject(raw.intl) ? raw.intl : {};
  const timezone = intl.timeZone === null ? undefined : intl.timeZone;
  settings.locale = localeOf(Array.isArray(languages) && !languages.length ? undefined : languages, timezone);

  const s = plainObject(raw.screen) ? raw.screen : null;
  if (s && s.width !== undefined && s.width !== null && s.height !== undefined && s.height !== null) {
    const { screen, filled } = wholeScreen({ width: num(s.width), height: num(s.height), availWidth: num(s.avail_width), availHeight: num(s.avail_height),
      colorDepth: num(s.color_depth), devicePixelRatio: num(s.device_pixel_ratio) }, "screen");
    settings.screen = screen;
    items.push(...filled);
    const rest = Object.keys(s).filter((k) => !["width", "height", "avail_width", "avail_height", "color_depth", "device_pixel_ratio"].includes(k));
    if (rest.length) items.push(item("screen", "not-applied", "M", `${rest.length} more field${rest.length > 1 ? "s" : ""} (window position and sizes, orientation, pixel depth): measured on this computer`));
  } else if (Object.hasOwn(raw, "screen")) {
    items.push(item("screen", "not-applied", "C", "no width and height in the file; this computer's screen is used"));
  }

  const at = plainObject(raw.meta) ? raw.meta.captured_at : undefined;
  const t = typeof at === "string" ? Date.parse(at) : NaN;
  return { settings, items: items.map((i) => withValue(i, settings)), collectedAt: Number.isNaN(t) ? null : new Date(t).toISOString() };
}

// An engine persona's settings and report: { settings, items }. Its options are named in the
// report; only the applied ones' values are repeated.
export function personaSettings(raw) {
  const items = [];
  const options = raw.options;
  const keys = Object.keys(options);
  const named = keys.filter(reportable);
  for (const k of named) {
    if (Object.hasOwn(PERSONA_APPLIED, k)) items.push(item(`options.${k}`, "applied", "C", `imported into ${PERSONA_APPLIED[k]}`));
    else if (Object.hasOwn(PERSONA_UNSUPPORTED, k)) items.push(item(`options.${k}`, "unsupported", PERSONA_UNSUPPORTED[k] === HARDWARE ? "M" : "U", PERSONA_UNSUPPORTED[k]));
    else if (Object.hasOwn(PERSONA_DERIVED, k)) items.push(item(`options.${k}`, "derived", "D", PERSONA_DERIVED[k]));
    else if (forbiddenWhy(k)) items.push(item(`options.${k}`, "unsupported", "U", `${/^[aeiou]/.test(forbiddenWhy(k)) ? "an" : "a"} ${forbiddenWhy(k)}: a profile never holds one`));
    else if (PAIRBROWSE_ENGINE_KEYS.includes(k) || k === "geoip") items.push(item(`options.${k}`, "not-applied", "U", "an engine option a profile doesn't hold"));
    else items.push(item(`options.${k}`, "not-applied", "U", "an option PairBrowse doesn't know; not read"));
  }
  items.push(...unnamedItem(keys.length - named.length, "options"));
  for (const k of Object.keys(raw)) {
    if (k === "options" || k === "name") continue;
    items.push(item(reportable(k) ? k : "(unnamed)", "not-applied", "U", "not part of a persona's options; not read"));
  }

  const settings = {};
  const { languages, dropped } = firstTen(languagesOf(options.acceptLanguage ?? undefined));
  if (dropped) items.push(item("options.acceptLanguage", "not-applied", "C", `${dropped} more language${dropped > 1 ? "s" : ""} past the first ten; a profile holds ten`));
  settings.locale = localeOf(Array.isArray(languages) && !languages.length ? undefined : languages, options.timezone ?? undefined);
  const has = (k) => options[k] !== undefined && options[k] !== null;
  if (has("screenWidth") || has("screenHeight")) {
    const { screen, filled } = wholeScreen({ width: num(options.screenWidth), height: num(options.screenHeight), availWidth: num(options.availWidth),
      availHeight: num(options.availHeight), colorDepth: num(options.colorDepth), devicePixelRatio: num(options.devicePixelRatio) }, "options");
    settings.screen = screen;
    items.push(...filled);
  } else {
    for (const k of ["availWidth", "availHeight", "colorDepth", "devicePixelRatio"]) {
      if (has(k)) {
        const at = items.findIndex((i) => i.field === `options.${k}`);
        items[at] = item(`options.${k}`, "not-applied", "C", "no screenWidth and screenHeight in the file; this computer's screen is used");
      }
    }
  }
  if (has("fingerprint")) {
    // The engine takes a seed as a number too.
    const seed = typeof options.fingerprint === "number" && Number.isSafeInteger(options.fingerprint) ? String(options.fingerprint) : options.fingerprint;
    settings.persona = { source: "seed", seed };
    const at = items.findIndex((i) => i.field === "options.fingerprint");
    items[at] = item("options.fingerprint", "applied", "C", "imported into persona.seed: a pinned seed; two browsers with it look like one device, so it runs in one browser at a time", { severity: "warning" });
  }
  return { settings, items: items.map((i) => withValue(i, settings)) };
}

// The value an applied item put into the settings, as its `requested`.
function withValue(it, settings) {
  if (it.status !== "applied") return it;
  const to = /imported into ([a-zA-Z.]+)/.exec(it.reason)?.[1].replace(/\.$/, "");
  if (!to) return it;
  const value = to.split(".").reduce((v, k) => (plainObject(v) ? v[k] : undefined), settings);
  return value === undefined ? it : { ...it, requested: structuredClone(value) };
}

// Every top-level section of a device or persona file classed (D16's field report). format: an
// import format id (profiles/schema.mjs IMPORT_FORMATS).
export function fieldReport(format, raw) {
  if (!plainObject(raw)) return [];
  if (format === "engine-device/1") return deviceSettings(raw).items;
  if (format === "engine-persona" && plainObject(raw.options)) return personaSettings(raw).items;
  return [];
}
