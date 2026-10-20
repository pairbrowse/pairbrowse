// The first-start migration to browser profiles, and its undo (spec server-mode Phase D
// "Migration", D4, D5, D13). It runs once per home, before the first launch, under its own lock
// (paths.profileMigrationLock; the helper's single-helper lock holds as well when the helper runs
// it): daemon/sessions/profiles.mjs calls ensureMigrated at the first launch, and the person can run
// it (and undo it) with `node scripts/profiles/cli.mjs migrate [--undo]`.
//
//  1. A report (migrationReport): the `default` profile config.json gives (profiles/map.mjs
//     readConfig: what it reads and every key it doesn't), every kept session with its assignment,
//     binding and persona, and a saved persona or fingerprintProfile config.json names (offered for
//     import, checked as a dry run; read in place as before until the person imports it).
//  2. browser-profiles/ and engine-profiles/ (0700); ~/.pairbrowse-engine copied into
//     engine-profiles/ (never moved or changed; links inside it are not copied; a note in
//     engine-profiles/ says where it came from); the `default` record stored (its settings stay in
//     config.json).
//  3. Each kept session: assignment.json naming `default` (one assigned already keeps its own), its
//     binding written where its folder exists and has none, and a persona named "pairbrowse" (the
//     name before profiles) renamed to the default's id.
//  4. browser-profiles/migration.json: what was done, with each file as it was before (for the
//     undo), and the items not carried into the default profile, which the status line names until
//     the person dismisses them (`cli.mjs migrate --dismiss`).
// A step that fails puts back everything done so far, and the launch runs on as before profiles
// (step 37's path: an unassigned session is the default's) with a warning; the next helper start
// tries again. config.json is never rewritten.
//
// From a finished migration on, the engine pack keeps its personas, imports and cache in
// engine-profiles/ (engineEnv: PAIRBROWSE_ENGINE_PROFILE_DIR, an empty owned
// PAIRBROWSE_ENGINE_PROFILE_SOURCE, PAIRBROWSE_ENGINE_CACHE, set in the helper's own process before
// the pack loads).
//
// The undo (undoMigration) exports every store profile to ~/.pairbrowse/profile-exports/ first
// (with its history and pinned seed: nothing is lost), then puts each session's assignment,
// binding and persona back as the migration found them (byte for byte where the migration's own
// file is still there; else the new files removed and a persona of the default renamed back to
// "pairbrowse", one of another profile removed, so its seed never becomes the default's), and
// removes browser-profiles/ and engine-profiles/. Refused while a helper runs on this home.
//
// Node's standard library only.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.mjs";
import { readJson, writeJsonAtomic, pidAlive } from "../util.mjs";
import { withInstallLockSync } from "../install-lock.mjs";
import { listSessions, readAssignment, readBinding, writeBinding, assignmentFile, bindingFile, personaFile, personaNameOf, profileDir, LEGACY_PERSONA, validName } from "../sessions.mjs";
import { readConfig } from "./map.mjs";
import { PROFILE_ID, DEFAULT_PROFILE } from "./schema.mjs";
import { checkImport, readImportFile } from "./import.mjs";
import { exportToFile } from "./export.mjs";
import { cliCommand } from "./validate.mjs";

export const MIGRATION_SCHEMA = 1;
const ENGINE_NOTE = "COPIED-FROM.txt";
const LOCK_WAIT_MS = 10_000;
// Statuses of report items that say a value wasn't carried into the default profile.
const NOT_CARRIED = new Set(["unsupported", "not-applied"]);
const PERSONA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const fail = (code, message) => Object.assign(new Error(message), { code });
const b64 = (file) => { try { return lstatSync(file).isFile() ? readFileSync(file).toString("base64") : null; } catch { return null; } };
const textOf = (file) => { try { return lstatSync(file).isFile() ? readFileSync(file, "utf8") : null; } catch { return null; } };
// A persona file as the engine pack writes it (its Profile.save).
const personaText = (raw) => `${JSON.stringify(raw, null, 2)}\n`;

// Where the engine pack keeps its personas, imports and cache once the home is migrated (D4).
export function engineEnv(engineDir = paths.engineProfiles) {
  return {
    PAIRBROWSE_ENGINE_PROFILE_DIR: join(engineDir, "profiles"),
    PAIRBROWSE_ENGINE_PROFILE_SOURCE: join(engineDir, "source"),
    PAIRBROWSE_ENGINE_CACHE: join(engineDir, "cache"),
  };
}
// Makes the three folders (0700; the source folder empty and owned: the pack imports nothing from
// elsewhere) and sets them in env (the helper's own process.env) before the engine pack loads.
export function applyEngineEnv({ engineDir = paths.engineProfiles, env = process.env } = {}) {
  const want = engineEnv(engineDir);
  for (const dir of [engineDir, ...Object.values(want)]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700);
  }
  Object.assign(env, want);
  return want;
}

// The migration's record: { schema, status: "done", at, defaultId, items, sessions, engine,
// dismissed }, or null when the home was never migrated (or the record can't be read).
export function readMigration(file = paths.profileMigration) {
  const raw = readJson(file);
  return raw && typeof raw === "object" && raw.schema === MIGRATION_SCHEMA && raw.status === "done" ? raw : null;
}

// What a migration would do, read only: { default: { settings, items }, sessions, offered, legacyEngine }.
// config: config.json as loaded; native: a native build is chosen or pinned here (map.mjs).
export function migrationReport({ config = {}, native = false, platform = process.platform, legacyEngine = paths.legacyEngine } = {}) {
  const { settings, items } = readConfig(config, { native, platform });
  const sessions = listSessions().filter((s) => !s.temporary).map(({ name }) => {
    const a = readAssignment(name), b = readBinding(name), persona = personaNameOf(name);
    return {
      name, assigned: a.profileId, bound: b.profileId, problem: a.problem || b.problem || null,
      persona: persona === undefined ? null : persona === LEGACY_PERSONA || (typeof persona === "string" && PROFILE_ID.test(persona)) ? persona : "(unnamed)",
    };
  });
  const offered = [];
  const block = config?.pairbrowse && typeof config.pairbrowse === "object" ? config.pairbrowse : {};
  if (typeof block.profile === "string" && !["auto", "local"].includes(block.profile)) {
    const named = PERSONA_NAME.test(block.profile) && !block.profile.endsWith(".json");
    const file = named ? join(legacyEngine, "profiles", `${block.profile}.json`) : null;
    let check = null;
    if (file && existsSync(file)) {
      try { check = checkImport(readImportFile(file), { file, source: `saved persona "${block.profile}" (config.json pairbrowse.profile)`, license: "unknown" }); } catch (e) { check = { ok: false, problem: e.message }; }
    }
    offered.push({ field: "pairbrowse.profile", what: named ? `the saved persona "${block.profile}"` : "a saved persona given by its path", file,
      dryRun: check ? { ok: check.ok, problem: check.problem || null, unsupported: (check.items || []).filter((i) => i.status === "unsupported").map((i) => i.field) } : null });
  }
  if (block.fingerprintProfile !== undefined) offered.push({ field: "pairbrowse.fingerprintProfile", what: "a device profile config.json names", file: null, dryRun: null });
  let legacy = false;
  try { legacy = lstatSync(legacyEngine).isDirectory(); } catch {}
  return { default: { settings, items }, sessions, offered, legacyEngine: legacy ? legacyEngine : null };
}

// The report's items as the status line and the record name them: not carried into the default
// profile (unsupported, not-applied) and the files offered for import.
export function notCarried(report) {
  const fields = report.default.items.filter((i) => NOT_CARRIED.has(i.status)).map((i) => i.field);
  return [...new Set([...fields, ...report.offered.map((o) => o.field)])];
}

// Runs the migration (steps 2 to 4) after its report, unless the home is migrated already.
// store: profiles/store.mjs createProfileStore's (its dir is where the record goes); configSettings:
// fromConfig(config) for the default. Returns { ran, record, report }; throws (err.code
// PROFILE_MIGRATION) after putting back what it did. failAt: tests stop it at a step.
export function migrate({ config = {}, native = false, platform = process.platform, store, file = paths.profileMigration, engineDir = paths.engineProfiles,
  legacyEngine = paths.legacyEngine, now = Date.now, failAt = null } = {}) {
  const already = readMigration(file);
  if (already) return { ran: false, record: already, report: null };
  if (typeof store?.configProfile !== "function") throw fail("PROFILE_MIGRATION", "The migration needs the profile store.");
  const report = migrationReport({ config, native, platform, legacyEngine });
  const undo = [];
  const step = (name) => { if (failAt === name) throw new Error(`stopped at ${name} (test)`); };
  try {
    // 2. The folders, the engine pack's copy, the default's record.
    mkdirSync(store.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(store.dir, 0o700);
    const engineMade = !existsSync(engineDir);
    mkdirSync(engineDir, { recursive: true, mode: 0o700 });
    if (engineMade) undo.push(() => rmSync(engineDir, { recursive: true, force: true }));
    if (process.platform !== "win32") chmodSync(engineDir, 0o700);
    let copied = false;
    if (report.legacyEngine) {
      step("engine");
      // Links inside are skipped (never followed out of the folder); files already there stay.
      cpSync(report.legacyEngine, engineDir, { recursive: true, force: false, errorOnExist: false, filter: (src) => { try { return !lstatSync(src).isSymbolicLink(); } catch { return false; } } });
      writeFileSync(join(engineDir, ENGINE_NOTE), `Copied from ${report.legacyEngine} on ${new Date(now()).toISOString()} by the PairBrowse profile migration.\nThe original is left as it was; PairBrowse uses this copy from now on.\n`, { mode: 0o600 });
      copied = true;
    }
    step("default");
    const defaultsBefore = store.list().map((r) => r.id);
    const record = store.configProfile(report.default.settings);
    if (!defaultsBefore.includes(record.id)) undo.push(() => rmSync(join(store.dir, `${record.id}.json`), { force: true }));

    // 3. Each kept session on the default (one assigned already keeps its profile).
    const sessions = [];
    for (const s of report.sessions) {
      step(`session:${s.name}`);
      if (s.problem) { sessions.push({ name: s.name, skipped: s.problem }); continue; }
      const entry = { name: s.name, assignment: null, binding: null, persona: null };
      if (!s.assigned) {
        const at = assignmentFile(s.name);
        const before = b64(at);
        writeJsonAtomic(at, { profileId: record.id }, { mode: 0o600 });
        entry.assignment = { before, after: textOf(at) };
        undo.push(() => putBack(at, before));
      }
      const onDefault = !s.assigned || s.assigned === record.id;
      if (onDefault && !s.bound && existsSync(profileDir(s.name))) {
        const at = bindingFile(s.name);
        writeBinding(s.name, record.id, now());
        entry.binding = { before: null, after: textOf(at) };
        undo.push(() => rmSync(at, { force: true }));
      }
      if (onDefault && s.persona === LEGACY_PERSONA) {
        const at = personaFile(s.name);
        const before = b64(at);
        const raw = JSON.parse(readFileSync(at, "utf8"));
        writeFileSync(at, personaText({ ...raw, name: record.id }), { mode: 0o600 });
        entry.persona = { before, after: textOf(at) };
        undo.push(() => putBack(at, before));
      }
      sessions.push(entry);
    }

    // 4. The record (written last: a home is migrated once it is there).
    step("record");
    const done = {
      schema: MIGRATION_SCHEMA, status: "done", at: new Date(now()).toISOString(), defaultId: record.id,
      items: report.default.items, offered: report.offered, notCarried: notCarried(report), sessions,
      engine: { copiedFrom: copied ? report.legacyEngine : null, dir: engineDir }, dismissed: false,
    };
    writeJsonAtomic(file, done, { mode: 0o600 });
    return { ran: true, record: done, report };
  } catch (e) {
    for (const fn of undo.reverse()) { try { fn(); } catch {} }
    throw fail("PROFILE_MIGRATION", `The browser profile migration stopped and put back what it had done (${e?.code || e?.message || "error"}); sessions start as before profiles until it runs again at the next helper start.`);
  }
}

// A file as it was: its bytes back (base64), or gone when there was none.
function putBack(file, before) {
  if (before === null || before === undefined) rmSync(file, { force: true });
  else writeFileSync(file, Buffer.from(before, "base64"), { mode: 0o600 });
}

// The migration under its lock (paths.profileMigrationLock), so a helper's first launch and the
// person's `cli.mjs migrate` never both migrate one home: the second finds the record and returns
// { ran: false }. Takes migrate's options; throws as it does, or when the lock stays busy past
// waitMs.
export function migrateLocked({ lockFile = paths.profileMigrationLock, file = paths.profileMigration, waitMs = LOCK_WAIT_MS, ...rest } = {}) {
  const record = readMigration(file);
  if (record) return { ran: false, record, report: null };
  return withInstallLockSync(() => migrate({ ...rest, file }), { file: lockFile, waitMs, staleMs: 60_000, what: "browser profile migration" });
}

// The migration for a launch (daemon/sessions/profiles.mjs): once per home, under its lock, then
// the engine pack's folders in this process's environment. Returns { ran, record, problem }: a
// problem (the migration failed and was put back, or the lock is busy) never stops the launch.
export function ensureMigrated({ lockFile = paths.profileMigrationLock, file = paths.profileMigration, engineDir = paths.engineProfiles, env = process.env, ...rest } = {}) {
  try {
    const out = migrateLocked({ ...rest, lockFile, file, engineDir });
    applyEngineEnv({ engineDir, env });
    return { ran: out.ran, record: out.record, problem: null };
  } catch (e) {
    return { ran: false, record: null, problem: e?.message || String(e) };
  }
}

// The person dismissed the migration's notes (cli.mjs migrate --dismiss): the status line stops
// naming what wasn't carried into the default profile. Returns whether there was a record.
export function dismissMigration(file = paths.profileMigration) {
  const record = readMigration(file);
  if (!record) return false;
  writeJsonAtomic(file, { ...record, dismissed: true }, { mode: 0o600 });
  return true;
}

// The status line's part while the migration's notes stand: one sentence, or null.
export function migrationNote(record) {
  if (!record || record.dismissed || !Array.isArray(record.notCarried) || !record.notCarried.length) return null;
  const shown = record.notCarried.slice(0, 6).join(", ");
  return `Profiles: config.json's ${shown}${record.notCarried.length > 6 ? ` and ${record.notCarried.length - 6} more` : ""} stay${record.notCarried.length === 1 ? "s" : ""} out of the default browser profile (${cliCommand("migrate --report")}; --dismiss hides this)`;
}

// Whether a helper runs on this home now (its lock names a live process).
export function helperRunning(lock = paths.daemonLock, alive = pidAlive) {
  let pid;
  try { pid = Number(readFileSync(lock, "utf8").trim()); } catch { return false; }
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid);
}

// Undoes the migration (see the header). store: the home's profile store. Returns { exported:
// [{ name, file }], sessions: [names put back], notRestored: [{ name, problem }], removed:
// [folders] } (none removed while a session wasn't put back). Throws PROFILE_MIGRATION when
// a helper runs on this home, or when a store profile couldn't be exported (nothing removed then).
export function undoMigration({ store, file = paths.profileMigration, engineDir = paths.engineProfiles, exportsDir = paths.profileExports, now = Date.now,
  running = helperRunning } = {}) {
  if (running()) throw fail("PROFILE_MIGRATION", "A PairBrowse helper is running on this home; quit it (close the browser and end the agents' sessions), then undo the migration.");
  const record = readMigration(file);
  const storeThere = existsSync(store.dir);
  if (!record && !storeThere && !existsSync(engineDir)) throw fail("PROFILE_MIGRATION", "This home has no browser profile migration to undo.");

  // 1. Every store profile exported first, so nothing made since is lost.
  const exported = [];
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  if (storeThere) {
    const rows = store.list();
    const broken = rows.filter((r) => r.problem);
    if (broken.length) throw fail("PROFILE_MIGRATION", `Browser profile ${broken[0].id} can't be read, so it couldn't be exported; fix or remove its file, then undo the migration. Nothing was removed.`);
    mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
    for (const r of rows.filter((x) => x.kind === "store")) {
      const dest = join(exportsDir, `${r.name}-${r.id}-${stamp}.json`);
      try { exportToFile(store.get(r.id), dest, { withHistory: true, includeIdentity: true }); } catch (e) {
        throw fail("PROFILE_MIGRATION", `Browser profile "${r.name}" couldn't be exported (${e?.message || e}); nothing was removed.`);
      }
      exported.push({ name: r.name, file: dest });
    }
  }

  // 2. The sessions as the migration found them.
  const defaultId = record?.defaultId || store.list().find((r) => r.kind === "config")?.id || null;
  const byName = new Map((record?.sessions || []).filter((s) => s && validName(s.name)).map((s) => [s.name, s]));
  const restored = [], notRestored = [];
  for (const { name, temporary } of listSessions()) {
    if (temporary) continue;
    try { restoreSession(name); restored.push(name); } catch (e) { notRestored.push({ name, problem: e?.code || e?.message || "error" }); }
  }
  // One session's files as the migration found them (a file that can't be read or written throws:
  // the session is listed as not put back, and the others go on).
  function restoreSession(name) {
    const was = byName.get(name);
    // Each file: the migration's own still there puts back what was before; anything else made by
    // profiles is removed (assignment, binding) or renamed back (a persona of the default).
    const back = (at, kept) => {
      if (kept && textOf(at) === kept.after) { putBack(at, kept.before); return true; }
      return false;
    };
    if (!back(assignmentFile(name), was?.assignment)) rmSync(assignmentFile(name), { force: true });
    if (!back(bindingFile(name), was?.binding)) rmSync(bindingFile(name), { force: true });
    if (!back(personaFile(name), was?.persona)) {
      const persona = personaNameOf(name);
      if (typeof persona === "string" && PROFILE_ID.test(persona)) {
        if (persona === defaultId) {
          const raw = JSON.parse(readFileSync(personaFile(name), "utf8"));
          writeFileSync(personaFile(name), personaText({ ...raw, name: LEGACY_PERSONA }), { mode: 0o600 });
        } else rmSync(personaFile(name), { force: true });
      }
    }
  }

  // 3. The new folders go (the exports stay); kept while a session wasn't put back, so it still
  // finds its profile and the person can undo again once its file is fixed.
  const removed = [];
  for (const dir of notRestored.length ? [] : [store.dir, engineDir]) {
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return { exported, sessions: restored, notRestored, removed, defaultName: DEFAULT_PROFILE };
}
