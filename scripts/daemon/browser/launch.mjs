// Launching the browser: which one (the native PairBrowse build, installed when needed, the open build or
// one of your own: browser/choice.mjs), its profile and key files, the launch itself, getContext()
// for everyone who needs the browser, its close, and what the next launch would be.
// st: the browser's state (browser/state.mjs); api: the other parts' functions, read when called.
import { ensureBrowser, launchOptions, prepareProfile, panelExtensionId, resetPanelWorker, writeHelperKeyFile, dropHelperKeyFile, CAPTURE_KEY_PREFIX } from "../../browser.mjs";
import { chooseBrowser, engineConfig, serverRefusal, shellOf } from "../../browser/choice.mjs";
import { engineProfile, launchEngine, validateEngine, SANDBOX } from "../../engine.mjs";
import { ensureNative, nativeDirs, nativeLayout, notChosen, pinnedAsset } from "../../native/install.mjs";
import { profileDir, createSession, sweepTemporary } from "../../sessions.mjs";
import { sleep, within } from "../../util.mjs";
import { setQuietTabs } from "../../focus.mjs";
import { shippedCrx } from "../../browser/adblock.mjs";
import { safeStorageFor, savedCardFor } from "../../browser/safe-storage.mjs";
import { MEASURING, nativeManifest } from "../../native-engine.mjs";
import { NATIVE } from "../../native-pack.mjs";
import { OPEN_ACCEPT_MS } from "../../opener.mjs";
import { isBrowserPage, BROWSER_PICKER, extensionUrl } from "../../../ui/urls.js";
import { pruneStaleContexts } from "../exec-contexts.mjs";
import { createGraphics, MEASURING_BUSY, MEASURING_WAIT_MS } from "./graphics.mjs";
import { probeLauncher } from "../../native/check.mjs";
import { screenGeometry } from "../../display.mjs";
import { paths } from "../../paths.mjs";
import { testMs, testOn } from "../../testenv.mjs";
import { startTabLoaded, START_LOAD_MS } from "./tabs.mjs";

// A test run's NetLog (testenv.mjs NETLOG, kept only in a helper the harness started): the browser
// writes what its network stack did, each name its own resolver was asked for among it, to
// <home>/netlog.json (written anew each launch), which the DNS leak tests read (spec server-mode
// C12). The helper's own switch, after the user's, so no browserArgs entry is needed or allowed.
export const NETLOG_SWITCH = "--log-net-log";
export const withNetLog = (options, { env = process.env, file = paths.netlog } = {}) =>
  (testOn("NETLOG", env) ? { ...options, args: [...(options.args || []), `${NETLOG_SWITCH}=${file}`] } : options);

// An extension page: web pages can't open, frame or script it (no web_accessible_resources).
// A build with its own pages shows its own picker instead (BROWSER_PICKER, ui/urls.js).
// The shell of the browser an engine config launches (browser/choice.mjs shellOf): whether it is a
// native build that declares its own pages (its build manifest's `chrome` field), whether that build also
// declares its capture page, whether that page reads a key of its own, and whether its settings are
// the engine settings' PairBrowse section (580). Tests pass their own.
export const browserPagesIn = (engine) => shellOf(engine).ownPages;
export const capturePagesIn = (engine) => shellOf(engine).capturePage;
export const captureKeyedIn = (engine) => shellOf(engine).captureKeyed;
export const settingsSectionIn = (engine) => shellOf(engine).settingsSection;
export const quietTabsIn = (engine) => shellOf(engine).quietTabs;
export const adBlockerIn = (engine) => shellOf(engine).adBlocker;
export const safeStorageKeyFileIn = (engine) => shellOf(engine).safeStorageKeyFile;
export const adBlockerCrxIn = (engine) => shellOf(engine).adBlockerCrx;
export const proxyAuthFileIn = (engine) => shellOf(engine).proxyAuthFile;

// A start (start: its promise) waited for through a graphics measurement: with no limit until a
// measurement runs (st.probing, at the call or when the waiters are told), as every start is
// waited for; from the moment one is first seen, at most ms more, then busy(true)'s error (the
// measurement's retry message). An install that begins meanwhile (st.installing when waiters are
// told, getContext's installWaiters) answers busy() at once, as for every other call.
// onMeasuring() once, when the measurement is first seen.
export function throughMeasurement(start, { st, waiters, ms, onMeasuring = () => {}, busy }) {
  let timer = null, waiter = null, stopWith = null;
  const measuring = () => {
    if (timer || !st.probing || !stopWith) return;
    timer = setTimeout(() => stopWith(busy(true)), ms);
    try { onMeasuring(); } catch {}
  };
  const stop = new Promise((_, reject) => {
    stopWith = reject;
    waiter = () => { if (st.installing) reject(busy()); else measuring(); };
    waiters.add(waiter);
  });
  measuring();
  return Promise.race([start, stop]).finally(() => { clearTimeout(timer); waiters.delete(waiter); });
}

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

// The page script at each document's start, where the driver can do that without touching the
// page's own response. Patchright can't: its init scripts (and exposeBinding, exposeFunction, the
// clock, tracing) install a route on every http(s) document that fetches it, writes a <script> into
// it and hands it back with Fetch.fulfillRequest. A fulfilled document has no certificate, so the
// address bar showed "Not secure" for every HTTPS page an agent loaded, the page's CSP was rewritten,
// and the script (with its key) sat in the page's own world. Under Patchright the script goes in
// as each page loads instead (hud.ensure on domcontentloaded: tabs.mjs, the "page" listener below),
// in the driver's hidden world; Playwright adds it with the browser's own call, untouched documents.
export async function addPageScript(ctx, driver, source) {
  if (driver === "patchright") return false;
  await ctx.addInitScript({ content: source });
  return true;
}

// How long a stop waits for saved tabs still reopening (close below), inside the helper's 5 s.
const RESTORE_WAIT_MS = 3000;
// What a stop leaves the browser's own close (its cookies written) before the helper's deadline.
export const CLOSE_RESERVE_MS = 1500;

export function createLaunch(st, deps, api) {
  const { chromium, config, driver, hud, log, notify, status, shuttingDown, onStarted, onClosed, browserPagesOf, capturePagesOf, captureKeyedOf, settingsSectionOf, quietTabsOf = quietTabsIn, adBlockerOf = adBlockerIn, safeStorageKeyFileOf = safeStorageKeyFileIn, adBlockerCrxOf = adBlockerCrxIn, proxyAuthFileOf = proxyAuthFileIn, helperFor, network, ensureNativeBuild = ensureNative } = deps;
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
  const pickerUrl = () => (st.ownPages ? BROWSER_PICKER : extensionUrl(panelExtensionId(), "picker/index.html"));
  // Which browser runs ("browser" in config.json, chooseBrowser in browser/choice.mjs). Every launch
  // reads the choice anew (a change in Settings takes effect at the next start) and keeps it here
  // (engine, shell): config itself is never written, so the older names a person wrote stay as
  // they wrote them.
  const choiceConfig = () => config;
  // The shell of the browser an engine config launches, read once per choice.
  const shellFor = (e) => {
    const ownPages = !!browserPagesOf(e);
    const capturePage = ownPages && !!capturePagesOf(e);
    return { kind: ownPages ? "pages" : "extension", ownPages, capturePage, captureKeyed: capturePage && !!captureKeyedOf(e), settingsSection: ownPages && !!settingsSectionOf(e), quietTabs: ownPages && !!quietTabsOf(e), adBlocker: ownPages && !!adBlockerOf(e), safeStorageKeyFile: ownPages && !!safeStorageKeyFileOf(e), adBlockerCrx: (ownPages && adBlockerOf(e) && adBlockerCrxOf(e)) || null, proxyAuthFile: ownPages && !!proxyAuthFileOf(e) };
  };
  const said = new Set(); // lines about the choice, logged once per helper run
  const once = (line) => { if (!said.has(line)) { said.add(line); log(line); } };
  // Calls waiting on a launch, told to retry once it installs the browser or measures its graphics
  // (getContext below): neither holds an agent's call silently for minutes.
  const installWaiters = new Set();
  const tellWaiters = () => { for (const fn of installWaiters) fn(); };
  // The launch's graphics, section 3.2 steps 4 and 7 (browser/graphics.mjs); a probe that starts
  // tells the waiting calls (st.probing).
  const graphics = createGraphics(st, deps, { ...api, onProbing: tellWaiters });

  const profile = () => engineProfile(st.engine || config, profileDir(st.session));

  // The browser the person chose ("browser"): the native PairBrowse browser (the pinned build,
  // installed and checked when it's missing or a new version is pinned, scripts/native-install.mjs),
  // "pairbrowse-open" (ensureBrowser at launch) or a browser of their own. Unset: the native build
  // where one is pinned for this computer, else the open build; the helper never records that
  // default. Never a quiet switch from the native build to the open build: only "browser":
  // "pairbrowse-open" (or its older name "chromium") picks that.
  async function chooseEngine() {
    const asset = pinnedAsset();
    const spec = chooseBrowser(config, { native: !!asset, pinnedExec: () => nativeDirs().exec });
    if (spec.problem) once(spec.problem);
    if (!spec.set) once(`browser: no choice recorded yet; using ${spec.browser} (Settings, or "browser" in ~/.pairbrowse/config.json)`);
    // Server mode runs only the native build (spec server-mode decision 12): any other is refused
    // here, before anything is installed or started.
    const refused = serverRefusal(spec, { server: !!api.isServer?.(), allowOther: testOn("SERVER_OPEN") });
    if (refused) { once(`launch refused: ${refused}`); throw new Error(refused); }
    st.inUse = spec.browser;
    // The home's move to browser profiles, and the engine pack's folders set, before anything here
    // can load the pack (an install's self-check launches it in this process; it reads those
    // folders once, when it loads). Once per helper (sessions/profiles.mjs prepare).
    api.profiles.prepare({ native: spec.binary === "native" });
    let executablePath = spec.executablePath; // a native build of your own (the older names), a path of your own, or null
    if (spec.install) {
      const optOut = 'To use PairBrowse as an extension instead, set "browser": "pairbrowse-open" in ~/.pairbrowse/config.json.';
      const installLog = (m) => {
        log(m);
        if (st.installing || !/^(downloading|unpacking)/.test(m)) return;
        st.installing = true;
        notify("Installing the PairBrowse browser. It takes a minute or two, once.");
        tellWaiters();
      };
      let native = null, checked = null;
      try {
        native = nativeLayout() ? await ensureNativeBuild(installLog, { asset, config, onGraphics: (m) => { checked = m; }, profileArgs: api.profiles.selfCheckArgs?.() ?? [] }) : null;
      } catch (e) {
        if (st.installing) notify("The PairBrowse browser couldn't be installed. Ask Claude what happened.");
        throw new Error(`The PairBrowse browser couldn't be installed: ${e.message} ${optOut}`);
      } finally {
        if (st.installing && native) notify("The PairBrowse browser is installed.");
        st.installing = false;
      }
      if (!native) throw new Error(`There's no PairBrowse browser build for ${process.platform} ${process.arch} yet. ${optOut}`);
      executablePath = native;
      // An install's self-check measured the new build's graphics with config.json's settings: kept
      // as the default profile's evidence for it (sessions/profiles.mjs fileSelfCheck).
      if (checked) {
        let build = null;
        try { build = nativeManifest(native).version; } catch {}
        api.profiles.fileSelfCheck(checked, { build, pack: NATIVE.engine.sha256, virtualScreen: checked.runtime?.display === "xvfb" ? screenGeometry(config) : null });
      }
    } else if (spec.binary !== "native") {
      // A recorded open build or path of your own: the log says why nothing is installed, once.
      const why = spec.set && !spec.problem ? notChosen(config, !!asset) : null;
      if (why) once(why);
    }
    // null for the open build: PairBrowse's own (ensureBrowser at launch).
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
    setQuietTabs(st.shell.quietTabs); // its tab changes never come in front: keepFocus has nothing to do
    st.ownPages = st.shell.ownPages;
    st.capture = st.shell.capturePage;
    st.chosen = true;
    // The browser's own pages reach the live view with the address in their launch switch and the
    // key in an owner-only file the other switch names (neither the key nor the path is logged).
    const helper = st.ownPages ? await helperFor().catch((e) => { log("live view", e?.message || e); return null; }) : null;
    if (st.ownPages && !helper) log("the browser's own pages have no helper address");
    step("live view");
    api.forgetTemporaryDownloads();
    // A virtual screen when this machine needs one (browser/supervise.mjs). Kept here, not read from
    // st.screen later: a screen lost while the launch waits below is never swapped for no screen.
    const screen = await api.ensureScreen();
    createSession(st.session);
    // The session's browser profile (sessions/profiles.mjs, spec server-mode section 3.2 step 2):
    // its assignment, binding and engine checked, mapped to this launch's switches, engine layer,
    // network and ad blocker, or the refusal this launch stops with (nothing written yet but the
    // binding of a first start). native: this build's version, which its validation is kept under.
    const native = next.browserEngine === "pairbrowse";
    const chosen = api.profiles.forLaunch(st.session, { browserKind: native ? "pairbrowse" : "pairbrowse-open", build: native ? nativeManifest(next.executablePath).version : null, pack: NATIVE.engine.sha256 });
    step("profile");
    const launchLog = measuringLog({ log, status, notify });
    let ctx, net = null, launchSwitches, keyFile = null, captureKeyFile = null, graphicsPlan;
    try {
      // The session's network (daemon/network.mjs, spec server-mode section 3.2 step 3): its proxy,
      // strict switches and auth file, or the refusal this launch stops with (never direct instead),
      // before the graphics step's probe, so a refusal never waits for it. Inside the try, so the
      // finally drops its auth file whatever stops the launch.
      // The profile's network id counts unless config.json's network.sessions names one (C4).
      // locale: what its pages read, judged against the exit's country at the check (C13).
      net = network ? network.forLaunch(st.session, { profileNetwork: chosen.network, shell: st.shell, native, locale: chosen.locale }) : null;
      // The graphics this start can have (browser/graphics.mjs, spec server-mode section 3.2 step 4):
      // the measurement kept for this build, or one made now in a probe browser of its own (the first
      // start per runtime; no proxy and never geoip, native/check.mjs probeEngine), and every static
      // compatibility error refusing the start by name.
      graphicsPlan = await graphics.before({ chosen, native, build: chosen.build, pack: NATIVE.engine.sha256, screen, session: st.session,
        probeLaunch: native ? probeLauncher({ chromium: browserType(), engine: { ...next, browserProfile: { ...chosen.engine, geoip: false } }, config, shell: st.shell, screen, env: process.env, executablePath: next.executablePath, profileArgs: chosen.switches, server: api.isServer(), log }) : null });
      step("graphics");
      // The proxy's exit (the helper's probe, started with the network above and bounded by its own
      // time): the WebRTC address pages see in a proxied session, on a build that shows one
      // (native-engine.mjs launchNative; docs/security.md). Null for a direct session.
      const webrtcExit = net ? await net.exit() : null;
      // The profile settings PairBrowse needs (blank start tab, pinned and enabled side panel,
      // colors; see prepareProfile in browser.mjs), written before each launch. The ad blocker: the
      // profile's choice, else config.json's. A saved card (spec server-mode B12): payment autofill
      // on only when the profile asks and this launch's Safe Storage is a real key store (the
      // Keychain or the per-install key file, checked now; browser/safe-storage.mjs), read once
      // here and handed to launchOptions, so the browser gets the key store the preference counted on.
      // The profile's light or dark scheme as the browser's Appearance setting (native only).
      const adBlockerOn = chosen.adBlocker ?? config.adBlocker !== false;
      const storage = safeStorageFor(config, st.shell, paths.safeStorageKey);
      const card = savedCardFor({ asked: chosen.savedCard === true, native, storage });
      api.profiles.setSavedCard?.(card);
      const firstRun = prepareProfile(profile(), undefined, { browserPages: st.ownPages, layout: config.layout, adBlocker: st.shell.adBlocker && adBlockerOn, adBlockerCrx: shippedCrx(st.shell.adBlockerCrx, next.executablePath), savedCard: card.on, colorScheme: chosen.colorScheme ?? null });
      step("prepare");
      // A side panel worker from another build (an update): the browser would keep running its
      // cached copy, so it's loaded anew from disk (resetPanelWorker in browser.mjs).
      if (!st.ownPages) try { if (resetPanelWorker(profile())) log("side panel: its worker changed since the last start; the browser loads it anew"); } catch (e) { log(`side panel: ${e?.message || e}`); }
      // The PairBrowse browser (scripts/browser.mjs), or another browser on the same engine from config.
      if (helper) try { keyFile = st.helperKeyPath = writeHelperKeyFile(helper.key); } catch (e) { log(`the browser's own pages have no helper address (key file: ${e?.code || "refused"})`); }
      // A capture page that reads its own key gets a new one now (and the helper requires it); a
      // file that can't be written leaves the capture page without one (it is refused: fail closed).
      const ck = helper?.newCaptureKey?.(!!(keyFile && st.capture && st.shell.captureKeyed)) || null;
      if (ck) try { captureKeyFile = st.captureKeyPath = writeHelperKeyFile(ck, undefined, CAPTURE_KEY_PREFIX); } catch (e) { log(`the capture page has no key (key file: ${e?.code || "refused"})`); }
      const options = {
        // The helper's own shutdown closes the browser (daemon.mjs shutdown -> close below).
        // Playwright's signal handlers would start a close of their own on the same SIGTERM, and
        // then treat the helper's close as a second one: a SIGKILL of the browser inside 50 ms, before
        // it wrote its cookies (it writes them every ~30 s and on a clean exit): logins lost.
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        // The launch itself, as the install self-check makes it too (browser.mjs launchOptions),
        // with the profile's switches after browserArgs (its window in place of the fixed size).
        ...launchOptions(config, {
          shell: st.shell, firstRun, screen, profileArgs: chosen.switches,
          storage, // the Safe Storage the saved card was decided on
          env: { ...process.env, ...(screen?.env || {}) },
          executablePath: next.executablePath || await ensureBrowser(browserType(), log),
          helper: helper && keyFile ? { origin: helper.origin, keyFile, ...(captureKeyFile ? { captureKeyFile } : {}) } : null,
        }),
      };
      launchSwitches = options.args || [];
      // The native build's engine layer: the profile's keys, geoip and the id its persona is saved
      // under; and the virtual screen, which on Linux is the screen pages read (spec E7).
      // measuredBackend: the measurement's backend (step 4), which on a host without a GPU makes
      // the native launch show the engine's identity (decision 10; native-engine.mjs applyGraphicsPlan).
      ctx = await launchEngine(browserType(), { ...next, browserProfile: chosen.engine, virtualDisplay: screen?.geometry ?? null, measuredBackend: graphicsPlan?.measured?.backend ?? null, webrtcExit }, profile(), withNetLog(net ? net.apply(options) : options), launchLog, undefined, { server: api.isServer() }); // in server mode the sandbox is required (spec server-mode A10)
    } catch (e) { dropHelperKey(keyFile, captureKeyFile); throw e; } // a failed launch leaves no key file
    finally { net?.drop(); launchLog.done(hud.badge()); } // the proxy's auth file: read by now, or the launch failed
    // The screen ended while the browser started (supervise.mjs lost() cleared it): this browser has
    // no screen, so it closes and the launch fails; the next action starts a new screen.
    if (screen && st.screen !== screen) {
      await within(5000, ctx.close().catch(() => {}));
      dropHelperKey(keyFile, captureKeyFile);
      throw new Error("the virtual screen ended while the browser started; see daemon.log");
    }
    // The session's egress check (daemon/network.mjs, spec server-mode section 3.2 step 6, C7):
    // before any tab is adopted or saved tab loads. A failure closes the browser and fails the
    // launch with the reason; the close handler isn't on yet, so it is no crash for the guard.
    const checked = net ? await network.checkAtLaunch(ctx, st.session, net) : { ok: true };
    if (!checked.ok) {
      await within(5000, ctx.close().catch(() => {}));
      dropHelperKey(keyFile, captureKeyFile);
      throw new Error(checked.refusal);
    }
    if (net?.proxy) step("network check");
    // The browser process's own graphics read (browser/graphics.mjs, section 3.2 step 7): a GPU
    // asked for over software, a backend other than the measured one, or (requireValidatedProfiles)
    // a profile not validated for this runtime closes the browser before any tab loads; the
    // verdict is kept with the profile. Not a crash for the guard either (no close handler yet).
    const drawn = await graphics.after(ctx, graphicsPlan, { chosen, switches: launchSwitches, session: st.session });
    if (!drawn.ok) {
      await within(5000, ctx.close().catch(() => {}));
      dropHelperKey(keyFile, captureKeyFile);
      throw new Error(drawn.refusal);
    }
    step("graphics read");
    // The running browser's network from now (network.strict(), C11), and its exit's rechecks
    // (daemon/network.mjs, C8): they end with this browser's close, tied on at the moment they
    // start, so a crash before the close handler below is on never leaves them running.
    if (net) { net.started(); ctx.once("close", () => network.stop(net)); }
    try {
      hud.setSandboxOff?.(SANDBOX.on === false); // the bar warns while the sandbox is off
      step("browser (fingerprint and launchPersistentContext inside)");
      pruneStaleContexts(ctx, { driver, log }); // the driver forgets a tab's old execution contexts as it navigates
      await addPageScript(ctx, driver, hud.source);
      deps.phishing?.watch(ctx); // listed phishing sites stopped before they show (daemon/phishing.mjs)
      // Never into the browser's own pages (its new tab page among them: plans/555 D1.3).
      for (const p of ctx.pages()) { api.adopt(p, ctx); if (!isBrowserPage(p.url())) hud.ensure(p); }
      // A tab can arrive already loaded (one the side panel opened at its address): its page
      // script comes now, since under Patchright it isn't there until ensure adds it.
      ctx.on("page", (p) => { api.adopt(p, ctx, { opened: true }); p.waitForLoadState("domcontentloaded").then(() => { if (!isBrowserPage(p.url())) hud.onPageLoad(p); }, () => {}); setTimeout(() => api.capTabs(ctx, p).catch(() => {}), 300); });
      step(`first page (${ctx.pages().length} open)`);
      awaitStartTab(ctx.pages()[0]);
      if (st.pick.state === "pending") api.showPicker(ctx, { own });
      else api.restore(ctx, null, { own });
    } catch (e) { if (net) network.stop(net); throw e; } // a launch that fails here: its rechecks end with it
    const mine = st.contextPromise;
    const launchedAt = Date.now();
    ctx.on("close", () => {
      dropHelperKey(keyFile, captureKeyFile); // this launch's own file: an older browser closing late keeps the next one's
      log("browser closed");
      // Closed for good (by hand, a crash, the turn cap), not on the way to another session: the
      // calls in flight hear of it.
      if (!st.switching) for (const fn of closeWatchers) try { fn(); } catch {}
      // Each saved tab's place, so an agent's tab is the same tab when the tabs come back (a
      // switch noted them before it closed the browser). Only the browser in use: an older one
      // closing late would note the next one's tabs.
      if (!st.switching && st.contextPromise === mine) api.notePlaces?.();
      // A close nobody asked for, on a server: the crash-loop guard counts it (browser/supervise.mjs)
      // and, unless it now holds, keep-alive starts the browser again after a pause.
      // The helper's own resets (a stalled call, the turn cap) are not crashes.
      if (!st.switching && !st.resetting && !shuttingDown() && !api.noteUnexpectedClose(launchedAt)) api.relaunchSoon(launchedAt);
      // Closed while asking: the next browser asks again.
      if (st.pick.state === "showing") { st.pick.state = "pending"; st.pick.page = null; }
      // Only the browser in use: an older one closing late never drops the next one (nor its profile).
      if (st.contextPromise === mine) { st.contextPromise = null; api.profiles.release(); graphics.release(); }
      hud.clearSparks();
      if (!st.switching) onClosed(); // switching sessions: the next one opens right away
    });
    log(`browser started (session ${st.session})`);
    onStarted(ctx);
    return ctx;
  }

  // The start tab's own first load (browser/tabs.mjs startTabLoaded): a build with its own pages
  // opens its new tab page there, and the first agent call waits for that load (ready()), at most
  // START_LOAD_MS. A browser that starts on about:blank has none to wait for. Under the test
  // harness, START_TAB_LATE stands in for a slow machine: the start tab's own load is one that
  // begins that many ms after the launch (the new tab page again, or, in a browser that started on
  // about:blank, for the first time).
  function awaitStartTab(page) {
    const late = testMs("START_TAB_LATE", 0);
    if (!page || !(st.ownPages || late)) return;
    const ms = testMs("START_TAB_WAIT_MS", START_LOAD_MS), t0 = Date.now();
    const load = !late ? startTabLoaded(page, { ms }) : sleep(late).then(async () => {
      if (page.isClosed()) return "closed";
      log("launch: the start tab's own load, late (START_TAB_LATE)");
      await within(ms, page.goto("chrome://newtab/", { waitUntil: "commit" }).catch(() => {}));
      return startTabLoaded(page, { ms });
    });
    const wait = within(ms, load)
      .then((how) => log(`launch: start tab ${how || "timeout"} after ${Date.now() - t0} ms`), () => {})
      .finally(() => { if (st.starting === wait) st.starting = null; });
    st.starting = wait;
  }

  // waitMeasuring: a caller that waits through a graphics measurement rather than being told to
  // retry (an agent's session switch, sessions/switch.mjs): MEASURING_WAIT_MS at most from when one
  // is first seen (browser/graphics.mjs), a start without one with no limit; onMeasuring() is
  // called once if one runs while it waits. An install still answers at once.
  function getContext({ waitMeasuring = false, onMeasuring = () => {} } = {}) {
    if (shuttingDown() && !st.contextPromise) return Promise.reject(new Error("PairBrowse is restarting. Retry in a moment."));
    if (st.switching) return st.switched.then(() => getContext({ waitMeasuring, onMeasuring }));
    // The browser kept crashing soon after each start (browser/supervise.mjs): no new start for now.
    const loop = !st.contextPromise && api.crashLoop();
    if (loop) return Promise.reject(new Error(loop));
    // The session's proxy failed its check a moment ago (daemon/network.mjs): no new start yet.
    const held = !st.contextPromise && network?.refusal(st.session);
    if (held) return Promise.reject(new Error(held));
    if (!st.contextPromise) {
      st.launching = true;
      st.contextPromise = launch().catch((e) => {
        st.contextPromise = null;
        api.profiles.release(); // a launch that stopped started no browser on its profile
        graphics.release();
        throw e;
      }).finally(() => { st.launching = false; installWaiters.clear(); });
    }
    if (!st.launching) return st.contextPromise;
    // measured: the measurement's message whatever runs now (throughMeasurement's limit).
    const busy = (measured = st.probing) => new Error(measured ? MEASURING_BUSY : "PairBrowse is installing its browser (the first start or a new version: a minute or two). Tell the user, then retry the last action in a minute.");
    if (waitMeasuring && !st.installing) return throughMeasurement(st.contextPromise, { st, waiters: installWaiters, ms: deps.measuringWaitMs ?? MEASURING_WAIT_MS, onMeasuring, busy });
    if (st.installing || st.probing) return Promise.reject(busy());
    return Promise.race([st.contextPromise, new Promise((_, reject) => installWaiters.add(() => reject(busy())))]);
  }


  // The browser, once saved tabs are back.
  // Calls in flight when the browser closes (closed by hand, or crashed) are told at once.
  const closeWatchers = new Set();
  const watchClose = (fn) => { closeWatchers.add(fn); return () => closeWatchers.delete(fn); };
  async function ready() {
    while (st.pickSwitch) await st.pickSwitch; // never the old browser after the person picked another
    const ctx = await getContext();
    if (st.starting) await st.starting; // the start tab's own first load (awaitStartTab), bounded
    if (st.restoring) await st.restoring;
    return ctx;
  }
  // The helper closes the browser itself so others can go on (a call past the turn cap, a
  // disconnected agent's stalled call): a close it caused, so never a crash for the guard.
  async function reset() {
    st.resetting = true;
    try { await (await st.contextPromise)?.close(); } catch {} finally { st.resetting = false; }
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
    st.personAt = Date.now(); // a person at the browser (the page script never sees this)
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
  // Saved tabs still reopening: their restore gets up to restoreWaitMs to finish first; still
  // going after that, nothing is saved (the tracker holds its writes during a restore,
  // scripts/tabs.mjs), so the saved list stays whole. deadline (now()'s clock): when the helper
  // kills the browser (daemon.mjs SHUTDOWN_GRACE_MS); the restore's wait and the save end
  // CLOSE_RESERVE_MS before it (the save writing every tab, with the titles read by then), so the
  // browser's own close, which writes the cookies, has that long.
  async function close({ restoreWaitMs = RESTORE_WAIT_MS, deadline = Infinity, now = Date.now } = {}) {
    const by = deadline - CLOSE_RESERVE_MS;
    try {
      const ctx = st.contextPromise && (await st.contextPromise);
      if (st.restoring) await within(Math.max(0, Math.min(restoreWaitMs, by - now())), Promise.resolve(st.restoring).catch(() => {}));
      if (st.restoring) log("shutdown: saved tabs were still reopening; the saved list stays as it was");
      await st.tabTracker?.saveNow({ deadline: by, now });
      st.tabTracker?.stop();
      await ctx?.close();
    } catch {}
    dropHelperKey();
    try { sweepTemporary(); } catch {}
    await api.stopScreen(); // Xvfb ended (browser/supervise.mjs), its cookie and record removed
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

  // graphicsStatus({ remote }): pairbrowse_status's Graphics part; graphicsSummary(): diagnostics'.
  return { browserType, dropHelperKey, pickerUrl, choiceConfig, profile, getContext, watchClose, ready, reset, openByHand, close, predict, nextShell,
    graphicsStatus: graphics.statusParts, graphicsSummary: graphics.summary };
}
