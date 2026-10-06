// The browser itself: launching it (and the native PairBrowse build), the pages it opens, the
// tabs it brings back, downloads, the tab cap, and switching between browser sessions.
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync, constants as fsConstants } from "node:fs";
import { basename, join, resolve } from "node:path";
import { paths } from "../paths.mjs";
import { ensureBrowser, launchArgs, prepareProfile, panelExtensionId, resetPanelWorker } from "../browser.mjs";
import { engineProfile, launchEngine, validateEngine } from "../engine.mjs";
import { ensureNative, nativeDirs, nativeLayout } from "../native-install.mjs";
import { needsVirtualDisplay, startVirtualDisplay } from "../display.mjs";
import { readSavedTabs, trackTabs, restoreTabs } from "../tabs.mjs";
import { computerName } from "../join.mjs";
import { validName, isTemporary, profileDir, tabsFile, currentSession, rememberSession, listSessions, createSession, deleteSession, sweepTemporary, readPeople, recordPerson } from "../sessions.mjs";
import { keepFocus } from "../focus.mjs";
import { sleep, readJson } from "../util.mjs";

// While a throwaway session is open, a marker says so: if the helper restarts, the session is
// gone and the next result tells Claude it's back on a kept one (with its logins).
const CLEAN_MARKER = join(paths.home, "run", "clean-session");
const TRIM_EVERY_MS = 60_000;
const KEEP_ENTRIES = 200;
// Playwright MCP listens to every request of every tab for its network tools, which PairBrowse
// doesn't offer. While anything listens, Playwright mirrors each request into this process and
// keeps it until the tab closes: about a third of a megabyte per action, for good. Drop those
// listeners (MCP adds its own short-lived ones while an action waits for the network).
const NETWORK_EVENTS = ["request", "response", "requestfailed", "requestfinished"];
// The session picker: agents' first browser action waits this long for the person's pick, then
// says what it waits for, so the agent tells them in chat instead of hanging silently.
const PICK_WAIT_MS = Number(process.env.PAIRBROWSE_TEST_PICK_WAIT_MS) || 15_000;
// An extension page: web pages can't open, frame or script it (no web_accessible_resources).
const pickerUrl = () => `chrome-extension://${panelExtensionId()}/picker.html`;

// Started in an SSH session (say, the desktop app's SSH sessions) means the browser runs on that
// machine, not the user's: its live view needs an SSH tunnel.
export const where = () => (process.env.SSH_CONNECTION ? "Server" : "Local");

export function stopRequestMirroring(page) {
  setTimeout(() => {
    for (const event of NETWORK_EVENTS) for (const fn of page.listeners(event)) page.off(event, fn);
  }, 1500).unref?.();
}

// hud, presence, popups: the other parts that watch each page. hostNote(text): a note for the
// host's agent's next result. onTabClosed(page). status(badge): the live view's status line.
// shuttingDown(): no new browser then. onStarted(ctx) / onClosed(): the browser came up / went
// away by itself (not for a session switch).
// liveOthers(): who else is in this browser's session right now ({ who, app, computer }).
export function createContext({ config, log, chromium, hud, presence, popups, hostNote, onTabClosed, status, shuttingDown, onStarted, onClosed, liveOthers = () => [], notify = () => {} }) {
  let contextPromise = null;
  // The PairBrowse browser is being downloaded and installed (first start, or a new version):
  // the user hears of it, and actions say so at once rather than waiting for minutes.
  let installing = false;
  let launching = false;
  const installWaiters = new Set();
  let session = currentSession(); // which browser session (Chrome profile) is in use
  let switching = false;
  let screen = null; // virtual display on a Linux machine without a screen
  let tabTracker = null;
  let restoring = null; // promise while saved tabs are being reopened
  let restoredActiveUrl = null;
  let lastCurrentUrl = null; // the tab Claude worked in last, from tool results
  // The session picker (config sessionPicker, on by default): the browser's first tab asks the
  // person which session to use, unless an agent chose first. Never on the very first start
  // (nothing to go back to) or in a cloud container (nobody sees the window).
  // pick.state: "off", "pending" (shown at the next launch), "showing", "done".
  // Something to go back to: a browser that ran before (Chrome's "Default" folder), saved tabs or
  // another kept session.
  const hasHistory = () => existsSync(join(profileDir(session), "Default")) || listSessions().some((s) => !s.temporary && (s.name !== "default" || s.tabs > 0));
  const pick = { state: config.sessionPicker !== false && process.env.CLAUDE_CODE_REMOTE !== "true" && hasHistory() ? "pending" : "off", page: null, text: "" };
  pick.done = new Promise((r) => { pick.resolve = r; });

  const profile = () => engineProfile(config, profileDir(session));
  const findPage = (ctx, url) => ctx.pages().find((p) => p.url() === url);
  // The open tabs, without starting the browser.
  const openPages = async () => (contextPromise ? (await contextPromise.catch(() => null))?.pages() || [] : []);
  // The tab showing url, else the last one; null while the browser is closed.
  async function pageAt(url) {
    if (!contextPromise) return null;
    const ctx = await getContext();
    return findPage(ctx, url) || ctx.pages().at(-1) || null;
  }

  // Playwright MCP keeps every network request and page event of each tab until it navigates or
  // snapshots that tab itself; busy background tabs (video, news, ads) grow those lists for good.
  // PairBrowse offers no network tools, so keep only the latest of each. (Its own per-tab object,
  // found defensively: if a runtime update changes it, nothing is touched.)
  setInterval(async () => {
    for (const page of await openPages()) {
      stopRequestMirroring(page); // a newly connected session's server adds its listeners again
      const sym = Object.getOwnPropertySymbols(page).find((x) => x.description === "tabSymbol");
      const tab = sym && page[sym];
      for (const key of ["_requests", "_recentEventEntries"]) {
        const list = tab?.[key];
        if (Array.isArray(list) && list.length > KEEP_ENTRIES) list.splice(0, list.length - KEEP_ENTRIES);
      }
    }
  }, TRIM_EVERY_MS).unref();

  // At most config.maxTabs tabs (20): when one more opens, the one used longest ago closes.
  // "Used" means an agent acted in it or a person clicked, typed or scrolled in it. Never the tab
  // Claude is in, one that just opened, or one anyone used in the last minutes (in a shared
  // session that could be another agent's or person's tab): then more tabs stay open. Claude is
  // told which tab went.
  const MAX_TABS = Math.max(2, Number(config.maxTabs) || 20);
  const IN_USE_MS = 10 * 60_000;
  const lastUsed = new WeakMap();
  const touch = (page) => page && lastUsed.set(page, Date.now());
  async function capTabs(ctx, keep = null) {
    if (restoring) return; // tabs coming back after a restart: decide once they're all open
    const pages = ctx.pages().filter((p) => !p.isClosed() && /^(https?:|about:blank)/.test(p.url()));
    if (pages.length <= MAX_TABS) return;
    const current = findPage(ctx, lastCurrentUrl);
    const idleSince = Date.now() - IN_USE_MS;
    const candidates = pages.filter((p) => p !== keep && p !== current && (lastUsed.get(p) || 0) < idleSince).sort((a, b) => (lastUsed.get(a) || 0) - (lastUsed.get(b) || 0));
    for (const p of candidates.slice(0, pages.length - MAX_TABS)) {
      const url = p.url();
      await p.close({ runBeforeUnload: false }).catch(() => {});
      hostNote(`Closed an old tab to keep ${MAX_TABS} open: ${url.slice(0, 120)}. Tab numbers changed: use browser_tabs list.`);
      log(`closed old tab ${url}`);
    }
  }

  // Files a site hands over (invoices, exported keys) go to the Downloads folder, as in any
  // browser; Playwright would otherwise keep them under a random name and delete them on close.
  function keepDownloads(page) {
    page.on("download", async (download) => {
      const dir = config.downloadsDir || join(homedir(), "Downloads");
      // The site picks the name: keep it to a plain file name.
      const name = basename(download.suggestedFilename() || "download").replace(/[\u0000-\u001f\u007f/\\:]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "download";
      const dot = name.lastIndexOf(".") > 0 ? name.lastIndexOf(".") : name.length;
      try {
        mkdirSync(dir, { recursive: true });
        const from = await download.path(); // finished, in Playwright's temporary folder
        let dest;
        for (let i = 0; ; i++) {
          dest = join(dir, i ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : name);
          try { copyFileSync(from, dest, fsConstants.COPYFILE_EXCL); break; } // never over an existing file
          catch (e) { if (e.code !== "EEXIST" || i > 500) throw e; }
        }
        hostNote(`Downloaded ${name} to ${dest}`);
        log(`downloaded ${dest}`);
      } catch (e) {
        const why = await download.failure().catch(() => null);
        hostNote(`Download of ${name} failed: ${why || e?.message || e}`);
        log(`download of ${name} failed: ${why || e?.message || e}`);
      }
    });
  }

  // Playwright saves downloads to a temporary folder it deletes when the browser closes. Chrome
  // still lists them in its download history, and on the next launch the macOS PairBrowse browser
  // (ungoogled-chromium) quits on the first new download. Forget those entries before launching.
  function forgetTemporaryDownloads() {
    const history = join(profile(), "Default", "History");
    if (process.platform !== "darwin" || !existsSync(history)) return;
    const temporary = "target_path LIKE '%/playwright-artifacts-%'";
    const sql = `DELETE FROM downloads_url_chains WHERE id IN (SELECT id FROM downloads WHERE ${temporary}); ` +
      `DELETE FROM downloads_slices WHERE download_id IN (SELECT id FROM downloads WHERE ${temporary}); DELETE FROM downloads WHERE ${temporary};`;
    const r = spawnSync("/usr/bin/sqlite3", [history, sql], { timeout: 5000, encoding: "utf8" });
    if (r.status !== 0) log(`couldn't clear temporary downloads: ${(r.stderr || r.error?.message || "").trim()}`);
  }

  // The native PairBrowse browser: the pinned build, installed and checked when it's missing or
  // a new version is pinned (scripts/native-install.mjs). A browser of your own stays as it is.
  // Never a quiet switch to the standard engine: only "browserEngine": "chromium" picks that.
  async function chooseEngine() {
    const auto = config.browserEngine === "auto";
    if (auto && config.executablePath) config.browserEngine = "chromium"; // a browser of your own
    else if (auto || (config.browserEngine === "pairbrowse" && (!config.executablePath || resolve(config.executablePath) === nativeDirs().exec))) {
      const optOut = 'To use the standard Chromium instead, set "browserEngine": "chromium" in ~/.pairbrowse/config.json.';
      const installLog = (m) => {
        log(m);
        if (installing || !/^(downloading|unpacking)/.test(m)) return;
        installing = true;
        notify("Installing the PairBrowse browser. It takes a minute or two, once.");
        for (const fn of installWaiters) fn();
      };
      let native = null;
      try {
        native = nativeLayout() ? await ensureNative(installLog) : null;
      } catch (e) {
        if (installing) notify("The PairBrowse browser couldn't be installed. Ask Claude what happened.");
        throw new Error(`The PairBrowse browser couldn't be installed: ${e.message} ${optOut}`);
      } finally {
        if (installing && native) notify("The PairBrowse browser is installed.");
        installing = false;
      }
      if (!native) throw new Error(`There's no PairBrowse browser build for ${process.platform} ${process.arch} yet. ${optOut}`);
      config.browserEngine = "pairbrowse";
      config.executablePath = native;
    }
    validateEngine(config);
  }

  // Everything that watches a page, for the tabs there at launch and each new one.
  function adopt(page, ctx) {
    page.on("domcontentloaded", () => hud.onPageLoad(page));
    popups.watchPage(page, ctx);
    keepDownloads(page);
    presence.watchUser(page);
    stopRequestMirroring(page);
    page.once("close", () => onTabClosed(page)); // a closed tab's turn ends with it
    touch(page);
  }

  // screen: the tab that shows "Opening tabs" (default: the first one).
  function restore(ctx, screen = null) {
    recordPerson(session, { who: "You", computer: computerName(), kind: "you" }); // the session is in use now
    const saved = readSavedTabs(tabsFile(session));
    tabTracker = trackTabs(ctx, { file: tabsFile(session), activePage: () => findPage(ctx, lastCurrentUrl), log });
    if (!saved.tabs.length) { screen?.close().catch(() => {}); return; }
    restoredActiveUrl = saved.tabs[saved.active]?.url || null;
    restoring = keepFocus(() => restoreTabs(ctx, saved, {
      log, screen,
      // Progress shows in the live view and side panel only (never as a badge in the pages),
      // and only when there's more than one tab to bring back.
      onProgress: (n, total) => { if (total > 1) status({ text: `Opening tabs ${n} of ${total}`, kind: "claude" }); },
    }).catch((e) => log("restore failed", e?.message || e)).finally(() => {
      status(hud.badge());
      restoring = null;
      log(`restored ${saved.tabs.length} tabs`);
      capTabs(ctx).catch(() => {});
    }));
  }

  async function launch() {
    await chooseEngine();
    // The profile settings PairBrowse needs (blank start tab, pinned and enabled side panel,
    // colors; see prepareProfile in browser.mjs), written before each launch.
    const firstRun = prepareProfile(profile());
    // A side panel worker from another build (an update): the browser would keep running its
    // cached copy, so it's loaded anew from disk (resetPanelWorker in browser.mjs).
    try { if (resetPanelWorker(profile())) log("side panel: its worker changed since the last start; the browser loads it anew"); } catch (e) { log(`side panel: ${e?.message || e}`); }
    forgetTemporaryDownloads();
    if (!screen && needsVirtualDisplay(config)) screen = await startVirtualDisplay(log);
    createSession(session);
    // The PairBrowse browser (scripts/browser.mjs), or another Chromium browser from config.
    const ctx = await launchEngine(chromium, config, profile(), {
      headless: false,
      env: { ...process.env, ...(screen?.env || {}) },
      executablePath: config.executablePath || await ensureBrowser(chromium, log),
      viewport: null,
      // Its own side panel is the only extension it loads.
      ignoreDefaultArgs: ["--disable-extensions"],
      args: launchArgs(config, { firstRun }),
    }, log);
    await ctx.addInitScript({ content: hud.source });
    for (const p of ctx.pages()) { adopt(p, ctx); hud.ensure(p); }
    ctx.on("page", (p) => { adopt(p, ctx); setTimeout(() => capTabs(ctx, p).catch(() => {}), 300); });
    if (pick.state === "pending") showPicker(ctx);
    else restore(ctx);
    ctx.on("close", () => {
      log("browser closed");
      // Closed while asking: the next browser asks again.
      if (pick.state === "showing") { pick.state = "pending"; pick.page = null; }
      contextPromise = null;
      hud.clearSparks();
      if (!switching) onClosed(); // switching sessions: the next one opens right away
    });
    log(`browser started (session ${session})`);
    onStarted(ctx);
    return ctx;
  }

  function getContext() {
    if (shuttingDown() && !contextPromise) return Promise.reject(new Error("PairBrowse is restarting. Retry in a moment."));
    if (!contextPromise) {
      launching = true;
      contextPromise = launch().catch((e) => {
        contextPromise = null;
        throw e;
      }).finally(() => { launching = false; installWaiters.clear(); });
    }
    if (!launching) return contextPromise;
    const busy = () => new Error("PairBrowse is installing its browser (the first start or a new version: a minute or two). Tell the user, then retry the last action in a minute.");
    if (installing) return Promise.reject(busy());
    return Promise.race([contextPromise, new Promise((_, reject) => installWaiters.add(() => reject(busy())))]);
  }

  // The browser, once saved tabs are back.
  async function ready() {
    while (pickSwitch) await pickSwitch; // never the old browser after the person picked another
    const ctx = await getContext();
    if (restoring) await restoring;
    return ctx;
  }
  // The tab the user was on before a restart, once (then null): the first action starts there.
  function takeRestoredActive() {
    const url = restoredActiveUrl;
    restoredActiveUrl = null;
    return url;
  }

  // ---- the session picker ----------------------------------------------------------------

  // Its tab, instead of the saved tabs (they come back once the person chose this session).
  // reopened: asked for again from the side panel, in a tab of its own; the open tabs stay.
  function showPicker(ctx, { reopened = false } = {}) {
    pick.state = "showing";
    if (!reopened) tabTracker = null; // the saved tabs stay as they were until the person chose
    (async () => {
      // The browser may start without a window and open its first one a moment later: use that.
      for (let i = 0; !reopened && i < 20 && !ctx.pages().length; i++) await sleep(150);
      const page = reopened ? await ctx.newPage() : ctx.pages()[0] || (await ctx.newPage());
      pick.page = page;
      // The extension may still be loading right after launch: try a few times.
      for (let i = 0; i < 20 && pick.state === "showing" && !page.isClosed(); i++) {
        if (await page.goto(pickerUrl(), { waitUntil: "domcontentloaded", timeout: 5000 }).then(() => true, () => false)) break;
        await sleep(250);
      }
      await keepFocus(() => page.bringToFront().catch(() => {}));
      log("session picker shown");
    })().catch((e) => log("session picker", e?.message || e));
  }

  // The person asked to switch (the side panel's "Switch session..."): the picker opens again in a
  // new tab, and agents' next actions wait for the pick as at the start. Agents can't ask for it.
  async function reopenPicker() {
    if (pick.state === "showing") { await pick.page?.bringToFront().catch(() => {}); return { text: "The session picker is open." }; }
    const ctx = await getContext();
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
    await getContext();
    if (pick.state !== "showing") return pick.state === "done" ? pick.text : "";
    let timer;
    const aborted = new Promise((r) => signal?.addEventListener("abort", () => r(null), { once: true }));
    const r = await Promise.race([pick.done, new Promise((ok) => { timer = setTimeout(() => ok(null), PICK_WAIT_MS); }), aborted]);
    clearTimeout(timer);
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
      return { name: s.name, tabs: tabs.length, sites: sites.slice(0, 4), current: s.name === session, used,
        people: people.map(({ who, app, computer, kind }) => ({ who, app, computer, kind })),
        live: s.name === session ? liveOthers().slice(0, 8) : [] };
    });
    // The open one (the last used) first, then by when they were used.
    sessions.sort((a, b) => Number(b.current) - Number(a.current) || b.used - a.used || a.name.localeCompare(b.name));
    return { picking: pick.state === "showing", where: where(), sessions };
  }

  let pickSwitch = null; // the switch the person's pick started, until the new browser is up
  function switchFromPicker(name) {
    pickSwitch = switchTo(name).catch((e) => log("pick", e?.message || e)).finally(() => { pickSwitch = null; });
  }

  // The person's pick: { action: "use", name } (a saved session) or { action: "new" } (fresh and
  // clean). Joining is wired in daemon.mjs (it needs the join code checks). Returns { text, error }.
  async function pickSession({ action, name } = {}) {
    if (pick.state !== "showing") return { text: "A session is already chosen.", error: true };
    if (action === "use") {
      if (!validName(name) || isTemporary(name) || !listSessions().some((s) => s.name === name)) return { text: `No session "${name}".`, error: true };
      if (name === session && pick.reopened) {
        // Asked for again, and the person kept the open session: the picker just closes.
        pick.reopened = false;
        picked(`The person kept session "${name}" in the browser's session picker.`);
        await pick.page?.close().catch(() => {});
        return { text: `Staying in session "${name}".` };
      }
      pick.reopened = false;
      if (name === session) {
        // Back to the session that's open: the picker's tab shows its tabs coming back.
        const ctx = await getContext();
        picked(`The person picked session "${name}" in the browser. Its tabs are reopening.`);
        await pick.page?.goto("about:blank").catch(() => {});
        restore(ctx);
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
    contextPromise?.then(async (ctx) => restore(ctx, await ctx.newPage())).catch((e) => log("restore", e?.message || e));
  }

  // ---- browser sessions ----------------------------------------------------------------

  const sessionInfo = () => ({ name: isTemporary(session) ? "Clean session" : session, where: where(), temporary: isTemporary(session) });

  async function switchTo(name) {
    if (name === session && contextPromise) return;
    switching = true;
    try {
      const ctx = contextPromise && (await contextPromise);
      if (ctx) {
        await tabTracker?.saveNow();
        tabTracker?.stop();
        await ctx.close().catch(() => {});
      }
      const previous = session;
      session = name;
      rememberSession(name);
      if (isTemporary(name)) writeFileSync(CLEAN_MARKER, name);
      else rmSync(CLEAN_MARKER, { force: true });
      if (isTemporary(previous) && previous !== name) deleteSession(previous);
      contextPromise = null;
    } finally {
      switching = false;
    }
    // An agent switching is a choice too: no picker in the next browser.
    picked(`Session "${isTemporary(name) ? "clean" : name}" was chosen by an agent.`);
    await getContext();
    log(`switched to session ${name}`);
  }

  // pairbrowse_session. Returns { text, error }.
  async function sessionCommand({ action, name } = {}) {
    const fail = (text) => ({ text, error: true });
    const exists = () => validName(name) && listSessions().some((s) => s.name === name);
    const list = () => listSessions().map((s) => `${s.name === session ? "* " : "  "}${s.temporary ? "clean (throwaway)" : s.name}${s.tabs ? `, ${s.tabs} saved tabs` : ""}`).join("\n");
    if (action === "list") return { text: `Browser sessions (* = in use, ${where().toLowerCase()} browser):\n${list()}` };
    if (action === "use") {
      if (!exists()) return fail(`No session "${name}".\n${list()}`);
      await switchTo(name);
      return { text: `Now using session "${name}" (${where().toLowerCase()} browser). Its tabs are reopening.` };
    }
    if (action === "new") {
      if (name !== undefined && !validName(name)) return fail("Session names use letters, numbers, - and _ (up to 40).");
      if (name && listSessions().some((s) => s.name === name)) return fail(`Session "${name}" already exists. Use it with action "use".`);
      const target = name || `clean-${Date.now()}`;
      createSession(target);
      await switchTo(target);
      return {
        text: name
          ? `Created and switched to the new session "${name}": an empty browser with no logins.`
          : "Switched to a clean, throwaway browser: no logins, no history. It's deleted when you switch away or the browser shuts down.",
      };
    }
    if (action === "delete") {
      if (!exists()) return fail(`No session "${name}".`);
      if (name === session) return fail("That session is in use. Switch to another one first.");
      if (name === "default") return fail("The default session can't be deleted.");
      deleteSession(name);
      return { text: `Deleted session "${name}" and its logins.` };
    }
    return fail('Use action "list", "use", "new" or "delete".');
  }

  // At startup: throwaway sessions a crash left behind, and the note that a clean one ended.
  function startUp() {
    try { sweepTemporary(); } catch {}
    if (!existsSync(CLEAN_MARKER)) return;
    rmSync(CLEAN_MARKER, { force: true });
    hostNote(`The clean session ended when the browser restarted. This is session "${session}" now, with its logins: switch to a new clean one (pairbrowse_session new, clean: true) if you need it.`);
  }

  // At shutdown: remember the tabs before they close; a clean close writes cookies to disk.
  async function close() {
    try {
      const ctx = contextPromise && (await contextPromise);
      await tabTracker?.saveNow();
      tabTracker?.stop();
      await ctx?.close();
    } catch {}
    try { sweepTemporary(); } catch {}
    screen?.stop();
  }

  return {
    getContext, current: () => contextPromise, profile, openPages, findPage, pageAt, ready, takeRestoredActive, touch,
    isRestoring: () => restoring !== null, isSwitching: () => switching,
    currentUrl: () => lastCurrentUrl, setCurrentUrl: (url) => { lastCurrentUrl = url; },
    sessionInfo, sessionCommand, startUp, close,
    waitForPick, pickerState, pickSession, pickedJoin, // In the session being opened, when the person just picked another.
    recordPerson: async (person) => { while (pickSwitch) await pickSwitch; recordPerson(session, person); }, picking: () => pick.state === "showing", reopenPicker,
    // An agent chose (pairbrowse_join): the picker goes, the saved tabs come back.
    agentChose(text) {
      if (pick.state !== "showing") { if (pick.state === "pending") pick.state = "done"; return; }
      picked(text);
      const page = pick.page;
      contextPromise?.then(async (ctx) => { await page?.goto("about:blank").catch(() => {}); restore(ctx); }).catch(() => {});
    },
  };
}
