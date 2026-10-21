// The profile property matrix (spec server-mode section 9) as data: for each property a page can
// read, where its value comes from, how the launch sets it (switches by name, engine keys, prefs),
// its class on each runtime, the validator's rules that check it (native/validate.mjs RULES, or an
// E13 coherence rule), what verifies it and the engine patch it still waits for.
//
// Classes (profiles/schema.mjs ITEM_CLASSES): C configurable (a profile setting the engine
// applies), M measured (the runtime's real value, reported), D derived (from the build or seed,
// constant), U unavailable or refused. Runtimes: macOS native (host capture), Linux native without
// a GPU (software, on Xvfb), Linux native on a GPU host (real GPU). `measuredToo` marks a property
// set by configuration whose result is also measured (a proxy's egress, WebRTC's candidates);
// `later` the class it takes once its patch ships.
//
// Pure; Node's standard library only. Field names follow validation items' (`locale.timezone`).

export const RUNTIMES = Object.freeze(["macos", "linux-software", "linux-gpu"]);

const all = (c) => ({ macos: c, "linux-software": c, "linux-gpu": c });

const ROWS = [
  { field: "locale.timezone", property: "Time zone", source: "profile locale.timezone, else geoip or this computer",
    mechanism: { engineKeys: ["timezone"] }, classes: all("C"), rules: ["locale", "locale.timezone-vs-egress"],
    verifiedBy: ["profiles-native: time zone, languages, screen and DPR are what pages read", "coherence"] },
  { field: "locale.languages", property: "Languages, Accept-Language", source: "profile locale.languages",
    mechanism: { engineKeys: ["acceptLanguage"], switches: ["lang"] }, classes: all("C"), rules: ["locale", "locale.language-vs-egress"],
    verifiedBy: ["profiles-native", "native-engine: profile languages reach --accept-lang"] },
  { field: "screen", property: "Screen size, avail, color depth", source: "profile screen; on Xvfb virtualScreen",
    mechanism: { engineKeys: ["screenWidth", "screenHeight", "availWidth", "availHeight", "colorDepth"] }, classes: all("C"),
    rules: ["screen.display", "screen.believable"], note: "on Xvfb it must equal virtualScreen (E7)",
    verifiedBy: ["native-graphics: screen vs virtualScreen", "probe screen"] },
  { field: "window", property: "Window size", source: "profile window; on Xvfb the screen",
    mechanism: { switches: ["window-size"] }, classes: all("C"), rules: [], verifiedBy: ["server-display: window matches virtualScreen"] },
  { field: "screen.devicePixelRatio", property: "Device pixel ratio", source: "profile screen.devicePixelRatio",
    mechanism: { engineKeys: ["devicePixelRatio"] }, classes: all("C"), rules: ["screen.display"], verifiedBy: ["profiles-native"] },
  { field: "display.colorScheme", property: "Color scheme", source: "profile display",
    mechanism: { switches: ["force-dark-mode"], prefs: ["browser.theme.color_scheme2"] }, classes: all("C"), rules: [],
    note: "light and dark as the native build's Appearance setting, which its pages follow; light refused on PairBrowse as an extension",
    verifiedBy: ["profile-map: a light scheme and reduced motion off", "browser: Appearance setting"] },
  { field: "display.reducedMotion", property: "Reduced motion", source: "profile display",
    mechanism: { switches: ["force-prefers-reduced-motion", "force-prefers-no-reduced-motion"] }, classes: all("C"), rules: [], verifiedBy: ["profile-map: toLaunch passes screenBrowserArgs", "profile-map: a light scheme and reduced motion off"] },
  { field: "persona.seed", property: "Persona seed", source: "profile persona.seed or per session",
    mechanism: { engineKeys: ["fingerprint"] }, classes: all("C"), rules: [], verifiedBy: ["profiles-native: pinned seed reproduces"] },
  { field: "network", property: "Proxy and egress", source: "Phase C network",
    mechanism: { switches: ["proxy-server"], other: "the proxy auth file" }, classes: all("C"), measuredToo: true, rules: [],
    verifiedBy: ["integration/proxy", "net-verdict"], patch: "962" },
  { field: "network.webrtc", property: "WebRTC addresses", source: "Phase C strict mode",
    mechanism: { switches: ["webrtc-ip-handling-policy"] }, classes: all("C"), measuredToo: true, rules: [], verifiedBy: ["proxy I4, I13"] },
  { field: "graphics.backend", property: "Rendering backend", source: "this computer",
    mechanism: { switches: ["use-angle"], other: "the browser process's SystemInfo read (native/backend.mjs)" }, classes: all("M"),
    rules: ["backend.requested", "backend.stable"], note: "software forces the engine's software renderer on Linux (--use-angle=swiftshader), refused on macOS; gpu requires a hardware one",
    verifiedBy: ["native-graphics", "optin linux-graphics", "optin gpu-host"] },
  { field: "graphics.require", property: "Graphics requirements", source: "profile graphics.require",
    mechanism: { other: "checked against the measurement, never applied" }, classes: all("M"),
    rules: ["require.webgl", "require.webgpu", "require.platforms"], verifiedBy: ["native-validate"] },
  { field: "webgl.strings", property: "WebGL/WebGL2 vendor, renderer", source: "this computer",
    mechanism: { engineKeys: ["disableGpuFingerprint"], other: "host capture on macOS" }, classes: all("M"),
    rules: ["webgl.strings-vs-backend", "webgl.context", "gpu.vs-platform", "gpu.software-as-hardware"], verifiedBy: ["native-validate"] },
  { field: "webgl.limits", property: "WebGL limits, extensions, precision", source: "this computer",
    mechanism: { engineKeys: ["disableGpuFingerprint"] }, classes: all("M"), rules: ["webgl.limits-vs-backend"], verifiedBy: ["native-validate"] },
  { field: "webgl.pixels", property: "WebGL and canvas pixels", source: "the host GPU or software raster",
    mechanism: {}, classes: all("M"), rules: ["canvas.stable", "canvas.repeat", "webgl.same-origins"], verifiedBy: ["native-validate"] },
  { field: "canvas.noise", property: "Canvas noise", source: "the build's default",
    mechanism: { engineKeys: ["fingerprintNoise"] }, classes: { macos: "U", "linux-software": "C", "linux-gpu": "U" }, rules: [],
    note: "off over real pixels (macOS, Linux with a GPU); on a host without one pairbrowse.graphicsNoise",
    verifiedBy: ["native-graphics: Linux plan sets noise off", "native-graphics: macOS plan sets noise off"] },
  { field: "canvas.bridge", property: "Canvas bridge", source: "none (removed, E1)",
    mechanism: {}, classes: all("U"), rules: ["bridge.absent"], verifiedBy: ["native-engine: no --canvas-bridge-* reaches the launch"], patch: "960" },
  { field: "webgpu.adapter", property: "WebGPU available, features, isFallbackAdapter", source: "this computer",
    mechanism: { other: "the engine passes the real adapter" }, classes: all("M"), rules: ["webgpu.features-vs-limits"],
    note: "on Linux an adapter or a defined reason", verifiedBy: ["probe webgpu"] },
  { field: "webgpu.vendor", property: "WebGPU vendor, architecture", source: "this computer",
    mechanism: { engineKeys: ["disableGpuFingerprint"], other: "host capture on macOS" }, classes: all("M"), rules: ["webgpu.vendor"], verifiedBy: ["native-validate"] },
  { field: "webgpu.limits", property: "WebGPU limits", source: "the persona table today",
    mechanism: { other: "the engine's persona override" }, classes: { macos: "M", "linux-software": "D", "linux-gpu": "D" }, later: "M",
    rules: ["webgpu.device"], note: "macOS reports the captured limits", verifiedBy: ["native-validate"], patch: "961" },
  { field: "fonts", property: "Fonts exposed and resolved", source: "the engine's per-platform list; host fonts or bundled clones",
    mechanism: { other: "040-fonts, fontLaunchEnv" }, classes: all("M"), rules: ["fonts.available"], verifiedBy: ["native-validate"] },
  { field: "media.codecs", property: "Codec support", source: "the build", mechanism: {}, classes: all("M"), rules: [], verifiedBy: ["probe media"] },
  { field: "media.capabilities", property: "Media capabilities", source: "the persona",
    mechanism: { other: "patch 147" }, classes: all("D"), rules: ["media.capabilities"], verifiedBy: ["native-validate"] },
  { field: "memory", property: "performance.memory", source: "the persona",
    mechanism: { other: "patch 146" }, classes: all("D"), rules: ["memory"], verifiedBy: ["native-validate"] },
  { field: "hardware", property: "Cores, device memory, touch points", source: "the seed persona",
    mechanism: {}, classes: all("D"), rules: [], verifiedBy: ["probe values recorded"] },
  { field: "ua.version", property: "User agent and version", source: "the build", mechanism: {}, classes: all("D"), rules: ["ua.build"], verifiedBy: ["native-validate"] },
  { field: "platform", property: "Platform", source: "the build", mechanism: {}, classes: all("D"), rules: ["gpu.vs-platform"], verifiedBy: ["coherence"] },
  { field: "hardware.imported", property: "Imported hardware (GPU, fonts list, audio, voices, codecs)", source: "another device",
    mechanism: {}, classes: all("U"), rules: [], note: "never applied (by decision)", verifiedBy: ["profile-import: reports every hardware section unsupported"] },
  { field: "payments.savedCard", property: "Saved card", source: "session storage",
    mechanism: { prefs: ["autofill"] }, classes: all("C"), rules: [], note: "with a key store (U3)", verifiedBy: ["browser saved-card case"] },
  { field: "sandbox", property: "Sandbox", source: "the helper (sandboxDecision)",
    mechanism: { other: "always on; in server mode required" }, classes: all("M"), rules: ["sandbox.on"], verifiedBy: ["engine", "native-validate"] },
];

const freeze = (v) => {
  if (v && typeof v === "object") { for (const x of Object.values(v)) freeze(x); Object.freeze(v); }
  return v;
};
export const PROPERTIES = freeze(ROWS.map((r) => ({ mechanism: {}, measuredToo: false, later: null, note: null, patch: null, ...r })));
const BY_FIELD = new Map(PROPERTIES.map((p) => [p.field, p]));

// One property's row, or null.
export const property = (field) => BY_FIELD.get(field) || null;

// The runtime a measurement is of: macOS native, or Linux by its measured backend (a backend not
// confirmed as hardware counts as software: it claims less).
export function runtimeOf({ platform, backend } = {}) {
  if (platform === "darwin" || platform === "macos") return "macos";
  return backend === "hardware" ? "linux-gpu" : "linux-software";
}

// A property's class on a runtime ("C", "M", "D", "U"), or null for a field the matrix doesn't list.
export const classOf = (field, runtime) => BY_FIELD.get(field)?.classes[runtime] ?? null;

// The rules that check a field (validator and coherence rules alike).
export const rulesOf = (field) => BY_FIELD.get(field)?.rules ?? [];
