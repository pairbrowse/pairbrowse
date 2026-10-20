// The browser profile each launch starts on (spec server-mode Phase D, section 3.2 step 2; D2, D10,
// D13; daemon/sessions/profiles.mjs): the session's assignment through the store, its binding
// (written at the first start, never re-stamped), the engine the profile ran on, requireValidated-
// Profiles, the mapping's refusals, the evidence kept without a new revision, the status part,
// reassignment rewriting the binding and the persona, and the wiring through createContext.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { EventEmitter } from "node:events";
import { createProfiles, unknownLicense } from "../scripts/daemon/sessions/profiles.mjs";
import { createProfileStore } from "../scripts/profiles/store.mjs";
import { fromConfig, THIS_COMPUTER_NOTE } from "../scripts/profiles/map.mjs";
import { createSession, assignProfile, assignmentFile, bindingFile, readBinding, personaFile, LEGACY_PERSONA, profileDir } from "../scripts/sessions.mjs";
import { createContext } from "../scripts/daemon/context.mjs";
import { validateProfile, cliCommand, CLI } from "../scripts/profiles/validate.mjs";
import { identityFile } from "../scripts/profiles/lock.mjs";

const dir = mkdtempSync(join(tmpdir(), "pb-session-profiles-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const T0 = Date.parse("2026-10-21T10:00:00Z");
const newStore = () => createProfileStore({ dir: join(dir, `store-${++n}`), now: () => T0 });
const BUILD = "150.0.7871.114";
const PACK = "4451781446317d6ebf675afa0d75258d826fb1f5ddf06f292a20bfc24e65f793";
const NATIVE = { browserKind: "pairbrowse", build: BUILD, pack: PACK };
const OPEN = { browserKind: "pairbrowse-open" };
const BERLIN = { name: "berlin", locale: { languages: ["de-DE", "de"], timezone: "Europe/Berlin", source: "set" }, window: { width: 1440, height: 900 } };
const parts = (store, config = {}) => {
  const st = {};
  const lines = [];
  return { st, lines, profiles: createProfiles(st, { config, log: (l) => lines.push(l), profileStore: store, now: () => T0, platform: "linux" }) };
};
const session = (name) => { createSession(name); return name; };
const raw = (store, id) => JSON.parse(readFileSync(join(store.dir, `${id}.json`), "utf8"));
const rewrite = (store, id, fn) => { const r = raw(store, id); fn(r); writeFileSync(join(store.dir, `${id}.json`), JSON.stringify(r)); };

test("the first start binds the folder to its profile; the launch's parts, evidence kept without a new revision, and the status part", () => {
  const store = newStore();
  const berlin = store.create(BERLIN);
  const name = session("sp-first");
  assignProfile(name, "berlin", { store });
  const { st, profiles, lines } = parts(store);
  const got = profiles.forLaunch(name, NATIVE);
  assert.equal(got.id, berlin.id);
  assert.deepEqual(got.switches, ["--lang=de-DE", "--window-size=1440,900"]);
  assert.deepEqual(got.engine, { id: berlin.id, kind: "store", geoip: false, engineKeys: { acceptLanguage: "de-DE,de", timezone: "Europe/Berlin" } });
  assert.equal(got.status, "unverified");
  assert.equal(got.build, BUILD);
  assert.equal(readBinding(name).profileId, berlin.id, "the assignment bound the folder (it exists)");
  // D10: the engine it first ran on and this launch's items, as evidence: no revision, no history.
  const kept = store.get(berlin.id);
  assert.deepEqual(kept.engine, { major: "150", build: BUILD });
  assert.equal(kept.revision, 1);
  assert.deepEqual(kept.history, []);
  assert.equal(kept.validation[BUILD].status, "unverified");
  assert.equal(kept.validation[BUILD].pack, PACK);
  assert.ok(kept.validation[BUILD].items.some((i) => i.field === "locale.timezone" && i.status === "applied"));
  assert.deepEqual(profiles.statusParts(), [`Profile: berlin (rev 1, unverified on ${BUILD})`]);
  assert.equal(st.profile.id, berlin.id);
  assert.ok(lines.some((l) => l.includes(`on browser profile "berlin" (${berlin.id}), revision 1, unverified on ${BUILD}`)), lines.join("\n"));
  // Nothing new on the next launch: the record isn't written again.
  const before = statSync(join(store.dir, `${berlin.id}.json`)).mtimeMs;
  const text = readFileSync(join(store.dir, `${berlin.id}.json`), "utf8");
  profiles.forLaunch(name, NATIVE);
  assert.equal(readFileSync(join(store.dir, `${berlin.id}.json`), "utf8"), text);
  assert.equal(statSync(join(store.dir, `${berlin.id}.json`)).mtimeMs, before);
  profiles.release();
  assert.deepEqual(profiles.statusParts(), []);
  // An unassigned session starts on the config-backed default and is bound to its id.
  const plain = session("sp-plain");
  const def = profiles.forLaunch(plain, OPEN);
  assert.equal(def.kind, "config");
  assert.deepEqual(readBinding(plain), { profileId: def.id, created: new Date(T0).toISOString(), problem: null }, "its first start bound it");
  assert.equal(statSync(bindingFile(plain)).mode & 0o777, 0o600);
  assert.deepEqual(profiles.statusParts(), ["Profile: default (rev 1, unverified on the open build)"]);
  assert.equal(store.get(def.id).engine, null, "the open build pins no engine");
  assert.deepEqual(profiles.list().map((p) => p.name), ["default", "berlin"]);
});

test("binding mismatch refuses, never re-stamps; a reassignment rewrites it with the assignment", () => {
  const store = newStore();
  const berlin = store.create(BERLIN);
  const tokyo = store.create({ name: "tokyo", locale: { languages: ["ja-JP"], timezone: "Asia/Tokyo", source: "set" } });
  const name = session("sp-bind");
  assignProfile(name, "berlin", { store });
  const { profiles } = parts(store);
  profiles.forLaunch(name, NATIVE);
  const bound = readFileSync(bindingFile(name), "utf8");
  // The assignment changed by hand (not through a reassignment): the folder is still berlin's.
  writeFileSync(assignmentFile(name), JSON.stringify({ profileId: tokyo.id }));
  assert.throws(() => profiles.forLaunch(name, NATIVE), (e) => e.message === `Session "${name}" doesn't start: its browser folder is bound to browser profile ${berlin.id}, and it is assigned browser profile "tokyo" (${tokyo.id}). A launch never binds it anew; the person reassigns the session to put it on another profile.`);
  assert.equal(readFileSync(bindingFile(name), "utf8"), bound, "never re-stamped");
  assert.deepEqual(profiles.statusParts(), [], "a refused launch has no profile");
  // The person's reassignment rewrites both, and the launch goes on.
  const done = assignProfile(name, "tokyo", { store });
  assert.equal(done.previous, tokyo.id);
  assert.equal(readBinding(name).profileId, tokyo.id);
  assert.equal(profiles.forLaunch(name, NATIVE).id, tokyo.id);
  // A binding that can't be read refuses (never bound anew), what it held kept aside.
  writeFileSync(bindingFile(name), "{ not json");
  assert.throws(() => profiles.forLaunch(name, NATIVE), /doesn't start: Session "sp-bind"'s profile binding \(pairbrowse-binding\.json in its folder\) isn't valid JSON .*; the person reassigns the session to bind it again\.$/);
  assert.equal(readFileSync(`${bindingFile(name)}.corrupt`, "utf8"), "{ not json");
  assert.equal(readFileSync(bindingFile(name), "utf8"), "{ not json");
  writeFileSync(bindingFile(name), JSON.stringify({ profileId: tokyo.id, created: "2026-10-21T10:00:00Z", extra: 1 }));
  assert.throws(() => profiles.forLaunch(name, NATIVE), /doesn't hold \{ "profileId", "created" \}/);
  assignProfile(name, "tokyo", { store });
  assert.equal(readBinding(name).problem, null, "a reassignment rewrites a broken binding");
  // A session folder bound to the default, assigned a store profile by hand: refused too.
  const plain = session("sp-bind-plain");
  const def = profiles.forLaunch(plain, OPEN);
  writeFileSync(assignmentFile(plain), JSON.stringify({ profileId: berlin.id }));
  assert.throws(() => profiles.forLaunch(plain, NATIVE), new RegExp(`bound to browser profile ${def.id}, and it is assigned browser profile "berlin"`));
});

test("other major refuses, other build unverified, requireValidatedProfiles refuses", () => {
  const store = newStore();
  const berlin = store.create(BERLIN);
  const name = session("sp-engine");
  assignProfile(name, "berlin", { store });
  const { profiles } = parts(store);
  profiles.forLaunch(name, NATIVE);
  // Another major: refused, naming both, nothing recorded.
  assert.throws(() => profiles.forLaunch(name, { ...NATIVE, build: "151.0.7900.10" }), (e) => e.message === `Session "${name}" doesn't start: browser profile "berlin" (${berlin.id}) was made on engine 150 (build ${BUILD}), and this browser is engine 151 (build 151.0.7900.10): re-validate the profile on this build (Check on the Sessions page, or ${cliCommand(`validate ${berlin.id}`)}) or migrate it to another profile; nothing was started.`);
  assert.equal(store.get(berlin.id).validation["151.0.7900.10"], undefined);
  // The refusal names the command line by its full path, runnable from any folder.
  assert.ok(CLI.startsWith("/") || /^[A-Za-z]:\\/.test(CLI), CLI);
  assert.ok(existsSync(CLI));
  // The config-backed default is held to the new major by the launch itself (its settings are
  // config.json's): unverified there, its history naming the change by "config", logged.
  const plain = session("sp-engine-default");
  const { profiles: own, lines: ownLines } = parts(store);
  const def = own.forLaunch(plain, NATIVE);
  assert.equal(def.kind, "config");
  const moved = own.forLaunch(plain, { ...NATIVE, build: "151.0.7900.10" });
  assert.deepEqual([moved.kind, moved.status, moved.build], ["config", "unverified", "151.0.7900.10"]);
  assert.deepEqual(store.get(def.id).engine, { major: "151", build: "151.0.7900.10" });
  assert.deepEqual(store.get(def.id).history.at(-1), { revision: store.get(def.id).revision, at: new Date(T0).toISOString(), change: ["engine"], by: "config" });
  assert.equal(store.get(def.id).validation["151.0.7900.10"].status, "unverified");
  assert.ok(ownLines.some((l) => /browser profile "default" .* was made on engine 150 \(build 150\.0\.7871\.114\); its settings are config\.json's, so it is held to engine 151 \(build 151\.0\.7900\.10\) now, unverified/.test(l)), ownLines.join("\n"));
  // Under requireValidatedProfiles it is refused there (unverified), and never re-pinned.
  const plain2 = session("sp-engine-default-strict");
  assert.throws(() => parts(store, { requireValidatedProfiles: true }).profiles.forLaunch(plain2, { ...NATIVE, build: "152.0.8000.1" }), /is unverified on build 152\.0\.8000\.1, and requireValidatedProfiles is on/);
  assert.deepEqual(store.get(def.id).engine, { major: "151", build: "151.0.7900.10" });
  // The person's check does the same for any profile (profiles/validate.mjs), by the person.
  const checked = validateProfile(store, "default", { build: "152.0.8000.1", pack: PACK, configSettings: fromConfig({}, { native: true, platform: "linux" }), platform: "linux", now: () => T0 });
  assert.deepEqual([checked.from, checked.build, checked.status], [{ major: "151", build: "151.0.7900.10" }, "152.0.8000.1", "unverified"]);
  assert.equal(store.get(def.id).history.at(-1).by, "person");
  assert.equal(own.forLaunch(plain, { ...NATIVE, build: "152.0.8000.1" }).status, "unverified");
  // Another build of the same major: unverified, the pin unchanged.
  const other = profiles.forLaunch(name, { ...NATIVE, build: "150.0.7871.200" });
  assert.equal(other.status, "unverified");
  assert.deepEqual(store.get(berlin.id).engine, { major: "150", build: BUILD });
  assert.equal(store.get(berlin.id).validation["150.0.7871.200"].status, "unverified");
  // Measured evidence (Phase E) for the pinned build: validated, and never written over by a launch.
  rewrite(store, berlin.id, (r) => { r.validation[BUILD] = { status: "validated", at: "2026-10-21T09:00:00Z", pack: PACK, items: [] }; });
  assert.equal(profiles.forLaunch(name, NATIVE).status, "validated");
  assert.deepEqual(store.get(berlin.id).validation[BUILD], { status: "validated", at: "2026-10-21T09:00:00Z", pack: PACK, items: [] });
  const strict = parts(store, { requireValidatedProfiles: true }).profiles;
  assert.equal(strict.forLaunch(name, NATIVE).status, "validated");
  assert.deepEqual(strict.statusParts(), [`Profile: berlin (rev 1, validated on ${BUILD})`]);
  assert.throws(() => strict.forLaunch(name, { ...NATIVE, build: "150.0.7871.200" }), (e) => e.message === `Session "${name}" doesn't start: browser profile "berlin" (${berlin.id}) is unverified on build 150.0.7871.200, and requireValidatedProfiles is on in config.json: validate the profile on it first; nothing was started.`);
  // An error among its checks refuses too.
  const bad = { field: "screen", rule: "screen.display", class: "C", status: "mismatch", requested: null, measured: null, severity: "error", reason: "not this screen" };
  rewrite(store, berlin.id, (r) => { r.validation[BUILD].items = [bad]; });
  assert.throws(() => strict.forLaunch(name, NATIVE), /has an error in its checks on build 150\.0\.7871\.114 \(screen\), and requireValidatedProfiles is on/);
  // A failed measurement stays failed; off, it still launches (as failed).
  rewrite(store, berlin.id, (r) => { r.validation[BUILD] = { status: "failed", at: "2026-10-21T09:00:00Z", pack: PACK, items: [bad] }; });
  assert.equal(profiles.forLaunch(name, NATIVE).status, "failed");
  assert.equal(store.get(berlin.id).validation[BUILD].status, "failed");
  // The open build's launches are never validated: refused under the switch.
  const open = session("sp-engine-open");
  assert.throws(() => strict.forLaunch(open, OPEN), /is unverified on the open build, and requireValidatedProfiles is on in config\.json: validate the profile on it first \(the open build's launches are never validated\)/);
  assert.equal(existsSync(bindingFile(open)), false, "a refused first start binds nothing");
});

test("unknown or retired profile refused by name, never the default; a field the browser can't apply refuses", () => {
  const store = newStore();
  const berlin = store.create(BERLIN);
  const old = store.create({ name: "old-one" });
  const { profiles } = parts(store);
  const name = session("sp-refuse");
  writeFileSync(assignmentFile(name), JSON.stringify({ profileId: "p-00000000000000ff" }));
  assert.throws(() => profiles.forLaunch(name, NATIVE), (e) => e.code === "PROFILE_UNKNOWN" && e.message === `Session "${name}" uses browser profile "p-00000000000000ff", which doesn't exist (it was removed, or never made); assign the session another profile.`);
  assignProfile(name, old.id, { store });
  store.retire(old.id);
  assert.throws(() => profiles.forLaunch(name, NATIVE), (e) => e.code === "PROFILE_RETIRED" && /uses browser profile "p-[0-9a-f]{16}", which is retired/.test(e.message));
  // An assignment that can't be read is never the default.
  writeFileSync(assignmentFile(name), "[]");
  assert.throws(() => profiles.forLaunch(name, NATIVE), /^Error: Session "sp-refuse" doesn't start: Session "sp-refuse"'s browser profile assignment doesn't hold one profile id/);
  // D11: berlin sets a time zone, which the open build can't apply.
  const shop = session("sp-refuse-open");
  assignProfile(shop, berlin.id, { store });
  assert.throws(() => profiles.forLaunch(shop, OPEN), /doesn't start: Browser profile "berlin" can't start on the open build: browser\.kind \(.*\); locale\.timezone \(the open build can't set a time zone\)\. Change the profile or the browser; nothing was started\.$/);
  assert.equal(readBinding(shop).profileId, berlin.id, "the assignment's own binding stays as it was");
});

test("a reassignment removes another profile's persona; the default takes over the persona every session had before profiles", () => {
  const store = newStore();
  const berlin = store.create(BERLIN);
  const tokyo = store.create({ name: "tokyo" });
  const persona = (name, who) => { mkdirSync(dirname(personaFile(name)), { recursive: true }); writeFileSync(personaFile(name), JSON.stringify({ name: who, options: { fingerprint: "seed-1" } })); };
  const a = session("sp-persona-a");
  assignProfile(a, "berlin", { store });
  persona(a, berlin.id);
  assignProfile(a, "berlin", { store });
  assert.ok(existsSync(personaFile(a)), "the same profile keeps its persona");
  assignProfile(a, "tokyo", { store });
  assert.equal(existsSync(personaFile(a)), false, "berlin's persona isn't carried over to tokyo");
  assert.equal(readBinding(a).profileId, tokyo.id);
  // A session from before profiles: its "pairbrowse" persona stays with the default.
  const configSettings = fromConfig({});
  const b = session("sp-persona-b");
  persona(b, LEGACY_PERSONA);
  assignProfile(b, "default", { store, configSettings });
  assert.ok(existsSync(personaFile(b)));
  assignProfile(b, "berlin", { store });
  assert.equal(existsSync(personaFile(b)), false, "never to a store profile");
  const c = session("sp-persona-c");
  persona(c, LEGACY_PERSONA);
  assignProfile(c, "tokyo", { store });
  assert.equal(existsSync(personaFile(c)), false);
});

test("a profile imported with license \"unknown\" warns at every launch", () => {
  const store = newStore();
  store.create({ name: "found", license: "unknown" });
  const name = session("sp-license");
  assignProfile(name, "found", { store });
  const { profiles, lines } = parts(store);
  const got = profiles.forLaunch(name, NATIVE);
  assert.deepEqual(got.warnings, [unknownLicense("found")]);
  assert.deepEqual(profiles.statusParts(), [`Profile: found (rev 1, unverified on ${BUILD})`, `warning: ${unknownLicense("found")}`]);
  profiles.forLaunch(name, NATIVE);
  assert.equal(lines.filter((l) => l === `launch: warning: ${unknownLicense("found")}`).length, 2);
});

// D9: config.json's persona "auto" or "local" is this computer; the default's status says so once,
// on the native build only (the open build never read the pairbrowse block), and a store profile's
// doesn't (it takes none of config.json's persona settings).
test("persona auto or local on the default: one status note", () => {
  const store = newStore();
  store.create(BERLIN);
  for (const selection of ["auto", "local"]) {
    const config = { browser: "pairbrowse", pairbrowse: { profile: selection } };
    const name = session(`sp-d9-${selection}`);
    const { profiles } = parts(store, config);
    profiles.forLaunch(name, NATIVE);
    const note = `note: ${THIS_COMPUTER_NOTE} (pairbrowse.profile "${selection}" in config.json)`;
    assert.deepEqual(profiles.statusParts().filter((p) => p.includes(THIS_COMPUTER_NOTE)), [note], selection);
    const open = parts(store, { browser: "pairbrowse-open", pairbrowse: { profile: selection } }).profiles;
    open.forLaunch(session(`sp-d9-open-${selection}`), OPEN);
    assert.equal(open.statusParts().some((p) => p.includes(THIS_COMPUTER_NOTE)), false, `${selection}: not on the open build`);
    const other = session(`sp-d9-store-${selection}`);
    assignProfile(other, "berlin", { store });
    profiles.forLaunch(other, NATIVE);
    assert.equal(profiles.statusParts().some((p) => p.includes(THIS_COMPUTER_NOTE)), false, `${selection}: not for a store profile`);
  }
});

test("a binding that can't be written refuses the first start and gives the identity lock back", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const store = newStore();
  store.create({ name: "pinned-bind", persona: { source: "seed", seed: "sp-bind-seed" } });
  const name = session("sp-bind-lock");
  assignProfile(name, "pinned-bind", { store });
  rmSync(bindingFile(name), { force: true });
  const identityDir = join(dir, "identity-bind");
  const st = {};
  const profiles = createProfiles(st, { config: {}, log: () => {}, profileStore: store, now: () => T0, platform: "linux", identityDir });
  // The session's browser folder read-only: the binding's write fails.
  chmodSync(dirname(bindingFile(name)), 0o500);
  try {
    assert.throws(() => profiles.forLaunch(name, NATIVE), /its binding to browser profile "pinned-bind" .* couldn't be written \(E[A-Z]+\)/);
  } finally { chmodSync(dirname(bindingFile(name)), 0o700); }
  assert.equal(existsSync(identityFile("sp-bind-seed", identityDir)), false, "the lock was given back");
  assert.equal(st.profile, null);
  assert.equal(profiles.forLaunch(name, NATIVE).name, "pinned-bind");
  assert.ok(existsSync(identityFile("sp-bind-seed", identityDir)), "taken again by the start that went on");
  profiles.release();
  assert.equal(existsSync(identityFile("sp-bind-seed", identityDir)), false);
});

// The launch (daemon/browser/launch.mjs) with a driver that records what it was given.
function recordingDriver() {
  const calls = [];
  const launchPersistentContext = async (profile, options) => {
    calls.push({ profile, options });
    const ctx = new EventEmitter();
    ctx.pages = () => [];
    ctx.addInitScript = async () => {};
    ctx.newPage = async () => { throw new Error("no pages here"); };
    ctx.browser = () => null;
    ctx.close = async () => { ctx.emit("close"); };
    return ctx;
  };
  return { chromium: { launchPersistentContext }, calls };
}
const quiet = () => {};

test("the launch starts on the session's profile: its switches after browserArgs, its window in place of the fixed size, its network id, its status part", { timeout: 30_000 }, async () => {
  const store = newStore();
  const shop = store.create({ name: "shop", browser: { kind: "pairbrowse-open" }, locale: { languages: ["de-DE"], timezone: null, source: "set" }, window: { width: 1440, height: 900 }, display: { colorScheme: "dark", reducedMotion: null }, network: "us" });
  const asked = [];
  const network = { forLaunch: (s, o) => { asked.push(o); return null; }, refusal: () => null, statusParts: () => [], strict: () => false };
  const d = recordingDriver();
  const context = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none", sessionPicker: false, browserArgs: ["--lang=fr"] }, log: quiet, chromium: d.chromium,
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet, network, profileStore: store,
  });
  const name = context.sessionName();
  createSession(name);
  assignProfile(name, "shop", { store });
  await context.getContext();
  const args = d.calls.at(-1).options.args;
  assert.deepEqual(args.filter((a) => a.startsWith("--window-size")), ["--window-size=1440,900"], "the profile's window replaces the fixed one");
  assert.ok(args.indexOf("--lang=de-DE") > args.indexOf("--lang=fr"), "the profile's switches come after browserArgs");
  assert.ok(args.includes("--force-dark-mode"));
  assert.equal(asked.at(-1).profileNetwork, "us", "the profile's network id reaches the network part");
  assert.ok(context.statusParts().includes("Profile: shop (rev 1, unverified on the open build)"), context.statusParts().join("\n"));
  assert.equal(readBinding(name).profileId, shop.id);
  assert.ok(existsSync(join(profileDir(name), "pairbrowse-binding.json")));
  await context.close();
  assert.ok(!context.statusParts().some((p) => p.startsWith("Profile:")), "the closed browser's profile is gone from status");
  // A refused profile: the browser never starts.
  writeFileSync(assignmentFile(name), JSON.stringify({ profileId: "p-00000000000000ee" }));
  const calls = d.calls.length;
  await assert.rejects(context.getContext(), /uses browser profile "p-00000000000000ee", which doesn't exist/);
  assert.equal(d.calls.length, calls);
  assert.deepEqual(context.statusParts(), []);
  assignProfile(name, "shop", { store });
});
