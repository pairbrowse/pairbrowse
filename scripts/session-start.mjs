#!/usr/bin/env node
// SessionStart hook: gives the agent the PairBrowse core, how the user sees the browser here, and
// any unfinished runs it can offer to resume (session-core.mjs). In Grok it prints nothing at
// session start (observe-only there) and runs again as a PostToolUse hook on Grok's PairBrowse
// tools (hooks/hooks.json), giving the core with the first PairBrowse result of the session.
import { readFileSync } from "node:fs";
import { detectHost } from "./surface.mjs";
import { sessionCore, grokCoreReply } from "./session-core.mjs";

try {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
  const host = detectHost(input);
  if (host === "grok") {
    const reply = grokCoreReply(input);
    if (reply) process.stdout.write(reply);
  } else if (!input.hook_event_name || input.hook_event_name === "SessionStart") {
    // Claude Code and Codex: their session start only.
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionCore(host) } }));
  }
} catch {
  // Never block session start.
}
