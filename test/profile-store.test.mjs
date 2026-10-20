// The browser profile store (spec server-mode Phase D, D1, D4, D5; scripts/profiles/store.mjs):
// owner-only records under browser-profiles/, a stable id through renames, revisions kept and
// stale writes refused under one lock, retired profiles never assigned or launched, removal refused
// while a session uses one, a corrupt file copied aside with its revisions offered, and the
// config-backed "default" profile storing only its identity, revision, history and validation.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createProfileStore, changedFields } from "../scripts/profiles/store.mjs";
import { checkProfile, SCHEMA_VERSION, SETTINGS } from "../scripts/profiles/schema.mjs";
import { measuredEntry } from "./helpers/measured.mjs";
import { paths, DEFAULT_CONFIG, loadConfig } from "../scripts/paths.mjs";
import { checkConfig } from "../scripts/config-schema.mjs";

const POSIX = process.platform !== "win32";
const freshDir = () => join(mkdtempSync(join(tmpdir(), "pb-profiles-")), "browser-profiles");
// A store on its own folder with a clock that moves a second per call and ids 1, 2, 3...
function makeStore(extra = {}) {
  let t = Date.parse("2026-10-21T10:00:00Z"), n = 0;
  const dir = extra.dir || freshDir();
  return createProfileStore({ dir, now: () => (t += 1000), randomId: () => (++n).toString(16).padStart(16, "0"), ...extra });
}
const mode = (p) => statSync(p).mode & 0o777;
const refuses = (fn, code, pattern) => assert.throws(fn, (e) => e.code === code && (!pattern || pattern.test(e.message)), `${code} ${pattern || ""}`);

test("the paths and the config key: browser-profiles and engine-profiles in the home, identity locks in the shared home, requireValidatedProfiles off", () => {
  assert.equal(paths.browserProfiles, join(paths.home, "browser-profiles"));
  assert.equal(paths.engineProfiles, join(paths.home, "engine-profiles"));
  assert.equal(paths.identityLocks, join(paths.shared, "identity-locks"));
  assert.equal(DEFAULT_CONFIG.requireValidatedProfiles, false);
  assert.deepEqual(checkConfig({ requireValidatedProfiles: true }).wrong, []);
  assert.match(checkConfig({ requireValidatedProfiles: "yes" }).wrong[0], /^requireValidatedProfiles is true or false/);
  const file = join(mkdtempSync(join(tmpdir(), "pb-cfg-")), "config.json");
  writeFileSync(file, JSON.stringify({ requireValidatedProfiles: true }));
  assert.equal(loadConfig(file).requireValidatedProfiles, true);
  writeFileSync(file, JSON.stringify({ requireValidatedProfiles: 1 }));
  assert.equal(loadConfig(file).requireValidatedProfiles, false, "a wrong value takes the default");
  assert.equal(createProfileStore().dir, paths.browserProfiles, "the store's folder by default");
});

test("create: a checked record at revision 1 with the defaults, an id of its own and a name no other profile has", () => {
  const store = makeStore();
  const p = store.create({ name: "berlin", locale: { languages: ["de-DE", "de"], timezone: "Europe/Berlin", source: "set" } });
  assert.equal(p.id, "p-0000000000000001");
  assert.equal(p.revision, 1);
  assert.equal(p.kind, "store");
  assert.equal(p.status, "active");
  assert.equal(p.schema, SCHEMA_VERSION);
  assert.deepEqual(p.history, []);
  assert.deepEqual(checkProfile(p).problems, []);
  refuses(() => store.create({ name: "BERLIN" }), "PROFILE_NAME", /named "berlin" exists already/);
  refuses(() => store.create({ name: "Default" }), "PROFILE_NAME", /config-backed/);
  refuses(() => store.create({ name: "x", id: "p-1111111111111111" }), "PROFILE_INVALID", /store sets/);
  refuses(() => store.create({ name: "x", revision: 9 }), "PROFILE_INVALID");
  refuses(() => store.create({ name: "bad name!" }), "PROFILE_INVALID", /^The browser profile wasn't made: name is/);
  // A name shaped like an id would be read as one: never reachable by name, or standing for another.
  refuses(() => store.create({ name: p.id }), "PROFILE_NAME", /looks like a profile id/);
  refuses(() => store.create({ name: "p-00000000000000ff" }), "PROFILE_NAME", /looks like a profile id/);
  refuses(() => store.update(p.id, { name: "p-00000000000000aa" }), "PROFILE_NAME", /looks like a profile id/);
  refuses(() => store.create({ name: "gpu", screen: { width: 10 } }), "PROFILE_INVALID");
  assert.equal(store.list().length, 1, "nothing written by a refused create");
});

test("0600 files in a 0700 folder; revisions in <id>.history, 0600 too", { skip: !POSIX }, () => {
  const store = makeStore();
  const p = store.create({ name: "work" });
  assert.equal(mode(store.dir), 0o700);
  assert.equal(mode(join(store.dir, `${p.id}.json`)), 0o600);
  store.update(p.id, { display: { colorScheme: "dark" } }, { expectRevision: 1 });
  assert.equal(mode(join(store.dir, `${p.id}.history`)), 0o700);
  assert.equal(mode(join(store.dir, `${p.id}.history`, "1.json")), 0o600);
  assert.deepEqual(readdirSync(store.dir).filter((n) => n.endsWith(".tmp")), [], "no temp file left");
});

test("stable id survives rename; a new store instance reads the same record", () => {
  const store = makeStore();
  const p = store.create({ name: "shop" });
  const renamed = store.update("SHOP", { name: "shop-eu" }, { expectRevision: 1 });
  assert.equal(renamed.id, p.id);
  assert.equal(renamed.name, "shop-eu");
  assert.deepEqual(renamed.history.at(-1).change, ["name"]);
  const again = createProfileStore({ dir: store.dir });
  assert.deepEqual(again.get(p.id), renamed);
  assert.deepEqual(again.get("Shop-EU"), renamed, "by name, case-insensitively");
  refuses(() => again.get("shop"), "PROFILE_UNKNOWN", /no browser profile "shop"/);
  refuses(() => again.get("p-ffffffffffffffff"), "PROFILE_UNKNOWN");
  refuses(() => again.get("../../etc/passwd"), "PROFILE_UNKNOWN", /"\(that name\)"/);
});

test("stale revision refused, history appended, earlier revisions kept and put back", () => {
  const store = makeStore();
  const p = store.create({ name: "eu" });
  const r2 = store.update(p.id, { locale: { timezone: "Europe/Paris" } }, { expectRevision: 1 });
  assert.equal(r2.revision, 2);
  assert.equal(r2.locale.source, "system", "an object setting is merged one level deep");
  assert.deepEqual(r2.history, [{ revision: 2, at: r2.history[0].at, change: ["locale.timezone"], by: "person" }]);
  refuses(() => store.update(p.id, { locale: { timezone: "Europe/Rome" } }, { expectRevision: 1 }), "PROFILE_STALE", /revision 2, not 1/);
  assert.equal(store.get(p.id).locale.timezone, "Europe/Paris", "the stale write changed nothing");
  const r3 = store.update(p.id, { window: { width: 1280, height: 800 }, display: { reducedMotion: true } }, { expectRevision: 2 });
  assert.deepEqual(r3.history.at(-1).change, ["window", "display.reducedMotion"]);
  assert.deepEqual(store.update(p.id, { window: { width: 1280 } }), r3, "nothing differs: no new revision");
  assert.deepEqual(store.revisions(p.id), [1, 2]);
  assert.equal(store.revision(p.id, 1).locale.timezone, null);
  const r4 = store.revert(p.id, 1, { expectRevision: 3 });
  assert.equal(r4.revision, 4);
  assert.equal(r4.locale.timezone, null);
  assert.equal(r4.window, null);
  assert.deepEqual(store.revisions(p.id), [1, 2, 3]);
  refuses(() => store.revision(p.id, 9), "PROFILE_UNKNOWN", /no saved revision 9/);
});

test("revert never brings back a name another profile took meanwhile", () => {
  const store = makeStore();
  const a = store.create({ name: "a" });
  store.update(a.id, { name: "b" });
  const other = store.create({ name: "A" });
  refuses(() => store.revert(a.id, 1), "PROFILE_NAME", /named "A" exists already/);
  assert.deepEqual(store.list().map((r) => r.name).sort(), ["A", "b"]);
  assert.equal(store.get(a.id).revision, 2, "the refused revert wrote nothing");
  // Also when the current file can't be read.
  writeFileSync(join(store.dir, `${a.id}.json`), "{ half");
  refuses(() => store.revert(a.id, 1), "PROFILE_NAME", /exists already/);
  store.remove(other.id);
  assert.equal(store.revert(a.id, 1).name, "a", "free again: put back");
});

test("update takes only the name and settings; a forbidden key is named with its reason; a refused change writes nothing", () => {
  const store = makeStore();
  const p = store.create({ name: "a" });
  for (const k of ["id", "revision", "kind", "status", "history", "validation", "engine", "provenance", "schema", "created"]) {
    refuses(() => store.update(p.id, { [k]: null }), "PROFILE_INVALID", new RegExp(`${k} can't be changed here`));
  }
  refuses(() => store.update(p.id, { proxy: "http://u:secret@x" }), "PROFILE_INVALID", /proxy can't be changed here/);
  refuses(() => store.update(p.id, { screen: { width: 1920 } }), "PROFILE_INVALID", /screen\.height is missing/);
  refuses(() => store.update(p.id, { locale: { timezone: "Mars/Olympus" } }), "PROFILE_INVALID", /time zone this computer knows/);
  refuses(() => store.update(p.id, { persona: { gpuVendor: "x" } }), "PROFILE_INVALID", /persona\.gpuVendor: a profile can't name a hardware value/);
  const b = store.create({ name: "b" });
  refuses(() => store.update(b.id, { name: "A" }), "PROFILE_NAME");
  assert.equal(store.get(p.id).revision, 1);
  assert.equal(store.get(b.id).name, "b");
  // A message never repeats a string a setting held.
  assert.throws(() => store.update(p.id, { network: "http://user:hunter2@proxy" }), (e) => e.code === "PROFILE_INVALID" && /^The browser profile wasn't changed: network is/.test(e.message) && !/hunter2/.test(e.message));
});

test("retire blocks assignment and launch until restored; the list shows it", () => {
  const store = makeStore();
  const p = store.create({ name: "old" });
  assert.equal(store.use("old").id, p.id);
  const retired = store.retire("old", { expectRevision: 1 });
  assert.equal(retired.status, "retired");
  assert.deepEqual(retired.history.at(-1).change, ["status"]);
  refuses(() => store.use("old", { session: "shop" }), "PROFILE_RETIRED", /^Session "shop" uses browser profile "old", which is retired/);
  refuses(() => store.use(p.id), "PROFILE_RETIRED");
  assert.equal(store.list().find((r) => r.id === p.id).status, "retired");
  refuses(() => store.create({ name: "OLD" }), "PROFILE_NAME", /exists already/);
  refuses(() => store.restore("old", { expectRevision: 1 }), "PROFILE_STALE");
  assert.equal(store.restore("old").status, "active");
  assert.equal(store.use("old").revision, 3);
  refuses(() => store.use("gone", { session: "shop" }), "PROFILE_UNKNOWN", /^Session "shop" uses browser profile "gone", which doesn't exist/);
});

test("remove refused while assigned, naming the sessions; then the record and its revisions go", () => {
  const assigned = new Map();
  const store = makeStore({ assignedTo: (id) => assigned.get(id) || [] });
  const p = store.create({ name: "temp" });
  store.update(p.id, { adBlocker: false });
  assigned.set(p.id, ["shop-a", "shop-b"]);
  refuses(() => store.remove("temp"), "PROFILE_ASSIGNED", /sessions "shop-a", "shop-b" use it/);
  assert.ok(existsSync(join(store.dir, `${p.id}.json`)));
  assigned.set(p.id, []);
  assert.deepEqual(store.remove("temp"), { id: p.id, name: "temp" });
  assert.ok(!existsSync(join(store.dir, `${p.id}.json`)));
  assert.ok(!existsSync(join(store.dir, `${p.id}.history`)));
  refuses(() => store.remove("temp"), "PROFILE_UNKNOWN");
});

test("corrupt file copied aside and named, its revisions offered and put back; a link is never followed", () => {
  const store = makeStore();
  const p = store.create({ name: "c" });
  store.update(p.id, { display: { colorScheme: "dark" } });
  const file = join(store.dir, `${p.id}.json`);
  writeFileSync(file, "{ half a rec");
  refuses(() => store.get(p.id), "PROFILE_CORRUPT", /kept beside it as p-0000000000000001\.json\.corrupt\. Its saved revisions \(1\) can be put back with revert/);
  assert.equal(readFileSync(`${file}.corrupt`, "utf8"), "{ half a rec");
  const listed = store.list().find((r) => r.id === p.id);
  assert.match(listed.problem, /isn't valid JSON/);
  // The lost file was revision 2; the revert lands above it, so a writer still holding 2 is stale.
  const back = store.revert(p.id, 1);
  assert.equal(back.revision, 3);
  assert.equal(back.name, "c");
  assert.equal(store.get(p.id).display.colorScheme, null);
  refuses(() => store.update(p.id, { adBlocker: true }, { expectRevision: 2 }), "PROFILE_STALE", /revision 3, not 2/);
  // A file that is JSON but can't be used keeps its own revision in view.
  writeFileSync(file, JSON.stringify({ ...store.get(p.id), revision: 7, screen: { width: 1 } }));
  refuses(() => store.get(p.id), "PROFILE_INVALID");
  assert.equal(store.revert(p.id, 1).revision, 8);
  refuses(() => store.update(p.id, { adBlocker: true }, { expectRevision: 7 }), "PROFILE_STALE");
  if (POSIX) {
    const elsewhere = join(mkdtempSync(join(tmpdir(), "pb-elsewhere-")), "x.json");
    writeFileSync(elsewhere, JSON.stringify(back));
    rmSync(file);
    symlinkSync(elsewhere, file);
    refuses(() => store.get(p.id), "PROFILE_UNREADABLE", /never followed/);
  }
});

test("a record of a newer schema is refused and never rewritten; one whose id isn't its file's name is refused", () => {
  const store = makeStore();
  const p = store.create({ name: "n" });
  const file = join(store.dir, `${p.id}.json`);
  const newer = JSON.stringify({ ...p, schema: SCHEMA_VERSION + 1, futureKey: 1 });
  writeFileSync(file, newer);
  refuses(() => store.get(p.id), "PROFILE_NEWER", /newer than this PairBrowse reads/);
  refuses(() => store.update(p.id, { adBlocker: true }), "PROFILE_NEWER");
  assert.equal(readFileSync(file, "utf8"), newer);
  writeFileSync(file, JSON.stringify({ ...p, id: "p-00000000000000ff" }));
  refuses(() => store.get(p.id), "PROFILE_INVALID", /isn't its file's name/);
});

test("the config-backed default (D5): settings never stored; a changed configHash bumps the revision by config", () => {
  const store = makeStore();
  const first = store.configProfile({ locale: { languages: ["en-US"], timezone: null, source: "set" } });
  assert.equal(first.name, "default");
  assert.equal(first.kind, "config");
  assert.equal(first.revision, 1);
  assert.deepEqual(first.locale.languages, ["en-US"]);
  assert.deepEqual(checkProfile(first).problems, []);
  const stored = JSON.parse(readFileSync(join(store.dir, `${first.id}.json`), "utf8"));
  for (const k of SETTINGS) assert.ok(!(k in stored), `${k} isn't stored`);
  assert.match(stored.configHash, /^[0-9a-f]{64}$/);
  if (POSIX) assert.equal(mode(join(store.dir, `${first.id}.json`)), 0o600);
  // Same settings: same revision, nothing written.
  assert.deepEqual(store.configProfile({ locale: { languages: ["en-US"], timezone: null, source: "set" } }), first);
  const second = store.configProfile({ locale: { languages: ["de-DE"], timezone: null, source: "set" }, display: { colorScheme: "dark", reducedMotion: null } });
  assert.equal(second.id, first.id, "the id is kept");
  assert.equal(second.revision, 2);
  assert.deepEqual(second.history.at(-1).change, ["locale", "display"]);
  assert.equal(second.history.at(-1).by, "config");
  // The default is listed first, used by name, and edited only through config.json.
  store.create({ name: "aaa" });
  assert.deepEqual(store.list().map((r) => r.name), ["default", "aaa"]);
  assert.equal(store.use("default").id, first.id);
  assert.equal(store.get("default").settings, "config.json");
  refuses(() => store.update("default", { adBlocker: true }), "PROFILE_CONFIG", /comes from config\.json/);
  refuses(() => store.retire("default"), "PROFILE_CONFIG");
  refuses(() => store.remove("default"), "PROFILE_CONFIG");
  refuses(() => store.configProfile({ proxy: "x" }), "PROFILE_INVALID", /hold only/);
  refuses(() => store.configProfile({ screen: { width: 5 } }), "PROFILE_INVALID");
  assert.equal(store.configProfile({}).revision, 3, "back to the defaults is a change too");
  // A settings key written into its file by hand refuses it.
  writeFileSync(join(store.dir, `${first.id}.json`), JSON.stringify({ ...stored, network: "us" }));
  refuses(() => store.use("p-0000000000000001"), "PROFILE_INVALID", /keeps no settings of its own/);
});

test("use on the default: its whole record from configSettings, else a stored part marked as no record", () => {
  const store = makeStore();
  const d = store.configProfile({});
  const part = store.use("default");
  assert.equal(part.settings, "config.json");
  assert.ok(!checkProfile(part).profile, "the stored part is no record to launch");
  const whole = store.use("default", { session: "shop", configSettings: { adBlocker: true } });
  assert.equal(whole.id, d.id);
  assert.equal(whole.adBlocker, true);
  assert.equal(whole.revision, 2, "a change in what config.json gives bumps it");
  assert.deepEqual(checkProfile(whole).problems, []);
  refuses(() => store.use("default", { session: "shop", configSettings: { proxy: "x" } }), "PROFILE_INVALID", /^Session "shop" uses browser profile "default": /);
});

test("use on a default never made: made from configSettings, refused without them", () => {
  const store = makeStore();
  refuses(() => store.use("default", { session: "shop" }), "PROFILE_UNKNOWN", /^Session "shop" uses browser profile "default", which doesn't exist/);
  const made = store.use("Default", { session: "shop", configSettings: {} });
  assert.equal(made.name, "default");
  assert.equal(made.revision, 1);
  assert.equal(store.use("default").id, made.id);
  refuses(() => store.use("nowhere", { configSettings: {} }), "PROFILE_UNKNOWN");
});

test("use names only a plain ref and session in its refusal", () => {
  const store = makeStore();
  assert.throws(() => store.use("../../x\nINJECT", { session: "a/b\nc" }), (e) => e.code === "PROFILE_UNKNOWN"
    && e.message.startsWith(`Session "(that name)" uses browser profile "(that name)", which doesn't exist`) && !/INJECT|\.\.\/|\n/.test(e.message));
  refuses(() => store.use("p-00000000000000ab", { session: "shop" }), "PROFILE_UNKNOWN", /^Session "shop" uses browser profile "p-00000000000000ab"/);
});

test("a default that exists but can't be used is refused by its file, never replaced by a second one", () => {
  for (const spoil of [
    (stub) => JSON.stringify({ ...stub, schema: SCHEMA_VERSION + 1 }),
    (stub) => JSON.stringify({ ...stub, configHash: "nope" }),
    () => "{ half a stub",
  ]) {
    const store = makeStore();
    const d = store.configProfile({});
    const file = join(store.dir, `${d.id}.json`);
    const text = spoil(JSON.parse(readFileSync(file, "utf8")));
    writeFileSync(file, text);
    assert.throws(() => store.configProfile({}), (e) => ["PROFILE_NEWER", "PROFILE_INVALID", "PROFILE_CORRUPT"].includes(e.code) && e.message.includes(`${d.id}.json`), text);
    assert.deepEqual(readdirSync(store.dir).filter((n) => n.endsWith(".json")), [`${d.id}.json`], "no second default");
    if (!text.startsWith("{ half")) assert.equal(readFileSync(file, "utf8"), text, "never rewritten");
  }
  // A newer stub is named as newer, not invalid.
  const store = makeStore();
  const d = store.configProfile({});
  const file = join(store.dir, `${d.id}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), schema: SCHEMA_VERSION + 1 }));
  refuses(() => store.use(d.id), "PROFILE_NEWER", /newer than this PairBrowse reads/);
  refuses(() => store.configProfile({}), "PROFILE_NEWER", /p-0000000000000001\.json/);
  // A store record that can't be used doesn't stop the default being made.
  const fresh = makeStore();
  const s = fresh.create({ name: "s" });
  writeFileSync(join(fresh.dir, `${s.id}.json`), JSON.stringify({ ...s, screen: { width: 1 } }));
  assert.equal(fresh.configProfile({}).kind, "config");
});

test("changedFields names sections and their keys", () => {
  assert.deepEqual(changedFields({ name: "a", locale: { timezone: null, source: "system" }, screen: null }, { name: "b", locale: { timezone: "UTC", source: "set" }, screen: { width: 1 } }),
    ["name", "locale.timezone", "locale.source", "screen"]);
  assert.deepEqual(changedFields({ status: "active" }, { status: "active" }), []);
});

// Two processes write the same profile on the same revision at once: one wins, the other is
// refused as stale, and the file is always one whole record.
test("two writers: one wins, never half written", async () => {
  const store = makeStore();
  const p = store.create({ name: "race" });
  const url = new URL("../scripts/profiles/store.mjs", import.meta.url).href;
  const code = `import { createProfileStore } from ${JSON.stringify(url)};
    const store = createProfileStore({ dir: process.argv[1] });
    const at = Number(process.argv[3]); while (Date.now() < at) {}
    try { const r = store.update(${JSON.stringify(p.id)}, { locale: { timezone: process.argv[2] } }, { expectRevision: 1 }); console.log(JSON.stringify({ ok: r.revision })); }
    catch (e) { console.log(JSON.stringify({ code: e.code })); }`;
  const go = Date.now() + 700;
  const run = (zone) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, store.dir, zone, String(go)], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", reject);
    child.on("exit", () => { try { resolve(JSON.parse(out.trim())); } catch { reject(new Error(`no answer: ${out}`)); } });
  });
  const results = await Promise.all([run("Europe/Berlin"), run("Asia/Tokyo")]);
  assert.deepEqual(results.map((r) => r.ok || r.code).sort(), [2, "PROFILE_STALE"].sort(), JSON.stringify(results));
  const now = createProfileStore({ dir: store.dir }).get(p.id);
  assert.equal(now.revision, 2);
  assert.ok(["Europe/Berlin", "Asia/Tokyo"].includes(now.locale.timezone));
  assert.equal(now.history.length, 1);
  assert.ok(!existsSync(join(store.dir, ".lock")), "the lock is released");
});

// D10, E8 (spec step 37): what a launch on the native build found is evidence: the engine pinned
// once, the build's unverified entry, never a new revision or history entry; measured entries left
// as they are; the config-backed default's stored part takes it the same way.
test("recordLaunch keeps the engine and the launch's entry without a new revision; measured entries stay", () => {
  const store = makeStore();
  const p = store.create({ name: "berlin" });
  const item = { field: "screen", rule: "profile.map", class: "C", status: "derived", requested: null, measured: null, severity: "info", reason: "this computer's" };
  const entry = (at, items = [item]) => ({ status: "unverified", at, pack: null, items });
  assert.equal(store.recordLaunch(p.id, { engine: { major: "150", build: "150.0.7871.114" }, build: "150.0.7871.114", entry: entry("2026-10-21T11:00:00Z") }), true);
  let r = store.get(p.id);
  assert.deepEqual(r.engine, { major: "150", build: "150.0.7871.114" });
  assert.deepEqual(r.validation["150.0.7871.114"], entry("2026-10-21T11:00:00Z"));
  assert.equal(r.revision, 1);
  assert.deepEqual(r.history, []);
  assert.deepEqual(store.revisions(p.id), [], "no revision file");
  assert.equal(mode(join(store.dir, `${p.id}.json`)), 0o600);
  // The same items again: nothing written (its time stays the first launch's); other items replace it.
  assert.equal(store.recordLaunch(p.id, { engine: { major: "150", build: "150.0.7871.114" }, build: "150.0.7871.114", entry: entry("2026-10-21T12:00:00Z") }), false);
  assert.equal(store.recordLaunch(p.id, { build: "150.0.7871.114", entry: entry("2026-10-21T12:00:00Z", []) }), true);
  assert.equal(store.get(p.id).validation["150.0.7871.114"].at, "2026-10-21T12:00:00Z");
  // The engine is pinned once: a later build of the same major is recorded beside it.
  store.recordLaunch(p.id, { engine: { major: "150", build: "150.0.7871.200" }, build: "150.0.7871.200", entry: entry("2026-10-21T13:00:00Z") });
  r = store.get(p.id);
  assert.deepEqual(r.engine, { major: "150", build: "150.0.7871.114" });
  assert.deepEqual(Object.keys(r.validation).sort(), ["150.0.7871.114", "150.0.7871.200"]);
  // A measured entry (Phase E) is never written over by a launch.
  const file = join(store.dir, `${p.id}.json`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.validation["150.0.7871.114"] = measuredEntry();
  writeFileSync(file, JSON.stringify(raw));
  assert.equal(store.recordLaunch(p.id, { build: "150.0.7871.114", entry: entry("2026-10-21T14:00:00Z") }), false);
  assert.equal(store.get(p.id).validation["150.0.7871.114"].status, "validated");
  // An entry that isn't valid is refused, nothing written.
  refuses(() => store.recordLaunch(p.id, { build: "150.0.7871.300", entry: { status: "fine", at: "x", pack: null, items: [] } }), "PROFILE_INVALID");
  assert.equal(store.get(p.id).validation["150.0.7871.300"], undefined);
  refuses(() => store.recordLaunch("p-00000000000000ff", { build: "150.0.7871.114", entry: entry("2026-10-21T11:00:00Z") }), "PROFILE_UNKNOWN");
  // The config-backed default: its stored part takes the engine and the entry, its hash unchanged.
  const def = store.configProfile({});
  const hash = JSON.parse(readFileSync(join(store.dir, `${def.id}.json`), "utf8")).configHash;
  assert.equal(store.recordLaunch(def.id, { engine: { major: "150", build: "150.0.7871.114" }, build: "150.0.7871.114", entry: entry("2026-10-21T11:00:00Z") }), true);
  const stub = JSON.parse(readFileSync(join(store.dir, `${def.id}.json`), "utf8"));
  assert.deepEqual(stub.engine, { major: "150", build: "150.0.7871.114" });
  assert.equal(stub.configHash, hash);
  assert.equal(stub.revision, 1);
  assert.equal(store.configProfile({}).validation["150.0.7871.114"].status, "unverified");
});
