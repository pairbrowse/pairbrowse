// The browser profile each launch starts on (spec server-mode Phase D, section 3.2 step 2; D2, D10,
// D13): forLaunch(session, { browserKind, build, pack }) reads the session's assignment
// (sessions.mjs readAssignment; none: the config-backed "default"), takes the profile through the
// store's use (unknown, retired or unreadable refused by name, never "default" in its place),
// checks the session's binding (pairbrowse-binding.json in its folder: a profile other than the
// one it names refuses the launch, never re-stamped; the first start writes it), the engine the
// profile ran on (another major refuses a store profile; the config-backed default is held to
// this one, as the person's check would; another build launches unverified) and, with
// requireValidatedProfiles, that this build's validation is "validated" with no error item; then
// maps the profile to the launch's parts (profiles/map.mjs toLaunch: a field the browser can't
// apply refuses, D11). It answers what launch.mjs passes on: the switches (after browserArgs), the
// engine layer (engineKeys, geoip and the profile id the persona is saved under, native-engine.mjs),
// the network id (daemon/network.mjs profileNetwork) and the ad blocker choice. Every refusal
// throws one sentence naming the session and the profile; nothing has started by then.
//
// Isolation is the engine's own (D2): one user-data-dir per session per browser kind and one live
// browser per helper (browser/state.mjs); the persona is per process, so this part holds one
// profile at a time: the running browser's (statusParts) until release(). A profile that pins a
// seed takes its identity lock (profiles/lock.mjs, D3) for as long as its browser runs, so it is
// one browser at a time across the instances of one shared home.
//
// The helper's own home (no profileStore given) is migrated to profiles before its first launch
// (profiles/migrate.mjs ensureMigrated, which also points the engine pack at engine-profiles/):
// launch.mjs calls prepare() before it installs or checks a native build, since the pack reads
// those folders once, when it first loads (an install's self-check loads it in this process). A
// migration that fails is put back and the launch runs on, with a warning in the log and status.
// owner: the person's operations on the sessions page (profile-owner.mjs), never an agent's.
import { readAssignment, readBinding, writeBinding, validName, assignedTo } from "../../sessions.mjs";
import { createProfileStore } from "../../profiles/store.mjs";
import { fromConfig, toLaunch, ENGINE_KEYS } from "../../profiles/map.mjs";
import { PROFILE_ID } from "../../profiles/schema.mjs";
import { cliCommand } from "../../profiles/validate.mjs";
import { takeIdentity } from "../../profiles/lock.mjs";
import { ensureMigrated, readMigration, migrationNote } from "../../profiles/migrate.mjs";
import { createProfileOwner } from "./profile-owner.mjs";

// A native build's version as validation keys it (profiles/schema.mjs BUILD).
const BUILD = /^\d{1,4}(?:\.\d{1,6}){3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const shown = (s) => (typeof s === "string" && (PROFILE_ID.test(s) || validName(s)) ? s : "(that name)");

// The warning every launch of a profile imported with license "unknown" gives (step 35).
export const unknownLicense = (name) => `browser profile "${shown(name)}" was imported with license "unknown": PairBrowse can't tell under which terms its settings may be used; import it again with --license naming them`;

// st: the browser's state (st.profile: the running browser's profile, or null). deps: config (the
// helper's config.json, read at each launch), log, profileStore (profiles/store.mjs
// createProfileStore's; the helper's own home's when left out); tests pass now, platform, env (the
// environment the engine pack's folders are set in) and migrateHome (ensureMigrated's place).
export function createProfiles(st, deps = {}) {
  const { config = {}, log = () => {}, profileStore = null } = deps;
  const { now = Date.now, platform = process.platform, identityDir, env = process.env, migrateHome = ensureMigrated } = deps;
  const store = profileStore || createProfileStore({ assignedTo });
  // Only the helper's own home is migrated (tests hand their own store and no migration).
  let migration = profileStore ? { done: true, problem: null } : null;
  st.profile = null;

  // Once per helper, before its first launch and before the engine pack loads: the home's migration
  // (see the header). native: a native build is chosen here (the default's settings depend on it).
  function prepare({ native = false } = {}) {
    if (migration) return;
    const r = migrateHome({ config, native, platform, store, now, env });
    migration = { done: !r.problem, problem: r.problem };
    if (r.problem) log(`launch: warning: ${r.problem}`);
    else if (r.ran) log(`launch: sessions moved to browser profiles (each on "default"); ${r.record.notCarried.length ? `config.json's ${r.record.notCarried.join(", ")} stay out of it` : "everything config.json gives is in it"}`);
  }

  function forLaunch(session, { browserKind, build = null, pack = null } = {}) {
    release();
    const native = browserKind === "pairbrowse";
    prepare({ native });
    const who = `Session "${shown(session)}"`;
    const refuse = (why) => new Error(`${who} doesn't start: ${why}`);

    const assigned = readAssignment(session);
    if (assigned.problem) throw refuse(assigned.problem);
    const record = store.use(assigned.ref, { session, configSettings: fromConfig(config, { native, platform }) });
    const named = `browser profile "${record.name}" (${record.id})`;

    // D13: the folder's own record of its profile. Never written over by a launch.
    const bound = readBinding(session);
    if (bound.problem) throw refuse(bound.problem);
    if (bound.profileId && bound.profileId !== record.id) {
      throw refuse(`its browser folder is bound to browser profile ${bound.profileId}, and it is assigned ${named}. A launch never binds it anew; the person reassigns the session to put it on another profile.`);
    }

    // D10: the engine the profile is held to, and what is known of it on this build. Another major
    // refuses a store profile: the person checks it on this build (cli.mjs validate, the sessions
    // page's Check), which holds it to this one. The config-backed default is held to this build
    // by the launch itself (below), with a log line: its settings are config.json's, read anew at
    // every launch, so the person's check would map the same settings this launch maps and refuses
    // on, and a desktop is never stopped at an engine update with its Check in the browser that
    // didn't start.
    const engine = native && typeof build === "string" && BUILD.test(build) ? { major: build.split(".")[0], build } : null;
    const repin = !!(engine && record.engine && record.engine.major !== engine.major);
    if (repin && record.kind !== "config") {
      throw refuse(`${named} was made on engine ${record.engine.major} (build ${record.engine.build}), and this browser is engine ${engine.major} (build ${engine.build}): re-validate the profile on this build (Check on the Sessions page, or ${cliCommand(`validate ${record.id}`)}) or migrate it to another profile; nothing was started.`);
    }
    const prior = engine ? record.validation?.[engine.build] || null : null;
    const status = prior?.status || "unverified";

    const mapped = toLaunch(record, { browserKind, platform });
    if (mapped.problem) throw refuse(mapped.problem);

    if (config.requireValidatedProfiles === true) {
      const on = engine ? `build ${engine.build}` : native ? "this build" : "the open build";
      if (status !== "validated") throw refuse(`${named} is ${status} on ${on}, and requireValidatedProfiles is on in config.json: validate the profile on it first${native ? "" : " (the open build's launches are never validated)"}; nothing was started.`);
      const errors = (prior.items || []).filter((i) => i.severity === "error");
      if (errors.length) throw refuse(`${named} has ${errors.length === 1 ? "an error" : `${errors.length} errors`} in its checks on ${on} (${errors.map((i) => i.field).join(", ")}), and requireValidatedProfiles is on in config.json; nothing was started.`);
    }

    // D3: a pinned seed is one device, in one browser at a time across instances (given back by
    // release(), or taken over once its holder is gone).
    const seed = record.persona?.seed;
    let identity = null;
    if (typeof seed === "string" && seed) {
      try { identity = takeIdentity(seed, { session, profileId: record.id, name: record.name }, identityDir ? { dir: identityDir } : {}); } catch (e) { throw refuse(e.message); }
    }
    // The first start on this profile binds the folder to it (refused if it can't: never a launch
    // whose binding isn't on disk).
    if (!bound.profileId) {
      try { writeBinding(session, record.id, now()); } catch (e) { identity?.release(); throw refuse(`its binding to ${named} couldn't be written (${e?.code || "error"}).`); }
    }
    // The evidence of this launch, kept with the profile for its build (no new revision); the
    // default on a new major held to this build (store.repin: a history entry by "config").
    if (engine) {
      const entry = { status: "unverified", at: new Date(now()).toISOString(), pack: typeof pack === "string" && SHA256.test(pack) ? pack : null, items: mapped.results.slice(0, 500) };
      try {
        if (repin) {
          store.repin(record.id, { engine, build: engine.build, entry, by: "config" });
          log(`launch: ${named} was made on engine ${record.engine.major} (build ${record.engine.build}); its settings are config.json's, so it is held to engine ${engine.major} (build ${engine.build}) now, unverified`);
        } else store.recordLaunch(record.id, { engine, build: engine.build, entry });
      } catch (e) { log(`launch: ${named}: what this launch found wasn't kept (${e?.code || "error"})`); }
    }

    const warnings = record.license === "unknown" ? [unknownLicense(record.name)] : [];
    for (const w of warnings) log(`launch: warning: ${w}`);
    log(`launch: ${who} on ${named}, revision ${record.revision}, ${status}${engine ? ` on ${engine.build}` : native ? "" : " (open build)"}`);
    st.profile = { session, id: record.id, name: record.name, kind: record.kind, revision: record.revision, status, build: engine?.build || null, browserKind, warnings, identity };
    return {
      id: record.id, name: record.name, kind: record.kind, revision: record.revision, status, build: engine?.build || null,
      switches: mapped.switches, network: mapped.network, adBlocker: mapped.adBlocker, results: mapped.results, warnings,
      // The engine layer native-engine.mjs reads (config.browserProfile): only the mapper's keys.
      engine: { id: record.id, kind: record.kind, geoip: mapped.geoip, engineKeys: Object.fromEntries(Object.entries(mapped.engineKeys).filter(([k]) => ENGINE_KEYS.includes(k))) },
    };
  }

  // The running browser closed, or its launch failed: no profile is in use, its identity lock given back.
  function release() {
    try { st.profile?.identity?.release(); } catch {}
    st.profile = null;
  }

  // pairbrowse_status's part: "Profile: <name> (rev <n>, <status> on <build>)", its warnings, the
  // migration's notes until dismissed, and a migration that failed.
  function statusParts() {
    const p = st.profile;
    const out = [];
    if (p) {
      const on = p.build || (p.browserKind === "pairbrowse" ? "this build" : "the open build");
      out.push(`Profile: ${p.name} (rev ${p.revision}, ${p.status} on ${on})`, ...p.warnings.map((w) => `warning: ${w}`));
    }
    if (migration?.problem) out.push(`warning: ${migration.problem}`);
    else if (migration?.done && !profileStore) { const note = migrationNote(readMigration()); if (note) out.push(note); }
    return out;
  }

  // Every profile (the store's list): what agents may pick from (D14).
  const list = () => store.list();
  // What config.json gives the config-backed default now, for an assignment made between launches.
  const configSettings = (native) => fromConfig(config, { native, platform });

  const api = { prepare, forLaunch, release, statusParts, list, store, configSettings };
  api.owner = createProfileOwner(st, { config, log, store, platform, now, configSettings });
  return api;
}
