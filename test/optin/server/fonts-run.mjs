// The server setup's fonts on the native Linux build, the side that runs inside the fonts container
// (test/optin/server-fonts.test.mjs starts it there; spec server-mode step 52). The image carries
// the setup's Debian packages (container.mjs fontsDockerfile); here the setup command itself runs
// as the normal user on the helper's home (Selawik from Microsoft's pinned release, the record, the
// browser's font configuration), its check is read, and then a page reads the fonts by width, as
// font checks do, with pairbrowse.fontStandIns off and then on. Prints "RESULT <json>".
//
// /runtime: the pinned runtime; /cache: the pinned Linux build and engine pack (native-cache.mjs).
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { userInfo } from "node:os";
import { session } from "../../helpers/live.mjs";
import { sleep, text } from "../../helpers/util.mjs";
import { logText, serverHome, signalHelper, startServerHelper } from "../../helpers/server.mjs";
import { installNativeLinux } from "./native-linux.mjs";
import { servePage } from "./graphics-page.mjs";
import { MEASURING_BUSY } from "../../../scripts/daemon/browser/graphics.mjs";
import { GRAPHICS_STOP_MS, GRAPHICS_TIMEOUT_MS } from "../../../scripts/native/check.mjs";

const RUNTIME = "/runtime";
// The families read by width (the Windows names the setup's fonts answer for), and names no
// computer has (a control: none may be found).
export const FAMILIES = ["Segoe UI", "Calibri", "Cambria", "Arial", "Times New Roman", "Courier New", "Verdana", "Georgia", "Trebuchet MS", "Impact"];
const FONTS_PAGE = `<!doctype html><title>fonts</title><p id=f>fonts: waiting</p><script>
(() => {
  const x = document.createElement("canvas").getContext("2d");
  const width = (f) => { x.font = "72px " + f; return x.measureText("mmmmmmmmmmlli1WQ@#").width; };
  const bases = ["monospace", "serif", "sans-serif"]; const base = bases.map(width);
  const has = (n) => bases.some((b, i) => width('"' + n + '", ' + b) !== base[i]);
  const emoji = (() => { const c = document.createElement("canvas"); c.width = 48; c.height = 48; const g = c.getContext("2d"); g.font = "32px sans-serif"; g.textBaseline = "top"; g.fillText("\\u{1F600}", 4, 4); const d = g.getImageData(0, 0, 48, 48).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2])) n++; return n; })();
  const cjk = width('"Noto Sans CJK JP", monospace') !== base[0];
  const out = { found: ${JSON.stringify(FAMILIES)}.filter(has), controlFound: ["PairBrowse Control Sans 7f3a", "Zq Control Mono 4be1"].filter(has), colorEmojiPixels: emoji, cjk };
  document.getElementById("f").textContent = "fonts: " + JSON.stringify(out) + " end";
})();
</script>`;

const result = { uid: userInfo().uid };
const helpers = [];
const sockets = [];
let home = null;

async function connect(socketPath) {
  const s = await session(socketPath, "a");
  sockets.push(s);
  const tool = async (name, args = {}, ms = 180_000) => {
    const deadline = Date.now() + GRAPHICS_TIMEOUT_MS + GRAPHICS_STOP_MS + 120_000;
    for (;;) {
      const r = await s.tool(name, args, ms);
      if (!text(r).includes(MEASURING_BUSY) || Date.now() > deadline) return r;
      await sleep(3000);
    }
  };
  return { sock: s.sock, tool };
}
async function readFonts(url, standIns) {
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ ...config, pairbrowse: { ...(config.pairbrowse || {}), fontStandIns: standIns } }));
  const started = await startServerHelper(home, { ms: 180_000 });
  helpers.push(started.daemon);
  const h = await connect(started.socketPath);
  await h.tool("browser_navigate", { url });
  await h.tool("browser_wait_for", { text: " end" });
  const shown = text(await h.tool("browser_snapshot", {}));
  const m = /fonts: (\{.*?\}) end/s.exec(shown);
  h.sock.destroy();
  await signalHelper(started.daemon, "SIGTERM");
  if (!m) throw new Error(`the page showed nothing:\n${shown.slice(0, 1500)}`);
  return JSON.parse(m[1].replace(/\\"/g, '"'));
}
const setup = (command) => {
  const r = spawnSync(process.execPath, ["/repo/scripts/native/fontsetup.mjs", command], { env: { ...process.env, PAIRBROWSE_HOME: home }, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
};

const site = await servePage(FONTS_PAGE);
try {
  const native = await installNativeLinux();
  home = serverHome(RUNTIME, { prefix: "pb-fonts-", executablePath: native.exe, config: { browserEngine: "pairbrowse", sessionPicker: false } });
  cpSync(native.engine, join(home, "engine"), { recursive: true });
  // The setup on this home, as the person runs it: the packages are in the image, so it asks
  // nothing and runs nothing with sudo; Selawik comes from Microsoft's release.
  result.install = setup("install");
  result.check = setup("check");
  result.off = await readFonts(site.url, false);
  result.on = await readFonts(site.url, true);
  result.launchLines = logText(home).split("\n").filter((l) => /launch: fonts/.test(l)).slice(-4);
} catch (e) {
  result.error = String(e?.stack || e);
  if (home) result.log = logText(home).slice(-6000);
} finally {
  for (const s of sockets) s.sock.destroy();
  for (const d of helpers) await signalHelper(d, "SIGTERM").catch(() => {});
  site.close();
}
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
