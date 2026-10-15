// Fast mode's click risk: what a click or an Enter press would commit, read from the page's
// structure where it lands (daemon/page.mjs clickContext and clickRisk), never its words.
import { isRef } from "../rules/policy.mjs";
import { within } from "../util.mjs";
import { withHelpers, buttonLabel, clickRisk, clickContext } from "../daemon/page.mjs";

// Keys that press a button: Enter (with or without modifiers: Shift+Enter submits a form too)
// in a field or on a button or link, and Space on a focused button. Returns "enter", "space" or "".
export function activatingKey(key) {
  const last = String(key || "").split("+").pop();
  if (/^(Enter|NumpadEnter)$/i.test(last)) return "enter";
  if (/^(Space|Spacebar| )$/i.test(last) || String(key) === " ") return "space";
  return "";
}

// The label of the button a key press (activatingKey) would press: the focused button or link
// itself, or for Enter in a field, the form's default submit button. "" when it presses none.
// Called in the page as (element, kind) on a target, or as (kind) for the focused element.
const pressedButton = withHelpers((a, b) => {
  const kind = typeof a === "string" ? a : b;
  let el = (typeof a === "string" ? null : a) || document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el.isContentEditable) return "";
  if (el.matches?.('button, input[type="submit"], input[type="button"], input[type="image"], [role="button"], a[href], [role="link"]')) return buttonLabel(el);
  if (kind !== "enter" || el.tagName === "TEXTAREA") return "";
  const button = (el.form || el.closest?.("form"))?.querySelector('button:not([type]), button[type="submit"], input[type="submit"]');
  return button ? buttonLabel(button) : "";
}, buttonLabel);

// Whether a frame on the page (a payment provider's card field lives in its own, cross-origin
// frame the page's code can't read) has card fields, by their autocomplete cc-* tokens.
async function cardFrame(page) {
  try {
    const frames = page.frames().filter((f) => f !== page.mainFrame()).slice(0, 12);
    const found = await Promise.all(frames.map((f) => within(800, f.evaluate(() => !!document.querySelector('input[autocomplete*="cc-" i]')).catch(() => false))));
    return found.some(Boolean);
  } catch {
    return false;
  }
}

// When the page can't be read, a click counts as one the user confirms.
export const UNREADABLE = { level: "commit", word: "submit", unreadable: true, why: ["PairBrowse couldn't read what it does"] };

// A click's context (daemon/page.mjs clickContext): the one reading every check shares (the
// helper's browser_click, Enter and Space, fast mode, uploads, pairbrowse_click_at). target: a ref or
// selector, a Playwright element handle or locator, or none (the focused element). prev: what the
// click just before in this tab committed. Unreadable counts as a commit (fail safe).
const inPage = withHelpers((el, [k, p, h]) => clickContext(el, k, p, h), clickContext, clickRisk, buttonLabel);
const focused = withHelpers(([k, p, h]) => { let el = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return clickContext(el, k, p, h); }, clickContext, clickRisk, buttonLabel);
export async function contextAt(page, target, kind = "click", prev = "") {
  try {
    const args = [kind, prev, { payFrame: await cardFrame(page) }];
    const el = !target ? null : typeof target === "string" ? page.locator(isRef(target) ? `aria-ref=${target}` : target).first() : target;
    // The focused element may be in a frame (a payment form in an iframe): read it there. A
    // frame that can't be followed reads as unreadable (the user confirms).
    const where = el ? null : await focusedFrame(page);
    if (!el && !where) return { risk: UNREADABLE };
    // A busy computer or a page still loading can miss the first second; a second, longer try
    // keeps that from reading as unreadable (which asks the user).
    for (const ms of [1000, 4000]) {
      const run = el ? el.evaluate(inPage, args, { timeout: ms }) : where.evaluate(focused, args);
      const ctx = await within(ms + 500, run.catch(() => null));
      if (ctx?.risk) return ctx;
    }
    return { risk: UNREADABLE };
  } catch {
    return { risk: UNREADABLE };
  }
}
// The frame holding the focused element: the page's own, or the frame a focused <iframe> leads
// into (as deep as frames go, up to 6); null when a focused frame can't be followed.
const FOCUSED_FRAME = () => { let e = document.activeElement; while (e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement; return /^(IFRAME|FRAME)$/.test(e?.tagName || "") ? e : null; };
export async function focusedFrame(page) {
  const main = typeof page.mainFrame === "function" ? page.mainFrame() : page;
  let frame = main;
  for (let depth = 0; depth < 6; depth++) {
    if (typeof frame.evaluateHandle !== "function") return frame;
    const h = await within(1500, Promise.resolve().then(() => frame.evaluateHandle(FOCUSED_FRAME)).catch(() => null));
    // The page's own document didn't answer: read as before (the checks' own tries decide).
    if (!h) return depth ? null : main;
    const box = h.asElement?.() || null;
    if (!box) { h.dispose?.().catch(() => {}); return frame; }
    const child = await within(1500, box.contentFrame().catch(() => null));
    box.dispose().catch(() => {});
    if (!child) return null;
    frame = child;
  }
  return null;
}
export const riskAt = async (page, target, kind = "click", prev = "") => (await contextAt(page, target, kind, prev)).risk;

// The refusal's wording for a risky click: why, and what to call it so the user confirms.
export const riskReason = (risk) => `${risk.why.join(", ") || "it commits something"}: a final action (${risk.word})`;

export async function enterButtonLabel(page, target, kind = "enter") {
  try {
    const run = target
      ? page.locator(isRef(target) ? `aria-ref=${target}` : String(target)).first().evaluate(pressedButton, kind, { timeout: 1000 })
      : page.evaluate(pressedButton, kind);
    return String(await within(1500, run.catch(() => "")) ?? "");
  } catch {
    return "";
  }
}
