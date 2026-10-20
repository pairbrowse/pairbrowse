// Browser sessions: separate browser profiles, each with its own logins, cookies and tabs.
// "default" is the original ~/.pairbrowse/profile. Clean sessions start empty and, unless
// they're given a name to keep, are deleted when you switch away or the browser shuts down.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, renameSync, readlinkSync, lstatSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { paths, sessionProfile, sessionFile } from "./paths.mjs";
import { readJson, writeJsonAtomic, pidAlive, keepCorrupt } from "./util.mjs";
import { sessionMoved } from "./net/config.mjs";
import { PROFILE_ID, DEFAULT_PROFILE } from "./profiles/schema.mjs";

const SESSIONS = paths.sessions;
const CURRENT = paths.currentSession;

// The tool's definition lives in the catalog (tools/catalog.mjs).
export { SESSION_TOOL } from "./tools/catalog.mjs";

export function validName(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name);
}

export const isTemporary = (name) => /^clean-\d+$/.test(name);
export const profileDir = sessionProfile;
// Who used a session: people and agents, with their app and kind of computer (sessions picker).
export const peopleFile = (name) => sessionFile(name, "people.json");
export const tabsFile = (name) => sessionFile(name, "tabs.json");
// The session's timeline (daemon/timeline.mjs): pictures already sent to agents, and their index.
export const timelineDir = (name) => sessionFile(name, "timeline");
// The session's activity log (daemon/activitylog.mjs): the bar's lines, owner-only. A clean
// session's stays in memory.
export const activityFile = (name) => sessionFile(name, "activity.json");
// The session's proxy checks (daemon/network.mjs, spec server-mode C9): kept apart from its profile.
export const networkFile = (name) => sessionFile(name, "network.json");
// The browser profile the session starts with (spec server-mode D1, D13): { "profileId": "p-..." },
// owner-only. Settings live in the profile (profiles/store.mjs), never here.
export const assignmentFile = (name) => sessionFile(name, "assignment.json");
// Every file or folder of a kept session, moved by a rename and gone with a deletion.
const SESSION_FILES = [profileDir, tabsFile, peopleFile, timelineDir, activityFile, networkFile, assignmentFile];

export function currentSession() {
  try {
    const name = readFileSync(CURRENT, "utf8").trim();
    return validName(name) && !isTemporary(name) && existsSync(profileDir(name)) ? name : "default";
  } catch {
    return "default";
  }
}

export function rememberSession(name) {
  // Throwaway sessions aren't remembered: the next start goes back to the last kept one.
  if (!isTemporary(name)) writeFileSync(CURRENT, name);
}

export function listSessions() {
  mkdirSync(SESSIONS, { recursive: true, mode: 0o700 });
  const names = ["default", ...readdirSync(SESSIONS, { withFileTypes: true }).filter((d) => d.isDirectory() && validName(d.name)).map((d) => d.name)];
  return names.map((name) => ({ name, temporary: isTemporary(name), tabs: readJson(tabsFile(name))?.tabs?.length || 0 }));
}

// A session's folder, made when missing (every launch calls this). profileId: a browser profile
// (id or name, "default" in any case included) chosen for the session, through assignProfile
// (store and configSettings go with it); left out (undefined), no choice: the session keeps what
// it has, unassigned reading as the config-backed "default" profile. Only a session this call
// makes is assigned (spec D14); a session that was there already (unassigned, it runs on
// "default") is checked against its profile and refused another, never reassigned here (D13:
// the person reassigns). A new session whose assignment is refused is removed again.
export function createSession(name, profileId = undefined, { store, configSettings } = {}) {
  const made = !existsSync(profileDir(name));
  mkdirSync(profileDir(name), { recursive: true, mode: 0o700 });
  if (profileId === undefined) return;
  try {
    const now = readAssignment(name);
    if (now.problem) throw new Error(now.problem);
    if (made && now.profileId === null) { assignProfile(name, profileId, { store, configSettings }); return; }
    if (typeof store?.use !== "function") throw new Error("Assigning a browser profile needs the profile store.");
    const another = new Error(`Session "${name}" uses another browser profile already; the person reassigns a session, a new one is never put on another profile.`);
    const isDefault = typeof profileId === "string" && profileId.toLowerCase() === DEFAULT_PROFILE;
    if (now.profileId === null && isDefault) return;
    let asked;
    try { asked = store.use(profileId, { session: name, configSettings }); } catch (e) {
      // The config-backed default not made yet: not the profile an assigned session has.
      if (isDefault && e?.code === "PROFILE_UNKNOWN") throw another;
      throw e;
    }
    const same = now.profileId === null ? asked.kind === "config" : asked.id === now.profileId;
    if (!same) throw another;
  } catch (e) {
    if (made) rmSync(profileDir(name), { recursive: true, force: true });
    throw e;
  }
}

// The session's assignment: { ref, profileId, problem }. ref: what to give the profile store's use
// (the profile's id; with no file, "default", the config-backed profile, as every session was
// before profiles). profileId: the id written, null with no file. problem: why the file can't be
// used (a link or folder at its name, not JSON, not { profileId }), with ref and profileId null:
// a session whose assignment can't be read never falls back to the default.
export function readAssignment(name) {
  const file = assignmentFile(name);
  const who = `Session "${validName(name) ? name : "(that name)"}"'s browser profile assignment`;
  const refused = (why, fix = "assign the session a profile again") => ({ ref: null, profileId: null, problem: `${who} ${why}; ${fix}.` });
  let text;
  try {
    if (!lstatSync(file).isFile()) return refused("isn't a regular file (a link or folder at its name is never followed)", "remove it, then assign the session a profile again");
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return { ref: DEFAULT_PROFILE, profileId: null, problem: null };
    return refused(`couldn't be read (${e?.code || "error"})`);
  }
  let raw;
  try { raw = JSON.parse(text); } catch {
    keepCorrupt(file, text);
    return refused("isn't valid JSON (what it held is kept beside it with .corrupt added)");
  }
  const ok = !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 1 && typeof raw.profileId === "string" && PROFILE_ID.test(raw.profileId);
  if (!ok) return refused('doesn\'t hold one profile id ({ "profileId": "p-" and 16 hex digits })');
  return { ref: raw.profileId, profileId: raw.profileId, problem: null };
}

// Puts a session on a browser profile (by id or name): the store's use checks it (unknown,
// retired or unreadable refused by name, never "default" in its place), then its id is written,
// owner-only. store: profiles/store.mjs createProfileStore's; configSettings: profiles/map.mjs
// fromConfig(config), which the config-backed "default" needs to be made the first time. The
// person reassigns a session; agents only pick a profile for a new one (spec D14). Takes effect
// at the session's next start. Returns { session, profileId, profile (its name), previous (the
// id before, or null) }; throws a plain sentence (err.code PROFILE_* from the store).
export function assignProfile(name, ref, { store, configSettings } = {}) {
  if (!validName(name)) throw new Error("Session names use letters, numbers, - and _ (up to 40).");
  if (name !== "default" && !existsSync(profileDir(name))) throw new Error(`No session "${name}".`);
  if (typeof store?.use !== "function") throw new Error("Assigning a browser profile needs the profile store.");
  const record = store.use(ref, { session: name, configSettings });
  const previous = readAssignment(name).profileId;
  writeJsonAtomic(assignmentFile(name), { profileId: record.id }, { mode: 0o600 });
  return { session: name, profileId: record.id, profile: record.name, previous };
}

// The sessions assigned a profile id (the store's assignedTo: a profile in use isn't removed). A
// session without an assignment uses the config-backed default, which is never removed anyway.
export function assignedTo(profileId) {
  if (typeof profileId !== "string" || !PROFILE_ID.test(profileId)) return [];
  return listSessions().map((s) => s.name).filter((name) => readAssignment(name).profileId === profileId);
}

// config.json as written, for moving one session's network entry: the parsed object, or null when
// there is none (no file, an empty one, null). One that can't be read or parsed throws `doing`'s
// sentence: PairBrowse never rewrites a config.json it can't parse (paths.mjs saveConfig).
function configForMove(file, doing) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw new Error(`${doing}: config.json couldn't be read (${e?.code || "error"}), so the session's proxy choice in it couldn't follow. Fix config.json, then try again.`);
  }
  if (!text.trim()) return null;
  let read;
  try { read = JSON.parse(text); } catch { read = undefined; }
  if (read === null) return null;
  if (!read || typeof read !== "object" || Array.isArray(read)) {
    throw new Error(`${doing}: config.json isn't valid JSON or an object { ... }, so the session's proxy choice in it couldn't follow. Fix config.json, then try again.`);
  }
  return read;
}

// The session's entry in config.json's network.sessions follows a rename (to) or goes with a
// deletion (to null) (spec server-mode C4; net/config.mjs sessionMoved), written before any file
// moves so a session never starts on another network than its own: a rename that lost it could
// start the session direct, a deletion that kept it would hand its choice (direct, say) to the next
// session of that name. Returns undo() (puts the block back as it was) or null when nothing
// changed. Throws a plain sentence (doing: what it is part of), nothing written.
function moveNetworkEntry(from, to, doing, file = paths.config) {
  const config = configForMove(file, doing);
  if (!config) return null;
  const before = config.network;
  const after = sessionMoved(before, from, to);
  if (!after) return null;
  try { writeJsonAtomic(file, { ...config, network: after }); } catch (e) {
    throw new Error(`${doing}: config.json couldn't be written (${e?.code || "error"}), so the session's proxy choice in it couldn't follow.`);
  }
  return () => {
    const now = configForMove(file, doing);
    if (now) writeJsonAtomic(file, { ...now, network: before });
  };
}

// A clean session's name is never used again: its map entry, if any, is left as it is, and its
// deletion (at a switch, at startup) never fails on config.json.
export function deleteSession(name) {
  if (name === "default") throw new Error("The default session can't be deleted.");
  if (!isTemporary(name)) moveNetworkEntry(name, null, `Session "${name}" wasn't deleted`);
  for (const of of SESSION_FILES) rmSync(of(name), { recursive: true, force: true });
  rmSync(`${activityFile(name)}.tmp`, { force: true });
}

// A kept session's new name (the person's rename on the session card; the browser is closed
// meanwhile): its profile folder, tabs, people, timeline, activity log and proxy checks move, and
// its entry in config.json's network.sessions follows it. Throws with a plain sentence. A move
// that fails puts back the ones already made, the map entry too.
// Whether anything of a session by this name is on disk (its profile, tabs, people, timeline,
// activity or proxy checks), listed or not: a rename never moves onto it.
export const sessionFilesExist = (name) => SESSION_FILES.some((of) => existsSync(of(name)));
export function renameSession(from, to) {
  if (from === "default") throw new Error("The default session keeps its name; start a named session to name it.");
  if (isTemporary(from)) throw new Error("A clean session can't be renamed: it is deleted when you switch away.");
  if (!validName(from) || !existsSync(profileDir(from))) throw new Error(`No session "${from}".`);
  if (!validName(to)) throw new Error("Session names use letters, numbers, - and _ (up to 40).");
  if (to === "default" || isTemporary(to)) throw new Error(`"${to}" is a name PairBrowse keeps for itself; choose another.`);
  const caseOnly = to !== from && to.toLowerCase() === from.toLowerCase();
  if (to === from) return;
  if (!caseOnly && listSessions().some((s) => s.name.toLowerCase() === to.toLowerCase())) throw new Error(`Session "${to}" already exists; choose another name.`);
  if (!caseOnly && sessionFilesExist(to)) throw new Error(`Session "${to}" already exists; choose another name.`);
  const undoNetwork = moveNetworkEntry(from, to, `Session "${from}" wasn't renamed`);
  const moved = [];
  try {
    for (const of of SESSION_FILES) {
      if (!existsSync(of(from))) continue;
      renameSync(of(from), of(to));
      moved.push(of);
    }
  } catch (e) {
    for (const of of moved.reverse()) { try { renameSync(of(to), of(from)); } catch {} }
    try { undoNetwork?.(); } catch {}
    throw new Error(`Couldn't rename session "${from}": ${e?.message || e}`);
  }
  try { if (readFileSync(CURRENT, "utf8").trim() === from) rememberSession(to); } catch {}
}

// Whether a browser has a session's profile open now: the engine's SingletonLock in the profile (or
// the native browser's own profile inside it), a link to "<host>-<pid>". A lock this computer left
// behind (its process gone, a crash) doesn't count; one from another host or an unreadable one
// does. A saved session is renamed only while nothing has it open (context.mjs renameSaved).
export function profileInUse(name, { host = hostname(), alive = pidAlive } = {}) {
  for (const dir of [profileDir(name), join(profileDir(name), "pairbrowse-native")]) {
    let target;
    try { target = readlinkSync(join(dir, "SingletonLock")); } catch (e) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") continue;
      if (existsSync(join(dir, "SingletonLock"))) return true; // there, but not a link: in use
      continue;
    }
    const m = /^(.*)-(\d+)$/.exec(String(target));
    if (!m || m[1] !== host) return true;
    if (alive(Number(m[2]))) return true;
  }
  return false;
}

const PEOPLE_MAX = 12;
const short = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, n);
// Most recent first. Each: { who, app, computer, kind ("you", "agent", "guest", "host"), at }.
export function readPeople(name) {
  const list = readJson(peopleFile(name))?.people;
  return Array.isArray(list) ? list.filter((p) => p && typeof p.who === "string").slice(0, PEOPLE_MAX) : [];
}
// Names and kinds only: never what they did or where.
export function recordPerson(name, person, now = Date.now()) {
  if (!validName(name) || isTemporary(name)) return; // a throwaway session is gone after use
  const p = { who: short(person.who, 40), app: short(person.app, 24), computer: short(person.computer, 12), kind: short(person.kind, 8), at: now };
  if (!p.who) return;
  const same = (x) => x.who === p.who && x.app === p.app && x.computer === p.computer && x.kind === p.kind;
  const people = [p, ...readPeople(name).filter((x) => !same(x))].slice(0, PEOPLE_MAX);
  try { writeJsonAtomic(peopleFile(name), { people }); } catch {}
}

// Throwaway sessions left behind (by a crash, or at shutdown).
export function sweepTemporary() {
  for (const s of listSessions()) if (s.temporary) deleteSession(s.name);
}
