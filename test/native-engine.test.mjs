import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative, nativeManifest, macHostProfile, hostCachePath, screenInfoArg, fillSettings, keystrokeSchedule, humanFill, TYPING_PACE, FILL_PACE_FLOOR } from "../scripts/native-engine.mjs";
import { loadEngine } from "../scripts/native-pack.mjs";

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

function fakeChromium(captured = { webgl: { vendor: "Apple", renderer: "Apple test GPU" }, speech: [], media_devices: [] }) {
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
  const chromium = fakeChromium({ webgl: { vendor: "Apple", renderer: "Apple M3 Pro" } });
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

test("a software WebGL renderer is never kept as this Mac's profile", async () => {
  rmSync(hostCachePath(), { force: true });
  const chromium = fakeChromium({ webgl: { webgl1: { UNMASKED_RENDERER_WEBGL: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)" } } });
  await assert.rejects(() => macHostProfile(chromium, "/fake", fakePack, mkdtempSync(join(tmpdir(), "pairbrowse-sw-")), "150.0.7871.114", () => "x"), /software WebGL renderer/);
  assert.equal(existsSync(hostCachePath()), false);
});

test("the hidden capture is told the real screen in physical pixels", () => {
  assert.equal(screenInfoArg({ width: 1728, height: 1117, top: 34, bottom: 77, scale: 2, edr: 16 }),
    "--screen-info={0,0 3456x2234 colorDepth=30 devicePixelRatio=2 workAreaTop=68 workAreaBottom=154}");
  assert.match(screenInfoArg({ width: 1920, height: 1080, top: 25, bottom: 0, scale: 1, edr: 1 }), /colorDepth=24 devicePixelRatio=1 /);
});

test("native app metadata requires a PairBrowse Chromium 150 bundle", () => {
  const good = appFixture();
  assert.equal(nativeManifest(good.executablePath).version, "150.0.7871.114");
  const bad = appFixture({ product: "Other", version: "150.0.7871.114" });
  assert.throws(() => nativeManifest(bad.executablePath), /Chromium 150 PairBrowse/);
  const wrongVersion = appFixture({ product: "PairBrowse", version: "149.0.1.1" });
  assert.throws(() => nativeManifest(wrongVersion.executablePath), /Chromium 150 PairBrowse/);
});

packTest("engine pack profile persistence round-trips through native launch", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-profile-"));
  const chromium = fakeChromium();
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
  const chromium = fakeChromium();
  await launchNative(chromium, { pairbrowse: { fingerprint: "named-seed" } }, directory,
    { executablePath: app.executablePath, headless: false }, pack);
  assert.equal(chromium.calls[0].options.args.find(a => a.startsWith("--fingerprint=")), "--fingerprint=named-seed");
});

packTest("humanized mouse moves take the combined shape unless config asks for the classic one", async () => {
  const pack = await loadPack();
  const seen = [];
  const spy = { ...pack, installHumanizeOnContext: (context, opts) => seen.push(opts) };
  const app = appFixture();
  for (const pairbrowse of [{}, { motion: "classic" }, { motion: "anything else" }]) {
    await launchNative(fakeChromium(), { pairbrowse: { fingerprint: "motion-seed", ...pairbrowse } }, mkdtempSync(join(tmpdir(), "pairbrowse-motion-")),
      { executablePath: app.executablePath, headless: false }, spy);
  }
  assert.deepEqual(seen.map((o) => o.motion), ["combined", "classic", "combined"]);
  assert.ok(seen.every((o) => o.humanize === true && o.seed));
  assert.ok(seen.every((o) => o.typingPace === TYPING_PACE), "single actions type at the default pace");
});

// A seeded generator, so a schedule's shape can be checked on fixed numbers.
function seeded(seed = 7) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test("form fill settings: typingPace 0.3 and Tab between fields by default, floored and parsed", () => {
  assert.equal(TYPING_PACE, 0.3);
  assert.deepEqual(fillSettings({}), { typingPace: 0.3, formMove: "tab" });
  assert.deepEqual(fillSettings(undefined), { typingPace: 0.3, formMove: "tab" });
  assert.deepEqual(fillSettings({ pairbrowse: { typingPace: 0.5, formMove: "mouse" } }), { typingPace: 0.5, formMove: "mouse" });
  assert.equal(fillSettings({ pairbrowse: { formMove: "anything else" } }).formMove, "tab");
  assert.equal(fillSettings({ pairbrowse: { typingPace: 0.2 } }).typingPace, FILL_PACE_FLOOR, "a form never types quicker than the floor");
  assert.equal(fillSettings({ pairbrowse: { typingPace: 3 } }).typingPace, 1);
  assert.equal(fillSettings({ pairbrowse: { typingPace: "fast" } }).typingPace, 0.3);
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

// A page with fields in tab order: what humanFill asks of it is recorded.
function fakeForm(fields) {
  const log = [];
  const byRef = new Map(fields.map((f) => [f.ref, { ...f, value: f.value ?? "", checked: f.checked ?? false, index: f.index ?? 0 }]));
  let focus = null, held = "";
  const typed = () => { const f = byRef.get(focus); if (f) f.value += held; held = ""; };
  const page = {
    _pairbrowseHumanized: true,
    keyboard: {
      press: async (key) => {
        log.push(`press ${key}`);
        if (key === "Tab") { const refs = fields.map((f) => f.ref); focus = refs[refs.indexOf(focus) + 1] ?? null; }
        else if (key === "Space") { const f = byRef.get(focus); if (f?.type === "checkbox") f.checked = !f.checked; }
        else if (key === "Backspace") { const f = byRef.get(focus); if (f) f.value = ""; }
      },
      down: async (key) => {
        const f = byRef.get(focus);
        // A closed select picks the first option starting with what is typed, as Chrome does.
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
          if (source.includes("activeElement")) return focus === ref ? "here" : "elsewhere";
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

packTest("engine pack emits this platform's fingerprint, proxy, locale, and stable seed flags", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-flags-"));
  const chromium = fakeChromium();
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
  const chromium = fakeChromium({
    webgl: { vendor: "Apple", renderer: "Apple M3 Pro" },
    webgpu: { vendor: "Apple", architecture: "Apple GPU" },
    media_devices: [], speech: [],
  });
  await launchNative(chromium, { pairbrowse: {} }, directory,
    { executablePath: app.executablePath, headless: false }, pack);
  assert.equal(readdirSync(directory).some(name => name.startsWith(".mac-host-capture-")), false);
  const saved = pack.Profile.load(join(directory, "pairbrowse-persona.json")).options;
  assert.equal(saved.fingerprint.length, 64);
  assert.deepEqual(saved.fingerprintProfile.webgl, { vendor: "Apple", renderer: "Apple M3 Pro" });
  const second = fakeChromium({});
  await launchNative(second, { pairbrowse: {} }, directory,
    { executablePath: app.executablePath, headless: false }, pack);
  assert.ok(second.calls[0].options.args.includes(`--fingerprint=${saved.fingerprint}`));
});

offMacPackTest("off macOS there's no host capture: the browser runs seeded, and the seed persists", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-seeded-"));
  const chromium = fakeChromium({});
  await launchNative(chromium, { pairbrowse: {} }, directory, { executablePath: app.executablePath, headless: false }, pack);
  assert.equal(chromium.calls.length, 1, "only the browser itself is launched");
  const saved = pack.Profile.load(join(directory, "pairbrowse-persona.json")).options;
  assert.equal(saved.fingerprint.length, 64);
  assert.equal(saved.fingerprintProfile, undefined);
  const second = fakeChromium({});
  await launchNative(second, { pairbrowse: {} }, directory, { executablePath: app.executablePath, headless: false }, pack);
  assert.ok(second.calls[0].options.args.includes(`--fingerprint=${saved.fingerprint}`));
});

macPackTest("nested collector WebGPU info is flattened for native profile import", async () => {
  rmSync(hostCachePath(), { force: true });
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-webgpu-normalize-"));
  const chromium = fakeChromium({
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
  const chromium = fakeChromium();
  const profile = new pack.Profile("captured", {
    fingerprintProfile: { navigator: { languages: ["en-US"] } },
    canvasBridge: { url: "ws://127.0.0.1:9099", auth: "secret" },
    agentLlmKey: "do-not-persist",
  });
  await launchNative(chromium, { pairbrowse: { profile } }, directory,
    { executablePath: app.executablePath, headless: false }, pack);
  const args = chromium.calls[0].options.args;
  assert.ok(args.some(a => a.startsWith("--fingerprint-profile=")));
  assert.equal(args.some(a => a.startsWith("--fingerprint=")), false);
  const saved = readFileSync(join(directory, "pairbrowse-persona.json"), "utf8");
  assert.equal(saved.includes("secret"), false);
  assert.equal(saved.includes("do-not-persist"), false);
  assert.equal(pack.Profile.load(join(directory, "pairbrowse-persona.json")).options.fingerprint, undefined);
});

packTest("saved profile launch controls survive the native adapter merge", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-saved-controls-"));
  const profile = new pack.Profile("saved-controls", {
    fingerprint: "saved-seed",
    extensions: ["/tmp/saved-extension"],
    disablePrivacySandbox: false,
  });
  const chromium = fakeChromium();
  await launchNative(chromium, { pairbrowse: { profile } }, directory,
    { executablePath: app.executablePath, headless: false }, pack);
  const args = chromium.calls[0].options.args;
  assert.ok(args.includes("--load-extension=/tmp/saved-extension"));
  assert.equal(args.some(a => a.startsWith("--disable-features=BrowsingTopics")), false);
});

packTest("unsupported options in saved profiles are rejected before launch", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-saved-reject-"));
  const profile = new pack.Profile("saved-reject", { personaSchema: 2 });
  await assert.rejects(() => launchNative(fakeChromium(), { pairbrowse: { profile } }, directory,
    { executablePath: app.executablePath }, pack), /does not support pairbrowse\.personaSchema/);
});

packTest("fingerprint passthrough is rejected when loaded from a saved profile", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-saved-off-"));
  const profile = new pack.Profile("saved-off", { fingerprint: "off" });
  await assert.rejects(() => launchNative(fakeChromium(), { pairbrowse: { profile } }, directory,
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
  const chromium = fakeChromium();
  await launchNative(chromium, { pairbrowse: { geoip: true } }, directory,
    { executablePath: app.executablePath, headless: false }, pack);
  assert.ok(chromium.calls[0].options.args.includes('--timezone=Europe/Berlin'));
});

packTest("native launch refuses options this engine can't honour", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-reject-"));
  await assert.rejects(() => launchNative(fakeChromium(), { pairbrowse: { socks5Udp: true } }, directory,
    { executablePath: app.executablePath }, pack), /does not support pairbrowse\.socks5Udp/);
});
