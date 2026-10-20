// Cross-phase consistency rules (spec server-mode E13; scripts/rules/coherence.mjs). Step 32b's
// locale rules, which the Network section's Test and each network check report (C13); step 35's
// screen rule, which a profile import reports (D16); step 43's graphics rules, the window and
// avail checks, and the hand-off's two lists (B14).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { localeVsEgress, regionOf, screenBelievable, gpuVsPlatform, gpuSoftwareAsHardware, rendererFamily, platformOf, setupLines, COHERENCE_RULES, COHERENCE_RULE_IDS } from "../scripts/rules/coherence.mjs";
import { countriesOf } from "../scripts/rules/tzcountry.mjs";

test("Europe/Berlin with egress US is an error; language mismatch a warning", () => {
  const items = localeVsEgress({ timezone: "Europe/Berlin", languages: ["de-DE", "de"], country: "US" });
  assert.deepEqual(items.map((i) => [i.id, i.severity]), [["locale.timezone-vs-egress", "error"], ["locale.language-vs-egress", "warning"]]);
  assert.match(items[0].text, /Europe\/Berlin is used in DE.*exit is in US/);
  assert.deepEqual(localeVsEgress({ timezone: "Europe/Berlin", languages: ["de-DE"], country: "DE" }), []);
  assert.deepEqual(localeVsEgress({ timezone: "America/New_York", languages: ["en-US"], country: "US" }), []);
});

test("rules that can't tell say nothing", () => {
  assert.deepEqual(localeVsEgress({ timezone: "UTC", languages: ["en"], country: "US" }), [], "UTC and a language without a region");
  assert.deepEqual(localeVsEgress({ timezone: "Europe/Berlin", languages: ["de-DE"], country: null }), [], "no country");
  assert.deepEqual(localeVsEgress({ timezone: "Not/AZone", languages: [], country: "US" }), []);
  assert.equal(regionOf("zh-Hant-TW"), "TW");
  assert.equal(regionOf("en"), null);
});

test("the time zone table knows each zone by the name Intl gives it too", () => {
  assert.deepEqual(countriesOf("Europe/Berlin").includes("DE"), true);
  assert.deepEqual(countriesOf("Asia/Ho_Chi_Minh"), ["VN"]);
  assert.deepEqual(countriesOf("Asia/Saigon"), ["VN"]);
  assert.deepEqual(countriesOf("US/Eastern"), ["US"]);
  assert.equal(countriesOf("Etc/GMT+5"), null);
  assert.equal(countriesOf(""), null);
});

test("screen.believable: real screens pass; impossible shapes, areas, pixel counts and ratios warn", () => {
  const ids = (s) => screenBelievable(s).map((i) => [i.id, i.severity]);
  for (const s of [{ width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, devicePixelRatio: 1 }, { width: 1512, height: 982, availWidth: 1512, availHeight: 945, devicePixelRatio: 2 },
    { width: 5120, height: 1440, availWidth: 5120, availHeight: 1400, devicePixelRatio: 1 }, { width: 390, height: 844, availWidth: 390, availHeight: 844, devicePixelRatio: 3 }, { width: 1366, height: 768, devicePixelRatio: 1.25 }]) {
    assert.deepEqual(ids(s), [], JSON.stringify(s));
  }
  assert.deepEqual(ids({ width: 6000, height: 1000, availWidth: 6000, availHeight: 1000, devicePixelRatio: 1 }), [["screen.believable", "warning"]]);
  assert.match(screenBelievable({ width: 1920, height: 1080, availWidth: 1920, availHeight: 400, devicePixelRatio: 1 })[0].text, /Only 1920x400 of the 1920x1080 screen/);
  assert.match(screenBelievable({ width: 8000, height: 4000, availWidth: 8000, availHeight: 4000, devicePixelRatio: 3 })[0].text, /more device pixels than any display/);
  assert.match(screenBelievable({ width: 1920, height: 1080, availWidth: 1920, availHeight: 1080, devicePixelRatio: 1.1 })[0].text, /pixel ratio of 1.1 isn't one/);
  assert.deepEqual(screenBelievable(null), []);
  assert.deepEqual(screenBelievable({ width: 0, height: 10 }), []);
});

test("Apple renderer on Linux is gpu.vs-platform", () => {
  const apple = "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)";
  const items = gpuVsPlatform({ platform: "Linux x86_64", renderer: apple });
  assert.deepEqual(items.map((i) => [i.id, i.severity]), [["gpu.vs-platform", "error"]]);
  assert.match(items[0].text, /apple GPU .* on Linux, which has none/);
  assert.deepEqual(gpuVsPlatform({ platform: "MacIntel", renderer: apple }), [], "Apple's GPU on a Mac");
  assert.deepEqual(gpuVsPlatform({ platform: "MacIntel", renderer: "ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics)" }), [], "an Intel Mac");
  assert.equal(gpuVsPlatform({ platform: "MacIntel", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0)" })[0].id, "gpu.vs-platform");
  assert.deepEqual(gpuVsPlatform({ platform: "Linux x86_64", renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 770 (RPL-S), OpenGL 4.6)" }), []);
  assert.deepEqual(gpuVsPlatform({ platform: "Win32", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)" }), []);
  assert.deepEqual(gpuVsPlatform({ platform: "linux", renderer: "Google SwiftShader" }), [], "software fits everywhere");
  assert.deepEqual(gpuVsPlatform({ platform: "Linux armv8l", renderer: "" }), [], "no renderer: can't tell");
  assert.deepEqual(gpuVsPlatform({ platform: "PlayStation", renderer: apple }), [], "a system not known: can't tell");
  assert.deepEqual([platformOf("MacIntel"), platformOf("macos"), platformOf("Linux x86_64"), platformOf("Win32"), platformOf("Linux armv81; Android"), platformOf("iPhone"), platformOf("iPad"), platformOf("")], ["macos", "macos", "linux", "windows", null, null, null, null]);
  assert.deepEqual([rendererFamily("ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)"), rendererFamily("llvmpipe (LLVM 15.0.7, 256 bits)"), rendererFamily("Radeon Pro 560")], ["apple", "software", "amd"]);
});

test("hardware renderer on a software backend is gpu.software-as-hardware", () => {
  const persona = "ANGLE (Intel, Mesa Intel(R) UHD Graphics 770 (RPL-S), OpenGL 4.6 (Core Profile) Mesa 23.2.1)";
  const items = gpuSoftwareAsHardware({ backend: { kind: "software", renderer: "llvmpipe (LLVM 15.0.7, 256 bits)" }, renderer: persona });
  assert.deepEqual(items.map((i) => [i.id, i.severity]), [["gpu.software-as-hardware", "error"]]);
  assert.match(items[0].text, /hardware GPU .* while the browser renders in software/);
  // A WebGPU adapter claiming a hardware vendor over software rendering is one too; a fallback one isn't.
  assert.equal(gpuSoftwareAsHardware({ backend: { kind: "software" }, adapter: { vendor: "intel", architecture: "gen-12-lp", isFallbackAdapter: false } }).length, 1);
  assert.deepEqual(gpuSoftwareAsHardware({ backend: { kind: "software" }, adapter: { vendor: "google", architecture: "swiftshader", isFallbackAdapter: true } }), []);
  assert.deepEqual(gpuSoftwareAsHardware({ backend: { kind: "software" }, renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)" }), []);
  assert.deepEqual(gpuSoftwareAsHardware({ backend: { kind: "hardware" }, renderer: persona }), [], "hardware rendering: not this rule's");
  assert.deepEqual(gpuSoftwareAsHardware({ backend: { kind: "unverified" }, renderer: persona }), [], "an unconfirmed backend: can't tell");
});

test("a window larger than the screen is not believable; neither is more available area than screen", () => {
  const screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, devicePixelRatio: 1 };
  const big = screenBelievable(screen, { window: { width: 2560, height: 1000 } });
  assert.deepEqual(big.map((i) => [i.id, i.severity, i.field]), [["screen.believable", "warning", "window"]]);
  assert.deepEqual(screenBelievable({ ...screen, availHeight: 1200 }).map((i) => i.field), ["screen"], "each item names its setting");
  assert.match(big[0].text, /A 2560x1000 window doesn't fit on a 1920x1080 screen/);
  assert.deepEqual(screenBelievable(screen, { window: { width: 1280, height: 800 } }), []);
  assert.deepEqual(screenBelievable(screen, { window: { width: 1920, height: 1080 } }), [], "a maximized window fits");
  assert.match(screenBelievable({ ...screen, availHeight: 1200 })[0].text, /more than the screen itself/);
});

test("the rules are one list with their severities; the hand-off's two lists keep a site's verification apart from setup problems", () => {
  assert.deepEqual(COHERENCE_RULE_IDS, ["gpu.vs-platform", "gpu.software-as-hardware", "screen.believable", "locale.timezone-vs-egress", "locale.language-vs-egress"]);
  assert.equal(COHERENCE_RULES["locale.timezone-vs-egress"], "error");
  const items = localeVsEgress({ timezone: "Europe/Berlin", languages: ["de-DE"], country: "US" });
  assert.equal(setupLines({ verification: "CAPTCHA on shop.example", items }),
    "Site verification (yours to do): CAPTCHA on shop.example.\nPairBrowse setup problems (PairBrowse's to fix, not the user's to work around): time zone Europe/Berlin vs egress US; languages for DE vs egress US.");
  assert.equal(setupLines({ verification: null, items: [] }), "");
  assert.equal(setupLines({ items: [{ id: "x", text: "Same." }, { id: "y", text: "Same." }] }), "PairBrowse setup problems (PairBrowse's to fix, not the user's to work around): Same.");
});
