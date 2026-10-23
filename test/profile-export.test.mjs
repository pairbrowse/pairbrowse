// Exporting a browser profile (spec server-mode D18; scripts/profiles/export.mjs): a
// `pairbrowse-profile/1` file with the name and settings, provenance and the most restrictive
// license, sealed by a SHA-256 over its canonical JSON; id, validation, history, a pinned seed,
// network references and saved-card data left out unless asked; the round trip through import
// gives a new id and empty validation.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportProfile, exportToFile, pairbrowseVersion } from "../scripts/profiles/export.mjs";
import { checkImport, importInto, exportSha256 } from "../scripts/profiles/import.mjs";
import { createProfileStore } from "../scripts/profiles/store.mjs";
import { SETTINGS, checkProfile } from "../scripts/profiles/schema.mjs";
import { measuredEntry } from "./helpers/measured.mjs";

const RECORD = JSON.parse(readFileSync(new URL("./fixtures/profiles/record-1.json", import.meta.url), "utf8"));
const AT = "2026-10-21T10:00:00Z";
const PROV = { format: "engine-device/1", file: "mac.json", sha256: "a".repeat(64), importedAt: "2026-10-20T09:00:00Z", by: "person",
  source: "my laptop", license: "own-capture", terms: null, collectedAt: null, tool: null };
const record = (change = {}) => ({ ...structuredClone(RECORD), ...structuredClone(change) });
function makeStore() {
  let t = Date.parse(AT), n = 0;
  return createProfileStore({ dir: join(mkdtempSync(join(tmpdir(), "pb-export-")), "browser-profiles"), now: () => (t += 1000), randomId: () => (++n).toString(16).padStart(16, "0") });
}

test("round trip keeps typed fields with a new id and empty validation", () => {
  const store = makeStore();
  const original = store.create({ name: "berlin", locale: RECORD.locale, screen: RECORD.screen, window: RECORD.window, display: RECORD.display,
    graphics: { backend: "software", require: { webgl: 2, webgpu: false, platforms: ["linux"] } }, adBlocker: true });
  // Some evidence a launch would add: never exported.
  const measured = { ...original, engine: RECORD.engine, validation: { "155.0.8059.84": measuredEntry({ at: AT }) } };
  const { file, text, sha256 } = exportProfile(measured, { at: AT, version: "0.16.12" });
  assert.deepEqual(Object.keys(file), ["format", "formatVersion", "exported", "profile", "provenance", "license", "sha256"]);
  assert.equal(file.format, "pairbrowse-profile");
  assert.equal(file.formatVersion, 1);
  assert.deepEqual(file.exported, { at: AT, pairbrowseVersion: "0.16.12", engineBuild: "155.0.8059.84" });
  assert.equal(sha256, exportSha256(JSON.parse(text)));
  for (const k of ["id", "validation", "history", "engine", "revision", "status", "kind", "created"]) assert.ok(!(k in file.profile), `${k} left out`);
  const back = importInto(store, text, { file: "berlin.json", at: AT, name: "berlin-copy" }).profile;
  assert.notEqual(back.id, original.id);
  assert.deepEqual(back.validation, {});
  assert.equal(back.engine, null);
  assert.equal(back.revision, 1);
  for (const k of SETTINGS) assert.deepEqual(back[k], original[k], k);
  assert.deepEqual(checkProfile(back).problems, []);
  // Its own version by default.
  assert.equal(exportProfile(original, { at: AT }).file.exported.pairbrowseVersion, pairbrowseVersion());
  assert.match(pairbrowseVersion(), /^\d+\.\d+\.\d+/);
  // The config-backed default's whole record exports too, and imports under another name.
  const def = store.configProfile({ adBlocker: false });
  const imported = importInto(store, exportProfile(def, { at: AT }).text, { file: "default.json", at: AT });
  assert.equal(imported.profile.name, "default-imported");
  assert.equal(imported.profile.kind, "store");
});

test("seed, history, network and saved-card data left out unless asked", () => {
  const r = record({ persona: { source: "seed", seed: "pinned-1" }, network: "home-proxy", payments: { savedCard: true },
    history: [{ revision: 3, at: AT, change: ["screen"], by: "person" }, { revision: 4, at: AT, change: ["locale.timezone"], by: "person" }] });
  const plain = exportProfile(r, { at: AT });
  assert.equal(plain.file.profile.persona.seed, null);
  assert.equal(plain.file.profile.network, null);
  assert.ok(!("history" in plain.file.profile));
  assert.deepEqual(plain.warnings, []);
  assert.ok(!plain.text.includes("pinned-1"));
  assert.ok(!plain.text.includes("home-proxy"));
  // Only the saved-card choice travels; card data is never in a profile, so never in an export.
  assert.deepEqual(plain.file.profile.payments, { savedCard: true });
  assert.doesNotMatch(plain.text, /card(?:Number|holder)|"cc-|"number"/i);

  const asked = exportProfile(r, { at: AT, withHistory: true, includeIdentity: true });
  assert.equal(asked.file.profile.persona.seed, "pinned-1");
  assert.equal(asked.file.profile.history.length, 2);
  assert.equal(asked.file.profile.network, null, "network references never travel");
  assert.match(asked.warnings[0], /two browsers started with it look like one device/);
  // On import: the seed applied with its warning, the history reported and not applied.
  const back = checkImport(asked.text, { file: "x.json", at: AT });
  assert.equal(back.ok, true, back.problem);
  assert.equal(back.settings.persona.seed, "pinned-1");
  assert.ok(back.items.some((i) => i.field === "profile.persona.seed" && i.severity === "warning"));
  assert.ok(back.items.some((i) => i.field === "profile.history" && i.status === "not-applied" && /2 entries/.test(i.reason)));
  assert.equal(back.settings.network, null);
  // A network id in a file is never applied.
  const net = JSON.parse(plain.text);
  net.profile.network = "someone-elses";
  net.sha256 = exportSha256(net);
  const withNet = checkImport(JSON.stringify(net), { file: "x.json", at: AT });
  assert.equal(withNet.settings.network, null);
  assert.ok(withNet.items.some((i) => i.field === "profile.network" && i.status === "not-applied"));
});

test("license is the most restrictive", () => {
  const gpl = { ...PROV, license: "GPL-3.0-only", sha256: "b".repeat(64) };
  const cc = { ...PROV, license: "CC-BY-4.0", sha256: "c".repeat(64) };
  assert.equal(exportProfile(record({ provenance: [PROV, gpl, cc], license: "GPL-3.0-only" }), { at: AT }).file.license, "GPL-3.0-only");
  assert.equal(exportProfile(record({ provenance: [PROV, cc], license: "CC-BY-4.0" }), { at: AT }).file.license, "CC-BY-4.0");
  assert.equal(exportProfile(record(), { at: AT }).file.license, "own-capture");
  // A record can't claim a looser license than its sources (the schema refuses it), so neither can an export.
  assert.match(checkProfile(record({ provenance: [gpl], license: "MIT" })).problems[0], /^license is looser than its sources'\.?$/);
  assert.throws(() => exportProfile(record({ provenance: [gpl], license: "MIT" })), (e) => e.code === "PROFILE_INVALID");
  // A file claiming a looser license than its own provenance is refused on import.
  const f = exportProfile(record({ provenance: [gpl], license: "GPL-3.0-only" }), { at: AT }).file;
  f.license = "MIT";
  f.sha256 = exportSha256(f);
  const r = checkImport(JSON.stringify(f), { file: "x.json", at: AT });
  assert.equal(r.refused.check, "provenance");
  assert.match(r.problem, /looser than its sources'/);
  // Importing keeps every source, so the license stays.
  const ok = checkImport(exportProfile(record({ provenance: [PROV, gpl], license: "GPL-3.0-only" }), { at: AT }).text, { file: "x.json", at: AT });
  assert.equal(ok.license, "GPL-3.0-only");
  assert.equal(ok.provenance.length, 3);
});

test("an edited export fails its SHA-256", () => {
  const { text } = exportProfile(record(), { at: AT });
  assert.equal(checkImport(text, { file: "x.json", at: AT }).ok, true);
  // Reformatted but unchanged: still the same canonical JSON.
  assert.equal(checkImport(JSON.stringify(JSON.parse(text)), { file: "x.json", at: AT }).ok, true);
  for (const edit of [(f) => { f.profile.locale.timezone = "Europe/Paris"; }, (f) => { f.license = "MIT"; }, (f) => { f.provenance.push(PROV); },
    (f) => { f.exported.at = "2026-10-22T10:00:00Z"; }, (f) => { f.profile.extra = 1; }]) {
    const f = JSON.parse(text);
    edit(f);
    const r = checkImport(JSON.stringify(f), { file: "x.json", at: AT });
    assert.equal(r.refused?.check, "integrity", r.problem);
    assert.match(r.problem, /doesn't match its SHA-256/);
  }
  const f = JSON.parse(text);
  delete f.sha256;
  assert.match(checkImport(JSON.stringify(f), { file: "x.json", at: AT }).problem, /refused at the integrity check: it has no sha256/);
  // Unknown keys in a sealed file are refused by name.
  const extra = JSON.parse(text);
  extra.profile.proxy = "http://u:p@h:1";
  extra.sha256 = exportSha256(extra);
  const r = checkImport(JSON.stringify(extra), { file: "x.json", at: AT });
  assert.equal(r.refused.check, "fields");
  assert.match(r.problem, /proxy/);
  assert.ok(!r.problem.includes("u:p@h"));
});

test("exportToFile writes one owner-only file and never replaces a link or folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-export-file-"));
  const dest = join(dir, "berlin.json");
  const out = exportToFile(record(), dest, { at: AT });
  assert.equal(out.file, dest);
  if (process.platform !== "win32") assert.equal(statSync(dest).mode & 0o777, 0o600);
  assert.equal(checkImport(readFileSync(dest), { file: "berlin.json", at: AT }).ok, true);
  assert.throws(() => exportToFile(record(), dest, { at: AT }), (e) => e.code === "PROFILE_EXPORT" && /a file is at that name already/.test(e.message));
  assert.equal(exportToFile(record(), dest, { at: AT, overwrite: true }).file, dest);
  writeFileSync(join(dir, "target.json"), "keep");
  symlinkSync(join(dir, "target.json"), join(dir, "link.json"));
  assert.throws(() => exportToFile(record(), join(dir, "link.json"), { at: AT, overwrite: true }), (e) => e.code === "PROFILE_EXPORT" && /link or folder/.test(e.message));
  assert.equal(readFileSync(join(dir, "target.json"), "utf8"), "keep");
  assert.throws(() => exportProfile({ ...record(), name: 5 }), (e) => e.code === "PROFILE_INVALID");
});
