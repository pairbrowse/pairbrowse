// The guard's rules (the PreToolUse hook, guard.mjs, prints what decide() says): what runs, what asks
// you and what is refused, for every PairBrowse tool call. Pure apart from reading the latest
// pre-submit review, so the daemon applies the same rules for clients whose hooks can't ask (Codex).
import { paths } from "../paths.mjs";
import { navigationProblem, toolRefused, BROWSER_PREFIX } from "./policy.mjs";
import { latestReview, REVIEW_MAX_AGE_MIN } from "../runs.mjs";
import { toolsWith } from "../tools/catalog.mjs";
import { clickClass, CLASS_TEXT, CLICK_PREFIX } from "./clicks.mjs";
import { uploadAllowed } from "./upload.mjs";
import { isLocalNetwork } from "./network.mjs";

const allow = () => out("allow");
export const ask = (reason) => out("ask", reason);
const deny = (reason) => out("deny", reason);
function out(permissionDecision, reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, ...(reason ? { permissionDecisionReason: `pairbrowse: ${reason}` } : {}) } };
}

// The runs server's tools, by Claude Code's and Codex's names (BROWSER_PREFIX: the browser's).
const RUNS_PREFIX = /^mcp__(plugin_pairbrowse_runs|pairbrowse_runs)__/;
export const isCodexTool = (name) => /^mcp__pairbrowse_(browser|runs)__/.test(String(name || ""));

export function decide(input, _config, review = latestReview(), now = Date.now()) {
  const name = String(input.tool_name || "");
  if (RUNS_PREFIX.test(name)) return allow();
  const tool = name.replace(BROWSER_PREFIX, "");
  const ti = input.tool_input || {};

  // Blocked, hidden (browser_evaluate among them) or unknown browser tools: refused (the browser
  // server refuses them itself too, whatever this hook says).
  const refused = toolRefused(tool);
  if (refused) return deny(refused);

  if (tool === "pairbrowse_session" && ti.action === "delete") return ask(`Deletes the browser session "${ti.name}" and its logins.`);

  // A drive link lets another person click and type in your logged-in browser. Anything but a
  // plain watch link asks.
  // The approve role (made, or given to an invite later) also answers your approval cards.
  const approves = ti.role === "approve" ? " and answer your approval cards (pay, delete, send, submit, publish) in their own browser" : "";
  // A watch link (share "watch") opens anywhere for whoever holds it, with no approval: the user
  // says yes to each one an agent makes (the side panel's own button needs no prompt).
  if (tool === "pairbrowse_invite" && ti.action === "create" && ti.share === "watch") {
    const h = Number(ti.hours) > 0 ? Math.min(Number(ti.hours), 24) : 1;
    return ask(`Makes a watch link: anyone who has it can watch your PairBrowse browser live from any browser for ${h === 1 ? "1 hour" : `${h} hours`} (view only; card and password fields covered; nobody is asked before watching). Give it only to people you want watching.`);
  }
  if (tool === "pairbrowse_invite" && ti.action === "create" && ti.role !== "watch") {
    const who = String(ti.label || "someone").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 40);
    return ask(`Creates an invite (a link or join code) that lets ${who} click and type in your logged-in PairBrowse browser${approves} (not your saved details or passwords) for ${Number(ti.hours) > 0 ? Math.min(Number(ti.hours), 168) : 24} hours. Share it only with someone you trust.`);
  }
  if (tool === "pairbrowse_invite" && ti.action === "set_role" && ti.role !== "drive") {
    return ask(`Lets the people who joined with invite ${String(ti.id || "").replace(/[^\w-]/g, "").slice(0, 20)} answer your approval cards (pay, delete, send, submit, publish) in their own browser. Allow only if you trust them with those steps.`);
  }

  // share_port needs no prompt here: it only asks the user, Yes or No in the side panel (a real
  // click there shares the dev server), in Claude Code and Codex alike.

  // Letting someone into the session: only the user decides, never an agent on its own (a page
  // could tell it to). The side panel's, live view's and in-page prompt's Allow need no prompt (a person's click); this does.
  if (tool === "pairbrowse_invite" && ti.action === "approve") {
    return ask(`Lets the person behind join request ${String(ti.id || "").replace(/[^\w-]/g, "").slice(0, 20)} into your PairBrowse session. Allow only if you are expecting them: the name on the request is in the PairBrowse side panel, where you can also click Allow yourself.`);
  }

  if (tool === "browser_file_upload" || (tool === "browser_drop" && ti.paths)) {
    const files = ti.paths || [];
    const odd = (Array.isArray(files) ? files : []).filter((p) => !uploadAllowed(p));
    if (odd.length) return ask(`Upload of ${odd.join(", ")}: only images, video and documents copied into ${paths.uploads} upload without asking.`);
    if (tool === "browser_file_upload") return allow();
  }

  if (tool === "browser_navigate" || (tool === "browser_tabs" && ti.url)) {
    const problem = navigationProblem(ti.url);
    if (problem) return deny(problem);
    if (isLocalNetwork(ti.url)) return ask(`${ti.url} is on your local network or this computer.`);
  }

  // A page's own confirm or prompt dialog (PairBrowse answers alerts itself): an OK the agent named
  // as a final action is yours. The helper has it named (scripts/rules/clicks.mjs dialogRule).
  if (tool === "browser_handle_dialog" && ti.accept && clickClass(ti.element)) {
    const cls = clickClass(ti.element);
    return ask(`OK on the page's dialog ("${String(ti.element).slice(0, 80)}") ${CLASS_TEXT[cls]}: a final action (${cls}). Check what it confirms.`);
  }

  if (tool === "browser_click" || tool === "browser_drag" || tool === "browser_drop" || tool === "pairbrowse_click_at") {
    // A drag is named by either end: dropping onto "Delete: Trash" deletes, whatever is dragged.
    const ends = [ti.element, ti.startElement, ti.endElement].map((e) => String(e || ""));
    const raw = ends.find(clickClass) || ends.find(Boolean) || "";
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

// Claude Code in bypass-permissions mode asks the user for nothing, by their choice: what the
// guard would ask about goes too (the reason is kept for the log). Its refusals stay refusals.
export function forMode(input, verdict) {
  const given = verdict?.hookSpecificOutput;
  if (input?.permission_mode !== "bypassPermissions" || given?.permissionDecision !== "ask") return verdict;
  return out("allow", `allowed without asking (bypass-permissions mode): ${String(given.permissionDecisionReason || "").replace(/^pairbrowse: /, "")}`);
}

// The tools whose named final action can be answered in the browser as well.
export const APPROVAL_TOOLS = toolsWith("approval"); // the catalog's (tools/catalog.mjs)

// What the browser's card says for this call ({ reason, target }), or null when it isn't a named
// click or dialog OK the rules ask about. The reason is the rule's own (decide()), never the agent's.
export function approvalAsk(tool, input, review = latestReview(), now = Date.now()) {
  const name = String(tool || "").replace(BROWSER_PREFIX, "");
  if (!APPROVAL_TOOLS.has(name) || !input || typeof input !== "object" || Array.isArray(input)) return null;
  const verdict = decide({ tool_name: `mcp__plugin_pairbrowse_browser__${name}`, tool_input: input }, undefined, review, now).hookSpecificOutput;
  if (verdict.permissionDecision !== "ask") return null;
  const ends = (name === "browser_handle_dialog" ? [input.element] : [input.element, input.startElement, input.endElement]).map((e) => String(e || ""));
  const raw = ends.find(clickClass);
  if (!raw) return null;
  const target = raw.replace(CLICK_PREFIX, "").trim().slice(0, 120) || raw.slice(0, 120);
  // what: the element as the agent named it, its class first ("Pay: Place order"): a joiner's
  // notice while the host decides (liveview/approval-share.mjs).
  return { reason: String(verdict.permissionDecisionReason || "").replace(/^pairbrowse: /, ""), target, what: raw.trim().slice(0, 140) };
}

// The other asks (a local-network page, a session delete, an invite, a joiner let in, a file
// upload), for the browser's card in apps other than Claude Code (serve.mjs): { reason, target,
// what, verb, hostOnly }, or null when the call needs no OK or is a named click (approvalAsk).
// hostOnly: answered by the person at this computer only, never by a joiner with the approve role
// (those answer final clicks, never who gets in or what the session loses).
const short = (v, n = 120) => String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, n);
export function handoffAsk(tool, input, review = latestReview(), now = Date.now()) {
  const name = String(tool || "").replace(BROWSER_PREFIX, "");
  if (!input || typeof input !== "object" || Array.isArray(input) || approvalAsk(name, input, review, now)) return null;
  const verdict = decide({ tool_name: `mcp__plugin_pairbrowse_browser__${name}`, tool_input: input }, undefined, review, now).hookSpecificOutput;
  if (verdict.permissionDecision !== "ask") return null;
  const [verb, target] =
    name === "browser_navigate" || name === "browser_tabs" ? ["wants to open", short(input.url)]
      : name === "pairbrowse_session" ? ["wants to delete the session", short(input.name)]
        : name === "pairbrowse_invite" && input.action === "create" && input.share === "watch" ? ["wants to make", "a watch link (view only, for whoever has it)"]
        : name === "pairbrowse_invite" && input.action === "create" ? ["wants to invite", `${short(input.label || "someone", 40)} (${input.role === "approve" ? "can drive and approve" : "can drive"})`]
          : name === "pairbrowse_invite" && input.action === "set_role" ? ["wants to let joiners approve", `Invite ${short(input.id, 20)}`]
            : name === "pairbrowse_invite" && input.action === "approve" ? ["wants to let in", `Join request ${short(input.id, 20)}`]
              : name === "browser_file_upload" || name === "browser_drop" ? ["wants to upload", (Array.isArray(input.paths) ? input.paths : []).map((p) => short(p, 200)).join(", ").slice(0, 120)]
                : ["wants to use", name];
  const reason = String(verdict.permissionDecisionReason || "").replace(/^pairbrowse: /, "");
  return { reason, target: target || name, what: `${verb} ${target || name}`.slice(0, 140), verb, hostOnly: true };
}

// The same call, however its keys are ordered: what the browser's card and the call that arrives
// are matched by.
export function approvalKey(tool, input) {
  const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  return JSON.stringify([String(tool || "").replace(BROWSER_PREFIX, ""), canon(input ?? null)]);
}
