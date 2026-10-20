// The rules every tool call passes first: which tab it may act in (never the browser's own pages,
// never a person's own tab), its arguments, the PairBrowse safety rules (guard.mjs), approvals
// given in the browser, and the browser tools' own checks (web pages only, passwords only on their
// sites, no final action pressed under a milder name). Each returns a refusal's text, or null.
import { isBrowserPage, BROWSER_PAGE_RULE, HAND_TOOLS, isWebStore, WEB_STORE_RULE, isWebTab, NOT_WEB_RULE, ERROR_PAGE_RULE, toolRefused, isRef, looksLikeSecretName, navigationProblem, secretNamesIn } from "../../rules/policy.mjs";
import { isUntouchedStart } from "../../tabs.mjs";
import { PERSON_TAB_RULE } from "../output.mjs";
import { BROWSER_GUARDED, REMOTE_TOOLS } from "./wire.mjs";
import { STATUS_KINDS } from "../../../ui/vocab.js";
import { clickRule, dialogRule, strongSignal } from "../../rules/clicks.mjs";
import { APPROVAL_TOOLS, approvalAsk, decide } from "../../rules/decide.mjs";
import { clickClass } from "../../rules/clicks.mjs";
import { activatingKey, contextAt, enterButtonLabel, riskAt, riskReason } from "../../runner.mjs";
import { hostAllowed } from "../../rules/secrets.mjs";
import { pathsIn } from "../../upload.mjs";
import { within } from "../../util.mjs";
import { originOf, sameWhere } from "../approvals.mjs";
import { realLabel } from "./pageread.mjs";
import { resolve as resolvePath, sep as pathSep } from "node:path";

// Whether a tool call may go on in the tab it would act in. here: the tab the call acts in (or
// null); pages: the open tabs, for browser_tabs select or close by index; personTab(page): a
// person's own tab (a file they opened from Downloads; any file: tab counts). Returns the refusal's
// text, or null. Pure. The browser's own pages (chrome://pairbrowse) and the person's tabs are
// never a tab an agent acts in, selects or closes.
// The address a pairbrowse_run's first step goes to ({"go": url} given inline), or null.
const firstGo = (name, args) => (name === "pairbrowse_run" && Array.isArray(args?.steps) && typeof args.steps[0]?.go === "string" ? args.steps[0].go : null);
// The address of a web tab a pairbrowse_run opens for itself, or null: a run starting with go,
// asked while the agent's tab is one of the browser's own pages other than an untouched new tab
// page (that one it leaves in place, tabRefusal). Pure. The page itself is left as it is.
export function runOpensTab(name, args, here) {
  const url = firstGo(name, args);
  return url && here && isBrowserPage(here.url()) && !isUntouchedStart(here.url()) ? url : null;
}
export const isFileTab = (page) => { try { return /^file:/i.test(String(page?.url?.() ?? "")); } catch { return false; } };
export function tabRefusal(name, args = {}, { here = null, pages = [], personTab = () => false } = {}) {
  const person = (page) => !!page && (!!personTab(page) || isFileTab(page));
  if ((name.startsWith("browser_") && name !== "browser_tabs" && name !== "browser_close") || BROWSER_GUARDED.has(name)) {
    // The one exception: browser_navigate may take an untouched new tab page (the start tab, a fresh
    // Cmd+T) to a web page, as it took the about:blank start tab before the build had its own new
    // tab page (plans/555 Risk 1); nothing reads or acts in the page itself, and navigationProblem
    // still refuses every browser page as a target.
    // pairbrowse_run whose first step is go leaves it the same way.
    const leavingNewTab = (name === "browser_navigate" || !!firstGo(name, args)) && here && isUntouchedStart(here.url());
    if (here && isBrowserPage(here.url()) && !leavingNewTab) return `${BROWSER_PAGE_RULE} Open a web page with browser_tabs new (url) or pick another tab with browser_tabs list and select.`;
    if (person(here)) return `${PERSON_TAB_RULE} Open a web page with browser_tabs new (url) or pick another tab with browser_tabs list and select.`;
    if (here && (HAND_TOOLS.has(name) || (name === "pairbrowse_run" && !firstGo(name, args))) && !isWebTab(here.url())) return /^chrome-error:/i.test(here.url()) ? ERROR_PAGE_RULE : NOT_WEB_RULE;
    if (here && HAND_TOOLS.has(name) && isWebStore(here.url())) return WEB_STORE_RULE;
  }
  if (name === "browser_tabs" && (args.action === "select" || args.action === "close") && args.index !== undefined) {
    const page = pages[Number(args.index)];
    if (page && isBrowserPage(page.url())) return `Tab ${args.index} is the browser's own page. ${BROWSER_PAGE_RULE} Use browser_tabs list.`;
    if (person(page)) return `Tab ${args.index} is the person's own tab (a downloaded file they opened). ${PERSON_TAB_RULE} Use browser_tabs list.`;
  }
  return null;
}

export function createRefusals(conn, api) {
  const { cap, clickApprovals, context, handOff, inUse, log, popups, secretNames, secrets, serverPage, serverUrl } = api;
  const { approvedArgs, approvedWhere, recentRisk, refNames, remote, risks } = conn;

  // The PairBrowse rules every call passes first. Returns a refusal, or null.
  // Arguments the browser server would answer with a raw parser error: said plainly instead.
  function argProblem(name, args) {
    const needs = { browser_click: ["target"], browser_type: ["target"], browser_hover: ["target"], browser_select_option: ["target"], browser_drag: ["startTarget", "endTarget"], browser_drop: ["target"] }[name] || [];
    for (const k of needs) {
      if (typeof args[k] !== "string" || !args[k].trim()) return `${name} needs ${k}: pass a ref from a browser_snapshot (like e12), or a selector.`;
      if (args[k].length > 2000) return `${name}: ${k} is far too long for a ref or a selector. Take a browser_snapshot and pass a ref from it.`;
    }
    if (name === "browser_fill_form") {
      if (!Array.isArray(args.fields) || !args.fields.length) return "browser_fill_form needs fields: a list of { name, type, target, value }.";
      if (args.fields.some((f) => !f || typeof f !== "object" || typeof f.target !== "string" || !f.target.trim())) return "browser_fill_form: give every field a target, a ref from a browser_snapshot (like e12).";
    }
    if ((name === "browser_file_upload" || name === "browser_drop") && args.paths !== undefined && !(Array.isArray(args.paths) && args.paths.every((x) => typeof x === "string"))) return `${name}: pass paths as a list of file paths (text), or [] to close an open file chooser.`;
    if (name === "browser_select_option" && !(Array.isArray(args.values) && args.values.length && args.values.every((x) => typeof x === "string"))) return "browser_select_option needs values: pass a list of the option texts (or values) to choose.";
    if (name === "browser_tabs" && ["select", "close"].includes(args.action) && args.index !== undefined && !(Number.isInteger(Number(args.index)) && Number(args.index) >= 0)) return "browser_tabs: pass index as a tab's number from browser_tabs list (0 is the first).";
    if (name === "pairbrowse_upload" && !(Array.isArray(args.files) && args.files.length && args.files.every((x) => typeof x === "string"))) return "pairbrowse_upload needs files: pass a list of absolute paths.";
    if (name === "pairbrowse_facts" && args.action === "forget" && !(Array.isArray(args.labels) && args.labels.every((x) => typeof x === "string"))) return "pairbrowse_facts forget needs labels: pass a list of the details' labels.";
    if (name === "pairbrowse_status") {
      if (!STATUS_KINDS.includes(args.kind)) return 'pairbrowse_status: set kind to "agent" (working; "claude" is the same), "you", "done" or "clear".';
      if (args.text !== undefined && (typeof args.text !== "string" || args.text.length > 140)) return "pairbrowse_status: text is up to 140 characters; shorten it.";
    }
    if (name === "browser_wait_for") {
      if (args.time !== undefined && !(Number.isFinite(Number(args.time)) && Number(args.time) >= 0 && Number(args.time) <= 120)) return "browser_wait_for: time is 0 to 120 seconds; pass a time in that range.";
      if (args.text === undefined && args.textGone === undefined && args.time === undefined) return "browser_wait_for: pass time (seconds), text (to appear) or textGone (to disappear).";
    }
    return null;
  }

  function refusal(name, args) {
    // Blocked, hidden or unknown browser tools: refused here, not only by the hook, so no
    // permission mode (bypass included) and no app without hooks reaches them.
    const off = toolRefused(name);
    if (off) return off;
    if (remote) {
      if (!name.startsWith("browser_") && !REMOTE_TOOLS.has(name)) return `${name} isn't available to a joiner's agent. Use the browser_ tools, which work in the host's tabs.`;
      if (secretNamesIn(name, args, secretNames()).length) return "The host's saved passwords stay with the host. Ask the host to sign in, or use your own details.";
      const outside = pathsIn(name, args).find((p) => !resolvePath(p).startsWith(resolvePath(remote.files) + pathSep));
      if (outside) return "Files for an upload come from your own computer (your PairBrowse sends them over); this computer's files aren't yours to send. Pass paths of files on your own computer.";
    }
    // The PairBrowse safety rules (guard.mjs), here as well as in the hook: what they block stays
    // blocked for every app, even with hooks off or the server added without the plugin. Claude
    // Code's hook asks you about the rest; other apps (Codex, any MCP client) can't be relied on
    // to ask, so what needs your OK is handed to you to do yourself in the PairBrowse window.
    const verdict = decide({ tool_name: `mcp__plugin_pairbrowse_browser__${name}`, tool_input: args }).hookSpecificOutput;
    const reason = verdict.permissionDecisionReason?.replace(/\.?$/, ".");
    if (verdict.permissionDecision === "deny") return verdict.permissionDecisionReason;
    if (verdict.permissionDecision === "ask" && conn.clientName !== "claude-code" && !approvedArgs.has(args)) {
      log(`handed to the user (${conn.clientName || "unknown app"}): ${name}`);
      return handOff(reason);
    }
    // (Claude Code's answer from the browser is checked once the call's tab is known: approvalProblem.)
    // While the session picker is up nobody has tabs to lose: an agent may choose for everyone.
    if ((name === "browser_close" || (name === "pairbrowse_session" && args.action !== "list")) && !context.picking() && inUse().length) {
      const who = inUse();
      return `${who.length === 1 ? "Another session is" : `${who.length} other sessions are`} using the browser (${who.join(", ")}): ` +
        `${name === "browser_close" ? "closing it" : "switching sessions"} would close their tabs. Wait until they're done (idle 10 minutes), ` +
        "or ask the person to switch with \"End session\" in the PairBrowse side panel (the right dock in the browser).";
    }
    return null;
  }

  // A named final action allowed in the browser holds only in the tab it was asked in, still on
  // the same origin (approvals.mjs sameWhere): a navigation or another tab in between (another
  // agent, a joiner, the page itself) makes it another click, asked again; the element's own
  // risk is judged again as it is clicked (browserToolProblem). Claude Code: the same ask
  // answered Deny in the browser (its hook passed that on, so this call came some other way) is
  // refused; a call that arrives while the browser still asks is the terminal's yes, and takes
  // the card down there.
  async function approvalProblem(name, args) {
    if (!clickApprovals || !APPROVAL_TOOLS.has(name)) return null;
    const ask = approvalAsk(name, args);
    if (!ask) return null;
    if (conn.clientName !== "claude-code" && !approvedWhere.has(args)) return null;
    const page = await within(3000, serverPage().catch(() => null));
    const here = { page, url: page && !page.isClosed() ? page.url() : "" };
    const moved = (where) => `Not done: the user allowed this in the PairBrowse browser for ${where?.origin || "another page"}, but the tab has changed since (it is now on ${originOf(here.url) || "another page"}). ` +
      "Take a browser_snapshot, check this is still the right step, and call again: the user is asked again.";
    if (conn.clientName === "claude-code") {
      const r = clickApprovals.arrived(name, args, here);
      if (r === "denied") return `Denied in the PairBrowse browser: ${ask.reason.replace(/\.$/, "")}. Nothing was done; ask the user what to do.`;
      if (r === "moved") { log(`approval: refused ${name}: the tab changed after the browser's Allow`); return moved(clickApprovals.lastWhere?.()); }
      return null;
    }
    const where = approvedWhere.get(args);
    approvedWhere.delete(args);
    if (sameWhere(where, here)) return null;
    approvedArgs.delete(args);
    log(`approval: refused ${name}: the tab changed after the browser's Allow`);
    return moved(where);
  }

  // The button Enter or Space would press (activatingKey), in the tab Claude worked in last.
  async function keyWouldPress(target, kind) {
    const page = await context.pageAt(context.currentUrl());
    return page ? enterButtonLabel(page, target, kind) : "";
  }

  // Checks for the browser tools, which go on to Playwright MCP: web pages only, passwords only
  // on their sites, and no final action pressed under a milder name. Returns a refusal, or null.
  async function browserToolProblem(name, args) {
    if (name === "browser_navigate" || (name === "browser_tabs" && args.url)) {
      const problem = navigationProblem(args.url);
      if (problem) return problem;
    }
    const { domains, problem } = secrets.get();
    const used = secretNamesIn(name, args, secretNames());
    if (used.length) {
      const url = await serverUrl();
      const wrong = used.find((s) => !url || !hostAllowed(url, domains[s]));
      if (wrong) {
        log(`refused ${wrong} on ${url}`);
        return `Refused: ${wrong} may only be typed on HTTPS pages of ${domains[wrong].join(", ") || "(no domains set)"}, ` +
          `and the current page is ${url || "unknown"}. Hand this field to the user. If the site is right, the user can add it in the Profile panel.`;
      }
      // A field inside a frame: the frame's own address must allow the secret too (a sign-in
      // frame from elsewhere on an allowed page), as fast mode checks (runner.mjs).
      const inFrames = (name === "browser_type" ? [[args.target, used[0]]] : (args.fields || []).map((f) => [f.target, f.value]))
        .filter(([t, v]) => /^f\d+e\d+$/.test(String(t || "")) && used.includes(v));
      if (inFrames.length) {
        const page = await serverPage();
        for (const [target, s] of inFrames) {
          const where = page ? await within(1500, page.locator(`aria-ref=${target}`).evaluate((n) => n.ownerDocument.location.href)).catch(() => null) : null;
          if (!where || !hostAllowed(where, domains[s])) {
            log(`refused ${s} in a frame at ${where || "an unreadable address"} on ${url}`);
            return `Refused: ${s} may only be typed on HTTPS pages of ${domains[s].join(", ") || "(no domains set)"}, ` +
              `and this field sits in a frame from ${where || "an address that couldn't be read"}. Hand this field to the user.`;
          }
        }
      }
    }
    if (problem && looksLikeSecretName(name, args)) return problem;
    // Keys press buttons too: Enter in a field submits its form, Enter or Space on a focused
    // button or link presses it, and typed text with a line break presses Enter. Judged by what
    // pressing it does (daemon/page.mjs clickRisk), never by what its button says.
    const key = name === "browser_press_key" ? activatingKey(args.key)
      : name === "browser_type" && (args.submit || /[\r\n]/.test(String(args.text || ""))) ? "enter" : "";
    if (key) {
      const page = await context.pageAt(context.currentUrl());
      const target = name === "browser_type" ? args.target : null;
      const risk = page ? await riskAt(page, target, key, recentRisk(page)) : null;
      // Only strong signals stop a key: an ordinary submit goes, as a click on it would.
      if (risk && strongSignal(risk)) {
        const label = await keyWouldPress(target, key);
        return `Refused: ${key === "space" ? "Space" : "Enter"} here would ${label ? `press "${label.slice(0, 60)}" and ` : ""}commit something (${riskReason(risk)}). ` +
          `Type without submit (and without line breaks), then use browser_click on its button, with "${cap(risk.word)}:" at the start of element, so the user confirms.`;
      }
    }
    // OK on a page's confirm or prompt dialog: right after a delete or payment click it's that same
    // final action, refused until named; any other OK follows the agent's label (a class asks).
    // The agent opening an address starts afresh: a delete before it confirms nothing there.
    if (name === "browser_navigate") { const page = await serverPage(); if (page) risks.set(page, null); }
    if (name === "browser_handle_dialog") {
      const page = await serverPage();
      const prev = recentRisk(page);
      if (dialogRule(!!args.accept, prev, args.element) === "name") return `Refused: OK here confirms the ${prev} click before it, a final action. Retry with element "${cap(prev)}: OK" so the user confirms it.`;
      popups.dialogAnswered(page);
    }
    // A click, judged by what it does (the page's structure, never its words; daemon/page.mjs
    // clickRisk) and then by scripts/rules/clicks.mjs: a final action by strong signals is refused
    // until element names its class; everything else goes, and the hook asks about any class
    // the agent named from its task.
    if (name === "browser_click") {
      const page = await serverPage();
      const text = await realLabel(page, args.target);
      if (text === undefined) return `target "${String(args.target).slice(0, 60)}" isn't a ref (like e12) or a selector Playwright reads. Take a browser_snapshot and use a ref from it.`;
      if (text === null) return isRef(args.target) ? `Ref ${refNames.plainOf(args.target).slice(0, 60)} isn't on the page any more. Take a browser_snapshot and use its fresh refs.` : `Nothing on the page matches "${String(args.target).slice(0, 60)}". Take a browser_snapshot and use a ref from it.`;
      const risk = page ? (await contextAt(page, args.target, "click", recentRisk(page))).risk : { level: "safe", word: "", why: [] };
      // Gone while it was read (a banner closed meanwhile): said as such, never clicked.
      if (risk.unreadable && (await realLabel(page, args.target)) === null) return `Ref ${refNames.plainOf(args.target).slice(0, 60)} isn't on the page any more. Take a browser_snapshot and use its fresh refs.`;
      if (clickRule(risk, args.element) === "name") {
        log(`refused click (${risk.word}: ${risk.why.join(", ")}) described as "${String(args.element || "").slice(0, 80)}"`);
        return `Refused: this click is a final action, whatever its label ("${String(text).slice(0, 60)}"): ${riskReason(risk)}. ` +
          `Retry with "${cap(risk.word)}:" at the start of element (e.g. "${cap(risk.word)}: ${String(text || "button").slice(0, 40)}"), so the user confirms it.`;
      }
      // Remembered a minute: the "OK" in the popup a delete click opens is still a delete.
      const cls = clickClass(args.element);
      const kind = ["pay", "delete"].includes(cls) ? cls : ["pay", "delete"].includes(risk.word) ? risk.word : "";
      if (page) risks.set(page, kind ? { kind, t: Date.now() } : null);
    }
    return null;
  }

  return { argProblem, refusal, approvalProblem, keyWouldPress, browserToolProblem };
}
