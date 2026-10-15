// Launching the browser: which one (the native PairBrowse build, installed when needed, Chromium or
// one of your own: browser/choice.mjs), its profile and key files, the launch itself, getContext()
// for everyone who needs the browser, its close, and what the next launch would be.
// st: the browser's state (browser/state.mjs); api: the other parts' functions, read when called.
import { ensureBrowser, launchOptions, prepareProfile, panelExtensionId, resetPanelWorker, writeHelperKeyFile, dropHelperKeyFile, CAPTURE_KEY_PREFIX } from "../../browser.mjs";
import { chooseBrowser, engineConfig, shellOf } from "../../browser/choice.mjs";
import { engineProfile, launchEngine, validateEngine } from "../../engine.mjs";
import { ensureNative, nativeDirs, nativeLayout, notChosen, pinnedAsset } from "../../native-install.mjs";
import { needsVirtualDisplay, startVirtualDisplay } from "../../display.mjs";
import { profileDir, createSession, sweepTemporary } from "../../sessions.mjs";
import { within } from "../../util.mjs";
import { MEASURING } from "../../native-engine.mjs";
import { OPEN_ACCEPT_MS } from "../../opener.mjs";
import { isChromePage, CHROME_PICKER, extensionUrl } from "../../../ui/urls.js";
import { pruneStaleContexts } from "../exec-contexts.mjs";

// An extension page: web pages can't open, frame or script it (no web_accessible_resources).
// A build with its own pages shows its own picker instead (CHROME_PICKER, ui/urls.js).
// The shell of the browser an engine config launches (browser/choice.mjs shellOf): whether it is a
// native build that declares its own pages (its manifest's `chrome` field), whether that build also
// declares its capture page, and whether that page reads a key of its own. Tests pass their own.
export const chromePagesIn = (engine) => shellOf(engine).ownPages;
export const capturePagesIn = (engine) => shellOf(engine).capturePage;
export const captureKeyedIn = (engine) => shellOf(engine).captureKeyed;

// This Mac's one-time capture (native-engine.mjs MEASURING): the first launch of a browser version
// waits up to a minute for it, and says so in the live view's status line and a notification (no
// browser yet, so no side panel or strip to show it). The launch's log, passing every line on;
// done(badge): the launch ended, the status line goes back to the badge.
// Each of its steps is bounded at 90 s (native-engine CAPTURE_STEP_MS); together they usually take under a minute.
export const MEASURING_STATUS = "Measuring this Mac once (usually under a minute, sometimes a few): the browser opens after that.";
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

export function createLaunch(st, deps, api) {
  const { chromium, config, driver, hud, log, notify, status, shuttingDown, onStarted, onClosed, chromePagesOf, capturePagesOf, captureKeyedOf, helperFor } = deps;
  // The driver's browser type: the object, or a getter (the helper loads its runtime after its socket listens).
  const browserType = () => (typeof chromium === "function" ? chromium() : chromium);

  // Sync and idempotent: a path given is one launch's own file (its close drops only that one).
  // The capture page's file goes with the pages' (the browser reads both as it starts).
  function dropHelperKey(path = st.helperKeyPath, capturePath = path === st.helperKeyPath ? st.captureKeyPath : null) {
    if (capturePath) { dropHelperKeyFile(capturePath); if (capturePath === st.captureKeyPath) st.captureKeyPath = null; }
    if (!path) return;
    dropHelperKeyFile(path);
    if (path === st.helperKeyPath) st.helperKeyPath = null;
  }
  const pickerUrl = () => (st.chrome ? CHROME_PICKER : extensionUrl(panelExtensionId(), "picker/index.html"));
  // Which browser runs ("browser" in config.json, chooseBrowser in browser/choice.mjs). Every launch
  // reads the choice anew (a change in Settings takes effect at the next start) and keeps it here
  // (engine, shell): config itself is never written, so the older names a person wrote stay as
  // they wrote them.
  const choiceConfig = () => config;
  // The shell of the browser an engine config launches, read once per choice.
  const shellFor = (e) => {
    const ownPages = !!chromePagesOf(e);
    const capturePage = ownPages && !!capturePagesOf(e);
    return { kind: ownPages ? "pages" : "extension", ownPages, capturePage, captureKeyed: capturePage && !!captureKeyedOf(e) };
  };
  const said = new Set(); // lines about the choice, logged once per helper run
  const once = (line) => { if (!said.has(line)) { said.add(line); log(line); } };
  const installWaiters = new Set();

  const profile = () => engineProfile(st.engine || config, profileDir(st.session));

  // The browser the person chose ("browser"): the native PairBrowse browser (the pinned build,
  // installed and checked when it's missing or a new version is pinned, scripts/native-install.mjs),
  // "chromium" (ensureBrowser at launch) or a browser of their own. Unset: the native build where
  // one is pinned for this computer, else chromium; the helper never records that default. Never a
  // quiet switch from the native build to Chromium: only "browser": "chromium" picks that.
  async function chooseEngine() {
    const asset = pinnedAsset();
    const spec = chooseBrowser(config, { native: !!asset, pinnedExec: () => nativeDirs().exec });
    if (spec.problem) once(spec.problem);
    if (!spec.set) once(`browser: no choice recorded yet; using ${spec.browser} (Settings, or "browser" in ~/.pairbrowse/config.json)`);
    st.inUse = spec.browser;
    let executablePath = spec.executablePath; // a native build of your own (the older names), a path of your own, or null
    if (spec.install) {
      const optOut = 'To use Chromium instead, set "browser": "chromium" in ~/.pairbrowse/config.json.';
      const installLog = (m) => {
        log(m);
        if (st.installing || !/^(downloading|unpacking)/.test(m)) return;
        st.installing = true;
        notify("Installing the PairBrowse browser. It takes a minute or two, once.");
        for (const fn of installWaiters) fn();
      };
      let native = null;
      try {
        native = nativeLayout() ? await ensureNative(installLog, { asset, config }) : null;
      } catch (e) {
        if (st.installing) notify("The PairBrowse browser couldn't be installed. Ask Claude what happened.");
        throw new Error(`The PairBrowse browser couldn't be installed: ${e.message} ${optOut}`);
      } finally {
        if (st.installing && native) notify("The PairBrowse browser is installed.");
        st.installing = false;
      }
      if (!native) throw new Error(`There's no PairBrowse browser build for ${process.platform} ${process.arch} yet. ${optOut}`);
      executablePath = native;
    } else if (spec.binary !== "native") {
      // A recorded chromium or path of your own: the log says why nothing is installed, once.
      const why = spec.set && !spec.problem ? notChosen(config, !!asset) : null;
      if (why) once(why);
    }
    // null for chromium: the PairBrowse Chromium (ensureBrowser at launch).
    const next = engineConfig(config, { binary: spec.binary, executablePath });
    validateEngine(next);
    st.engine = next;
    return next;
  }




  async function launch() {
    const own = st.byHand;
    st.byHand = false;
    st.chosen = false;
    // Each launch step's time (plans/555 item 4), logged as "launch: <step> <ms> ms".
    let stepAt = Date.now();
    const step = (name) => { const now = Date.now(); log(`launch: ${name} ${now - stepAt} ms`); stepAt = now; };
    const next = await chooseEngine();
    step("engine");
    st.shell = shellFor(next);
    st.chrome = st.shell.ownPages;
    st.capture = st.shell.capturePage;
    st.chosen = true;
    // The profile settings PairBrowse needs (blank start tab, pinned and enabled side panel,
    // colors; see prepareProfile in browser.mjs), written before each launch.
    const firstRun = prepareProfile(profile(), undefined, { chromePages: st.chrome, layout: config.layout });
    step("prepare");
    // A side panel worker from another build (an update): the browser would keep running its
    // cached copy, so it's loaded anew from disk (resetPanelWorker in browser.mjs).
    if (!st.chrome) try { if (resetPanelWorker(profile())) log("side panel: its worker changed since the last start; the browser loads it anew"); } catch (e) { log(`side panel: ${e?.message || e}`); }
    // The browser's own pages reach the live view with the address in their launch switch and the
    // key in an owner-only file the other switch names (neither the key nor the path is logged).
    const helper = st.chrome ? await helperFor().catch((e) => { log("live view", e?.message || e); return null; }) : null;
    if (st.chrome && !helper) log("the browser's own pages have no helper address");
    step("live view");
    api.forgetTemporaryDownloads();
    if (!st.screen && needsVirtualDisplay(config)) st.screen = await startVirtualDisplay(log);
    createSession(st.session);
    // The PairBrowse browser (scripts/browser.mjs), or another Chromium browser from config.
    let keyFile = null, captureKeyFile = null;
    if (helper) try { keyFile = st.helperKeyPath = writeHelperKeyFile(helper.key); } catch (e) { log(`the browser's own pages have no helper address (key file: ${e?.code || "refused"})`); }
    // A capture page that reads its own key gets a new one now (and the helper requires it); a
    // file that can't be written leaves the capture page without one (it is refused: fail closed).
    const ck = helper?.newCaptureKey?.(!!(keyFile && st.capture && st.shell.captureKeyed)) || null;
    if (ck) try { captureKeyFile = st.captureKeyPath = writeHelperKeyFile(ck, undefined, CAPTURE_KEY_PREFIX); } catch (e) { log(`the capture page has no key (key file: ${e?.code || "refused"})`); }
    const launchLog = measuringLog({ log, status, notify });
    let ctx;
    try {
      ctx = await launchEngine(browserType(), next, profile(), {
        // The helper's own shutdown closes the browser (daemon.mjs shutdown -> close below).
        // Playwright's signal handlers would start a close of their own on the same SIGTERM, and
        // then treat the helper's close as a second one: a SIGKILL of Chromium inside 50 ms, before
        // it wrote its cookies (it writes them every ~30 s and on a clean exit): logins lost.
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        // The launch itself, as the install self-check makes it too (browser.mjs launchOptions).
        ...launchOptions(config, {
          shell: st.shell, firstRun,
          env: { ...process.env, ...(st.screen?.env || {}) },
          executablePath: next.executablePath || await ensureBrowser(browserType(), log),
          helper: helper && keyFile ? { origin: helper.origin, keyFile, ...(captureKeyFile ? { captureKeyFile } : {}) } : null,
        }),
      }, launchLog);
    } catch (e) { dropHelperKey(keyFile, captureKeyFile); throw e; } // a failed launch leaves no key file
    finally { launchLog.done(hud.badge()); }
    step("browser (fingerprint and launchPersistentContext inside)");
    pruneStaleContexts(ctx, { driver, log }); // the driver forgets a tab's old execution contexts as it navigates
    await ctx.addInitScript({ content: hud.source });
    // Never into the browser's own pages (its new tab page among them: plans/555 D1.3).
    for (const p of ctx.pages()) { api.adopt(p, ctx); if (!isChromePage(p.url())) hud.ensure(p); }
    // A tab can arrive already loaded (one the side panel opened at its address): its page
    // script comes now, since under Patchright it isn't there until ensure adds it.
    ctx.on("page", (p) => { api.adopt(p, ctx); p.waitForLoadState("domcontentloaded").then(() => { if (!isChromePage(p.url())) hud.onPageLoad(p); }, () => {}); setTimeout(() => api.capTabs(ctx, p).catch(() => {}), 300); });
    step(`first page (${ctx.pages().length} open)`);
    if (st.pick.state === "pending") api.showPicker(ctx, { own });
    else api.restore(ctx, null, { own });
    const mine = st.contextPromise;
    ctx.on("close", () => {
      dropHelperKey(keyFile, captureKeyFile); // this launch's own file: an older browser closing late keeps the next one's
      log("browser closed");
      // Closed for good (by hand, a crash, the turn cap), not on the way to another session: the
      // calls in flight hear of it.
      if (!st.switching) for (const fn of closeWatchers) try { fn(); } catch {}
      // Closed while asking: the next browser asks again.
      if (st.pick.state === "showing") { st.pick.state = "pending"; st.pick.page = null; }
      // Only the browser in use: an older one closing late never drops the next one.
      if (st.contextPromise === mine) st.contextPromise = null;
      hud.clearSparks();
      if (!st.switching) onClosed(); // switching sessions: the next one opens right away
    });
    log(`browser started (session ${st.session})`);
    onStarted(ctx);
    return ctx;
  }

  function getContext() {
    if (shuttingDown() && !st.contextPromise) return Promise.reject(new Error("PairBrowse is restarting. Retry in a moment."));
    if (st.switching) return st.switched.then(() => getContext());
    if (!st.contextPromise) {
      st.launching = true;
      st.contextPromise = launch().catch((e) => {
        st.contextPromise = null;
        throw e;
      }).finally(() => { st.launching = false; installWaiters.clear(); });
    }
    if (!st.launching) return st.contextPromise;
    const busy = () => new Error("PairBrowse is installing its browser (the first start or a new version: a minute or two). Tell the user, then retry the last action in a minute.");
    if (st.installing) return Promise.reject(busy());
    return Promise.race([st.contextPromise, new Promise((_, reject) => installWaiters.add(() => reject(busy())))]);
  }

  // The browser, once saved tabs are back.
  // Calls in flight when the browser closes (closed by hand, or crashed) are told at once.
  const closeWatchers = new Set();
  const watchClose = (fn) => { closeWatchers.add(fn); return () => closeWatchers.delete(fn); };
  async function ready() {
    while (st.pickSwitch) await st.pickSwitch; // never the old browser after the person picked another
    const ctx = await getContext();
    if (st.restoring) await st.restoring;
    return ctx;
  }

















  // The person opened the PairBrowse browser by hand, and its bare start handed itself to this
  // helper (scripts/open.mjs; plans/555 item 6): the browser opens as the helper's, or the window
  // already open comes to the front. { ok } once it's up, or after acceptMs while it still starts
  // (the launch goes on; a failure after that is logged). { ok: false, why } when the browser this
  // helper uses isn't a PairBrowse build with its own pages (then the person's start opens as a
  // plain window, as before), while the helper stops, or when the launch failed at once.
  async function openByHand({ acceptMs = OPEN_ACCEPT_MS } = {}) {
    if (shuttingDown()) return { ok: false, why: "PairBrowse is restarting" };
    const pages = nextShell().ownPages;
    if (!pages) return { ok: false, why: "the browser in use here isn't the PairBrowse browser (\"browser\" in ~/.pairbrowse/config.json)" };
    if (!st.contextPromise) st.byHand = true; // this start is the person's: it may come to the front
    const up = getContext().then(async (ctx) => {
      const page = st.pick.state === "showing" && st.pick.page && !st.pick.page.isClosed() ? st.pick.page : ctx.pages().findLast((p) => !p.isClosed()) || null;
      if (page) await within(3000, page.bringToFront().catch(() => {}));
      return { ok: true };
    }, (e) => ({ ok: false, why: e?.message || String(e) }));
    const answer = await within(acceptMs, up);
    if (answer) return answer;
    // Still starting: taken (the opener's browser won't open a window of its own). A start that
    // fails from here on is said where the person looks, since nothing else would show it.
    up.then((a) => {
      if (a.ok) return;
      log(`the browser opened by hand didn't start: ${a.why}`);
      try { notify(`The PairBrowse browser didn't start: ${String(a.why).slice(0, 200)}. Open it again.`); } catch {}
    });
    return { ok: true };
  }


  // At shutdown: remember the tabs before they close; a clean close writes cookies to disk.
  async function close() {
    try {
      const ctx = st.contextPromise && (await st.contextPromise);
      await st.tabTracker?.saveNow();
      st.tabTracker?.stop();
      await ctx?.close();
    } catch {}
    dropHelperKey();
    try { sweepTemporary(); } catch {}
    st.screen?.stop();
  }

  // Before the browser runs: the shell the next launch would have (the build chooseEngine would
  // pick, without installing anything). Read from disk once per choice.
  function predict() {
    let next = st.engine || config;
    try {
      const spec = chooseBrowser(config, { native: !!pinnedAsset(), pinnedExec: () => nativeDirs().exec });
      next = engineConfig(config, { binary: spec.binary, executablePath: spec.install ? nativeDirs().exec : spec.executablePath });
    } catch {}
    const sig = `${next.browserEngine}\u0001${next.executablePath}`;
    if (st.predicted?.sig !== sig) st.predicted = { sig, shell: shellFor(next) };
    return st.predicted.shell;
  }
  // This launch's shell, or the next one's while no browser runs (what it will be once it runs).
  const nextShell = () => (st.contextPromise && st.chosen ? st.shell : predict());

  return { browserType, dropHelperKey, pickerUrl, choiceConfig, profile, getContext, watchClose, ready, openByHand, close, predict, nextShell };
}
