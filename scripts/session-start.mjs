#!/usr/bin/env node
// SessionStart hook: gives the agent the PairBrowse core (scripts/core.md), how the user sees the
// browser here, and any unfinished runs it can offer to resume.
import { unfinishedRuns, unfinishedNote } from "./runs.mjs";
import { readFileSync } from "node:fs";
import { detectSurface, detectHost, surfaceGuidance, coreText } from "./surface.mjs";
import { loadConfig, paths } from "./paths.mjs";
import { chooseBrowserDriver, patchrightNodeMinimum } from "./driver.mjs";

try {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
  const host = detectHost(input);
  const surface = host === "codex" ? "terminal" : detectSurface();
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
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n\n") } }));
} catch {
  // Never block session start.
}
