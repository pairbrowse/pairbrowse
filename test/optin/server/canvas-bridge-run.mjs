// The canvas bridge is dead in the build itself (spec server-mode E1, engine patch 960; step 49),
// the side that runs inside the A13 container (canvas-bridge-dead.test.mjs starts it there). The
// native Linux build is started straight through the driver, not through the helper (which strips
// the bridge switches before any launch), with the bridge's own switches pointing at a listener on
// this computer's loopback and a page that draws on a 2D canvas and in WebGL and reads the pixels
// back. With patch 065 the renderer would connect to that listener and send what it drew; with 960
// nothing connects, the renderers never get the switches, and the page still draws. The browser
// runs with its sandbox on, as the normal user, on a virtual screen of its own. Prints "RESULT
// <json>".
//
// /runtime: the pinned runtime; /cache: the pinned Linux build and engine pack (native-cache.mjs).
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { installNativeLinux } from "./native-linux.mjs";
import { GRAPHICS_PAGE, servePage } from "./graphics-page.mjs";
import { processes } from "../../helpers/server.mjs";
import { sleep } from "../../helpers/util.mjs";

const RUNTIME = "/runtime";
const result = { uid: userInfo().uid };
const log = (m) => process.stderr.write(`bridge: ${m}\n`);
// The home for this run's virtual screen records (paths.mjs reads it as it loads: set before).
const home = mkdtempSync(join(tmpdir(), "pb-bridge-"));
process.env.PAIRBROWSE_HOME = home;
mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });

const connections = [];
const listener = createServer((socket) => {
  const at = Date.now();
  let head = "";
  socket.on("data", (d) => { head += d.toString("latin1").slice(0, 300); });
  socket.on("close", () => connections.push({ at, head: head.slice(0, 300) }));
  socket.setTimeout(2000, () => socket.destroy());
});
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
const site = await servePage(GRAPHICS_PAGE);
let screen = null, ctx = null;
try {
  const native = await installNativeLinux();
  result.native = native.version;
  const { startVirtualDisplay } = await import("../../../scripts/display.mjs");
  screen = await startVirtualDisplay(log, { name: "Xauthority-bridge", geometry: { width: 1280, height: 800, depth: 24 } });
  const { chromium } = createRequire(join(RUNTIME, "package.json"))("patchright");
  const bridge = [`--canvas-bridge-url=ws://127.0.0.1:${port}/bridge`, "--canvas-bridge-mode=all", "--canvas-bridge-allow=*", "--canvas-bridge-fallback=none", "--canvas-bridge-auth=test"];
  result.switches = bridge.map((s) => s.split("=")[0]);
  ctx = await chromium.launchPersistentContext(join(home, "profile"), {
    executablePath: native.exe, headless: false, chromiumSandbox: true,
    env: { ...process.env, ...(screen.env || {}) },
    args: [...bridge, "--password-store=basic", "--no-first-run", "--window-size=1280,800"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(site.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => /graphics: .* end$/.test(document.getElementById("g")?.textContent || ""), null, { timeout: 60_000 });
  const shown = await page.evaluate(() => document.getElementById("g").textContent);
  result.page = JSON.parse(/graphics: (\{.*\}) end/s.exec(shown)[1]);
  // Draw more, as a site would, and give a bridge every chance to connect.
  await page.evaluate(() => { for (let i = 0; i < 20; i++) { const c = document.createElement("canvas"); c.width = 300; c.height = 150; const x = c.getContext("2d"); x.fillStyle = `hsl(${i * 17}, 60%, 50%)`; x.fillRect(0, 0, 300, 150); x.fillText("bridge " + i, 10, 50); c.toDataURL(); x.getImageData(0, 0, 10, 10); } });
  await sleep(8000);
  const all = processes();
  const browser = all.filter((p) => p.cmd.startsWith(native.exe) && !/--type=/.test(p.cmd));
  result.browserHasSwitch = browser.some((p) => /--canvas-bridge-url=/.test(p.cmd));
  const renderers = all.filter((p) => p.cmd.startsWith(native.exe) && /--type=(renderer|gpu-process|utility)/.test(p.cmd));
  result.children = renderers.length;
  result.childrenWithSwitch = renderers.filter((p) => /canvas-bridge/.test(p.cmd)).length;
  result.noSandboxSwitch = browser.some((p) => /--no-sandbox/.test(p.cmd));
  result.connections = connections.length;
  result.heads = connections.slice(0, 3).map((c) => c.head);
} catch (e) {
  result.error = String(e?.stack || e);
} finally {
  await ctx?.close().catch(() => {});
  await screen?.stop().catch(() => {});
  listener.close();
  site.close();
}
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
