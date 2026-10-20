// The browser profile each launch starts on (spec server-mode Phase D, section 3.2 step 2; D2, D10,
// D13): forLaunch(session, { browserKind, build, pack }) reads the session's assignment
// (sessions.mjs readAssignment; none: the config-backed "default"), takes the profile through the
// store's use (unknown, retired or unreadable refused by name, never "default" in its place),
// checks the session's binding (pairbrowse-binding.json in its folder: a profile other than the
// one it names refuses the launch, never re-stamped; the first start writes it), the engine the
// profile ran on (another major refuses, another build launches unverified) and, with
// requireValidatedProfiles, that this build's validation is "validated" with no error item; then
// maps the profile to the launch's parts (profiles/map.mjs toLaunch: a field the browser can't
// apply refuses, D11). It answers what launch.mjs passes on: the switches (after browserArgs), the
// engine layer (engineKeys, geoip and the profile id the persona is saved under, native-engine.mjs),
// the network id (daemon/network.mjs profileNetwork) and the ad blocker choice. Every refusal
// throws one sentence naming the session and the profile; nothing has started by then.
//
// Isolation is the engine's own (D2): one user-data-dir per session per browser kind and one live
// browser per helper (browser/state.mjs); the persona is per process, so this part holds one
// profile at a time: the running browser's (statusParts) until release().
import { readAssignment, readBinding, writeBinding, validName, assignedTo } from "../../sessions.mjs";
import { createProfileStore } from "../../profiles/store.mjs";
import { fromConfig, toLaunch, ENGINE_KEYS } from "../../profiles/map.mjs";
import { PROFILE_ID } from "../../profiles/schema.mjs";

// A native build's version as validation keys it (profiles/schema.mjs BUILD).
const BUILD = /^\d{1,4}(?:\.\d{1,6}){3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const shown = (s) => (typeof s === "string" && (PROFILE_ID.test(s) || validName(s)) ? s : "(that name)");

// The warning every launch of a profile imported with license "unknown" gives (step 35).
export const unknownLicense = (name) => `browser profile "${shown(name)}" was imported with license "unknown": PairBrowse can't tell under which terms its settings may be used; import it again with --license naming them`;

// st: the browser's state (st.profile: the running browser's profile, or null). deps: config (the
// helper's config.json, read at each launch), log, profileStore (profiles/store.mjs
// createProfileStore's; the helper's own home's when left out); tests pass now and platform.
export function createProfiles(st, deps = {}) {
  const { config = {}, log = () => {}, profileStore = null } = deps;
  const { now = Date.now, platform = process.platform } = deps;
  const store = profileStore || createProfileStore({ assignedTo });
  st.profile = null;

  function forLaunch(session, { browserKind, build = null, pack = null } = {}) {
    st.profile = null;
    const native = browserKind === "pairbrowse";
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

    // D10: the engine the profile first ran on, and what is known of it on this build.
    const engine = native && typeof build === "string" && BUILD.test(build) ? { major: build.split(".")[0], build } : null;
    // The config-backed default isn't held to its pin until step 38 brings validate and migrate:
    // nothing could clear it, so every desktop start would stop at the next engine major. It starts
    // unverified there, the pin kept as evidence.
    const otherMajor = engine && record.engine && record.engine.major !== engine.major;
    if (otherMajor && record.kind === "config") log(`launch: ${named} was made on engine ${record.engine.major}; this browser is engine ${engine.major}, so it starts unverified`);
    else if (otherMajor) {
      throw refuse(`${named} was made on engine ${record.engine.major} (build ${record.engine.build}), and this browser is engine ${engine.major} (build ${engine.build}): re-validate the profile on this build or migrate it; nothing was started.`);
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

    // The first start on this profile binds the folder to it (refused if it can't: never a launch
    // whose binding isn't on disk).
    if (!bound.profileId) {
      try { writeBinding(session, record.id, now()); } catch (e) { throw refuse(`its binding to ${named} couldn't be written (${e?.code || "error"}).`); }
    }
    // The evidence of this launch, kept with the profile for its build (no new revision).
    if (engine) {
      try {
        store.recordLaunch(record.id, { engine, build: engine.build, entry: { status: "unverified", at: new Date(now()).toISOString(), pack: typeof pack === "string" && SHA256.test(pack) ? pack : null, items: mapped.results.slice(0, 500) } });
      } catch (e) { log(`launch: ${named}: what this launch found wasn't kept (${e?.code || "error"})`); }
    }

    const warnings = record.license === "unknown" ? [unknownLicense(record.name)] : [];
    for (const w of warnings) log(`launch: warning: ${w}`);
    log(`launch: ${who} on ${named}, revision ${record.revision}, ${status}${engine ? ` on ${engine.build}` : native ? "" : " (open build)"}`);
    st.profile = { session, id: record.id, name: record.name, kind: record.kind, revision: record.revision, status, build: engine?.build || null, browserKind, warnings };
    return {
      id: record.id, name: record.name, kind: record.kind, revision: record.revision, status, build: engine?.build || null,
      switches: mapped.switches, network: mapped.network, adBlocker: mapped.adBlocker, results: mapped.results, warnings,
      // The engine layer native-engine.mjs reads (config.browserProfile): only the mapper's keys.
      engine: { id: record.id, kind: record.kind, geoip: mapped.geoip, engineKeys: Object.fromEntries(Object.entries(mapped.engineKeys).filter(([k]) => ENGINE_KEYS.includes(k))) },
    };
  }

  // The running browser closed, or its launch failed: no profile is in use.
  function release() { st.profile = null; }

  // pairbrowse_status's part: "Profile: <name> (rev <n>, <status> on <build>)", and its warnings.
  function statusParts() {
    const p = st.profile;
    if (!p) return [];
    const on = p.build || (p.browserKind === "pairbrowse" ? "this build" : "the open build");
    return [`Profile: ${p.name} (rev ${p.revision}, ${p.status} on ${on})`, ...p.warnings.map((w) => `warning: ${w}`)];
  }

  // Every profile (the store's list): what agents may pick from (D14).
  const list = () => store.list();

  return { forLaunch, release, statusParts, list, store };
}
