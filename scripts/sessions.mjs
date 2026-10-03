// Browser sessions: separate Chrome profiles, each with its own logins, cookies and tabs.
// "default" is the original ~/.pairbrowse/profile. Clean sessions start empty and, unless
// they're given a name to keep, are deleted when you switch away or the browser shuts down.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
export const tabsFile = (name) => (name === "default" ? join(paths.home, "tabs.json") : join(SESSIONS, `${name}.tabs.json`));

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
}

// Throwaway sessions left behind (by a crash, or at shutdown).
export function sweepTemporary() {
  for (const s of listSessions()) if (s.temporary) deleteSession(s.name);
}
