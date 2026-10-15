// The session picker: the browser's first tab asks the person which session to use (unless an
// agent chose first), agents' first actions wait for the pick, and the person's own switches
// (the session switcher, the new tab page's chips) go through it.
// st: the browser's state (browser/state.mjs); api: the other parts' functions, read when called.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nativeProfile } from "../../engine.mjs";
import { createSession, isTemporary, listSessions, profileDir, readPeople, recordPerson, tabsFile, validName } from "../../sessions.mjs";
import { readSavedTabs } from "../../tabs.mjs";
import { readJson, sleep, within } from "../../util.mjs";
import { where } from "../where.mjs";

// The session picker: agents' first browser action waits this long for the person's pick, then
// says what it waits for, so the agent tells them in chat instead of hanging silently.
const PICK_WAIT_MS = Number(process.env.PAIRBROWSE_TEST_PICK_WAIT_MS) || 15_000;

export function createPicker(st, deps, api) {
  const { config, liveOthers, log } = deps;
  // The session picker (config sessionPicker, on by default): the browser's first tab asks the
  // person which session to use, unless an agent chose first. Never on the very first start
  // (nothing to go back to) or in a cloud container (nobody sees the window).
  // pick.state: "off", "pending" (shown at the next launch), "showing", "done".
  // Something to go back to: a browser that ran before (Chrome's "Default" folder, in the Chromium
  // profile or the native build's own: engine.mjs engineProfile), saved tabs or another kept session.
  const ranBefore = (dir) => existsSync(join(dir, "Default")) || existsSync(join(nativeProfile(dir), "Default"));

  const hasHistory = () => ranBefore(profileDir(st.session)) || listSessions().some((s) => !s.temporary && (s.name !== "default" || s.tabs > 0));

  const pick = { state: config.sessionPicker !== false && process.env.CLAUDE_CODE_REMOTE !== "true" && hasHistory() ? "pending" : "off", page: null, text: "" };

  pick.done = new Promise((r) => { pick.resolve = r; });

  st.pick = pick;

  // ---- the session picker ----------------------------------------------------------------

  // Its tab, instead of the saved tabs (they come back once the person chose this session).
  // reopened: asked for again from the side panel, in a tab of its own; the open tabs stay.
  function showPicker(ctx, { reopened = false, own = false } = {}) {
    pick.state = "showing";
    if (!reopened) st.tabTracker = null; // the saved tabs stay as they were until the person chose
    (async () => {
      // The browser may start without a window and open its first one a moment later: use that.
      for (let i = 0; !reopened && i < 20 && !ctx.pages().length; i++) await sleep(150);
      const page = reopened ? await ctx.newPage() : ctx.pages()[0] || (await ctx.newPage());
      pick.page = page;
      // The extension may still be loading right after launch: try a few times.
      for (let i = 0; i < 20 && pick.state === "showing" && !page.isClosed(); i++) {
        const at = Date.now();
        const went = await page.goto(api.pickerUrl(), { waitUntil: "domcontentloaded", timeout: 5000 }).then(() => "ok", (e) => String(e?.message || e).split("\n")[0].slice(0, 80));
        log(`launch: picker goto try ${i + 1} ${Date.now() - at} ms: ${went}`);
        if (went === "ok") break;
        await sleep(250);
      }
      await api.focusing(own, () => page.bringToFront().catch(() => {}));
      log("session picker shown");
    })().catch((e) => log("session picker", e?.message || e));
  }

  // The person asked to switch (the side panel's "End session", the right dock in the browser): the picker opens again in a
  // new tab, and agents' next actions wait for the pick as at the start. Agents can't ask for it.
  async function reopenPicker() {
    if (pick.state === "showing") { await within(3000, Promise.resolve(pick.page?.bringToFront()).catch(() => {})); return { text: "The session picker is open." }; }
    const ctx = await api.getContext();
    pick.reopened = true;
    pick.text = "";
    pick.done = new Promise((r) => { pick.resolve = r; });
    showPicker(ctx, { reopened: true });
    return { text: "Pick a session in the new tab." };
  }

  // A choice was made (by the person in the picker, or by an agent): waiting agents go on.
  function picked(text) {
    if (pick.state === "done" || pick.state === "off") { pick.state = "done"; return; }
    pick.state = "done";
    pick.text = text;
    pick.resolve(text);
    log(`session picked: ${text}`);
  }

  // Before an agent's first browser action: starts the browser (which shows the picker) and waits
  // for the person's pick, at most PICK_WAIT_MS. Returns the pick's text, "" when there was no
  // picker, or { waiting } when it timed out.
  async function waitForPick(signal) {
    if (pick.state === "off" || pick.state === "done") return "";
    await api.getContext();
    if (pick.state !== "showing") return pick.state === "done" ? pick.text : "";
    let timer;
    let onAbort;
    const aborted = new Promise((r) => { onAbort = () => r(null); signal?.addEventListener("abort", onAbort, { once: true }); });
    const r = await Promise.race([pick.done, new Promise((ok) => { timer = setTimeout(() => ok(null), PICK_WAIT_MS); }), aborted]);
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    return r === null ? { waiting: true } : r;
  }

  // What the picker shows: the kept sessions, most recently used first, with their saved tabs'
  // sites, who used them (people and agents, their app and kind of computer) and, for the open
  // one, who is in it right now.
  function pickerState() {
    const sessions = listSessions().filter((s) => !s.temporary).map((s) => {
      const { tabs } = readSavedTabs(tabsFile(s.name));
      const sites = [...new Set(tabs.map((t) => { try { return new URL(t.url).hostname.replace(/^www\./, ""); } catch { return ""; } }).filter(Boolean))];
      const people = readPeople(s.name);
      const used = Math.max(Date.parse(readJson(tabsFile(s.name))?.savedAt || "") || 0, people[0]?.at || 0);
      return { name: s.name, tabs: tabs.length, sites: sites.slice(0, 4), current: s.name === st.session, used,
        people: people.map(({ who, app, computer, kind }) => ({ who, app, computer, kind })),
        live: s.name === st.session ? liveOthers().slice(0, 8) : [] };
    });
    // The open one (the last used) first, then by when they were used.
    sessions.sort((a, b) => Number(b.current) - Number(a.current) || b.used - a.used || a.name.localeCompare(b.name));
    return { picking: pick.state === "showing", where: where(), sessions };
  }

  function switchFromPicker(name) {
    st.pickSwitch = api.switchTo(name).catch((e) => log("pick", e?.message || e)).finally(() => { st.pickSwitch = null; });
  }

  // The person's pick: { action: "use", name } (a saved session) or { action: "new" } (fresh and
  // clean). Joining is wired in daemon.mjs (it needs the join code checks). Returns { text, error }.
  async function pickSession({ action, name } = {}) {
    if (pick.state !== "showing") return { text: "A session is already chosen.", error: true };
    if (action === "use") {
      if (!validName(name) || isTemporary(name) || !listSessions().some((s) => s.name === name)) return { text: `No session "${name}".`, error: true };
      if (name === st.session && pick.reopened) {
        // Asked for again, and the person kept the open session: the picker just closes.
        pick.reopened = false;
        picked(`The person kept session "${name}" in the browser's session picker.`);
        await pick.page?.close().catch(() => {});
        return { text: `Staying in session "${name}".` };
      }
      pick.reopened = false;
      if (name === st.session) {
        // Back to the session that's open: the picker's tab shows its tabs coming back.
        const ctx = await api.getContext();
        picked(`The person picked session "${name}" in the browser. Its tabs are reopening.`);
        await pick.page?.goto("about:blank").catch(() => {});
        api.restore(ctx);
        return { text: `Opening session "${name}".` };
      }
      // Waiting agents go on at once; their next action waits for the new browser (ready()).
      switchFromPicker(name);
      picked(`The person picked session "${name}" in the browser. Its tabs are reopening.`);
      return { text: `Opening session "${name}".` };
    }
    if (action === "new") {
      pick.reopened = false;
      const target = `clean-${Date.now()}`;
      createSession(target);
      switchFromPicker(target);
      picked("The person started a fresh session in the browser: a clean, throwaway browser with no logins, deleted when you switch away.");
      return { text: "Starting a fresh session." };
    }
    return { text: 'Use action "use" or "new".', error: true };
  }

  // The person joined a shared session from the picker: this session stays, without its saved
  // tabs (the shared ones open in a window of their own).
  // The picker's tab stays, saying what happens next; the saved tabs open after it.
  function pickedJoin(text) {
    if (pick.state !== "showing") return;
    picked(text);
    if (pick.reopened) { pick.reopened = false; return; } // the open tabs are still there
    st.contextPromise?.then(async (ctx) => api.restore(ctx, await ctx.newPage())).catch((e) => log("restore", e?.message || e));
  }

  // The person switches away from the session that's open (POST pick while no picker shows: the
  // session switcher, the new tab page's chips; daemon/pick.mjs checks who else is at work first):
  // { action: "use", name } or { action: "new" }. Checked here at once, then the browser restarts
  // on the other session after the answer went out (the page that asked closes with the window).
  // Returns { text } or { text, error: true }.
  async function switchForPerson({ action, name } = {}) {
    if (pick.state === "showing") return pickSession({ action, name });
    if (st.switching) return { text: "The browser is switching sessions; try again in a moment.", error: true };
    if (st.restoring) return { text: "Tabs are still reopening; switch once they're back.", error: true };
    if (action === "use") {
      if (!validName(name) || isTemporary(name) || !listSessions().some((s) => s.name === name)) return { text: `No session "${name}".`, error: true };
      if (name === st.session) return { text: `You're in session "${name}" already.` };
      setImmediate(() => api.switchTo(name).catch((e) => log("switch", e?.message || e)));
      return { text: `Opening session "${name}".` };
    }
    if (action === "new") {
      const target = `clean-${Date.now()}`;
      createSession(target);
      setImmediate(() => api.switchTo(target).catch((e) => log("switch", e?.message || e)));
      return { text: "Starting a fresh session." };
    }
    return { text: 'Use action "use" or "new".', error: true };
  }

  // An agent chose (pairbrowse_join): the picker goes, the saved tabs come back.
  function agentChose(text) {
    if (pick.state !== "showing") { if (pick.state === "pending") pick.state = "done"; return; }
    picked(text);
    const page = pick.page;
    st.contextPromise?.then(async (ctx) => { await page?.goto("about:blank").catch(() => {}); api.restore(ctx); }).catch(() => {});
  }

  // Who used the session: recorded in the session being opened when the person just picked another.
  const recordPersonHere = async (person) => { while (st.pickSwitch) await st.pickSwitch; recordPerson(st.session, person); };

  return { showPicker, reopenPicker, picked, waitForPick, pickerState, pickSession, pickedJoin, switchForPerson, agentChose, recordPersonHere };
}
