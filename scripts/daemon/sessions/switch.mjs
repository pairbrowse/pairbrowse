// Browser sessions: switching (the browser closes and reopens on the other session's profile),
// renaming, saving the open session's tabs, pairbrowse_session, and the clean session's marker.
// st: the browser's state (browser/state.mjs); api: the other parts' functions, read when called.
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { paths, INSTANCE } from "../../paths.mjs";
import { validName, isTemporary, rememberSession, listSessions, createSession, deleteSession, renameSession, sessionFilesExist, profileInUse, sweepTemporary } from "../../sessions.mjs";
import { renameRunsSession } from "../../runs.mjs";
import { within } from "../../util.mjs";
import { where } from "../where.mjs";
import { sweepCodeSignClones } from "../../native/clones.mjs";
import { harnessStarted } from "../../testenv.mjs";

// While a throwaway session is open, a marker says so: if the helper restarts, the session is
// gone and the next result tells Claude it's back on a kept one (with its logins).
const CLEAN_MARKER = paths.cleanSession;

export function createSwitch(st, deps, api) {
  const { beforeRename, hostNote, log, notify, onRenamed } = deps;
  // ---- browser sessions ----------------------------------------------------------------

  // instance: this helper's named instance (home.mjs), so the browser's pages can tell two
  // PairBrowse windows apart; absent for the default home.
  const sessionInfo = () => ({ name: isTemporary(st.session) ? "Clean session" : st.session, where: where(), temporary: isTemporary(st.session), ...(INSTANCE ? { instance: INSTANCE } : {}) });

  // renameFrom: a person's rename of the open session (renameCurrent): the browser closes, the
  // session's files move to the new name, and the same session reopens with its tabs.
  // waitMeasuring, onMeasuring: an agent's switch waits (bounded) through a graphics measurement
  // the start runs, rather than hearing it should retry (launch.mjs getContext).
  async function switchTo(name, { renameFrom = null, waitMeasuring = false, onMeasuring = () => {} } = {}) {
    if (!renameFrom && name === st.session && st.contextPromise) {
      // The open session, chosen by an agent while the picker is up: the picker goes, its tabs come back.
      if (st.pick.state === "showing") {
        const ctx = await st.contextPromise;
        api.picked(`Session "${name}" was chosen by an agent. Its tabs are reopening.`);
        await st.pick.page?.goto("about:blank").catch(() => {});
        api.restore(ctx);
      }
      return;
    }
    while (st.switching) await st.switched; // one switch at a time
    let done;
    st.switched = new Promise((r) => { done = r; });
    st.switching = true;
    let renamed = false;
    try {
      // Another switch ran first: this rename is over (nothing closed, nothing moved).
      if (renameFrom && st.session !== renameFrom) { log(`rename of session ${renameFrom} dropped: the browser is on session ${st.session} now`); return; }
      const ctx = st.contextPromise && (await st.contextPromise);
      if (ctx) {
        await st.tabTracker?.saveNow();
        await api.notePlaces();
        st.tabTracker?.stop();
        await ctx.close().catch(() => {});
      }
      if (renameFrom) {
        // Only once the browser is closed: a running browser keeps writing into its profile folder.
        await beforeRename().catch(() => {});
        try {
          renameSession(renameFrom, name);
          try { renameRunsSession(renameFrom, name); } catch (e) { log(`rename: runs: ${e?.message || e}`); }
          try { onRenamed(renameFrom, name); } catch {}
          renamed = true;
        } catch (e) {
          log(`rename of session ${renameFrom} failed: ${e?.message || e}`);
          hostNote(`Renaming the browser session "${renameFrom}" to "${name}" didn't work (${e?.message || e}); the browser reopened on "${renameFrom}".`);
          notify(`Renaming the session to "${name}" didn't work; it reopened as "${renameFrom}".`);
          name = renameFrom;
        }
      }
      const previous = st.session;
      st.session = name;
      rememberSession(name);
      if (isTemporary(name)) writeFileSync(CLEAN_MARKER, name);
      else rmSync(CLEAN_MARKER, { force: true });
      if (!renameFrom && isTemporary(previous) && previous !== name) deleteSession(previous);
      st.contextPromise = null;
    } finally {
      st.switching = false;
      done();
    }
    // An agent switching is a choice too: no picker in the next browser.
    if (!renameFrom) api.picked(`Session "${isTemporary(name) ? "clean" : name}" was chosen by an agent.`);
    if (renamed) hostNote(`The person renamed this browser session "${renameFrom}" to "${name}"; the browser restarted on it and its tabs are reopening (pairbrowse_session use ${name}).`);
    await api.getContext({ waitMeasuring, onMeasuring });
    log(renameFrom ? `session ${renameFrom} renamed to ${name}` : `switched to session ${name}`);
  }

  // A person renames the open session (the session card's pencil, POST session): checked here
  // at once, then the browser restarts on the renamed session (switchTo's rename mode) after the
  // answer went out. Returns { ok, name, from, restarting } or { error }.
  function renameCurrent(given) {
    const from = st.session;
    const to = String(given ?? "").trim();
    if (!st.contextPromise) return { error: "The browser isn't open; open it first, then rename its session." };
    if (st.switching) return { error: "The browser is switching sessions; try again in a moment." };
    if (st.restoring) return { error: "Tabs are still reopening; rename the session once they're back." };
    if (st.pick.state === "showing") return { error: "The session picker is open; pick a session first." };
    if (from === "default") return { error: "The default session keeps its name; start a named session to name it." };
    if (isTemporary(from)) return { error: "A clean session can't be renamed: it is deleted when you switch away." };
    if (to === from) return { ok: true, name: from, from, restarting: false };
    if (!validName(to)) return { error: "Session names use letters, numbers, - and _ (up to 40)." };
    if (to === "default" || isTemporary(to)) return { error: `"${to}" is a name PairBrowse keeps for itself; choose another.` };
    const caseOnly = to.toLowerCase() === from.toLowerCase();
    if (!caseOnly && (listSessions().some((s) => s.name.toLowerCase() === to.toLowerCase()) || sessionFilesExist(to))) return { error: `Session "${to}" already exists; choose another name.` };
    setImmediate(() => switchTo(to, { renameFrom: from }).catch((e) => log("rename", e?.message || e)));
    return { ok: true, name: to, from, restarting: true };
  }

  // A person renames a saved session that isn't open (the sessions page, POST session with from):
  // its files move now, nothing restarts. Refused while the browser switches (it may be opening
  // that one) and while a browser has its profile open (profileInUse); the open session goes
  // through renameCurrent. Returns { ok, name, from, restarting: false } or { error }.
  function renameSaved(fromGiven, given) {
    const from = String(fromGiven ?? "").trim();
    const to = String(given ?? "").trim();
    if (from === st.session) return renameCurrent(to);
    if (st.switching) return { error: "The browser is switching sessions; try again in a moment." };
    if (from === "default") return { error: "The default session keeps its name; start a named session to name it." };
    if (isTemporary(from)) return { error: "A clean session can't be renamed: it is deleted when you switch away." };
    if (!validName(from) || !listSessions().some((s) => s.name === from)) return { error: `No session "${from}".` };
    if (to === from) return { ok: true, name: from, from, restarting: false };
    if (profileInUse(from)) return { error: `Session "${from}" is open in another browser; close it there, then rename it.` };
    try { renameSession(from, to); } catch (e) { return { error: String(e?.message || e) }; }
    try { renameRunsSession(from, to); } catch (e) { log(`rename: runs: ${e?.message || e}`); }
    try { onRenamed(from, to); } catch {}
    hostNote(`The person renamed the saved browser session "${from}" to "${to}" (pairbrowse_session use ${to}).`);
    log(`saved session ${from} renamed to ${to} by the person`);
    return { ok: true, name: to, from, restarting: false };
  }

  // A person's Save on the session card: the open session's tabs written now (the same write a
  // person's session switch and the shutdown make). Returns { ok } or { error }.
  async function saveTabs() {
    if (!st.contextPromise) return { error: "The browser isn't open." };
    if (st.switching) return { error: "The browser is switching sessions; try again in a moment." };
    if (st.restoring) return { error: "Tabs are still reopening; save once they're back." };
    if (isTemporary(st.session)) return { error: "A clean session isn't kept: there is nothing to save." };
    if (!st.tabTracker) return { error: "Pick a session first." };
    await st.tabTracker.saveNow();
    return { ok: true };
  }

  // The browser profiles an agent may pick from (spec D14): names, kinds and status only, never a
  // setting. Retired and unreadable ones are listed as such and can't be picked.
  function profileList() {
    const rows = api.profiles.list();
    const line = (r) => (r.problem ? `  ${r.id} (can't be read: the user fixes it)` : `  ${r.name}${r.kind === "config" ? " (from config.json; new sessions get it unless told otherwise)" : ""}${r.status === "retired" ? " (retired: can't be picked)" : ""}`);
    return `Browser profiles (pick one for a new session: action "new" with name and profile; only the user makes or changes them):\n${rows.length ? rows.map(line).join("\n") : "  default (from config.json)"}`;
  }

  // An agent's switch (pairbrowse_session use and new): the start is waited for through a graphics
  // measurement it runs (bounded, launch.mjs getContext waitMeasuring), and the answer says so: ""
  // or a sentence (with a trailing space). made: what was already done, said when the browser
  // still didn't open, so the agent continues with "use" rather than making it again.
  async function agentSwitch(target, made = "") {
    let measured = false;
    const started = Date.now();
    try {
      await switchTo(target, { waitMeasuring: true, onMeasuring: () => { measured = true; } });
    } catch (e) {
      if (!made) throw e;
      throw new Error(`${made}, but its browser isn't open yet: ${e?.message || e} Continue with pairbrowse_session use ${target}.`, { cause: e });
    }
    if (!measured) return "";
    const s = Math.max(1, Math.round((Date.now() - started) / 1000));
    return `It waited ${s} s while PairBrowse measured this browser's graphics once (the first start of this browser version); nothing needs retrying. `;
  }

  // pairbrowse_session. Returns { text, error }.
  async function sessionCommand({ action, name, profile } = {}) {
    const fail = (text) => ({ text, error: true });
    const exists = () => validName(name) && listSessions().some((s) => s.name === name);
    const list = () => listSessions().map((s) => `${s.name === st.session ? "* " : "  "}${s.temporary ? "clean (throwaway)" : s.name}${s.tabs ? `, ${s.tabs} saved tab${s.tabs === 1 ? "" : "s"}` : ""}`).join("\n");
    // The open session's count is its tabs now (its file may be up to a save behind).
    if (action === "list" && st.tabTracker && !st.switching) await within(3000, st.tabTracker.saveNow()).catch(() => {});
    if (action === "list") return { text: `Browser sessions (* = in use, ${where().toLowerCase()} browser):\n${list()}` };
    if (action === "profiles") {
      try { return { text: profileList() }; } catch (e) { return fail(`The browser profiles couldn't be listed: ${e?.message || e}`); }
    }
    if (profile !== undefined && action !== "new") return fail('profile goes with action "new" only: an agent picks a profile for a new session; the user reassigns existing ones.');
    if (action === "use") {
      if (!exists()) return fail(`No session "${name}".\n${list()}`);
      const waited = await agentSwitch(name);
      return { text: `Now using session "${name}" (${where().toLowerCase()} browser). ${waited}Its tabs are reopening.` };
    }
    if (action === "new") {
      if (name !== undefined && !validName(name)) return fail("Session names use letters, numbers, - and _ (up to 40).");
      if (name && listSessions().some((s) => s.name === name)) return fail(`Session "${name}" already exists. Use it with action "use".`);
      if (profile !== undefined && (typeof profile !== "string" || !profile)) return fail('profile is a browser profile\'s name, from action "profiles".');
      const target = name || `clean-${Date.now()}`;
      // A profile chosen: the new session is assigned it (sessions.mjs createSession: unknown or
      // retired refused by name, nothing made then).
      // A profile with a setting the browser in use can't apply is refused by name before anything
      // is made (sessions/profiles.mjs fit), never left to a start that fails.
      let chosen = null;
      try {
        if (profile === undefined) createSession(target);
        else {
          // The browser the next launch starts, as the person's assignment and fit decide it.
          const configSettings = api.profiles.configSettings(api.profiles.nextNative());
          const record = api.profiles.store.use(profile, { configSettings });
          const fitted = api.profiles.fit(record);
          if (fitted?.problem) return fail(`${fitted.problem} Nothing was made: pick another profile, or tell the user which setting to change.\n${profileList()}`);
          createSession(target, profile, { store: api.profiles.store, configSettings });
          chosen = record.name;
        }
      } catch (e) { return fail(`${String(e?.message || e)}\n${profileList()}`); }
      const waited = await agentSwitch(target, name ? `Session "${name}" was created` : "The clean session was made");
      const on = chosen ? ` on browser profile "${chosen}"` : "";
      return {
        text: name
          ? `Created and switched to the new session "${name}"${on}: an empty browser with no logins.${waited ? ` ${waited.trim()}` : ""}`
          : `Switched to a clean, throwaway browser${on}: no logins, no history. It's deleted when you switch away or the browser shuts down.${waited ? ` ${waited.trim()}` : ""}`,
      };
    }
    if (action === "delete") {
      if (!exists()) return fail(`No session "${name}".`);
      if (name === st.session) return fail("That session is in use. Switch to another one first.");
      if (name === "default") return fail("The default session can't be deleted.");
      // Not while the browser switches (it may be opening that one), nor while a browser has its
      // profile open (another PairBrowse, a browser started by hand on it).
      if (st.switching) return fail("The browser is switching sessions; try again in a moment.");
      if (profileInUse(name)) return fail(`Session "${name}" is open in another browser; close it there, then delete it.`);
      // Its proxy choice in config.json goes with it (sessions.mjs); a config.json that can't be
      // rewritten keeps the whole session.
      try { deleteSession(name); } catch (e) { return fail(String(e?.message || e)); }
      return { text: `Deleted session "${name}" and its logins.` };
    }
    return fail('Use action "list", "use", "new", "delete" or "profiles".');
  }

  // At startup: throwaway sessions a crash left behind, the copies of the browser a hard stop
  // left on macOS (native/clones.mjs; in the background, never in a test run, which leaves the
  // computer's folders alone), and the note that a clean one ended.
  function startUp() {
    try { sweepTemporary(); } catch {}
    if (!harnessStarted()) sweepCodeSignClones({ log });
    if (!existsSync(CLEAN_MARKER)) return;
    rmSync(CLEAN_MARKER, { force: true });
    hostNote(`The clean session ended when the browser restarted. This is session "${st.session}" now, with its logins: switch to a new clean one (pairbrowse_session new, clean: true) if you need it.`);
  }

  return { sessionInfo, switchTo, renameCurrent, renameSaved, saveTabs, sessionCommand, startUp };
}
