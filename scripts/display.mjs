// Private virtual screen for servers: a real, headed Chrome without a monitor.
// Xvfb runs without TCP and behind an X cookie stored in ~/.pairbrowse, so other users on the
// machine can't watch the screen or send it input.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { paths } from "./paths.mjs";

// Is a program on the PATH?
export const hasCommand = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

export function needsVirtualDisplay(config, env = process.env, platform = process.platform) {
  if (config.display === "none" || platform !== "linux") return false;
  if (config.display === "xvfb") return true;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

export async function startVirtualDisplay(log = () => {}) {
  if (!hasCommand("Xvfb") || !hasCommand("xauth")) {
    throw new Error("pairbrowse needs Xvfb and xauth for a virtual screen. Install them (Debian/Ubuntu: sudo apt-get install -y xvfb xauth).");
  }
  const auth = join(paths.home, "run", "Xauthority");
  for (let n = 99; n < 140; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    rmSync(auth, { force: true });
    const cookie = randomBytes(16).toString("hex");
    if (spawnSync("xauth", ["-f", auth, "add", `:${n}`, ".", cookie]).status !== 0) throw new Error("xauth failed");
    const xvfb = spawn("Xvfb", [`:${n}`, "-screen", "0", "1366x900x24", "-auth", auth, "-nolisten", "tcp"], { stdio: "ignore" });
    for (let i = 0; i < 50 && xvfb.exitCode === null; i++) {
      if (existsSync(`/tmp/.X11-unix/X${n}`)) {
        log(`virtual screen :${n} started`);
        return { env: { DISPLAY: `:${n}`, XAUTHORITY: auth }, stop: () => xvfb.kill() };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    xvfb.kill();
  }
  throw new Error("couldn't start a virtual screen (Xvfb)");
}
