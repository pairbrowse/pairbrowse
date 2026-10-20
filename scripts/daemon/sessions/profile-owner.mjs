// The person's browser profile operations on the sessions page (spec server-mode D14, step 38):
// the owner-only routes (liveview/routes/profiles.mjs) call these, never an agent (agents list
// profiles and pick one for a new session through pairbrowse_session, nothing else).
//   state(): every profile (the store's list) and which profile each kept session is on.
//   assign(session, ref): puts a saved session that isn't open on a profile (sessions.mjs
//     assignProfile: assignment and binding together, the old profile's persona removed); takes
//     effect at its next start. The open session, a clean one and one another browser has open are
//     refused.
//   importFile(bytes, host): one profile file (profiles/import.mjs importInto: checked, settings
//     only, its SHA-256, source and license kept). host: { file, source, license, terms, name, dryRun }.
//   exportOne(ref, options): a pairbrowse-profile/1 file's text (profiles/export.mjs).
//   validate(ref): checks the profile on the native build installed now and holds it to that build
//     (profiles/validate.mjs).
// Each answers { ... } or { error } (a sentence; never a setting's value).
import { listSessions, readAssignment, assignProfile, isTemporary, profileInUse, validName } from "../../sessions.mjs";
import { importInto } from "../../profiles/import.mjs";
import { exportProfile } from "../../profiles/export.mjs";
import { validateProfile, installedBuild } from "../../profiles/validate.mjs";
import { nativeManifest } from "../../native-engine.mjs";
import { NATIVE } from "../../native-pack.mjs";
import { DEFAULT_PROFILE } from "../../profiles/schema.mjs";

const error = (e) => ({ error: String(e?.message || e || "That didn't work.") });

// st: the browser's state (st.session, st.contextPromise, st.engine, st.profile). deps: config,
// log, store, platform, now, configSettings(native).
export function createProfileOwner(st, { config = {}, log = () => {}, store, platform = process.platform, now = Date.now, configSettings }) {
  // Whether the native build is the one in use (the last launch's), for the default's settings.
  const native = () => st.profile?.browserKind === "pairbrowse" || st.engine?.browserEngine === "pairbrowse";
  // A profile by name or id, the config-backed default made from config.json when it never was.
  const use = (ref) => {
    try { return store.use(ref); } catch (e) {
      if (e?.code === "PROFILE_UNKNOWN" && String(ref).toLowerCase() === DEFAULT_PROFILE) return store.use(ref, { configSettings: configSettings(native()) });
      throw e;
    }
  };

  function state() {
    const profiles = store.list().map((r) => (r.problem ? { id: r.id, problem: r.problem } : { id: r.id, name: r.name, kind: r.kind, revision: r.revision, status: r.status, engine: r.engine || null }));
    const names = new Map(profiles.filter((p) => p.name).map((p) => [p.id, p.name]));
    const defaultId = profiles.find((p) => p.kind === "config")?.id || null;
    const sessions = listSessions().filter((s) => !s.temporary).map(({ name }) => {
      const a = readAssignment(name);
      if (a.problem) return { name, profileId: null, profile: null, problem: a.problem };
      const id = a.profileId || defaultId;
      return { name, profileId: id, profile: a.profileId ? names.get(a.profileId) || null : DEFAULT_PROFILE, problem: null };
    });
    return { profiles, sessions, current: st.session };
  }

  function assign(session, ref) {
    try {
      const name = String(session ?? "");
      if (!validName(name) || !listSessions().some((s) => s.name === name)) return { error: `No session "${validName(name) ? name : "(that name)"}".` };
      if (isTemporary(name)) return { error: "A clean session starts on the default profile and is deleted when you switch away; keep a named session to give it a profile." };
      if (name === st.session && st.contextPromise) return { error: `Session "${name}" is open now; switch to another session first, then put it on another profile.` };
      if (profileInUse(name)) return { error: `Session "${name}" is open in another browser; close it there first.` };
      if (typeof ref !== "string" || !ref) return { error: "Name a browser profile." };
      const record = use(ref);
      const r = assignProfile(name, record.id, { store });
      log(`profiles: the person put session ${name} on browser profile ${record.name} (${record.id})`);
      return { ok: true, session: name, profileId: r.profileId, profile: r.profile, text: `Session "${name}" starts on browser profile "${r.profile}" from its next start.` };
    } catch (e) { return error(e); }
  }

  function importFile(bytes, host = {}) {
    try {
      const r = importInto(store, bytes, { ...host, at: new Date(now()).toISOString() });
      if (!r.dryRun) log(`profiles: the person imported browser profile ${r.profile.name} (${r.profile.id}), ${r.format}, license ${r.license}`);
      return { ok: true, dryRun: r.dryRun, name: r.name, id: r.profile?.id || null, format: r.format, license: r.license, unverified: r.unverified,
        items: r.items.map(({ field, status, severity, reason }) => ({ field, status, severity, reason })) };
    } catch (e) {
      const items = (e?.report?.items || []).map(({ field, status, severity, reason }) => ({ field, status, severity, reason }));
      return { error: String(e?.message || e), items };
    }
  }

  function exportOne(ref, { withHistory = false, includeIdentity = false } = {}) {
    try {
      // The config-backed default's whole record: its settings as config.json gives them now.
      let whole = use(ref);
      if (whole.kind === "config") whole = store.use(whole.id, { configSettings: configSettings(native()) });
      const out = exportProfile(whole, { withHistory, includeIdentity, at: new Date(now()).toISOString() });
      log(`profiles: the person exported browser profile ${whole.name} (${whole.id})`);
      return { ok: true, fileName: `${whole.name}.pairbrowse-profile.json`, text: out.text, sha256: out.sha256, warnings: out.warnings };
    } catch (e) { return error(e); }
  }

  async function validate(ref) {
    try {
      let on = null;
      if (st.engine?.browserEngine === "pairbrowse" && st.engine.executablePath) {
        try { on = { build: nativeManifest(st.engine.executablePath).version, pack: NATIVE.engine?.sha256 || null }; } catch {}
      }
      on ||= await installedBuild(config);
      if (on.problem) return { error: on.problem };
      const r = validateProfile(store, ref, { ...on, configSettings: configSettings(true), platform, now });
      log(`profiles: the person checked browser profile ${r.name} (${r.id}) on build ${r.build}`);
      const from = r.from && r.from.build !== r.build ? ` (it was held to build ${r.from.build})` : "";
      return { ok: true, id: r.id, name: r.name, build: r.build, status: r.status,
        text: `Browser profile "${r.name}" applies on build ${r.build}${from} and starts there now; it stays unverified until PairBrowse measures this build.` };
    } catch (e) { return error(e); }
  }

  return { state, assign, importFile, exportOne, validate };
}
