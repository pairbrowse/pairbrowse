// The page reads behind the card rules (scripts/rules/cards.mjs): whether a field an agent would
// type into, choose in or paste into is a card field. Used by the browser tools' checks
// (daemon/serve/refuse.mjs) and fast mode's steps. Every read is bounded; a field whose page
// doesn't answer in time reads as no card field (the typed value is still checked).
import { within } from "../util.mjs";
import { isRef } from "../rules/policy.mjs";
import { CARD_TOKENS, SIGNALS } from "../rules/cards.mjs";
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
export async function cardFieldOf(field, pageUrl) {
  if (!field) return "";
  const r = await within(READ_MS, Promise.resolve().then(() => field.evaluate(scan, CARD_TOKENS)).catch(() => null));
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

// The card signal of the field that has the focus in page (in whichever frame), or "".
export async function focusedCardField(page) {
  if (!page) return "";
  const frame = await focusedFrame(page);
  if (!frame || typeof frame.evaluateHandle !== "function") return "";
  const h = await within(READ_MS, Promise.resolve().then(() => frame.evaluateHandle(() => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el && el !== document.body ? el : null;
  })).catch(() => null));
  const el = h?.asElement?.() || null;
  if (!el) { h?.dispose?.().catch(() => {}); return ""; }
  try { return await cardFieldOf(el, page.url()); } finally { el.dispose?.().catch(() => {}); }
}
