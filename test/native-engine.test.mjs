import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative, applyGraphicsPlan, DRIVER_BLINK_SWITCH, DRIVER_BACKGROUND_SWITCH, nativeManifest, declaresOwnPages, macHostProfile, captureMacHost, MEASURING, hostCachePath, screenInfoArg, CANVAS_BRIDGE_DROPPED, isCanvasBridgeSwitch, personaProxyRefusal, PROXY_CREDENTIALS_REFUSAL, proxyCredentials, withoutAddresses, proxyAuthFile, fillSettings, keystrokeSchedule, humanFill, humanType, TYPING_PACE, FILL_PACE_FLOOR, SLOW_TYPE_PACE, paceSets, flatWebgpuProfile, personaBindingRefusal, droppedLine, clockZoneNote } from "../scripts/native-engine.mjs";
import { PAIRBROWSE_ENGINE_KEYS } from "../scripts/config-schema.mjs";
import { loadEngine } from "../scripts/native/pack.mjs";
import { normalizeWebgpu, GRAPHICS } from "../scripts/native/graphics.mjs";
import { THIS_COMPUTER_NOTE } from "../scripts/profiles/map.mjs";
import { sha256 } from "../scripts/util.mjs";
import { STRICT_WEBRTC, resolverRule } from "../scripts/net/config.mjs";

// The Mac host profile is cached in the PairBrowse home: keep tests away from the real one.
process.env.PAIRBROWSE_HOME = mkdtempSync(join(tmpdir(), "pairbrowse-home-test-"));

function appFixture(metadata = { product: "PairBrowse", version: "150.0.7871.114", arch: "arm64" }) {
  const root = mkdtempSync(join(tmpdir(), "pairbrowse-native-test-"));
  const contents = join(root, "PairBrowse.app", "Contents");
  const executablePath = join(contents, "MacOS", "pairbrowse");
  mkdirSync(join(contents, "Resources"), { recursive: true });
  mkdirSync(join(contents, "Frameworks", "Chromium Framework.framework"), { recursive: true });
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  writeFileSync(join(contents, "Resources", "PairBrowse-build.json"), JSON.stringify(metadata));
  writeFileSync(executablePath, "fake native Chromium executable");
  return { root, executablePath };
}

function fakeBrowserType(captured = { webgl: { vendor: "Apple", renderer: "Apple test GPU" }, speech: [], media_devices: [] }) {
  const calls = [];
  const chromium = {
    calls,
    captures: 0,
    launchPersistentContext: async (profile, options) => {
      if (profile.includes(".mac-host-capture-")) {
        if (!options.args.includes("--disable-gpu-fingerprint")) throw new Error("probe must disable GPU fingerprinting");
        if (options.headless !== true) throw new Error("the capture must never show a window");
        chromium.captures++;
        return { pages() { return [{ async evaluate() { return captured; } }]; }, async close() {} };
      }
      calls.push({ profile, options });
      return { closed: false, on() {}, pages() { return []; }, browser() { return null; }, async close() { this.closed = true; } };
    },
    launch: async () => ({ close() {} }),
  };
  return chromium;
}

// An unpacked engine pack (the folder with engine.mjs), e.g. ~/.pairbrowse/engine.
const engineDir = process.env.PAIRBROWSE_TEST_ENGINE;
const packTest = engineDir ? test : test.skip;
// The host capture reads this Mac's own fingerprint: macOS only (elsewhere the browser runs seeded).
const macPackTest = engineDir && process.platform === "darwin" ? test : test.skip;
const offMacPackTest = engineDir && process.platform !== "darwin" ? test : test.skip;
const PLATFORM = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform];
const loadPack = () => loadEngine(engineDir);

// The capture runs once per Mac: a cached host profile is reused until the build or hardware changes.
const fakePack = { collector: "", DEFAULT_IGNORED_ARGS: [] };
test("the Mac host capture is cached privately and reused by new profiles", async () => {
  rmSync(hostCachePath(), { force: true });
  const chromium = fakeBrowserType({ webgl: { vendor: "Apple", renderer: "Apple M3 Pro" } });
  const hardware = () => "Mac15,7|AGXAcceleratorG15X";
  const first = await macHostProfile(chromium, "/fake", fakePack, mkdtempSync(join(tmpdir(), "pairbrowse-p1-")), "150.0.7871.114", hardware);
  assert.equal(chromium.captures, 1);
  if (process.platform !== "win32") assert.equal(statSync(hostCachePath()).mode & 0o777, 0o600);
  const second = await macHostProfile(chromium, "/fake", fakePack, mkdtempSync(join(tmpdir(), "pairbrowse-p2-")), "150.0.7871.114", hardware);
  assert.equal(chromium.captures, 1, "a second profile reuses the cache: no launch");
  assert.deepEqual(second, first);
  await macHostProfile(chromium, "/fake", fakePack, mkdtempSync(join(tmpdir(), "pairbrowse-p3-")), "150.0.7871.200", hardware);
  assert.equal(chromium.captures, 2, "a new browser version captures again");
  await macHostProfile(chromium, "/fake", fakePack, mkdtempSync(join(tmpdir(), "pairbrowse-p4-")), "150.0.7871.200", () => "Mac16,1|other GPU");
  assert.equal(chromium.captures, 3, "other hardware captures again");
});

// The capture takes up to a minute on a first launch: the helper is told when it starts (and only
// then: a cached profile says nothing), and two launches at once share one capture.
test("the Mac host capture says when it starts, once, and two launches share it", async () => {
  rmSync(hostCachePath(), { force: true });
  const chromium = fakeBrowserType({ webgl: { vendor: "Apple", renderer: "Apple M3 Pro" } });
  const hardware = async () => "Mac15,7|AGXAcceleratorG15X";
  let told = 0;
  const ask = () => macHostProfile(chromium, "/fake", fakePack, mkdtempSync(join(tmpdir(), "pairbrowse-m-")), "150.0.7871.114", hardware, () => told++);
  const [a, b] = await Promise.all([ask(), ask()]);
  assert.deepEqual(a, b);
  assert.equal(chromium.captures, 1, "one capture for both");
  assert.equal(told, 1);
  await ask();
  assert.equal(told, 1, "cached: nothing to say");
  assert.match(MEASURING, /^launch: measuring this Mac once/);
});

// Every step of the capture is bounded: a collector that never answers fails the launch with its
// reason (and the hidden browser is closed), it never holds the launch forever.
test("a host capture that hangs fails in its time and closes its browser", async () => {
  let closed = false;
  const chromium = { launchPersistentContext: async () => ({ pages: () => [{ evaluate: () => new Promise(() => {}) }], close: async () => { closed = true; } }) };
  const at = Date.now();
  await assert.rejects(() => captureMacHost(chromium, "/fake", fakePack, mkdtempSync(join(tmpdir(), "pairbrowse-hang-")), null, 150), /the collector took over 0\.15 s/);
  assert.ok(Date.now() - at < 2000);
  assert.equal(closed, true);
});

test("a software WebGL renderer is never kept as this Mac's profile", async () => {
  rmSync(hostCachePath(), { force: true });
  const chromium = fakeBrowserType({ webgl: { webgl1: { UNMASKED_RENDERER_WEBGL: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)" } } });
  await assert.rejects(() => macHostProfile(chromium, "/fake", fakePack, mkdtempSync(join(tmpdir(), "pairbrowse-sw-")), "150.0.7871.114", () => "x"), /software WebGL renderer/);
  assert.equal(existsSync(hostCachePath()), false);
});

test("the hidden capture is told the real screen in physical pixels", () => {
  assert.equal(screenInfoArg({ width: 1728, height: 1117, top: 34, bottom: 77, scale: 2, edr: 16 }),
    "--screen-info={0,0 3456x2234 colorDepth=30 devicePixelRatio=2 workAreaTop=68 workAreaBottom=154}");
  assert.match(screenInfoArg({ width: 1920, height: 1080, top: 25, bottom: 0, scale: 1, edr: 1 }), /colorDepth=24 devicePixelRatio=1 /);
});

test("a build's own pages are read from its manifest's chrome field", () => {
  const base = { product: "PairBrowse", version: "150.0.7871.114", arch: "arm64" };
  assert.equal(declaresOwnPages(nativeManifest(appFixture({ ...base, chrome: 1 }).executablePath)), true);
  assert.equal(declaresOwnPages(nativeManifest(appFixture({ ...base, chrome: 2 }).executablePath)), true);
  for (const chrome of [undefined, 0, "1", true, 1.5, -1, null]) {
    assert.equal(declaresOwnPages(nativeManifest(appFixture(chrome === undefined ? base : { ...base, chrome }).executablePath)), false, String(chrome));
  }
  assert.equal(declaresOwnPages(null), false);
});

test("native app metadata requires a PairBrowse build of engine version 150", () => {
  const good = appFixture();
  assert.equal(nativeManifest(good.executablePath).version, "150.0.7871.114");
  const bad = appFixture({ product: "Other", version: "150.0.7871.114" });
  assert.throws(() => nativeManifest(bad.executablePath), /PairBrowse build of engine version 150/);
  const wrongVersion = appFixture({ product: "PairBrowse", version: "149.0.1.1" });
  assert.throws(() => nativeManifest(wrongVersion.executablePath), /PairBrowse build of engine version 150/);
  // Malformed manifests refuse with the same sentence, never a TypeError (found by test/fuzz/native.test.js).
  for (const m of [null, { product: "PairBrowse", version: [] }, { product: "PairBrowse", version: 150 }]) {
    assert.throws(() => nativeManifest(appFixture(m).executablePath), /PairBrowse build of engine version 150/, JSON.stringify(m));
  }
});

packTest("engine pack profile persistence round-trips through native launch", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-profile-"));
  const chromium = fakeBrowserType();
  await launchNative(chromium, { pairbrowse: { fingerprint: "stable-seed", humanize: false } }, directory,
    { executablePath: app.executablePath, headless: false }, pack);
  const persona = join(directory, "pairbrowse-persona.json");
  assert.ok(existsSync(persona));
  assert.equal(pack.Profile.load(persona).options.fingerprint, "stable-seed");
  await launchNative(chromium, { pairbrowse: {} }, directory,
    { executablePath: app.executablePath, headless: false }, pack);
  assert.equal(chromium.calls[1].options.args.find(a => a.startsWith("--fingerprint=")), "--fingerprint=stable-seed");
});

packTest("browser options are read from the pairbrowse key", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-profile-"));
  const chromium = fakeBrowserType();
  await launchNative(chromium, { pairbrowse: { fingerprint: "named-seed" } }, directory,
    { executablePath: app.executablePath, headless: false }, pack);
  assert.equal(chromium.calls[0].options.args.find(a => a.startsWith("--fingerprint=")), "--fingerprint=named-seed");
});

packTest("a native launch leaves out the driver's switches: no automation flag, no warning bar for AutomationControlled", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const chromium = fakeBrowserType();
  await launchNative(chromium, { pairbrowse: { fingerprint: "bar-seed" } }, mkdtempSync(join(tmpdir(), "pairbrowse-bar-")),
    { executablePath: app.executablePath, headless: false }, pack);
  const { ignoreDefaultArgs, args } = chromium.calls[0].options;
  assert.ok(ignoreDefaultArgs.includes("--enable-automation"));
  assert.ok(ignoreDefaultArgs.includes(DRIVER_BLINK_SWITCH));
  assert.equal(DRIVER_BLINK_SWITCH, "--disable-blink-features=AutomationControlled");
  assert.ok(!args.some((a) => a.startsWith("--disable-blink-features")), "no Blink feature switch of PairBrowse's own");
  // Background networking on: extensions update from the Web Store, Safe Browsing refreshes its lists.
  assert.ok(ignoreDefaultArgs.includes(DRIVER_BACKGROUND_SWITCH));
  assert.ok(!args.includes(DRIVER_BACKGROUND_SWITCH));
});

packTest("humanized mouse moves take the fast shape unless config asks for another; the adaptive pace adds the combined one", async () => {
  const pack = await loadPack();
  const app = appFixture();
  // Each launch: the motions the pack was given, in order (the adaptive pace's two sets take a
  // page hook each, as the pack's own install does on a context).
  const launches = [];
  for (const pairbrowse of [{}, { motion: "classic" }, { motion: "combined" }, { motion: "quick" }, { motion: "anything else" }, { inputPace: "fast" }, { inputPace: "human" }, { motion: "quick", typingPace: 0.5, inputPace: "human" }]) {
    const seen = [];
    const spy = { ...pack, installHumanizeOnContext: (scope, opts) => { seen.push(opts); scope.on("page", () => {}); } };
    await launchNative(fakeBrowserType(), { pairbrowse: { fingerprint: "motion-seed", ...pairbrowse } }, mkdtempSync(join(tmpdir(), "pairbrowse-motion-")),
      { executablePath: app.executablePath, headless: false }, spy);
    launches.push(seen);
  }
  assert.deepEqual(launches.map((seen) => seen.map((o) => o.motion)), [["fast", "combined"], ["classic", "combined"], ["combined", "combined"], ["quick", "combined"], ["fast", "combined"], ["fast"], ["combined"], ["combined"]]);
  assert.ok(launches.flat().every((o) => o.humanize === true && o.seed));
  assert.deepEqual(launches[0].map((o) => o.typingPace), [TYPING_PACE, 1], "the fast set types at typingPace, the everyday one at an everyday typist's");
  assert.deepEqual(launches[0].map((o) => o.showCursor), [false, false]);
  assert.deepEqual(launches[7].map((o) => o.typingPace), [1], "\"human\" always types as an everyday typist");
  assert.deepEqual(paceSets({ motion: "combined", typingPace: 1 }), { fast: { motion: "combined", typingPace: 1 } }, "one set when both paces are the same");
});

// A seeded generator, so a schedule's shape can be checked on fixed numbers.
function seeded(seed = 7) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test("form fill settings: typingPace 0.2, Tab between fields and the adaptive pace by default, floored and parsed", () => {
  assert.equal(TYPING_PACE, 0.2);
  assert.deepEqual(fillSettings({}), { typingPace: 0.2, formMove: "tab", inputPace: "adaptive" });
  assert.deepEqual(fillSettings(undefined), { typingPace: 0.2, formMove: "tab", inputPace: "adaptive" });
  assert.deepEqual(fillSettings({ pairbrowse: { typingPace: 0.5, formMove: "mouse", inputPace: "human" } }), { typingPace: 0.5, formMove: "mouse", inputPace: "human" });
  assert.equal(fillSettings({ pairbrowse: { formMove: "anything else" } }).formMove, "tab");
  assert.equal(fillSettings({ pairbrowse: { inputPace: "slow" } }).inputPace, "adaptive");
  assert.equal(fillSettings({ pairbrowse: { typingPace: 0.1 } }).typingPace, FILL_PACE_FLOOR, "a form never types quicker than the floor");
  assert.equal(fillSettings({ pairbrowse: { typingPace: 3 } }).typingPace, 1);
  assert.equal(fillSettings({ pairbrowse: { typingPace: "fast" } }).typingPace, 0.2);
});

test("a keystroke schedule types every key with a person's rhythm: rollover, Shift held, no faster than 40 ms a key", () => {
  const text = "Visser Tuinen BV, anna.visser@example.com";
  const events = keystrokeSchedule(text, 0.3, seeded());
  for (let i = 1; i < events.length; i++) assert.ok(events[i].at >= events[i - 1].at, "in time order");
  const downs = events.filter((e) => e.type === "down" && e.key !== "Shift").map((e) => e.key);
  assert.deepEqual(downs, Array.from(text), "every character goes down once, in order");
  const open = new Map();
  for (const e of events) {
    if (e.type === "down") { assert.equal(open.has(e.key), false, `${e.key} is up before it goes down again`); open.set(e.key, e.at); }
    else { assert.ok(open.has(e.key), `${e.key} was down`); assert.ok(e.at > open.get(e.key)); open.delete(e.key); }
  }
  assert.equal(open.size, 0, "every key comes up");
  // Shift is down while a capital or a sign is typed, up while plain letters are.
  let shift = false;
  for (const e of events) {
    if (e.key === "Shift") shift = e.type === "down";
    else if (e.type === "down") assert.equal(shift, /[A-Z@]/.test(e.key), `Shift ${shift ? "held" : "up"} for ${e.key}`);
  }
  // Rollover: some key goes down before the one before it is up.
  const keyed = events.filter((e) => e.key !== "Shift");
  assert.ok(keyed.some((e, i) => e.type === "down" && keyed[i - 1]?.type === "down"), "a quick typist's overlap");
  const perChar = (pace, rng) => { let total = 0, n = 0; for (let i = 0; i < 200; i++) { const ev = keystrokeSchedule(text, pace, rng); total += ev[ev.length - 1].at; n += text.length; } return total / n; };
  const rng = seeded(3);
  const floor = perChar(0.2, rng), fast = perChar(0.3, rng), slow = perChar(1, rng);
  assert.ok(floor >= 40, `the floor is about 40 ms a key: ${floor.toFixed(1)}`);
  assert.ok(floor < fast && fast < slow, "a lower pace is quicker");
  assert.ok(fast < 65, `0.3 is a quick hand: ${fast.toFixed(1)} ms a key`);
  assert.ok(slow > 110, `1 is the engine's own pace: ${slow.toFixed(1)} ms a key`);
  assert.deepEqual(keystrokeSchedule("", 0.3), []);
  assert.deepEqual(keystrokeSchedule("a\n", 0.3, seeded()).filter((e) => e.type === "down").map((e) => e.key), ["a", "Enter"]);
});

// The ordinary-browser measurement's two numbers for typing (server-mode spec, decision 11): the
// median time between one key going down and the next, and how many keys are still down when the
// next goes down. An everyday typist: about 150 ms and about one in five. The fast pace is the
// quick hand the measurement read (about 23 ms, nearly every key overlapping), kept where nothing
// scores the input (the adaptive pace, spec step 51).
const rhythm = (pace, human) => {
  const text = "The quick brown fox jumps over the lazy dog, then types dana.smith@example.com and Some Words.";
  const gaps = [], overlaps = [];
  for (let r = 0; r < 200; r++) {
    const ev = keystrokeSchedule(text, pace, seeded(r + 1), { human }).filter((e) => e.key !== "Shift");
    const downs = ev.filter((e) => e.type === "down");
    for (let i = 1; i < downs.length; i++) {
      gaps.push(downs[i].at - downs[i - 1].at);
      const up = ev.find((e) => e.type === "up" && e.key === downs[i - 1].key && e.at >= downs[i - 1].at);
      overlaps.push(up.at > downs[i].at);
    }
  }
  gaps.sort((a, b) => a - b);
  return { median: gaps[gaps.length >> 1], share: overlaps.filter(Boolean).length / overlaps.length, least: gaps[0] };
};
test("the fast pace is a quick typist's rollover, as before: about 25 ms between keys, most overlapping", () => {
  const { median, share } = rhythm(TYPING_PACE, false);
  assert.ok(median > 15 && median < 35, `median ${median.toFixed(0)} ms between keys`);
  assert.ok(share > 0.8, `${(share * 100).toFixed(0)}% of keys overlap the next`);
});
test("the everyday pace types as an everyday typist, whatever typingPace says: about 150 ms between keys, about one in five overlapping", () => {
  for (const pace of [TYPING_PACE, 0.5, 1]) {
    const { median, share, least } = rhythm(pace, true);
    assert.ok(median > 125 && median < 185, `median ${median.toFixed(0)} ms between keys`);
    assert.ok(share > 0.1 && share < 0.35, `${(share * 100).toFixed(0)}% of keys overlap the next`);
    assert.ok(least > 54, "no two keys closer than a hand manages");
  }
});

// A page with fields in tab order: what humanFill asks of it is recorded.
function fakeForm(fields) {
  const log = [];
  const byRef = new Map(fields.map((f) => [f.ref, { ...f, value: f.value ?? "", checked: f.checked ?? false, index: f.index ?? 0 }]));
  let focus = null, held = "";
  const typed = () => { const f = byRef.get(focus); if (f) f.value += held; held = ""; };
  const page = {
    _pairbrowseHumanized: true,
    // What the focused field holds (humanType reads back where the keys went).
    evaluate: async () => { const f = byRef.get(focus); return f && f.type !== "checkbox" ? f.value : null; },
    keyboard: {
      press: async (key) => {
        log.push(`press ${key}`);
        if (key === "Tab") { const refs = fields.map((f) => f.ref); focus = refs[refs.indexOf(focus) + 1] ?? null; }
        else if (key === "Space") { const f = byRef.get(focus); if (f?.type === "checkbox") f.checked = !f.checked; }
        else if (key === "Backspace") { const f = byRef.get(focus); if (f) f.value = ""; }
      },
      down: async (key) => {
        const f = byRef.get(focus);
        // A closed select picks the first option starting with what is typed, as the browser does.
        if (f?.type === "combobox" && key.length === 1) { f.prefix = (f.prefix || "") + key; f.index = f.options.findIndex((o) => o.toLowerCase().startsWith(f.prefix.toLowerCase())); }
        else if (key.length === 1 || key === "Enter") { held += key === "Enter" ? "\n" : key; typed(); }
        log.push(`down ${key}`);
      },
      up: async (key) => { log.push(`up ${key}`); },
    },
    locator: (selector) => {
      const ref = selector.replace("aria-ref=", "");
      const f = byRef.get(ref);
      const loc = {
        first: () => loc,
        evaluate: async (fn, arg) => {
          const source = String(fn);
          const refs = fields.map((x) => x.ref);
          if (source.includes("activeElement") && source.includes("order")) return focus === ref ? "focused" : refs[refs.indexOf(focus) + 1] === ref && !f.unreachable ? "tab" : "no";
          if (source.includes("activeElement") && source.includes("parts")) return focus === ref ? "here" : "elsewhere";
          if (source.includes("activeElement")) return focus === ref; // humanType: has it the focus
          if (source.includes("datetime-local") && source.includes("tagName")) return f.kind || "";
          if (source.includes("prefix")) return { from: f.index, to: f.options.indexOf(arg), prefix: arg[0] };
          if (source.includes("selectedIndex")) return f.index;
          return null;
        },
        click: async () => { log.push(`click ${ref}`); focus = ref; },
        inputValue: async () => { if (f.type === "checkbox") throw new Error("not a text field"); return f.value; },
        isChecked: async () => f.checked,
        setChecked: async (want) => { log.push(`setChecked ${ref}`); f.checked = want; },
        selectOption: async ({ label }) => { log.push(`selectOption ${ref}`); f.index = f.options.indexOf(label); },
        fill: async (value) => { log.push(`fill ${ref} ${page._pairbrowseHumanized ? "humanized" : "plain"}`); focus = ref; f.value = value; },
      };
      return loc;
    },
  };
  return { page, log, byRef };
}

test("a form fill goes field to field by Tab where that is next, by mouse otherwise, and reads each back", async () => {
  const form = fakeForm([
    { ref: "e1", type: "textbox" }, { ref: "e2", type: "textbox", value: "old" }, { ref: "e3", type: "combobox", options: ["Pick one", "Germany", "Netherlands"] },
    { ref: "e4", type: "textbox", kind: "date" }, { ref: "e5", type: "textbox", unreachable: true }, { ref: "e6", type: "checkbox" },
  ]);
  const items = [
    { target: "e1", name: "First name", type: "textbox", value: "Anna" },
    { target: "e2", name: "Last name", type: "textbox", value: "Visser" },
    { target: "e3", name: "Country", type: "combobox", value: "Netherlands" },
    { target: "e4", name: "Birthday", type: "textbox", value: "17 May 1990" },
    { target: "e5", name: "Notes", type: "textbox", value: "Hi" },
    { target: "e6", name: "I agree", type: "checkbox", value: "true" },
  ];
  const { lines, failed } = await humanFill(form.page, items, fillSettings({}), { rng: seeded(), wait: async () => {}, isoDate: (v) => (v === "17 May 1990" ? "1990-05-17" : null) });
  assert.equal(failed, false);
  assert.deepEqual(lines, ["Filled First name with Anna.", "Filled Last name with Visser.", "Chose Netherlands for Country.", "Filled Birthday with 1990-05-17.", "Filled Notes with Hi.", "Ticked I agree."]);
  assert.deepEqual([...form.byRef.values()].map((f) => f.value || f.index || f.checked), ["Anna", "Visser", 2, "1990-05-17", "Hi", true]);
  const moves = form.log.filter((l) => /^(click|fill|press Tab|press Space|setChecked|selectOption|press ControlOrMeta\+a|press Backspace)/.test(l));
  // A fresh page: Tab into the first field; a field with text in it is cleared first; the select by
  // its first letter; the date set at once in its turn, with the human-like input off for that; a
  // field not next in the order by mouse; the box by Space.
  assert.deepEqual(moves, ["press Tab", "press Tab", "press ControlOrMeta+a", "press Backspace", "press Tab", "press Tab", "fill e4 plain", "click e5", "press Tab", "press Space"]);
  assert.equal(form.page._pairbrowseHumanized, true, "the human-like input is back on after the date");
  assert.deepEqual(form.log.filter((l) => l === "down N"), ["down N"], "the select heard its option's first letter");
  assert.equal(form.log.filter((l) => l.startsWith("fill ")).length, 1, "no instant paste: every text went in key by key");
});

test("a form fill by mouse reaches for every field; a secret is never said; a value that doesn't stay is", async () => {
  const form = fakeForm([{ ref: "e1", type: "textbox" }, { ref: "e2", type: "textbox" }, { ref: "e3", type: "textbox", swallow: true }]);
  form.page.locator("aria-ref=e3"); // the page keeps what is typed into e3 only until it is read back
  const original = form.page.locator;
  form.page.locator = (selector) => { const loc = original(selector); if (selector.endsWith("e3")) loc.inputValue = async () => ""; return loc; };
  const items = [
    { target: "e1", name: "Email", type: "textbox", value: "a@b.c" },
    { target: "e2", name: "Password", type: "textbox", value: "real-secret", shown: "SITE_PASSWORD" },
    { target: "e3", name: "Code", type: "textbox", value: "1234" },
  ];
  const { lines, failed } = await humanFill(form.page, items, fillSettings({ pairbrowse: { formMove: "mouse" } }), { rng: seeded(), wait: async () => {} });
  assert.equal(failed, true);
  assert.deepEqual(lines, ["Filled Email with a@b.c.", "Filled Password with SITE_PASSWORD.", "Code didn't take what was typed: it is empty."]);
  assert.deepEqual(form.log.filter((l) => /^(click|press Tab)/.test(l)), ["click e1", "click e2", "click e3"], "by mouse: never Tab");
  assert.equal(lines.join().includes("real-secret"), false);
});

const T41 = "Second note typed in, thirty-eight chars."; // 41 characters, as the timing harness types
// The schedule's average per key at a pace, over 200 texts.
const perKey = (pace) => { let total = 0; for (let i = 0; i < 200; i++) total += keystrokeSchedule(T41, pace, seeded(i)).at(-1).at; return total / (200 * T41.length); };
// What humanType waited in all (a mocked clock: the sum grows with the pace, which is what is checked).
async function waitedBy(settings, options) {
  let waited = 0;
  await humanType(fakeForm([{ ref: "e1", type: "textbox" }]).page, { target: "e1", value: T41 }, settings, { rng: seeded(), wait: async (ms) => { waited += ms; }, ...options });
  return waited;
}

test("a single browser_type clicks the field once, clears it, types key by key at typingPace and reads it back", async () => {
  const form = fakeForm([{ ref: "e1", type: "textbox", value: "old" }, { ref: "e2", type: "textbox" }]);
  const wait = async () => {};
  const traced = [];
  const first = await humanType(form.page, { target: "e1", name: "Notes", value: T41 }, fillSettings({}), { rng: seeded(), wait, trace: (l) => traced.push(l) });
  assert.deepEqual(first, { line: "Typed into Notes.", failed: false });
  assert.equal(form.byRef.get("e1").value, T41, "the old text is gone, the new one in");
  const moves = form.log.filter((l) => /^(click|fill|press)/.test(l));
  assert.deepEqual(moves, ["click e1", "press ControlOrMeta+a", "press Backspace"], "the engine's own click, then a hand's clear; never an instant fill");
  assert.deepEqual(form.log.filter((l) => l.startsWith("down ") && l !== "down Shift").map((l) => l.slice(5)), Array.from(T41), "every character key by key");
  const quick = perKey(TYPING_PACE);
  assert.ok(quick >= 22 && quick < 40, `a fast typist's rollover at the default pace: ${quick.toFixed(1)} ms a key`);
  assert.match(traced[0], /^browser_type, 41 characters: Notes by click: check \d+, click \d+, read \d+, clear \d+, type \d+, read \d+ ms$/);
  // The field has the focus now: no second click.
  const again = await humanType(form.page, { target: "e1", name: "Notes", value: "Hi" }, fillSettings({}), { rng: seeded(), wait, trace: (l) => traced.push(l) });
  assert.deepEqual(again, { line: "Typed into Notes.", failed: false });
  assert.equal(form.log.filter((l) => l === "click e1").length, 1);
  assert.match(traced[1], /Notes by focused/);
});

test("browser_type says so when the keys went nowhere: nothing had the focus and the field is still empty", async () => {
  const form = fakeForm([{ ref: "e1", type: "textbox" }]);
  // The click lands but focuses nothing: the keys reach no field.
  const loc = form.page.locator;
  form.page.locator = (selector) => { const l = loc(selector); return { ...l, first: () => ({ ...l, click: async () => {} }) }; };
  const r = await humanType(form.page, { target: "e1", name: "Notes", value: "Hello" }, fillSettings({}), { rng: seeded(), wait: async () => {} });
  assert.deepEqual(r, { line: "Notes didn't take what was typed: it is empty.", failed: true });
});

test("browser_type slowly types at about 90 ms a key, at the caret, and still reads the field back", async () => {
  const slow = perKey(SLOW_TYPE_PACE);
  assert.ok(slow > 80 && slow < 100, `slowly is about 90 ms a key: ${slow.toFixed(1)}`);
  const form = fakeForm([{ ref: "e1", type: "textbox", value: "Ams" }]);
  const r = await humanType(form.page, { target: "e1", name: "Search", value: "terdam" }, fillSettings({}), { rng: seeded(), wait: async () => {}, slowly: true });
  assert.deepEqual(r, { line: "Typed into Search.", failed: false });
  assert.equal(form.byRef.get("e1").value, "Amsterdam", "slowly adds to what the field holds, as key-by-key typing did");
  assert.equal(form.log.some((l) => l === "press Backspace"), false);
  // Slowly waits longer than the default pace; a slower typingPace stays slower than slowly.
  const quick = await waitedBy(fillSettings({}), {});
  const slowly = await waitedBy(fillSettings({}), { slowly: true });
  const slowest = await waitedBy(fillSettings({ pairbrowse: { typingPace: 1 } }), { slowly: true });
  assert.ok(slowly > quick * 1.5 && slowest > slowly, `waited ${quick} < ${slowly} < ${slowest}`);
});

// The adaptive input pace (native/pace.mjs, spec step 51): each field typed at the pace decided for
// it, the decision told to the caller (the result says it).
test("browser_type types at the everyday rhythm where the pace for its field is human, and says which pace it took", async () => {
  const human = { pace: "human", why: "sign-in" }, fast = { pace: "fast", why: "" };
  const told = [];
  // A mocked clock: each wait is the time from the first key, so the longest is the whole text's.
  const typed = async (decision, settings = fillSettings({})) => {
    let waited = 0;
    const form = fakeForm([{ ref: "e1", type: "textbox" }]);
    const r = await humanType(form.page, { target: "e1", name: "Email", value: T41 }, settings, { rng: seeded(), wait: async (ms) => { waited = Math.max(waited, ms); }, decide: async (page, loc, setting) => { assert.equal(setting, settings.inputPace); assert.equal(typeof loc.evaluate, "function"); return decision; }, onPace: (d, label) => told.push([d, label]) });
    assert.deepEqual(r, { line: "Typed into Email.", failed: false });
    return waited / T41.length;
  };
  const quick = await typed(fast), everyday = await typed(human);
  assert.ok(quick < 45, `fast: ${quick.toFixed(1)} ms a key`);
  assert.ok(everyday > 120, `everyday: ${everyday.toFixed(1)} ms a key`);
  assert.deepEqual(told, [[fast, "Email"], [human, "Email"]]);
  // A quicker or slower typingPace changes the fast pace only.
  assert.ok(Math.abs(await typed(human, fillSettings({ pairbrowse: { typingPace: 0.5 } })) - everyday) < 1);
});

test("a form fill decides each field's pace as it reaches it", async () => {
  const form = fakeForm([{ ref: "e1", type: "textbox" }, { ref: "e2", type: "textbox" }, { ref: "e3", type: "textbox" }]);
  const items = [
    { target: "e1", name: "Search", type: "textbox", value: T41 },
    { target: "e2", name: "Email", type: "textbox", value: T41 },
    { target: "e3", name: "Password", type: "textbox", value: T41, shown: "SITE_PASSWORD" },
  ];
  const told = [], longest = { e1: 0, e2: 0, e3: 0 };
  let current = null, i = 0;
  const byField = { e1: { pace: "fast", why: "" }, e2: { pace: "human", why: "sign-in" }, e3: { pace: "human", why: "sign-in" } };
  // A mocked clock: each wait while typing is the time from the field's first key.
  const { lines, failed } = await humanFill(form.page, items, fillSettings({ pairbrowse: { formMove: "mouse" } }), {
    rng: seeded(), wait: async (ms) => { longest[current] = Math.max(longest[current], ms); },
    decide: async () => { current = items[i++].target; return byField[current]; },
    onPace: (decision, label) => told.push({ decision, label }),
  });
  assert.equal(failed, false);
  assert.deepEqual(lines, [`Filled Search with ${T41}`, `Filled Email with ${T41}`, "Filled Password with SITE_PASSWORD."]);
  assert.deepEqual(told.map((t) => [t.label, t.decision.pace]), [["Search", "fast"], ["Email", "human"], ["Password", "human"]]);
  const perKey = Object.fromEntries(Object.entries(longest).map(([k, v]) => [k, v / T41.length]));
  assert.ok(perKey.e1 < 45 && perKey.e2 > 120 && perKey.e3 > 120, `ms a key: ${JSON.stringify(perKey)}`);
});

test("browser_type never says a secret, and says when the value didn't stay", async () => {
  const form = fakeForm([{ ref: "e1", type: "textbox" }, { ref: "e2", type: "textbox" }, { ref: "e3", type: "textbox", value: "+31612345678" }]);
  const quiet = { rng: seeded(), wait: async () => {} };
  const secret = await humanType(form.page, { target: "e1", name: "Password", value: "real-secret", shown: "SITE_PASSWORD" }, fillSettings({}), quiet);
  assert.deepEqual(secret, { line: "Typed into Password.", failed: false });
  // The value is read back from the field with the focus: where the keys went, also when the page
  // swapped the element meanwhile (a search box with suggestions).
  const focusedValue = form.page.evaluate;
  form.page.evaluate = async () => "";
  const gone = await humanType(form.page, { target: "e2", name: "Code", value: "1234" }, fillSettings({}), quiet);
  assert.deepEqual(gone, { line: "Code didn't take what was typed: it is empty.", failed: true });
  form.page.evaluate = async () => "+31 6 1234 5678";
  const masked = await humanType(form.page, { target: "e3", name: "Phone", value: "+31612345678" }, fillSettings({}), quiet);
  assert.deepEqual(masked, { line: 'Typed into Phone; the page shows it as "+31 6 1234 5678".', failed: false });
  form.page.evaluate = focusedValue;
  const original = form.page.locator;
  form.page.locator = (selector) => { const loc = original(selector); loc.click = async () => { throw new Error("Element is not visible\nmore"); }; return loc; };
  const failed = await humanType(form.page, { target: "e1", name: "Hidden", value: "x" }, fillSettings({}), quiet);
  assert.deepEqual(failed, { line: "Hidden couldn't be typed into: Element is not visible", failed: true });
  assert.equal(JSON.stringify([secret, gone, masked, failed]).includes("real-secret"), false);
});

packTest("engine pack emits this platform's fingerprint, proxy, locale, and stable seed flags", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-flags-"));
  const chromium = fakeBrowserType();
  await launchNative(chromium, { pairbrowse: { fingerprint: "mac-seed", timezone: "Europe/Berlin", acceptLanguage: "de-DE,de" } }, directory,
    { executablePath: app.executablePath, headless: false, proxy: { server: "http://proxy.test:8080" } }, pack);
  const { options } = chromium.calls[0];
  assert.match(options.args.join("\n"), /--fingerprint=mac-seed/);
  assert.match(options.args.join("\n"), new RegExp(`--fingerprint-platform=${PLATFORM}\\b`));
  assert.match(options.args.join("\n"), /--timezone=Europe\/Berlin/);
  assert.match(options.args.join("\n"), /--accept-lang=de-DE,de/);
  assert.deepEqual(options.proxy, { server: "http://proxy.test:8080" });
});

macPackTest("macOS host capture keeps its seed across persisted restarts", async () => {
  rmSync(hostCachePath(), { force: true });
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-host-capture-"));
  const chromium = fakeBrowserType({
    webgl: { vendor: "Apple", renderer: "Apple M3 Pro" },
    webgpu: { vendor: "Apple", architecture: "Apple GPU" },
    media_devices: [], speech: [],
  });
  const lines = [];
  await launchNative(chromium, { pairbrowse: {} }, directory,
    { executablePath: app.executablePath, headless: false }, pack, (line) => lines.push(line));
  // Each launch step's time (plans/555 item 4): the capture inside the fingerprint step, then the launch.
  assert.match(lines.join("\n"), /^launch: fingerprint \d+ ms \(host capture \d+ ms\)$/m);
  assert.match(lines.join("\n"), /^launch: launchPersistentContext \d+ ms$/m);
  assert.ok(lines.indexOf(MEASURING) >= 0 && lines.indexOf(MEASURING) < lines.findIndex((l) => l.startsWith("launch: fingerprint")), "the capture is told before it runs");
  assert.equal(readdirSync(directory).some(name => name.startsWith(".mac-host-capture-")), false);
  const saved = pack.Profile.load(join(directory, "pairbrowse-persona.json")).options;
  assert.equal(saved.fingerprint.length, 64);
  assert.deepEqual(saved.fingerprintProfile.webgl, { vendor: "Apple", renderer: "Apple M3 Pro" });
  const second = fakeBrowserType({});
  const later = [];
  await launchNative(second, { pairbrowse: {} }, directory,
    { executablePath: app.executablePath, headless: false }, pack, (line) => later.push(line));
  assert.equal(later.includes(MEASURING), false, "cached: no measuring");
  assert.ok(second.calls[0].options.args.includes(`--fingerprint=${saved.fingerprint}`));
});

offMacPackTest("off macOS there's no host capture: the browser runs seeded, and the seed persists", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-seeded-"));
  const chromium = fakeBrowserType({});
  await launchNative(chromium, { pairbrowse: {} }, directory, { executablePath: app.executablePath, headless: false }, pack);
  assert.equal(chromium.calls.length, 1, "only the browser itself is launched");
  const saved = pack.Profile.load(join(directory, "pairbrowse-persona.json")).options;
  assert.equal(saved.fingerprint.length, 64);
  assert.equal(saved.fingerprintProfile, undefined);
  const second = fakeBrowserType({});
  await launchNative(second, { pairbrowse: {} }, directory, { executablePath: app.executablePath, headless: false }, pack);
  assert.ok(second.calls[0].options.args.includes(`--fingerprint=${saved.fingerprint}`));
});

macPackTest("nested collector WebGPU info is flattened for native profile import", async () => {
  rmSync(hostCachePath(), { force: true });
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-webgpu-normalize-"));
  const chromium = fakeBrowserType({
    webgl: { webgl1: { parameters: {} }, webgl2: null },
    webgpu: { info: { vendor: "apple", architecture: "apple-gpu", device: "", description: "" }, limits: {} },
    speech: [], media_devices: [],
  });
  await launchNative(chromium, { pairbrowse: {} }, directory,
    { executablePath: app.executablePath, headless: false }, pack);
  const saved = pack.Profile.load(join(directory, "pairbrowse-persona.json")).options.fingerprintProfile;
  assert.deepEqual(saved.webgpu, { vendor: "apple", architecture: "apple-gpu", device: "", description: "", limits: {} });
});

packTest("captured profile objects persist without an accidental seed", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-captured-"));
  const chromium = fakeBrowserType();
  const profile = new pack.Profile("captured", {
    fingerprintProfile: { navigator: { languages: ["en-US"] } },
    agentLlmKey: "do-not-persist",
  });
  await launchNative(chromium, { pairbrowse: { profile } }, directory,
    { executablePath: app.executablePath, headless: false }, pack);
  const args = chromium.calls[0].options.args;
  assert.ok(args.some(a => a.startsWith("--fingerprint-profile=")));
  assert.equal(args.some(a => a.startsWith("--fingerprint=")), false);
  const saved = readFileSync(join(directory, "pairbrowse-persona.json"), "utf8");
  assert.equal(saved.includes("do-not-persist"), false);
  assert.equal(pack.Profile.load(join(directory, "pairbrowse-persona.json")).options.fingerprint, undefined);
});

// The canvas bridge (it sent what pages draw to a program at an address) is gone: refused where a
// person sets it, dropped from the persona kept with a profile, stripped from the switches.
test("config.json canvasBridge refused before anything launches", async () => {
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-bridge-config-"));
  const chromium = fakeBrowserType();
  await assert.rejects(() => launchNative(chromium, { pairbrowse: { canvasBridge: { url: "ws://127.0.0.1:9099" } } }, directory,
    { executablePath: app.executablePath, headless: false }, fakePack), /config\.json's pairbrowse block sets canvasBridge: refused/);
  assert.equal(chromium.calls.length, 0);
});

test("canvas-bridge switches are recognized in every spelling", () => {
  for (const a of ["--canvas-bridge-url=ws://x", "--canvas-bridge-auth=k", "-canvas-bridge-mode=all", "--Canvas-Bridge-Allow=a"]) assert.ok(isCanvasBridgeSwitch(a), a);
  for (const a of ["--canvas-noise", "--fingerprint=1", "canvas-bridge-url", null]) assert.ok(!isCanvasBridgeSwitch(a), String(a));
});

packTest("saved persona canvasBridge refused", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-bridge-saved-"));
  const profile = new pack.Profile("bridged", { fingerprint: "seed", canvasBridge: { url: "ws://127.0.0.1:9099", auth: "secret" } });
  const chromium = fakeBrowserType();
  await assert.rejects(() => launchNative(chromium, { pairbrowse: { profile } }, directory,
    { executablePath: app.executablePath, headless: false }, pack), /saved profile \(pairbrowse\.profile\) sets canvasBridge: refused/);
  assert.equal(chromium.calls.length, 0);
});

packTest("persisted canvasBridge dropped", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-bridge-persisted-"));
  const personaPath = join(directory, "pairbrowse-persona.json");
  new pack.Profile("pairbrowse", { fingerprint: "kept-seed", canvasBridge: { url: "ws://127.0.0.1:9099", auth: "secret" } }).save(personaPath);
  const chromium = fakeBrowserType();
  const lines = [];
  await launchNative(chromium, { pairbrowse: {} }, directory, { executablePath: app.executablePath, headless: false }, pack, (l) => lines.push(l));
  assert.equal(lines.filter((l) => l === CANVAS_BRIDGE_DROPPED).length, 1, lines.join("\n"));
  const args = chromium.calls[0].options.args;
  assert.ok(!args.some(isCanvasBridgeSwitch), args.join(" "));
  assert.ok(args.includes("--fingerprint=kept-seed"), "the rest of the persona stays");
  const saved = readFileSync(personaPath, "utf8");
  assert.ok(!saved.includes("canvasBridge") && !saved.includes("9099") && !saved.includes("secret"), "never written back");
});

packTest("no --canvas-bridge-* reaches the launch, sandbox still on", async () => {
  const real = await loadPack();
  // A pack that adds the bridge's switches itself: the launch strips them anyway.
  const pack = { ...real, gateEngineSwitches: (path, args, x) => {
    const gated = real.gateEngineSwitches(path, args, x);
    return { ...gated, args: [...gated.args, "--canvas-bridge-url=ws://127.0.0.1:9099", "--canvas-bridge-auth=secret", "-Canvas-Bridge-Mode=all"] };
  } };
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-bridge-switches-"));
  const chromium = fakeBrowserType();
  const lines = [];
  await launchNative(chromium, { pairbrowse: { fingerprint: "seed" } }, directory, { executablePath: app.executablePath, headless: false, chromiumSandbox: true }, pack, (l) => lines.push(l));
  const { options } = chromium.calls[0];
  assert.ok(!options.args.some((a) => /canvas-bridge/i.test(a)), options.args.join(" "));
  assert.ok(lines.some((l) => /--canvas-bridge-url, --canvas-bridge-auth, -Canvas-Bridge-Mode stripped/.test(l)) && !lines.some((l) => l.includes("secret")), lines.join("\n"));
  assert.equal(options.chromiumSandbox, true);
  assert.ok(!options.args.some((a) => /no-sandbox/i.test(a)));
});

packTest("a saved profile's launch controls and extensions are named and dropped through the real pack", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-saved-controls-"));
  const profile = new pack.Profile("saved-controls", {
    fingerprint: "saved-seed",
    extensions: ["/tmp/saved-extension"],
    disablePrivacySandbox: false,
  });
  const chromium = fakeBrowserType();
  const lines = [];
  await launchNative(chromium, { pairbrowse: { profile } }, directory,
    { executablePath: app.executablePath, headless: false }, pack, (l) => lines.push(l));
  const args = chromium.calls[0].options.args;
  assert.ok(!args.some((a) => a.includes("/tmp/saved-extension")), "only PairBrowse's own extension loads");
  assert.ok(lines.includes(droppedLine("saved", ["extensions", "disablePrivacySandbox"])), lines.join("\n"));
  assert.ok(args.includes("--fingerprint=saved-seed"), "its fingerprint still applies");
});

packTest("unsupported options in saved profiles are rejected before launch", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-saved-reject-"));
  const profile = new pack.Profile("saved-reject", { personaSchema: 2 });
  await assert.rejects(() => launchNative(fakeBrowserType(), { pairbrowse: { profile } }, directory,
    { executablePath: app.executablePath }, pack), /does not support pairbrowse\.personaSchema/);
});

packTest("fingerprint passthrough is rejected when loaded from a saved profile", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-saved-off-"));
  const profile = new pack.Profile("saved-off", { fingerprint: "off" });
  await assert.rejects(() => launchNative(fakeBrowserType(), { pairbrowse: { profile } }, directory,
    { executablePath: app.executablePath }, pack), /passthrough needs a newer/);
});

packTest("GeoIP refreshes persisted implicit locale after proxy changes", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-geo-"));
  new pack.Profile('old', { fingerprint: 'saved', timezone: 'America/New_York', acceptLanguage: 'en-US' })
    .save(join(directory, 'pairbrowse-persona.json'));
  pack.applyGeoip = async fingerprint => {
    assert.equal(fingerprint.timezone, undefined);
    assert.equal(fingerprint.acceptLanguage, undefined);
    fingerprint.timezone = 'Europe/Berlin';
    fingerprint.acceptLanguage = 'de-DE';
  };
  const chromium = fakeBrowserType();
  await launchNative(chromium, { pairbrowse: { geoip: true } }, directory,
    { executablePath: app.executablePath, headless: false }, pack);
  assert.ok(chromium.calls[0].options.args.includes('--timezone=Europe/Berlin'));
});

// Spec C9: what geoip derives is a measurement of this launch's exit address, so the persona file
// never holds it (a session's region follows its proxy, and the file never names an address); the
// pack is asked quietly and through the launch's proxy.
packTest("geoip with a proxy never writes its fields into the persona", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-geo-persona-"));
  const personaPath = join(directory, "pairbrowse-persona.json");
  // A persona written before this change still holds the fields: the next geoip launch drops them.
  new pack.Profile("old", { fingerprint: "kept-seed", timezone: "America/New_York", acceptLanguage: "en-US", webrtcIp: "192.0.2.44", location: "40.7,-74.0" }).save(personaPath);
  const proxy = { server: "http://203.0.113.10:3128" };
  const asked = [];
  pack.applyGeoip = async (fingerprint, given, quiet) => {
    asked.push({ given, quiet });
    for (const key of ["timezone", "acceptLanguage", "webrtcIp", "location"]) assert.equal(fingerprint[key], undefined, key);
    Object.assign(fingerprint, { timezone: "Europe/Berlin", acceptLanguage: "de-DE", webrtcIp: "198.51.100.7", location: "52.52,13.40" });
  };
  for (const _ of [1, 2]) {
    const chromium = fakeBrowserType();
    await launchNative(chromium, { pairbrowse: { geoip: true } }, directory, { executablePath: app.executablePath, headless: false, proxy }, pack);
    assert.ok(chromium.calls[0].options.args.includes("--timezone=Europe/Berlin"), "this launch still uses what geoip found");
    const saved = readFileSync(personaPath, "utf8");
    for (const word of ["timezone", "acceptLanguage", "webrtcIp", "location", "Europe/Berlin", "America/New_York", "198.51.100.7", "192.0.2.44", "203.0.113.10"]) assert.ok(!saved.includes(word), `${word} kept in ${saved}`);
    assert.equal(pack.Profile.load(personaPath).options.fingerprint, "kept-seed", "the rest of the persona stays");
  }
  assert.deepEqual(asked, [{ given: proxy, quiet: true }, { given: proxy, quiet: true }]);
});

packTest("geoip values set in config.json still apply, and are read from there again, not the persona", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-geo-set-"));
  pack.applyGeoip = async (fingerprint) => { fingerprint.timezone ??= "Europe/Berlin"; fingerprint.acceptLanguage ??= "de-DE"; };
  const chromium = fakeBrowserType();
  await launchNative(chromium, { pairbrowse: { geoip: true, timezone: "Asia/Tokyo" } }, directory, { executablePath: app.executablePath, headless: false }, pack);
  assert.ok(chromium.calls[0].options.args.includes("--timezone=Asia/Tokyo"));
  assert.ok(!readFileSync(join(directory, "pairbrowse-persona.json"), "utf8").includes("Asia/Tokyo"));
});

// D12: without geoip too, a set time zone is read from its setting at each launch and the persona
// keeps none (nor a language); one an older version kept there is no longer read.
packTest("without geoip a set time zone applies from config.json at each launch; the persona keeps none", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-geo-off-"));
  pack.applyGeoip = async () => { throw new Error("geoip is off"); };
  const chromium = fakeBrowserType();
  await launchNative(chromium, { pairbrowse: { timezone: "Asia/Tokyo" } }, directory, { executablePath: app.executablePath, headless: false }, pack);
  assert.ok(chromium.calls[0].options.args.includes("--timezone=Asia/Tokyo"));
  const kept = pack.Profile.load(join(directory, "pairbrowse-persona.json")).options;
  assert.equal(kept.timezone, undefined);
  assert.equal(kept.acceptLanguage, undefined);
  new pack.Profile("pairbrowse", { ...kept, timezone: "Asia/Tokyo" }).save(join(directory, "pairbrowse-persona.json"));
  const again = fakeBrowserType();
  await launchNative(again, { pairbrowse: {} }, directory, { executablePath: app.executablePath, headless: false }, pack);
  assert.ok(again.calls[0].options.args.includes(`--timezone=${Intl.DateTimeFormat().resolvedOptions().timeZone}`), "this computer's, not one an older persona kept");
});

packTest("a geoip failure stops the launch with a sentence naming no address", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-geo-fail-"));
  pack.applyGeoip = async () => { throw new Error("geoip: could not resolve the connection's region (no timezone for exit IP 198.51.100.7). Set timezone and acceptLanguage, or fix the proxy."); };
  const chromium = fakeBrowserType();
  await assert.rejects(() => launchNative(chromium, { pairbrowse: { geoip: true } }, directory, { executablePath: app.executablePath, headless: false }, pack),
    (error) => /could not resolve the connection's region \(no timezone for exit IP an address\)/.test(error.message) && !error.message.includes("198.51.100.7"));
  assert.equal(chromium.calls.length, 0);
});

test("withoutAddresses takes IPv4 and IPv6 addresses out of a sentence, nothing else", () => {
  assert.equal(withoutAddresses("no timezone for exit IP 198.51.100.7."), "no timezone for exit IP an address.");
  assert.equal(withoutAddresses("exit IP 2001:db8::1)"), "exit IP an address)");
  assert.equal(withoutAddresses("2001:db8:0:0:0:0:0:1."), "an address.");
  assert.equal(withoutAddresses("ip ::ffff:192.0.2.1 and ::1"), "ip an address and an address");
  for (const kept of ["timed out after 20s (PAIRBROWSE_ENGINE_GEOIP_TIMEOUT_SECONDS)", "invalid proxy (http://proxy.example:3128)", "at 12:30:45", "geoip: could not determine the exit IP through the proxy"]) {
    assert.equal(withoutAddresses(kept), kept);
  }
});

packTest("native launch refuses options this engine can't honour", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-reject-"));
  await assert.rejects(() => launchNative(fakeBrowserType(), { pairbrowse: { socks5Udp: true } }, directory,
    { executablePath: app.executablePath }, pack), /does not support pairbrowse\.socks5Udp/);
});

packTest("a WebRTC IP policy in browserArgs never loosens the default deny, in any spelling", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-profile-"));
  const chromium = fakeBrowserType();
  const lines = [];
  await launchNative(chromium, { pairbrowse: { fingerprint: "rtc-seed", humanize: false } }, directory,
    { executablePath: app.executablePath, headless: false, args: ["--webrtc-ip-handling-policy=default", "--force-webrtc-ip-handling-policy", "-webrtc-ip-handling-policy=default", "--WebRTC-IP-Handling-Policy=default", ...(process.platform === "win32" ? ["/webrtc-ip-handling-policy=default"] : []), "--lang=en"] }, pack, (l) => lines.push(l));
  const args = chromium.calls[0].options.args;
  const rtc = args.filter((a) => /webrtc-ip-handling-policy/i.test(a));
  assert.deepEqual(rtc, ["--webrtc-ip-handling-policy=disable_non_proxied_udp"], rtc.join(" "));
  assert.ok(args.includes("--lang=en"), "other switches pass");
  assert.ok(lines.some((l) => /WebRTC IP handling switch in browserArgs was dropped/.test(l)));
});

// A strict proxied session (net/config.mjs launchPart): its WebRTC switch is the default deny's
// own policy, kept as given (no "dropped" line, no second copy), its resolver rule passes, and the
// driver gets the proxy as given (no credential in it).
packTest("a strict proxied session's switches and proxy reach the native launch as given", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-strict-"));
  const chromium = fakeBrowserType();
  const lines = [];
  const proxy = { server: "http://203.0.113.10:3128", bypass: "localhost,127.0.0.1,[::1]" };
  await launchNative(chromium, { pairbrowse: { fingerprint: "strict-seed", humanize: false } }, directory,
    { executablePath: app.executablePath, headless: false, proxy, args: ["--lang=en", resolverRule("203.0.113.10"), STRICT_WEBRTC] }, pack, (l) => lines.push(l));
  const { options } = chromium.calls[0];
  assert.deepEqual(options.args.filter((a) => /webrtc-ip-handling-policy/i.test(a)), [STRICT_WEBRTC]);
  assert.deepEqual(options.args.filter((a) => /host-resolver-rules/.test(a)), [resolverRule("203.0.113.10")]);
  assert.deepEqual(options.proxy, proxy);
  assert.ok(!lines.some((l) => /WebRTC IP handling switch in browserArgs was dropped/.test(l)), lines.join("\n"));
});

packTest("config.pairbrowse passes only PairBrowse's settings and the engine's fingerprint options to a launch", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-closed-"));
  const chromium = fakeBrowserType();
  const lines = [];
  const own = "/opt/pairbrowse/ui";
  await launchNative(chromium, { pairbrowse: { fingerprint: "closed-seed", humanize: false, extensions: ["/tmp/evil-ext"], proxy: { server: "http://evil.example:8080" },
    args: ["--gpu-launcher=/bin/evil"], ignoreDefaultArgs: true, executablePath: "/bin/evil", disablePrivacySandbox: false, agentLlmUrl: "http://evil.example" } }, directory,
  { executablePath: app.executablePath, headless: false, args: [`--load-extension=${own}`, `--disable-extensions-except=${own}`, "--lang=en"] }, pack, (l) => lines.push(l));
  const { options } = chromium.calls[0];
  const args = options.args.join(" ");
  assert.ok(!args.includes("evil"), args);
  assert.ok(args.includes(own), "PairBrowse's own extension still loads");
  assert.equal(options.proxy, undefined);
  assert.equal(options.executablePath, app.executablePath);
  assert.ok(options.args.includes("--fingerprint=closed-seed"), "fingerprint options pass");
  assert.ok(lines.some((l) => /pairbrowse\.extensions, pairbrowse\.proxy, pairbrowse\.args/.test(l) && /not used/.test(l)), lines.join("\n"));
});

// The collector nests WebGPU under webgpu.info; the engine reads webgpu.vendor (spec E10 W1). One
// function flattens it, on every layer a fingerprintProfile comes from.
const NESTED_WEBGPU = { info: { vendor: "apple", architecture: "apple-gpu", device: "", description: "" }, limits: { maxBindGroups: 4 } };
const FLAT_WEBGPU = { vendor: "apple", architecture: "apple-gpu", device: "", description: "", limits: { maxBindGroups: 4 } };

test("normalizeWebgpu flattens the collector's nested WebGPU and leaves every other shape as it was", () => {
  const nested = { webgl: { vendor: "Apple" }, webgpu: structuredClone(NESTED_WEBGPU) };
  const flat = normalizeWebgpu(nested);
  assert.deepEqual(flat, { webgl: { vendor: "Apple" }, webgpu: FLAT_WEBGPU });
  assert.deepEqual(nested.webgpu, NESTED_WEBGPU, "the given profile is never changed");
  assert.equal(normalizeWebgpu(flat), flat, "already flat: the same object");
  const withVendor = { webgpu: { vendor: "apple", info: { vendor: "other" } } };
  assert.equal(normalizeWebgpu(withVendor), withVendor, "a top-level vendor wins");
  for (const same of [{ webgpu: { available: false } }, { webgpu: null }, { webgpu: { info: "text" } }, {}, null, undefined, "profile.json", 7, []]) {
    assert.equal(normalizeWebgpu(same), same);
  }
});

test("a fingerprintProfile's WebGPU is flattened whether it is an object, a file or JSON text; the file is never written", () => {
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-webgpu-file-"));
  const file = join(directory, "profile.json");
  const text = JSON.stringify({ webgpu: NESTED_WEBGPU });
  writeFileSync(file, text);
  assert.deepEqual(flatWebgpuProfile(file), { webgpu: FLAT_WEBGPU });
  assert.equal(readFileSync(file, "utf8"), text, "the user's file stays as it was");
  assert.deepEqual(flatWebgpuProfile(text), { webgpu: FLAT_WEBGPU });
  assert.deepEqual(flatWebgpuProfile({ webgpu: NESTED_WEBGPU }), { webgpu: FLAT_WEBGPU });
  const flatFile = join(directory, "flat.json");
  writeFileSync(flatFile, JSON.stringify({ webgpu: FLAT_WEBGPU }));
  assert.equal(flatWebgpuProfile(flatFile), flatFile, "a flat file passes on as its path");
  assert.equal(flatWebgpuProfile("not json"), "not json");
  assert.equal(flatWebgpuProfile(join(directory, "missing.json")), join(directory, "missing.json"));
});

test("the Mac host capture hands the engine a flat WebGPU", async () => {
  const chromium = fakeBrowserType({ webgl: { vendor: "Apple", renderer: "Apple M3 Pro" }, webgpu: structuredClone(NESTED_WEBGPU), media_devices: [] });
  const captured = await captureMacHost(chromium, "/fake", fakePack, mkdtempSync(join(tmpdir(), "pairbrowse-capture-webgpu-")), null);
  assert.deepEqual(captured.webgpu, FLAT_WEBGPU);
});

// A host profile cached before the flattening (nested WebGPU) is flattened on a cache hit, never captured again.
test("a cached Mac host profile with nested WebGPU comes back flat without a new capture", async () => {
  rmSync(hostCachePath(), { force: true });
  const chromium = fakeBrowserType();
  const hardware = () => "Mac15,7|AGXAcceleratorG15X";
  await macHostProfile(chromium, "/fake", fakePack, mkdtempSync(join(tmpdir(), "pairbrowse-cache-webgpu-")), "150.0.7871.114", hardware);
  const { key } = JSON.parse(readFileSync(hostCachePath(), "utf8"));
  writeFileSync(hostCachePath(), JSON.stringify({ key, profile: { webgl: { vendor: "Apple", renderer: "Apple M3 Pro" }, webgpu: structuredClone(NESTED_WEBGPU) } }));
  const cached = await macHostProfile(chromium, "/fake", fakePack, mkdtempSync(join(tmpdir(), "pairbrowse-cache-webgpu-")), "150.0.7871.114", hardware);
  assert.deepEqual(cached.webgpu, FLAT_WEBGPU);
  assert.equal(chromium.captures, 1, "a cache hit: no capture");
});

// Just enough of the engine pack for launchNative: it records the fingerprint the engine is given.
function recordingPack({ saved = {} } = {}) {
  class Profile {
    constructor(name, options) { this.name = name; this.options = options; }
    save(path) { writeFileSync(path, JSON.stringify({ name: this.name, options: this.options })); }
    static load(path) { const { name, options } = JSON.parse(readFileSync(path, "utf8")); return new Profile(name, options); }
  }
  const given = [];
  return {
    given, Profile, DEFAULT_IGNORED_ARGS: [],
    resolveProfileOptions: () => structuredClone(saved),
    splitFingerprintOptions: (options) => {
      const { fingerprintProfile, fingerprint, timezone, acceptLanguage, platform, brandVersion, ...rest } = options;
      return { fingerprint: Object.fromEntries(Object.entries({ fingerprintProfile, fingerprint, timezone, acceptLanguage, platform, brandVersion }).filter(([, v]) => v !== undefined)), rest };
    },
    // D9: never called; a call fails the launch it came from.
    measureHost: async () => { throw new Error("measureHost called"); },
    resolveAuto: async () => { throw new Error("resolveAuto called"); },
    resolveLocal: () => { throw new Error("resolveLocal called"); },
    splitAgentOptions: (options) => ({ agent: {}, rest: options }),
    resolveProxy: (proxy) => ({ args: [], proxy }),
    engineSupportsSwitch: () => false,
    mergeFeatureFlags: (args) => args,
    fingerprintArgs: (fingerprint) => { given.push(fingerprint); return []; },
    agentArgs: () => [], privacySandboxArgs: () => [], portableArgs: () => [], extensionArgs: () => [],
    webrtcDefaultDenyArgs: () => [], gpuBlocklistArgs: () => [],
    gateEngineSwitches: (_, args) => ({ args }),
    installHumanizeOnContext: () => {},
  };
}

test("nested WebGPU is flattened on every layer: config, saved and persisted", async () => {
  const app = appFixture();
  const launch = async (config, pack, directory = mkdtempSync(join(tmpdir(), "pairbrowse-webgpu-layer-"))) => {
    await launchNative(fakeBrowserType(), config, directory, { executablePath: app.executablePath, headless: false }, pack);
    const persona = JSON.parse(readFileSync(join(directory, "pairbrowse-persona.json"), "utf8")).options;
    return { engine: pack.given[0].fingerprintProfile, persona: persona.fingerprintProfile, directory };
  };
  const nestedProfile = () => ({ navigator: { languages: ["en-US"] }, webgpu: structuredClone(NESTED_WEBGPU) });

  const config = await launch({ pairbrowse: { fingerprint: "seed", fingerprintProfile: nestedProfile() } }, recordingPack());
  assert.deepEqual(config.engine.webgpu, FLAT_WEBGPU, "config.json");
  assert.deepEqual(config.persona.webgpu, FLAT_WEBGPU, "the persona keeps the flat form");

  const file = join(mkdtempSync(join(tmpdir(), "pairbrowse-webgpu-saved-")), "profile.json");
  writeFileSync(file, JSON.stringify(nestedProfile()));
  const saved = await launch({ pairbrowse: { profile: "mine" } }, recordingPack({ saved: { fingerprintProfile: file } }));
  assert.deepEqual(saved.engine.webgpu, FLAT_WEBGPU, "a saved profile naming a file");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).webgpu, NESTED_WEBGPU, "the saved profile's file stays as it was");

  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-webgpu-persisted-"));
  writeFileSync(join(directory, "pairbrowse-persona.json"), JSON.stringify({ name: "pairbrowse", options: { fingerprint: "seed", fingerprintProfile: nestedProfile() } }));
  const persisted = await launch({ pairbrowse: {} }, recordingPack(), directory);
  assert.deepEqual(persisted.engine.webgpu, FLAT_WEBGPU, "the persisted persona");

  const unreadable = await launch({ pairbrowse: { fingerprint: "seed", fingerprintProfile: file.replace("profile.json", "missing.json") } }, recordingPack());
  assert.equal(unreadable.engine, file.replace("profile.json", "missing.json"), "a path that isn't readable passes on as it was");
});

// Today's behavior, pinned before spec D7, D12 change it (F1, F4, F7). Each test names the decision
// that turns it around; until then a change here is a change in what reaches the engine.
const PINNED_PROFILE = () => ({ navigator: { languages: ["en-US"] } });

// Spec D9 (F5): config.json's persona "auto" and "local" once had the engine pack measure this
// computer and pick another device's persona from a library or a service (whose address the build
// rewrites to .invalid). Now both are this computer: the macOS host capture, else the seed persona;
// the pack's measureHost, resolveAuto and resolveLocal are never called, no probe browser starts,
// and the launch says so in one log line.
test("auto never calls resolveAuto", async () => {
  const app = appFixture();
  for (const selection of ["auto", "local"]) {
    const pack = Object.assign(recordingPack(), { collector: "" });
    const calls = [];
    for (const name of ["measureHost", "resolveAuto", "resolveLocal"]) pack[name] = () => { calls.push(name); throw new Error(`${name} called`); };
    const chromium = fakeBrowserType();
    let probes = 0;
    chromium.launch = async () => { probes++; return { close() {} }; };
    const directory = mkdtempSync(join(tmpdir(), `pairbrowse-d9-${selection}-`));
    const lines = [];
    await launchNative(chromium, { pairbrowse: { profile: selection, profileSelect: { mode: "best" } } }, directory, { executablePath: app.executablePath, headless: false }, pack, (l) => lines.push(l));
    assert.deepEqual(calls, [], `${selection}: the engine pack picks nothing`);
    assert.equal(probes, 0, `${selection}: no probe browser`);
    assert.equal(chromium.calls.length, 1, `${selection}: the browser starts`);
    assert.ok(lines.includes(`launch: pairbrowse.profile "${selection}": ${THIS_COMPUTER_NOTE}`), `${selection}: one note: ${JSON.stringify(lines)}`);
    assert.equal(lines.filter((l) => l.includes(THIS_COMPUTER_NOTE)).length, 1);
    assert.ok(!lines.some((l) => /persona selected from/.test(l)), `${selection}: no persona picked`);
    const given = pack.given[0];
    if (process.platform === "darwin") assert.ok(given.fingerprintProfile && typeof given.fingerprintProfile === "object", `${selection}: this Mac's own capture`);
    else {
      assert.equal(given.fingerprintProfile, undefined, `${selection}: the seed persona, no other device's profile`);
      assert.equal(given.fingerprint, sha256(directory), `${selection}: the session's own seed`);
    }
  }
  // A saved persona named in config.json is still read in place (it is offered for import).
  const named = recordingPack({ saved: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE() } });
  const lines = [];
  await launchNative(fakeBrowserType(), { pairbrowse: { profile: "mine" } }, mkdtempSync(join(tmpdir(), "pairbrowse-d9-named-")), { executablePath: app.executablePath, headless: false }, named, (l) => lines.push(l));
  assert.deepEqual(named.given[0].fingerprintProfile, PINNED_PROFILE());
  assert.ok(!lines.some((l) => l.includes(THIS_COMPUTER_NOTE)));
});


// Spec D7 (F1): config.json passes only the engine's fingerprint options, and so do a saved
// profile and the persona kept with a session: their launch controls (args, env, ignoreDefaultArgs,
// the sandbox, the executable), extensions and agent or storage options are named in one log line
// per layer (names only, never values) and dropped; the persona written back keeps only the
// fingerprint. Their proxy refuses the launch instead (C10, below).
test("launch controls are named and dropped", async () => {
  const app = appFixture();
  const controls = () => ({ args: ["--f1-pinned-switch"], env: { F1_PINNED: "1" },
    ignoreDefaultArgs: ["--f1-ignored"], chromiumSandbox: false, executablePath: "/bin/f1-other", extensions: ["/tmp/f1-extension"],
    portableProfile: "/tmp/f1-portable", encryptionKey: "f1-secret-key", disablePrivacySandbox: false, "a key/../with odd letters": 1 });
  const layers = {
    saved: { config: { pairbrowse: { profile: "mine" } }, pack: recordingPack({ saved: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE(), ...controls() } }), persona: null,
      where: "the saved profile (pairbrowse.profile)" },
    persisted: { config: { pairbrowse: {} }, pack: recordingPack(), persona: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE(), ...controls() },
      where: "the persona kept with this session (pairbrowse-persona.json)" },
  };
  for (const [layer, { config, pack, persona, where }] of Object.entries(layers)) {
    const directory = mkdtempSync(join(tmpdir(), `pairbrowse-f1-${layer}-`));
    const personaPath = join(directory, "pairbrowse-persona.json");
    if (persona) writeFileSync(personaPath, JSON.stringify({ name: "pairbrowse", options: persona }));
    const chromium = fakeBrowserType();
    const lines = [];
    await launchNative(chromium, config, directory, { executablePath: app.executablePath, headless: false }, pack, (l) => lines.push(l));
    const { options } = chromium.calls[0];
    assert.ok(!options.args.includes("--f1-pinned-switch"), `${layer}: its args never reach the browser`);
    assert.equal(options.env, undefined, `${layer}: nor its env`);
    assert.ok(!options.ignoreDefaultArgs.includes("--f1-ignored"), `${layer}: nor its ignoreDefaultArgs`);
    assert.ok(!options.args.some((a) => a.includes("f1-")), `${layer}: nor its extension or portable profile: ${options.args.join(" ")}`);
    assert.equal(options.chromiumSandbox, true, `${layer}: the sandbox stays the helper's`);
    assert.equal(options.executablePath, app.executablePath, `${layer}: the executable stays the helper's`);
    const named = lines.filter((l) => l.includes(`in ${where} not used`));
    assert.deepEqual(named, [`launch: args, env, ignoreDefaultArgs, chromiumSandbox, executablePath, extensions, portableProfile, encryptionKey, disablePrivacySandbox, 1 other in ${where} not used: only the engine's fingerprint options pass from a persona (see docs/configuration.md)`], `${layer}: ${lines.join("\n")}`);
    assert.equal(droppedLine(layer, ["args"]), `launch: args in ${where} not used: only the engine's fingerprint options pass from a persona (see docs/configuration.md)`);
    assert.ok(!lines.some((l) => /f1-|F1_PINNED|odd letters/.test(l)), `${layer}: never a value or an odd name`);
    assert.deepEqual(pack.given[0].fingerprintProfile, PINNED_PROFILE(), `${layer}: the fingerprint still applies`);
    const written = JSON.parse(readFileSync(personaPath, "utf8")).options;
    assert.deepEqual(Object.keys(written).filter((k) => k in controls()), [], `${layer}: the persona written back keeps only the fingerprint`);
  }
});

// Spec D7: what passes from a saved profile and the persona kept with a session is
// PAIRBROWSE_ENGINE_KEYS and nothing else; options the engine can't honour still refuse (UNSUPPORTED).
test("saved and persisted layers pass only engine keys", async () => {
  const app = appFixture();
  const every = Object.fromEntries(PAIRBROWSE_ENGINE_KEYS.map((k) => [k, k === "fingerprintProfile" ? PINNED_PROFILE() : k === "fingerprint" ? "seed" : `v-${k}`]));
  const extra = { headless: true, args: ["--x"], userDataDir: "/tmp/x", proxyBypass: "x", agent: { key: "k" }, viewport: { width: 1 } };
  for (const layer of ["saved", "persisted"]) {
    const pack = recordingPack(layer === "saved" ? { saved: { ...every, ...extra } } : {});
    let rest = null;
    const split = pack.splitFingerprintOptions;
    pack.splitFingerprintOptions = (options) => { const out = split(options); rest = out.rest; return { fingerprint: { ...out.fingerprint, ...out.rest }, rest: {} }; };
    const directory = mkdtempSync(join(tmpdir(), `pairbrowse-d7-${layer}-`));
    if (layer === "persisted") writeFileSync(join(directory, "pairbrowse-persona.json"), JSON.stringify({ name: "pairbrowse", options: { ...every, ...extra } }));
    await launchNative(fakeBrowserType(), { pairbrowse: layer === "saved" ? { profile: "mine" } : {} }, directory, { executablePath: app.executablePath, headless: false }, pack);
    const reached = new Set([...Object.keys(pack.given[0]), ...Object.keys(rest)]);
    for (const k of Object.keys(extra)) assert.ok(!reached.has(k), `${layer}: ${k} dropped`);
    for (const k of reached) assert.ok(PAIRBROWSE_ENGINE_KEYS.includes(k), `${layer}: ${k} is an engine key`);
    for (const k of ["hardwareConcurrency", "storageQuota", "tlsProfile"]) assert.equal(pack.given[0][k], `v-${k}`, `${layer}: ${k} passes`);
    // The legacy GPU identity (U6) passes from a layer that sets it now, off Linux; never only from the kept persona.
    assert.equal(pack.given[0].gpuVendor, layer === "saved" && process.platform !== "linux" ? "v-gpuVendor" : undefined, `${layer}: gpuVendor`);
  }
  const unsupported = recordingPack({ saved: { fingerprint: "seed", personaSchema: 2 } });
  await assert.rejects(launchNative(fakeBrowserType(), { pairbrowse: { profile: "mine" } }, mkdtempSync(join(tmpdir(), "pairbrowse-d7-unsupported-")), { executablePath: app.executablePath, headless: false }, unsupported),
    /does not support pairbrowse\.personaSchema/);
});

// C10: a proxy in a saved profile or the persona kept with a session stops the launch with the
// move-it sentence; dropping it would turn a proxied session into a direct one.
test("a saved or persisted persona's proxy refuses the launch, pointing to network.proxies", async () => {
  const app = appFixture();
  const proxy = { server: "http://persona-proxy.test:8080", username: "persona-user", password: "persona-pass" };
  const layers = {
    saved: { config: { pairbrowse: { profile: "mine" } }, pack: recordingPack({ saved: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE(), proxy } }), persona: null,
      sentence: personaProxyRefusal("The saved profile (pairbrowse.profile)") },
    persisted: { config: { pairbrowse: {} }, pack: recordingPack(), persona: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE(), proxy },
      sentence: personaProxyRefusal("The persona kept with this session (pairbrowse-persona.json)") },
    "persisted, null": { config: { pairbrowse: {} }, pack: recordingPack(), persona: { fingerprint: "seed", proxy: null },
      sentence: personaProxyRefusal("The persona kept with this session (pairbrowse-persona.json)") },
  };
  for (const [layer, { config, pack, persona, sentence }] of Object.entries(layers)) {
    const directory = mkdtempSync(join(tmpdir(), "pairbrowse-c10-"));
    const personaPath = join(directory, "pairbrowse-persona.json");
    if (persona) writeFileSync(personaPath, JSON.stringify({ name: "pairbrowse", options: persona }));
    const before = existsSync(personaPath) ? readFileSync(personaPath, "utf8") : null;
    const chromium = fakeBrowserType();
    const error = await launchNative(chromium, config, directory, { executablePath: app.executablePath, headless: false }, pack).then(() => null, (e) => e);
    assert.ok(error, `${layer}: refused`);
    assert.equal(error.message, sentence, layer);
    assert.match(error.message, /network\.proxies/, `${layer}: names where a proxy goes`);
    assert.doesNotMatch(error.message, /persona-proxy|persona-user|persona-pass/, `${layer}: never the proxy's address or credentials`);
    assert.equal(chromium.calls.length, 0, `${layer}: no browser started`);
    assert.equal(existsSync(personaPath) ? readFileSync(personaPath, "utf8") : null, before, `${layer}: the persona file is left as it was`);
  }
});

// C1: a proxy's credentials never reach the driver's proxy option or a switch: the launch options'
// proxy with a user, a password or user info in its address stops the launch before the pack sees it.
test("a launch's proxy with credentials is refused; one without passes as it is", async () => {
  const app = appFixture();
  const refused = [
    { server: "http://proxy.test:8080", username: "u-secret" },
    { server: "http://proxy.test:8080", password: "p-secret" },
    { server: "http://u-secret:p-secret@proxy.test:8080" },
    { server: "socks5://u-secret@proxy.test:1080" },
    { server: "u-secret:p-secret@proxy.test:8080" },
    "http://u-secret:p-secret@proxy.test:8080",
  ];
  for (const proxy of refused) {
    assert.equal(proxyCredentials(proxy), true, JSON.stringify(proxy));
    const pack = recordingPack();
    let resolved = 0;
    pack.resolveProxy = (p) => { resolved++; return { args: [], proxy: p }; };
    const chromium = fakeBrowserType();
    const error = await launchNative(chromium, { pairbrowse: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE() } }, mkdtempSync(join(tmpdir(), "pairbrowse-c1-")),
      { executablePath: app.executablePath, headless: false, proxy }, pack).then(() => null, (e) => e);
    assert.equal(error?.message, PROXY_CREDENTIALS_REFUSAL, JSON.stringify(proxy));
    assert.doesNotMatch(error.message, /secret/);
    assert.equal(resolved, 0, "the engine pack never sees it");
    assert.equal(chromium.calls.length, 0, "no browser started");
  }
  for (const proxy of [undefined, null, { server: "http://proxy.test:8080" }, { server: "socks5://[::1]:1080/", bypass: "localhost" }, { server: "http://proxy.test:8080", username: "", password: "" }, { server: "http://proxy.test/a@b" }])
    assert.equal(proxyCredentials(proxy), false, JSON.stringify(proxy));
  const pack = recordingPack();
  const chromium = fakeBrowserType();
  await launchNative(chromium, { pairbrowse: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE() } }, mkdtempSync(join(tmpdir(), "pairbrowse-c1-")),
    { executablePath: app.executablePath, headless: false, proxy: { server: "http://proxy.test:8080", bypass: "localhost,127.0.0.1,[::1]" } }, pack);
  assert.deepEqual(chromium.calls[0].options.proxy, { server: "http://proxy.test:8080", bypass: "localhost,127.0.0.1,[::1]" });
});

test("proxyAuthFile: the build manifest's field, 1 and up, gates proxy credentials (962)", () => {
  assert.equal(proxyAuthFile({ proxyAuthFile: 1 }), true);
  assert.equal(proxyAuthFile({ proxyAuthFile: 2 }), true);
  for (const v of [undefined, 0, "1", true, 1.5, null, -1]) assert.equal(proxyAuthFile({ proxyAuthFile: v }), false, String(v));
  assert.equal(proxyAuthFile(null), false);
});

// Spec D12 (F4): the build's platform and brand version fill the fingerprint when no setting gives
// them, at each launch, and are never kept in the persona: an update within the major launches
// with the new build's version, one an older version kept is not read, and a persona copied from
// another system brings no platform along. A legacy config.json value (U6) still applies.
test("in-major update keeps no old brandVersion", async () => {
  const first = appFixture({ product: "PairBrowse", version: "150.0.7871.114", arch: "arm64" });
  const later = appFixture({ product: "PairBrowse", version: "150.0.7900.1", arch: "arm64" });
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-f4-"));
  const personaPath = join(directory, "pairbrowse-persona.json");
  const config = { pairbrowse: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE() } };
  const before = recordingPack();
  await launchNative(fakeBrowserType(), config, directory, { executablePath: first.executablePath, headless: false }, before);
  assert.equal(before.given[0].brandVersion, "150.0.7871.114");
  assert.equal(before.given[0].platform, PLATFORM);
  const stored = JSON.parse(readFileSync(personaPath, "utf8")).options;
  assert.equal(stored.brandVersion, undefined, "the derived brand version is never stored");
  assert.equal(stored.platform, undefined, "nor the derived platform");
  const after = recordingPack();
  await launchNative(fakeBrowserType(), config, directory, { executablePath: later.executablePath, headless: false }, after);
  assert.equal(after.given[0].brandVersion, "150.0.7900.1", "the updated build says its own version");
  // A persona an older version wrote, with the first build's values: not read.
  writeFileSync(personaPath, JSON.stringify({ name: "pairbrowse", options: { ...stored, brandVersion: "150.0.7871.114", platform: PLATFORM } }));
  const older = recordingPack();
  await launchNative(fakeBrowserType(), config, directory, { executablePath: later.executablePath, headless: false }, older);
  assert.equal(older.given[0].brandVersion, "150.0.7900.1", "an old stored version is not read");
  assert.equal(JSON.parse(readFileSync(personaPath, "utf8")).options.brandVersion, undefined, "and is gone once saved again");

  const other = PLATFORM === "windows" ? "linux" : "windows";
  const copied = mkdtempSync(join(tmpdir(), "pairbrowse-f4-copied-"));
  writeFileSync(join(copied, "pairbrowse-persona.json"), JSON.stringify({ name: "pairbrowse", options: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE(), platform: other } }));
  const moved = recordingPack();
  await launchNative(fakeBrowserType(), { pairbrowse: {} }, copied, { executablePath: later.executablePath, headless: false }, moved);
  assert.equal(moved.given[0].platform, PLATFORM, "a persona from another system brings no platform along");
  const legacy = recordingPack();
  await launchNative(fakeBrowserType(), { pairbrowse: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE(), platform: other, brandVersion: "149.0.1.1" } }, mkdtempSync(join(tmpdir(), "pairbrowse-f4-legacy-")), { executablePath: later.executablePath, headless: false }, legacy);
  assert.equal(legacy.given[0].platform, other, "config.json's legacy platform still applies (U6)");
  assert.equal(legacy.given[0].brandVersion, "149.0.1.1");
});

// Spec D12 (F7): a profile's languages reach the engine as Accept-Language (--accept-lang); a device
// profile given as a setting keeps its own languages; this computer's Intl fills in only when no
// setting names any, and neither is kept in the persona.
test("profile languages reach --accept-lang", async () => {
  const app = appFixture();
  const host = Intl.DateTimeFormat().resolvedOptions();
  const id = "p-0123456789abcdef";
  const store = { id, kind: "store", geoip: false, engineKeys: { acceptLanguage: "de-DE,de", timezone: "Europe/Berlin" } };
  const launch = async (config, pack = Object.assign(recordingPack(), { collector: "" })) => {
    const directory = mkdtempSync(join(tmpdir(), "pairbrowse-f7-"));
    const chromium = fakeBrowserType();
    await launchNative(chromium, config, directory, { executablePath: app.executablePath, headless: false }, pack);
    return { pack, chromium, stored: JSON.parse(readFileSync(join(directory, "pairbrowse-persona.json"), "utf8")).options };
  };
  const profile = await launch({ pairbrowse: { acceptLanguage: "ja-JP" }, browserProfile: store });
  assert.equal(profile.pack.given[0].acceptLanguage, "de-DE,de", "the profile's languages, not config.json's");
  assert.equal(profile.stored.acceptLanguage, undefined, "read from the profile at each launch, never the persona");
  const device = await launch({ pairbrowse: { fingerprint: "seed", fingerprintProfile: { navigator: { languages: ["nl-NL", "nl", "<bad>"] } } } });
  assert.equal(device.pack.given[0].acceptLanguage, "nl-NL,nl", "the device's own languages, not this computer's");
  assert.equal(device.pack.given[0].timezone, host.timeZone);
  assert.equal(device.stored.acceptLanguage, undefined);
  assert.equal(device.stored.timezone, undefined, "this computer's time zone is never stored");
  const plain = await launch({ pairbrowse: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE() } });
  assert.equal(plain.pack.given[0].acceptLanguage, "en-US");
  const none = await launch({ pairbrowse: { fingerprint: "seed", fingerprintProfile: { navigator: {} } } });
  assert.equal(none.pack.given[0].acceptLanguage, host.locale, "no setting names any: this computer's");
  const explicit = await launch({ pairbrowse: { fingerprint: "seed", acceptLanguage: "nl-NL,nl", timezone: "Europe/Amsterdam", fingerprintProfile: PINNED_PROFILE() } });
  assert.equal(explicit.pack.given[0].acceptLanguage, "nl-NL,nl", "a set acceptLanguage wins");
  assert.equal(explicit.pack.given[0].timezone, "Europe/Amsterdam");
  if (engineDir) {
    // Through the real engine pack: the switch the browser reads.
    const real = await launch({ pairbrowse: {}, browserProfile: store }, await loadPack());
    const args = real.chromium.calls[0].options.args;
    assert.ok(args.includes("--accept-lang=de-DE,de"), args.join(" "));
    assert.ok(args.includes("--timezone=Europe/Berlin"), args.join(" "));
  }
});

// D13 (spec step 37): the persona kept with a session is its browser profile's, saved under the
// profile's id; a launch on another profile is refused rather than carrying its seed and values over,
// and only the config-backed default takes over the "pairbrowse" persona every session had before.
// A store profile's engine keys replace config.json's own persona settings; the default's sit on them.
test("persona saved under the profile id; another profile's persona refused; a store profile's keys replace config.json's", async () => {
  const app = appFixture();
  const id = "p-0123456789abcdef", other = "p-fedcba9876543210", defaultId = "p-00000000000000aa";
  // A collector of its own: on macOS a store profile without a device of its own is this Mac (host capture).
  const launch = (config, directory, pack = Object.assign(recordingPack(), { collector: "" })) => launchNative(fakeBrowserType(), config, directory, { executablePath: app.executablePath, headless: false }, pack).then(() => pack);
  const storeLayer = { id, kind: "store", geoip: false, engineKeys: { timezone: "Europe/Berlin", acceptLanguage: "de-DE,de", fingerprint: "profile-seed" } };
  const config = { pairbrowse: { timezone: "Asia/Tokyo", acceptLanguage: "ja-JP", fingerprint: "config-seed", fingerprintProfile: PINNED_PROFILE(), profile: "auto" }, browserProfile: storeLayer };
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-persona-id-"));
  const pack = await launch(config, directory);
  assert.equal(pack.given[0].timezone, "Europe/Berlin");
  assert.equal(pack.given[0].acceptLanguage, "de-DE,de");
  assert.equal(pack.given[0].fingerprint, "profile-seed");
  const persona = JSON.parse(readFileSync(join(directory, "pairbrowse-persona.json"), "utf8"));
  assert.equal(persona.name, id, "saved under the profile's id");
  assert.equal(persona.options.timezone, undefined, "its time zone is read from the profile at each launch (D12)");
  assert.equal(persona.options.fingerprint, "profile-seed");
  // The same profile again: its own persona is read.
  assert.equal((await launch(config, directory)).given[0].fingerprint, "profile-seed");
  // Another profile on this folder: refused, the persona left as it was.
  const before = readFileSync(join(directory, "pairbrowse-persona.json"), "utf8");
  await assert.rejects(launch({ pairbrowse: {}, browserProfile: { ...storeLayer, id: other } }, directory), (e) => e.message === personaBindingRefusal(id, other));
  assert.equal(readFileSync(join(directory, "pairbrowse-persona.json"), "utf8"), before);
  assert.match(personaBindingRefusal("../x", other), /belongs to no browser profile, not p-fedcba9876543210: refused/, "a name that isn't an id is never repeated");
  // The persona from before profiles: the config-backed default takes it over under its id...
  const legacy = mkdtempSync(join(tmpdir(), "pairbrowse-persona-legacy-"));
  writeFileSync(join(legacy, "pairbrowse-persona.json"), JSON.stringify({ name: "pairbrowse", options: { fingerprint: "kept-seed", fingerprintProfile: PINNED_PROFILE() } }));
  const def = await launch({ pairbrowse: { timezone: "Asia/Tokyo" }, browserProfile: { id: defaultId, kind: "config", geoip: false, engineKeys: { timezone: "Asia/Tokyo" } } }, legacy);
  assert.equal(def.given[0].fingerprint, "kept-seed", "its seed kept");
  assert.equal(def.given[0].timezone, "Asia/Tokyo");
  assert.equal(JSON.parse(readFileSync(join(legacy, "pairbrowse-persona.json"), "utf8")).name, defaultId);
  // ...and a store profile never does.
  const legacy2 = mkdtempSync(join(tmpdir(), "pairbrowse-persona-legacy2-"));
  writeFileSync(join(legacy2, "pairbrowse-persona.json"), JSON.stringify({ name: "pairbrowse", options: { fingerprint: "kept-seed" } }));
  await assert.rejects(launch({ pairbrowse: {}, browserProfile: storeLayer }, legacy2), (e) => e.message === personaBindingRefusal("pairbrowse", id));
  // Without a profile (the install self-check, older callers) the persona keeps its old name.
  const plain = mkdtempSync(join(tmpdir(), "pairbrowse-persona-plain-"));
  await launch({ pairbrowse: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE() } }, plain);
  assert.equal(JSON.parse(readFileSync(join(plain, "pairbrowse-persona.json"), "utf8")).name, "pairbrowse");
});

// A server's UTC clock (decision 11's measurement): the launch says how to give the session the
// exit's zone, only on a server, only when nothing sets the zone.
test("a server launch on a UTC clock says how to set the exit's time zone", async () => {
  assert.equal(clockZoneNote("Europe/Berlin"), null);
  assert.equal(clockZoneNote(undefined), null);
  for (const z of ["UTC", "Etc/UTC", "Etc/GMT+2", "GMT", "Universal"]) assert.match(clockZoneNote(z), /set the profile's locale\.timezone, or TZ for the helper \(docs\/server\.md\)/, z);
  const app = appFixture();
  const before = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const run = async (config) => {
      const lines = [];
      await launchNative(fakeBrowserType(), { pairbrowse: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE(), ...config.pairbrowse }, ...config.rest }, mkdtempSync(join(tmpdir(), "pairbrowse-zone-")),
        { executablePath: app.executablePath, headless: false, args: [] }, recordingPack(), (l) => lines.push(l));
      return lines.some((l) => /^launch: time zone UTC \(this computer's clock\)/.test(l));
    };
    assert.equal(await run({ rest: { virtualDisplay: { width: 1366, height: 900, depth: 24 } } }), true, "a server on UTC");
    assert.equal(await run({ rest: { server: { keepAlive: true } } }), true, "keepAlive is a server too");
    assert.equal(await run({ rest: {} }), false, "a desktop's clock is the person's own");
    assert.equal(await run({ pairbrowse: { timezone: "UTC" }, rest: { virtualDisplay: { width: 1366, height: 900, depth: 24 } } }), false, "a zone set on purpose");
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

// Spec E2, E7 and section 13.1: on Linux the launch passes the real backend's strings, no noise and
// the virtual screen (config.virtualDisplay, the helper's Xvfb) as the screen; on macOS no noise
// over this Mac's pixels; elsewhere nothing.
// What the plan adds is worked out at each launch and never kept in the persona.
test("the graphics plan reaches the engine and never the persona", async () => {
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-graphics-plan-"));
  const pack = recordingPack();
  const lines = [];
  await launchNative(fakeBrowserType(), { pairbrowse: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE(), graphics: "software" }, virtualDisplay: { width: 1366, height: 900, depth: 24 } }, directory,
    { executablePath: app.executablePath, headless: false, args: ["--use-angle=swiftshader"] }, pack, (l) => lines.push(l));
  const linux = process.platform === "linux";
  const mac = process.platform === "darwin";
  const expected = linux ? { disableGpuFingerprint: true, fingerprintNoise: false, screenWidth: 1366, screenHeight: 900, availWidth: 1366, availHeight: 900, colorDepth: 24, devicePixelRatio: 1 } : mac ? { fingerprintNoise: false } : {};
  for (const [k, v] of Object.entries(expected)) assert.equal(pack.given[0][k], v, k);
  if (!linux) for (const k of ["disableGpuFingerprint", ...(mac ? [] : ["fingerprintNoise"]), "screenWidth"]) assert.equal(pack.given[0][k], undefined, k);
  const stored = JSON.parse(readFileSync(join(directory, "pairbrowse-persona.json"), "utf8")).options;
  for (const k of ["disableGpuFingerprint", "fingerprintNoise", "screenWidth", "screenHeight", "availWidth", "availHeight", "colorDepth", "devicePixelRatio"]) assert.equal(stored[k], undefined, `${k} is never kept`);
  assert.ok(!lines.some((l) => /pairbrowse\.graphics in config\.json not used/.test(l)), "pairbrowse.graphics is PairBrowse's own setting");
  assert.equal(GRAPHICS.requested, "software");
  assert.deepEqual(GRAPHICS.switches, ["--use-angle=swiftshader"]);
  assert.equal(GRAPHICS.kind, "unverified", "until the browser process says");
  assert.equal(GRAPHICS.shown, null, "the runtime's own graphics");
  // Decision 10: the launch's engine config carries the backend measured or kept (measuredBackend,
  // daemon/browser/launch.mjs and native/check.mjs probeLauncher); a software one on Linux shows
  // the engine's identity, with canvas noise as pairbrowse.canvasNoise says, never kept in the persona.
  const shownDir = mkdtempSync(join(tmpdir(), "pairbrowse-graphics-shown-"));
  const shownPack = recordingPack();
  await launchNative(fakeBrowserType(), { pairbrowse: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE(), graphicsNoise: false }, virtualDisplay: { width: 1366, height: 900, depth: 24 }, measuredBackend: { kind: "software", renderer: "llvmpipe" } }, shownDir,
    { executablePath: app.executablePath, headless: false, args: [] }, shownPack, (l) => lines.push(l));
  if (linux) {
    assert.deepEqual([shownPack.given[0].disableGpuFingerprint, shownPack.given[0].fingerprintNoise, shownPack.given[0].canvasNoise, shownPack.given[0].screenWidth], [false, false, false, 1366]);
    assert.equal(GRAPHICS.shown, "Intel UHD Graphics 770");
    assert.ok(lines.some((l) => /graphics: software rendering, shown as Intel UHD Graphics 770 .*canvas noise off/.test(l)));
  } else {
    assert.equal(GRAPHICS.shown, null, "never off Linux");
    assert.equal(shownPack.given[0].disableGpuFingerprint, undefined);
  }
  const shownStored = JSON.parse(readFileSync(join(shownDir, "pairbrowse-persona.json"), "utf8")).options;
  for (const k of ["disableGpuFingerprint", "fingerprintNoise", "canvasNoise", "screenWidth"]) assert.equal(shownStored[k], undefined, `${k} is never kept`);
  // A build whose engine takes the pool switch (patch 967; the pack reads the build's switches):
  // the Windows identity (decision 11): platform windows among the engine's options, the screen
  // less a taskbar, the identity's own switches on the launch's command line (the pool entry,
  // WebGPU's software adapter by name with the service on; never the unsafe switch), nothing
  // of it kept in the persona, and the wheel's notch the Windows one for the pack.
  const winDir = mkdtempSync(join(tmpdir(), "pairbrowse-graphics-windows-"));
  const winPack = recordingPack();
  winPack.engineSupportsSwitch = (exe, name) => name === "fingerprint-gpu-pool";
  winPack.humanize = [];
  winPack.installHumanizeOnContext = (scope, opts) => { winPack.humanize.push(opts); };
  const winChromium = fakeBrowserType();
  await launchNative(winChromium, { pairbrowse: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE() }, virtualDisplay: { width: 1366, height: 900, depth: 24 }, measuredBackend: { kind: "software", renderer: "llvmpipe" } }, winDir,
    { executablePath: app.executablePath, headless: false, args: [] }, winPack, (l) => lines.push(l));
  const winArgs = winChromium.calls.at(-1).options.args;
  if (linux) {
    assert.equal(GRAPHICS.shown, "Windows 11 with NVIDIA GeForce RTX 3060");
    assert.deepEqual([winPack.given[0].platform, winPack.given[0].availHeight, winPack.given[0].screenHeight], ["windows", 852, 900]);
    for (const s of ["--fingerprint-gpu-pool=nvidia", "--use-webgpu-adapter=swiftshader"]) assert.ok(winArgs.includes(s), `${s} in ${winArgs.join(" ")}`);
    assert.ok(winArgs.some((a) => /^--enable-features=.*\bWebGPUService\b/.test(a)), "the WebGPU service feature on");
    assert.ok(!winArgs.some((a) => /unsafe-webgpu/.test(a)), "never the unsafe switch");
    assert.ok(lines.some((l) => /graphics: software rendering, shown as Windows 11 with NVIDIA GeForce RTX 3060/.test(l)));
    assert.equal(winPack.humanize.at(-1)?.wheelNotch, 100, "the wheel's notch is Windows'");
  } else {
    assert.equal(GRAPHICS.shown, null, "never off Linux");
    assert.ok(!winArgs.some((a) => /fingerprint-gpu-pool|use-webgpu-adapter|WebGPUService/.test(a)), "no identity switch off Linux");
    assert.equal(winPack.humanize.at(-1)?.wheelNotch, process.platform === "darwin" ? 40 : 120, "the wheel's notch is this computer's");
  }
  const winStored = JSON.parse(readFileSync(join(winDir, "pairbrowse-persona.json"), "utf8")).options;
  for (const k of ["platform", "availHeight", "screenWidth", "canvasNoise"]) assert.equal(winStored[k], undefined, `${k} is never kept`);
  assert.ok(!lines.some((l) => /pairbrowse\.graphicsNoise in config\.json not used/.test(l)), "pairbrowse.graphicsNoise is PairBrowse's own setting");
});

// Decision U6: a legacy GPU key removed from config.json is gone at the next launch, never kept
// on by the persona the first launch saved (and never named deprecated again).
test("a legacy GPU key removed from config.json is neither applied nor logged at the next launch", async () => {
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-legacy-gpu-"));
  const run = async (extra) => {
    const pack = recordingPack();
    // The real pack keeps gpuVendor with the fingerprint; this one's split would leave it out.
    const split = pack.splitFingerprintOptions;
    pack.splitFingerprintOptions = (options) => { const out = split(options); return { fingerprint: { ...out.fingerprint, ...out.rest }, rest: {} }; };
    const lines = [];
    await launchNative(fakeBrowserType(), { pairbrowse: { fingerprint: "seed", fingerprintProfile: PINNED_PROFILE(), ...extra } }, directory, { executablePath: app.executablePath, headless: false }, pack, (l) => lines.push(l));
    return { given: pack.given[0], lines };
  };
  const first = await run({ gpuVendor: "Old Vendor" });
  assert.ok(first.lines.some((l) => /gpuVendor .*deprecated/.test(l)), first.lines.join("\n"));
  if (process.platform !== "linux") assert.equal(first.given.gpuVendor, "Old Vendor");
  const next = await run({});
  assert.equal(next.given.gpuVendor, undefined);
  assert.ok(!next.lines.some((l) => /gpuVendor/.test(l)), next.lines.join("\n"));
  assert.equal(JSON.parse(readFileSync(join(directory, "pairbrowse-persona.json"), "utf8")).options.gpuVendor, undefined, "the persona no longer keeps it");
});

// Spec E7 on Linux: a screen key set without screenWidth and screenHeight gives way to the virtual
// screen's with a log line, never silently.
test("on the virtual screen a lone screen key is replaced with a log line", () => {
  const lines = [];
  const fingerprint = { devicePixelRatio: 2, colorDepth: 24 };
  applyGraphicsPlan(fingerprint, { overrides: { devicePixelRatio: 2, colorDepth: 24 }, saved: {} }, { platform: "linux", display: { width: 1366, height: 900, depth: 24 }, log: (l) => lines.push(l) });
  assert.equal(fingerprint.devicePixelRatio, 1);
  assert.equal(fingerprint.screenWidth, 1366);
  assert.ok(lines.some((l) => /^launch: devicePixelRatio not applied on Linux: the virtual screen's apply/.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /colorDepth not applied/.test(l)), "an equal value isn't named");
  // With screenWidth and screenHeight set, the layer's screen stands and nothing is named.
  const own = { screenWidth: 1920, screenHeight: 1080, devicePixelRatio: 2 };
  const quiet = [];
  applyGraphicsPlan(own, { overrides: { ...own }, saved: {} }, { platform: "linux", display: { width: 1366, height: 900, depth: 24 }, log: (l) => quiet.push(l) });
  assert.equal(own.devicePixelRatio, 2);
  assert.ok(!quiet.some((l) => /not applied on Linux: the virtual screen/.test(l)));
});
