// The browser profile store (spec server-mode Phase D, D1, D4, D5): one owner-only record per
// profile in ~/.pairbrowse/browser-profiles/<id>.json (0600, the folder 0700), each earlier revision
// in <id>.history/<revision>.json, every write under one lock (install-lock.mjs's, on the folder's
// own .lock file) so the helper, the CLI and the live view never write half a record or lose a
// change: a write names the revision it read (expectRevision) and a stale one is refused.
//
// Two kinds (D5). A store profile (kind "store") is edited only here. The "default" profile (kind
// "config") is computed from config.json at each launch (profiles/map.mjs fromConfig hands its
// settings to configProfile): only its identity, revision, history, engine and validation are
// stored, never its settings, and a change in what config.json gives (configHash) bumps its
// revision with a history entry by "config".
//
// Records are read through profiles/upgrade.mjs (an older schema upgraded in memory and written at
// the next change, its file kept as that revision; a newer one refused and never rewritten) and
// checked whole by profiles/schema.mjs. A file that isn't JSON is copied aside (util.mjs
// keepCorrupt) and named, with its saved revisions offered (revert). A record is read only from a
// regular file: a link at its name is refused, never followed.
//
// Node's standard library only. Errors are plain sentences (err.code PROFILE_*), naming the
// profile by its name or id; they repeat no setting's value.
import { lstatSync, mkdirSync, chmodSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { paths } from "../paths.mjs";
import { writeJsonAtomic, keepCorrupt, sha256 } from "../util.mjs";
import { withInstallLockSync } from "../install-lock.mjs";
import { SCHEMA_VERSION, PROFILE_ID, DEFAULT_PROFILE, HISTORY_MAX, SETTINGS, checkProfile, profileDefaults, canonicalJson as canonical } from "./schema.mjs";
import { upgradeProfile } from "./upgrade.mjs";
import { validName } from "../sessions.mjs";

// What update() takes: the settings and the name. Provenance and license come with an import
// (create), engine and validation with a launch or a measurement, status with retire and restore.
const EDITABLE = new Set(["name", ...SETTINGS]);
const FILE = /^(p-[0-9a-f]{16})\.json$/;
const REVISION_FILE = /^([1-9]\d{0,8})\.json$/;
const CONFIG_HASH = /^[0-9a-f]{64}$/;
const SECTION_HASH = /^[0-9a-f]{16}$/;
const LOCK_WAIT_MS = 10_000;
// A write takes milliseconds; a lock this old was left by a process that stopped mid-write.
const LOCK_STALE_MS = 60_000;

const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const fail = (code, message) => Object.assign(new Error(message), { code });
const sameValue = (a, b) => canonical(a) === canonical(b);
// A caller's ref or session as a message may name it: an id or a plain name, else "(that name)"
// (it reaches logs and status, so a path or a line break never does).
const shown = (s) => (typeof s === "string" && (PROFILE_ID.test(s) || validName(s)) ? s : "(that name)");
// The config-backed profile's stored part without the hashes it keeps for itself.
const stripHashes = (r) => { const { configHash: _hash, sections: _sections, ...rest } = r; return rest; };

// The field paths that differ between two records' editable parts ("locale.timezone", "screen",
// "name"), at most 50 (a history entry's change list).
export function changedFields(before, after, keys = [...EDITABLE, "status"]) {
  const out = [];
  for (const k of keys) {
    const a = before?.[k], b = after?.[k];
    if (sameValue(a, b)) continue;
    if (plainObject(a) && plainObject(b)) {
      for (const sub of new Set([...Object.keys(a), ...Object.keys(b)])) if (!sameValue(a[sub], b[sub])) out.push(`${k}.${sub}`);
    } else out.push(k);
  }
  return out.slice(0, 50);
}

// The settings' hash and each section's (16 hex digits), for the config-backed profile (D5).
export function configHash(settings) {
  const sections = Object.fromEntries(SETTINGS.map((k) => [k, sha256(canonical(settings[k])).slice(0, 16)]));
  return { hash: sha256(canonical(Object.fromEntries(SETTINGS.map((k) => [k, settings[k]])))), sections };
}

// dir: the store's folder (paths.browserProfiles); now(): the time in ms; randomId(): 16 hex
// digits for a new id; assignedTo(id): the sessions using a profile (sessions.mjs, spec step 36),
// which keep it from being removed.
export function createProfileStore({ dir = paths.browserProfiles, now = Date.now, randomId = () => randomBytes(8).toString("hex"), assignedTo = () => [] } = {}) {
  const at = () => new Date(now()).toISOString();
  const recordFile = (id) => join(dir, `${id}.json`);
  const historyDir = (id) => join(dir, `${id}.history`);
  const revisionFile = (id, n) => join(historyDir(id), `${n}.json`);

  // The folder, owner-only, made when missing and tightened when an older umask widened it.
  function ensureDir() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
  }
  const locked = (fn) => {
    ensureDir();
    return withInstallLockSync(fn, { file: join(dir, ".lock"), waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS, what: "browser profile change" });
  };

  // A regular file's text, null when there is none; a link or anything else at its name is refused.
  function readText(file, label) {
    let st;
    try { st = lstatSync(file); } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
    if (!st.isFile()) throw fail("PROFILE_UNREADABLE", `${label} isn't a regular file (a link or folder at its name is never followed); remove it, then try again.`);
    return readFileSync(file, "utf8");
  }

  // The raw object in a profile's file: { raw } or null when there is none. A file that isn't JSON
  // is copied aside and refused, naming the copy and the revisions kept.
  function readRaw(id) {
    const file = recordFile(id);
    const text = readText(file, `Browser profile ${id}'s file`);
    if (text === null) return null;
    try { return { raw: JSON.parse(text) }; } catch {
      keepCorrupt(file, text);
      const saved = revisionsOf(id);
      throw fail("PROFILE_CORRUPT", `Browser profile ${id}'s file isn't valid JSON; what it held is kept beside it as ${id}.json.corrupt. ${saved.length ? `Its saved revisions (${saved.join(", ")}) can be put back with revert.` : "It has no saved revision to put back."}`);
    }
  }

  // The config-backed profile's stored part (D5): identity, revision, history, engine, validation,
  // and the hash of the settings config.json last gave. Checked as a record with neutral settings.
  function stubProblems(raw) {
    if (!plainObject(raw)) return ["the record is an object { ... }."];
    const { configHash: hash, sections, ...rest } = raw;
    const problems = [];
    if (typeof hash !== "string" || !CONFIG_HASH.test(hash)) problems.push("configHash is 64 hex digits.");
    if (!plainObject(sections) || Object.keys(sections).length !== SETTINGS.length || !SETTINGS.every((k) => typeof sections[k] === "string" && SECTION_HASH.test(sections[k]))) {
      problems.push("sections holds each setting's hash (16 hex digits).");
    }
    const stray = SETTINGS.filter((k) => Object.hasOwn(rest, k));
    if (stray.length) problems.push(`the config-backed profile keeps no settings of its own (${stray.join(", ")}); they come from config.json.`);
    else {
      const { problems: more } = upgradeProfile({ ...rest, ...profileDefaults(), validation: rest.validation, history: rest.history }, { at: at() });
      problems.push(...more);
    }
    return problems;
  }

  // One profile by id, checked (upgraded when older): { kind: "store", profile } or { kind:
  // "config", stub }, null when there is none. Throws PROFILE_CORRUPT or PROFILE_INVALID, naming id.
  function load(id) {
    const read = readRaw(id);
    if (!read) return null;
    const { raw } = read;
    if (plainObject(raw) && raw.kind === "config") {
      const problems = stubProblems(raw);
      // A newer stub is refused as newer (never rewritten, D19), not as invalid.
      const newer = Number.isInteger(raw.schema) && raw.schema > SCHEMA_VERSION && problems.find((p) => /newer than this PairBrowse/.test(p));
      if (newer) throw fail("PROFILE_NEWER", `Browser profile ${id} (the config-backed "${DEFAULT_PROFILE}") can't be used: ${newer}`);
      if (problems.length || raw.id !== id) throw fail("PROFILE_INVALID", `Browser profile ${id} (the config-backed "${DEFAULT_PROFILE}") can't be used: ${raw.id !== id ? "its id isn't its file's name." : problems[0]}`);
      return { kind: "config", stub: structuredClone(raw) };
    }
    const { profile, problems } = upgradeProfile(raw, { at: at() });
    if (!profile) throw fail(/newer than this PairBrowse/.test(problems[0]) ? "PROFILE_NEWER" : "PROFILE_INVALID", `Browser profile ${id} can't be used: ${problems[0]}`);
    if (profile.id !== id) throw fail("PROFILE_INVALID", `Browser profile ${id} can't be used: its id isn't its file's name.`);
    return { kind: "store", profile };
  }

  const ids = () => {
    try { return readdirSync(dir).map((n) => FILE.exec(n)?.[1]).filter(Boolean).sort(); } catch (e) { if (e?.code === "ENOENT") return []; throw e; }
  };
  function revisionsOf(id) {
    try { return readdirSync(historyDir(id)).map((n) => Number(REVISION_FILE.exec(n)?.[1])).filter(Boolean).sort((a, b) => a - b); } catch { return []; }
  }

  // Every readable record: [{ id, kind, profile | stub }]; ones that can't be read: [{ id, problem }].
  function scan() {
    const ok = [], bad = [];
    for (const id of ids()) {
      try { const r = load(id); if (r) ok.push({ id, ...r }); } catch (e) { bad.push({ id, problem: e.message, code: e.code }); }
    }
    return { ok, bad };
  }
  // The kind a file's raw JSON names ("config", "store"), null when it can't be read as JSON.
  function rawKind(id) {
    try {
      const raw = JSON.parse(readText(recordFile(id), `Browser profile ${id}'s file`));
      return plainObject(raw) ? raw.kind : null;
    } catch { return null; }
  }
  const nameOf = (r) => (r.kind === "config" ? DEFAULT_PROFILE : r.profile.name);

  // A profile by its id or name (names case-insensitively): the loaded entry, or a PROFILE_UNKNOWN
  // refusal naming ref. An id whose file can't be read throws that file's problem.
  function find(ref) {
    if (typeof ref !== "string" || !ref) throw fail("PROFILE_UNKNOWN", "Name a browser profile by its name or id.");
    if (PROFILE_ID.test(ref)) {
      const r = load(ref);
      if (r) return { id: ref, ...r };
    } else {
      const { ok } = scan();
      const hit = ok.find((r) => nameOf(r).toLowerCase() === ref.toLowerCase());
      if (hit) return hit;
    }
    throw fail("PROFILE_UNKNOWN", `There is no browser profile "${shown(ref)}".`);
  }
  const storeOnly = (r, doing) => {
    if (r.kind === "config") throw fail("PROFILE_CONFIG", `The "${DEFAULT_PROFILE}" profile comes from config.json and can't be ${doing}; change config.json instead.`);
    return r.profile;
  };
  const checkRevision = (p, expectRevision) => {
    if (expectRevision !== undefined && expectRevision !== p.revision) {
      throw fail("PROFILE_STALE", `Browser profile "${p.name}" changed meanwhile (it is at revision ${p.revision}, not ${expectRevision}); read it again and redo the change.`);
    }
  };
  // A name no other profile (any status, either kind) uses, case-insensitively, and not shaped
  // like an id (find would read it as one, so the profile could never be reached by its name).
  function checkNameFree(name, exceptId) {
    if (typeof name !== "string") return;
    if (name.toLowerCase() === DEFAULT_PROFILE) throw fail("PROFILE_NAME", `"${name}" is the config-backed profile's name; choose another.`);
    if (PROFILE_ID.test(name)) throw fail("PROFILE_NAME", `"${name}" looks like a profile id; choose another.`);
    const taken = scan().ok.find((r) => r.id !== exceptId && nameOf(r).toLowerCase() === name.toLowerCase());
    if (taken) throw fail("PROFILE_NAME", `A browser profile named "${nameOf(taken)}" exists already; choose another name.`);
  }
  const checked = (record, doing) => {
    const { profile, problems } = checkProfile(record);
    if (!profile) throw fail("PROFILE_INVALID", `The browser profile wasn't ${doing}: ${problems.join(" ")}`);
    return profile;
  };

  // Writes a store record as its next revision: the current file (as read, any schema) kept as its
  // revision first, then the new one in its place; revision files past HISTORY_MAX pruned.
  function writeNext(prev, next) {
    const prevText = prev ? readText(recordFile(prev.id), `Browser profile ${prev.id}'s file`) : null;
    if (prevText !== null) {
      mkdirSync(historyDir(prev.id), { recursive: true, mode: 0o700 });
      // The file as it was, byte for byte (an older schema stays readable as that revision).
      let raw;
      try { raw = JSON.parse(prevText); } catch { raw = null; }
      if (raw) writeJsonAtomic(revisionFile(prev.id, prev.revision), raw, { mode: 0o600 });
    }
    writeJsonAtomic(recordFile(next.id), next, { mode: 0o600 });
    for (const n of revisionsOf(next.id)) if (n <= next.revision - HISTORY_MAX) rmSync(revisionFile(next.id, n), { force: true });
    return structuredClone(next);
  }
  const withEntry = (p, change, by) => [...p.history, { revision: p.revision + 1, at: at(), change, by }].slice(-HISTORY_MAX);

  // { profile } settings changed into p as the next revision, or p unchanged when nothing differs.
  function bump(p, after, by, doing) {
    const change = changedFields(p, after);
    if (!change.length) return structuredClone(p);
    const next = checked({ ...after, schema: SCHEMA_VERSION, revision: p.revision + 1, history: withEntry(p, change, by) }, doing);
    return writeNext(p, next);
  }

  const api = {
    dir,

    // Every profile, the config-backed one first, then by name: { id, name, kind, revision,
    // status, created, engine } each, and { id, problem } for a file that can't be read.
    list() {
      const { ok, bad } = scan();
      const rows = ok.map((r) => {
        const p = r.kind === "config" ? r.stub : r.profile;
        return { id: r.id, name: nameOf(r), kind: r.kind, revision: p.revision, status: p.status, created: p.created, engine: p.engine };
      }).sort((a, b) => (a.kind === "config" ? -1 : b.kind === "config" ? 1 : a.name.localeCompare(b.name)));
      return [...rows, ...bad.map(({ id, problem }) => ({ id, problem }))];
    },

    // One store profile's record by id or name (a copy). The config-backed one's settings live in
    // config.json: configProfile gives its whole record.
    get(ref) {
      const r = find(ref);
      if (r.kind === "config") return { ...stripHashes(structuredClone(r.stub)), settings: "config.json" };
      return structuredClone(r.profile);
    },

    // A profile a session may be assigned or launched on (D13 and the launch, spec steps 36 and 37):
    // its whole record; unknown, retired or unreadable refused by name, never falling back to
    // "default". session: named in the refusal. configSettings: what config.json gives the
    // config-backed default now (profiles/map.mjs fromConfig), which answers its whole record
    // through configProfile; without it the default answers only its stored part, marked
    // settings: "config.json" like get's, which is no record to launch (checkProfile refuses it).
    use(ref, { session, configSettings } = {}) {
      const who = session ? `Session "${shown(session)}" uses browser profile "${shown(ref)}"` : `Browser profile "${shown(ref)}"`;
      let r;
      try { r = find(ref); } catch (e) {
        // The config-backed default is made from configSettings the first time it is asked for.
        const firstDefault = e.code === "PROFILE_UNKNOWN" && configSettings !== undefined && typeof ref === "string" && ref.toLowerCase() === DEFAULT_PROFILE;
        if (!firstDefault) throw fail(e.code, e.code === "PROFILE_UNKNOWN" ? `${who}, which doesn't exist (it was removed, or never made); assign the session another profile.` : `${who}: ${e.message}`);
        r = { kind: "config" };
      }
      if (r.kind === "config") {
        if (configSettings === undefined) return { ...stripHashes(structuredClone(r.stub)), settings: "config.json" };
        try { return api.configProfile(configSettings); } catch (e) { throw fail(e.code, `${who}: ${e.message}`); }
      }
      if (r.profile.status === "retired") throw fail("PROFILE_RETIRED", `${who}, which is retired; restore it, or assign the session another profile.`);
      return structuredClone(r.profile);
    },

    // A new store profile from settings (each one left out takes profileDefaults'), with a name no
    // other profile has. provenance and license: an import's (profiles/import.mjs). Revision 1.
    create(fields = {}, { by = "person" } = {}) {
      if (!plainObject(fields)) throw fail("PROFILE_INVALID", "A browser profile's settings are an object { ... }.");
      const allowed = new Set([...EDITABLE, "provenance", "license"]);
      const stray = Object.keys(fields).filter((k) => !allowed.has(k));
      if (stray.length) throw fail("PROFILE_INVALID", `The browser profile wasn't made: ${stray.length === 1 ? "a key" : "keys"} the store sets or a profile can't hold (${stray.filter((k) => /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k)).join(", ") || "unnamed"}).`);
      return locked(() => {
        checkNameFree(fields.name);
        let id;
        do id = `p-${String(randomId()).toLowerCase()}`; while (PROFILE_ID.test(id) && load(id));
        const record = { schema: SCHEMA_VERSION, id, name: fields.name, kind: "store", revision: 1, status: "active", created: at(), engine: null, ...profileDefaults(), ...structuredClone(fields), validation: {}, history: [] };
        if (by !== "person") record.history = [{ revision: 1, at: record.created, change: changedFields(profileDefaults(), record, SETTINGS), by }];
        return writeNext(null, checked(record, "made"));
      });
    },

    // Changes settings and the name of a store profile: each object setting merged one level deep
    // (null replaces it whole). expectRevision: the revision the change was made on; another
    // refuses (PROFILE_STALE). The result is the next revision, or the record unchanged when nothing
    // differs. The id never changes, a rename included.
    update(ref, fields, { expectRevision, by = "person" } = {}) {
      if (!plainObject(fields)) throw fail("PROFILE_INVALID", "A browser profile's changes are an object { ... }.");
      const stray = Object.keys(fields).filter((k) => !EDITABLE.has(k));
      if (stray.length) {
        const named = stray.filter((k) => /^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k));
        throw fail("PROFILE_INVALID", `The browser profile wasn't changed: ${named.length ? named.join(", ") : "those keys"} can't be changed here (only its name and settings: ${SETTINGS.join(", ")}).`);
      }
      return locked(() => {
        const p = storeOnly(find(ref), "edited here");
        checkRevision(p, expectRevision);
        if (fields.name !== undefined && fields.name !== p.name) checkNameFree(fields.name, p.id);
        const after = structuredClone(p);
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined) continue;
          after[k] = plainObject(v) && plainObject(p[k]) ? { ...p[k], ...structuredClone(v) } : structuredClone(v);
        }
        return bump(p, after, by, "changed");
      });
    },

    // Retired: kept, listed, never assigned or launched (use refuses) until restored.
    retire(ref, { expectRevision } = {}) {
      return locked(() => {
        const p = storeOnly(find(ref), "retired");
        checkRevision(p, expectRevision);
        return bump(p, { ...p, status: "retired" }, "person", "retired");
      });
    },
    restore(ref, { expectRevision } = {}) {
      return locked(() => {
        const p = storeOnly(find(ref), "restored");
        checkRevision(p, expectRevision);
        return bump(p, { ...p, status: "active" }, "person", "restored");
      });
    },

    // Deletes a store profile and its saved revisions; refused while any session is assigned it
    // (naming them). Returns { id, name }.
    remove(ref) {
      return locked(() => {
        let r;
        try { r = find(ref); } catch (e) {
          // A file that can't be read can still be removed by its id.
          if (e.code === "PROFILE_UNKNOWN" || !PROFILE_ID.test(ref)) throw e;
          r = { id: ref, kind: "store", profile: { id: ref, name: ref } };
        }
        const p = storeOnly(r, "removed");
        const sessions = [...(assignedTo(p.id) || [])];
        if (sessions.length) throw fail("PROFILE_ASSIGNED", `Browser profile "${p.name}" wasn't removed: ${sessions.length === 1 ? "session" : "sessions"} ${sessions.map((s) => `"${s}"`).join(", ")} ${sessions.length === 1 ? "uses" : "use"} it; assign ${sessions.length === 1 ? "it" : "them"} another profile first, or retire it.`);
        rmSync(recordFile(p.id), { force: true });
        rmSync(historyDir(p.id), { recursive: true, force: true });
        return { id: p.id, name: p.name };
      });
    },

    // The revisions kept for a profile (by id or name; by id also when its file can't be read).
    revisions(ref) {
      if (PROFILE_ID.test(ref)) return revisionsOf(ref);
      return revisionsOf(find(ref).id);
    },
    // One kept revision's record, upgraded and checked (a copy).
    revision(ref, n) {
      const id = PROFILE_ID.test(ref) ? ref : find(ref).id;
      if (!Number.isInteger(n) || !revisionsOf(id).includes(n)) throw fail("PROFILE_UNKNOWN", `Browser profile ${id} has no saved revision ${n}.`);
      let raw;
      try { raw = JSON.parse(readText(revisionFile(id, n), `Revision ${n} of browser profile ${id}`)); } catch (e) {
        throw e?.code ? e : fail("PROFILE_CORRUPT", `Revision ${n} of browser profile ${id} isn't valid JSON.`);
      }
      const { profile, problems } = upgradeProfile(raw, { at: at() });
      if (!profile) throw fail("PROFILE_INVALID", `Revision ${n} of browser profile ${id} can't be used: ${problems[0]}`);
      return profile;
    },

    // Puts a kept revision's name and settings back as the next revision (also when the current
    // file couldn't be read: it was copied aside, and this writes a new one after the highest
    // revision known).
    revert(id, n, { expectRevision } = {}) {
      if (!PROFILE_ID.test(id)) id = find(id).id;
      return locked(() => {
        const old = api.revision(id, n);
        let current = null;
        try {
          const r = load(id);
          if (r) current = storeOnly(r, "reverted");
        } catch (e) { if (e.code !== "PROFILE_CORRUPT" && e.code !== "PROFILE_INVALID") throw e; }
        // The name comes back only when no other profile took it meanwhile.
        if (!current || old.name.toLowerCase() !== current.name.toLowerCase()) checkNameFree(old.name, id);
        if (current) {
          checkRevision(current, expectRevision);
          return bump(current, { ...current, ...Object.fromEntries([...EDITABLE].map((k) => [k, old[k]])) }, "person", "reverted");
        }
        // The file that couldn't be used is kept aside before the revision takes its place (a file
        // that wasn't JSON was copied when it was read).
        const text = readText(recordFile(id), `Browser profile ${id}'s file`);
        let lost = null;
        if (text !== null) {
          keepCorrupt(recordFile(id), text);
          try { const v = JSON.parse(text)?.revision; if (Number.isInteger(v) && v > 0) lost = v; } catch { /* not JSON: its revision is unknown */ }
        }
        // Above the revision that was lost, so a writer still holding it is refused as stale: its
        // own number when the file parsed, else two past the highest kept (the current file always
        // sat above every kept revision).
        const top = Math.max(n, ...revisionsOf(id));
        const revision = lost !== null ? Math.max(top, lost) + 1 : top + 2;
        const next = checked({ ...old, revision, history: [...old.history, { revision, at: at(), change: [...EDITABLE], by: "person" }].slice(-HISTORY_MAX) }, "reverted");
        return writeNext(null, next);
      });
    },

    // What a launch on the native build found (D10, E8; daemon/sessions/profiles.mjs): engine, the
    // { major, build } it first ran on, set once (null before); entry, the launch's own
    // validation[build] ({ status: "unverified", at, pack, items }). Evidence, not settings: no new
    // revision, no history entry. An entry with measured evidence (validated or failed, or any
    // holding a measurement) is left as it is, and one whose status, pack and items are the same
    // isn't written again (its at stays the first launch's). replaceMeasured: the measured entry is
    // of another runtime (its graphics, driver, display or switches changed: daemon/browser/
    // graphics.mjs), so this launch's entry, without a measurement, replaces it and the next start
    // measures again. A record of an older schema is left for its next change (writeNext keeps its
    // file). Returns whether anything was written.
    recordLaunch(id, { engine = null, build, entry = null, replaceMeasured = false } = {}) {
      return locked(() => {
        const read = readRaw(id);
        if (!read) throw fail("PROFILE_UNKNOWN", `There is no browser profile "${shown(id)}".`);
        if (!plainObject(read.raw) || read.raw.schema !== SCHEMA_VERSION) return false;
        const r = load(id);
        const before = r.kind === "config" ? r.stub : r.profile;
        const next = structuredClone(before);
        if (engine && !before.engine) next.engine = { major: engine.major, build: engine.build };
        const prior = before.validation?.[build];
        const same = (a, b) => sameValue({ status: a.status, pack: a.pack, items: a.items }, { status: b.status, pack: b.pack, items: b.items });
        const measured = !!prior && (prior.status !== "unverified" || plainObject(prior.graphics));
        const replace = !!entry && (!prior || (measured ? replaceMeasured && !plainObject(entry.graphics) : !same(prior, entry)));
        if (entry && typeof build === "string" && replace) next.validation = { ...before.validation, [build]: structuredClone(entry) };
        if (sameValue(next, before)) return false;
        if (r.kind === "config") {
          const problems = stubProblems(next);
          if (problems.length) throw fail("PROFILE_INVALID", `Browser profile ${id} (the config-backed "${DEFAULT_PROFILE}") wasn't updated: ${problems[0]}`);
        } else checked(next, "updated");
        writeJsonAtomic(recordFile(id), next, { mode: 0o600 });
        return true;
      });
    },

    // A measurement's verdict (E6, E8; native/validate.mjs validate's entry, spec step 40): entry,
    // with its runtimeKey and graphics (the measured record), becomes validation[build] in place of
    // whatever was there (a launch's unverified entry, an older measurement). Evidence, not
    // settings: no new revision, no history entry, and the profile's graphics request stays as it
    // is. An entry without a measurement is a launch's (recordLaunch). A record of an older schema
    // is refused (it is upgraded at its next change first). Returns whether anything was written.
    recordValidation(id, { build, entry } = {}) {
      if (typeof build !== "string" || !/^\d{1,4}(?:\.\d{1,6}){3}$/.test(build)) throw fail("PROFILE_INVALID", "A measurement is kept under a build like \"155.0.8059.84\".");
      if (!plainObject(entry) || !plainObject(entry.graphics) || typeof entry.runtimeKey !== "string") throw fail("PROFILE_INVALID", "A measurement's entry carries its runtimeKey and graphics; a launch's own entry is kept by recordLaunch.");
      return locked(() => {
        const read = readRaw(id);
        if (!read) throw fail("PROFILE_UNKNOWN", `There is no browser profile "${shown(id)}".`);
        if (!plainObject(read.raw) || read.raw.schema !== SCHEMA_VERSION) throw fail("PROFILE_INVALID", `Browser profile ${id} has an older record; change any setting first so it is written in this version's form.`);
        const r = load(id);
        const before = r.kind === "config" ? r.stub : r.profile;
        const next = { ...structuredClone(before), validation: { ...before.validation, [build]: structuredClone(entry) } };
        if (sameValue(next, before)) return false;
        if (r.kind === "config") {
          const problems = stubProblems(next);
          if (problems.length) throw fail("PROFILE_INVALID", `Browser profile ${id} (the config-backed "${DEFAULT_PROFILE}") wasn't updated: ${problems[0]}`);
        } else checked(next, "updated");
        writeJsonAtomic(recordFile(id), next, { mode: 0o600 });
        return true;
      });
    },

    // The person's check of a profile on another build (D10, spec step 38: cli.mjs validate, the
    // sessions page): engine, the { major, build } it is held to from now, replaces the one it was
    // made on, and entry ({ status: "unverified", at, pack, items }) becomes validation[build] unless
    // that build has measured evidence (validated or failed), kept as it is. Evidence, not settings:
    // no new revision, but a history entry at the current revision naming "engine", by the person
    // (by "config": a launch holding the config-backed default to a new major, daemon/sessions/
    // profiles.mjs). A record of an older schema is refused (it is upgraded at its next change
    // first). Returns the record as written (the config-backed one's stored part).
    repin(id, { engine, build, entry, by = "person" }) {
      if (!plainObject(engine) || typeof engine.major !== "string" || typeof engine.build !== "string") throw fail("PROFILE_INVALID", "A profile is held to an engine { major, build }.");
      if (by !== "person" && by !== "config") throw fail("PROFILE_INVALID", "A profile's engine is changed by the person, or by config for the config-backed default.");
      return locked(() => {
        const read = readRaw(id);
        if (!read) throw fail("PROFILE_UNKNOWN", `There is no browser profile "${shown(id)}".`);
        if (!plainObject(read.raw) || read.raw.schema !== SCHEMA_VERSION) throw fail("PROFILE_INVALID", `Browser profile ${id} has an older record; change any setting first so it is written in this version's form.`);
        const r = load(id);
        const before = r.kind === "config" ? r.stub : r.profile;
        const next = structuredClone(before);
        next.engine = { major: engine.major, build: engine.build };
        const prior = before.validation?.[build];
        if (entry && typeof build === "string" && !(prior && prior.status !== "unverified")) next.validation = { ...before.validation, [build]: structuredClone(entry) };
        if (!sameValue(before.engine, next.engine)) next.history = [...before.history, { revision: before.revision, at: at(), change: ["engine"], by }].slice(-HISTORY_MAX);
        if (sameValue(next, before)) return structuredClone(before);
        if (r.kind === "config") {
          const problems = stubProblems(next);
          if (problems.length) throw fail("PROFILE_INVALID", `Browser profile ${id} (the config-backed "${DEFAULT_PROFILE}") wasn't updated: ${problems[0]}`);
        } else checked(next, "updated");
        writeJsonAtomic(recordFile(id), next, { mode: 0o600 });
        return structuredClone(next);
      });
    },

    // The config-backed "default" profile's whole record (D5) from the settings config.json gives
    // now (profiles/map.mjs fromConfig; any setting left out takes profileDefaults'): its stored id,
    // revision, history, engine and validation with these settings. Made at revision 1 the first
    // time; a change in the settings' hash bumps the revision, naming the sections that changed,
    // by "config". The settings are checked as a record's are; a problem refuses (PROFILE_INVALID).
    configProfile(settings = {}) {
      if (!plainObject(settings)) throw fail("PROFILE_INVALID", "The default profile's settings are an object { ... }.");
      const stray = Object.keys(settings).filter((k) => !SETTINGS.includes(k));
      if (stray.length) throw fail("PROFILE_INVALID", `The default profile's settings hold only ${SETTINGS.join(", ")}.`);
      const fields = { ...profileDefaults(), ...structuredClone(settings) };
      const values = Object.fromEntries(SETTINGS.map((k) => [k, fields[k]]));
      const { hash, sections } = configHash(values);
      const whole = (stub) => checked({ ...stripHashes(stub), ...values, license: "own-capture", provenance: [] }, "read from config.json");
      return locked(() => {
        const { ok, bad } = scan();
        let stub = ok.find((r) => r.kind === "config")?.stub;
        if (!stub) {
          // A default that exists but can't be used is refused by its file, never replaced by a
          // second one (that would drop its id, history and sessions, and rewrite a newer home).
          const blocking = bad.find((b) => b.code === "PROFILE_CORRUPT" || b.code === "PROFILE_UNREADABLE" || rawKind(b.id) === "config");
          if (blocking) throw fail(blocking.code || "PROFILE_INVALID", `The config-backed "${DEFAULT_PROFILE}" profile wasn't read: ${blocking.id}.json in the browser profiles folder ${blocking.code === "PROFILE_CORRUPT" || blocking.code === "PROFILE_UNREADABLE" ? "can't be read and may be it" : "is it but can't be used"}. ${blocking.problem} Fix or remove that file, then try again.`);
          let id;
          do id = `p-${String(randomId()).toLowerCase()}`; while (PROFILE_ID.test(id) && load(id));
          stub = { schema: SCHEMA_VERSION, id, name: DEFAULT_PROFILE, kind: "config", revision: 1, status: "active", created: at(), engine: null, validation: {}, history: [], configHash: hash, sections };
          const record = whole(stub);
          writeJsonAtomic(recordFile(id), stub, { mode: 0o600 });
          return record;
        }
        if (stub.configHash !== hash) {
          const change = SETTINGS.filter((k) => stub.sections?.[k] !== sections[k]);
          const revision = stub.revision + 1;
          const next = { ...stub, revision, history: [...stub.history, { revision, at: at(), change: change.length ? change : [...SETTINGS], by: "config" }].slice(-HISTORY_MAX), configHash: hash, sections };
          const record = whole(next);
          writeJsonAtomic(recordFile(stub.id), next, { mode: 0o600 });
          return record;
        }
        return whole(stub);
      });
    },
  };
  return api;
}
