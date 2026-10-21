// Importing a browser profile (spec server-mode D-AP2, D15 to D17; scripts/profiles/import.mjs and
// device.mjs): formats told apart by content, the file size-capped before parsing, versions known,
// settings only (another device's hardware reported unsupported and never applied, credentials and
// launch options never kept), provenance with SHA-256, source and license, and a dry run that
// writes nothing. Fixtures are hand-written (no third-party data).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { checkImport, importInto, importFile, readImportFile, detectFormat, importName, IMPORT_MAX_BYTES, IMPORT_CHECKS } from "../scripts/profiles/import.mjs";
import { DEVICE_SECTIONS, classifySection, fieldReport } from "../scripts/profiles/device.mjs";
import { exportProfile } from "../scripts/profiles/export.mjs";
import { createProfileStore } from "../scripts/profiles/store.mjs";
import { checkProfile, licenseRank, mostRestrictive } from "../scripts/profiles/schema.mjs";
import { sha256 } from "../scripts/util.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/profiles/${name}`, import.meta.url));
const DEVICE = fixture("engine-device-1.json");
const PERSONA = fixture("engine-persona.json");
const RECORD = JSON.parse(fixture("record-1.json"));
const AT = "2026-10-21T10:00:00Z";
const HOST = { file: "capture.json", source: "my own laptop", license: "own-capture", at: AT };
const SECRET = "fixture-secret-pw";
const freshDir = () => join(mkdtempSync(join(tmpdir(), "pb-import-")), "browser-profiles");
function makeStore() {
  let t = Date.parse(AT), n = 0;
  return createProfileStore({ dir: freshDir(), now: () => (t += 1000), randomId: () => (++n).toString(16).padStart(16, "0") });
}
const withJson = (buf, change) => Buffer.from(JSON.stringify(change(JSON.parse(buf))));
const refusedAt = (report, check, pattern) => {
  assert.equal(report.ok, false, `refused: ${report.problem}`);
  assert.equal(report.refused.check, check, report.problem);
  assert.match(report.problem, /^Import of (?:"[^"]+"|the file) refused at the \w+ check: /);
  if (pattern) assert.match(report.problem, pattern);
};
const byField = (items, field) => items.filter((i) => i.field === field);
// Every file under dir, read as text.
function allText(dir) {
  let out = "";
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out += readFileSync(join(e.parentPath ?? e.path, e.name), "utf8");
  return out;
}

test("formats detected by content, never by a file name", () => {
  assert.equal(detectFormat(JSON.parse(DEVICE)).format, "engine-device/1");
  assert.equal(detectFormat(JSON.parse(PERSONA)).format, "engine-persona");
  assert.equal(detectFormat(exportProfile(RECORD, { at: AT }).file).format, "pairbrowse-profile/1");
  // The same content under any name is the same format; another name of the same content too.
  assert.equal(checkImport(DEVICE, { ...HOST, file: "export.pairbrowse.json" }).format, "engine-device/1");
  assert.equal(checkImport(PERSONA, { ...HOST, file: "device.json" }).format, "engine-persona");
  refusedAt(checkImport(JSON.stringify({ format: "other-tool" }), HOST), "format", /isn't "pairbrowse-profile"/);
  refusedAt(checkImport(JSON.stringify({ navigator: {}, options: {} }), HOST), "format", /neither/);
  refusedAt(checkImport(JSON.stringify({ cookies: [] }), HOST), "format", /isn't a format PairBrowse imports/);
  refusedAt(checkImport("[1,2]", HOST), "shape");
  refusedAt(checkImport("{ not json", HOST), "json");
  refusedAt(checkImport(Buffer.from([0x7b, 0xff, 0x7d]), HOST), "json", /UTF-8/);
  refusedAt(checkImport(`${"[".repeat(40)}${"]".repeat(40)}`, HOST), "shape");
  refusedAt(checkImport(JSON.stringify({ navigator: JSON.parse(`${'{"a":'.repeat(40)}1${"}".repeat(40)}`) }), HOST), "shape", /nested more than 32 deep/);
  // A deeply nested file is refused without overflowing anything.
  refusedAt(checkImport(`{"navigator":${'{"a":'.repeat(100000)}1${"}".repeat(100000)}}`, HOST), "shape");
  assert.deepEqual(IMPORT_CHECKS, ["size", "json", "shape", "format", "integrity", "version", "fields", "provenance"]);
});

test("over 1 MiB refused before parsing, from bytes and from a file", () => {
  const big = Buffer.alloc(IMPORT_MAX_BYTES + 1, 0x20);
  refusedAt(checkImport(big, HOST), "size", /1048577 bytes; a profile file is at most 1048576/);
  // Not JSON at all, yet the size is what refuses: nothing was parsed.
  refusedAt(checkImport(Buffer.alloc(IMPORT_MAX_BYTES + 10, 0x7b), HOST), "size");
  assert.equal(checkImport(Buffer.concat([DEVICE, Buffer.alloc(IMPORT_MAX_BYTES - DEVICE.length, 0x20)]), HOST).ok, true, "exactly 1 MiB is read");
  const dir = mkdtempSync(join(tmpdir(), "pb-import-file-"));
  writeFileSync(join(dir, "big.json"), big);
  assert.throws(() => readImportFile(join(dir, "big.json")), (e) => e.code === "PROFILE_IMPORT" && /refused at the size check/.test(e.message));
  // One file: a link at the name is refused, never followed; a folder isn't a file.
  writeFileSync(join(dir, "device.json"), DEVICE);
  symlinkSync(join(dir, "device.json"), join(dir, "link.json"));
  assert.throws(() => readImportFile(join(dir, "link.json")), (e) => e.code === "PROFILE_IMPORT" && /link, which is never followed/.test(e.message));
  assert.throws(() => readImportFile(dir), (e) => e.code === "PROFILE_IMPORT" && /isn't a regular file/.test(e.message));
  // A named pipe at the name is refused at once, never waited on for a writer.
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [join(dir, "pipe.json")]);
    assert.throws(() => readImportFile(join(dir, "pipe.json")), (e) => e.code === "PROFILE_IMPORT" && /isn't a regular file/.test(e.message));
  }
  assert.throws(() => readImportFile(join(dir, "missing.json")), (e) => e.code === "PROFILE_IMPORT" && /no such file/.test(e.message));
  assert.deepEqual(readImportFile(join(dir, "device.json")), DEVICE);
});

test("unknown or newer versions refused naming both", () => {
  refusedAt(checkImport(withJson(DEVICE, (d) => ({ ...d, meta: { ...d.meta, schema_version: 2 } })), HOST), "version", /schema_version 2, newer than this PairBrowse reads \(1\)/);
  refusedAt(checkImport(withJson(DEVICE, (d) => ({ ...d, meta: { ...d.meta, schema_version: 0 } })), HOST), "version", /isn't a version this PairBrowse knows/);
  assert.equal(checkImport(withJson(DEVICE, (d) => ({ ...d, meta: undefined })), HOST).ok, true, "an early capture without meta");
  // An export's formatVersion, sealed as written (an edited one fails its SHA-256 first).
  const sealed = (v) => { const f = { ...exportProfile(RECORD, { at: AT }).file, formatVersion: v }; f.sha256 = exportSha(f); return JSON.stringify(f); };
  refusedAt(checkImport(sealed(2), HOST), "version", /formatVersion 2, newer than this PairBrowse reads \(1\)/);
  refusedAt(checkImport(sealed("1"), HOST), "version", /no formatVersion this PairBrowse knows/);
});
// The SHA-256 an export file would carry.
function exportSha(f) { const { sha256: _s, ...rest } = f; return sha256(canon(rest)); }
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));

test("an engine-device file applies screen, languages and time zone and reports every hardware section unsupported", () => {
  const r = checkImport(DEVICE, HOST);
  assert.equal(r.ok, true, r.problem);
  assert.deepEqual(r.settings.locale, { languages: ["de-DE", "de", "en"], timezone: "Europe/Berlin", source: "set" });
  assert.deepEqual(r.settings.screen, { width: 1512, height: 982, availWidth: 1512, availHeight: 945, colorDepth: 30, devicePixelRatio: 2 });
  // Nothing else is set: window, graphics, persona and the rest keep their defaults.
  assert.equal(r.settings.window, null);
  assert.deepEqual(r.settings.graphics, { backend: "auto", require: null });
  assert.deepEqual(r.settings.persona, { source: "seed", seed: null });
  for (const k of ["webgl", "webgpu", "fonts", "audio", "speech", "codecs", "perf_memory", "media_devices", "canvas", "hardware_concurrency", "device_memory", "max_touch_points",
    "navigator.hardware_concurrency", "navigator.device_memory", "navigator.max_touch_points"]) {
    const [it] = byField(r.items, k);
    assert.equal(it?.status, "unsupported", k);
    assert.equal(it.requested, null, `${k}: no value of it repeated`);
    assert.match(it.reason, /another device's hardware/);
  }
  assert.equal(byField(r.items, "navigator").find((i) => i.status === "derived").class, "D", "version identity is the build's");
  assert.deepEqual(byField(r.items, "navigator.languages")[0].requested, ["de-DE", "de", "en"]);
  assert.equal(byField(r.items, "intl.timeZone")[0].requested, "Europe/Berlin");
  // Every top-level section of the file is classed, and every item has the shared shape.
  for (const k of Object.keys(JSON.parse(DEVICE))) assert.ok(r.items.some((i) => i.field === k || i.field.startsWith(`${k}.`)), `${k} is in the report`);
  for (const i of r.items) assert.deepEqual(Object.keys(i), ["field", "rule", "class", "status", "requested", "measured", "severity", "reason"]);
  // The page address the collector ran on is never kept or repeated.
  assert.doesNotMatch(JSON.stringify(r), /private=1|Test GPU|Test Sans/);
  assert.equal(r.provenance[0].collectedAt, "2026-10-01T09:00:00.000Z");
  assert.match(r.provenance[0].tool, /^engine collector/);
  // A section this PairBrowse doesn't know is named, not read; one with no field name is counted.
  const odd = checkImport(withJson(DEVICE, (d) => ({ ...d, newThing: { x: 1 }, "two words": 1 })), HOST);
  assert.equal(byField(odd.items, "newThing")[0].status, "not-applied");
  assert.equal(byField(odd.items, "(unnamed)")[0].status, "not-applied");
  // The section table classes each collector section, and fieldReport matches the import's.
  assert.equal(classifySection("webgpu", {})[0].status, "unsupported");
  assert.equal(DEVICE_SECTIONS.screen.status, "applied");
  assert.deepEqual(fieldReport("engine-device/1", JSON.parse(DEVICE)), r.items.filter((i) => i.rule === "import.fields"));
  // Missing avail, depth and ratio take the whole screen, 24 and 1, each reported.
  const bare = checkImport(withJson(DEVICE, (d) => ({ ...d, screen: { width: 1280, height: 800 } })), HOST);
  assert.deepEqual(bare.settings.screen, { width: 1280, height: 800, availWidth: 1280, availHeight: 800, colorDepth: 24, devicePixelRatio: 1 });
  assert.equal(byField(bare.items, "screen.colorDepth")[0].status, "derived");
  // No screen and no languages: this computer's; the locale only what the file has.
  const none = checkImport(withJson(DEVICE, (d) => ({ ...d, screen: null, navigator: { user_agent: "x" }, intl: {} })), HOST);
  assert.equal(none.settings.screen, null);
  assert.deepEqual(none.settings.locale, { languages: null, timezone: null, source: "system" });
});

test("sane ranges: a screen or ratio out of range, an unknown time zone or language tag refuses by name", () => {
  refusedAt(checkImport(withJson(DEVICE, (d) => ({ ...d, screen: { ...d.screen, width: 99999 } })), HOST), "fields", /screen\.width is a whole number from 320 to 16384, not 99999/);
  refusedAt(checkImport(withJson(DEVICE, (d) => ({ ...d, screen: { ...d.screen, device_pixel_ratio: 9 } })), HOST), "fields", /screen\.devicePixelRatio .* not 9/);
  refusedAt(checkImport(withJson(DEVICE, (d) => ({ ...d, screen: { ...d.screen, width: "1512" } })), HOST), "fields", /screen\.width .* not a string/);
  refusedAt(checkImport(withJson(DEVICE, (d) => ({ ...d, intl: { timeZone: "Mars/Olympus" } })), HOST), "fields", /locale\.timezone is not a time zone this computer knows/);
  refusedAt(checkImport(withJson(DEVICE, (d) => ({ ...d, navigator: { languages: ["not a tag"] } })), HOST), "fields", /locale\.languages\[0\]/);
  // Repeats dropped, ten kept, the rest reported.
  const many = ["en-US", "en", "EN", "de", "fr", "it", "es", "nl", "pt", "pl", "sv", "da"];
  const r = checkImport(withJson(DEVICE, (d) => ({ ...d, navigator: { languages: many } })), HOST);
  assert.deepEqual(r.settings.locale.languages, ["en-US", "en", "de", "fr", "it", "es", "nl", "pt", "pl", "sv"]);
  assert.ok(r.items.some((i) => i.field === "navigator.languages" && i.status === "not-applied" && /1 more language/.test(i.reason)));
});

test("coherence: an unbelievable screen is reported as a warning and never refuses", () => {
  const r = checkImport(withJson(DEVICE, (d) => ({ ...d, screen: { width: 4000, height: 800, avail_width: 4000, avail_height: 330, color_depth: 24, device_pixel_ratio: 1.3 } })), HOST);
  assert.equal(r.ok, true, r.problem);
  const warned = r.items.filter((i) => i.rule === "screen.believable");
  assert.equal(warned.length, 3);
  for (const w of warned) assert.equal(w.severity, "warning");
  assert.deepEqual(checkImport(DEVICE, HOST).items.filter((i) => i.rule === "screen.believable"), []);
});

test("a setting the profile's browser can't apply is imported and named at once, never found by a failed start", () => {
  const builds = (r) => r.items.filter((i) => i.rule === "import.build");
  // The native build applies a light scheme and reduced motion off (the fixture's): nothing to say.
  const native = checkImport(exportProfile(RECORD, { at: AT }).text, { ...HOST, platform: "linux" });
  assert.equal(native.ok, true, native.problem);
  assert.deepEqual(builds(native), []);
  assert.deepEqual(native.settings.display, { colorScheme: "light", reducedMotion: false });
  // PairBrowse as an extension: its time zone, screen and light scheme named, each a warning.
  const open = checkImport(exportProfile({ ...RECORD, browser: { kind: "pairbrowse-open" } }, { at: AT }).text, { ...HOST, platform: "linux" });
  assert.equal(open.ok, true, open.problem);
  assert.deepEqual(builds(open).map((i) => [i.field, i.status, i.severity]), [["locale.timezone", "unsupported", "warning"], ["screen", "unsupported", "warning"], ["display.colorScheme", "unsupported", "warning"]]);
  assert.match(byField(builds(open), "display.colorScheme")[0].reason, /^can't start as it is: PairBrowse as an extension can't give pages a light scheme/);
  assert.equal(open.settings.display.colorScheme, "light", "imported as it is");
});

test("an engine-persona's GPU, cores, memory, proxy, canvasBridge and launch options are unsupported and dropped, credentials in no file or log", () => {
  const r = checkImport(PERSONA, { ...HOST, file: "travel.json" });
  assert.equal(r.ok, true, r.problem);
  assert.equal(r.name, "travel-laptop");
  assert.deepEqual(r.settings.locale, { languages: ["en-US", "en"], timezone: "America/New_York", source: "set" });
  assert.deepEqual(r.settings.screen, { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, devicePixelRatio: 1 });
  assert.deepEqual(r.settings.persona, { source: "seed", seed: "travel-seed-1" });
  assert.equal(r.settings.network, null);
  const seed = byField(r.items, "options.fingerprint")[0];
  assert.equal(seed.severity, "warning", "a pinned seed is named as one device");
  for (const k of ["gpuVendor", "gpuRenderer", "hardwareConcurrency", "deviceMemory", "maxTouchPoints", "platform", "proxy", "canvasBridge", "webrtcIp", "location", "fingerprintProfile", "browserArgs", "executablePath", "humanize"]) {
    const [it] = byField(r.items, `options.${k}`);
    assert.equal(it?.status, "unsupported", k);
    assert.equal(it.requested, null, k);
  }
  assert.equal(byField(r.items, "options.brandVersion")[0].status, "derived");
  assert.equal(byField(r.items, "options.fingerprintNoise")[0].status, "not-applied");
  // Nothing of the proxy (address, user, password) or the other device's values anywhere.
  const text = JSON.stringify(r);
  for (const s of [SECRET, "fixture-user", "proxy.invalid", "Test Vendor", "Test Renderer", "203.0.113.9", "some-library-device", "--no-sandbox", "/tmp/x"]) assert.ok(!text.includes(s), s);
  // Imported into a store: the files written hold none of it either, and a refusal repeats none.
  const store = makeStore();
  const done = importInto(store, PERSONA, { ...HOST, file: "travel.json" });
  assert.equal(done.profile.name, "travel-laptop");
  assert.deepEqual(checkProfile(done.profile).problems, []);
  assert.ok(!allText(store.dir).includes(SECRET));
  assert.ok(!allText(store.dir).includes("fixture-user"));
  const bad = checkImport(withJson(PERSONA, (p) => ({ ...p, options: { ...p.options, timezone: SECRET } })), HOST);
  refusedAt(bad, "fields");
  assert.ok(!JSON.stringify(bad).includes(SECRET), "a refusal never repeats a string from the file");
  // A seed of the engine's number form; "off" (the persona turned off) refused.
  assert.equal(checkImport(withJson(PERSONA, (p) => ({ ...p, options: { ...p.options, fingerprint: 42 } })), HOST).settings.persona.seed, "42");
  refusedAt(checkImport(withJson(PERSONA, (p) => ({ ...p, options: { ...p.options, fingerprint: "off" } })), HOST), "fields", /persona\.seed/);
  // A persona with only a width and height: the rest filled; options without a screen size: not applied.
  const only = checkImport(Buffer.from(JSON.stringify({ name: "x", options: { colorDepth: 30 } })), HOST);
  assert.equal(only.settings.screen, null);
  assert.equal(byField(only.items, "options.colorDepth")[0].status, "not-applied");
});

test("provenance records SHA-256, source, license; missing ones refused; --license unknown imports unverified", () => {
  const r = checkImport(DEVICE, { ...HOST, terms: "for my own use" });
  assert.deepEqual(r.provenance, [{ format: "engine-device/1", file: "capture.json", sha256: sha256(DEVICE), importedAt: AT, by: "person", source: "my own laptop",
    license: "own-capture", terms: "for my own use", collectedAt: "2026-10-01T09:00:00.000Z", tool: "engine collector (schema_version 1)" }]);
  assert.equal(r.sha256, sha256(DEVICE), "the SHA-256 of the file as written");
  assert.equal(r.license, "own-capture");
  refusedAt(checkImport(DEVICE, { ...HOST, source: undefined }), "provenance", /no source/);
  refusedAt(checkImport(DEVICE, { ...HOST, source: "two\nlines" }), "provenance", /no source/);
  refusedAt(checkImport(DEVICE, { ...HOST, license: undefined }), "provenance", /no license/);
  refusedAt(checkImport(DEVICE, { ...HOST, license: "GPL 3; rm -rf" }), "provenance", /isn't an SPDX license id/);
  refusedAt(checkImport(DEVICE, { ...HOST, terms: "x".repeat(201) }), "provenance", /terms/);
  const unknown = checkImport(DEVICE, { ...HOST, license: "unknown" });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.unverified, true);
  assert.equal(unknown.license, "unknown");
  assert.ok(unknown.items.some((i) => i.field === "license" && i.status === "unverified" && i.severity === "warning"));
  assert.equal(checkImport(DEVICE, { ...HOST, license: "GPL-3.0-only" }).license, "GPL-3.0-only");
  // The original file is never kept: only its base name, never a folder or a hidden name.
  assert.equal(checkImport(DEVICE, { ...HOST, file: "/home/me/.secret/../.capture.json" }).provenance[0].file, "capture.json");
  // An export's own license and source come from the file; another --license refused naming both.
  const exp = exportProfile({ ...RECORD, provenance: r.provenance, license: "own-capture" }, { at: AT }).text;
  const back = checkImport(exp, { file: "berlin.json", at: AT });
  assert.equal(back.ok, true, back.problem);
  assert.equal(back.provenance.length, 2, "the earlier sources kept, this import added");
  assert.match(back.provenance[1].source, /^PairBrowse export/);
  refusedAt(checkImport(exp, { file: "berlin.json", at: AT, license: "MIT" }), "provenance", /the file names a different license than the one given/);
  // A refusal repeats no string from the file: an export whose license is a credential-shaped id.
  const token = "SECRETTOKENabc123";
  const odd = (source, license) => { const f = { ...exportProfile({ ...RECORD, provenance: [{ ...r.provenance[0], license: source }], license: source }, { at: AT }).file, license }; f.sha256 = exportSha(f); return JSON.stringify(f); };
  // Named differently by the person; and looser than an "unknown" source (an unlisted id ranks just under it).
  for (const [file, host] of [[odd("own-capture", token), { license: "MIT" }], [odd("unknown", token), {}]]) {
    const refusedOdd = checkImport(file, { file: "odd.json", at: AT, ...host });
    assert.equal(refusedOdd.ok, false);
    assert.ok(!JSON.stringify(refusedOdd).includes(token), "the file's license is never repeated");
  }
  const looser = (() => { const f = { ...exportProfile({ ...RECORD, provenance: [{ ...r.provenance[0], license: "GPL-3.0-only" }], license: "GPL-3.0-only" }, { at: AT }).file, license: "MIT" }; f.sha256 = exportSha(f); return JSON.stringify(f); })();
  const refusedLooser = checkImport(looser, { file: "l.json", at: AT });
  refusedAt(refusedLooser, "provenance", /looser than its sources'\.?$/);
  assert.ok(!refusedLooser.problem.includes("GPL-3.0-only"), "the sources' license is never repeated");
  // The record's license is the most restrictive of its sources'.
  assert.equal(mostRestrictive(["own-capture", "MIT", "GPL-3.0-only", "CC-BY-4.0"]), "GPL-3.0-only");
  assert.equal(mostRestrictive(["MIT", "unknown"]), "unknown");
  assert.ok(licenseRank("MIT OR GPL-3.0-only") < licenseRank("MIT AND GPL-3.0-only"));
});

test("--dry-run writes nothing; an import makes a profile with a new id and a free name", () => {
  const store = makeStore();
  const dry = importInto(store, DEVICE, { ...HOST, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.profile, null);
  assert.equal(dry.name, "capture");
  assert.equal(existsSync(store.dir) ? readdirSync(store.dir).filter((n) => n !== ".lock").length : 0, 0, "no record written");
  const one = importInto(store, DEVICE, HOST);
  assert.equal(one.profile.name, "capture");
  assert.equal(one.profile.revision, 1);
  assert.deepEqual(one.profile.validation, {});
  assert.equal(one.profile.provenance[0].sha256, sha256(DEVICE));
  if (process.platform !== "win32") assert.equal(statSync(join(store.dir, `${one.profile.id}.json`)).mode & 0o777, 0o600);
  // The same file again gets the next free name; a name the person gives is used as it is.
  assert.equal(importInto(store, DEVICE, HOST).profile.name, "capture-2");
  assert.throws(() => importInto(store, DEVICE, { ...HOST, name: "capture" }), (e) => e.code === "PROFILE_NAME");
  assert.equal(importInto(store, DEVICE, { ...HOST, name: "work-mac" }).profile.name, "work-mac");
  // A refusal throws with the report, and writes nothing.
  const before = readdirSync(store.dir).length;
  assert.throws(() => importInto(store, Buffer.from("{}"), HOST), (e) => e.code === "PROFILE_IMPORT" && e.report.refused.check === "format");
  assert.equal(readdirSync(store.dir).length, before);
  // Names from files: cleaned, never the default's or an id's.
  assert.equal(importName(null, "my capture (1).json"), "my-capture-1");
  assert.equal(importName("Default", "x.json"), "Default-imported");
  assert.equal(importName(null, "p-0123456789abcdef.json"), "p-0123456789abcdef-imported");
  assert.equal(importName(null, "....json"), "imported");
  // From a path: the one file, by its base name.
  const dir = mkdtempSync(join(tmpdir(), "pb-import-path-"));
  writeFileSync(join(dir, "laptop.json"), DEVICE);
  assert.equal(importFile(store, join(dir, "laptop.json"), { source: "s", license: "MIT", at: AT }).profile.provenance[0].file, "laptop.json");
});
