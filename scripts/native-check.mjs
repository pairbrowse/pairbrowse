// The launch self-check every native build passes before it's kept (native-install.mjs): launched
// once the way the helper launches it, on a throwaway profile, against a small local page.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths, loadConfig } from "./paths.mjs";
import { launchArgs, prepareProfile, panelExtensionId, THEME_COLOR, hudScript } from "./browser.mjs";
import { launchEngine } from "./engine.mjs";
import { nativeManifest } from "./native-engine.mjs";
import { ensureRuntime } from "./runtime.mjs";
import { needsVirtualDisplay, startVirtualDisplay } from "./display.mjs";
import { loadBrowserDriver, patchrightNodeMinimum } from "./driver.mjs";
import { readJson, sleep, withTimeout } from "./util.mjs";

const CHECK_TIMEOUT_MS = 180_000;
// Chromium registers an extension's worker a moment after launch.
const PANEL_WAIT_TRIES = 20, PANEL_WAIT_MS = 500;
// Extensions Chromium loaded from a folder ("unpacked"), in Secure Preferences.
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

// The side panel's worker runs, and no other extension does.
async function checkExtensions(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
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

// After the browser closed: the PairBrowse colors stuck (Chromium's own color theme, no theme
// extension and so no "Installed theme" bar), and only the side panel is installed.
function checkProfile(profile) {
  const prefs = readJson(join(profile, "Default", "Preferences"), {});
  if (prefs.extensions?.theme?.id !== "user_color_theme_id" || prefs.browser?.theme?.user_color2 !== THEME_COLOR) throw new Error("the PairBrowse colors didn't stick");
  const secure = readJson(join(profile, "Default", "Secure Preferences"), {});
  const loaded = Object.entries(secure.extensions?.settings || {}).filter(([, e]) => e?.location === UNPACKED_LOCATION).map(([id]) => id);
  if (loaded.some((id) => id !== panelExtensionId())) throw new Error(`unexpected extensions installed: ${loaded.join(", ")}`);
}

// Returns what passed; throws on the first failure. On a Linux machine without a screen the check
// runs on a private virtual screen of its own, like the browser itself (display.mjs).
export async function selfCheck(exec, { config = loadConfig(), log = () => {}, timeoutMs = CHECK_TIMEOUT_MS, env = process.env } = {}) {
  ensureRuntime(log);
  const { chromium } = loadBrowserDriver(createRequire(join(paths.runtime, "package.json")), config, process.versions.node, patchrightNodeMinimum(paths.runtime));
  const browserDir = join(paths.home, "browser");
  mkdirSync(browserDir, { recursive: true });
  const scratch = mkdtempSync(join(browserDir, ".selfcheck-"));
  const profile = join(scratch, "profile");
  prepareProfile(profile);
  const site = await checkServer();
  const passed = [];
  let screen = null;
  let ctx = null;
  const work = (async () => {
    if (needsVirtualDisplay(config, env)) screen = await startVirtualDisplay(log, { name: "Xauthority-check" });
    ctx = await launchEngine(chromium, { ...config, browserEngine: "pairbrowse", executablePath: exec }, profile,
      { headless: false, env: { ...env, ...(screen?.env || {}) }, executablePath: exec, viewport: null, ignoreDefaultArgs: ["--disable-extensions"], args: launchArgs(config) }, log);
    const version = ctx.browser()?.version() || "";
    if (!version.includes(nativeManifest(exec).version)) throw new Error(`the browser reports version ${version || "(none)"}`);
    passed.push(`launches (${version})`);
    const page = ctx.pages()[0] || await ctx.newPage();
    await checkExtensions(ctx, page);
    passed.push("side panel running, no other extensions");
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
    checkProfile(profile);
    passed.push("color theme, no theme extension");
    return passed;
  })();
  try {
    return await withTimeout(work, timeoutMs, `the check took longer than ${timeoutMs / 1000} s`);
  } finally {
    await ctx?.close().catch(() => {});
    await work.catch(() => {});
    screen?.stop();
    site.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}
