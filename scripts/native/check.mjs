// The launch self-check every native build passes before it's kept (native-install.mjs): launched
// once the way the helper launches it, on a throwaway profile, against a small local page. Then its
// graphics are measured once (native/probe.mjs, server-mode spec E4): a throwaway probe browser,
// hidden on macOS, on Linux on the check's own screen (its private virtual screen on a server, the
// desktop otherwise).
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths, loadConfig } from "../paths.mjs";
import { launchOptions, prepareProfile, panelExtensionId, THEME_COLOR, hudScript } from "../browser.mjs";
import { engineConfig, shellOf } from "../browser/choice.mjs";
import { launchEngine, SANDBOX } from "../engine.mjs";
import { nativeManifest } from "../native-engine.mjs";
import { NATIVE } from "../native-pack.mjs";
import { ensureRuntime } from "../runtime.mjs";
import { needsVirtualDisplay, screenGeometry, serverMode, startVirtualDisplay } from "../display.mjs";
import { loadBrowserDriver, patchrightNodeMinimum } from "../driver.mjs";
import { readJson, sleep, within, withTimeout } from "../util.mjs";
import { probeLaunch, probeOptions, graphicsStep, PROBE_STEP_MS } from "./probe.mjs";

const CHECK_TIMEOUT_MS = 180_000;
// The graphics step runs on the helper's launch path (an update's first start waits for it), so
// its bound fits there: one probe start (the build just started once, so a minute is ample) and
// two page steps. A probe still running then is stopped and waited for, its start in flight and
// one page step at most, plus its closes: the worst case past the check's own three minutes is
// GRAPHICS_TIMEOUT_MS + GRAPHICS_STOP_MS, under four minutes. A slower probe leaves the step
// unverified, measured again later (E6).
export const GRAPHICS_LAUNCH_MS = 60_000;
export const GRAPHICS_TIMEOUT_MS = GRAPHICS_LAUNCH_MS + 2 * PROBE_STEP_MS;
const CLOSE_MS = 15_000; // the probe's browser close and its local server's
export const GRAPHICS_STOP_MS = GRAPHICS_LAUNCH_MS + PROBE_STEP_MS + CLOSE_MS;
// Where a probe runs (native/probe.mjs RUNTIME_PLATFORMS); elsewhere the step says so.
const PROBE_PLATFORMS = new Set(["darwin", "linux"]);
const PLATFORM_NAMES = { win32: "Windows" };
// The engine registers an extension's worker a moment after launch.
const PANEL_WAIT_TRIES = 20, PANEL_WAIT_MS = 500;
// Extensions the engine loaded from a folder ("unpacked"), in Secure Preferences.
const UNPACKED_LOCATION = 8;

// A page with a form and a download, recording what the browser sent.
async function checkServer() {
  const download = randomBytes(32).toString("hex");
  const sent = { name: null };
  const server = createServer((req, res) => {
    if (req.url === "/file.txt") {
      res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="pairbrowse-check.txt"' });
      return res.end(download);
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => { sent.name = new URLSearchParams(body).get("name"); res.end("<!doctype html><title>sent</title>sent"); });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><title>PairBrowse check</title><form method="post"><input id="name" name="name"><button id="go">Send</button></form><a id="dl" href="/file.txt">file</a>');
  });
  await new Promise((ok, no) => { server.once("error", no); server.listen(0, "127.0.0.1", ok); });
  return { origin: `http://127.0.0.1:${server.address().port}`, download, sent, close: () => server.close() };
}

// The side panel's worker runs, and no other extension does. ownPages (a build with its own pages):
// no extension runs at all.
async function checkExtensions(ctx, page, { ownPages = false } = {}) {
  const cdp = await ctx.newCDPSession(page);
  if (ownPages) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const any = targetInfos.filter((t) => t.url.startsWith("chrome-extension://"));
    if (any.length) throw new Error(`extensions are running: ${any.map((t) => t.url).join(", ")}`);
    return;
  }
  const panel = `chrome-extension://${panelExtensionId()}/`;
  let workers = [];
  for (let i = 0; i < PANEL_WAIT_TRIES && !workers.length; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    workers = targetInfos.filter((t) => t.url.startsWith("chrome-extension://") && t.type !== "page");
    if (!workers.length) await sleep(PANEL_WAIT_MS);
  }
  if (!workers.some((t) => t.url.startsWith(panel))) throw new Error("the side panel isn't running");
  const others = workers.filter((t) => !t.url.startsWith(panel));
  if (others.length) throw new Error(`other extensions are running: ${others.map((t) => t.url).join(", ")}`);
}

// The page script runs and draws the bottom bar.
async function checkBottomBar(page) {
  const { source, name, token, tags } = hudScript();
  await page.evaluate(source);
  await page.evaluate(([n, t]) => window[n]?.(t, JSON.stringify({ items: [{ t: Date.now(), text: "Install check", who: "PairBrowse" }], waiting: false }), "bar"), [name, token]);
  const height = await page.evaluate((tag) => document.querySelector(tag)?.getBoundingClientRect().height ?? 0, tags.bar);
  if (!(height > 0)) throw new Error("the bottom bar doesn't show");
}

// After the browser closed: the PairBrowse colors stuck (the engine's own color theme, no theme
// extension and so no "Installed theme" bar), and only the side panel is installed. ownPages (a build
// with its own pages, which draws its own colors): no unpacked extension at all.
function checkProfile(profile, { ownPages = false } = {}) {
  const prefs = readJson(join(profile, "Default", "Preferences"), {});
  if (!ownPages && (prefs.extensions?.theme?.id !== "user_color_theme_id" || prefs.browser?.theme?.user_color2 !== THEME_COLOR)) throw new Error("the PairBrowse colors didn't stick");
  const secure = readJson(join(profile, "Default", "Secure Preferences"), {});
  const loaded = Object.entries(secure.extensions?.settings || {}).filter(([, e]) => e?.location === UNPACKED_LOCATION).map(([id]) => id);
  const allowed = ownPages ? [] : [panelExtensionId()];
  if (loaded.some((id) => !allowed.includes(id))) throw new Error(`unexpected extensions installed: ${loaded.join(", ")}`);
}

// The build's graphics, measured once in a probe browser (launch(directory): started as the
// check's was, launchOptions with the same sandbox rule, hidden on macOS by probeOptions). Answers
// the step's line: the backend's kind, WebGL's level and WebGPU's adapter (graphicsStep), or why it
// went unmeasured. A graphics probe that fails never fails the install: the build runs (the checks
// before said so), and an unmeasured runtime is "unverified" until a later measurement (E6).
// onMeasured(measured): the measurement, for the caller to keep as evidence. A probe past
// timeoutMs is stopped and waited for (stopMs at most) before the line is answered, so its browser
// is closed, its folder gone and the SANDBOX and GRAPHICS state it puts back put back before the
// person's browser starts. probe: native/probe.mjs probeLaunch (tests pass their own).
export async function graphicsCheck({ launch, build, pack = null, display = "native", platform = process.platform, sandbox = SANDBOX, scratch, log = () => {}, onMeasured = () => {}, timeoutMs = GRAPHICS_TIMEOUT_MS, launchMs = GRAPHICS_LAUNCH_MS, stepMs = PROBE_STEP_MS, stopMs = GRAPHICS_STOP_MS, probe = probeLaunch }) {
  if (!PROBE_PLATFORMS.has(platform)) return `graphics: not measured on ${PLATFORM_NAMES[platform] || platform}`;
  const stop = new AbortController();
  const probing = Promise.resolve()
    .then(() => probe({ launch, directory: scratch, build, pack, platform, display, sandbox, launchMs, stepMs, log, signal: stop.signal }))
    .then((measured) => ({ measured }), (error) => ({ error }));
  const done = await within(timeoutMs, probing);
  if (!done) {
    stop.abort();
    if (!await within(stopMs, probing)) log(`graphics probe: not stopped within ${stopMs / 1000} s`);
  }
  if (!done || done.error) {
    const why = done ? String(done.error?.message || done.error).replace(/^PairBrowse graphics probe failed: /, "") : `it took longer than ${timeoutMs / 1000} s`;
    log(`graphics not measured: ${why}`);
    return `graphics: unverified (not measured: ${why.split("\n")[0].slice(0, 160)})`;
  }
  try { onMeasured(done.measured); } catch {}
  return graphicsStep(done.measured);
}

// A graphics probe's browser start (native/probe.mjs probeLaunch's launch(directory)): the build
// started as the helper starts it (launchOptions, with a profile's switches when given, and the
// engine config's layer: a profile's keys), the same sandbox rule (required in server mode), on
// the given screen, hidden on macOS (probeOptions), a plain about:blank first tab, no live view.
// Never geoip (probeEngine). Shared by the self-check, the helper's first launch per runtime key
// and cli.mjs validate.
export function probeLauncher({ chromium, engine, config = {}, shell, screen = null, env = process.env, executablePath, profileArgs = [], server = false, log = () => {} }) {
  return (directory) => {
    prepareProfile(directory, undefined, { browserPages: !!shell?.ownPages, layout: config.layout });
    const options = probeOptions(launchOptions(config, { shell, screen, env: { ...env, ...(screen?.env || {}) }, executablePath, blankStart: true, profileArgs }));
    return launchEngine(chromium, { ...probeEngine(engine), virtualDisplay: screen?.geometry ?? null }, directory, options, log, undefined, { server });
  };
}

// A probe's engine config: geoip off in both places it can be on (config.json's pairbrowse block
// and the profile's engine layer). A probe has no proxy, so geoip's region lookup would go straight
// out from this computer and send its own address to an outside service (spec C11; and on a server
// without direct egress it fails, so the profile is never measured); its time zone and languages
// are the profile's own, else this computer's (Intl). Graphics don't depend on either.
export function probeEngine(engine = {}) {
  const out = { ...engine };
  if (out.pairbrowse && typeof out.pairbrowse === "object") out.pairbrowse = { ...out.pairbrowse, geoip: false };
  if (out.browserProfile && typeof out.browserProfile === "object") out.browserProfile = { ...out.browserProfile, geoip: false };
  return out;
}

// cli.mjs validate's measurement (spec E4): the installed build exec, started for one profile
// (engineLayer: sessions/profiles.mjs's engine layer; profileArgs: its switches) in a probe
// browser of its own, on a private virtual screen where this machine needs one (as the helper's
// browser runs there). Answers { measured (null when not measured), line (graphicsStep's, or why),
// display }. Never throws for a probe that fails; a driver that can't load does.
export async function measureGraphics(exec, { config = loadConfig(), engineLayer = null, profileArgs = [], log = () => {}, env = process.env, check = graphicsCheck } = {}) {
  ensureRuntime(log);
  const { chromium } = loadBrowserDriver(createRequire(join(paths.runtime, "package.json")), config, process.versions.node, patchrightNodeMinimum(paths.runtime));
  mkdirSync(paths.browser, { recursive: true });
  const scratch = mkdtempSync(join(paths.browser, ".measure-"));
  const engine = { ...engineConfig(config, { binary: "native", executablePath: exec }), ...(engineLayer ? { browserProfile: engineLayer } : {}) };
  let screen = null, measured = null;
  try {
    if (needsVirtualDisplay(config, env)) screen = await startVirtualDisplay(log, { name: "Xauthority-measure", geometry: screenGeometry(config) });
    const launch = probeLauncher({ chromium, engine, config, shell: shellOf(engine), screen, env, executablePath: exec, profileArgs, server: serverMode(config, env), log });
    const line = await check({ launch, build: nativeManifest(exec).version, pack: NATIVE.engine?.sha256 ?? null, display: screen ? "xvfb" : "native", scratch, log, onMeasured: (m) => { measured = m; } });
    return { measured, line, display: screen ? "xvfb" : "native", virtualScreen: screen?.geometry ?? null };
  } finally {
    await screen?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Returns what passed; throws on the first failure. On a Linux machine without a screen the check
// runs on a private virtual screen of its own, like the browser itself (display.mjs).
// graphicsMs: the graphics step's bound; onGraphics(measured): its measurement (graphicsCheck);
// profileArgs: the default profile's switches its probe starts with, as the helper's launch passes
// them (sessions/profiles.mjs selfCheckArgs), so the measurement's runtime key is that launch's.
export async function selfCheck(exec, { config = loadConfig(), log = () => {}, timeoutMs = CHECK_TIMEOUT_MS, graphicsMs = GRAPHICS_TIMEOUT_MS, onGraphics = () => {}, env = process.env, profileArgs = [] } = {}) {
  ensureRuntime(log);
  const { chromium } = loadBrowserDriver(createRequire(join(paths.runtime, "package.json")), config, process.versions.node, patchrightNodeMinimum(paths.runtime));
  const browserDir = paths.browser;
  mkdirSync(browserDir, { recursive: true });
  const scratch = mkdtempSync(join(browserDir, ".selfcheck-"));
  const profile = join(scratch, "profile");
  const engine = engineConfig(config, { binary: "native", executablePath: exec });
  const shell = shellOf(engine); // a manifest that doesn't read: the extension's (the version check below fails it)
  const ownPages = shell.ownPages;
  prepareProfile(profile, undefined, { browserPages: ownPages, layout: config.layout });
  const site = await checkServer();
  const passed = [];
  let screen = null;
  let ctx = null;
  const work = (async () => {
    if (needsVirtualDisplay(config, env)) screen = await startVirtualDisplay(log, { name: "Xauthority-check", geometry: screenGeometry(config) });
    // Launched as the helper launches it (browser.mjs launchOptions), on purpose without three
    // things: no live view (no helper switches), a plain about:blank first tab whatever the
    // build's start page (blankStart: the check drives that tab), and never firstRun (on macOS
    // --no-startup-window would leave no first tab to drive). On a server its sandbox is required,
    // as the helper's is (engine.mjs launchEngine).
    ctx = await launchEngine(chromium, { ...engine, virtualDisplay: screen?.geometry ?? null }, profile, launchOptions(config, { shell, screen, env: { ...env, ...(screen?.env || {}) }, executablePath: exec, blankStart: true }), log, undefined, { server: serverMode(config, env) });
    const version = ctx.browser()?.version() || "";
    if (!version.includes(nativeManifest(exec).version)) throw new Error(`the browser reports version ${version || "(none)"}`);
    passed.push(`launches (${version})`);
    const page = ctx.pages()[0] || await ctx.newPage();
    await checkExtensions(ctx, page, { ownPages });
    passed.push(ownPages ? "no extensions (the browser's own pages)" : "side panel running, no other extensions");
    await page.goto(site.origin, { waitUntil: "domcontentloaded" });
    await checkBottomBar(page);
    passed.push("bottom bar shows");
    await page.fill("#name", "PairBrowse check");
    await Promise.all([page.waitForURL(`${site.origin}/`, { waitUntil: "load" }).catch(() => {}), page.click("#go")]);
    for (let i = 0; i < 20 && site.sent.name === null; i++) await sleep(100);
    if (site.sent.name !== "PairBrowse check") throw new Error(`the form sent ${JSON.stringify(site.sent.name)}`);
    passed.push("form fill and send");
    // The form's own navigation back to this page can still be on its way on a slow computer (the
    // wait above ends at once: the address is already this one); the page ends up here either way.
    await page.goto(site.origin, { waitUntil: "domcontentloaded" }).catch(async (e) => {
      if (!/interrupted by another navigation/.test(String(e?.message || e))) throw e;
      await page.waitForLoadState("domcontentloaded");
    });
    const [file] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }), page.click("#dl")]);
    const saved = join(scratch, "download.txt");
    await file.saveAs(saved);
    if (readFileSync(saved, "utf8") !== site.download) throw new Error("the downloaded file is wrong");
    passed.push("download");
    await ctx.close();
    ctx = null;
    checkProfile(profile, { ownPages });
    passed.push(ownPages ? "no unpacked extensions installed" : "color theme, no theme extension");
    return passed;
  })();
  try {
    const result = await withTimeout(work, timeoutMs, `the check took longer than ${timeoutMs / 1000} s`);
    // On the check's own screen, which stays until the finally below.
    log("measuring the new browser's graphics");
    const launch = probeLauncher({ chromium, engine, config, shell, screen, env, executablePath: exec, profileArgs, server: serverMode(config, env), log });
    result.push(await graphicsCheck({ launch, build: nativeManifest(exec).version, pack: NATIVE.engine?.sha256 ?? null, display: screen ? "xvfb" : "native", scratch, log, onMeasured: onGraphics, timeoutMs: graphicsMs }));
    return result;
  } finally {
    await ctx?.close().catch(() => {});
    await work.catch(() => {});
    await screen?.stop();
    site.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}
