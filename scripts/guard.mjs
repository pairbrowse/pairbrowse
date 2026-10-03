#!/usr/bin/env node
// PreToolUse hook for every PairBrowse tool.
// - Routine browser actions run without permission prompts.
// - Submit-for-review / publish clicks are blocked until a passing pre-submit review
//   was recorded in the last REVIEW_MAX_AGE_MIN (30) minutes, and then still ask you to confirm. This can't be switched off.
// - Paying, deleting and messaging people ask you first.
// - Uploads run only for ordinary media and documents in ~/.pairbrowse/files/uploads;
//   anything else asks you.
// - Only web pages can be opened; local-network addresses ask you first.
// - If anything goes wrong in here, it asks rather than allows.
import { resolve, sep } from "node:path";
import { loadConfig, paths } from "./paths.mjs";
import { navigationProblem, BLOCKED_TOOLS, BROWSER_PREFIX } from "./policy.mjs";
import { latestReview, REVIEW_MAX_AGE_MIN } from "./runs.mjs";
import { secretInside, MEDIA } from "./upload.mjs";

export const REVIEW_WORDS = [
  "submit for review", "submit app", "submit listing", "submit for approval", "submit application",
  "send for review", "request review", "publish", "go live",
];

export const CONFIRM_WORDS = [
  // money
  "pay", "purchase", "buy", "checkout", "check out", "place order", "subscribe", "upgrade",
  "add card", "add payment", "confirm payment", "start trial", "start plan", "charge",
  // destructive
  "delete", "deactivate", "uninstall", "close account", "close store", "cancel subscription",
  "revoke", "disconnect", "transfer ownership",
  // talking to other people
  "send message", "send invite", "send email", "reply to customer",
];

// Phrases that contain a confirm word but are routine.
const SAFE_PHRASES = ["send code", "send verification", "resend code", "send link"];

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

export const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A whole word or phrase in a lower-case label ("pay" in "pay now", not in "payment").
const matches = (label, word) => new RegExp(`(^|[^a-z])${escapeRegExp(word)}([^a-z]|$)`).test(label);
const routine = (raw) => SAFE_PHRASES.reduce((s, p) => s.replaceAll(p, " "), String(raw).toLowerCase());

// Whether a label names this final-action word (a pay button must be called pay, not delete).
export const mentions = (raw, word) => matches(routine(raw), word);

// The final-action word in a button label, if any: { word, review } or null.
export function finalAction(raw, config = loadConfig()) {
  const label = routine(raw);
  const review = REVIEW_WORDS.find((w) => matches(label, w));
  if (review) return { word: review, review: true };
  const neverConfirm = config.neverConfirm.map((w) => w.toLowerCase());
  const words = [...CONFIRM_WORDS, ...config.confirm.map((w) => w.toLowerCase())].filter((w) => !neverConfirm.includes(w));
  const hit = words.find((w) => matches(label, w));
  return hit ? { word: hit, review: false } : null;
}

// For steps nobody confirms one by one (fast mode, an upload button clicked to find its file
// chooser): the built-in words count even where neverConfirm lifts them for browser_click.
const BUILT_IN = { confirm: [], neverConfirm: [] };
export const finalActionStrict = (raw, config = loadConfig()) => finalAction(raw, config) || finalAction(raw, BUILT_IN);

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

  if (tool === "browser_click" || tool === "browser_drag" || tool === "browser_drop") {
    const raw = String(ti.element || ti.startElement || ti.endElement || "");
    const action = finalAction(raw, config);

    if (action?.review) {
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

    if (action) return ask(`"${raw}" looks like a final action (${action.word})`);
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
