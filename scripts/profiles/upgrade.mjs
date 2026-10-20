// Older profile records and export files brought up to this PairBrowse's versions (spec
// server-mode D19): a chain of pure steps, one per version, each taking a record of version n and
// answering one of version n + 1. A newer version is refused and never rewritten (the file stays
// as it is for the PairBrowse that wrote it); an older one is upgraded in memory, and the store
// writes the result only as a new revision file through its own lock (profiles/store.mjs).
//
// Records: schema 1 is the first, so RECORD_STEPS is empty until schema 2; a step added for a new
// schema keeps the record's history, and the upgrader appends one entry naming the change
// ({ revision, at, change: ["schema"], by: "upgrade" }) without bumping the revision (settings
// are unchanged). Exports: `pairbrowse-profile` formatVersion 1 is the first; an older export is
// upgraded after its SHA-256 is checked over the file as written (profiles/import.mjs), never
// before.
//
// Pure; Node's standard library only.
import { SCHEMA_VERSION, FORMAT_VERSION, EXPORT_FORMAT, HISTORY_MAX, checkProfile } from "./schema.mjs";

// RECORD_STEPS[n]: a record of schema n to one of schema n + 1. Keyed from 1; none yet.
export const RECORD_STEPS = Object.freeze({});
// EXPORT_STEPS[n]: an export of formatVersion n to one of n + 1. None yet.
export const EXPORT_STEPS = Object.freeze({});

const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// The versions a chain has no step for between first and current (a gap would strand records of
// that version): [] when every version below current has its step.
export function chainGaps(steps, current, first = 1) {
  const gaps = [];
  for (let n = first; n < current; n++) if (typeof steps[n] !== "function") gaps.push(n);
  return gaps;
}

// Runs value (at version from) through steps to version to: { value, problem }. Each step gets a
// copy, never the caller's object; a step that throws or answers something other than an object
// stops the chain with a problem naming the version.
function runChain(value, from, to, steps, versionKey, what) {
  let cur = structuredClone(value);
  for (let n = from; n < to; n++) {
    const step = steps[n];
    if (typeof step !== "function") return { value: null, problem: `no upgrade from ${what} ${n} to ${n + 1} (the upgrader's chain has a gap)` };
    let next;
    try { next = step(structuredClone(cur)); } catch (e) {
      return { value: null, problem: `the upgrade from ${what} ${n} to ${n + 1} failed (${e?.message || "an error"})` };
    }
    if (!plainObject(next)) return { value: null, problem: `the upgrade from ${what} ${n} to ${n + 1} answered no record` };
    // History is kept through every step, whatever a step returns for it.
    if (versionKey === "schema" && !Array.isArray(next.history) && Array.isArray(cur.history)) next.history = cur.history;
    next[versionKey] = n + 1;
    cur = next;
  }
  return { value: cur, problem: "" };
}

// The version a raw object carries under key, or a problem: { version, problem }.
function versionOf(raw, key, current, what) {
  const v = raw[key];
  if (!Number.isInteger(v) || v < 1) return { version: null, problem: `the ${what} has no ${key} this PairBrowse knows (a whole number from 1)` };
  if (v > current) return { version: v, problem: `the ${what} is ${key} ${v}, newer than this PairBrowse reads (${current}); update PairBrowse, the file is left as it is` };
  return { version: v, problem: "" };
}

// A profile record read at any known schema: { profile, from, upgraded, problems }. profile: the
// checked record at SCHEMA_VERSION (profiles/schema.mjs checkProfile), or null with problems (one
// sentence each); from: the schema it was written in (null when unreadable); upgraded: whether a
// step ran. at: the upgrade's time for its history entry (an ISO time; the caller's clock).
// steps and current are for tests; the store passes neither. Never throws, never changes raw.
export function upgradeProfile(raw, { at, steps = RECORD_STEPS, current = SCHEMA_VERSION, check = checkProfile } = {}) {
  if (!plainObject(raw)) return { profile: null, from: null, upgraded: false, problems: ["a profile record is an object { ... }."] };
  const { version, problem } = versionOf(raw, "schema", current, "record");
  if (problem) return { profile: null, from: version, upgraded: false, problems: [`${problem}.`] };
  if (version === current) {
    const { profile, problems } = check(raw);
    return { profile, from: version, upgraded: false, problems };
  }
  const ran = runChain(raw, version, current, steps, "schema", "schema");
  if (ran.problem) return { profile: null, from: version, upgraded: false, problems: [`${ran.problem}; the file is left as it is.`] };
  const record = ran.value;
  const history = Array.isArray(record.history) ? record.history : [];
  record.history = [...history, { revision: record.revision, at: at ?? new Date().toISOString(), change: ["schema"], by: "upgrade" }].slice(-HISTORY_MAX);
  const { profile, problems } = check(record);
  if (!profile) return { profile: null, from: version, upgraded: true, problems: problems.map((p) => `after the upgrade from schema ${version}: ${p}`) };
  return { profile, from: version, upgraded: true, problems: [] };
}

// An export file's object at any known formatVersion: { file, from, upgraded, problem }. file:
// the object at FORMAT_VERSION (its profile and provenance are checked by profiles/import.mjs),
// or null with problem (a sentence). The format's name is checked here; its SHA-256 is checked
// over the file as written, before this runs. Never throws, never changes raw.
export function upgradeExport(raw, { steps = EXPORT_STEPS, current = FORMAT_VERSION } = {}) {
  if (!plainObject(raw) || raw.format !== EXPORT_FORMAT) return { file: null, from: null, upgraded: false, problem: `not a ${EXPORT_FORMAT} export (its "format" is "${EXPORT_FORMAT}").` };
  const { version, problem } = versionOf(raw, "formatVersion", current, "export");
  if (problem) return { file: null, from: version, upgraded: false, problem: `${problem}.` };
  if (version === current) return { file: structuredClone(raw), from: version, upgraded: false, problem: "" };
  const ran = runChain(raw, version, current, steps, "formatVersion", "formatVersion");
  if (ran.problem) return { file: null, from: version, upgraded: false, problem: `${ran.problem}; the file is left as it is.` };
  return { file: ran.value, from: version, upgraded: true, problem: "" };
}
