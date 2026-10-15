// The browser itself: launching it (and the native PairBrowse build), the pages it opens, the
// tabs it brings back, downloads, the tab cap, and switching between browser sessions.
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync, constants as fsConstants } from "node:fs";
import { basename, join, resolve } from "node:path";
import { paths } from "../paths.mjs";
import { ensureBrowser, launchArgs, prepareProfile, panelExtensionId, resetPanelWorker, browserChoice, writeHelperKeyFile, dropHelperKeyFile } from "../browser.mjs";
import { engineProfile, launchEngine, validateEngine } from "../engine.mjs";
import { ensureNative, nativeDirs, nativeLayout, notChosen, pinnedAsset } from "../native-install.mjs";
import { needsVirtualDisplay, startVirtualDisplay } from "../display.mjs";
import { readSavedTabs, trackTabs, restoreTabs } from "../tabs.mjs";
import { computerName } from "../join.mjs";
import { validName, isTemporary, profileDir, tabsFile, currentSession, rememberSession, listSessions, createSession, deleteSession, renameSession, sessionFilesExist, profileInUse, sweepTemporary, readPeople, recordPerson } from "../sessions.mjs";
import { renameRunsSession } from "../runs.mjs";
import { keepFocus } from "../focus.mjs";
import { sleep, readJson, within } from "../util.mjs";
import { pruneStaleContexts } from "./contexts.mjs";
import { chromePages, capturePages, nativeManifest, MEASURING } from "../native-engine.mjs";
import { isChromePage } from "../policy.mjs";
import { createPersonTabs, keepDownloadMark } from "./tools.mjs";
import { OPEN_ACCEPT_MS } from "../opener.mjs";

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
// A build with its own pages shows its own picker instead (chrome://pairbrowse/picker).
const CHROME_PICKER = "chrome://pairbrowse/picker";
// Whether the browser config launches is a native build that declares its own pages (its
// manifest's `chrome` field).
const chromePagesIn = (config) => { try { return config.browserEngine === "pairbrowse" && chromePages(nativeManifest(config.executablePath)); } catch { return false; } };
// Whether that build also declares its capture page (native-engine capturePages).
const capturePagesIn = (config) => { try { return config.browserEngine === "pairbrowse" && capturePages(nativeManifest(config.executablePath)); } catch { return false; } };

// Started in an SSH session (say, the desktop app's SSH sessions) means the browser runs on that
// machine, not the user's: its live view needs an SSH tunnel.
export const where = () => (process.env.SSH_CONNECTION ? "Server" : "Local");

// This Mac's one-time capture (native-engine.mjs MEASURING): the first launch of a browser version
// waits up to a minute for it, and says so in the live view's status line and a notification (no
// browser yet, so no side panel or strip to show it). The launch's log, passing every line on;
// done(badge): the launch ended, the status line goes back to the badge.
export const MEASURING_STATUS = "Measuring this Mac once (under a minute): the browser opens after that.";
export function measuringLog({ log, status, notify }) {
  let measuring = false;
  const launchLog = (text, ...more) => {
    log(text, ...more);
    if (text !== MEASURING || measuring) return;
    measuring = true;
    status({ text: MEASURING_STATUS, kind: "claude" });
    notify(MEASURING_STATUS);
  };
  launchLog.done = (badge) => { if (measuring) status(badge); measuring = false; };
  return launchLog;
}

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
// chromePagesOf(config): whether the browser it launches has its own pages. helperFor(): the live view's
// { origin, key } for those pages (started then), or null: the address goes in its launch switch,
// the key in an owner-only file named by the other switch, deleted on first use (dropHelperKey).
// beforeRename(): awaited before a rename moves the session's files (the timeline's last writes).
// onRenamed(from, to): the session was renamed (the goal log follows).
// onDownload({ op: "start", name, page }) -> id, then { op: "done", id, path } or { op: "failed", id }:
// the Tools tab's Downloads (daemon/tools.mjs), in memory only.
// personTabs: the person's own tabs (daemon/tools.mjs createPersonTabs), shared with serve.mjs:
// openForPerson opens one, and no agent's fallback tab is ever one.
export function createContext({ personTabs = createPersonTabs(), config, log, chromium, driver = "patchright", hud, presence, popups, hostNote, onTabClosed, status, shuttingDown, onStarted, onClosed, liveOthers = () => [], notify = () => {}, chromePagesOf = chromePagesIn, capturePagesOf = capturePagesIn, helperFor = async () => null,
  beforeRename = async () => {}, onRenamed = () => {}, onDownload = () => null }) {
  let contextPromise = null;
  let chrome = false; // the browser in use has its own pages (no side panel extension)
  let chosen = false; // chrome and capture are this launch's (set once its build was chosen)
  let capture = false; // ...and its own capture page
  // The driver's browser type: the object, or a getter (the helper loads its runtime after its socket listens).
  const browserType = () => (typeof chromium === "function" ? chromium() : chromium);
  let helperKeyPath = null; // the key file of the browser launched last, until used or closed

  // Sync and idempotent: a path given is one launch's own file (its close drops only that one).
  function dropHelperKey(path = helperKeyPath) {
    if (!path) return;
    dropHelperKeyFile(path);
    if (path === helperKeyPath) helperKeyPath = null;
  }
  const pickerUrl = () => (chrome ? CHROME_PICKER : `chrome-extension://${panelExtensionId()}/picker.html`);
  // The PairBrowse browser is being downloaded and installed (first start, or a new version):
  // the user hears of it, and actions say so at once rather than waiting for minutes.
  let installing = false;
  let launching = false;
  // The next launch is for a person who opened the PairBrowse browser by hand (openByHand): it may
  // come to the front, so nothing puts the app they were in back in front of it (keepFocus).
  let byHand = false;
  const focusing = (own, change) => (own ? change() : keepFocus(change));
  // Which browser runs ("browser" in config.json, browserChoice in browser.mjs). The launch sets
  // config.browserEngine and config.executablePath from it (in memory only), so the older names a
  // person wrote are kept aside here: every launch reads the choice anew (a change in Settings
  // takes effect at the next start).
  const legacy = { browserEngine: config.browserEngine, executablePath: config.executablePath };
  const choiceConfig = () => ({ ...config, ...legacy });
  let inUse = null; // the browser the last launch chose
  const said = new Set(); // lines about the choice, logged once per helper run
  const once = (line) => { if (!said.has(line)) { said.add(line); log(line); } };
  const installWaiters = new Set();
  let session = currentSession(); // which browser session (Chrome profile) is in use
  let switching = false;
// While a session switch closes one browser and opens the next, anyone else asking for the
// browser waits for it: a browser started in between would be left running, unknown to the
// helper (a second window, and the next start fails on its profile in use).
let switched = Promise.resolve();
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
    return findPage(ctx, url) || ctx.pages().findLast((p) => !isChromePage(p.url()) && !personTabs.has(p)) || null;
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
  // Read at each check: Settings can change it while the browser runs.
  const maxTabs = () => Math.max(2, Number(config.maxTabs) || 20);
  const IN_USE_MS = 10 * 60_000;
  const lastUsed = new WeakMap();
  const touch = (page) => page && lastUsed.set(page, Date.now());
  async function capTabs(ctx, keep = null) {
    if (restoring) return; // tabs coming back after a restart: decide once they're all open
    const pages = ctx.pages().filter((p) => !p.isClosed() && /^(https?:|about:blank)/.test(p.url()));
    const MAX_TABS = maxTabs();
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
      // A download started in the person's own tab is theirs: no note for the agents.
      const personal = personTabs.has(page);
      const dir = config.downloadsDir || join(homedir(), "Downloads");
      // The site picks the name: keep it to a plain file name.
      const name = basename(download.suggestedFilename() || "download").replace(/[\u0000-\u001f\u007f/\\:]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "download";
      const dot = name.lastIndexOf(".") > 0 ? name.lastIndexOf(".") : name.length;
      let id = null;
      try { id = onDownload({ op: "start", name, page }); } catch {}
      try {
        mkdirSync(dir, { recursive: true });
        const from = await download.path(); // finished, in Playwright's temporary folder
        let dest;
        for (let i = 0; ; i++) {
          dest = join(dir, i ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : name);
          try { copyFileSync(from, dest, fsConstants.COPYFILE_EXCL); break; } // never over an existing file
          catch (e) { if (e.code !== "EEXIST" || i > 500) throw e; }
        }
        await keepDownloadMark(from, dest); // Open and Office's Protected View read it
        try { onDownload({ op: "done", id, path: dest }); } catch {}
        if (!personal) hostNote(`Downloaded ${name} to ${dest}`);
        log(`downloaded ${dest}`);
      } catch (e) {
        try { onDownload({ op: "failed", id }); } catch {}
        const why = await download.failure().catch(() => null);
        if (!personal) hostNote(`Download of ${name} failed: ${why || e?.message || e}`);
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

  // The browser the person chose ("browser"): the native PairBrowse browser (the pinned build,
  // installed and checked when it's missing or a new version is pinned, scripts/native-install.mjs),
  // "chromium" (ensureBrowser at launch) or a browser of their own. Unset: the native build where
  // one is pinned for this computer, else chromium; the helper never records that default. Never a
  // quiet switch from the native build to Chromium: only "browser": "chromium" picks that.
  async function chooseEngine() {
    const asset = pinnedAsset();
    const choice = browserChoice(choiceConfig(), { native: !!asset });
    if (choice.problem) once(choice.problem);
    if (!choice.set) once(`browser: no choice recorded yet; using ${choice.browser} (Settings, or "browser" in ~/.pairbrowse/config.json)`);
    inUse = choice.browser;
    if (choice.browser === "pairbrowse" && choice.executablePath && resolve(choice.executablePath) !== nativeDirs().exec) {
      // (The older names: a native build of your own, used as it is.)
      config.browserEngine = "pairbrowse";
      config.executablePath = choice.executablePath;
    } else if (choice.browser === "pairbrowse") {
      const optOut = 'To use Chromium instead, set "browser": "chromium" in ~/.pairbrowse/config.json.';
      const installLog = (m) => {
        log(m);
        if (installing || !/^(downloading|unpacking)/.test(m)) return;
        installing = true;
        notify("Installing the PairBrowse browser. It takes a minute or two, once.");
        for (const fn of installWaiters) fn();
      };
      let native = null;
      try {
        native = nativeLayout() ? await ensureNative(installLog, { asset, config: choiceConfig() }) : null;
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
    } else {
      // A recorded chromium or path of your own: the log says why nothing is installed, once.
      const why = choice.set && !choice.problem ? notChosen(choiceConfig(), !!asset) : null;
      if (why) once(why);
      config.browserEngine = "chromium";
      config.executablePath = choice.executablePath; // null: the PairBrowse Chromium (ensureBrowser)
    }
    validateEngine(config);
  }

  // Everything that watches a page, for the tabs there at launch and each new one.
  function adopt(page, ctx) {
    // No badge or bar is drawn into the browser's own pages.
    page.on("domcontentloaded", () => { if (!isChromePage(page.url())) hud.onPageLoad(page); });
    popups.watchPage(page, ctx);
    keepDownloads(page);
    presence.watchUser(page);
    stopRequestMirroring(page);
    page.once("close", () => onTabClosed(page)); // a closed tab's turn ends with it
    touch(page);
  }

  // screen: the tab that shows "Opening tabs" (default: the first one).
  function restore(ctx, screen = null, { own = false } = {}) {
    recordPerson(session, { who: "You", computer: computerName(), kind: "you" }); // the session is in use now
    const saved = readSavedTabs(tabsFile(session));
    tabTracker = trackTabs(ctx, { file: tabsFile(session), activePage: () => findPage(ctx, lastCurrentUrl), log });
    if (!saved.tabs.length) { screen?.close().catch(() => {}); return; }
    restoredActiveUrl = saved.tabs[saved.active]?.url || null;
    const restoreAt = Date.now();
    restoring = focusing(own, () => restoreTabs(ctx, saved, {
      log, screen,
      // A build with its own pages: no "Opening tabs" list (setContent fails on its new tab page,
      // and the strip shows the progress); its untouched start tab closes after (plans/555 D1.4).
      list: !chrome,
      // Progress shows in the live view and side panel only (never as a badge in the pages),
      // and only when there's more than one tab to bring back.
      onProgress: (n, total) => { if (total > 1) status({ text: `Opening tabs ${n} of ${total}`, kind: "claude" }); },
    }).catch((e) => log("restore failed", e?.message || e)).finally(() => {
      status(hud.badge());
      restoring = null;
      log(`restored ${saved.tabs.length} tabs`);
      log(`launch: restore ${Date.now() - restoreAt} ms`);
      capTabs(ctx).catch(() => {});
    }));
  }

  async function launch() {
    const own = byHand;
    byHand = false;
    chosen = false;
    // Each launch step's time (plans/555 item 4), logged as "launch: <step> <ms> ms".
    let stepAt = Date.now();
    const step = (name) => { const now = Date.now(); log(`launch: ${name} ${now - stepAt} ms`); stepAt = now; };
    await chooseEngine();
    step("engine");
    chrome = !!chromePagesOf(config);
    capture = chrome && !!capturePagesOf(config);
    chosen = true;
    // The profile settings PairBrowse needs (blank start tab, pinned and enabled side panel,
    // colors; see prepareProfile in browser.mjs), written before each launch.
    const firstRun = prepareProfile(profile(), undefined, { chromePages: chrome, layout: config.layout });
    step("prepare");
    // A side panel worker from another build (an update): the browser would keep running its
    // cached copy, so it's loaded anew from disk (resetPanelWorker in browser.mjs).
    if (!chrome) try { if (resetPanelWorker(profile())) log("side panel: its worker changed since the last start; the browser loads it anew"); } catch (e) { log(`side panel: ${e?.message || e}`); }
    // The browser's own pages reach the live view with the address in their launch switch and the
    // key in an owner-only file the other switch names (neither the key nor the path is logged).
    const helper = chrome ? await helperFor().catch((e) => { log("live view", e?.message || e); return null; }) : null;
    if (chrome && !helper) log("the browser's own pages have no helper address");
    step("live view");
    forgetTemporaryDownloads();
    if (!screen && needsVirtualDisplay(config)) screen = await startVirtualDisplay(log);
    createSession(session);
    // The PairBrowse browser (scripts/browser.mjs), or another Chromium browser from config.
    let keyFile = null;
    if (helper) try { keyFile = helperKeyPath = writeHelperKeyFile(helper.key); } catch (e) { log(`the browser's own pages have no helper address (key file: ${e?.code || "refused"})`); }
    const launchLog = measuringLog({ log, status, notify });
    let ctx;
    try {
      ctx = await launchEngine(browserType(), config, profile(), {
        headless: false,
        // The helper's own shutdown closes the browser (daemon.mjs shutdown -> close below).
        // Playwright's signal handlers would start a close of their own on the same SIGTERM, and
        // then treat the helper's close as a second one: a SIGKILL of Chromium inside 50 ms, before
        // it wrote its cookies (it writes them every ~30 s and on a clean exit): logins lost.
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        env: { ...process.env, ...(screen?.env || {}) },
        executablePath: config.executablePath || await ensureBrowser(browserType(), log),
        viewport: null,
        // Its own side panel is the only extension it loads. A build with its own pages opens its
        // startup page (PairBrowse's new tab page), not the driver's about:blank (plans/555 D1.2).
        ignoreDefaultArgs: chrome ? ["--disable-extensions", "about:blank"] : ["--disable-extensions"],
        args: launchArgs(config, { firstRun, chromePages: chrome, helper: helper && keyFile ? { origin: helper.origin, keyFile } : null }),
      }, launchLog);
    } catch (e) { dropHelperKey(keyFile); throw e; } // a failed launch leaves no key file
    finally { launchLog.done(hud.badge()); }
    step("browser (fingerprint and launchPersistentContext inside)");
    pruneStaleContexts(ctx, { driver, log }); // the driver forgets a tab's old execution contexts as it navigates
    await ctx.addInitScript({ content: hud.source });
    // Never into the browser's own pages (its new tab page among them: plans/555 D1.3).
    for (const p of ctx.pages()) { adopt(p, ctx); if (!isChromePage(p.url())) hud.ensure(p); }
    // A tab can arrive already loaded (one the side panel opened at its address): its page
    // script comes now, since under Patchright it isn't there until ensure adds it.
    ctx.on("page", (p) => { adopt(p, ctx); p.waitForLoadState("domcontentloaded").then(() => { if (!isChromePage(p.url())) hud.onPageLoad(p); }, () => {}); setTimeout(() => capTabs(ctx, p).catch(() => {}), 300); });
    step(`first page (${ctx.pages().length} open)`);
    if (pick.state === "pending") showPicker(ctx, { own });
    else restore(ctx, null, { own });
    const mine = contextPromise;
    ctx.on("close", () => {
      dropHelperKey(keyFile); // this launch's own file: an older browser closing late keeps the next one's
      log("browser closed");
      // Closed for good (by hand, a crash, the turn cap), not on the way to another session: the
      // calls in flight hear of it.
      if (!switching) for (const fn of closeWatchers) try { fn(); } catch {}
      // Closed while asking: the next browser asks again.
      if (pick.state === "showing") { pick.state = "pending"; pick.page = null; }
      // Only the browser in use: an older one closing late never drops the next one.
      if (contextPromise === mine) contextPromise = null;
      hud.clearSparks();
      if (!switching) onClosed(); // switching sessions: the next one opens right away
    });
    log(`browser started (session ${session})`);
    onStarted(ctx);
    return ctx;
  }

  function getContext() {
    if (shuttingDown() && !contextPromise) return Promise.reject(new Error("PairBrowse is restarting. Retry in a moment."));
    if (switching) return switched.then(() => getContext());
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
  // Calls in flight when the browser closes (closed by hand, or crashed) are told at once.
  const closeWatchers = new Set();
  const watchClose = (fn) => { closeWatchers.add(fn); return () => closeWatchers.delete(fn); };
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
  function showPicker(ctx, { reopened = false, own = false } = {}) {
    pick.state = "showing";
    if (!reopened) tabTracker = null; // the saved tabs stay as they were until the person chose
    (async () => {
      // The browser may start without a window and open its first one a moment later: use that.
      for (let i = 0; !reopened && i < 20 && !ctx.pages().length; i++) await sleep(150);
      const page = reopened ? await ctx.newPage() : ctx.pages()[0] || (await ctx.newPage());
      pick.page = page;
      // The extension may still be loading right after launch: try a few times.
      for (let i = 0; i < 20 && pick.state === "showing" && !page.isClosed(); i++) {
        const at = Date.now();
        const went = await page.goto(pickerUrl(), { waitUntil: "domcontentloaded", timeout: 5000 }).then(() => "ok", (e) => String(e?.message || e).split("\n")[0].slice(0, 80));
        log(`launch: picker goto try ${i + 1} ${Date.now() - at} ms: ${went}`);
        if (went === "ok") break;
        await sleep(250);
      }
      await focusing(own, () => page.bringToFront().catch(() => {}));
      log("session picker shown");
    })().catch((e) => log("session picker", e?.message || e));
  }

  // The person asked to switch (the side panel's "Switch session..."): the picker opens again in a
  // new tab, and agents' next actions wait for the pick as at the start. Agents can't ask for it.
  async function reopenPicker() {
    if (pick.state === "showing") { await within(3000, Promise.resolve(pick.page?.bringToFront()).catch(() => {})); return { text: "The session picker is open." }; }
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

  // The person switches away from the session that's open (POST pick while no picker shows: the
  // session switcher, the new tab page's chips; daemon/pick.mjs checks who else is at work first):
  // { action: "use", name } or { action: "new" }. Checked here at once, then the browser restarts
  // on the other session after the answer went out (the page that asked closes with the window).
  // Returns { text } or { text, error: true }.
  async function switchForPerson({ action, name } = {}) {
    if (pick.state === "showing") return pickSession({ action, name });
    if (switching) return { text: "The browser is switching sessions; try again in a moment.", error: true };
    if (restoring) return { text: "Tabs are still reopening; switch once they're back.", error: true };
    if (action === "use") {
      if (!validName(name) || isTemporary(name) || !listSessions().some((s) => s.name === name)) return { text: `No session "${name}".`, error: true };
      if (name === session) return { text: `You're in session "${name}" already.` };
      setImmediate(() => switchTo(name).catch((e) => log("switch", e?.message || e)));
      return { text: `Opening session "${name}".` };
    }
    if (action === "new") {
      const target = `clean-${Date.now()}`;
      createSession(target);
      setImmediate(() => switchTo(target).catch((e) => log("switch", e?.message || e)));
      return { text: "Starting a fresh session." };
    }
    return { text: 'Use action "use" or "new".', error: true };
  }

  // ---- browser sessions ----------------------------------------------------------------

  const sessionInfo = () => ({ name: isTemporary(session) ? "Clean session" : session, where: where(), temporary: isTemporary(session) });

  // renameFrom: a person's rename of the open session (renameCurrent): the browser closes, the
  // session's files move to the new name, and the same session reopens with its tabs.
  async function switchTo(name, { renameFrom = null } = {}) {
    if (!renameFrom && name === session && contextPromise) {
      // The open session, chosen by an agent while the picker is up: the picker goes, its tabs come back.
      if (pick.state === "showing") {
        const ctx = await contextPromise;
        picked(`Session "${name}" was chosen by an agent. Its tabs are reopening.`);
        await pick.page?.goto("about:blank").catch(() => {});
        restore(ctx);
      }
      return;
    }
    while (switching) await switched; // one switch at a time
    let done;
    switched = new Promise((r) => { done = r; });
    switching = true;
    let renamed = false;
    try {
      // Another switch ran first: this rename is over (nothing closed, nothing moved).
      if (renameFrom && session !== renameFrom) { log(`rename of session ${renameFrom} dropped: the browser is on session ${session} now`); return; }
      const ctx = contextPromise && (await contextPromise);
      if (ctx) {
        await tabTracker?.saveNow();
        tabTracker?.stop();
        await ctx.close().catch(() => {});
      }
      if (renameFrom) {
        // Only once the browser is closed: a running Chromium keeps writing into its profile folder.
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
      const previous = session;
      session = name;
      rememberSession(name);
      if (isTemporary(name)) writeFileSync(CLEAN_MARKER, name);
      else rmSync(CLEAN_MARKER, { force: true });
      if (!renameFrom && isTemporary(previous) && previous !== name) deleteSession(previous);
      contextPromise = null;
    } finally {
      switching = false;
      done();
    }
    // An agent switching is a choice too: no picker in the next browser.
    if (!renameFrom) picked(`Session "${isTemporary(name) ? "clean" : name}" was chosen by an agent.`);
    if (renamed) hostNote(`The person renamed this browser session "${renameFrom}" to "${name}"; the browser restarted on it and its tabs are reopening (pairbrowse_session use ${name}).`);
    await getContext();
    log(renameFrom ? `session ${renameFrom} renamed to ${name}` : `switched to session ${name}`);
  }

  // A person renames the open session (the session card's pencil, POST session): checked here
  // at once, then the browser restarts on the renamed session (switchTo's rename mode) after the
  // answer went out. Returns { ok, name, from, restarting } or { error }.
  function renameCurrent(given) {
    const from = session;
    const to = String(given ?? "").trim();
    if (!contextPromise) return { error: "The browser isn't open; open it first, then rename its session." };
    if (switching) return { error: "The browser is switching sessions; try again in a moment." };
    if (restoring) return { error: "Tabs are still reopening; rename the session once they're back." };
    if (pick.state === "showing") return { error: "The session picker is open; pick a session first." };
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
    if (from === session) return renameCurrent(to);
    if (switching) return { error: "The browser is switching sessions; try again in a moment." };
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
    if (!contextPromise) return { error: "The browser isn't open." };
    if (switching) return { error: "The browser is switching sessions; try again in a moment." };
    if (restoring) return { error: "Tabs are still reopening; save once they're back." };
    if (isTemporary(session)) return { error: "A clean session isn't kept: there is nothing to save." };
    if (!tabTracker) return { error: "Pick a session first." };
    await tabTracker.saveNow();
    return { ok: true };
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

  // A file the person opened from Downloads, in a new active tab that is theirs for its whole
  // life (personTabs): no agent reads or acts in it. onClose(): called once the tab closes.
  // Resolves { ok: true, page } or { error }; never throws.
  const NO_TAB = "The file couldn't be shown in a tab.";
  async function openForPerson(url, { onClose } = {}) {
    if (!contextPromise || switching || pick.state === "showing") return { error: "The browser isn't open, so the file can't be shown in a tab." };
    const ctx = await within(5000, getContext().catch(() => null));
    const page = ctx ? await within(5000, keepFocus(() => ctx.newPage()).catch(() => null)) : null;
    if (!page) return { error: NO_TAB };
    personTabs.add(page);
    page.once("close", () => {
      personTabs.delete(page);
      try { onClose?.(); } catch {}
    });
    const ok = await within(10_000, page.goto(url, { waitUntil: "commit" }).then(() => true, () => false));
    if (ok !== true) {
      await within(3000, page.close({ runBeforeUnload: false }).catch(() => {}));
      return { error: NO_TAB };
    }
    await within(3000, keepFocus(() => page.bringToFront()).catch(() => {}));
    return { ok: true, page };
  }

  // At startup: throwaway sessions a crash left behind, and the note that a clean one ended.
  // The person opened the PairBrowse browser by hand, and its bare start handed itself to this
  // helper (scripts/open.mjs; plans/555 item 6): the browser opens as the helper's, or the window
  // already open comes to the front. { ok } once it's up, or after acceptMs while it still starts
  // (the launch goes on; a failure after that is logged). { ok: false, why } when the browser this
  // helper uses isn't a PairBrowse build with its own pages (then the person's start opens as a
  // plain window, as before), while the helper stops, or when the launch failed at once.
  async function openByHand({ acceptMs = OPEN_ACCEPT_MS } = {}) {
    if (shuttingDown()) return { ok: false, why: "PairBrowse is restarting" };
    const pages = contextPromise && chosen ? chrome : predict().pages;
    if (!pages) return { ok: false, why: "the browser in use here isn't the PairBrowse browser (\"browser\" in ~/.pairbrowse/config.json)" };
    if (!contextPromise) byHand = true; // this start is the person's: it may come to the front
    const up = getContext().then(async (ctx) => {
      const page = pick.state === "showing" && pick.page && !pick.page.isClosed() ? pick.page : ctx.pages().findLast((p) => !p.isClosed()) || null;
      if (page) await within(3000, page.bringToFront().catch(() => {}));
      return { ok: true };
    }, (e) => ({ ok: false, why: e?.message || String(e) }));
    const answer = await within(acceptMs, up);
    if (answer) return answer;
    up.then((a) => { if (!a.ok) log(`the browser opened by hand didn't start: ${a.why}`); });
    return { ok: true };
  }

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
    dropHelperKey();
    try { sweepTemporary(); } catch {}
    screen?.stop();
  }

  // Before the browser runs: the config the next launch would use (the build chooseEngine would
  // pick, without installing anything). Read from disk once per choice.
  let predicted = null;
  function predict() {
    let next = config;
    if (!(config.browserEngine === "pairbrowse" && config.executablePath)) {
      try {
        const choice = browserChoice(choiceConfig(), { native: !!pinnedAsset() });
        if (choice.browser === "pairbrowse") next = { ...config, browserEngine: "pairbrowse", executablePath: choice.executablePath || nativeDirs().exec };
      } catch {}
    }
    const sig = `${next.browserEngine}\u0001${next.executablePath}`;
    if (predicted?.sig !== sig) {
      const pages = !!chromePagesOf(next);
      predicted = { sig, pages, capture: pages && !!capturePagesOf(next) };
    }
    return predicted;
  }

  return {
    chromePages: () => chrome,
    capturePages: () => capture,
    // The same, before the browser has started too (what it will be once it runs): an invite made
    // first says what the share will really carry.
    willHaveChromePages: () => (contextPromise && chosen ? chrome : predict().pages),
    willHaveCapturePages: () => (contextPromise && chosen ? capture : predict().capture),
    openForPerson, isPersonTab: (p) => personTabs.has(p), openByHand,
    // The browser of the window open now ("pairbrowse", "chromium" or a path), null when none is.
    browserInUse: () => (contextPromise ? inUse : null),
    // The settings the choice is read from (config with the older names as the person wrote them).
    choiceConfig,
    getContext, watchClose, current: () => contextPromise, profile, openPages, findPage, pageAt, ready, takeRestoredActive, touch,
    isRestoring: () => restoring !== null, isSwitching: () => switching,
    currentUrl: () => lastCurrentUrl, setCurrentUrl: (url) => { lastCurrentUrl = url; },
    sessionInfo, sessionCommand, startUp, close, sessionName: () => session, renameSaved, renameCurrent, saveTabs,
    // The browser's pages used their key (or the helper stops): its file has done its job.
    dropHelperKey: () => dropHelperKey(),
    waitForPick, pickerState, pickSession, pickedJoin, switchForPerson, // In the session being opened, when the person just picked another.
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
