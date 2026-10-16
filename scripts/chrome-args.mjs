// The user's own chromeArgs (config.json) are screened before they reach the browser against an
// ALLOWLIST: only switches on the list below pass, each with a value of the shape it takes. Any
// other switch is dropped whatever it does (a debugging surface, a program run in place of a
// browser process, certificate checks or site isolation off, traffic sent elsewhere, another
// profile or extension, a switch PairBrowse has never heard of), and so is every argument that
// isn't a switch: Chromium opens those as pages or files, and it never reads one as the value of
// the switch before it ("--proxy-server", "http://x" is a switch with no value and then a page to
// open). The driver's own pipe (--remote-debugging-pipe) and profile (--user-data-dir) and the
// side panel's own extension switches are added by the helper from its launch options, never from
// these args, so they are not affected.
//
// Chromium reads a switch written with "--" or "-" (and "/" on Windows), up to the first "=", its
// name case-insensitively on Windows; an argument after a bare "--" is never a switch. switchName
// finds the name the same way; a name is compared lowercased on every platform (on macOS and Linux
// a differently cased switch is one Chromium doesn't know and ignores).
//
// --no-sandbox (any spelling, with or without a value) is the sandbox choice, never a raw switch.
// On Linux it is the user's documented way to turn the sandbox off (engine.mjs sandboxDecision, ADR
// 0005): it reaches the driver as chromiumSandbox: false, and the driver adds --no-sandbox itself.
// On macOS and Windows the sandbox always works and always stays on: the switch is refused (named
// in the log and in pairbrowse_status, never dropped quietly), and so is "chromeSandbox": false.
import { harnessStarted } from "./testenv.mjs";

const NONE = (v) => v === null; // a switch that takes no value
const ONE_OF = (...values) => (v) => v !== null && values.includes(v);
const MATCHES = (re) => (v) => v !== null && re.test(v);
const FEATURE = /^[A-Za-z0-9_]{1,80}$/;
const featureList = (v, ok) => v !== null && v.split(",").every((f) => FEATURE.test(f) && ok(f));

// host-resolver-rules: only rules that keep a name on this computer (a local test or dev site):
// "MAP <name> <loopback>[:port]", "MAP <name> ~NOTFOUND" or "EXCLUDE <name>". A rule that sends a
// name anywhere else could put another server in a site's place.
const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/;
const RULE_NAME = /^[A-Za-z0-9*.-]{1,253}(?::\d{1,5})?$/;
function localRules(v) {
  if (v === null || !v.trim()) return false;
  return v.split(",").every((rule) => {
    const p = rule.trim().split(/\s+/);
    if (p[0] === "EXCLUDE") return p.length === 2 && RULE_NAME.test(p[1]);
    return p[0] === "MAP" && p.length === 3 && RULE_NAME.test(p[1]) && (LOOPBACK.test(p[2]) || p[2] === "~NOTFOUND");
  });
}

// Every switch a user's chromeArgs may carry, and the value it takes. Nothing here runs a
// program, opens a debugging surface, loads code, turns a security check off or sends traffic
// elsewhere: language, window, scale, colors and fonts, GPU and display backend choices, sound,
// notifications, and the switches the helper's own launch already uses.
export const ALLOWED = {
  "lang": MATCHES(/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/),
  "window-size": MATCHES(/^\d{1,5},\d{1,5}$/),
  "window-position": MATCHES(/^-?\d{1,5},-?\d{1,5}$/),
  "start-maximized": NONE,
  "force-device-scale-factor": MATCHES(/^\d{1,2}(?:\.\d{1,4})?$/),
  "force-dark-mode": NONE,
  "force-prefers-reduced-motion": NONE,
  "force-color-profile": MATCHES(/^[a-z0-9-]{1,32}$/),
  "font-render-hinting": ONE_OF("none", "slight", "medium", "full"),
  "disable-font-subpixel-positioning": NONE,
  "disable-lcd-text": NONE,
  "hide-scrollbars": NONE,
  "disable-smooth-scrolling": NONE,
  "force-renderer-accessibility": NONE,
  "disable-gpu": NONE,
  "disable-gpu-compositing": NONE,
  "use-gl": MATCHES(/^[a-z0-9-]{1,32}$/),
  "use-angle": MATCHES(/^[a-z0-9-]{1,32}$/),
  "ozone-platform": ONE_OF("wayland", "x11"),
  "ozone-platform-hint": ONE_OF("auto", "wayland", "x11"),
  "disable-dev-shm-usage": NONE,
  "mute-audio": NONE,
  "autoplay-policy": ONE_OF("no-user-gesture-required", "user-gesture-required", "document-user-activation-required"),
  "disable-notifications": NONE,
  "no-first-run": NONE,
  "no-default-browser-check": NONE,
  "hide-crash-restore-bubble": NONE,
  "test-type": NONE,
  "disable-renderer-backgrounding": NONE,
  "disable-background-timer-throttling": NONE,
  "disable-backgrounding-occluded-windows": NONE,
  // Test runs only, where nobody browses (ADR 0009).
  "headless": (v) => v === null || v === "new" || v === "old",
  // Feature names only (no field trial parameters); no feature may be turned off (that is how
  // site isolation and other protections are switched off) except, in a test run, below.
  "enable-features": (v) => featureList(v, () => true),
  "disable-features": (v, { harness }) => featureList(v, (f) => harness && HARNESS_DISABLED_FEATURES.includes(f)),
  "host-resolver-rules": localRules,
  // The sandbox: the user's own choice on Linux only, read by sandboxDecision and never passed as
  // a raw switch. Elsewhere it is refused (screenChromeArgs "refused").
  "no-sandbox": (v, { platform }) => sandboxOffAllowed(platform),
  // A browser the test harness started (testenv.mjs harnessStarted) keeps its test profile's
  // passwords out of the computer's keychain; an installed helper never does.
  "use-mock-keychain": (v, { harness }) => harness && v === null,
  "password-store": (v, { harness }) => harness && v === "basic",
};
// The one feature a test run turns off: its two local test sites reach each other.
const HARNESS_DISABLED_FEATURES = ["LocalNetworkAccessChecks"];

// The switch name of an arg ("--Remote-Debugging-Port=9222" -> "remote-debugging-port"), or null
// for an arg that is not a switch. The name is not trimmed: "-- lang" is the switch " lang", which
// no list holds.
export function switchName(arg, platform = process.platform) {
  const s = String(arg);
  const m = s.match(platform === "win32" ? /^(?:--|-|\/)([^=]+)/ : /^(?:--|-)([^=]+)/);
  if (!m) return null;
  return m[1].toLowerCase();
}

// An arg's value after "=", or null when it has none.
const valueOf = (arg) => { const s = String(arg); const i = s.indexOf("="); return i < 0 ? null : s.slice(i + 1); };

// Whether one arg passes the allowlist.
export function allowedChromeArg(arg, platform = process.platform, { harness = false } = {}) {
  if (typeof arg !== "string") return false;
  const name = switchName(arg, platform);
  if (name === null || !Object.hasOwn(ALLOWED, name)) return false;
  return ALLOWED[name](valueOf(arg), { harness, platform }) === true;
}

// { kept, dropped, refused }: dropped names each switch removed, as the user wrote it (value cut
// off), and counts the arguments that aren't switches (never shown: one could be a page's address);
// refused names each --no-sandbox spelling removed where the sandbox can't be turned off
// (sandboxRefusal says why).
// harness: whether the test harness started this helper (the test-only switches above).
export function screenChromeArgs(args, platform = process.platform, { harness = harnessStarted() } = {}) {
  const kept = [], dropped = [], refused = [];
  let positional = 0, ended = false;
  for (const a of Array.isArray(args) ? args : []) {
    if (a === "--") ended = true; // what follows is never a switch
    if (!ended && allowedChromeArg(a, platform, { harness })) { kept.push(a); continue; }
    if (!ended && typeof a === "string" && switchName(a, platform) === "no-sandbox") refused.push(a.split("=")[0]);
    else if (!ended && typeof a === "string" && switchName(a, platform) !== null) dropped.push(a.split("=")[0]);
    else positional++;
  }
  if (positional) dropped.push(`${positional} argument${positional > 1 ? "s" : ""} that ${positional > 1 ? "aren't switches" : "isn't a switch"}`);
  return { kept, dropped, refused };
}

// The config warning (and helper log line) for dropped switches, or null.
export function droppedWarning(dropped) {
  if (!dropped.length) return null;
  return `config.json: chromeArgs ${dropped.join(", ")} dropped (PairBrowse passes only the switches on its list, each with a value of the shape it takes; see docs/configuration.md)`;
}

// The sandbox. Only Linux may turn it off: its kernel or container can take away what the sandbox
// needs. On macOS and Windows it always works, so nothing in config turns it off there.
export const SANDBOX_OFF_WARNING = "The browser's sandbox is off: websites are less isolated from this computer";
export const sandboxOffAllowed = (platform) => platform === "linux";
const isNoSandbox = (a, platform) => typeof a === "string" && switchName(a, platform) === "no-sandbox";
// What in config asks for the sandbox off, or null.
export function sandboxOffAsked(config = {}, platform = process.platform) {
  if (config.chromeSandbox === false) return "chromeSandbox is false in config.json";
  const args = Array.isArray(config.chromeArgs) ? config.chromeArgs : [];
  const end = args.indexOf("--"); // what follows a bare "--" is never a switch
  if ((end < 0 ? args : args.slice(0, end)).some((a) => isNoSandbox(a, platform))) return "chromeArgs has --no-sandbox";
  return null;
}
const OS_NAMES = { darwin: "macOS", win32: "Windows" };
// Why a request for the sandbox off is refused on this platform.
export function sandboxRefusal(asked, platform = process.platform) {
  return `${asked}: refused, the browser's sandbox always stays on on ${OS_NAMES[platform] || platform} (only Linux may turn it off)`;
}
// args without any --no-sandbox spelling (the driver alone adds it, and only when the sandbox is off).
export const withoutNoSandbox = (args, platform = process.platform) => (Array.isArray(args) ? args : []).filter((a) => !isNoSandbox(a, platform));

// The args launchArgs passes on: the screened ones, without --no-sandbox (the driver adds that
// itself when the sandbox is off).
export function launchableChromeArgs(args, platform = process.platform, options) {
  return withoutNoSandbox(screenChromeArgs(args, platform, options).kept, platform);
}
