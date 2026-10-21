// The one schema for ~/.pairbrowse/config.json: each key's type and allowed values (Node's standard
// library only; no side effects). paths.mjs loadConfig checks the file with checkConfig: a key it
// doesn't know is kept and named in a warning; a value of the wrong type is refused (the default is
// used for that key) with a message naming the key, what it takes and what to do. saveConfig and the
// Settings route refuse such a value before anything is written (configProblem). Deeper checks stay
// where each setting is used (a tunnel's fields: tunnels/config.mjs; a browser path: browser/choice.mjs),
// except `network`'s, which the schema takes as written so net/config.mjs can fail closed (a
// broken block refuses sessions rather than turning them direct); configProblem asks it too.
import { checkNetwork } from "./net/config.mjs";
import { GRAPHICS_BACKENDS } from "./native/graphics.mjs";

// A spec: { type: "boolean" | "string" | "integer" | "number" | "array" | "object", nullable,
// values (one of these exact values), min, max (numbers), items (an array's items' type),
// fields (an object's own keys, each a spec), open (an object may hold keys besides its fields),
// refused (a key never used whatever its value: the reason, named with the key and the value left out) }.
const PORT = { type: "integer", min: 0, max: 65535 };
// The native engine's fingerprint options a user may set under "pairbrowse" (what the browser
// tells sites about itself: seed, persona, platform, GPU, screen, region). They only shape the
// fingerprint switches the engine builds; none names an extension, a program, a proxy, another
// server or a switch of its own.
export const PAIRBROWSE_ENGINE_KEYS = ["fingerprint", "fingerprintVoices", "fingerprintProfile", "fingerprintNoise", "platform", "platformVersion",
  "brand", "brandVersion", "gpuVendor", "gpuRenderer", "gpuStringSpoof", "disableGpuFingerprint", "hardwareConcurrency", "deviceMemory",
  "screenWidth", "screenHeight", "availWidth", "availHeight", "colorDepth", "devicePixelRatio", "maxTouchPoints", "lightStealth",
  "location", "timezone", "acceptLanguage", "webrtcIp", "webrtcMdns", "canvasNoise", "storageQuota", "tlsProfile"];
const NAMES = { type: "array", items: "string" };
// pairbrowse.profileSelect (spec server-mode D8, F2): closed to the engine pack's persona-picking
// options, which PairBrowse no longer uses (D9: "auto" and "local" are this computer), kept so an
// older config.json still reads. Options that would run a program, ask another service or fetch
// files (the pack's persona library) are refused by name and never reach the launch.
export const PROFILE_SELECT_REFUSED = ["python", "converter", "apiBase", "licenseKey", "localDir", "autoDownload", "autoDownloadCount"];
const REFUSED_SELECT = "refused: PairBrowse never runs a program, asks a service or fetches files to pick a persona (spec D8)";
export const PROFILE_SELECT = {
  type: "object", fields: {
    os: { type: "string" }, mode: { values: ["best", "random", "rotate"] }, topN: { type: "integer", min: 1, max: 1000 },
    key: { type: "string" }, preferLocal: { type: "boolean" }, offline: { type: "boolean" },
    maxEncodedSize: { type: "integer", min: 0 }, quiet: { type: "boolean" },
    ...Object.fromEntries(PROFILE_SELECT_REFUSED.map((k) => [k, { refused: REFUSED_SELECT }])),
  },
};
export const CONFIG_SCHEMA = {
  browser: { type: "string", nullable: true, hint: '"pairbrowse", "pairbrowse-open" or an absolute path to a browser' },
  // Older names, still read while "browser" is unset (browser/choice.mjs), never written.
  browserEngine: { type: "string", nullable: true, older: true },
  executablePath: { type: "string", nullable: true, older: true },
  browserDriver: { values: ["patchright", "playwright"] },
  participantName: { type: "string", nullable: true },
  maxTabs: { type: "integer", min: 1 },
  screenshots: { type: "boolean" },
  phishingProtection: { type: "boolean" },
  adBlocker: { type: "boolean" },
  safeStorage: { values: ["file", "keychain"] },
  downloadsDir: { type: "string", nullable: true },
  browserArgs: NAMES,
  // "required": on, and never off on Linux either (browser-args.mjs sandboxRequired).
  browserSandbox: { values: [true, false, "required"] },
  // Their older names, still read while the new one is unset (browser-args.mjs), never written.
  chromeArgs: { ...NAMES, older: true },
  chromeSandbox: { type: "boolean", older: true },
  display: { values: ["auto", "xvfb", "none"] },
  // Depth 30 stays out until measured on a server's Xvfb.
  virtualScreen: { type: "object", fields: { width: { type: "integer", min: 800, max: 7680 }, height: { type: "integer", min: 600, max: 4320 }, depth: { values: [16, 24] } } },
  server: { type: "object", fields: { keepAlive: { type: "boolean" } } },
  // Hand-off to a person away from the window (spec server-mode B1, B6, B11, decisions U2 and 8).
  // channels: each an object whose own fields daemon/notify/ checks (a channel it can't use is
  // skipped with a warning naming it); remindMinutes at or above grantMinutes falls back
  // (handoffTimes).
  handoff: {
    type: "object", fields: {
      enabled: { type: "boolean" },
      away: { type: "boolean" },
      publicLink: { type: "boolean" },
      grantMinutes: { type: "integer", min: 1, max: 120 },
      remindMinutes: { type: "integer", min: 1 },
      channels: { type: "array", items: "object" },
    },
  },
  // Per-session proxies (spec server-mode C4): any value is kept as written and checked by
  // net/config.mjs checkNetwork, whose warnings loadConfig adds; never dropped for the default
  // (that would make a proxied session direct).
  network: { nullable: true, hint: 'an object { "proxies": { ... }, "default", "sessions", "strict", "checkUrl", "recheckMinutes" } (net/config.mjs)' },
  // Browser profiles (spec server-mode D10): only validated ones launch (profiles/store.mjs records).
  requireValidatedProfiles: { type: "boolean" },
  liveViewPort: PORT,
  liveViewHosts: NAMES,
  inviteBaseUrl: { type: "string", nullable: true },
  joinHosts: NAMES,
  sharing: { type: "object", fields: { tunnel: { type: "object", open: true }, guestPort: { ...PORT, nullable: true } } },
  timeline: { type: "boolean" },
  timelineCap: { type: "integer", min: 1, max: 200 },
  layout: { type: "object", fields: { left: { values: ["open", "rail", "hidden"] }, right: { values: ["open", "rail", "hidden"] }, strip: { type: "integer", min: 44, max: 176 } } },
  reportUrl: { type: "string", nullable: true },
  cookieChoice: { values: ["accept", "reject"] },
  sessionPicker: { type: "boolean" },
  settleMs: { type: "integer", nullable: true, min: 0, max: 5000 },
  dockWidth: { type: "number", nullable: true, min: 0 },
  dockHost: { type: "string" },
  dockTop: { type: "number", min: 0 },
  dockMakeRoom: { type: "boolean" },
  // The native build's own settings (native-engine.mjs readSettings, native/humanize.mjs) and the
  // engine's fingerprint options (PAIRBROWSE_ENGINE_KEYS, checked by the engine at launch). Closed:
  // any other key (extensions, a proxy, launch options, switches) is named as unknown here and
  // never reaches the launch (readSettings leaves it out and logs it).
  pairbrowse: {
    type: "object", fields: {
      profile: { type: "string", nullable: true },
      profileSelect: PROFILE_SELECT,
      humanize: { type: "boolean" },
      showCursor: { type: "boolean" },
      geoip: { type: "boolean" },
      typingPace: { type: "number", min: 0.2, max: 1 },
      motion: { values: ["fast", "quick", "combined", "classic"] },
      // The adaptive input pace (native/pace.mjs): the everyday pace only where the input is scored.
      inputPace: { values: ["adaptive", "fast", "human"] },
      formMove: { values: ["tab", "mouse"] },
      // The default profile's graphics.backend (spec server-mode E2; native/graphics.mjs graphicsPlan).
      graphics: { values: GRAPHICS_BACKENDS },
      // Noise over the identity shown on a host without a GPU (decision 10: the engine's canvas
      // noise and its canvas and WebGL readback noise, fingerprintNoise and canvasNoise; default
      // false, as the measurement of decision 11 decided). On a host with a GPU the real
      // pixels get no noise, whatever this says.
      graphicsNoise: { type: "boolean" },
      // The open stand-ins under the Windows font names in the browser's font configuration on
      // Linux, once the server setup has run (native/fontconf.mjs, spec step 52): default false
      // until the ordinary-browser measurement decides.
      fontStandIns: { type: "boolean" },
      ...Object.fromEntries(PAIRBROWSE_ENGINE_KEYS.map((k) => [k, {}])),
    },
  },
};

const TYPE_WORDS = { boolean: "true or false", string: "a string", integer: "a whole number", number: "a number", array: "a list", object: "an object { ... }" };

// What a spec takes, in words: 'true or false', 'a whole number from 1 to 200', '"auto", "xvfb" or "none"'.
export function expected(spec) {
  let s;
  if (spec.values) s = spec.values.map((v) => JSON.stringify(v)).join(", ").replace(/, ([^,]*)$/, " or $1");
  else if (spec.hint) s = spec.hint;
  else {
    s = TYPE_WORDS[spec.type];
    if (spec.type === "array" && spec.items) s = `a list of ${spec.items}s`;
    if (spec.min !== undefined && spec.max !== undefined) s += ` from ${spec.min} to ${spec.max}`;
    else if (spec.min !== undefined) s += ` of ${spec.min} or more`;
  }
  return spec.nullable ? `${s}, or null` : s;
}

const kindOf = (v) => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : typeof v === "string" ? "a string" : typeof v === "number" ? (Number.isInteger(v) ? "a whole number" : "a number") : typeof v);
const shown = (v) => { const t = JSON.stringify(v); return t === undefined ? String(v) : t.length > 60 ? `${t.slice(0, 57)}...` : t; };
const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// Whether value fits spec (its own type and values; an object's fields are checked one by one by the caller).
export function fits(spec, v) {
  if (v === null) return !!spec.nullable;
  if (spec.values) return spec.values.includes(v);
  switch (spec.type) {
    case "boolean": return typeof v === "boolean";
    case "string": return typeof v === "string";
    case "integer": case "number":
      if (typeof v !== "number" || !Number.isFinite(v) || (spec.type === "integer" && !Number.isInteger(v))) return false;
      return (spec.min === undefined || v >= spec.min) && (spec.max === undefined || v <= spec.max);
    case "array": return Array.isArray(v) && (!spec.items || v.every((x) => (spec.items === "object" ? plainObject(x) : typeof x === spec.items)));
    case "object": return plainObject(v);
    default: return true;
  }
}

// The message for a wrong value at key (a dotted name for a nested one).
export function wrongValue(key, spec, value) {
  return `${key} is ${expected(spec)}, not ${shown(value)} (${kindOf(value)})`;
}

// Checks one object against fields: { value, unknown: [dotted names], wrong: [messages] }. A wrong
// value is left out of value (the caller's default applies); an unknown one is kept.
function checkFields(given, fields, open, prefix, out) {
  const value = {};
  for (const [k, v] of Object.entries(given)) {
    const name = prefix ? `${prefix}.${k}` : k;
    const spec = fields[k];
    if (!spec) { if (!open) out.unknown.push(name); value[k] = v; continue; }
    if (v === undefined) continue;
    if (spec.refused) { out.wrong.push(`${name} is ${spec.refused}`); continue; }
    if (!fits(spec, v)) { out.wrong.push(wrongValue(name, spec, v)); continue; }
    value[k] = spec.type === "object" && spec.fields && v !== null ? checkFields(v, spec.fields, spec.open, name, out) : v;
  }
  return value;
}

// The file's contents checked: { config: what to use (wrong values left out), unknown: [key names],
// wrong: [one message each] }. A file that isn't an object: nothing used, one message.
export function checkConfig(raw) {
  const out = { unknown: [], wrong: [] };
  if (raw === undefined || raw === null) return { config: {}, ...out };
  if (!plainObject(raw)) return { config: {}, unknown: [], wrong: [`the file is ${kindOf(raw)}, not an object { ... }`] };
  return { config: checkFields(raw, CONFIG_SCHEMA, false, "", out), ...out };
}

// The first wrong value among fields about to be written, as a sentence, or "" (unknown keys are
// let through: the file is the person's own).
export function configProblem(fields) {
  if (!plainObject(fields)) return "config.json's settings are an object { ... }; nothing was written.";
  const { wrong } = checkConfig(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
  if (wrong.length) return `${wrong[0]}; nothing was written.`;
  const net = fields.network === undefined ? null : checkNetwork(fields.network);
  return net?.messages.length ? `${net.messages[0]}; nothing was written.` : "";
}

// The hand-off's grant life and reminder time in minutes: { grantMinutes, remindMinutes, warning }.
// A reminder at or after the grant's end would never come, so it falls back to two thirds of the
// grant's life (at least a minute), with a warning saying so ("" when none).
export function handoffTimes({ grantMinutes, remindMinutes }) {
  if (remindMinutes < grantMinutes) return { grantMinutes, remindMinutes, warning: "" };
  const fallback = Math.max(1, Math.floor((grantMinutes * 2) / 3));
  return { grantMinutes, remindMinutes: fallback, warning: `config.json: handoff.remindMinutes (${remindMinutes}) is at or after handoff.grantMinutes (${grantMinutes}); reminding after ${fallback} minute${fallback === 1 ? "" : "s"} instead` };
}

// The warnings loadConfig gives (one line each), naming the file and what to do.
export function configWarnings({ unknown, wrong }, file) {
  const lines = [];
  for (const w of wrong) lines.push(`config.json: ${w}; using the default for it until it is fixed in ${file}`);
  if (unknown.length) lines.push(`config.json: unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")} (not used: check the spelling against docs/configuration.md) in ${file}`);
  return lines;
}
