// The browser itself: launching it (and the native PairBrowse build), the pages it opens, the
// tabs it brings back, downloads, the tab cap, and switching between browser sessions.
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync, constants as fsConstants } from "node:fs";
import { basename, join, resolve } from "node:path";
import { paths } from "../paths.mjs";
import { ensureBrowser, launchArgs, prepareProfile } from "../browser.mjs";
import { engineProfile, launchEngine, validateEngine } from "../engine.mjs";
import { ensureNative, nativeDirs, nativeLayout } from "../native-install.mjs";
import { needsVirtualDisplay, startVirtualDisplay } from "../display.mjs";
import { readSavedTabs, trackTabs, restoreTabs } from "../tabs.mjs";
import { validName, isTemporary, profileDir, tabsFile, currentSession, rememberSession, listSessions, createSession, deleteSession, sweepTemporary } from "../sessions.mjs";
import { keepFocus } from "../focus.mjs";

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

// Started over SSH (remote mode or a desktop-app SSH session) means it's the server browser.
export const where = () => (process.env.PAIRBROWSE_ON_SERVER || process.env.SSH_CONNECTION ? "Server" : "Local");

export function stopRequestMirroring(page) {
  setTimeout(() => {
    for (const event of NETWORK_EVENTS) for (const fn of page.listeners(event)) page.off(event, fn);
  }, 1500).unref?.();
}

// hud, presence, popups: the other parts that watch each page. hostNote(text): a note for the
// host's agent's next result. onTabClosed(page). status(badge): the live view's status line.
// shuttingDown(): no new browser then. onStarted(ctx) / onClosed(): the browser came up / went
// away by itself (not for a session switch).
export function createContext({ config, log, chromium, hud, presence, popups, hostNote, onTabClosed, status, shuttingDown, onStarted, onClosed }) {
  let contextPromise = null;
  let session = currentSession(); // which browser session (Chrome profile) is in use
  let switching = false;
  let screen = null; // virtual display on servers
  let tabTracker = null;
  let restoring = null; // promise while saved tabs are being reopened
  let restoredActiveUrl = null;
  let lastCurrentUrl = null; // the tab Claude worked in last, from tool results

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
  async function chooseEngine() {
    if (config.browserEngine === "auto") {
      // The default: the native build where there is one for this platform and chip (macOS,
      // Linux x64, Windows x64), else the standard engine.
      let native = null;
      if (!config.executablePath && nativeLayout()) {
        native = await ensureNative(log).catch((e) => { log(`using the standard browser: ${e.message}`); return null; });
      }
      config.browserEngine = native ? "pairbrowse" : "chromium";
      if (native) config.executablePath = native;
    } else if (config.browserEngine === "pairbrowse" && (!config.executablePath || resolve(config.executablePath) === nativeDirs().exec)) {
      config.executablePath = (await ensureNative(log)) || config.executablePath;
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

  function restore(ctx) {
    const saved = readSavedTabs(tabsFile(session));
    tabTracker = trackTabs(ctx, { file: tabsFile(session), activePage: () => findPage(ctx, lastCurrentUrl), log });
    if (!saved.tabs.length) return;
    restoredActiveUrl = saved.tabs[saved.active]?.url || null;
    restoring = keepFocus(() => restoreTabs(ctx, saved, {
      log,
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
    restore(ctx);
    ctx.on("close", () => {
      log("browser closed");
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
    contextPromise ??= launch().catch((e) => {
      contextPromise = null;
      throw e;
    });
    return contextPromise;
  }

  // The browser, once saved tabs are back.
  async function ready() {
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
    getContext, current: () => contextPromise, openPages, findPage, pageAt, ready, takeRestoredActive, touch,
    isRestoring: () => restoring !== null, isSwitching: () => switching,
    currentUrl: () => lastCurrentUrl, setCurrentUrl: (url) => { lastCurrentUrl = url; },
    sessionInfo, sessionCommand, startUp, close,
  };
}
