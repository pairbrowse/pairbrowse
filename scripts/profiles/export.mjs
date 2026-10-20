// Exporting a browser profile as a `pairbrowse-profile/1` file (spec server-mode D18): its name and
// settings, where its data came from and under which license, sealed with a SHA-256 over the
// canonical JSON so an edited file is refused on import (profiles/import.mjs). Left out: the id
// (an import gets a new one), validation (measured on each computer), engine, revision and status,
// history (unless withHistory), a pinned seed (unless includeIdentity: two browsers with it look
// like one device), network references and credentials, and saved-card data (it lives encrypted in
// the session's storage, never in a profile). Storage (cookies, logins) is never exported.
//
// exportProfile is pure; exportToFile writes the one file asked for, owner-only. Node's standard
// library only.
import { lstatSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../util.mjs";
import { EXPORT_FORMAT, FORMAT_VERSION, SETTINGS, checkProfile, mostRestrictive } from "./schema.mjs";
import { exportSha256 } from "./import.mjs";

// This PairBrowse's version, written into each export (exported.pairbrowseVersion).
let ownVersion;
export function pairbrowseVersion() {
  if (ownVersion === undefined) {
    try { ownVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version || null; } catch { ownVersion = null; }
  }
  return ownVersion;
}

const fail = (code, message) => Object.assign(new Error(message), { code });

// A checked record (a store profile, or the config-backed default's whole record) as an export
// file: { file, text, sha256, warnings }. file: the object; text: as written to disk; warnings:
// sentences for the person (includeIdentity's). at: the export's ISO time. Refuses a record that
// doesn't check (PROFILE_INVALID), naming its first problem.
export function exportProfile(record, { withHistory = false, includeIdentity = false, at = new Date().toISOString(), version = pairbrowseVersion() } = {}) {
  const { profile: p, problems } = checkProfile(record);
  if (!p) throw fail("PROFILE_INVALID", `The browser profile wasn't exported: ${problems[0]}`);
  const warnings = [];
  const profile = { name: p.name };
  for (const k of SETTINGS) profile[k] = structuredClone(p[k]);
  profile.network = null;
  if (profile.persona.seed !== null) {
    if (includeIdentity) warnings.push(`The export holds browser profile "${p.name}"'s pinned seed: two browsers started with it look like one device to sites, so use it in one place at a time.`);
    else profile.persona.seed = null;
  }
  if (withHistory) profile.history = structuredClone(p.history);
  const provenance = structuredClone(p.provenance);
  const file = {
    format: EXPORT_FORMAT, formatVersion: FORMAT_VERSION,
    exported: { at, pairbrowseVersion: version, engineBuild: p.engine?.build ?? null },
    profile, provenance,
    // The most restrictive of its sources', and never looser than the record's own.
    license: provenance.length ? mostRestrictive([...provenance.map((e) => e.license), p.license]) : p.license,
  };
  file.sha256 = exportSha256(file);
  return { file, text: `${JSON.stringify(file, null, 2)}\n`, sha256: file.sha256, warnings };
}

// Writes record's export to dest (0600, whole through a temporary file and a rename): { file:
// dest, sha256, warnings }. A file already at dest is replaced only with overwrite; a link or
// folder there never.
export function exportToFile(record, dest, { overwrite = false, ...options } = {}) {
  const out = exportProfile(record, options);
  let st = null;
  try { st = lstatSync(dest); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  if (st && !st.isFile()) throw fail("PROFILE_EXPORT", "The browser profile wasn't exported: something other than a file (a link or folder) is at that name.");
  if (st && !overwrite) throw fail("PROFILE_EXPORT", "The browser profile wasn't exported: a file is at that name already; choose another, or replace it.");
  writeJsonAtomic(dest, out.file, { mode: 0o600 });
  return { file: dest, sha256: out.sha256, warnings: out.warnings };
}
