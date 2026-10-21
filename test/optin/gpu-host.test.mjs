// Phase E on a host with a real GPU (spec server-mode acceptance "Runtimes", gpu-host; decision
// 10: graphics are the real, measured values there): on the native build on this computer a
// helper's first start measures once and reads a hardware backend; the renderer pages read is the
// one the measurement recorded and of the backend's own family; WebGPU is an adapter or a defined
// reason; the default profile is "validated" (never "consistent": no identity is shown over
// hardware) and the status part says so; the sandbox is on; and a killed browser relaunches with
// the same graphics request and measurement (the same runtime key and time, no second probe).
//
// Needs PAIRBROWSE_TEST_GPU_HOST=1 on a computer with a GPU, PAIRBROWSE_TEST_RUNTIME,
// PAIRBROWSE_TEST_EXECUTABLE (a native build for this computer) and PAIRBROWSE_TEST_ENGINE;
// skipped cleanly otherwise. On a Mac the harness's browser is hidden and still renders on Metal;
// on Linux it runs headed on this desktop's own screen (DISPLAY), where the GPU is.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { session } from "../helpers/live.mjs";
import { sleep, text, until } from "../helpers/util.mjs";
import { helperHome, startHelper, nativeExe, nativeVersion, testBrowser } from "../helpers/daemon.mjs";
import { GRAPHICS_PAGE, parseGraphics, servePage } from "./server/graphics-page.mjs";
import { rendererFamily } from "../../scripts/rules/coherence.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SKIP = process.env.PAIRBROWSE_TEST_GPU_HOST !== "1" ? "set PAIRBROWSE_TEST_GPU_HOST=1 on a computer with a GPU"
  : !runtime ? "set PAIRBROWSE_TEST_RUNTIME"
  : !nativeExe ? "set PAIRBROWSE_TEST_EXECUTABLE (a native build) and PAIRBROWSE_TEST_ENGINE"
  : process.platform === "linux" && !process.env.DISPLAY ? "Linux: a desktop with DISPLAY set (the GPU is there)" : false;

// The browser under the helper (its child that isn't node or one of the browser's own helpers).
function browserPid(helperPid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
  const kid = rows.find((r) => Number(r[2]) === helperPid && !/node/.test(r[3]) && !/--type=/.test(r[3]));
  return kid ? Number(kid[1]) : 0;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function defaultValidation(home, build) {
  const dir = join(home, "browser-profiles");
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let p;
    try { p = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (p?.kind === "config") return p.validation?.[build] ?? null;
  }
  return null;
}
const log = (home) => { try { return readFileSync(join(home, "daemon.log"), "utf8"); } catch { return ""; } };
const measured = (home) => log(home).split("\n").filter((l) => /measuring graphics once for this browser version/.test(l)).length;

test("GPU host: backend hardware, the renderer the measurement recorded, WebGPU defined, validated, sandbox on; a killed browser relaunches on the same measurement", { skip: SKIP, timeout: 900_000 }, async (t) => {
  const site = await servePage(GRAPHICS_PAGE);
  // On Linux the browser runs headed on this desktop (the GPU is there); on a Mac hidden, on Metal.
  const home = process.platform === "linux"
    ? (() => { const h = helperHome(runtime); writeFileSync(join(h, "config.json"), JSON.stringify({ ...testBrowser(runtime), display: "none", sessionPicker: false, screenshots: false })); return h; })()
    : helperHome(runtime, { prefix: "pb-gpu-", config: { sessionPicker: false } });
  const h = await startHelper(home, { env: { PAIRBROWSE_TEST_RELAUNCH_MS: "1000" } });
  let failed = false;
  try {
    let a = await session(h.socketPath, "g");
    try {
      const read = async () => {
        const nav = await a.tool("browser_navigate", { url: site.url }, 180_000);
        await a.tool("browser_wait_for", { text: " end" }, 60_000);
        const shown = text(await a.tool("browser_snapshot", {}));
        const page = parseGraphics(shown);
        assert.ok(page, `the page showed its graphics:\n${text(nav).slice(0, 1200)}\n${shown.slice(0, 1200)}`);
        return page;
      };
      const page = await read();
      const status = text(await a.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
      const entry = defaultValidation(home, nativeVersion);
      t.diagnostic(JSON.stringify({ page, status, entry: entry && { status: entry.status, backend: entry.graphics?.backend, mismatches: entry.items.filter((i) => i.status === "mismatch") } }, null, 1).slice(0, 8000));
      assert.equal(measured(home), 1, "measured once at the first start");
      assert.ok(entry, "the default profile keeps the verdict");
      assert.equal(entry.graphics?.backend?.kind, "hardware", `a hardware backend: ${JSON.stringify(entry.graphics?.backend)}`);
      assert.equal(entry.graphics.shown, null, "no identity shown over hardware");
      assert.equal(entry.status, "validated", JSON.stringify(entry.items.filter((i) => i.status !== "matched" && i.status !== "derived")));
      assert.ok(page.webgl.available && page.webgl.renderer, JSON.stringify(page.webgl));
      assert.equal(page.webgl.renderer, entry.graphics.webgl.unmaskedRenderer, "pages read the renderer the measurement recorded");
      const family = rendererFamily(entry.graphics.backend.renderer);
      assert.ok(family && family !== "software", `the backend names a hardware family: ${entry.graphics.backend.renderer}`);
      assert.equal(rendererFamily(page.webgl.renderer), family, "the renderer pages read is the backend's own family");
      assert.ok(page.webgpu.available ? typeof page.webgpu.vendor === "string" && page.webgpu.isFallbackAdapter !== true : typeof page.webgpu.reason === "string", `a WebGPU adapter or a defined reason: ${JSON.stringify(page.webgpu)}`);
      if (page.webgpu.available) assert.equal(rendererFamily(page.webgpu.vendor), family, "the WebGPU adapter is the backend's family");
      assert.match(status, /Graphics: hardware \(.+\), requested auto, validated on \d+\.\d+\.\d+\.\d+/, status);
      assert.doesNotMatch(status, /shown as|sandbox is off/i);
      // A killed browser comes back on the next action, on the same measurement. After a crash
      // the helper ends agents' connections (their bridges reconnect within 10 s and are back in
      // their tabs): this agent connects again, as a bridge does.
      const pid = browserPid(h.daemon.pid);
      assert.ok(pid, "the browser runs");
      process.kill(pid, "SIGKILL");
      for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
      await until("the helper saw the browser close", () => /browser closed/.test(log(home)), 30_000, 200);
      a.sock.destroy();
      a = await session(h.socketPath, "h");
      const again = await read();
      const statusAfter = text(await a.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
      const after = defaultValidation(home, nativeVersion);
      assert.ok(browserPid(h.daemon.pid) && browserPid(h.daemon.pid) !== pid, "a new browser");
      assert.equal(again.webgl.renderer, page.webgl.renderer);
      assert.equal(measured(home), 1, "no second measurement");
      assert.deepEqual([after.runtimeKey, after.graphics.at, after.status], [entry.runtimeKey, entry.graphics.at, "validated"], "the same measurement and verdict (the entry's own time is the second start's)");
      assert.deepEqual(after.graphics, entry.graphics, "the measurement unchanged");
      assert.match(statusAfter, /Graphics: hardware \(.+\), requested auto, validated on/);
      assert.ok(log(home).split("\n").filter((l) => /launch: graphics: hardware, validated on/.test(l)).length >= 2, "both starts filed the verdict");
    } catch (e) {
      failed = true;
      throw new Error(`${e.message}\n--- daemon.log (${home}) ---\n${log(home).slice(-5000)}`, { cause: e });
    } finally { a.sock.destroy(); }
  } finally {
    await h.stop();
    site.close();
    if (!failed) rmSync(home, { recursive: true, force: true }); // kept on a failure, for its log
  }
});
