import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchNative, nativeManifest } from "../scripts/native-engine.mjs";
import { loadEngine } from "../scripts/native-pack.mjs";

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
    launchPersistentContext: async (profile, options) => {
      if (profile.includes(".mac-host-capture-")) {
        if (!options.args.includes("--disable-gpu-fingerprint")) throw new Error("probe must disable GPU fingerprinting");
        return { pages() { return [{ async evaluate() { return captured; } }]; }, async close() {} };
      }
      calls.push({ profile, options });
      return { closed: false, on() {}, pages() { return []; }, async close() { this.closed = true; } };
    },
    launch: async () => ({ close() {} }),
  };
  return chromium;
}

// An unpacked engine pack (the folder with engine.mjs), e.g. ~/.pairbrowse/engine.
const engineDir = process.env.PAIRBROWSE_TEST_ENGINE;
const packTest = engineDir ? test : test.skip;
const loadPack = () => loadEngine(engineDir);

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

packTest("engine pack emits macOS fingerprint, proxy, locale, and stable seed flags", async () => {
  const pack = await loadPack();
  const app = appFixture();
  const directory = mkdtempSync(join(tmpdir(), "pairbrowse-flags-"));
  const chromium = fakeChromium();
  await launchNative(chromium, { pairbrowse: { fingerprint: "mac-seed", timezone: "Europe/Berlin", acceptLanguage: "de-DE,de" } }, directory,
    { executablePath: app.executablePath, headless: false, proxy: { server: "http://proxy.test:8080" } }, pack);
  const { options } = chromium.calls[0];
  assert.match(options.args.join("\n"), /--fingerprint=mac-seed/);
  assert.match(options.args.join("\n"), /--fingerprint-platform=macos/);
  assert.match(options.args.join("\n"), /--timezone=Europe\/Berlin/);
  assert.match(options.args.join("\n"), /--accept-lang=de-DE,de/);
  assert.deepEqual(options.proxy, { server: "http://proxy.test:8080" });
});

packTest("macOS host capture keeps its seed across persisted restarts", async () => {
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

packTest("nested collector WebGPU info is flattened for native profile import", async () => {
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
