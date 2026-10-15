// Pinned browser runtime in ~/.pairbrowse/runtime (the shared installs' home: instances use the
// same one), installed from the plugin's lockfile: exact versions, checksums verified by npm,
// install scripts disabled; one install at a time (install-lock.mjs).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "./paths.mjs";
import { withInstallLockSync } from "./install-lock.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function ensureRuntime(say = () => {}) {
  const want = readFileSync(join(root, "runtime", "package-lock.json"), "utf8");
  const lock = join(paths.runtime, "package-lock.json");
  const installed = () => existsSync(lock) && readFileSync(lock, "utf8") === want && existsSync(join(paths.runtime, "node_modules", "@playwright/mcp"));
  if (installed()) return false;
  return withInstallLockSync(() => {
    if (installed()) return false; // another helper installed it while this one waited
    say("installing the browser runtime (first run only)...");
    mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
    copyFileSync(join(root, "runtime", "package.json"), join(paths.runtime, "package.json"));
    copyFileSync(join(root, "runtime", "package-lock.json"), lock);
    const r = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: paths.runtime, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", encoding: "utf8" });
    if (r.status !== 0) throw new Error(`npm ci failed:\n${r.stderr}`);
    return true;
  }, { say });
}
