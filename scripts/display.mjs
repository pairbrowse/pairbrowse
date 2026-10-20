// Private virtual screen for a Linux machine without a screen: a real, headed browser without a monitor.
// Xvfb runs without TCP and behind an X cookie stored in ~/.pairbrowse, so other users on the
// machine can't watch the screen or send it input.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { paths, DEFAULT_CONFIG } from "./paths.mjs";
import { CONFIG_SCHEMA, fits } from "./config-schema.mjs";
import { sleep } from "./util.mjs";

// Is a program on the PATH?
export const hasCommand = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

export function needsVirtualDisplay(config, env = process.env, platform = process.platform) {
  if (config.display === "none" || platform !== "linux") return false;
  if (config.display === "xvfb") return true;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

// Server mode: the helper runs the browser on its own virtual screen, or config.json's
// server.keepAlive says this is a server. Supervision, the sandbox rule and where() read it; a
// desktop (a screen of its own, no keepAlive) is never in server mode.
export function serverMode(config, env = process.env, platform = process.platform) {
  return needsVirtualDisplay(config, env, platform) || config?.server?.keepAlive === true;
}

// The virtual screen's { width, height, depth } from config.json's virtualScreen: each field the
// schema's bounds allow, else its default (1366x900x24), so a partial or hand-edited value
// still gives a whole screen.
export function screenGeometry(config) {
  const given = config?.virtualScreen && typeof config.virtualScreen === "object" ? config.virtualScreen : {};
  const { fields } = CONFIG_SCHEMA.virtualScreen;
  const out = {};
  for (const k of Object.keys(fields)) out[k] = fits(fields[k], given[k]) ? given[k] : DEFAULT_CONFIG.virtualScreen[k];
  return out;
}

// Xvfb's arguments for display n: one screen of the geometry, the cookie file, no TCP.
export const xvfbArgs = (n, geometry, auth) => [`:${n}`, "-screen", "0", `${geometry.width}x${geometry.height}x${geometry.depth}`, "-auth", auth, "-nolisten", "tcp"];

// name: the X cookie file in ~/.pairbrowse/run (the launch self-check uses its own, so a
// running browser's screen keeps working). geometry: { width, height, depth } (screenGeometry;
// checked again here, defaults for what's missing). Returns { env, display, pid, geometry, stop }.
export async function startVirtualDisplay(log = () => {}, { name = "Xauthority", geometry } = {}) {
  if (!hasCommand("Xvfb") || !hasCommand("xauth")) {
    throw new Error("pairbrowse needs Xvfb and xauth for a virtual screen. Install them (Debian/Ubuntu: sudo apt-get install -y xvfb xauth).");
  }
  const g = screenGeometry({ virtualScreen: geometry });
  const auth = join(paths.run, name);
  mkdirSync(paths.run, { recursive: true, mode: 0o700 });
  for (let n = 99; n < 140; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    rmSync(auth, { force: true });
    const cookie = randomBytes(16).toString("hex");
    if (spawnSync("xauth", ["-f", auth, "add", `:${n}`, ".", cookie]).status !== 0) throw new Error("xauth failed");
    const xvfb = spawn("Xvfb", xvfbArgs(n, g, auth), { stdio: "ignore" });
    for (let i = 0; i < 50 && xvfb.exitCode === null; i++) {
      if (existsSync(`/tmp/.X11-unix/X${n}`)) {
        log(`virtual screen :${n} started (${g.width}x${g.height}x${g.depth})`);
        return { env: { DISPLAY: `:${n}`, XAUTHORITY: auth }, display: `:${n}`, pid: xvfb.pid, geometry: g, stop: () => xvfb.kill() };
      }
      await sleep(100);
    }
    xvfb.kill();
  }
  throw new Error("couldn't start a virtual screen (Xvfb)");
}
