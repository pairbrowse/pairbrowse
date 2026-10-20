// The one schema for a browser profile record (spec server-mode Phase D, D1, D6, D10, D17, D19):
// what a person chose for a session's browser (locale, screen, window, display, graphics request,
// persona seed, saved-card option, a network id), never storage, a proxy server, a credential, a
// launch option, a path or another device's hardware (section 3.3). Records are written by
// profiles/store.mjs as ~/.pairbrowse/browser-profiles/<id>.json; an older record reaches
// checkProfile only through profiles/upgrade.mjs.
//
// Strict where config.json is lenient: a profile is applied to a launch, so any unknown key, wrong
// value or broken cross-field rule refuses the whole record (nothing is dropped and used anyway).
// Messages name the key and what it takes; they repeat a number, true, false or null, never a
// string (a value in the wrong field could be a credential).
//
// Pure; Node's standard library only. Specs use config-schema.mjs's format ({ type, nullable,
// values, min, max }) plus: pattern (a string's RegExp), maxLength, each (an array's item spec),
// maxItems, maxJson (an open object's size as JSON), entries ({ key: RegExp, value: spec }: an object whose own keys are free but checked).
import { fits, expected } from "../config-schema.mjs";
import { NETWORK_ID } from "../net/credentials.mjs";

// The record's schema (D19). A newer one is refused, never rewritten; an older one goes through
// profiles/upgrade.mjs first.
export const SCHEMA_VERSION = 1;
// The export file's formatVersion (D18, `pairbrowse-profile/1`).
export const FORMAT_VERSION = 1;
export const EXPORT_FORMAT = "pairbrowse-profile";

// Session names as sessions.mjs validName takes them (repeated here: sessions.mjs loads paths.mjs,
// which makes the home's folders).
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const PROFILE_ID = /^p-[0-9a-f]{16}$/;
// The config-backed profile (D5): computed from config.json each launch, the only one of kind "config".
export const DEFAULT_PROFILE = "default";
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAJOR = /^\d{1,4}$/;
const BUILD = /^\d{1,4}(?:\.\d{1,6}){3}$/;
// A language tag (BCP 47 shape; Intl.getCanonicalLocales decides) and an IANA time zone name.
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,4}$/;
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+-]{0,30}(?:\/[A-Za-z0-9_+-]{1,30}){0,2}$/;
// The engine's persona seed (its `fingerprint` key); "off" turns the persona off and is refused.
const SEED = /^(?!off$)[A-Za-z0-9_-]{1,128}$/;
// A license: an SPDX id or expression (`MIT`, `CC-BY-4.0`, `MIT OR Apache-2.0`), `own-capture` or `unknown` (D17).
const LICENSE = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}(?: (?:AND|OR|WITH) [A-Za-z0-9][A-Za-z0-9.+-]{0,63}){0,4}$/;
// A file's base name: no folder, nothing hidden.
const BASE_NAME = /^[^/\\\0.][^/\\\0]{0,254}$/;
// A field path in history and validation items (`locale.timezone`, `screen`).
const FIELD = /^[A-Za-z][A-Za-z0-9]{0,39}(?:\.[A-Za-z][A-Za-z0-9]{0,39}){0,3}$/;
const TEXT = { type: "string", maxLength: 200 };

export const BROWSER_KINDS = ["pairbrowse", "pairbrowse-open"];
export const PROFILE_KINDS = ["store", "config"];
export const PROFILE_STATUSES = ["active", "retired"];
export const LOCALE_SOURCES = ["set", "system", "geoip"];
// Phase E's graphics requests (E2, E8); measurements live in validation[build].graphics.
export const GRAPHICS_BACKENDS = ["auto", "software", "gpu"];
export const PERSONA_SOURCES = ["seed", "host"];
// D15's import formats, as provenance names them.
export const IMPORT_FORMATS = [`${EXPORT_FORMAT}/1`, "engine-device/1", "engine-persona"];
// Who made a history entry: the person (CLI, live view), the config file (the default profile's
// configHash changed, D5), the first-start migration, or the upgrader.
export const HISTORY_BY = ["person", "config", "migration", "upgrade"];
// D10's validation shape, shared with Phase E (section 9's classes).
export const VALIDATION_STATUSES = ["validated", "unverified", "failed"];
export const ITEM_STATUSES = ["applied", "not-applied", "derived", "unsupported", "matched", "mismatch", "unverified"];
export const ITEM_CLASSES = ["C", "M", "D", "U"];
export const ITEM_SEVERITIES = ["error", "warning", "info"];
export const HISTORY_MAX = 1000;
export const PROVENANCE_MAX = 50;
const SCREEN = { type: "integer", min: 320, max: 16384 };

const iso = (hint) => ({ type: "string", pattern: ISO_TIME, hint: hint || "a UTC time like \"2026-10-20T10:00:00Z\"" });
const isoOrNull = { ...iso(), nullable: true };

export const PROFILE_SCHEMA = {
  schema: { type: "integer", min: 1 },
  id: { type: "string", pattern: PROFILE_ID, hint: '"p-" and 16 hex digits' },
  name: { type: "string", pattern: NAME, hint: "a name of letters, digits, - and _ (up to 40, starting with a letter or digit)" },
  kind: { values: PROFILE_KINDS },
  revision: { type: "integer", min: 1 },
  status: { values: PROFILE_STATUSES },
  created: iso(),
  // The engine this profile was validated on (D10); null for one never launched on the native build.
  engine: { type: "object", nullable: true, fields: {
    major: { type: "string", pattern: MAJOR, hint: 'a major version like "150"' },
    build: { type: "string", pattern: BUILD, hint: 'a build like "150.0.7871.114"' },
  } },
  browser: { type: "object", fields: { kind: { values: BROWSER_KINDS } } },
  locale: { type: "object", fields: {
    languages: { type: "array", nullable: true, each: { type: "string", pattern: LANGUAGE, hint: 'a language tag like "de-DE"' }, maxItems: 10 },
    timezone: { type: "string", nullable: true, pattern: TIMEZONE, hint: 'a time zone name like "Europe/Berlin"' },
    source: { values: LOCALE_SOURCES },
  } },
  // null: this computer's screen (on a virtual screen, virtualScreen's size, E7).
  screen: { type: "object", nullable: true, fields: {
    width: SCREEN, height: SCREEN, availWidth: SCREEN, availHeight: SCREEN,
    colorDepth: { values: [16, 24, 30, 32] },
    devicePixelRatio: { type: "number", min: 0.5, max: 5 },
  } },
  window: { type: "object", nullable: true, fields: { width: SCREEN, height: SCREEN } },
  // null in a field: not set, the system's own.
  display: { type: "object", fields: {
    colorScheme: { values: ["light", "dark"], nullable: true },
    reducedMotion: { type: "boolean", nullable: true },
  } },
  graphics: { type: "object", fields: {
    backend: { values: GRAPHICS_BACKENDS },
    require: { type: "object", nullable: true, fields: {
      webgl: { values: [1, 2], nullable: true },
      webgpu: { type: "boolean" },
      platforms: { type: "array", each: { values: ["linux", "macos"] }, maxItems: 2 },
    } },
  } },
  // seed: a pinned persona seed (D3: one browser at a time), or null for a per-session one.
  persona: { type: "object", fields: {
    source: { values: PERSONA_SOURCES },
    seed: { type: "string", nullable: true, pattern: SEED, hint: "a seed of letters, digits, - and _ (up to 128)" },
  } },
  payments: { type: "object", fields: { savedCard: { type: "boolean" } } },
  // A Phase C network id (config.json network.proxies), never a server or credential.
  network: { type: "string", nullable: true, pattern: NETWORK_ID, hint: "a network id from config.json's network.proxies" },
  adBlocker: { type: "boolean", nullable: true },
  license: { type: "string", pattern: LICENSE, hint: 'an SPDX license id, "own-capture" or "unknown"' },
  // D17: where imported settings came from. The original file is never kept; its SHA-256 is.
  provenance: { type: "array", maxItems: PROVENANCE_MAX, each: { type: "object", fields: {
    format: { values: IMPORT_FORMATS },
    file: { type: "string", pattern: BASE_NAME, hint: "a file's base name" },
    sha256: { type: "string", pattern: SHA256, hint: "64 hex digits" },
    importedAt: iso(),
    by: { values: ["person"] },
    source: TEXT,
    license: { type: "string", pattern: LICENSE, hint: 'an SPDX license id, "own-capture" or "unknown"' },
    terms: { ...TEXT, nullable: true },
    collectedAt: isoOrNull,
    tool: { ...TEXT, nullable: true },
  } } },
  // D10, E8: evidence per engine build, never configuration (a measurement doesn't bump revision).
  validation: { type: "object", entries: { key: BUILD, value: { type: "object", fields: {
    status: { values: VALIDATION_STATUSES },
    at: iso(),
    pack: { type: "string", nullable: true, pattern: SHA256, hint: "the engine pack's SHA-256 (64 hex digits)" },
    runtimeKey: { type: "string", pattern: SHA256, hint: "64 hex digits" },
    graphics: { type: "object", open: true, maxJson: 20000 },
    items: { type: "array", maxItems: 500, each: { type: "object", fields: {
      field: { type: "string", pattern: FIELD, hint: 'a field like "locale.timezone"' },
      rule: { ...TEXT, maxLength: 80, nullable: true },
      class: { values: ITEM_CLASSES },
      status: { values: ITEM_STATUSES },
      requested: { any: true },
      measured: { any: true },
      severity: { values: ITEM_SEVERITIES },
      reason: { ...TEXT, maxLength: 300, nullable: true },
    } } },
  } } } },
  history: { type: "array", maxItems: HISTORY_MAX, each: { type: "object", fields: {
    revision: { type: "integer", min: 1 },
    at: iso(),
    change: { type: "array", maxItems: 50, each: { type: "string", pattern: FIELD, hint: 'a field like "locale.timezone"' } },
    by: { values: HISTORY_BY },
  } } },
};
// Keys an entry may leave out (every other key of an object spec is required).
const OPTIONAL = new Set(["validation.*.runtimeKey", "validation.*.graphics"]);

// D6: what a profile can never name, with the reason the refusal gives. Unknown keys are refused
// anyway; these say why, wherever in the record they stand.
const NEVER = {
  path: ["executablePath", "executable", "path", "binary", "browserPath", "userDataDir", "profileDir", "downloadsDir"],
  extension: ["extension", "extensions", "loadExtension", "crx"],
  "proxy server": ["proxy", "proxyServer", "proxies", "proxyAuth", "server", "username", "password"],
  "launch option": ["args", "browserArgs", "switches", "launchOptions", "env", "headless", "ignoreDefaultArgs",
    "ignoredArgs", "browserSandbox", "sandbox", "channel", "devtools", "remoteDebuggingPort", "executableArgs"],
  "agent option": ["agent", "agentOptions", "humanize", "typingPace", "motion", "formMove", "showCursor"],
  "canvas bridge": ["canvasBridge"],
  "hardware value": ["gpuVendor", "gpuRenderer", "gpuStringSpoof", "disableGpuFingerprint", "hardwareConcurrency", "deviceMemory",
    "maxTouchPoints", "platform", "platformVersion", "brand", "brandVersion", "webgl", "webgpu", "fonts", "audio", "speech", "codecs",
    "perf_memory", "media_devices", "canvas", "fingerprintProfile", "webrtcIp"],
};
const NEVER_WHY = new Map(Object.entries(NEVER).flatMap(([why, keys]) => keys.map((k) => [k, why])));
const NEVER_HELP = {
  "proxy server": 'choose a network by its id in "network" (config.json network.proxies)',
  "hardware value": "graphics and hardware are measured from this computer, never set (spec D-AP2)",
};
export const FORBIDDEN_KEYS = [...NEVER_WHY.keys()];

const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// Keys named only when they look like a field name; others counted.
const FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const kindOf = (v) => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : typeof v === "string" ? "a string" : typeof v === "number" ? (Number.isInteger(v) ? "a whole number" : "a number") : typeof v);
const shown = (v) => (typeof v === "number" || typeof v === "boolean" || v === null ? `${JSON.stringify(v)} (${kindOf(v)})` : kindOf(v));
const wrong = (key, spec, v) => `${key} is ${expected(spec)}, not ${shown(v)}`;

function validLanguage(tag) {
  try { return Intl.getCanonicalLocales(tag).length === 1; } catch { return false; }
}
function validTimezone(zone) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}
// Date.parse rolls impossible dates over (Feb 30 reads as Mar 2): the time read back must be the one written.
const validTime = (s) => {
  const t = Date.parse(s);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 19) === s.slice(0, 19);
};
// JSON text of v, or undefined when it has none (a BigInt, a cycle): checks never throw.
const jsonText = (v) => { try { return JSON.stringify(v); } catch { return undefined; } };

// One value against its spec at key; problems pushed to out (each a sentence without its period).
function checkValue(key, spec, v, out, starKey) {
  if (spec.any) {
    const t = jsonText(v);
    if (t === undefined || t.length > 2000) out.push(`${key} is a short JSON value`);
    return;
  }
  if (!fits(spec, v)) { out.push(wrong(key, spec, v)); return; }
  if (v === null) return;
  if (typeof v === "string") {
    if ((spec.maxLength !== undefined && v.length > spec.maxLength) || (spec.pattern && !spec.pattern.test(v))) { out.push(wrong(key, spec, v)); return; }
    if (spec.pattern === LANGUAGE && !validLanguage(v)) out.push(`${key} is not a language tag this computer knows`);
    if (spec.pattern === TIMEZONE && !validTimezone(v)) out.push(`${key} is not a time zone this computer knows`);
    if (spec.pattern === ISO_TIME && !validTime(v)) out.push(`${key} is not a real date and time`);
    return;
  }
  if (Array.isArray(v)) {
    if (spec.maxItems !== undefined && v.length > spec.maxItems) { out.push(`${key} holds at most ${spec.maxItems} entries, not ${v.length}`); return; }
    if (spec.each) v.forEach((x, i) => checkValue(`${key}[${i}]`, spec.each, x, out, `${starKey}[]`));
    return;
  }
  if (plainObject(v)) {
    if (spec.entries) {
      for (const [k, x] of Object.entries(v)) {
        if (!spec.entries.key.test(k)) { out.push(`${key} has an entry whose key isn't ${expected({ hint: 'a build like "150.0.7871.114"' })}`); continue; }
        checkValue(`${key}["${k}"]`, spec.entries.value, x, out, `${starKey}.*`);
      }
    } else if (spec.fields) checkObject(key, spec.fields, v, out, starKey, spec.open);
    if (spec.maxJson !== undefined) {
      const t = jsonText(v);
      if (t === undefined) out.push(`${key} is a JSON object`);
      else if (t.length > spec.maxJson) out.push(`${key} is at most ${spec.maxJson} characters as JSON`);
    }
  }
}

// An object's own keys against fields: unknown and forbidden keys named, missing ones named.
function checkObject(prefix, fields, given, out, starPrefix = prefix, open = false) {
  const at = (k) => (prefix ? `${prefix}.${k}` : k);
  const stars = (k) => (starPrefix ? `${starPrefix}.${k}` : k);
  const unknown = [];
  for (const [k, v] of Object.entries(given)) {
    // Own keys only: a key on Object.prototype ("constructor", "toString", "__proto__") is unknown.
    const known = Object.hasOwn(fields, k), why = NEVER_WHY.get(k);
    if (why && !known) { out.push(`${at(k)}: a profile can't name a ${why}${NEVER_HELP[why] ? `; ${NEVER_HELP[why]}` : ""}`); continue; }
    if (!known) { if (!open) unknown.push(k); continue; }
    checkValue(at(k), fields[k], v, out, stars(k));
  }
  for (const k of Object.keys(fields)) {
    if (!Object.hasOwn(given, k) && !OPTIONAL.has(stars(k).replace(/\["[^"]*"\]/g, ".*"))) out.push(`${at(k)} is missing (${expected(fields[k])})`);
  }
  if (unknown.length) {
    const named = unknown.filter((k) => FIELD_KEY.test(k)), other = unknown.length - named.length;
    const where = prefix ? `in ${prefix}` : "";
    const list = [...named.map((k) => `"${k}"`), ...(other ? [`${other} other${other > 1 ? "s" : ""}`] : [])].join(", ");
    out.push(`unknown key${unknown.length > 1 ? "s" : ""} ${list}${where ? ` ${where}` : ""} (a profile holds only its typed settings)`);
  }
}

// Rules across fields, on a record whose fields each passed.
function crossFieldProblems(p) {
  const out = [];
  if (p.screen) {
    if (p.screen.availWidth > p.screen.width) out.push(`screen.availWidth (${p.screen.availWidth}) is wider than screen.width (${p.screen.width})`);
    if (p.screen.availHeight > p.screen.height) out.push(`screen.availHeight (${p.screen.availHeight}) is taller than screen.height (${p.screen.height})`);
  }
  if (p.engine && !p.engine.build.startsWith(`${p.engine.major}.`)) out.push(`engine.build isn't a build of engine.major ${p.engine.major}`);
  const isDefault = p.name.toLowerCase() === DEFAULT_PROFILE;
  if (p.kind === "config" && p.name !== DEFAULT_PROFILE) out.push(`kind "config" is only the "${DEFAULT_PROFILE}" profile's (it is computed from config.json)`);
  if (p.kind === "store" && isDefault) out.push(`the name "${p.name}" is the config-backed profile's; choose another name`);
  if (p.kind === "config" && p.provenance.length) out.push(`the "${DEFAULT_PROFILE}" profile comes from config.json and has no imported provenance`);
  if (p.persona.source === "host" && p.persona.seed !== null) out.push("persona.seed is null when persona.source is \"host\" (this computer's own values)");
  const late = p.history.find((h) => h.revision > p.revision);
  if (late) out.push(`history has revision ${late.revision}, after the record's revision ${p.revision}`);
  return out;
}

// A record checked whole: { profile, problems }. profile: a copy of the record when it has no
// problem, else null (nothing in it is used); problems: one sentence each, naming the key. A
// record of another schema is refused here: profiles/upgrade.mjs reads older ones, newer ones are
// never read. Never throws.
export function checkProfile(raw) {
  if (!plainObject(raw)) return { profile: null, problems: [`a profile record is an object { ... }, not ${kindOf(raw)}.`] };
  if (raw.schema !== SCHEMA_VERSION) {
    const v = raw.schema;
    const problem = !Number.isInteger(v) || v < 1 ? "the record has no schema version this PairBrowse knows (schema is a whole number from 1)"
      : v > SCHEMA_VERSION ? `the record is schema ${v}, newer than this PairBrowse reads (${SCHEMA_VERSION}); update PairBrowse, the file is left as it is`
        : `the record is schema ${v}, older than ${SCHEMA_VERSION}; it is read through the upgrader (profiles/upgrade.mjs)`;
    return { profile: null, problems: [`${problem}.`] };
  }
  const out = [];
  checkObject("", PROFILE_SCHEMA, raw, out);
  if (!out.length) out.push(...crossFieldProblems(raw));
  if (out.length) return { profile: null, problems: out.map((p) => `${p}.`) };
  return { profile: structuredClone(raw), problems: [] };
}

// The first problem of a record as one sentence, or "".
export const profileProblem = (raw) => checkProfile(raw).problems[0] || "";

// A new record's settings before anyone chose any: the system's locale, screen and display, the
// browser's own graphics, a per-session seed, no saved card, the default network, config.json's
// ad blocker choice. The store adds schema, id, name, kind, revision, status, created and engine.
export function profileDefaults() {
  return {
    browser: { kind: "pairbrowse" },
    locale: { languages: null, timezone: null, source: "system" },
    screen: null,
    window: null,
    display: { colorScheme: null, reducedMotion: null },
    graphics: { backend: "auto", require: null },
    persona: { source: "seed", seed: null },
    payments: { savedCard: false },
    network: null,
    adBlocker: null,
    license: "own-capture",
    provenance: [],
    validation: {},
    history: [],
  };
}
