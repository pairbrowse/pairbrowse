import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync, symlinkSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pb-install-"));
process.env.PAIRBROWSE_HOME = home;
const { installNative, expectedSha256, nativeDirs, ensureNative, nativeLayout, pinnedAsset, buildFits, machoArchs } = await import("../scripts/native/install.mjs");
const { NATIVE } = await import("../scripts/native-pack.mjs");
const { BRANDING, rebrandPak, attributionIds } = await import("../scripts/native/macos-app.mjs");
const { nativeManifest } = await import("../scripts/native-engine.mjs");
// Nothing is downloaded in these tests: the pinned build can't be fetched, the engine pack is there.
const offline = { pinned: async () => { throw new Error("offline"); }, engine: async () => {}, asset: { file: "pairbrowse-test.zip", sha256: "ab".repeat(32) } };

// A locale.pak (format 5) holding these strings, as the engine ships them.
function pak(strings) {
  const data = strings.map((s) => Buffer.from(s, "utf8"));
  const header = Buffer.alloc(12 + (data.length + 1) * 6);
  header.writeUInt32LE(5, 0); header[4] = 1; header.writeUInt16LE(data.length, 8); header.writeUInt16LE(0, 10);
  let offset = header.length;
  data.forEach((d, i) => { header.writeUInt16LE(100 + i, 12 + i * 6); header.writeUInt32LE(offset, 14 + i * 6); offset += d.length; });
  header.writeUInt16LE(0, 12 + data.length * 6); header.writeUInt32LE(offset, 14 + data.length * 6);
  return Buffer.concat([header, ...data]);
}
const LOCALE = ["Customize Chromium", "About Chromium", "Settings"];
const temps = [];
const temp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
const mac = process.platform === "darwin";

// A tiny stand-in for a PairBrowse build: the right names, manifest and icon, ad-hoc signed.
// chrome: the manifest's `chrome` field (a build with its own pages), absent when not given.
function fakeArchive(version, dir = temp("pb-build-"), { chrome = undefined } = {}) {
  const app = join(dir, "PairBrowse.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  const fw = join(app, "Contents", "Frameworks", "Chromium Framework.framework");
  mkdirSync(join(fw, "Versions", "A", "Resources"), { recursive: true });
  copyFileSync("/usr/bin/true", join(fw, "Versions", "A", "Chromium Framework"));
  writeFileSync(join(fw, "Versions", "A", "Resources", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.pairbrowse.test.framework</string><key>CFBundleExecutable</key><string>Chromium Framework</string><key>CFBundlePackageType</key><string>FMWK</string></dict></plist>`);
  symlinkSync("A", join(fw, "Versions", "Current"));
  symlinkSync("Versions/Current/Chromium Framework", join(fw, "Chromium Framework"));
  symlinkSync("Versions/Current/Resources", join(fw, "Resources"));
  mkdirSync(join(fw, "Versions", "A", "Resources", "en.lproj"), { recursive: true });
  writeFileSync(join(fw, "Versions", "A", "Resources", "en.lproj", "locale.pak"), pak(LOCALE));
  // The engine's notification helper as it's built: the engine's name, ID and localized name.
  const alerts = join(fw, "Versions", "A", "Helpers", "Chromium Helper (Alerts).app", "Contents");
  mkdirSync(join(alerts, "MacOS"), { recursive: true });
  mkdirSync(join(alerts, "Resources", "base.lproj"), { recursive: true });
  copyFileSync("/usr/bin/true", join(alerts, "MacOS", "Chromium Helper (Alerts)"));
  writeFileSync(join(alerts, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleName</key><string>Chromium Helper (Alerts)</string><key>CFBundleDisplayName</key><string>Chromium Helper (Alerts)</string><key>CFBundleExecutable</key><string>Chromium Helper (Alerts)</string><key>CFBundleIdentifier</key><string>org.chromium.Chromium.framework.AlertNotificationService</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  writeFileSync(join(alerts, "Resources", "base.lproj", "InfoPlist.strings"), '"CFBundleDisplayName" = "Chromium";\n');
  copyFileSync("/usr/bin/true", join(app, "Contents", "MacOS", "pairbrowse"));
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleName</key><string>PairBrowse</string><key>CFBundleExecutable</key><string>pairbrowse</string><key>CFBundleIdentifier</key><string>app.pairbrowse.test</string></dict></plist>`);
  writeFileSync(join(app, "Contents", "Resources", "PairBrowse-build.json"), JSON.stringify({ product: "PairBrowse", version, arch: process.arch === "arm64" ? "arm64" : "x86_64", ...(chrome === undefined ? {} : { chrome }) }));
  copyFileSync(new URL("../scripts/browser/pairbrowse.icns", import.meta.url), join(app, "Contents", "Resources", "app.icns"));
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app]);
  const zip = join(dir, `pairbrowse-${version}.zip`);
  execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip]);
  const sha = createHash("sha256").update(readFileSync(zip)).digest("hex");
  writeFileSync(`${zip}.sha256`, `${sha}  pairbrowse-${version}.zip\n`);
  return zip;
}
const installedVersion = () => JSON.parse(readFileSync(join(nativeDirs().app, "Contents", "Resources", "PairBrowse-build.json"), "utf8")).version;
const installedPak = () => readFileSync(join(nativeDirs().app, "Contents", "Frameworks", "Chromium Framework.framework", "Versions", "A", "Resources", "en.lproj", "locale.pak"));
// What macOS shows in the notification prompt: the helper's names, localized ones first, and its ID.
const alertsHelper = () => join(nativeDirs().app, "Contents", "Frameworks", "Chromium Framework.framework", "Versions", "A", "Helpers", "Chromium Helper (Alerts).app", "Contents");
const plistJson = (file) => JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
function assertAlertsBranded() {
  const info = plistJson(join(alertsHelper(), "Info.plist"));
  assert.equal(info.CFBundleName, "PairBrowse");
  assert.equal(info.CFBundleDisplayName, "PairBrowse");
  assert.equal(info.CFBundleIdentifier, "app.pairbrowse.test.framework.AlertNotificationService", "Chromium finds it by the app's ID");
  for (const folder of ["base.lproj", "en.lproj"]) assert.equal(plistJson(join(alertsHelper(), "Resources", folder, "InfoPlist.strings")).CFBundleDisplayName, "PairBrowse");
  assert.ok(readFileSync(join(alertsHelper(), "Resources", "app.icns")).equals(readFileSync(new URL("../scripts/browser/pairbrowse.icns", import.meta.url))));
  const signature = execFileSync("sh", ["-c", 'codesign -dv "$0" 2>&1', dirname(alertsHelper())], { encoding: "utf8" });
  assert.match(signature, /Identifier=app\.pairbrowse\.test\.framework\.AlertNotificationService\n/, "signed under its new ID");
}
const verifies = (app) => { try { execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "ignore" }); return true; } catch { return false; } };

test("rebranding interface text only rewrites entries that name the engine", () => {
  const before = pak(["About Chromium", "Ünïcode \u00e9"]);
  const odd = Buffer.concat([before, Buffer.from([0xff, 0xfe])]); // trailing bytes that aren't text
  odd.writeUInt32LE(odd.readUInt32LE(14 + 2 * 6) + 2, 14 + 2 * 6);
  const after = rebrandPak(odd);
  assert.ok(after.includes(Buffer.from("About PairBrowse")));
  assert.ok(after.subarray(-2).equals(Buffer.from([0xff, 0xfe])), "bytes that aren't text are copied as they are");
  assert.equal(rebrandPak(Buffer.from([4, 0, 0, 0, 1])), null, "other formats are left alone");
});

test("the engine keeps its credit: copyright strings and the link to its project", () => {
  const english = pak(["About Chromium", "Copyright {0,date,y} The Chromium Authors. All rights reserved.",
    'Chromium is made possible by the <a href="$1">Chromium</a> open source project']);
  const attribution = attributionIds(english);
  assert.deepEqual([...attribution], [101]);
  assert.deepEqual(rebrandPak(english, attribution), pak(["About PairBrowse", "Copyright {0,date,y} The Chromium Authors. All rights reserved.",
    'PairBrowse is made possible by the <a href="$1">Chromium</a> open source project']));
  // Another language: the same ids keep their credit, whatever the words.
  const german = pak(["Über Chromium", "Copyright {0,date,y} Die Chromium-Autoren.", 'Chromium wird durch das Open-Source-Projekt <a href="$1">Chromium</a> ermöglicht']);
  assert.deepEqual(rebrandPak(german, attribution), pak(["Über PairBrowse", "Copyright {0,date,y} Die Chromium-Autoren.", 'PairBrowse wird durch das Open-Source-Projekt <a href="$1">Chromium</a> ermöglicht']));
  // A pack branded by the old rule is put right.
  const old = pak(["About PairBrowse", "Copyright {0,date,y} The PairBrowse Authors. All rights reserved.", 'PairBrowse is made possible by the <a href="$1">PairBrowse</a> open source project']);
  assert.deepEqual(rebrandPak(old, attributionIds(old)), rebrandPak(english, attribution));
});

test("the SHA-256 comes from the side file, for that archive only", () => {
  const dir = temp("pb-sha-");
  const hex = "AB".repeat(32);
  writeFileSync(join(dir, "a.zip.sha256"), `${hex}  a.zip\n`);
  assert.equal(expectedSha256(join(dir, "a.zip")), hex.toLowerCase());
  writeFileSync(join(dir, "s.zip.sha256"), `${hex} *s.zip\n`); // shasum -b style
  assert.equal(expectedSha256(join(dir, "s.zip")), hex.toLowerCase());
  writeFileSync(join(dir, "b.zip.sha256"), `${hex}  other.zip\n`);
  assert.throws(() => expectedSha256(join(dir, "b.zip")), /is for other.zip/);
  assert.throws(() => expectedSha256(join(dir, "c.zip")), /no SHA-256/);
  assert.throws(() => expectedSha256(join(dir, "a.zip"), ""), /not a SHA-256/);
  assert.throws(() => expectedSha256(join(dir, "a.zip"), "abc"), /not a SHA-256/);
});

test("installs, keeps the previous app, and rolls back when the check fails", { skip: !mac }, async () => {
  const checked = [];
  const ok = async (exec, { config }) => { checked.push(config); return ["fake check"]; };
  const opts = { check: ok, register: false };
  const configFile = join(home, "config.json");
  const before = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
  await installNative(fakeArchive("150.0.0.1"), opts);
  assert.equal(installedVersion(), "150.0.0.1");
  assert.deepEqual(installedPak(), pak(["Customize PairBrowse", "About PairBrowse", "Settings"]), "interface text says PairBrowse");
  assertAlertsBranded();
  assert.ok(verifies(nativeDirs().app), "signature still verifies");
  assert.equal(JSON.parse(readFileSync(nativeDirs().record, "utf8")).branding, BRANDING);
  // An install writes nothing into config.json ("browser" picks the browser); the check runs the
  // new build as the native engine all the same.
  assert.equal(existsSync(configFile) ? readFileSync(configFile, "utf8") : null, before, "config.json untouched");
  assert.equal(checked[0].browserEngine, "pairbrowse");
  assert.equal(checked[0].executablePath, nativeDirs().exec);
  assert.equal(JSON.parse(readFileSync(nativeDirs().record, "utf8")).version, "150.0.0.1");
  assert.equal(JSON.parse(readFileSync(nativeDirs().record, "utf8")).ownPages, false, "today's builds have no pages of their own");

  // A build whose manifest declares its own pages: the record says so.
  await installNative(fakeArchive("150.0.0.2", undefined, { chrome: 1 }), opts);
  assert.equal(installedVersion(), "150.0.0.2");
  assert.equal(JSON.parse(readFileSync(nativeDirs().record, "utf8")).ownPages, true);
  assert.ok(existsSync(join(nativeDirs().previous, "Contents", "MacOS", "pairbrowse")), "previous app kept");

  writeFileSync(join(home, "config.json"), JSON.stringify({ browserDriver: "patchright", mine: 1 }));
  await assert.rejects(installNative(fakeArchive("150.0.0.3"), { register: false, check: async () => { throw new Error("no bottom bar"); } }), /no bottom bar/);
  assert.equal(installedVersion(), "150.0.0.2", "the working app is back");
  assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")), { browserDriver: "patchright", mine: 1 }, "settings are back");
});

test("an archive that doesn't match its SHA-256 is refused before anything changes", async () => {
  const dir = temp("pb-bad-");
  const zip = join(dir, "x.zip");
  writeFileSync(zip, "not a build");
  const before = existsSync(nativeDirs().app) ? readFileSync(join(nativeDirs().app, "Contents", "Resources", "PairBrowse-build.json"), "utf8") : null;
  await assert.rejects(installNative(zip, { sha256: "00".repeat(32), check: async () => [], register: false }), /doesn't match its SHA-256/);
  assert.equal(existsSync(nativeDirs().app) ? readFileSync(join(nativeDirs().app, "Contents", "Resources", "PairBrowse-build.json"), "utf8") : null, before, "nothing changed");
});

test("a second install at the same time is refused, a stale lock is taken over", { skip: !mac }, async () => {
  mkdirSync(nativeDirs().dir, { recursive: true });
  const lock = join(nativeDirs().dir, ".install.lock");
  writeFileSync(lock, String(process.pid)); // this process is alive
  await assert.rejects(installNative(fakeArchive("150.0.0.4"), { check: async () => ["ok"], register: false }), /another PairBrowse install is running/);
  writeFileSync(lock, "999999"); // no such process
  // The self-check's graphics measurement is handed out (step 44: the helper keeps it with the default profile).
  const measured = { runtimeKey: "k" };
  let given = null;
  await installNative(fakeArchive("150.0.0.4"), { check: async (exec, o) => { o.onGraphics(measured); return ["ok"]; }, register: false, onGraphics: (m) => { given = m; } });
  assert.equal(given, measured);
  assert.equal(installedVersion(), "150.0.0.4");
  assert.equal(existsSync(lock), false, "lock released");
});

test("an install cut short after the swap is undone at the next start", { skip: !mac }, async () => {
  const d = nativeDirs();
  assert.equal(installedVersion(), "150.0.0.4");
  // As if killed during the self-check: the old app sits aside, an unchecked one is in place.
  renameSync(d.app, d.rollback);
  const unpacked = temp("pb-unchecked-");
  execFileSync("ditto", ["-x", "-k", fakeArchive("150.0.0.9"), unpacked]);
  renameSync(join(unpacked, "PairBrowse.app"), d.app);
  writeFileSync(d.pending, JSON.stringify({ hadOld: true, config: '{"browserDriver":"patchright"}' }));
  writeFileSync(join(home, "config.json"), '{"browserEngine":"pairbrowse"}');
  await ensureNative(() => {}, offline);
  assert.equal(installedVersion(), "150.0.0.4", "the replaced app is back");
  assert.equal(existsSync(d.pending), false);
  assert.equal(existsSync(d.rollback), false);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")), { browserDriver: "patchright" }, "settings are back");
});

test("on start, an installed build branded by an older version is branded again, on a checked copy", { skip: !mac }, async () => {
  const d = nativeDirs();
  // As if installed before interface text was rebranded: the pin matches, the branding is older.
  writeFileSync(join(d.app, "Contents", "Frameworks", "Chromium Framework.framework", "Versions", "A", "Resources", "en.lproj", "locale.pak"), pak(LOCALE));
  // ...and before the notification helper got PairBrowse's name (BRANDING 5).
  writeFileSync(join(alertsHelper(), "Resources", "base.lproj", "InfoPlist.strings"), '"CFBundleDisplayName" = "Chromium";\n');
  rmSync(join(alertsHelper(), "Resources", "en.lproj"), { recursive: true, force: true });
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", d.app]);
  writeFileSync(d.record, JSON.stringify({ version: "150.0.0.4", sha256: offline.asset.sha256, branding: 1 }));
  assert.equal(await ensureNative(() => {}, offline), d.exec);
  assert.deepEqual(installedPak(), pak(["Customize PairBrowse", "About PairBrowse", "Settings"]));
  assertAlertsBranded();
  assert.ok(verifies(d.app), "signature still verifies");
  assert.equal(JSON.parse(readFileSync(d.record, "utf8")).branding, BRANDING);
  assert.equal(existsSync(d.pending) || existsSync(d.rollback), false, "no swap left behind");
  rmSync(d.record, { force: true });
});

test("on start, an installed app is kept while the pinned build can't be had", { skip: !mac }, async () => {
  // The fake app from the tests above is installed (not the pinned version) and the pinned build
  // can't be fetched: keep using it rather than failing to start.
  const logs = [];
  assert.equal(await ensureNative((m) => logs.push(m), offline), nativeDirs().exec);
  assert.match(logs.join("\n"), /couldn't install PairBrowse .* \(offline\); keeping 150\.0\.0\.4/);
  // Without its engine pack the native browser can't launch: the start fails, and says why.
  await assert.rejects(ensureNative(() => {}, { ...offline, engine: async () => { throw new Error("no engine pack"); } }), /no engine pack/);
  // And with nothing installed it says how to install.
  rmSync(nativeDirs().app, { recursive: true, force: true });
  await assert.rejects(ensureNative(() => {}, offline), /isn't installed \(offline\)\. Install it with: node .*native-install\.mjs <pairbrowse-test\.zip>/);
  // A platform and chip without a build: nothing to install (the helper then refuses to start
  // unless the user picked the standard engine).
  assert.equal(await ensureNative(() => {}, { ...offline, asset: null }), null);
});

test("the pinned builds and engine pack are fetched from the public GitHub release", () => {
  assert.equal(NATIVE.baseUrl, `https://github.com/pairbrowse/pairbrowse/releases/download/browser-${NATIVE.version}`);
  // The engine version, with a pack revision (-2) for a second pack of the same browser.
  assert.match(NATIVE.engine.file, new RegExp(`^pairbrowse-engine-${NATIVE.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-\\d+)?\\.tgz$`));
  for (const hex of [NATIVE.engine.sha256, ...Object.values(NATIVE.engine.files)]) assert.match(hex, /^[0-9a-f]{64}$/);
});

// A Linux build as linuxwin.py packages it: PairBrowse/chrome + PairBrowse-build.json, tar.xz.
function fakeLinuxArchive(version, platform = "linux", dir = temp("pb-linux-")) {
  const root = join(dir, "PairBrowse");
  mkdirSync(join(root, "locales"), { recursive: true });
  writeFileSync(join(root, "chrome"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(root, "PairBrowse-build.json"), JSON.stringify({ product: "PairBrowse", version, platform, arch: "x64", binary: "chrome" }));
  const archive = join(dir, `pairbrowse-${version}-linux-x64.tar.xz`);
  execFileSync("tar", ["-cJf", archive, "-C", dir, "PairBrowse"]);
  writeFileSync(`${archive}.sha256`, `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  pairbrowse-${version}-linux-x64.tar.xz\n`);
  return archive;
}

test("each platform and chip picks its own build", () => {
  assert.equal(nativeLayout("darwin", "arm64").pin, NATIVE.arm64);
  assert.equal(nativeLayout("darwin", "arm64").arch, "arm64");
  assert.equal(nativeLayout("darwin", "x64").pin, NATIVE.x64);
  assert.equal(nativeLayout("darwin", "x64").arch, "x86_64");
  assert.match(NATIVE.arm64.file, /-macos-arm64\.zip$/);
  assert.match(NATIVE.x64.file, /-macos-x86_64\.zip$/);
  // Released builds only: a platform without a pinned SHA-256 gets no download.
  assert.equal(pinnedAsset(nativeLayout("darwin", "arm64")), NATIVE.arm64);
  assert.equal(pinnedAsset({ pin: { file: "x", sha256: null } }), null);
  assert.deepEqual(nativeLayout("linux", "x64").exec, ["chrome"]);
  assert.equal(nativeLayout("linux", "x64").pin, NATIVE.linux);
  assert.deepEqual(nativeLayout("win32", "x64").exec, ["chrome.exe"]);
  assert.equal(nativeLayout("win32", "x64").folder, "PairBrowse");
  assert.equal(nativeLayout("linux", "arm64"), null);
  assert.equal(nativeLayout("win32", "arm64"), null);
  assert.equal(nativeLayout("freebsd", "x64"), null);
  assert.equal(nativeDirs(nativeLayout("linux", "x64")).exec, join(home, "browser", "PairBrowse", "chrome"));
});

test("a Linux/Windows build's manifest sits next to its program and names its platform", () => {
  const dir = temp("pb-manifest-");
  writeFileSync(join(dir, "chrome"), "");
  writeFileSync(join(dir, "PairBrowse-build.json"), JSON.stringify({ product: "PairBrowse", version: "150.0.7871.114", platform: "linux", arch: "x64" }));
  assert.equal(nativeManifest(join(dir, "chrome")).platform, "linux");
  writeFileSync(join(dir, "PairBrowse-build.json"), JSON.stringify({ product: "PairBrowse", version: "150.0.7871.114", arch: "x64" }));
  assert.throws(() => nativeManifest(join(dir, "chrome")), /names no platform/);
});

test("a build fits only this platform and chip: arch required, on macOS a Mach-O program for this chip", () => {
  const mac = nativeLayout("darwin", "arm64"), intel = nativeLayout("darwin", "x64"), linux = nativeLayout("linux", "x64");
  const base = { product: "PairBrowse", version: "150.0.7871.114" };
  assert.doesNotThrow(() => buildFits({ ...base, arch: "arm64" }, mac, ["arm64"]));
  assert.doesNotThrow(() => buildFits({ ...base, arch: "arm64", platform: "macos" }, mac, ["x86_64", "arm64"]));
  assert.doesNotThrow(() => buildFits({ ...base, arch: "x64", platform: "linux" }, linux));
  for (const [manifest, layout, machO, why] of [
    [{ ...base }, mac, ["arm64"], /names no arch/],
    [{ ...base, arch: "" }, linux, null, /names no arch/],
    [{ ...base, platform: "linux" }, linux, null, /names no arch/],
    [{ ...base, arch: "x86_64" }, mac, ["x86_64"], /for x86_64, this computer is arm64/],
    [{ ...base, arch: "arm64" }, intel, ["arm64"], /for arm64, this computer is x86_64/],
    [{ ...base, arch: "arm64", platform: "linux" }, mac, ["arm64"], /for linux, not macos/],
    [{ ...base, arch: "arm64" }, mac, null, /isn't a macOS program/],
    [{ ...base, arch: "arm64" }, mac, ["x86_64"], /runs on x86_64, this computer is arm64/],
    [{ ...base, arch: "x64", platform: "windows" }, linux, null, /for windows, not linux/],
    [{ ...base, arch: "arm64", platform: "linux" }, linux, null, /for arm64, this computer is x64/],
  ]) assert.throws(() => buildFits(manifest, layout, machO), why, JSON.stringify(manifest));
  if (process.platform === "darwin") {
    assert.ok(machoArchs(process.execPath).length >= 1, "node itself is a Mach-O program here");
    assert.equal(machoArchs("/etc/hosts"), null);
  } else assert.equal(machoArchs(process.execPath), null, "an ELF program is no Mach-O one");
});

test("a Linux build whose manifest names no arch is refused before anything changes", async () => {
  const layout = nativeLayout("linux", "x64");
  const d = nativeDirs(layout);
  const dir = temp("pb-noarch-");
  const root = join(dir, "PairBrowse");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "chrome"), "#!/bin/sh\n");
  writeFileSync(join(root, "PairBrowse-build.json"), JSON.stringify({ product: "PairBrowse", version: "150.0.1.9", platform: "linux", binary: "chrome" }));
  const archive = join(dir, "pairbrowse-150.0.1.9-linux-x64.tar.xz");
  execFileSync("tar", ["-cJf", archive, "-C", dir, "PairBrowse"]);
  writeFileSync(`${archive}.sha256`, `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  pairbrowse-150.0.1.9-linux-x64.tar.xz\n`);
  await assert.rejects(installNative(archive, { check: async () => ["fake check"], register: false, layout }), /names no arch/);
  assert.ok(!existsSync(join(d.app, "chrome")), "nothing installed");
});

test("Linux layout: installs a tar.xz, keeps the previous build, rolls back, refuses another platform's build", async () => {
  const layout = nativeLayout("linux", "x64");
  const d = nativeDirs(layout);
  const version = () => JSON.parse(readFileSync(join(d.app, "PairBrowse-build.json"), "utf8")).version;
  const opts = { check: async () => ["fake check"], register: false, layout };
  const configFile = join(home, "config.json");
  const before = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
  await installNative(fakeLinuxArchive("150.0.1.1"), opts);
  assert.equal(version(), "150.0.1.1");
  assert.equal(existsSync(configFile) ? readFileSync(configFile, "utf8") : null, before, "an install writes nothing into config.json");
  await installNative(fakeLinuxArchive("150.0.1.2"), opts);
  assert.ok(existsSync(join(d.previous, "chrome")), "previous build kept");
  await assert.rejects(installNative(fakeLinuxArchive("150.0.1.3"), { ...opts, check: async () => { throw new Error("no side panel"); } }), /no side panel/);
  assert.equal(version(), "150.0.1.2", "the working build is back");
  await assert.rejects(installNative(fakeLinuxArchive("150.0.1.4", "windows"), opts), /for windows, not linux/);
  assert.equal(version(), "150.0.1.2");
  rmSync(d.app, { recursive: true, force: true });
  rmSync(d.previous, { recursive: true, force: true });
  rmSync(d.record, { force: true });
});

test("with browser: pairbrowse-open (or chromium, or a path) nothing is downloaded or installed", async () => {
  let fetched = 0;
  const counting = async () => { fetched++; throw new Error("offline"); };
  const logs = [];
  assert.equal(await ensureNative((m) => logs.push(m), { ...offline, pinned: counting, config: { browser: "chromium" } }), null);
  assert.equal(fetched, 0, "nothing fetched");
  assert.match(logs.join("\n"), /browser is pairbrowse-open in ~\/\.pairbrowse\/config\.json: nothing to download or install/);
  logs.length = 0;
  assert.equal(await ensureNative((m) => logs.push(m), { ...offline, pinned: counting, config: { browserEngine: "chromium", executablePath: "/fake/chrome" } }), null);
  assert.match(logs.join("\n"), /browser is a browser of your own/);
  assert.equal(fetched, 0);
  // installNative: refused before the archive is even read (this one doesn't exist).
  logs.length = 0;
  const unread = join(temp("pb-noarchive-"), "pairbrowse-150.0.0.0.zip");
  assert.equal(await installNative(unread, { log: (m) => logs.push(m), register: false, check: async () => { throw new Error("never"); }, config: { browser: "/bin/sh" } }), null);
  assert.match(logs.join("\n"), /browser is a browser of your own in ~\/\.pairbrowse\/config\.json: nothing to download or install/);
  // A path that isn't a program is the open build (the fallback): nothing installed either.
  logs.length = 0;
  assert.equal(await installNative(unread, { log: (m) => logs.push(m), register: false, config: { browser: "/some/chromium" } }), null);
  assert.match(logs.join("\n"), /browser is pairbrowse-open in/);
  // "pairbrowse" and unset still go on to fetch the pinned build (here: offline, nothing installed).
  for (const config of [{ browser: "pairbrowse" }, {}]) {
    const before = fetched;
    const d = nativeDirs();
    const had = existsSync(d.exec);
    if (had) { await ensureNative(() => {}, { ...offline, pinned: counting, config }).catch(() => {}); }
    else await assert.rejects(ensureNative(() => {}, { ...offline, pinned: counting, config }), /isn't installed/);
    assert.equal(fetched, before + 1, JSON.stringify(config));
  }
  await assert.rejects(installNative(unread, { register: false, config: { browser: "pairbrowse" } }), /no SHA-256/);
  await assert.rejects(installNative(unread, { register: false, config: {} }), /no SHA-256/);
});

test("the first-setup question: asked once, Enter is PairBrowse, 2 is the open build, recorded in config.json", async () => {
  const { askBrowserChoice, BROWSER_QUESTION, skipMessage } = await import("../scripts/native/install.mjs");
  const configFile = join(home, "config.json");
  const saved = existsSync(configFile) ? readFileSync(configFile, "utf8") : null;
  try {
    const never = async () => { throw new Error("asked"); };
    // Already chosen (or the older names): no question.
    assert.equal(await askBrowserChoice({ config: { browser: "chromium" }, native: true, ask: never }), "pairbrowse-open");
    assert.equal(await askBrowserChoice({ config: { browserEngine: "pairbrowse" }, native: true, ask: never }), "pairbrowse");
    // No build for this computer: the open build, nothing asked or written.
    rmSync(configFile, { force: true });
    assert.equal(await askBrowserChoice({ config: {}, native: false, ask: never }), "pairbrowse-open");
    assert.equal(existsSync(configFile), false, "nothing recorded");
    // The by-hand step's line then names the missing pin, not a config.json state that isn't there.
    assert.match(skipMessage({}, false), /no PairBrowse build is pinned for this computer; nothing downloaded or installed/);
    assert.doesNotMatch(skipMessage({}, false), /browser is pairbrowse-open in/);
    assert.match(skipMessage({ browser: "chromium" }, false), /browser is pairbrowse-open in ~\/\.pairbrowse\/config\.json/);
    // Answers, recorded with the file's other keys kept.
    writeFileSync(configFile, JSON.stringify({ browserDriver: "patchright", participantName: "Ann" }));
    let asked = "";
    assert.equal(await askBrowserChoice({ config: {}, native: true, ask: async (q) => { asked = q; return "2"; } }), "pairbrowse-open");
    assert.equal(asked, BROWSER_QUESTION);
    assert.match(asked, /1\. The PairBrowse browser \(recommended\)/, "the native browser leads");
    assert.match(asked, /2\. PairBrowse as an extension: .*no server mode/s, "the fallback, with what it lacks");
    assert.doesNotMatch(asked, /open build|open-source/);
    assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { browserDriver: "patchright", participantName: "Ann", browser: "pairbrowse-open" });
    assert.equal(await askBrowserChoice({ config: {}, native: true, ask: async () => "" }), "pairbrowse");
    assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { browserDriver: "patchright", participantName: "Ann", browser: "pairbrowse" });
    assert.equal(await askBrowserChoice({ config: {}, native: true, ask: async () => " Chromium " }), "pairbrowse-open", "the older word");
    assert.equal(await askBrowserChoice({ config: {}, native: true, ask: async () => "open" }), "pairbrowse-open");
    assert.equal(await askBrowserChoice({ config: {}, native: true, ask: async () => "extension" }), "pairbrowse-open");
    // No terminal and no stand-in: PairBrowse, recorded.
    rmSync(configFile, { force: true });
    assert.equal(await askBrowserChoice({ config: {}, native: true, input: { isTTY: false }, output: { isTTY: false } }), "pairbrowse");
    assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { browser: "pairbrowse" });
  } finally {
    if (saved === null) rmSync(configFile, { force: true }); else writeFileSync(configFile, saved);
  }
});

test.after(() => { for (const d of [home, ...temps]) rmSync(d, { recursive: true, force: true }); });
