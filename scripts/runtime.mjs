// Pinned browser runtime in ~/.pairbrowse/runtime, installed from the plugin's lockfile:
// exact versions, checksums verified by npm, install scripts disabled.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "./paths.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function ensureRuntime(say = () => {}) {
  const source = "runtime";
  const destination = paths.runtime;
  const dependency = "@playwright/mcp";
  const want = readFileSync(join(root, source, "package-lock.json"), "utf8");
  const lock = join(destination, "package-lock.json");
  if (existsSync(lock) && readFileSync(lock, "utf8") === want && existsSync(join(destination, "node_modules", dependency))) return false;
  say("installing the browser runtime (first run only)...");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  copyFileSync(join(root, source, "package.json"), join(destination, "package.json"));
  copyFileSync(join(root, source, "package-lock.json"), lock);
  const r = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: destination, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", encoding: "utf8" });
  if (r.status !== 0) throw new Error(`npm ci failed:\n${r.stderr}`);
  return true;
}

