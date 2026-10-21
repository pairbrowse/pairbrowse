// Importing a browser profile from one file (spec server-mode D-AP2, D15 to D17): a PairBrowse
// export (`pairbrowse-profile/1`), the engine pack's collector output (`engine-device/1`) or an
// engine persona (`engine-persona`), told apart by their content, never by a file name. Settings
// only: another device's hardware is reported `unsupported` and never applied (profiles/device.mjs),
// network references, credentials and launch options are never kept, and the original file is
// never stored; its SHA-256 is, in the record's provenance with its source and license (D17).
//
// checkImport is pure: the file's bytes and a host object ({ file, at, source, license, terms,
// name }) in, a report out. Its checks run in order (IMPORT_CHECKS) and the first that fails
// refuses the import, naming the file, the check and the value (a number, true, false or null;
// never a string from the file, which could be a credential): size (at most 1 MiB, refused before
// parsing), json (UTF-8, strict JSON), shape (an object, nested at most 32 deep), format (detected
// by content), integrity (a PairBrowse export's SHA-256 over its canonical JSON, as written),
// version (a format version this PairBrowse reads; an older export upgraded), fields (every
// top-level section classed; the settings read checked as a whole record, profiles/schema.mjs),
// provenance (source and license present). Coherence (rules/coherence.mjs screen.believable) and
// a setting the profile's browser can't apply on this computer (profiles/map.mjs buildFit, rule
// "import.build") only warn. Data in the file that isn't applied is reported per field and never refuses (D11).
//
// importInto(store, bytes, host) writes the checked profile through the store (profiles/store.mjs
// create); readImportFile reads the one file asked for (a regular file, never a link, its size
// checked before a byte of it is read). Node's standard library only.
import { openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { basename, extname } from "node:path";
import { sha256 } from "../util.mjs";
import { screenBelievable } from "../rules/coherence.mjs";
import { EXPORT_FORMAT, SCHEMA_VERSION, SETTINGS, PROFILE_ID, PROVENANCE_MAX, HISTORY_MAX, DEFAULT_PROFILE,
  checkProfile, profileDefaults, mostRestrictive, licenseRank, looserWhy, canonicalJson } from "./schema.mjs";
import { upgradeExport } from "./upgrade.mjs";
import { DEVICE_SCHEMA_VERSION, deviceSettings, personaSettings, item, reportable } from "./device.mjs";
import { buildFit } from "./map.mjs";

export const IMPORT_MAX_BYTES = 1024 * 1024;
export const IMPORT_MAX_DEPTH = 32;
export const IMPORT_CHECKS = ["size", "json", "shape", "format", "integrity", "version", "fields", "provenance"];
// What a person names as a license (D17): an SPDX id or expression, own-capture or unknown.
const LICENSE = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}(?: (?:AND|OR|WITH) [A-Za-z0-9][A-Za-z0-9.+-]{0,63}){0,4}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const BASE_NAME = /^[^/\\\0.][^/\\\0]{0,254}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const BUILD = /^\d{1,4}(?:\.\d{1,6}){3}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// The keys of an export file and of its profile part (D18).
const EXPORT_KEYS = ["format", "formatVersion", "exported", "profile", "provenance", "license", "sha256"];
const EXPORT_PROFILE_KEYS = ["name", ...SETTINGS, "history"];
// A stand-in identity for checking the settings read as a whole record (the store gives its own).
const CHECK_ID = "p-0000000000000000";

const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// A short text a person typed (source, terms): printable, no line breaks, at most 200 characters.
const TEXT = /^[^\0-\x1f\x7f]{1,200}$/;
const shownFile = (f) => (BASE_NAME.test(f) ? `"${f}"` : "the file");

// The file's base name as provenance keeps it: no folder, no leading dot, at most 255 characters.
export function importFileName(file) {
  const base = basename(String(file || "")).replace(/^\.+/, "").replace(/[\0\\/]/g, "").slice(0, 255);
  return base || "profile.json";
}

// Deeper than max (iteratively: a file nested 100000 deep can't overflow the stack here).
function tooDeep(v, max) {
  const stack = [[v, 1]];
  while (stack.length) {
    const [x, d] = stack.pop();
    if (!x || typeof x !== "object") continue;
    if (d > max) return true;
    for (const k of Object.keys(x)) stack.push([x[k], d + 1]);
  }
  return false;
}

// The import format of a parsed file, by content (D15): { format } or { problem }.
export function detectFormat(raw) {
  if (!plainObject(raw)) return { problem: "it isn't a JSON object { ... }" };
  if (Object.hasOwn(raw, "format")) {
    if (raw.format === EXPORT_FORMAT) return { format: `${EXPORT_FORMAT}/1` };
    return { problem: `its "format" isn't "${EXPORT_FORMAT}", the one format of that kind PairBrowse imports` };
  }
  const device = plainObject(raw.navigator), persona = plainObject(raw.options);
  if (device && persona) return { problem: "it has both a navigator section and an options object, so it is neither a device file nor a persona" };
  if (device) return { format: "engine-device/1" };
  if (persona) return { format: "engine-persona" };
  return { problem: `it isn't a format PairBrowse imports (a PairBrowse export with "format": "${EXPORT_FORMAT}", a device file with a navigator section, or a persona with an options object)` };
}

// An export file's SHA-256 (D18): over the canonical JSON of everything in it but its sha256.
export function exportSha256(file) {
  const { sha256: _ignored, ...rest } = file;
  return sha256(canonicalJson(rest));
}

// A name for an imported profile (letters, digits, - and _, up to 40) from the name the file holds,
// else the file's name; never the config-backed profile's or one shaped like an id.
export function importName(given, fileName) {
  const raw = typeof given === "string" && given ? given : basename(fileName, extname(fileName));
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 40).replace(/[-_]+$/, "");
  if (!NAME.test(cleaned)) return "imported";
  return cleaned.toLowerCase() === DEFAULT_PROFILE || PROFILE_ID.test(cleaned) ? `${cleaned}-imported` : cleaned;
}

// The check that failed: { check, reason }.
const refusal = (check, reason) => ({ check, reason });

// A PairBrowse export (D18) read: { settings, name, provenance, license, items, collectedAt, tool } or
// a refusal. raw: the parsed file; text: as written (its SHA-256 is checked over the parsed value).
function readExport(raw) {
  if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) return refusal("integrity", "it has no sha256 of 64 hex digits");
  if (exportSha256(raw) !== raw.sha256) return refusal("integrity", "its content doesn't match its SHA-256 (it was changed after it was exported)");
  const { file, problem } = upgradeExport(raw);
  if (!file) return refusal("version", problem.replace(/\.$/, ""));
  const stray = Object.keys(file).filter((k) => !EXPORT_KEYS.includes(k));
  if (stray.length) return refusal("shape", `it holds keys an export doesn't (${stray.filter(reportable).join(", ") || `${stray.length} unnamed`})`);
  const { exported, profile } = file;
  if (!plainObject(exported) || typeof exported.at !== "string" || !ISO.test(exported.at)
    || !(exported.pairbrowseVersion === null || (typeof exported.pairbrowseVersion === "string" && VERSION.test(exported.pairbrowseVersion)))
    || !(exported.engineBuild === null || (typeof exported.engineBuild === "string" && BUILD.test(exported.engineBuild)))
    || Object.keys(exported).some((k) => !["at", "pairbrowseVersion", "engineBuild"].includes(k))) {
    return refusal("shape", "exported is { at, pairbrowseVersion, engineBuild } (a UTC time, a version or null, a build or null)");
  }
  if (!plainObject(profile)) return refusal("shape", "profile is an object { ... }");
  const strayProfile = Object.keys(profile).filter((k) => !EXPORT_PROFILE_KEYS.includes(k));
  if (strayProfile.length) return refusal("fields", `profile holds keys an export doesn't (${strayProfile.filter(reportable).join(", ") || `${strayProfile.length} unnamed`}); a profile holds only its name and settings`);
  if (!Array.isArray(file.provenance)) return refusal("provenance", "provenance is a list");
  if (typeof file.license !== "string" || !LICENSE.test(file.license)) return refusal("provenance", 'license is an SPDX license id, "own-capture" or "unknown"');
  const sources = mostRestrictive(file.provenance.map((p) => p?.license));
  if (file.provenance.length && licenseRank(file.license) < licenseRank(sources)) return refusal("provenance", `its license is looser than its sources'${looserWhy(sources)}`);

  const items = [];
  const settings = {};
  for (const k of SETTINGS) {
    if (!Object.hasOwn(profile, k)) { items.push(item(`profile.${k}`, "derived", "C", "not in the file; the default")); continue; }
    if (k === "network") {
      if (profile.network !== null) items.push(item("profile.network", "not-applied", "C", "a network is chosen on this computer; network references are never imported"));
      continue;
    }
    settings[k] = structuredClone(profile[k]);
    items.push(item(`profile.${k}`, "applied", "C", `imported into ${k}`, { requested: structuredClone(profile[k]) }));
  }
  if (plainObject(settings.persona) && typeof settings.persona.seed === "string") {
    items.push(item("profile.persona.seed", "applied", "C", "a pinned seed: two browsers with it look like one device, so it runs in one browser at a time", { severity: "warning", rule: "import.identity" }));
  }
  if (Object.hasOwn(profile, "history")) {
    if (!Array.isArray(profile.history) || profile.history.length > HISTORY_MAX) return refusal("fields", `profile.history is a list of at most ${HISTORY_MAX} entries`);
    items.push(item("profile.history", "not-applied", "D", `${profile.history.length} entr${profile.history.length === 1 ? "y" : "ies"} of the exported profile's history, kept in the file; the new profile starts its own`));
  }
  return {
    settings, name: typeof profile.name === "string" ? profile.name : null, provenance: structuredClone(file.provenance), license: file.license, items,
    collectedAt: exported.at, tool: exported.pairbrowseVersion ? `PairBrowse ${exported.pairbrowseVersion}` : "PairBrowse",
    source: `PairBrowse export${exported.pairbrowseVersion ? ` (${exported.pairbrowseVersion})` : ""}`,
  };
}

// A collector file (engine-device/1) read: its meta.schema_version 1 or absent.
function readDevice(raw) {
  const meta = plainObject(raw.meta) ? raw.meta : {};
  const v = meta.schema_version;
  if (v !== undefined && v !== null) {
    if (!Number.isInteger(v) || v < 1) return refusal("version", "meta.schema_version isn't a version this PairBrowse knows (a whole number from 1)");
    if (v > DEVICE_SCHEMA_VERSION) return refusal("version", `the device file is schema_version ${v}, newer than this PairBrowse reads (${DEVICE_SCHEMA_VERSION}); update PairBrowse`);
  }
  const { settings, items, collectedAt } = deviceSettings(raw);
  return { settings, name: null, provenance: [], license: null, items, collectedAt, tool: `engine collector (schema_version ${v ?? DEVICE_SCHEMA_VERSION})`, source: null };
}

function readPersona(raw) {
  const { settings, items } = personaSettings(raw);
  return { settings, name: typeof raw.name === "string" ? raw.name : null, provenance: [], license: null, items, collectedAt: null, tool: "engine persona", source: null };
}

// Checks one file (its bytes, or its text) for import. host: { file (the name it came as), at (the
// import's ISO time), source, license, terms (the person's --source, --license, --terms), name,
// platform (the computer the build check is for: this one when left out) }.
// Answers { ok, format, refused: { check, reason } | null, problem (a sentence, "" when ok), name,
// settings, provenance, license, sha256, items, unverified }: on ok, everything store.create takes
// (name, settings, provenance, license); items: the field report and coherence, D10's shape.
// Never throws, reads no file.
export function checkImport(data, host = {}) {
  const fileName = importFileName(host.file);
  const at = typeof host.at === "string" && ISO.test(host.at) ? host.at : new Date().toISOString();
  const out = { ok: false, format: null, refused: null, problem: "", name: null, settings: null, provenance: null, license: null, sha256: null, items: [], unverified: false };
  // A refusal keeps the field report without values: what it read may be what was wrong.
  const refuse = ({ check, reason }) => ({ ...out, items: out.items.map((i) => ({ ...i, requested: null })), refused: { check, reason },
    problem: `Import of ${shownFile(fileName)} refused at the ${check} check: ${reason}.` });

  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.isBuffer(data) ? data : data instanceof Uint8Array ? Buffer.from(data) : null;
  if (!bytes) return refuse(refusal("size", "no file content was given"));
  if (bytes.length > IMPORT_MAX_BYTES) return refuse(refusal("size", `it is ${bytes.length} bytes; a profile file is at most ${IMPORT_MAX_BYTES} (1 MiB)`));
  out.sha256 = sha256(bytes);
  let raw;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    raw = JSON.parse(text);
  } catch { return refuse(refusal("json", "it isn't UTF-8 JSON")); }
  if (!plainObject(raw)) return refuse(refusal("shape", "it isn't a JSON object { ... }"));
  if (tooDeep(raw, IMPORT_MAX_DEPTH)) return refuse(refusal("shape", `it is nested more than ${IMPORT_MAX_DEPTH} deep`));
  const { format, problem } = detectFormat(raw);
  if (!format) return refuse(refusal("format", problem));
  out.format = format;

  const read = format === "engine-device/1" ? readDevice(raw) : format === "engine-persona" ? readPersona(raw) : readExport(raw);
  if (read.check) return refuse(read);
  out.items = read.items;

  // Provenance (D17): source and license from the file, else from the person; both required.
  const source = read.source ?? host.source;
  if (typeof source !== "string" || !TEXT.test(source)) return refuse(refusal("provenance", "it names no source; say where it came from (--source, up to 200 characters on one line)"));
  let license = read.license;
  if (host.license !== undefined && host.license !== null) {
    if (typeof host.license !== "string" || !LICENSE.test(host.license)) return refuse(refusal("provenance", 'the license named isn\'t an SPDX license id, "own-capture" or "unknown"'));
    if (license && license !== host.license) return refuse(refusal("provenance", "the file names a different license than the one given"));
    license = host.license;
  }
  if (!license) return refuse(refusal("provenance", 'it names no license; name it (--license: an SPDX license id, "own-capture" or "unknown")'));
  const terms = host.terms ?? null;
  if (terms !== null && (typeof terms !== "string" || !TEXT.test(terms))) return refuse(refusal("provenance", "terms are up to 200 characters on one line"));
  const entry = { format, file: fileName, sha256: out.sha256, importedAt: at, by: "person", source, license, terms, collectedAt: read.collectedAt, tool: read.tool };
  const provenance = [...read.provenance, entry];
  if (provenance.length > PROVENANCE_MAX) return refuse(refusal("provenance", `it would hold ${provenance.length} provenance entries; a profile holds at most ${PROVENANCE_MAX}`));
  const recordLicense = mostRestrictive(provenance.map((p) => p?.license));

  // The settings read, checked as the whole record the store will make.
  // A name the person gives is taken as it is (refused by the record check when it can't be one).
  const name = typeof host.name === "string" && host.name ? host.name : importName(read.name, fileName);
  const settings = { ...profileDefaults(), ...read.settings };
  const candidate = { schema: SCHEMA_VERSION, id: CHECK_ID, name, kind: "store",
    revision: 1, status: "active", created: at, engine: null, ...settings, license: recordLicense, provenance, validation: {}, history: [] };
  const { profile, problems } = checkProfile(candidate);
  if (!profile) return refuse(refusal(problems.some((p) => /^provenance|^license/.test(p)) ? "provenance" : "fields", `the settings read from it can't be used: ${problems.map((p) => p.replace(/\.$/, "")).join("; ")}`));

  if (recordLicense === "unknown") {
    out.unverified = true;
    out.items.push(item("license", "unverified", "U", 'its license is "unknown": the profile imports unverified, and every launch on it warns until its license is known', { severity: "warning", rule: "import.provenance" }));
  }
  for (const c of screenBelievable(profile.screen, { window: profile.window })) out.items.push(item(c.field, "mismatch", "C", c.text, { severity: c.severity, rule: c.id }));
  // What the browser the profile is for can't apply on this computer (D11): imported, and said now
  // rather than by a launch that refuses it (profiles/map.mjs buildFit).
  for (const r of buildFit(profile, { platform: host.platform }).items) out.items.push(item(r.field, r.status, r.class, `can't start as it is: ${r.reason}`, { severity: "warning", rule: "import.build" }));
  const kept = Object.fromEntries(SETTINGS.map((k) => [k, profile[k]]));
  return { ...out, ok: true, name, settings: kept, provenance: profile.provenance, license: profile.license };
}

// A name for the store: the one asked for as it is (the store refuses one taken), else the file's
// with -2, -3, ... when another profile has it.
function freeName(store, report, asked) {
  if (asked) return report.name;
  const taken = new Set([DEFAULT_PROFILE, ...store.list().map((r) => r.name).filter(Boolean).map((n) => n.toLowerCase())]);
  const base = report.name;
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const next = `${base.slice(0, 40 - String(n).length - 1)}-${n}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
  return base;
}

// Imports one file's bytes into store (profiles/store.mjs): { ...checkImport's report, profile }.
// host as checkImport's, plus dryRun (check and report, write nothing). A refusal throws
// PROFILE_IMPORT with the report's problem (err.report holds the report).
export function importInto(store, data, host = {}) {
  const report = checkImport(data, host);
  if (!report.ok) throw Object.assign(new Error(report.problem), { code: "PROFILE_IMPORT", report });
  const name = freeName(store, report, typeof host.name === "string" && host.name !== "");
  if (host.dryRun) return { ...report, name, profile: null, dryRun: true };
  const profile = store.create({ name, ...report.settings, provenance: report.provenance, license: report.license });
  return { ...report, name, profile, dryRun: false };
}

// The bytes of the one file asked for: a regular file (a link at its name is refused, never
// followed), at most IMPORT_MAX_BYTES, its size checked before anything is read. Opened without
// blocking, so a named pipe or device at the name is refused at once rather than waiting for a
// writer. Throws PROFILE_IMPORT naming the file and the check.
export function readImportFile(file) {
  const name = shownFile(importFileName(file));
  const fail = (check, reason) => Object.assign(new Error(`Import of ${name} refused at the ${check} check: ${reason}.`), { code: "PROFILE_IMPORT" });
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch (e) {
    if (e?.code === "ELOOP" || e?.code === "EMLINK") throw fail("file", "it is a link, which is never followed; name the file itself");
    throw fail("file", e?.code === "ENOENT" ? "there is no such file" : `it can't be opened (${e?.code || "an error"})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw fail("file", "it isn't a regular file");
    if (st.size > IMPORT_MAX_BYTES) throw fail("size", `it is ${st.size} bytes; a profile file is at most ${IMPORT_MAX_BYTES} (1 MiB)`);
    // One byte past the cap: a file that grew since fstat is refused too.
    const buf = Buffer.alloc(IMPORT_MAX_BYTES + 1);
    let got = 0, n;
    while (got < buf.length && (n = readSync(fd, buf, got, buf.length - got, null)) > 0) got += n;
    if (got > IMPORT_MAX_BYTES) throw fail("size", `it is over ${IMPORT_MAX_BYTES} bytes (1 MiB)`);
    return buf.subarray(0, got);
  } finally { closeSync(fd); }
}

// Imports the file at path (readImportFile, then importInto with its base name).
export function importFile(store, path, host = {}) {
  return importInto(store, readImportFile(path), { ...host, file: basename(String(path)) });
}

