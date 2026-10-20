// What the agent is told when its session starts (session-start.mjs): the PairBrowse core
// (scripts/core.md) worded for its app, how the user sees the browser there, a driver notice and
// the unfinished runs it can offer to resume. Grok gets it from a tool hook instead: its
// SessionStart is observe-only (nothing printed there reaches the model) and only tool hooks'
// additionalContext does, so the first PairBrowse result of each Grok session carries it
// (grokFirst; session-start.mjs and log.mjs, whichever name Grok gives the tools).
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unfinishedRuns, unfinishedNote } from "./runs.mjs";
import { detectSurface, surfaceGuidance, coreText } from "./surface.mjs";
import { loadConfig, paths } from "./paths.mjs";
import { chooseBrowserDriver, patchrightNodeMinimum } from "./driver.mjs";
import { sha256 } from "./util.mjs";

export function sessionCore(host) {
  const surface = host === "claude" ? detectSurface() : "terminal";
  // The browser asks the person which session (its session picker) unless that's turned off.
  const config = loadConfig();
  const picker = config.sessionPicker !== false && surface !== "cloud";
  const parts = [coreText(host, { picker }), surfaceGuidance(surface, host)];
  // Node.js too old for Patchright: the helper falls back to Playwright; tell the user once.
  let driver = null;
  try { driver = chooseBrowserDriver(config, process.versions.node, patchrightNodeMinimum(paths.runtime)); } catch {}
  if (driver?.notice) parts.push(`Tell the user once, in these words: "${driver.notice}"`);
  // Unfinished runs, the agent's own and the ones the helper kept by itself (docs/using.md, "Runs"):
  // one line each, so a task picks up where it was after a context reset.
  const open = unfinishedRuns();
  if (open.length) parts.push(unfinishedNote(open));
  return parts.join("\n\n");
}

// Whether this Grok session hasn't had the core yet: marks it (a file named for its id, hashed)
// and clears markers older than a week. No session id: once a day.
export function grokFirst(input = {}, env = process.env) {
  const id = String(env.GROK_SESSION_ID || input.sessionId || input.session_id || `day-${new Date().toISOString().slice(0, 10)}`);
  try {
    mkdirSync(paths.grokCore, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(paths.grokCore)) {
      try { if (Date.now() - statSync(join(paths.grokCore, f)).mtimeMs > 7 * 24 * 3600_000) unlinkSync(join(paths.grokCore, f)); } catch {}
    }
    writeFileSync(join(paths.grokCore, sha256(id).slice(0, 32)), "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

// The hook reply that gives Grok the core with this tool result, or "" (not Grok's tool hook,
// or this session had it).
export function grokCoreReply(input = {}, env = process.env) {
  if (!env.GROK_HOOK_EVENT || env.GROK_HOOK_EVENT !== "PostToolUse" || !grokFirst(input, env)) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: sessionCore("grok") } });
}
