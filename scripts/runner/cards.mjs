// The page reads behind the card rules (scripts/rules/cards.mjs): whether a field an agent would
// type into, choose in or paste into is a card field. Used by the browser tools' checks
// (daemon/serve/refuse.mjs) and fast mode's steps. Every read is bounded; a field whose page
// doesn't answer in time reads as no card field (the typed value is still checked). tokens: the
// autocomplete tokens that count (CARD_TOKENS; a saved-card session's key rule passes
// AUTOFILL_TOKENS). focusedFillField and focusedCardForm: the saved card's own reads (B12).
import { within } from "../util.mjs";
import { isRef } from "../rules/policy.mjs";
import { CARD_TOKENS, AUTOFILL_TOKENS, CARD_NAME, SIGNALS } from "../rules/cards.mjs";
import { focusedFrame } from "./risk.mjs";

const READ_MS = 1500;

// In the page, on the field: its card token, and for a field in a frame whether that frame holds
// card fields and its origin. A label stands for its control.
function scan(n, tokens) {
  const tok = (el) => String(el?.getAttribute?.("autocomplete") || "").toLowerCase().split(/\s+/).find((t) => tokens.includes(t)) || "";
  const el = n?.tagName === "LABEL" && n.control ? n.control : n;
  const doc = el?.ownerDocument || document;
  let top;
  try { top = doc.defaultView === doc.defaultView.top; } catch { top = false; }
  let frameCard = false;
  if (!top) {
    const fields = doc.querySelectorAll("input, select, textarea");
    for (let i = 0; i < fields.length && i < 400 && !frameCard; i++) frameCard = !!tok(fields[i]);
  }
  return { token: tok(el), top, frameCard, origin: String(doc.location?.origin || "") };
}

const originOf = (url) => { try { return new URL(url).origin; } catch { return ""; } };

// The card signal of a field (an element handle or a locator), or "". pageUrl: the tab's own
// address (a payment frame counts only from another site than the page).
export async function cardFieldOf(field, pageUrl, tokens = CARD_TOKENS) {
  if (!field) return "";
  const r = await within(READ_MS, Promise.resolve().then(() => field.evaluate(scan, tokens)).catch(() => null));
  if (!r) return "";
  if (r.token) return SIGNALS.token(r.token);
  if (r.top) return "";
  if (r.frameCard) return SIGNALS.cardFrame;
  if (r.origin && r.origin === originOf(pageUrl)) return "";
  // A frame from another site: the page's own allow="payment" on it.
  const handle = typeof field.elementHandle === "function" ? await within(READ_MS, field.elementHandle({ timeout: 1000 }).catch(() => null)) : field;
  const frame = handle ? await within(READ_MS, Promise.resolve().then(() => handle.ownerFrame()).catch(() => null)) : null;
  const box = frame ? await within(READ_MS, Promise.resolve().then(() => frame.frameElement()).catch(() => null)) : null;
  const allow = box ? await within(READ_MS, Promise.resolve().then(() => box.getAttribute("allow")).catch(() => null)) : null;
  for (const h of [box, handle !== field ? handle : null]) h?.dispose?.().catch(() => {});
  return /(?:^|[\s;])payment(?:[\s;]|$)/i.test(String(allow ?? "")) ? SIGNALS.payFrame : "";
}

// The card signal of an agent's target in page (a ref from a snapshot, or a selector), or "".
export async function cardFieldAt(page, target) {
  if (!page || typeof target !== "string" || !target.trim()) return "";
  let loc;
  try { loc = page.locator(isRef(target) ? `aria-ref=${target}` : target).first(); } catch { return ""; }
  return cardFieldOf(loc, page.url());
}

// The element that has the focus in page (in whichever frame), as a handle the caller disposes, or null.
export async function focusedHandle(page) {
  if (!page) return null;
  const frame = await focusedFrame(page);
  if (!frame || typeof frame.evaluateHandle !== "function") return null;
  const h = await within(READ_MS, Promise.resolve().then(() => frame.evaluateHandle(() => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el && el !== document.body ? el : null;
  })).catch(() => null));
  const el = h?.asElement?.() || null;
  if (!el) h?.dispose?.().catch(() => {});
  return el;
}

// The card signal of the field that has the focus in page (in whichever frame), or "".
export async function focusedCardField(page, { tokens = CARD_TOKENS } = {}) {
  const el = await focusedHandle(page);
  if (!el) return "";
  try { return await cardFieldOf(el, page.url(), tokens); } finally { el.dispose?.().catch(() => {}); }
}

// Text fields: an <input> whose type takes typed text (no type is text).
const NOT_TEXT = /^(?:hidden|checkbox|radio|button|submit|reset|image|file|range|color)$/i;

// In the page, on the focused field, for "Fill saved card": whether it is the card number
// (autocomplete cc-number), holds nothing, is its document's first text field, and whether another
// field there is the card number.
function fillScan(n, notText) {
  const el = n?.tagName === "LABEL" && n.control ? n.control : n;
  const doc = el?.ownerDocument || document;
  const tokens = (x) => String(x?.getAttribute?.("autocomplete") || "").toLowerCase().split(/\s+/);
  const text = (x) => x?.tagName === "INPUT" && !new RegExp(notText).test(String(x.getAttribute?.("type") || ""));
  const fields = [...doc.querySelectorAll("input")].slice(0, 400);
  return {
    number: tokens(el).includes("cc-number"),
    empty: text(el) && typeof el.value === "string" && el.value === "",
    first: fields.find(text) === el,
    numberElsewhere: fields.some((f) => f !== el && tokens(f).includes("cc-number")),
  };
}

// The focused field as "Fill saved card" (liveview/grants.mjs) needs it: { signal (cardFieldOf with
// every autofill token), number, empty, first, numberElsewhere } (fillScan), or null when nothing
// has the focus or the page doesn't answer in time.
export async function focusedFillField(page) {
  const el = await focusedHandle(page);
  if (!el) return null;
  try {
    const r = await within(READ_MS, Promise.resolve().then(() => el.evaluate(fillScan, NOT_TEXT.source)).catch(() => null));
    if (!r) return null;
    return { ...r, signal: await cardFieldOf(el, page.url(), AUTOFILL_TOKENS) };
  } finally { el.dispose?.().catch(() => {}); }
}

// In the page, on the focused field: whether it is a text field of a document one of whose fields
// names a card (CARD_NAME) by its name, id, placeholder, aria-label or label.
function formScan(n, { notText, name }) {
  const el = n?.tagName === "LABEL" && n.control ? n.control : n;
  if (el?.tagName !== "INPUT" || new RegExp(notText).test(String(el.getAttribute?.("type") || ""))) return false;
  const re = new RegExp(name, "i");
  const fields = (el.ownerDocument || document).querySelectorAll("input, select");
  const said = (f) => [f.getAttribute?.("name"), f.getAttribute?.("id"), f.getAttribute?.("placeholder"), f.getAttribute?.("aria-label"), f.labels?.[0]?.textContent].filter(Boolean).join(" ");
  for (let i = 0; i < fields.length && i < 400; i++) if (re.test(said(fields[i]))) return true;
  return false;
}

// SIGNALS.cardForm when the focused field in page is a text field of a form whose fields name a
// card without a cc-* token (a saved-card session's list-key rule, rules/cards.mjs), else "".
export async function focusedCardForm(page) {
  const el = await focusedHandle(page);
  if (!el) return "";
  try {
    const r = await within(READ_MS, Promise.resolve().then(() => el.evaluate(formScan, { notText: NOT_TEXT.source, name: CARD_NAME })).catch(() => null));
    return r === true ? SIGNALS.cardForm : "";
  } finally { el.dispose?.().catch(() => {}); }
}
