// Rules the daemon enforces on every tool call, whatever the hooks or permission mode say.
import { isBrowserPage } from "../../ui/urls.js";
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
  if (BLOCKED_TOOLS.has(n)) return `${n} is disabled by PairBrowse. Use another tool, or ask the user to do this step.`;
  if (n === "browser_evaluate") return "browser_evaluate isn't available in PairBrowse: page scripts can read what was typed, passwords included. Read the page with browser_snapshot or browser_find instead.";
  if (HIDDEN_TOOLS.has(n)) return `${n} isn't available in PairBrowse. Use the tools it offers (browser_snapshot reads the page).`;
  if (n.startsWith("browser_") && !KNOWN_TOOLS.has(n)) return `${n} isn't available in PairBrowse. Use the tools it offers (browser_snapshot reads the page).`;
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
export { BROWSER_PAGE_ORIGINS, isBrowserPage, isBrowserScreenPage, hiddenFromLiveView } from "../../ui/urls.js";
// The Chrome Web Store: extensions install only by the person's own click. Agents may open and read
// it; they never click, type or press keys there (the browser's own install dialog asks the person
// anyway). True for the store's pages, old address and new.
export function isWebStore(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "https:") return false;
    return u.hostname === "chromewebstore.google.com" || (u.hostname === "chrome.google.com" && /^\/webstore(?:\/|$)/.test(u.pathname));
  } catch { return false; }
}
export const WEB_STORE_RULE = "The extension Web Store is the user's: only they install extensions, with their own click (agents read it, never click, type or press keys there). Tell the user which extension to add and let them click Add to PairBrowse themselves.";
// A tab an agent's hands may act in: a web page (or a blank one). The browser's own pages
// (chrome://extensions, flags, history and the rest) and extensions' own pages
// (chrome-extension://) are the person's: there an extension could be loaded, switched on or
// given more, a setting changed.
export const isWebTab = (url) => /^(?:https?:|about:blank(?:[?#]|$))/i.test(String(url ?? "").trim());
export const ERROR_PAGE_RULE = "That tab shows the browser's error page for an address that didn't load. Load it again with browser_navigate (or browser_navigate_back), then act on the page.";
export const NOT_WEB_RULE = "That tab shows one of the browser's own pages or an extension's page, which only the user works in. Open a web page with browser_tabs new (url) or pick a web tab with browser_tabs list and select.";
// The tools that act on a page as a person's hands would: refused on the Web Store.
export const HAND_TOOLS = new Set(["browser_click", "browser_type", "browser_press_key", "browser_fill_form", "browser_select_option", "browser_drag", "browser_drop", "browser_file_upload", "pairbrowse_click_at", "pairbrowse_upload"]);
export const BROWSER_PAGE_RULE = "chrome://pairbrowse pages are the PairBrowse browser's own (its tab strip, docks, session picker, new tab and settings): no agent opens, reads or acts in them.";

export function navigationProblem(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return `Not a valid URL: ${url}. Pass a full address, like https://example.com/.`;
  }
  if (isBrowserPage(u.href)) return `${BROWSER_PAGE_RULE} Open a web page (http or https) instead.`;
  if (u.protocol === "http:" || u.protocol === "https:" || u.href === "about:blank") return null;
  return `pairbrowse only opens web pages (http/https), not ${u.protocol} URLs. Open an http or https address instead.`;
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
// A postal code's "code" ("ZIP code", "Postal code", "Zip/Postal Code", "Post code"): an address,
// not a secret. Only the phrase itself is taken out: "ZIP code or security code" stays sensitive.
const POSTAL_CODE = /\b(?:zip|postal|post)(?:\s*[/-]?\s*(?:zip|postal|post))?[\s_-]*code\b/gi;
// A field sensitive by its label: SENSITIVE (outside a postal code's name), except the
// cardholder's name ("Name on card").
const NAME_ON_CARD = /(\bname\b|\bholder\b)[^]{0,12}\bcard|card ?holder/i;
export const sensitiveLabel = (label) => { const l = String(label ?? "").replace(POSTAL_CODE, " "); return SENSITIVE.test(l) && !NAME_ON_CARD.test(l); };
// Card numbers inside other text ("ref 4242 4242 4242 4242 paid"): masked to their last two digits.
// A run of digit groups ("Order 12 4242 4242 4242 4242"): a card among its groups is masked too,
// only as cards are written (one group of 13 to 19 digits, or 4-4-4-4, 4-6-5, 4-6-4, 4-4-4-4-3),
// so a page list, phone numbers or order numbers in a row stay as they are.
const lastTwo = (s) => `••••${s.replace(/\D/g, "").slice(-2)}`;
const CARD_GROUPS = new Set(["4-4-4-4", "4-6-5", "4-6-4", "4-4-4-4-3"]);
function maskRun(run) {
  if (looksLikeCard(run)) return lastTwo(run);
  const parts = run.match(/\d+|\D+/g);
  const out = [];
  for (let i = 0; i < parts.length;) {
    let hit = -1;
    if (/^\d/.test(parts[i])) {
      for (let j = Math.min(parts.length - 1, i + 8); j >= i && hit < 0; j--) {
        if (!/^\d/.test(parts[j])) continue;
        const groups = parts.slice(i, j + 1).filter((p) => /^\d/.test(p));
        const shape = groups.length === 1 ? groups[0].length >= 13 && groups[0].length <= 19 : CARD_GROUPS.has(groups.map((g) => g.length).join("-"));
        if (shape && looksLikeCard(parts.slice(i, j + 1).join(""))) hit = j;
      }
    }
    if (hit < 0) out.push(parts[i++]);
    else { out.push(lastTwo(parts.slice(i, hit + 1).join(""))); i = hit + 1; }
  }
  return out.join("");
}
export const maskCards = (text) => String(text ?? "").replace(/(?<!\d)(?:\d[ \t\u00a0-]{0,3}){12,}\d(?!\d)/g, maskRun);
// What the activity line shows for a typed value.
export function shownValue(label, value) {
  const s = String(value ?? "");
  if (SECRET_NAME.test(s)) return s; // a saved password's name, not the password
  if (sensitiveLabel(label) || looksLikeCard(s)) return s.length > 4 ? `••••${s.replace(/\s/g, "").slice(-2)}` : "••••";
  return maskCards(s);
}

// ---- what joiners' agents read -----------------------------------------------------------------
// Every text a joiner's agent gets (results, snapshots, find, outlines, errors) shows a card number
// as "••••" and its last two digits, and the value of a field that is sensitive by its kind as
// "••••". The host's own agents read the page as it is. Narrower than SENSITIVE: a promo code, a
// card's title, a gift card or a pin's location read as typed; a postal code and the name on the
// card always do. An expiry or a PIN counts by its label only when the label says it plainly.
const READ_SENSITIVE = /\bcard ?(?:number|no\b|#)|\b(?:credit|debit|payment|bank) ?card\b|\bcc[- ]?(?:num(?:ber)?|exp|csc|cvc|cvv)\b|\bcvc2?\b|\bcvv2?\b|\bcvn\b|\bcsc\b|(?:security|verification|one[- ]time|sms|auth(?:entication)?|access|confirmation|login|2fa|card)[ -]?code|\botp\b|\b2fa\b|one[- ]time (?:code|password|pin)|(?:expiration|expiry|exp\.?) ?date|card expir|valid (?:thru|through)|\bmm\s*\/\s*yy|\bpin ?(?:code|number)\b|^\W*pin\W*$|^\W*digit \d{1,2}\W*$|\bdigit \d{1,2} of \d{1,2}\b|\biban\b|\bssn\b|social security|routing number|account number|pass(?:word|code|phrase)/i;
export const readSensitiveLabel = (label) => { const l = String(label ?? "").replace(POSTAL_CODE, " "); return READ_SENSITIVE.test(l) && !NAME_ON_CARD.test(l); };
// A field's hints (type, autocomplete, inputmode, name, id, aria-label, label, placeholder, in
// that order, space-separated, then "maxlength<N>" when its maxlength is 1 to 8): sensitive by
// its own kind, whatever its label says. "PIN" or "expiry" alone count with a field kind that
// fits (a password, numeric or telephone field). A one-time code's box ("otp", "totp", "code",
// "digit-3", "sms_code") counts when numeric, telephone or short (maxlength 1 to 8); a phone's
// country or area code, a promo or gift code don't.
const OTP_WORD = /(?:^|[^a-z0-9])(?:[th]?otp|code|passcode|pin|digit[-_ ]?\d{1,2}|(?:sms|mfa|2fa|verify|verification|auth|login|security)[-_ ]?code)(?![a-z])/i;
const NOT_OTP = /\b(?:country|area|dial(?:ing)?|calling|phone|currency|language|promo(?:tion(?:al)?)?|coupon|discount|voucher|gift|referral|invite|invitation)[-_ ]?code\b/gi;
export const sensitiveHints = (hints) => {
  const h = String(hints ?? "");
  if (/^password\b/.test(h) || /\bcc-(?!name|given|family|additional)|one-time-code|current-password|new-password/i.test(h) || readSensitiveLabel(h)) return true;
  const plain = h.replace(POSTAL_CODE, " ");
  const numeric = /^(?:tel|number)\b|\bnumeric\b/i.test(h);
  if (numeric && /\bpin\b|\bexpir/i.test(plain)) return true;
  return (numeric || /\bmaxlength[1-8]$/.test(h)) && OTP_WORD.test(plain.replace(NOT_OTP, " "));
};
// A sensitive value as an agent reads it: a card number's last two digits, nothing of the rest.
// Already masked ("••••42"): kept as it is.
export const maskedValue = (value) => (/^••••\d{0,2}$/.test(String(value ?? "")) ? String(value) : looksLikeCard(value) ?`••••${String(value).replace(/\D/g, "").slice(-2)}` : "••••");

// Dropdowns stay as they are (a month or a year on its own), consistently with their options.
const FIELD_LINE = /^(\s*)(- (?:textbox|searchbox|spinbutton)\b(?: "((?:[^"\\]|\\.)*)")?(?: \[[^\]\n]*\])*):(?: (.*))?$/;
const unquote = (s) => { const t = String(s ?? "").trim(); if (/^".*"$/.test(t)) { try { return JSON.parse(t); } catch {} } if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'"); return t; };
const unescapeJs = (s) => String(s).replace(/\\(.)/g, "$1");
// A typing call in Playwright's code ("...getByRole('textbox', { name: 'CVC' }).fill('123')").
const CODE_TYPED = /(\.(?:fill|pressSequentially|type)\()(['"`])((?:\\.|(?!\2)[^\\\n])*)\2/g;

// text as an agent may read it. values: the current values of fields sensitive by their kind in
// the page (pageread.mjs sensitiveValues), found on any field's line or typing call that shows one
// of them, and anywhere in the text when 6 characters or longer; UNKNOWN_VALUES when the page's
// fields couldn't all be read: then every field's value and every typed value is masked. Pure,
// never throws.
export const UNKNOWN_VALUES = "unknown";
export function maskForAgent(text, values = []) {
  let out = String(text ?? "");
  const unknown = values === UNKNOWN_VALUES;
  const known = new Set((Array.isArray(values) ? values : []).map((v) => String(v ?? "").trim()).filter(Boolean));
  for (const v of [...known].sort((a, b) => b.length - a.length)) if (v.length >= 6 && /\d/.test(v)) out = out.split(v).join(maskedValue(v));
  // A saved password shown by its name (secrets.mjs redact) already shows nothing of itself.
  // A page's value on another field: only on an unlabeled one, or when 4 characters or longer (a
  // CVC "123" or a month "12" on a labeled Quantity field is a coincidence).
  const hides = (label, value) => {
    const v = String(value ?? "").trim();
    if (/^<secret>[A-Za-z0-9_]+<\/secret>$/.test(v)) return false;
    return (unknown && v !== "") || readSensitiveLabel(label) || (known.has(v) && (!String(label ?? "").trim() || v.length >= 4));
  };
  // Snapshot lines (browser_snapshot, browser_find, an action's snapshot): a field's value on its
  // own line, or as its "- text:" child (a field with a placeholder).
  const lines = out.split("\n");
  let under = null; // { indent, label } of a field whose children are being read
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.match(/^ */)[0].length;
    if (under && line.trim() && indent <= under.indent) under = null;
    const f = FIELD_LINE.exec(line);
    if (f) {
      const label = f[3] ? unquote(`"${f[3]}"`) : "";
      if (f[4] !== undefined && f[4].trim()) { if (hides(label, unquote(f[4]))) lines[i] = `${f[1]}${f[2]}: ${maskedValue(unquote(f[4]))}`; }
      else under = { indent, label };
      continue;
    }
    if (under) {
      const t = /^(\s*- text: )(.*)$/.exec(line);
      if (t && indent === under.indent + 2 && hides(under.label, unquote(t[2]))) lines[i] = `${t[1]}${maskedValue(unquote(t[2]))}`;
    }
    // pairbrowse_run's outline: "Fields: Card number [tel] = 4242...; Name [text] = Ada".
    if (/^Fields: /.test(line)) lines[i] = line.replace(/(^Fields: |; )([^;[\n]*?) \[([^\]\n]*)\] = ([^;\n]*)/g, (m, sep, label, kind, value) => (hides(label, value) && !value.startsWith("••••") ?`${sep}${label} [${kind}] = ${maskedValue(value)}` : m));
  }
  out = lines.join("\n");
  // Playwright's code for a typing call: masked by the field it names (the quoted parts of its
  // locator after the last frame: a role's name, a label, "#cvc"), or by the value.
  out = out.replace(CODE_TYPED, (m, call, q, raw, at, whole) => {
    const lineStart = whole.lastIndexOf("\n", at) + 1;
    const before = whole.slice(lineStart, at);
    const own = before.slice(before.lastIndexOf("contentFrame()") + 1);
    const value = unescapeJs(raw);
    const names = [...own.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((x) => unescapeJs(x[2])).filter((s) => !/^(?:textbox|searchbox|spinbutton|combobox|iframe)$/.test(s)).join(" ");
    return hides(names, value) ? `${call}${q}${maskedValue(value)}${q}` : m;
  });
  return maskCards(out);
}
