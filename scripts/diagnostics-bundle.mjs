#!/usr/bin/env node
// One command for a bug report: node scripts/diagnostics-bundle.mjs [--out <folder>]
// Writes a folder (pairbrowse-diagnostics-<time>) of what helps find a problem, with nothing
// private in it: versions (the helper, both plugin manifests, the pinned runtime, Node, the OS),
// the native build and engine pack installed, the settings (config.json, values redacted), the
// helper's last crash and the last lines of daemon.log. Every text goes through the same scrub as
// the Tools tab's diagnostics (daemon/diagnostics.mjs): saved passwords masked, addresses cut to
// their host (no path, query or fragment), emails, cookies, keys and tokens, quoted page text and folders
// under your home removed. Nothing else is read (no profile, cookies, secrets file beyond the
// values to mask, runs, activity or goal logs) and nothing is sent anywhere: you attach it yourself.
// Default folder: ~/.pairbrowse/diagnostics. Node's standard library only.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, platform, arch, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "./paths.mjs";
import { readJson } from "./util.mjs";
import { scrub } from "./daemon/diagnostics.mjs";
import { loadSecrets, redact } from "./rules/secrets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LOG_LINES = 400;
const TAIL_BYTES = 512 * 1024;
const CRASH_LINES = 20;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z /;
const CRASH = /^\S+ (uncaught exception|unhandled rejection)\b/;
// Settings whose values are never written, whatever they hold (a proxy's user and password, keys).
const HIDDEN_KEY = /key|token|secret|password|passwd|auth|cookie|credential|proxy/i;

// The last bytes of a file as lines (the first, cut, dropped), or [].
function tail(file, bytes = TAIL_BYTES) {
  let buf;
  try { buf = readFileSync(file); } catch { return []; }
  const cut = buf.length > bytes;
  const lines = buf.subarray(Math.max(0, buf.length - bytes)).toString("utf8").split("\n");
  return cut ? lines.slice(1) : lines;
}

// A settings value as it may be written: strings scrubbed, numbers and booleans as they are,
// values under a secret-sounding name hidden, nesting and lists bounded.
export function redactConfig(value, clean, depth = 0) {
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string") return clean(value);
  if (depth >= 4) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactConfig(v, clean, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 100)) out[clean(k)] = HIDDEN_KEY.test(k) ? "[hidden]" : redactConfig(v, clean, depth + 1);
    return out;
  }
  return null;
}

// The helper's last crash in daemon.log: the line that says so and its stack, scrubbed; or null.
export function lastCrash(lines, clean) {
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (CRASH.test(lines[i])) { at = i; break; }
  if (at < 0) return null;
  const out = [lines[at]];
  for (let i = at + 1; i < lines.length && out.length < CRASH_LINES && !ISO.test(lines[i]) && lines[i].trim(); i++) out.push(lines[i]);
  return { at: lines[at].slice(0, lines[at].indexOf(" ")), lines: out.map(clean) };
}

const version = (file) => { const v = readJson(file)?.version; return typeof v === "string" ? v : null; };
const pick = (o, keys) => (o && typeof o === "object" ? Object.fromEntries(keys.filter((k) => typeof o[k] === "string" || typeof o[k] === "boolean" || typeof o[k] === "number").map((k) => [k, o[k]])) : null);

// Writes the bundle; returns { dir, files }. home: whose folders count as private (tests pass
// theirs); now: the clock.
export function writeBundle({ out = paths.diagnostics, home = homedir(), now = new Date() } = {}) {
  const secrets = loadSecrets(paths.secrets).values;
  const mask = (t) => redact(t, secrets, { as: (name) => `[${name}]` });
  // Lines from the log and settings: page text in quotes goes too (the helper quotes page names).
  const clean = (t) => scrub(t, { home, mask, max: 400 });
  const logLines = tail(paths.daemonLog);
  const config = readJson(paths.config);
  const runtimePkg = readJson(join(ROOT, "runtime", "package.json"));
  const summary = {
    created: now.toISOString(),
    versions: {
      helper: version(join(ROOT, "package.json")),
      claudePlugin: version(join(ROOT, ".claude-plugin", "plugin.json")),
      codexPlugin: version(join(ROOT, ".codex-plugin", "plugin.json")),
      runtime: pick(runtimePkg?.dependencies, ["@playwright/mcp", "patchright", "playwright"]),
      runtimeInstalled: version(join(paths.runtime, "node_modules", "@playwright", "mcp", "package.json")),
      node: process.versions.node,
      os: `${platform()} ${arch()} ${release()}`,
    },
    native: {
      build: pick(readJson(join(paths.browser, "native.json")), ["version", "sha256", "installedAt", "branding", "chrome"]),
      engine: pick(readJson(join(paths.engine, "installed.json")), ["version", "sha256", "installedAt"]),
      ungoogledStamp: existsSync(paths.buildStamp) ? clean(readFileSync(paths.buildStamp, "utf8").trim()) : null,
    },
    config: config === null ? null : redactConfig(config, clean),
    secrets: { saved: Object.keys(secrets).length }, // how many, never their names or values
    lastCrash: lastCrash(logLines, clean),
  };
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dir = join(resolve(out), `pairbrowse-diagnostics-${stamp}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = [join(dir, "summary.json"), join(dir, "daemon-log.txt")];
  writeFileSync(files[0], `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(files[1], `${logLines.filter((l) => l.trim()).slice(-LOG_LINES).map(clean).join("\n")}\n`, { mode: 0o600 });
  return { dir, files };
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--out");
  if (args.includes("--help") || (i >= 0 && !args[i + 1])) {
    console.log("Usage: node scripts/diagnostics-bundle.mjs [--out <folder>]\nWrites a redacted diagnostics folder to attach to a bug report (default under ~/.pairbrowse/diagnostics).");
    process.exit(args.includes("--help") ? 0 : 2);
  }
  const { dir } = writeBundle(i >= 0 ? { out: args[i + 1] } : {});
  console.log(`Diagnostics written to ${dir}\nLook it over before you attach it: nothing in it was sent anywhere.`);
}
