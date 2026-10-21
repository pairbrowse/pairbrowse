// The browser profile each launch starts on (spec server-mode Phase D, section 3.2 step 2; D2, D10,
// D13): forLaunch(session, { browserKind, build, pack }) reads the session's assignment
// (sessions.mjs readAssignment; none: the config-backed "default"), takes the profile through the
// store's use (unknown, retired or unreadable refused by name, never "default" in its place),
// checks the session's binding (pairbrowse-binding.json in its folder: a profile other than the
// one it names refuses the launch, never re-stamped; the first start writes it), the engine the
// profile ran on (another major refuses a store profile; the config-backed default is held to
// this one, as the person's check would; another build launches unverified) and, with
// requireValidatedProfiles, that this build's validation is "validated" (measured with this engine
// pack, native/validate.mjs entryStatus) with no error item; then
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
// coherence(): the running profile's open coherence items (rules/coherence.mjs, E13): its screen
// and window as sites see them (screen.believable, also kept in the launch's evidence), and the
// mismatches its measured validation on this pack found (gpu.*); a hand-off reports them (B14).
// fileValidation(entry): what the running browser's graphics checks found (daemon/browser/
// graphics.mjs, section 3.2 step 7), kept as its build's evidence; its status and coherence items
// follow. fileSelfCheck(measured): an install self-check's measurement (native/check.mjs), filed
// with the config-backed default, whose settings the self-check's browser started with;
// selfCheckArgs(): the default's mapped switches that self-check's graphics probe starts with.
// Saved card (spec server-mode B12): forLaunch answers savedCard (the profile asks for one); the
// launch decides with its key store (browser/safe-storage.mjs savedCardFor) and files the answer
// with setSavedCard, which the status part says; savedCard() is it for the browser running now
// ({ asked, on, store, line }, or null with none running or none asked).
import { readAssignment, readBinding, writeBinding, validName, assignedTo } from "../../sessions.mjs";
import { createProfileStore } from "../../profiles/store.mjs";
import { launchableBrowserArgs, browserArgsOf } from "../../browser-args.mjs";
import { fromConfig, toLaunch, ENGINE_KEYS, PICKS_THIS_COMPUTER, THIS_COMPUTER_NOTE } from "../../profiles/map.mjs";
import { PROFILE_ID, DEFAULT_PROFILE } from "../../profiles/schema.mjs";
import { cliCommand, requestOf, measuredEntry } from "../../profiles/validate.mjs";
import { entryStatus } from "../../native/validate.mjs";
import { takeIdentity } from "../../profiles/lock.mjs";
import { ensureMigrated, readMigration, migrationNote } from "../../profiles/migrate.mjs";
import { createProfileOwner } from "./profile-owner.mjs";
import { COHERENCE_RULES, screenBelievable } from "../../rules/coherence.mjs";

// A native build's version as validation keys it (profiles/schema.mjs BUILD).
const BUILD = /^\d{1,4}(?:\.\d{1,6}){3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const shown = (s) => (typeof s === "string" && (PROFILE_ID.test(s) || validName(s)) ? s : "(that name)");

// The warning every launch of a profile imported with license "unknown" gives (step 35).
export const unknownLicense = (name) => `browser profile "${shown(name)}" was imported with license "unknown": PairBrowse can't tell under which terms its settings may be used; import it again with --license naming them`;

// Short words for a profile's coherence item in a hand-off's report (rules/coherence.mjs setupLines).
const COHERENCE_WORDS = { "gpu.vs-platform": "pages read a GPU this system never has", "gpu.software-as-hardware": "pages read a hardware GPU over software rendering",
  "screen.believable": "a screen or window size no real system has" };

// The open coherence items of a profile for a hand-off's report: its screen's (believable, every
// launch's) and the measured mismatches of entry (a validation entry counted for this pack, or
// null), at most 20.
function coherenceOf(believable, entry, name) {
  const measured = (entry?.items || []).filter((i) => COHERENCE_RULES[i?.rule] && i.status === "mismatch" && i.rule !== "screen.believable");
  return [...believable, ...measured].slice(0, 20).map((i) => ({ id: i.rule, severity: i.severity, text: String(i.reason || ""), words: `${COHERENCE_WORDS[i.rule] || i.rule} (browser profile "${shown(name)}")` }));
}

// The time zone and languages pages read on a launch of record (mapped: its toLaunch parts):
// { timezone, languages, geoip: { timezone, languages } }. The native build sends the profile's own
// (engine keys); the open build sets only the first language (--lang) and never the time zone;
// anything unset is this computer's (Intl), or under geoip (native only) the exit's: geoip says
// which values it supplies, since a profile's own time zone and languages still win over it
// (native-engine.mjs drops only the geoip fields the profile leaves unset).
function pagesLocale(record, mapped, native) {
  const intl = Intl.DateTimeFormat().resolvedOptions();
  const set = Array.isArray(record.locale?.languages) && record.locale.languages.length ? record.locale.languages : null;
  const zoneSet = native && typeof mapped.engineKeys?.timezone === "string";
  const timezone = zoneSet ? mapped.engineKeys.timezone : intl.timeZone;
  const languages = set ? (native ? set : set.slice(0, 1)) : [intl.locale];
  const geo = !!(native && mapped.geoip);
  return { timezone, languages, geoip: { timezone: geo && !zoneSet, languages: geo && !set } };
}

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
    // E6: measured evidence counts only for the engine pack it was measured with (its runtime key
    // is compared once the browser answers, section 3.2 step 7).
    const prior = engine ? record.validation?.[engine.build] || null : null;
    const status = entryStatus(prior, { pack: typeof pack === "string" && SHA256.test(pack) ? pack : null });

    // userArgs: config.json's browserArgs as the launch passes them (browser.mjs launchArgs), so
    // the graphics plan refuses a renderer switch that contradicts the profile's backend.
    const mapped = toLaunch(record, { browserKind, platform, userArgs: launchableBrowserArgs(browserArgsOf(config), platform) });
    if (mapped.problem) throw refuse(mapped.problem);
    // E13: the profile's screen and window as sites see them (warnings only, never a refusal: D11).
    const believable = screenBelievable(record.screen, { window: record.window }).map((c) => ({ field: c.field, rule: c.id,
      class: "C", status: "mismatch", requested: `${record.screen.width}x${record.screen.height}`, measured: null, severity: c.severity, reason: c.text }));
    const results = [...mapped.results, ...believable];

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
      const entry = { status: "unverified", at: new Date(now()).toISOString(), pack: typeof pack === "string" && SHA256.test(pack) ? pack : null, items: results.slice(0, 500) };
      try {
        if (repin) {
          store.repin(record.id, { engine, build: engine.build, entry, by: "config" });
          log(`launch: ${named} was made on engine ${record.engine.major} (build ${record.engine.build}); its settings are config.json's, so it is held to engine ${engine.major} (build ${engine.build}) now, unverified`);
        } else store.recordLaunch(record.id, { engine, build: engine.build, entry });
      } catch (e) { log(`launch: ${named}: what this launch found wasn't kept (${e?.code || "error"})`); }
    }

    const warnings = record.license === "unknown" ? [unknownLicense(record.name)] : [];
    for (const w of warnings) log(`launch: warning: ${w}`);
    // D9: config.json's persona "auto" or "local" is this computer now: one note in the status
    // while the config-backed default on the native build still says so (the launch logs it too).
    const notes = native && record.kind === "config" && PICKS_THIS_COMPUTER.includes(config.pairbrowse?.profile) ? [`note: ${THIS_COMPUTER_NOTE} (pairbrowse.profile "${config.pairbrowse.profile}" in config.json)`] : [];
    log(`launch: ${who} on ${named}, revision ${record.revision}, ${status}${engine ? ` on ${engine.build}` : native ? "" : " (open build)"}`);
    // The open coherence items: the screen's, and the measured ones of this pack (status validated
    // or failed: entryStatus counts a measurement only for its own pack).
    const coherence = coherenceOf(believable, status === "unverified" ? null : prior, record.name);
    st.profile = { session, id: record.id, name: record.name, kind: record.kind, revision: record.revision, status, build: engine?.build || null, browserKind, warnings, notes, identity, coherence, believable };
    // The measurement kept for this build and engine pack (validation[build].graphics), which the
    // launch's graphics step reads before it starts the browser (section 3.2 step 4): its runtime
    // key is compared once the browser answers (step 7).
    const stored = prior?.graphics && typeof pack === "string" && prior.pack === pack ? structuredClone(prior.graphics) : null;
    return {
      id: record.id, name: record.name, kind: record.kind, revision: record.revision, status, build: engine?.build || null,
      switches: mapped.switches, network: mapped.network, adBlocker: mapped.adBlocker, results, warnings,
      // Whether the profile asks for a saved card (the launch honors it only with a key store).
      savedCard: mapped.prefs.savedCard === true,
      // What it asked for (graphics, screen, window, locale) and the measurement kept for this
      // build and pack: the graphics steps' inputs (daemon/browser/graphics.mjs).
      request: requestOf(record), measured: stored,
      // What pages read for time zone and languages (the network check's coherence input, C13):
      // the profile's on the native build, else this computer's; a value geoip supplies follows the
      // exit, so isn't judged.
      locale: pagesLocale(record, mapped, native),
      // The engine layer native-engine.mjs reads (config.browserProfile): only the mapper's keys, and
      // the backend asked for (its switches are among the mapper's; native-engine.mjs files it in GRAPHICS).
      engine: { id: record.id, kind: record.kind, geoip: mapped.geoip, graphics: record.graphics.backend, engineKeys: Object.fromEntries(Object.entries(mapped.engineKeys).filter(([k]) => ENGINE_KEYS.includes(k))) },
    };
  }

  // The running browser closed, or its launch failed: no profile is in use, its identity lock given back.
  function release() {
    try { st.profile?.identity?.release(); } catch {}
    st.profile = null;
  }

  // pairbrowse_status's part: "Profile: <name> (rev <n>, <status> on <build>)", its warnings and
  // notes (D9's), the migration's notes until dismissed, and a migration that failed.
  function statusParts() {
    const p = st.profile;
    const out = [];
    if (p) {
      const on = p.build || (p.browserKind === "pairbrowse" ? "this build" : "the open build");
      out.push(`Profile: ${p.name} (rev ${p.revision}, ${p.status} on ${on})`, ...p.warnings.map((w) => `warning: ${w}`), ...(p.notes || []));
      if (p.savedCard?.line) out.push(p.savedCard.on ? p.savedCard.line : `warning: ${p.savedCard.line}`);
    }
    if (migration?.problem) out.push(`warning: ${migration.problem}`);
    else if (migration?.done && !profileStore) { const note = migrationNote(readMigration()); if (note) out.push(note); }
    return out;
  }

  // The launch's saved-card answer for the running profile (savedCardFor), and the browser running
  // now's: null when none runs or its profile asks for none. Logged once per launch, no card data.
  function setSavedCard(card) {
    if (!st.profile) return;
    st.profile.savedCard = card?.asked ? { asked: true, on: card.on === true, store: card.on ? String(card.store || "") : "", line: String(card.line || "") } : null;
    if (st.profile.savedCard) log(`launch: ${st.profile.savedCard.line}`);
  }
  const savedCard = () => (st.profile?.savedCard ? { ...st.profile.savedCard } : null);

  // Every profile (the store's list): what agents may pick from (D14).
  const list = () => store.list();
  // What config.json gives the config-backed default now, for an assignment made between launches.
  const configSettings = (native) => fromConfig(config, { native, platform });

  // The running profile's open coherence items (B14), [] with none running.
  const coherence = () => (st.profile?.coherence || []).map((i) => ({ ...i }));

  // The running browser's graphics verdict on its build (section 3.2 step 7): an entry with a
  // measurement of this pack and runtime key replaces the build's (store.recordValidation); one
  // without is a launch's (store.recordLaunch), and with replaceMeasured (the measurement kept was
  // of another runtime) it replaces a measured one too, so the next start measures again. The
  // running profile's status and coherence items follow the entry. A write that fails is logged,
  // never a refusal (the entry still gives the status). Returns the status.
  function fileValidation(entry, { build, replaceMeasured = false } = {}) {
    const p = st.profile;
    if (!p || !entry || typeof build !== "string") return null;
    try {
      if (entry.graphics) store.recordValidation(p.id, { build, entry });
      else store.recordLaunch(p.id, { build, entry, replaceMeasured });
    } catch (e) { log(`launch: browser profile "${shown(p.name)}": its graphics checks weren't kept (${e?.code || "error"})`); }
    p.status = entry.graphics && ["validated", "failed"].includes(entry.status) ? entry.status : "unverified";
    p.coherence = coherenceOf(p.believable || [], entry.graphics ? entry : null, p.name);
    return p.status;
  }

  // The config-backed default on the native build: its record, browserArgs and toLaunch parts.
  const defaultLaunch = () => {
    const record = store.use(DEFAULT_PROFILE, { configSettings: fromConfig(config, { native: true, platform }) });
    const userArgs = launchableBrowserArgs(browserArgsOf(config), platform);
    return { record, userArgs, mapped: toLaunch(record, { browserKind: "pairbrowse", platform, userArgs }) };
  };

  // The switches an install self-check's graphics probe starts with (native/check.mjs selfCheck
  // profileArgs): the default's mapped ones (its graphics backend among them), as its launch
  // passes them after browserArgs, so the measurement's runtime key is the launch's. [] when the
  // default doesn't map (the launch then refuses on its own).
  function selfCheckArgs() {
    try { return defaultLaunch().mapped.switches; } catch { return []; }
  }

  // An install self-check's measurement (spec step 44): kept as the config-backed default's
  // evidence for build (the self-check started config.json's settings, which are the default's),
  // through the same check as a launch's (its switches: browserArgs and the default's mapped ones
  // after them, as the self-check's probe passed them, selfCheckArgs). virtualScreen: the
  // self-check's screen on Xvfb. Whether it was kept; a failure is logged.
  function fileSelfCheck(measured, { build, pack = null, virtualScreen = null } = {}) {
    if (!measured || typeof build !== "string" || !BUILD.test(build)) return false;
    try {
      const { record, userArgs, mapped } = defaultLaunch();
      const entry = measuredEntry(record, { build, pack, measured, runtimeKey: measured.runtimeKey, platform, virtualScreen, switches: [...userArgs, ...mapped.switches], results: mapped.results, now });
      if (!entry.graphics) return false;
      store.recordValidation(record.id, { build, entry });
      log(`launch: the install check's graphics kept with browser profile "${record.name}" (${entry.status} on ${build})`);
      return true;
    } catch (e) { log(`launch: the install check's graphics weren't kept (${e?.code || e?.message || "error"})`); return false; }
  }

  const api = { prepare, forLaunch, release, statusParts, list, store, configSettings, coherence, fileValidation, fileSelfCheck, selfCheckArgs, setSavedCard, savedCard };
  api.owner = createProfileOwner(st, { config, log, store, platform, now, configSettings });
  return api;
}
