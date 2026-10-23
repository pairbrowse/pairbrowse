// The first-start migration to browser profiles and its undo (spec server-mode Phase D
// "Migration", profiles/migrate.mjs): today's layout (config.json's pairbrowse block and
// browserArgs, three sessions, personas named "pairbrowse", ~/.pairbrowse-engine) moves to
// profiles with each session on "default"; what config.json gives that a profile doesn't hold is
// listed, never dropped quietly; it runs once; a failure puts everything back; the undo exports
// the store first and puts the sessions' files back byte for byte. The launch runs it once
// (daemon/sessions/profiles.mjs) and points the engine pack at engine-profiles/.
import "./helpers/home.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { paths } from "../scripts/paths.mjs";
import { createSession, assignmentFile, bindingFile, personaFile, readAssignment, readBinding, personaNameOf, profileDir } from "../scripts/sessions.mjs";
import { createProfileStore } from "../scripts/profiles/store.mjs";
import { fromConfig } from "../scripts/profiles/map.mjs";
import { migrate, migrateLocked, migrationReport, notCarried, undoMigration, readMigration, ensureMigrated, engineEnv, migrationNote, dismissMigration } from "../scripts/profiles/migrate.mjs";
import { CLI } from "../scripts/profiles/validate.mjs";
import { createContext } from "../scripts/daemon/context.mjs";
import { pinnedAsset, nativeLayout } from "../scripts/native/install.mjs";
import { createProfiles } from "../scripts/daemon/sessions/profiles.mjs";

const T0 = Date.parse("2026-10-21T10:00:00Z");
const CONFIG = {
  browser: "pairbrowse",
  browserArgs: ["--lang=de-DE", "--window-size=1440,900"],
  pairbrowse: { timezone: "Europe/Berlin", acceptLanguage: "de-DE,de;q=0.9", fingerprint: "desk-7", gpuVendor: "Intel", hardwareConcurrency: 8, profile: "auto", humanize: true },
};
const SESSIONS = ["default", "work", "shop"];
const persona = (name) => `${JSON.stringify({ name, options: { fingerprint: "desk-7", timezone: "Europe/Berlin" } }, null, 2)}\n`;
const store = () => createProfileStore({ now: () => T0 });

// Today's layout in this test's home: three sessions with personas, the engine pack's own folder.
function todaysHome() {
  for (const p of [paths.sessions, paths.profile, paths.browserProfiles, paths.engineProfiles, paths.legacyEngine, paths.profileExports, join(paths.home, "assignment.json"), paths.profileMigrationLock]) rmSync(p, { recursive: true, force: true });
  for (const name of SESSIONS) {
    createSession(name);
    mkdirSync(join(profileDir(name), "pairbrowse-native"), { recursive: true });
    writeFileSync(personaFile(name), persona("pairbrowse"));
    writeFileSync(join(profileDir(name), "Cookies"), `cookies of ${name}`);
  }
  mkdirSync(join(paths.legacyEngine, "profiles"), { recursive: true });
  writeFileSync(join(paths.legacyEngine, "profiles", "berlin.json"), JSON.stringify({ name: "berlin", options: { timezone: "Europe/Berlin", gpuVendor: "NVIDIA" } }));
  mkdirSync(join(paths.legacyEngine, "geoip"), { recursive: true });
  writeFileSync(join(paths.legacyEngine, "geoip", "db.mmdb"), "geo");
}
const bytes = (file) => (existsSync(file) ? readFileSync(file).toString("base64") : null);
const snapshot = () => Object.fromEntries(SESSIONS.flatMap((n) => [[`${n}:a`, bytes(assignmentFile(n))], [`${n}:b`, bytes(bindingFile(n))], [`${n}:p`, bytes(personaFile(n))], [`${n}:c`, bytes(join(profileDir(n), "Cookies"))]]));

beforeEach(() => todaysHome());

test("a home with config.pairbrowse, browserArgs and three sessions migrates; each assigned default; unsupported keys listed, none silently dropped", () => {
  const s = store();
  const r = migrate({ config: CONFIG, native: true, platform: "linux", store: s, now: () => T0 });
  assert.equal(r.ran, true);
  const def = s.list().find((p) => p.kind === "config");
  assert.equal(r.record.defaultId, def.id);
  for (const name of SESSIONS) {
    assert.equal(readAssignment(name).profileId, def.id, `${name} on default`);
    assert.equal(readBinding(name).profileId, def.id, `${name} bound`);
    assert.equal(personaNameOf(name), def.id, `${name}'s persona under the default's id`);
    assert.equal(statSync(assignmentFile(name)).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(profileDir(name), "Cookies"), "utf8"), `cookies of ${name}`, "storage untouched");
  }
  // The default's settings are config.json's (read, never written back).
  const whole = s.use("default", { configSettings: fromConfig(CONFIG, { native: true, platform: "linux" }) });
  assert.equal(whole.locale.timezone, "Europe/Berlin");
  assert.deepEqual(whole.window, { width: 1440, height: 900 });
  assert.equal(whole.persona.seed, "desk-7");
  // Every key not carried is named: the hardware keys (U6), the helper's own, the saved persona.
  for (const k of ["pairbrowse.gpuVendor", "pairbrowse.hardwareConcurrency", "pairbrowse.humanize"]) assert.ok(r.record.notCarried.includes(k), `${k} listed: ${r.record.notCarried.join(", ")}`);
  assert.deepEqual(notCarried(r.report), r.record.notCarried);
  assert.match(migrationNote(r.record), /^Profiles: config\.json's .*pairbrowse\.gpuVendor.* stay out of the default browser profile/);
  assert.equal(statSync(paths.profileMigration).mode & 0o777, 0o600);
  assert.equal(statSync(paths.browserProfiles).mode & 0o777, 0o700);
  dismissMigration();
  assert.equal(migrationNote(readMigration()), null, "dismissed");
});

test("idempotent; auto is recorded as this computer with no request made", () => {
  const s = store();
  // "auto" reads as this computer: the seed persona off macOS, the host capture on it; the
  // migration makes no request (it has no network part at all).
  const linux = migrate({ config: { ...CONFIG, pairbrowse: { profile: "auto" } }, native: true, platform: "linux", store: s, now: () => T0 });
  const id = linux.record.defaultId;
  assert.equal(s.use("default", { configSettings: fromConfig({ ...CONFIG, pairbrowse: { profile: "auto" } }, { native: true, platform: "linux" }) }).persona.source, "seed");
  assert.equal(migrationReport({ config: { browser: "pairbrowse", pairbrowse: { profile: "auto" } }, native: true, platform: "darwin" }).default.settings.persona.source, "host");
  const before = snapshot();
  const again = migrate({ config: CONFIG, native: true, platform: "linux", store: s, now: () => T0 + 1000 });
  assert.equal(again.ran, false);
  assert.equal(again.record.defaultId, id);
  assert.deepEqual(snapshot(), before, "a second run changes nothing");
  assert.equal(s.list().filter((p) => p.kind === "config").length, 1);
});

test("~/.pairbrowse-engine copied, never moved; the engine pack points at engine-profiles", () => {
  // A link inside the old folder is never followed into the copy.
  symlinkSync("/etc", join(paths.legacyEngine, "outside"));
  const before = readdirSync(paths.legacyEngine).sort();
  const env = {};
  const r = ensureMigrated({ config: CONFIG, native: true, platform: "linux", store: store(), now: () => T0, env });
  assert.equal(r.problem, null);
  assert.equal(r.ran, true);
  assert.deepEqual(readdirSync(paths.legacyEngine).sort(), before, "the original is left as it was");
  assert.equal(readFileSync(join(paths.engineProfiles, "profiles", "berlin.json"), "utf8"), readFileSync(join(paths.legacyEngine, "profiles", "berlin.json"), "utf8"));
  assert.equal(existsSync(join(paths.engineProfiles, "outside")), false, "links are not copied");
  assert.match(readFileSync(join(paths.engineProfiles, "COPIED-FROM.txt"), "utf8"), /left as it was/);
  assert.deepEqual(env, engineEnv(paths.engineProfiles));
  for (const dir of Object.values(env)) assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(env.PAIRBROWSE_ENGINE_PROFILE_SOURCE), [], "the source folder is empty and owned");
  // The saved persona config.json names is offered for import (a dry run), never imported.
  const report = migrationReport({ config: { ...CONFIG, pairbrowse: { profile: "berlin" } }, native: true, platform: "linux" });
  assert.equal(report.offered[0].field, "pairbrowse.profile");
  assert.equal(report.offered[0].dryRun.ok, true);
  assert.ok(report.offered[0].dryRun.unsupported.includes("options.gpuVendor"), "another device's GPU reported unsupported");
  assert.equal(store().list().filter((p) => p.kind === "store").length, 0);
  // Already migrated: the environment only.
  const env2 = {};
  assert.equal(ensureMigrated({ config: CONFIG, store: store(), env: env2 }).ran, false);
  assert.deepEqual(env2, env);
});

test("a failure leaves the legacy path working", () => {
  const before = snapshot();
  for (const at of ["engine", "default", "session:shop", "record"]) {
    const env = {};
    const r = ensureMigrated({ config: CONFIG, native: true, platform: "linux", store: store(), now: () => T0, env, failAt: at });
    assert.match(r.problem, /migration stopped and put back what it had done/, at);
    assert.deepEqual(snapshot(), before, `${at}: every session as it was`);
    assert.equal(readMigration(), null);
    assert.equal(existsSync(paths.engineProfiles), false, `${at}: no engine folder left`);
    assert.deepEqual(env, {}, "the engine pack keeps its own folders");
  }
  // The launch runs on (step 37's path) with the warning in the log and status.
  const lines = [];
  const st = {};
  const parts = createProfiles(st, { config: { ...CONFIG, browser: "pairbrowse-open", pairbrowse: {} }, log: (l) => lines.push(l), now: () => T0, platform: "linux", env: {} });
  const got = parts.forLaunch("work", { browserKind: "pairbrowse-open" });
  assert.equal(got.kind, "config");
  assert.ok(!lines.some((l) => /warning/.test(l)), "this one migrated");
  assert.ok(readMigration(), "the launch migrated the home");
});

test("undo exports first and restores byte for byte", () => {
  const before = snapshot();
  const s = store();
  migrate({ config: CONFIG, native: true, platform: "linux", store: s, now: () => T0 });
  const berlin = s.create({ name: "berlin", persona: { source: "seed", seed: "berlin-7" } });
  // Refused while a helper runs on the home.
  assert.throws(() => undoMigration({ store: s, running: () => true }), /helper is running/);
  const r = undoMigration({ store: s, running: () => false, now: () => T0 });
  assert.equal(r.exported.length, 1);
  const file = JSON.parse(readFileSync(r.exported[0].file, "utf8"));
  assert.equal(file.profile.name, "berlin");
  assert.equal(file.profile.persona.seed, "berlin-7", "the pinned seed kept in the undo's export");
  assert.equal(statSync(r.exported[0].file).mode & 0o777, 0o600);
  assert.deepEqual(snapshot(), before, "each session's files as before, byte for byte");
  assert.equal(existsSync(paths.browserProfiles), false);
  assert.equal(existsSync(paths.engineProfiles), false);
  assert.ok(existsSync(paths.legacyEngine));
  void berlin;
  // A session put on another profile since, and a persona saved under the default's id by a launch:
  // removed, and renamed back.
  migrate({ config: CONFIG, native: true, platform: "linux", store: s, now: () => T0 });
  const id = readMigration().defaultId;
  writeFileSync(personaFile("work"), persona(id).replace("Europe/Berlin", "Europe/Paris"));
  const other = s.create({ name: "paris" });
  writeFileSync(assignmentFile("shop"), JSON.stringify({ profileId: other.id }));
  writeFileSync(personaFile("shop"), persona(other.id));
  undoMigration({ store: s, running: () => false, now: () => T0 });
  assert.equal(personaNameOf("work"), "pairbrowse");
  assert.equal(existsSync(personaFile("shop")), false, "another profile's persona never becomes the default's");
  assert.equal(existsSync(assignmentFile("shop")), false);
  assert.throws(() => undoMigration({ store: s, running: () => false }), /no browser profile migration to undo/);
});

test("the helper's own home: migrated once before its first launch, the note in status until dismissed; a failed one warns and the launch runs on", () => {
  // A part with no store of its own is the helper's: prepare() (launch.mjs, before the engine pack
  // can load) migrates the home and sets the pack's folders; forLaunch finds it done.
  const lines = [];
  const env = {};
  const helper = createProfiles({}, { config: CONFIG, log: (l) => lines.push(l), now: () => T0, platform: "linux", env });
  assert.deepEqual(helper.statusParts(), [], "nothing said before the first launch");
  helper.prepare({ native: true });
  assert.ok(readMigration(), "migrated");
  assert.deepEqual(env, engineEnv(paths.engineProfiles), "the engine pack's folders set in the helper's environment");
  assert.ok(lines.some((l) => /^launch: sessions moved to browser profiles \(each on "default"\); config\.json's .*pairbrowse\.gpuVendor.* stay out of it$/.test(l)), lines.join("\n"));
  const note = migrationNote(readMigration());
  assert.match(note, new RegExp(`${CLI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} migrate --report`), "the note names the command line by its full path");
  assert.deepEqual(helper.statusParts(), [note]);
  const got = helper.forLaunch("work", { browserKind: "pairbrowse", build: "155.0.8059.84" });
  assert.equal(got.id, readMigration().defaultId);
  helper.release();
  assert.equal(lines.filter((l) => /sessions moved/.test(l)).length, 1, "once per helper");
  assert.ok(dismissMigration());
  assert.deepEqual(helper.statusParts(), [], "dismissed");
  // A new helper on the migrated home: nothing to move, the folders set again.
  const env2 = {};
  const next = createProfiles({}, { config: CONFIG, log: (l) => lines.push(l), now: () => T0, platform: "linux", env: env2 });
  next.forLaunch("shop", { browserKind: "pairbrowse", build: "155.0.8059.84" });
  next.release();
  assert.deepEqual(env2, env);
  assert.equal(lines.filter((l) => /sessions moved/.test(l)).length, 1);

  // A migration that fails: put back, a warning in the log and status, and the launch runs on
  // unmigrated (an unassigned session is the default's), the pack keeping its own folders.
  todaysHome();
  const before = snapshot();
  const failed = [];
  const env3 = {};
  const broken = createProfiles({}, { config: CONFIG, log: (l) => failed.push(l), now: () => T0, platform: "linux", env: env3,
    migrateHome: (o) => ensureMigrated({ ...o, failAt: "record" }) });
  const ran = broken.forLaunch("work", { browserKind: "pairbrowse", build: "155.0.8059.84" });
  assert.equal(ran.kind, "config");
  assert.equal(readMigration(), null);
  assert.deepEqual(env3, {});
  const warning = failed.find((l) => l.startsWith("launch: warning: "));
  assert.match(warning, /migration stopped and put back what it had done/);
  assert.ok(broken.statusParts().includes(`warning: ${warning.slice("launch: warning: ".length)}`), broken.statusParts().join("\n"));
  broken.release();
  const after = snapshot();
  assert.deepEqual({ ...after, "work:b": before["work:b"] }, before, "every session as it was (work bound by its own start)");
});

test("the migration runs under its lock: the person's migrate while a helper's is running waits, then finds it done", { timeout: 20_000 }, async () => {
  // Another process holds the migration's lock (a helper's first launch migrating now).
  const lockUrl = pathToFileURL(join(import.meta.dirname, "..", "scripts", "install-lock.mjs")).href;
  const code = `import { withInstallLockSync } from ${JSON.stringify(lockUrl)};
withInstallLockSync(() => { process.stdout.write("held\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); }, { file: ${JSON.stringify(paths.profileMigrationLock)}, what: "test" });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"], env: process.env });
  await new Promise((done, fail) => { child.stdout.once("data", done); child.once("exit", () => fail(new Error("the holder ended early"))); });
  assert.throws(() => migrateLocked({ config: CONFIG, native: true, platform: "linux", store: store(), now: () => T0, waitMs: 100 }), /busy|in progress|another/i);
  assert.equal(readMigration(), null, "nothing migrated past the lock");
  await new Promise((done) => child.once("exit", done));
  assert.equal(migrateLocked({ config: CONFIG, native: true, platform: "linux", store: store(), now: () => T0 }).ran, true);
  assert.equal(migrateLocked({ config: CONFIG, native: true, platform: "linux", store: store(), now: () => T0 }).ran, false, "once per home");
});

test("undo stops at no session: one it can't put back is listed, the folders kept, and a second undo finishes", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const before = snapshot();
  const s = store();
  migrate({ config: CONFIG, native: true, platform: "linux", store: s, now: () => T0 });
  const id = readMigration().defaultId;
  // work's persona saved since by a launch (not the migration's own) and not writable now.
  writeFileSync(personaFile("work"), persona(id).replace("Europe/Berlin", "Europe/Paris"));
  chmodSync(personaFile("work"), 0o400);
  let r;
  try { r = undoMigration({ store: s, running: () => false, now: () => T0 }); } finally { chmodSync(personaFile("work"), 0o600); }
  assert.deepEqual(r.notRestored.map((x) => x.name), ["work"]);
  assert.match(r.notRestored[0].problem, /^E[A-Z]+$/);
  assert.deepEqual(r.sessions.sort(), ["default", "shop"]);
  assert.deepEqual(r.removed, [], "the folders stay while a session wasn't put back");
  assert.ok(existsSync(paths.browserProfiles));
  assert.equal(bytes(assignmentFile("shop")), before["shop:a"], "the others are put back");
  // Fixed: the second undo finishes.
  const again = undoMigration({ store: s, running: () => false, now: () => T0 });
  assert.deepEqual(again.notRestored, []);
  assert.equal(personaNameOf("work"), "pairbrowse");
  assert.equal(existsSync(paths.browserProfiles), false);
  const { "work:p": _p, ...rest } = snapshot();
  const { "work:p": _q, ...was } = before;
  assert.deepEqual(rest, was);
});

test("the launch migrates and sets the engine pack's folders before it installs or checks the native build", { skip: !(pinnedAsset() && nativeLayout()) && "no native build is pinned for this computer" }, async () => {
  const keys = Object.keys(engineEnv());
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  const seen = [];
  const quiet = () => {};
  try {
    const context = createContext({
      config: { browser: "pairbrowse", display: "none", sessionPicker: false }, log: quiet, chromium: {},
      hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
      presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
      shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
      // The install (and its self-check, which loads the engine pack in this process): stopped here.
      ensureNativeBuild: async () => { seen.push({ dir: process.env.PAIRBROWSE_ENGINE_PROFILE_DIR, migrated: !!readMigration() }); throw new Error("stop (test)"); },
    });
    await assert.rejects(context.getContext(), /stop \(test\)/);
    assert.deepEqual(seen, [{ dir: join(paths.engineProfiles, "profiles"), migrated: true }]);
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
