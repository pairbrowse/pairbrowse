// Rules the daemon enforces on every tool call, whatever the hooks or permission mode say.
import { isChromePage } from "../../ui/urls.js";
import { toolsWith, CATALOG } from "../tools/catalog.mjs";

// run_code_unsafe runs arbitrary code in the helper. The webmcp tools let web pages register
// their own tools for Claude to call, which hands a hostile page a direct line to Claude. The
// tool catalog (tools/catalog.mjs) marks them blocked.
export const BLOCKED_TOOLS = toolsWith("blocked");

// Not offered to Claude, to keep every request small: debugging and layout tools that form work
// doesn't need. Screenshots too: Claude reads the page structure, and you watch the live view.
export const HIDDEN_TOOLS = toolsWith("hidden");

// Whether the browser server refuses a tool outright, whatever the hooks or permission mode say
// (bypass included): a reason, or "". Blocked tools, hidden ones (not offered, so never Claude's to
// call: browser_evaluate runs a script in the page, which can read what was typed, passwords
// included; browser_take_screenshot would skip the password check on pictures), and any browser_
// tool the catalog doesn't know (a newer runtime's, never reviewed).
const KNOWN_TOOLS = new Set(Object.keys(CATALOG));
export function toolRefused(name) {
  const n = String(name ?? "");
  if (BLOCKED_TOOLS.has(n)) return `${n} is disabled by PairBrowse.`;
  if (n === "browser_evaluate") return "browser_evaluate isn't available in PairBrowse: page scripts can read what was typed, passwords included. Read the page with browser_snapshot or browser_find instead.";
  if (HIDDEN_TOOLS.has(n)) return `${n} isn't available in PairBrowse. Use the tools it offers (browser_snapshot reads the page).`;
  if (n.startsWith("browser_") && !KNOWN_TOOLS.has(n)) return `${n} isn't available in PairBrowse.`;
  return "";
}

// PairBrowse's own tools: their definitions live in the catalog.
export { STATUS_TOOL, LIVEVIEW_TOOL, RECORD_TOOL, INVITE_TOOL, JOIN_TOOL } from "../tools/catalog.mjs";

// Drops sections Claude doesn't need from tool results: the open-tabs list (except from
// browser_tabs itself) and console/event notices. Keeps results to a few hundred tokens.
export function trimResult(tool, text) {
  const sections = String(text).split(/(?=^### )/m);
  // browser_tabs list answers with the tabs in its Result; the open-tabs section the browser server
  // adds when another agent changed the tabs meanwhile would list them all a second time.
  const listed = tool === "browser_tabs" && sections.some((sec) => sec.startsWith("### Result") && /^- \d+: /m.test(sec));
  return sections
    .filter((sec) => {
      if (sec.startsWith("### Open tabs")) return tool === "browser_tabs" && !listed;
      if (sec.startsWith("### Events")) return false;
      return true;
    })
    .join("")
    .replace(/^- Console: .*\n?/gm, "")
    // Ad and tracking links run to thousands of characters; the start says where they go.
    .replace(/^(\s*- \/url: "?)([^\n]{160})[^\n]{40,}$/gm, "$1$2…");
}

// Snapshot refs ("e42", "f1e7" in a frame), as opposed to CSS selectors or visible text.
export const isRef = (value) => /^(f\d+)?e\d+$/.test(String(value ?? ""));

// The browser tools' names in hooks: Claude Code's mcp__plugin_pairbrowse_browser__<tool>, Codex's
// (servers named in .codex-plugin/mcp.json) mcp__pairbrowse_browser__<tool>.
export const BROWSER_PREFIX = /^mcp__(plugin_pairbrowse_browser|pairbrowse_browser)__/;

// A saved password's NAME (SHOPIFY_PASSWORD), which Claude types in place of the password.
const SECRET_NAME = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;

const typedValues = (tool, args) =>
  tool === "browser_fill_form" ? (args.fields || []).map((f) => f.value) : tool === "browser_type" ? [args.text] : [];

export function secretNamesIn(tool, args, names) {
  return typedValues(tool, args).filter((v) => names.includes(v));
}

// SOME_SECRET style values, used when secrets are disabled to explain why instead of typing the name.
export function looksLikeSecretName(tool, args) {
  return typedValues(tool, args).some((v) => SECRET_NAME.test(String(v ?? "")));
}

// The PairBrowse browser's own pages (a native build's tab strip, docks, session picker, new tab
// and settings): never an agent's to open, read or act in. Their addresses and the rules about
// them live in ui/urls.js (one copy for the helper and the pages).
export { CHROME_PAGE_ORIGINS, isChromePage, isChromeScreenPage, hiddenFromLiveView } from "../../ui/urls.js";
export const CHROME_PAGE_RULE = "chrome://pairbrowse pages are the PairBrowse browser's own (its tab strip, docks, session picker, new tab and settings): no agent opens, reads or acts in them.";

export function navigationProblem(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return `Not a valid URL: ${url}`;
  }
  if (isChromePage(u.href)) return CHROME_PAGE_RULE;
  if (u.protocol === "http:" || u.protocol === "https:" || u.href === "about:blank") return null;
  return `pairbrowse only opens web pages (http/https), not ${u.protocol} URLs.`;
}

// Fields whose values never show in the activity line, the bottom bar or the run log, and are
// never remembered: by their label, or because the value is a card number.
export const SENSITIVE = /pass(word|code|phrase)?|\bpin\b|otp|one[- ]time|verification|security code|\bcode\b|token|secret|cvv|cvc|card|expir|iban|account number|routing|ssn|social security|passport|tax id/i;
export function looksLikeCard(value) {
  const digits = String(value ?? "").replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
// A field sensitive by its label: SENSITIVE, except the cardholder's name ("Name on card").
export const sensitiveLabel = (label) => { const l = String(label ?? ""); return SENSITIVE.test(l) && !/(\bname\b|\bholder\b)[^]{0,12}\bcard|card ?holder/i.test(l); };
// Card numbers inside other text ("ref 4242 4242 4242 4242 paid"): masked to their last two digits.
export const maskCards = (text) => String(text ?? "").replace(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g, (m) => (looksLikeCard(m) ? `••••${m.replace(/[\s-]/g, "").slice(-2)}` : m));
// What the activity line shows for a typed value.
export function shownValue(label, value) {
  const s = String(value ?? "");
  if (SECRET_NAME.test(s)) return s; // a saved password's name, not the password
  if (sensitiveLabel(label) || looksLikeCard(s)) return s.length > 4 ? `••••${s.replace(/\s/g, "").slice(-2)}` : "••••";
  return maskCards(s);
}
