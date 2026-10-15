#!/usr/bin/env node
// PreToolUse hook for every PairBrowse tool.
// - Routine browser actions run without permission prompts.
// - Clicks named with a class ("Pay: Submit order": the agent names what it knows commits, and the
//   helper demands it for payment, danger and DELETE signals, see clickClass) ask you first. "Publish:" clicks are blocked until a passing pre-submit review
//   was recorded in the last REVIEW_MAX_AGE_MIN (30) minutes, then still ask. This can't be switched off.
// - OK on a page's confirm or prompt dialog named with a class asks you; the helper makes the agent
//   name it right after a delete or payment click (scripts/rules/clicks.mjs).
// - Uploads run only for ordinary media and documents in ~/.pairbrowse/files/uploads;
//   anything else asks you.
// - Only web pages can be opened; local-network addresses ask you first.
// - If anything goes wrong in here, it asks rather than allows.
import { paths } from "./paths.mjs";
import { isCodexTool, approvalAsk, decide, forHost, forMode, ask } from "./rules/decide.mjs";
import { BROWSER_PREFIX } from "./rules/policy.mjs";
import { HOOK_MARK, requestLine } from "./hookline.mjs";

// The rules live in rules/ (decide.mjs, clicks.mjs, upload.mjs, network.mjs); re-exported here for
// the hook's older importers.
export { CLICK_CLASSES, clickClass, CLICK_PREFIX } from "./rules/clicks.mjs";
export { uploadAllowed } from "./rules/upload.mjs";
export { isLocalNetwork } from "./rules/network.mjs";
export { isCodexTool, decide, forHost, forMode, APPROVAL_TOOLS, approvalAsk, approvalKey } from "./rules/decide.mjs";

// Approvals in two places at once (Claude Code). Claude Code shows its own prompt only after the
// PreToolUse hook has exited, so that hook can't also wait for the browser. The same script runs as
// its PermissionRequest hook too (hooks/hooks.json), which Claude Code starts alongside its prompt:
// for a named click (and a named OK on a page's dialog) it asks the helper over the private socket
// to show the ask in the browser and waits. Whichever answer comes first wins: an Allow or Deny in
// the browser ends the prompt; a yes in the terminal sends the call, and the helper takes the card
// down; a no in the terminal stops this hook, and the helper takes the card down when its socket
// closes. Nothing here ever allows by mistake: any error, timeout or other answer prints nothing, and
// the terminal's prompt stays as the only one.

// The first bytes of a hook's line on the private socket, and the one-line request (hookline.mjs).
export { HOOK_MARK } from "./hookline.mjs";
// How long an ask waits in the browser before the terminal is the only place left.
const waitEnv = Number(process.env.PAIRBROWSE_APPROVAL_WAIT_MS);
export const APPROVAL_WAIT_MS = Number.isFinite(waitEnv) && process.env.PAIRBROWSE_APPROVAL_WAIT_MS !== "" ? Math.min(600_000, Math.max(100, waitEnv)) : 120_000;

// This hook's ancestors (process ids, its parent first, up to 6): the app that runs it is among
// them, and the helper matches it to the agent whose bridge that app started (approvals.mjs
// whose). Read with one bounded ps; [parent] alone when that fails.
export async function ancestors() {
  const chain = [process.ppid];
  if (process.platform === "win32") return chain;
  try {
    const { execFile } = await import("node:child_process");
    const out = await new Promise((done) => execFile("ps", ["-A", "-o", "pid=,ppid="], { timeout: 1500, maxBuffer: 4 << 20 }, (e, o) => done(e ? "" : String(o))));
    const parent = new Map();
    for (const l of out.split("\n")) { const [a, b] = l.trim().split(/\s+/).map(Number); if (a > 0) parent.set(a, b); }
    for (let p = parent.get(process.ppid); chain.length < 6 && p > 1 && !chain.includes(p); p = parent.get(p)) chain.push(p);
  } catch {}
  return chain;
}

// The PermissionRequest hook: what it prints ("" leaves the terminal's prompt to answer).
export async function permissionRequest(input, { socketPath = paths.socket, waitMs = APPROVAL_WAIT_MS } = {}) {
  let sock = null;
  try {
    const tool = String(input?.tool_name || "");
    if (isCodexTool(tool) || !tool.startsWith("mcp__plugin_pairbrowse_browser__")) return "";
    // Bypass mode asks nothing; a subagent's prompt waits for this hook, so it isn't asked here.
    if (input.permission_mode === "bypassPermissions" || input.agent_id) return "";
    const ti = input.tool_input;
    const name = tool.replace(BROWSER_PREFIX, "");
    if (!approvalAsk(name, ti)) return "";
    const net = await import("node:net");
    const chain = await ancestors();
    sock = net.connect(socketPath);
    const line = await requestLine(sock, `${HOOK_MARK},${JSON.stringify({ op: "approval", v: 1, tool: name, input: ti, ancestors: chain }).slice(1)}`, waitMs + 5000, { partialOnClose: true });
    let answer = "";
    try { answer = JSON.parse(line || "null")?.answer; } catch {}
    if (answer === "allow" || answer === "site") return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    if (answer === "deny") return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "pairbrowse: Denied in the PairBrowse browser. Nothing was done; ask the user what to do." } } });
    return "";
  } catch {
    return "";
  } finally {
    sock?.destroy();
  }
}

if (process.argv[1]?.endsWith("guard.mjs")) {
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    // The PermissionRequest hook: prints the browser's answer, or nothing. Never an allow on error.
    let peek = null;
    try { peek = JSON.parse(raw); } catch {}
    if (peek?.hook_event_name === "PermissionRequest" || (!peek && /"hook_event_name"\s*:\s*"PermissionRequest"/.test(raw))) {
      const done = () => process.exit(0); // within()'s timer must not keep the hook alive
      (peek ? permissionRequest(peek) : Promise.resolve("")).catch(() => "").then((text) => (text ? process.stdout.write(text, done) : done()));
      return;
    }
    let input = {};
    try {
      input = JSON.parse(raw) || {};
      process.stdout.write(forHost(input, forMode(input, decide(input))));
    } catch {
      // Fail closed: if the guard can't decide, you do. Unreadable input from Codex (which would
      // treat an "ask" as a failed hook and go ahead) is refused outright.
      const verdict = ask("The safety check couldn't read this action, so it needs your approval.");
      process.stdout.write(input?.tool_name ? forHost(input, verdict) : /mcp__pairbrowse_(browser|runs)__/.test(raw)
        ? forHost({ tool_name: "mcp__pairbrowse_browser__" }, verdict) : JSON.stringify(verdict));
    }
  });
}
