// Browser sessions: separate Chrome profiles, each with its own logins, cookies and tabs.
// "default" is the original ~/.pairbrowse/profile. Clean sessions start empty and, unless
// they're given a name to keep, are deleted when you switch away or the browser shuts down.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, renameSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { paths } from "./paths.mjs";
import { readJson } from "./util.mjs";

const SESSIONS = join(paths.home, "sessions");
const CURRENT = join(paths.home, "session");

export const SESSION_TOOL = {
  name: "pairbrowse_session",
  description:
    "Browser sessions are separate browsers, each with its own logins and tabs. " +
    'action "list" shows them; "use" switches to one (name); "new" creates one: with clean:true and no name it is a ' +
    'throwaway clean browser deleted when you switch away, with a name it is kept; "delete" removes one (the user confirms). ' +
    "Switching closes the current browser window and opens the other session's tabs.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["list", "use", "new", "delete"] },
      name: { type: "string", description: "Session name: letters, numbers, - and _" },
      clean: { type: "boolean" },
    },
  },
};

export function validName(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name);
}

export const isTemporary = (name) => /^clean-\d+$/.test(name);
export const profileDir = (name) => (name === "default" ? paths.profile : join(SESSIONS, name));
// Who used a session: people and agents, with their app and kind of computer (sessions picker).
export const peopleFile = (name) => (name === "default" ? join(paths.home, "people.json") : join(SESSIONS, `${name}.people.json`));
export const tabsFile = (name) => (name === "default" ? join(paths.home, "tabs.json") : join(SESSIONS, `${name}.tabs.json`));
// The session's timeline (daemon/timeline.mjs): pictures already sent to agents, and their index.
export const timelineDir = (name) => (name === "default" ? join(paths.home, "timeline") : join(SESSIONS, `${name}.timeline`));
// The session's activity log (daemon/activitylog.mjs): the bar's lines, owner-only. A clean
// session's stays in memory.
export const activityFile = (name) => (name === "default" ? join(paths.home, "activity.json") : join(SESSIONS, `${name}.activity.json`));

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

export function createSession(name) {
  mkdirSync(profileDir(name), { recursive: true, mode: 0o700 });
}

export function deleteSession(name) {
  if (name === "default") throw new Error("The default session can't be deleted.");
  rmSync(profileDir(name), { recursive: true, force: true });
  rmSync(tabsFile(name), { force: true });
  rmSync(peopleFile(name), { force: true });
  rmSync(timelineDir(name), { recursive: true, force: true });
  rmSync(activityFile(name), { force: true });
  rmSync(`${activityFile(name)}.tmp`, { force: true });
}

// A kept session's new name (the person's rename on the session card; the browser is closed
// meanwhile): its profile folder, tabs, people, timeline and activity log move. Throws with a plain sentence.
// A move that fails puts back the ones already made.
// Whether anything of a session by this name is on disk (its profile, tabs, people, timeline or activity),
// listed or not: a rename never moves onto it.
export const sessionFilesExist = (name) => [profileDir, tabsFile, peopleFile, timelineDir, activityFile].some((of) => existsSync(of(name)));
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
  const moved = [];
  try {
    for (const of of [profileDir, tabsFile, peopleFile, timelineDir, activityFile]) {
      if (!existsSync(of(from))) continue;
      renameSync(of(from), of(to));
      moved.push(of);
    }
  } catch (e) {
    for (const of of moved.reverse()) { try { renameSync(of(to), of(from)); } catch {} }
    throw new Error(`Couldn't rename session "${from}": ${e?.message || e}`);
  }
  try { if (readFileSync(CURRENT, "utf8").trim() === from) rememberSession(to); } catch {}
}

// Whether a browser has a session's profile open now: Chromium's SingletonLock in the profile (or
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
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
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
  try { writeFileSync(peopleFile(name), JSON.stringify({ people }, null, 2)); } catch {}
}

// Throwaway sessions left behind (by a crash, or at shutdown).
export function sweepTemporary() {
  for (const s of listSessions()) if (s.temporary) deleteSession(s.name);
}
