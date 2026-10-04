#!/usr/bin/env node
// PreToolUse hook for every PairBrowse tool.
// - Routine browser actions run without permission prompts.
// - Clicks named with a class ("Pay: Submit order": the agent names what it knows commits, and the
//   helper demands it for payment, danger and DELETE signals, see clickClass) ask you first. "Publish:" clicks are blocked until a passing pre-submit review
//   was recorded in the last REVIEW_MAX_AGE_MIN (30) minutes, then still ask. This can't be switched off.
// - OK on a page's confirm or prompt dialog named with a class asks you; the helper makes the agent
//   name it right after a delete or payment click (scripts/clickrule.mjs).
// - Uploads run only for ordinary media and documents in ~/.pairbrowse/files/uploads;
//   anything else asks you.
// - Only web pages can be opened; local-network addresses ask you first.
// - If anything goes wrong in here, it asks rather than allows.
import { resolve, sep } from "node:path";
import { loadConfig, paths } from "./paths.mjs";
import { navigationProblem, BLOCKED_TOOLS, BROWSER_PREFIX } from "./policy.mjs";
import { latestReview, REVIEW_MAX_AGE_MIN } from "./runs.mjs";
import { secretInside, MEDIA } from "./upload.mjs";

// A click Claude knows commits something is named with its class first: "Pay: Submit order",
// "Delete: OK", "Submit: Create account", "Send: Reply", "Publish: Submit for review". The helper
// works out from the page's structure what the click does (daemon/page.mjs clickRisk, never its
// words) and refuses one with strong signals until it's named (scripts/clickrule.mjs); ordinary
// submits go unless Claude names them. This hook asks you about every named click. Publish is the class
// Claude gives a submit-for-review or go-live click (the listing skill), and it's blocked until a
// passing pre-submit review.
export const CLICK_CLASSES = ["publish", "pay", "delete", "send", "submit"];
const CLASS_TEXT = { publish: "publishes or submits for review", pay: "pays", delete: "deletes or ends something", send: "sends something to other people", submit: "sends or submits something" };

// The class an element description starts with ("Pay: Submit order" -> "pay"), or "".
export function clickClass(element) {
  const c = String(element || "").match(/^[\s"'“‘([]*([A-Za-z]+)\s*:/)?.[1]?.toLowerCase();
  return CLICK_CLASSES.includes(c) ? c : "";
}

export function uploadAllowed(p, uploadsDir = paths.uploads) {
  const full = resolve(String(p));
  return full.startsWith(resolve(uploadsDir) + sep) && MEDIA.test(full) && !secretInside(full);
}

// Loopback, private and link-local addresses: your router, NAS, local dev servers.
export function isLocalNetwork(url) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) || /^0\./.test(host) || host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
}

const allow = () => out("allow");
const ask = (reason) => out("ask", reason);
const deny = (reason) => out("deny", reason);
function out(permissionDecision, reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, ...(reason ? { permissionDecisionReason: `pairbrowse: ${reason}` } : {}) } };
}

// The runs server's tools, by Claude Code's and Codex's names (BROWSER_PREFIX: the browser's).
const RUNS_PREFIX = /^mcp__(plugin_pairbrowse_runs|pairbrowse_runs)__/;
export const isCodexTool = (name) => /^mcp__pairbrowse_(browser|runs)__/.test(String(name || ""));

export function decide(input, config = loadConfig(), review = latestReview(), now = Date.now()) {
  const name = String(input.tool_name || "");
  if (RUNS_PREFIX.test(name)) return allow();
  const tool = name.replace(BROWSER_PREFIX, "");
  const ti = input.tool_input || {};

  if (BLOCKED_TOOLS.has(tool)) return deny(`${tool} is disabled by PairBrowse.`);

  if (tool === "pairbrowse_session" && ti.action === "delete") return ask(`Deletes the browser session "${ti.name}" and its logins.`);

  // A drive link lets another person click and type in your logged-in browser. Anything but a
  // plain watch link asks.
  if (tool === "pairbrowse_invite" && ti.action === "create" && ti.role !== "watch") {
    const who = String(ti.label || "someone").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 40);
    return ask(`Creates an invite (a link or join code) that lets ${who} click and type in your logged-in PairBrowse browser (not your saved details or passwords) for ${Number(ti.hours) > 0 ? Math.min(Number(ti.hours), 168) : 24} hours. Share it only with someone you trust.`);
  }

  // share_port needs no prompt here: it only asks the user, Yes or No in the side panel (a real
  // click there shares the dev server), in Claude Code and Codex alike.

  // Letting someone into the session: only the user decides, never an agent on its own (a page
  // could tell it to). The live view's Allow button needs no prompt; this does.
  if (tool === "pairbrowse_invite" && ti.action === "approve") {
    return ask(`Lets the person behind join request ${String(ti.id || "").replace(/[^\w-]/g, "").slice(0, 20)} into your PairBrowse session. Allow only if you are expecting them.`);
  }

  // Page scripts can read what was typed (including passwords) and send it anywhere, so they
  // always need your OK. Claude doesn't need them for filling forms.
  if (tool === "browser_evaluate") return ask("Runs a script inside the page. Check what it does before allowing it.");

  if (tool === "browser_file_upload" || (tool === "browser_drop" && ti.paths)) {
    const files = ti.paths || [];
    const odd = files.filter((p) => !uploadAllowed(p));
    if (odd.length) return ask(`Upload of ${odd.join(", ")}: only images, video and documents copied into ${paths.uploads} upload without asking.`);
    if (tool === "browser_file_upload") return allow();
  }

  if (tool === "browser_navigate" || (tool === "browser_tabs" && ti.url)) {
    const problem = navigationProblem(ti.url);
    if (problem) return deny(problem);
    if (isLocalNetwork(ti.url)) return ask(`${ti.url} is on your local network or this computer.`);
  }

  // A page's own confirm or prompt dialog (PairBrowse answers alerts itself): an OK the agent named
  // as a final action is yours. The helper has it named (scripts/clickrule.mjs dialogRule).
  if (tool === "browser_handle_dialog" && ti.accept && clickClass(ti.element)) {
    const cls = clickClass(ti.element);
    return ask(`OK on the page's dialog ("${String(ti.element).slice(0, 80)}") ${CLASS_TEXT[cls]}: a final action (${cls}). Check what it confirms.`);
  }

  if (tool === "browser_click" || tool === "browser_drag" || tool === "browser_drop") {
    const raw = String(ti.element || ti.startElement || ti.endElement || "");
    const cls = clickClass(raw);

    if (cls === "publish") {
      const fresh = review && now - Date.parse(review.at) < REVIEW_MAX_AGE_MIN * 60_000;
      if (!fresh || !review.passed) {
        return deny(
          `"${raw}" submits for review or publishes. First open the platform's current official requirements in a new tab, ` +
          `check the filled-in listing against every rule, fix what fails, and record it with review_save. ` +
          (review && fresh && !review.passed ? "The last review failed." : `No passing review in the last ${REVIEW_MAX_AGE_MIN} minutes.`),
        );
      }
      const waived = review.checks.filter((c) => c.waived).map((c) => c.rule);
      return ask(`Pre-submit review passed (${review.checks.length} checks against ${review.guidelinesUrl})` +
        (waived.length ? `, waived by you: ${waived.join("; ")}` : "") + `. Confirm "${raw}".`);
    }

    if (cls) return ask(`"${raw}" ${CLASS_TEXT[cls]}: a final action (${cls})`);
  }

  return allow();
}

// Codex takes only "deny" from this hook (an "allow" or "ask" answer counts as a failed hook, and
// the call goes ahead), so there: say nothing to allow, and hand what needs your OK to you.
export function forHost(input, verdict) {
  if (!isCodexTool(input?.tool_name)) return JSON.stringify(verdict);
  const { permissionDecision, permissionDecisionReason = "" } = verdict.hookSpecificOutput;
  if (permissionDecision === "allow") return "";
  const reason = permissionDecision === "ask"
    ? `${permissionDecisionReason.replace(/\.?$/, ".")} This needs the user's OK: set pairbrowse_status to "you" and ask the user to do this step themselves in the PairBrowse window, then continue`
    : permissionDecisionReason;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

if (process.argv[1]?.endsWith("guard.mjs")) {
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let input = {};
    try {
      input = JSON.parse(raw) || {};
      process.stdout.write(forHost(input, decide(input)));
    } catch {
      // Fail closed: if the guard can't decide, you do. Unreadable input from Codex (which would
      // treat an "ask" as a failed hook and go ahead) is refused outright.
      const verdict = ask("The safety check couldn't read this action, so it needs your approval.");
      process.stdout.write(input?.tool_name ? forHost(input, verdict) : /mcp__pairbrowse_(browser|runs)__/.test(raw)
        ? forHost({ tool_name: "mcp__pairbrowse_browser__" }, verdict) : JSON.stringify(verdict));
    }
  });
}
