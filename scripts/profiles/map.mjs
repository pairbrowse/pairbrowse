// A browser profile to and from what a launch uses (spec server-mode Phase D, D1, D6, D11, D12).
//
// fromConfig(config): the settings config.json gives the config-backed "default" profile (D5;
// profiles/store.mjs configProfile takes them): `browser` (and its older names) as browser.kind,
// the screened browserArgs' --lang, --window-size, --force-device-scale-factor, --force-dark-mode,
// --force-prefers-reduced-motion and --force-prefers-no-reduced-motion, and, when config starts
// the native build, the pairbrowse block's time zone, languages, screen keys, seed, geoip, graphics
// backend (E2) and persona choice (D9). It never rewrites config.json, and the switches stay in
// browserArgs as written. What it doesn't read
// is reported (readConfig's items), never dropped quietly: another device's hardware keys stay
// config.json-only legacy (decision U6), helper-wide settings stay global, the network block is
// operator config (a network change never changes a profile, so never its revision).
//
// toLaunch(profile, { browserKind, platform }): one checked record as a launch's parts. Typed
// fields only (D6): switches from SWITCHES, each passing browser-args.mjs screenBrowserArgs as it
// is; engine keys from ENGINE_KEYS (all in config-schema.mjs PAIRBROWSE_ENGINE_KEYS); never a
// path, extension, proxy server, launch or agent option. A field the person set that the chosen
// browser can't apply refuses the launch (D11, `problem`); the open build applies switches only.
// Values the launch works out (geoip, this computer's Intl, the build's platform and version)
// are reported `derived` and never written into the profile (D12).
//
// Report items take D10's shape ({ field, rule, class, status, requested, measured, severity,
// reason }); `requested` holds only a value applied from the profile, never a seed or a string
// read from config.json. Pure; Node's standard library only.
import { isAbsolute } from "node:path";
import { PAIRBROWSE_ENGINE_KEYS } from "../config-schema.mjs";
import { screenBrowserArgs, browserArgsOf, switchName, allowedBrowserArg } from "../browser-args.mjs";
import { SETTINGS, DEFAULT_PROFILE, SCHEMA_VERSION, checkProfile, profileDefaults } from "./schema.mjs";
import { item, languagesOf, reportable } from "./device.mjs";
import { graphicsPlan, GRAPHICS_BACKENDS } from "../native/graphics.mjs";

// D9: config.json's persona "auto" and "local" (once the engine pack's pick from a library or a
// service) are read as this computer; the note the launch log and pairbrowse_status give.
export const PICKS_THIS_COMPUTER = ["auto", "local"];
export const THIS_COMPUTER_NOTE = "PairBrowse no longer picks another device's profile; graphics come from this computer";

// Every switch the mapper can add, and every engine key it can set (D6); the fuzz test holds it to these.
export const SWITCHES = Object.freeze(["lang", "window-size", "force-dark-mode", "force-prefers-reduced-motion", "force-prefers-no-reduced-motion", "use-angle"]);
// Why a display setting can't start (toLaunch's refusals, also said at import and selection: buildFit).
export const LIGHT_ON_EXTENSION = "PairBrowse as an extension can't give pages a light scheme: no switch forces one, and its Appearance setting would turn its whole window light too (the native PairBrowse browser applies it; null follows this computer)";
export const DARK_FORCED = "config.json's browserArgs has --force-dark-mode, which asks for a dark scheme, while the profile asks for light (remove that switch, or set the profile's colorScheme to dark or null)";
export const REDUCED_MOTION_FORCED = "config.json's browserArgs has --force-prefers-reduced-motion, which the browser checks first, so reduced motion can't be off (remove that switch, or set the profile's reducedMotion to true or null)";
export const ENGINE_KEYS = Object.freeze(["acceptLanguage", "timezone", "screenWidth", "screenHeight", "availWidth", "availHeight", "colorDepth", "devicePixelRatio", "fingerprint"]);
const BUILD_NAMES = { pairbrowse: "the native PairBrowse browser", "pairbrowse-open": "PairBrowse as an extension" };
// config.json's pairbrowse keys this module reads into a profile.
const READ_KEYS = ["acceptLanguage", "timezone", "geoip", "screenWidth", "screenHeight", "availWidth", "availHeight", "colorDepth", "devicePixelRatio", "fingerprint", "profile", "graphics"];
// Another device's hardware and the build's identity: config.json-only legacy (decision U6).
const HARDWARE_KEYS = ["gpuVendor", "gpuRenderer", "gpuStringSpoof", "disableGpuFingerprint", "hardwareConcurrency", "deviceMemory", "maxTouchPoints",
  "platform", "platformVersion", "brand", "brandVersion", "fingerprintVoices"];
// The helper's own settings in the pairbrowse block: global, never a profile's.
const GLOBAL_KEYS = ["humanize", "showCursor", "typingPace", "motion", "formMove"];
const SEED = /^(?!off$)[A-Za-z0-9_-]{1,128}$/;
const MAP_RULE = "profile.map";
const CONFIG_RULE = "config.map";

const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// The browser.kind config.json starts (browser/choice.mjs browserChoice, read the same way): the
// native build for "pairbrowse" (or the older browserEngine "pairbrowse"); the open build for its
// names, a browser of your own by its path (launched like it; an executablePath only with
// browserEngine "chromium", "auto" or unset) or anything else; unset, the native build where one
// is pinned for this computer (native).
export function browserKindOf(config = {}, { native = false } = {}) {
  const given = config?.browser;
  if (typeof given === "string") return given === "pairbrowse" ? "pairbrowse" : "pairbrowse-open";
  const engine = config?.browserEngine;
  if (engine === "pairbrowse") return "pairbrowse";
  const path = typeof config?.executablePath === "string" && config.executablePath;
  if (path && (engine === "chromium" || engine === "auto" || engine == null)) return "pairbrowse-open";
  if (engine === "chromium") return "pairbrowse-open";
  return native ? "pairbrowse" : "pairbrowse-open";
}

// Tags without repeats (case-insensitively), the first ten.
function firstTen(list) {
  const seen = new Set(), out = [];
  for (const t of list) {
    if (typeof t !== "string" || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return { languages: out.slice(0, 10), dropped: Math.max(0, out.length - 10) };
}

// A neutral config-backed record around settings, for checkProfile (the store checks the real one).
const asRecord = (settings) => ({ schema: SCHEMA_VERSION, id: "p-0000000000000000", name: DEFAULT_PROFILE, kind: "config", revision: 1, status: "active",
  created: "2026-01-01T00:00:00Z", engine: null, ...profileDefaults(), ...settings, license: "own-capture", provenance: [] });
const settingsOnly = (o) => Object.fromEntries(SETTINGS.map((k) => [k, structuredClone(o[k])]));

// Each settings section whose value doesn't make a valid record goes back to the default, with an
// item naming the section and the check's sentence (which repeats no string).
function keepValid(settings, items) {
  const defaults = settingsOnly(profileDefaults());
  for (let round = 0; round <= SETTINGS.length; round++) {
    const { problems } = checkProfile(asRecord(settings));
    if (!problems.length) return settings;
    const bad = new Set();
    for (const p of problems) {
      const section = /^([A-Za-z]+)/.exec(p)?.[1];
      if (SETTINGS.includes(section)) bad.add(section);
    }
    if (!bad.size) break;
    for (const k of bad) {
      const why = problems.find((p) => p.startsWith(k));
      items.push(item(k, "not-applied", "C", `config.json's value doesn't fit a profile's ${k} and isn't read into it: ${why}`, { severity: "warning", rule: CONFIG_RULE }));
      settings[k] = defaults[k];
    }
  }
  if (checkProfile(asRecord(settings)).problems.length) {
    items.push(item("(settings)", "not-applied", "C", "config.json's values don't make a valid profile; the defaults are used", { severity: "warning", rule: CONFIG_RULE }));
    return defaults;
  }
  return settings;
}

// What config.json gives the config-backed profile, with a report: { settings, items }. settings
// holds every SETTINGS key and makes a valid record (a value that doesn't fit is left at its
// default and reported). native: a build is pinned for this computer (browserKindOf); platform:
// "darwin" reads persona "auto" and "local" as the host capture, elsewhere the seed persona (D9).
export function readConfig(config = {}, { native = false, platform = process.platform } = {}) {
  const cfg = plainObject(config) ? config : {};
  const items = [];
  const report = (field, status, cls, reason, severity = "info") => items.push(item(field, status, cls, reason, { severity, rule: CONFIG_RULE }));
  const settings = settingsOnly(profileDefaults());
  const kind = browserKindOf(cfg, { native });
  settings.browser = { kind };
  if (typeof cfg.browser === "string" && isAbsolute(cfg.browser)) {
    report("browser", "not-applied", "C", "a browser of your own by its path stays in config.json; it starts like PairBrowse as an extension");
  }

  // The switches that pass the screen, as the launch passes them; one read only when every copy agrees.
  const kept = screenBrowserArgs(browserArgsOf(cfg), platform, { harness: false }).kept;
  const valuesOf = (name) => kept.filter((a) => switchName(a, platform) === name).map((a) => (a.includes("=") ? a.slice(a.indexOf("=") + 1) : null));
  const has = (name) => valuesOf(name).length > 0;
  function single(name) {
    const values = [...new Set(valuesOf(name))];
    if (values.length > 1) report(`browserArgs`, "not-applied", "C", `more than one --${name} with different values; kept as written, not read into the profile`, "warning");
    return values.length === 1 ? values[0] : undefined;
  }
  const lang = single("lang");
  const size = /^(\d{1,5}),(\d{1,5})$/.exec(single("window-size") ?? "");
  const scale = single("force-device-scale-factor");
  // A backend switch in browserArgs stays there as written; the backend a profile asks for is its
  // graphics.backend (the native build's pairbrowse.graphics below), and the one in use is measured.
  for (const name of ["use-gl", "use-angle", "disable-gpu"]) {
    if (has(name)) report("browserArgs", "not-applied", "M", `--${name} is kept in browserArgs as written; the backend in use is measured after launch (Phase E)`);
  }

  // The pairbrowse block is the native build's: on the open build it is read by nothing, as today.
  const block = plainObject(cfg.pairbrowse) ? cfg.pairbrowse : {};
  const pb = kind === "pairbrowse" ? block : {};
  if (kind !== "pairbrowse" && Object.keys(block).length) report("pairbrowse", "not-applied", "C", "the native build's settings; config.json starts PairBrowse as an extension, which reads none of them");

  // Locale: the pairbrowse block's languages, else --lang; its time zone; geoip.
  let languages = null;
  if (typeof pb.acceptLanguage === "string") {
    const read = firstTen(languagesOf(pb.acceptLanguage));
    if (read.dropped) report("pairbrowse.acceptLanguage", "not-applied", "C", `${read.dropped} more language${read.dropped > 1 ? "s" : ""} past the first ten; a profile holds ten`, "warning");
    if (read.languages.length) languages = read.languages;
  } else if (pb.acceptLanguage !== undefined) report("pairbrowse.acceptLanguage", "not-applied", "C", "not a list of languages; not read", "warning");
  if (!languages && typeof lang === "string") languages = [lang.replace(/_/g, "-")];
  let timezone = null;
  if (typeof pb.timezone === "string") timezone = pb.timezone;
  else if (pb.timezone !== undefined) report("pairbrowse.timezone", "not-applied", "C", "not a time zone name; not read", "warning");
  const geoip = pb.geoip === true;
  settings.locale = { languages, timezone, source: geoip ? "geoip" : languages || timezone ? "set" : "system" };

  // Screen: a width and a height make one; the rest as the import fills them (D15).
  const width = num(pb.screenWidth), height = num(pb.screenHeight);
  const ratio = num(pb.devicePixelRatio) ?? (scale !== undefined ? Number(scale) : undefined);
  if (width !== undefined && height !== undefined) {
    settings.screen = { width, height, availWidth: num(pb.availWidth) ?? width, availHeight: num(pb.availHeight) ?? height,
      colorDepth: num(pb.colorDepth) ?? 24, devicePixelRatio: ratio ?? 1 };
  } else {
    const partial = ["screenWidth", "screenHeight", "availWidth", "availHeight", "colorDepth", "devicePixelRatio"].filter((k) => pb[k] !== undefined);
    if (partial.length) report("pairbrowse", "not-applied", "C", `${partial.join(", ")} without both screenWidth and screenHeight: kept in config.json, not read into the profile (a profile's screen takes a width and a height)`, "warning");
    else if (scale !== undefined) report("browserArgs", "not-applied", "C", "--force-device-scale-factor without a screen size: kept in browserArgs as written (a profile's screen takes a width and a height)");
  }
  if (size) settings.window = { width: Number(size[1]), height: Number(size[2]) };
  // The engine checks --force-prefers-reduced-motion first, so it wins when both are given.
  settings.display = { colorScheme: has("force-dark-mode") ? "dark" : null,
    reducedMotion: has("force-prefers-reduced-motion") ? true : has("force-prefers-no-reduced-motion") ? false : null };
  // The backend (E2): the native build's pairbrowse.graphics, else this computer's ("auto").
  if (pb.graphics !== undefined && !GRAPHICS_BACKENDS.includes(pb.graphics)) report("pairbrowse.graphics", "not-applied", "M", `not one of ${GRAPHICS_BACKENDS.map((b) => `"${b}"`).join(", ")}; not read`, "warning");
  settings.graphics = { backend: GRAPHICS_BACKENDS.includes(pb.graphics) ? pb.graphics : "auto", require: null };

  // Persona (D9): "auto" and "local" are this computer; a saved persona's name is offered for
  // import (spec step 38) and read in place until then; the seed.
  let source = "seed", seed = null;
  if (PICKS_THIS_COMPUTER.includes(pb.profile)) {
    source = platform === "darwin" ? "host" : "seed";
    report("pairbrowse.profile", "derived", "D", `${THIS_COMPUTER_NOTE} (spec D9)`);
  } else if (typeof pb.profile === "string" && pb.profile) {
    report("pairbrowse.profile", "not-applied", "C", "a saved persona: offered for import when profiles are set up, read in place until then", "warning");
  }
  const givenSeed = typeof pb.fingerprint === "number" && Number.isSafeInteger(pb.fingerprint) ? String(pb.fingerprint) : pb.fingerprint;
  if (typeof givenSeed === "string" && SEED.test(givenSeed)) {
    if (source === "host") report("pairbrowse.fingerprint", "not-applied", "C", "a seed isn't used with this computer's own values (pairbrowse.profile)", "warning");
    else seed = givenSeed;
  } else if (givenSeed !== undefined) report("pairbrowse.fingerprint", "not-applied", "C", "not a seed a profile holds (letters, digits, - and _, never \"off\"); kept in config.json", "warning");
  settings.persona = { source, seed };
  settings.payments = { savedCard: false };
  settings.network = null;
  settings.adBlocker = typeof cfg.adBlocker === "boolean" ? cfg.adBlocker : null;

  // Everything else in the pairbrowse block, named (counted when its name isn't a field name).
  let unnamed = 0;
  for (const k of Object.keys(pb)) {
    if (READ_KEYS.includes(k)) continue;
    if (!reportable(k)) { unnamed++; continue; }
    const field = `pairbrowse.${k}`;
    if (HARDWARE_KEYS.includes(k)) report(field, "unsupported", "D", "another device's hardware or the build's identity: stays a config.json setting for one release (decision U6), never a profile's", "warning");
    else if (k === "fingerprintProfile") report(field, "unsupported", "U", "a profile from a library of other devices: never a profile's (spec D9)", "warning");
    else if (k === "profileSelect") report(field, "not-applied", "U", "PairBrowse picks no other device's profile (spec D9)");
    else if (GLOBAL_KEYS.includes(k)) report(field, "not-applied", "U", "a helper-wide setting, not a profile's");
    else if (PAIRBROWSE_ENGINE_KEYS.includes(k)) report(field, "not-applied", "U", "an engine option kept in config.json, not a profile's");
    else report(field, "not-applied", "U", "not a setting PairBrowse knows");
  }
  if (unnamed) report("pairbrowse.(unnamed)", "not-applied", "U", `${unnamed} key${unnamed > 1 ? "s" : ""} with names that aren't field names; not read`);
  return { settings: keepValid(settings, items), items };
}

// The settings config.json gives the config-backed profile (readConfig without its report).
export const fromConfig = (config, options) => readConfig(config, options).settings;

// What a profile's settings can't do on a browser, said before any launch (D11): at import (on the
// browser the profile is for) and when a session is put on it (on the browser the next launch
// starts), so a setting is never accepted quietly and found only by a launch that fails.
// browserKind: the browser (default: the profile's own, browser.kind); platform and userArgs as
// toLaunch's. Answers { items, problem }: toLaunch's refusing items (status "unsupported" or
// "mismatch", each naming its field and reason) and one sentence naming them all, or null. Pure.
export function buildFit(profile, { browserKind = null, platform = process.platform, userArgs = [] } = {}) {
  const kind = browserKind ?? profile?.browser?.kind;
  const mapped = toLaunch(profile, { browserKind: kind, platform, userArgs });
  const items = mapped.results.filter((r) => r.severity === "error");
  if (!items.length) return { items: [], problem: mapped.problem ? mapped.problem.replace(/ Change the profile or the browser; nothing was started\.$/, ".") : null };
  const name = typeof profile?.name === "string" ? profile.name : "(unnamed)";
  return { items, problem: `Browser profile "${name}" can't start on ${BUILD_NAMES[kind] || "this browser"}: ${items.map((r) => `${r.field} (${r.reason})`).join("; ")}.` };
}

// One checked record as a launch's parts: { switches, engineKeys, prefs, geoip, network, adBlocker,
// results, problem }. browserKind: the browser this launch starts ("pairbrowse" or
// "pairbrowse-open"; a browser of your own by its path is "pairbrowse-open"); platform: the
// switches' screen and D9's host capture (macOS). results: one item per setting (applied,
// derived, not-applied or, refusing, unsupported or mismatch with severity "error"), for
// validation[build] (D10; the caller files them under its build). problem: null, or the sentence
// that refuses the launch (D11), naming the profile and every field it can't apply; with a
// problem, switches and engine keys are empty. prefs: { savedCard: true } when the profile asks for
// a saved card (the launch writes it only with a real key store), and colorScheme ("light" or
// "dark", native only) for the browser's Appearance setting the launch writes. network: the profile's network id for
// net/config.mjs networkFor's profileNetwork; adBlocker: its choice (null: config.json's).
// userArgs: config.json's browserArgs as the launch passes them (the graphics plan refuses a
// renderer switch the profile's backend contradicts). The profile is never changed. Never throws.
export function toLaunch(profile, { browserKind, platform = process.platform, userArgs = [] } = {}) {
  const switches = [], engineKeys = {}, prefs = {}, results = [];
  const empty = (problem) => ({ switches: [], engineKeys: {}, prefs: {}, geoip: false, network: null, adBlocker: null, results, problem });
  const { profile: p, problems } = checkProfile(profile);
  if (!p) return empty(`The browser profile can't start: ${problems[0]}`);
  if (!Object.hasOwn(BUILD_NAMES, browserKind)) return empty(`Browser profile "${p.name}" can't start: the browser kind is "pairbrowse" or "pairbrowse-open".`);
  const native = browserKind === "pairbrowse";
  const build = BUILD_NAMES[browserKind];
  const add = (field, status, cls, reason, { requested = null, severity = "info" } = {}) => results.push(item(field, status, cls, reason, { requested, severity, rule: MAP_RULE }));
  const applied = (field, cls, reason, requested = null) => add(field, "applied", cls, reason, { requested });
  const derived = (field, cls, reason) => add(field, "derived", cls, reason);
  const refuse = (field, cls, reason, status = "unsupported") => add(field, status, cls, reason, { severity: "error" });

  if (p.browser.kind !== browserKind) refuse("browser.kind", "C", `the profile is for ${BUILD_NAMES[p.browser.kind]}, and this launch starts ${build}`, "mismatch");

  // Locale (matrix: acceptLanguage and --lang; the timezone key; geoip on the native build only).
  const { languages, timezone, source } = p.locale;
  if (languages) {
    const langSwitch = `--lang=${languages[0]}`;
    const takesLang = allowedBrowserArg(langSwitch, platform);
    if (native) {
      engineKeys.acceptLanguage = languages.join(",");
      applied("locale.languages", "C", "sent as Accept-Language and navigator.languages", languages);
      if (takesLang) switches.push(langSwitch);
      else add("locale.languages", "not-applied", "C", "the first language isn't one --lang takes, so the browser's own interface language stays; pages still get the languages", { severity: "warning" });
    } else if (!takesLang) refuse("locale.languages", "C", "the first language isn't one --lang takes, and PairBrowse as an extension sets languages only through it");
    else {
      switches.push(langSwitch);
      applied("locale.languages", "C", "the first language as the browser's language (--lang)", languages.slice(0, 1));
      if (languages.length > 1) add("locale.languages", "not-applied", "C", `PairBrowse as an extension takes only the first language; ${languages.length - 1} more aren't sent`, { severity: "warning" });
    }
  } else derived("locale.languages", "C", source === "geoip" && native ? "from the exit address at each launch (geoip)" : "this computer's at each launch");
  if (timezone) {
    if (native) { engineKeys.timezone = timezone; applied("locale.timezone", "C", "the time zone pages read", timezone); } else refuse("locale.timezone", "C", "PairBrowse as an extension can't set a time zone");
  } else derived("locale.timezone", "C", source === "geoip" && native ? "from the exit address at each launch (geoip)" : "this computer's at each launch");
  const geoip = source === "geoip";
  if (geoip) {
    if (native) applied("locale.source", "C", "time zone and languages not set here follow the exit address (geoip), looked up at each launch and never kept");
    else refuse("locale.source", "C", "PairBrowse as an extension has no geoip");
  }

  // Screen (the screen engine keys, native only) and window (--window-size).
  if (p.screen) {
    if (native) {
      const s = p.screen;
      Object.assign(engineKeys, { screenWidth: s.width, screenHeight: s.height, availWidth: s.availWidth, availHeight: s.availHeight, colorDepth: s.colorDepth, devicePixelRatio: s.devicePixelRatio });
      applied("screen", "C", "the screen pages read", { ...s });
    } else refuse("screen", "C", "PairBrowse as an extension can't set a screen (null: this computer's)");
  } else derived("screen", "C", "this computer's (on a virtual screen, its size)");
  if (p.window) {
    switches.push(`--window-size=${p.window.width},${p.window.height}`);
    applied("window", "C", "the window's size (--window-size)", { ...p.window });
  } else derived("window", "C", "the browser's own");

  // Display. The color scheme pages read: the engine has a switch for dark only (--force-dark-mode,
  // which pages follow only while the browser's Appearance setting is "System"). On the native build
  // pages follow that setting (browser.theme.color_scheme2, the browser's own window stays its
  // own colors), so the launch sets it to the profile's light or dark (prefs.colorScheme,
  // browser.mjs profilePreferences); on PairBrowse as an extension that setting turns the whole
  // window light too, so light stays refused there. Reduced motion: a switch each way
  // (--force-prefers-reduced-motion, --force-prefers-no-reduced-motion); the engine checks the
  // first before the second, so a reduced-motion switch in config.json's browserArgs would win
  // over a profile's false. Either clash with config.json's browserArgs (a dark switch beside a
  // profile's light, whose Appearance setting would then keep the switch from pages) is a named
  // mismatch, never settled quietly.
  const { colorScheme, reducedMotion } = p.display;
  if (colorScheme === "dark") {
    switches.push("--force-dark-mode");
    if (native) prefs.colorScheme = "dark";
    applied("display.colorScheme", "C", native ? "the browser's Appearance setting at Dark, which pages follow, and --force-dark-mode" : "--force-dark-mode", "dark");
  } else if (colorScheme === "light") {
    if (native && userArgs.some((a) => switchName(a, platform) === "force-dark-mode")) refuse("display.colorScheme", "C", DARK_FORCED, "mismatch");
    else if (native) { prefs.colorScheme = "light"; applied("display.colorScheme", "C", "the browser's Appearance setting at Light, which pages follow", "light"); } else refuse("display.colorScheme", "C", LIGHT_ON_EXTENSION);
  } else derived("display.colorScheme", "C", "this computer's");
  const forcedOn = userArgs.some((a) => switchName(a, platform) === "force-prefers-reduced-motion");
  if (reducedMotion === true) { switches.push("--force-prefers-reduced-motion"); applied("display.reducedMotion", "C", "--force-prefers-reduced-motion", true); } else if (reducedMotion === false) {
    if (forcedOn) refuse("display.reducedMotion", "C", REDUCED_MOTION_FORCED, "mismatch");
    else { switches.push("--force-prefers-no-reduced-motion"); applied("display.reducedMotion", "C", "--force-prefers-no-reduced-motion", false); }
  } else derived("display.reducedMotion", "C", "this computer's");

  // Graphics (E2, native/graphics.mjs graphicsPlan): software is the engine's own software renderer
  // on Linux (refused on macOS and on the open build, never partly applied); a GPU (native only:
  // the plan refuses it on the open build) and a requirement (native only) are checked against
  // the measurement before the start and the browser's own read after it (daemon/browser/
  // graphics.mjs, section 3.2 steps 4 and 7), which refuse it there. The plan's engine keys (Linux:
  // the real backend's strings and screen) are the launch's own, never the profile's
  // (native-engine.mjs).
  const { backend, require: requirement } = p.graphics;
  const plan = graphicsPlan({ requested: backend, platform, browserKind, userArgs, name: p.name });
  if (plan.refusals.length) for (const r of plan.refusals) refuse("graphics.backend", "M", r.message.replace(/\.$/, ""));
  else if (backend === "software") { switches.push(...plan.switches); applied("graphics.backend", "M", `a software renderer (${plan.switches.join(" ")}); the backend in use is measured, not assumed`, "software"); } else if (backend === "gpu") applied("graphics.backend", "M", "a GPU: checked against the measured backend before the start and the browser's own read after it", "gpu");
  else derived("graphics.backend", "M", "this computer's, measured");
  if (requirement && !native) refuse("graphics.require", "M", "only the native PairBrowse build checks graphics requirements");
  else if (requirement) applied("graphics.require", "M", "checked against the measurement before each start", requirement);

  // Persona (D3, D9): a pinned seed, the host's own values, or a seed per session.
  const { seed } = p.persona;
  if (seed) {
    if (native) { engineKeys.fingerprint = seed; applied("persona.seed", "C", "a pinned seed: one device wherever it runs"); } else refuse("persona.seed", "C", "PairBrowse as an extension has no persona");
  } else if (p.persona.source === "host") derived("persona.source", "D", native && platform === "darwin" ? "this Mac's own values (host capture)" : native ? "the seed persona with this computer's graphics (host capture is macOS only)" : "PairBrowse as an extension reports this computer's own");
  else if (native) derived("persona.seed", "D", "a seed of the session's own");
  else add("persona.seed", "not-applied", "D", "PairBrowse as an extension has no persona");

  // A saved card (B12): the preference the launch writes, honored only with a real key store,
  // which only the launch knows (browser/safe-storage.mjs savedCardFor; it says so in the status
  // and keeps payment autofill off otherwise). Never a refusal: off is its safe side (spec B12, an
  // exception to D11). The open build never has one.
  if (p.payments.savedCard) {
    prefs.savedCard = true;
    if (native) applied("payments.savedCard", "C", "payment autofill on when this launch has a real key store (the Keychain or this install's key file); only the person fills it, during a hand-off", true);
    else add("payments.savedCard", "not-applied", "C", "PairBrowse as an extension has no key store for saved cards: payment autofill stays off", { requested: true, severity: "warning" });
  }
  if (p.network) applied("network", "C", "the session's proxy, unless config.json's network.sessions names one", p.network);
  else derived("network", "C", "config.json's network default, if any");
  if (p.adBlocker !== null) applied("adBlocker", "C", p.adBlocker ? "on" : "off", p.adBlocker);

  // Every switch as the launch screens browserArgs (built to pass; anything else refuses).
  const screened = screenBrowserArgs(switches, platform, { harness: false });
  if (screened.kept.length !== switches.length) refuse("switches", "C", "a switch the mapper made didn't pass the switch screen");
  const errors = results.filter((r) => r.severity === "error");
  if (errors.length) {
    const list = errors.map((r) => `${r.field} (${r.reason})`).join("; ");
    return empty(`Browser profile "${p.name}" can't start on ${build}: ${list}. Change the profile or the browser; nothing was started.`);
  }
  return { switches, engineKeys, prefs, geoip: geoip && native, network: p.network, adBlocker: p.adBlocker, results, problem: null };
}
