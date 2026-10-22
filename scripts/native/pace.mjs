// The adaptive input pace (server-mode spec, step 51): humanized input in the native browser goes
// at a quick hand's pace (typingPace's quick rhythm, the "fast" motion) wherever nothing scores it,
// and at an everyday person's rhythm (about 150 ms between keys, the profile's own speed of moves)
// only where it matters: a page that carries a verification or scoring widget, and a field in a
// sign-in, sign-up or payment form. Both are read by structure, never from a list of sites: the
// widget by the address of its frame or script, as PairBrowse already knows a CAPTCHA (popups.mjs
// CHALLENGE), invisible ones (score-based reCAPTCHA, non-interactive Turnstile) included, or by its
// container; the form by its fields' hints, as the masking scans read them (rules/policy.mjs
// sensitiveHints, rules/cards.mjs CARD_NAME). Decided per page and per field when the typing or the
// move starts: a page that loads a widget later goes at the everyday pace from then on.
// "pairbrowse" inputPace in config.json: "adaptive" (the default), "fast" or "human" (always).
import { CHALLENGE } from "../popups.mjs";
import { CARD_NAME } from "../rules/cards.mjs";
import { sensitiveHints } from "../rules/policy.mjs";
import { within } from "../util.mjs";

export const INPUT_PACES = ["adaptive", "fast", "human"];
export const inputPaceOf = (config) => {
  const given = config?.pairbrowse?.inputPace;
  return INPUT_PACES.includes(given) ? given : "adaptive";
};

// A widget's own container, where its frame isn't up yet: reCAPTCHA's box and v3 badge, hCaptcha's,
// Turnstile's, and any element carrying a widget's site key.
export const WIDGET_BOXES = ".g-recaptcha, .grecaptcha-badge, .h-captcha, .cf-turnstile, [data-sitekey]";

// What the fields of a form say it is, from each field's hints (pageread.mjs's order: type,
// autocomplete, inputmode, name, id, aria-label, label, placeholder): "payment" (a card field),
// "sign-up" (a new password, or two password fields), "sign-in" (a password or a user name),
// "one-time code", "sensitive" (another field sensitive by its kind: a PIN, an IBAN), or "".
const CARD = new RegExp(`\\bcc-(?:number|csc|exp)|${CARD_NAME}`, "i");
const PASSWORD = /^password\b|\b(?:current|new)-password\b/i;
const ONE_TIME = /\bone-time-code\b|(?:^|[^a-z])[th]?otp(?![a-z])|\b(?:sms|mfa|2fa|verification|security)[-_ ]?code\b/i;
export function formKind(hints = []) {
  const list = (Array.isArray(hints) ? hints : []).map((h) => String(h ?? ""));
  if (list.some((h) => CARD.test(h))) return "payment";
  const passwords = list.filter((h) => PASSWORD.test(h));
  if (list.some((h) => /\bnew-password\b/i.test(h)) || passwords.length >= 2) return "sign-up";
  if (passwords.length || list.some((h) => /\busername\b/i.test(h))) return "sign-in";
  if (list.some((h) => ONE_TIME.test(h))) return "one-time code";
  if (list.some((h) => sensitiveHints(h))) return "sensitive";
  return "";
}

// The pace for one action: { pace: "fast" | "human", why }. why: "inputPace" (set so), "widget",
// or the form's kind (formKind); "" when nothing asks for the everyday pace.
export function decidePace(setting = "adaptive", { widget = false, form = "" } = {}) {
  if (setting === "fast" || setting === "human") return { pace: setting, why: "inputPace" };
  if (widget) return { pace: "human", why: "widget" };
  if (form) return { pace: "human", why: form };
  return { pace: "fast", why: "" };
}

// In a few words, for the tool result: "fast", "everyday (sign-in form)".
const REASONS = { inputPace: "inputPace", widget: "verification widget on the page", "sign-in": "sign-in form", "sign-up": "sign-up form", payment: "payment form", "one-time code": "one-time code field", sensitive: "sensitive field" };
export const paceWords = ({ pace, why } = {}) => {
  const word = pace === "human" ? "everyday" : "fast";
  return why && (pace === "human" || why === "inputPace") ? `${word} (${REASONS[why] || why})` : word;
};
// One sentence for a result: "Pace: fast." for one action or every field alike, else the fields at
// the everyday pace by name ("Pace: everyday for Email, Password (sign-in form); fast for the rest.",
// the rest said only when some went fast). entries: [{ label, decision, moves }]; moves: the pace
// the moves went at (paced-motion.mjs useMotion), said when the swap to the decided one didn't
// happen ("Pace: everyday (sign-in form); moves stayed fast.").
export function paceLine(entries = []) {
  const groups = new Map();
  for (const { label, decision = {}, moves = null } of entries) {
    const words = paceWords(decision);
    const stayed = moves && moves !== decision.pace ? `moves stayed ${moves === "human" ? "everyday" : "fast"}` : "";
    const key = `${words}|${stayed}`;
    if (!groups.has(key)) groups.set(key, { decision, words, stayed, labels: [] });
    groups.get(key).labels.push(label);
  }
  if (!groups.size) return "";
  const all = [...groups.values()];
  if (all.length === 1) return `Pace: ${all[0].words}${all[0].stayed ? `; ${all[0].stayed}` : ""}.`;
  const parts = all.filter((g) => g.decision.pace === "human" || g.stayed).map((g) => {
    const notes = [g.decision.pace === "human" && g.decision.why ? REASONS[g.decision.why] || g.decision.why : "", g.stayed].filter(Boolean);
    return `${g.decision.pace === "human" ? "everyday" : "fast"} for ${g.labels.join(", ")}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  });
  const rest = all.some((g) => g.decision.pace !== "human" && !g.stayed);
  return `Pace: ${parts.join("; ")}${rest ? "; fast for the rest" : ""}.`;
}

// In the page, on the field (or element) acted on: whether its document carries a widget (a frame
// or script by its maker's address, or the widget's own container), and the hints of each field of
// its form (the form it belongs to, else the nearest element around it that holds another field,
// at most 8 levels up), itself first. Self-contained: it runs in the page.
function scanForPace(el, { source, boxes }) {
  const maker = new RegExp(source, "i");
  const doc = el.ownerDocument || document;
  let widget = false;
  for (const n of doc.querySelectorAll("script[src], iframe[src], frame[src]")) {
    if (maker.test(n.src)) { widget = true; break; }
  }
  if (!widget) { try { widget = !!doc.querySelector(boxes); } catch { /* not a selector here */ } }
  const SKIP = ["hidden", "submit", "button", "image", "reset", "checkbox", "radio", "file", "range", "color"];
  const fieldsIn = (root) => [...root.querySelectorAll("input, textarea")].filter((n) => !SKIP.includes(n.type));
  const own = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
  let group = el.form || null;
  for (let n = el.parentElement, depth = 0; !group && n && depth < 8; n = n.parentElement, depth++) {
    if (fieldsIn(n).filter((f) => f !== el).length >= (own ? 1 : 2)) group = n;
  }
  const fields = group ? fieldsIn(group) : [];
  if (own && !fields.includes(el)) fields.unshift(el);
  const hintsOf = (n) => {
    const hints = [n.type, n.getAttribute("autocomplete"), n.getAttribute("inputmode"), n.name, n.id, n.getAttribute("aria-label"), n.labels?.[0]?.innerText, n.placeholder]
      .map((x) => String(x || "").replace(/\s+/g, " ").slice(0, 80));
    if (n.maxLength > 0 && n.maxLength <= 8) hints.push(`maxlength${n.maxLength}`);
    return hints.join(" ");
  };
  // The document's own fields too: a hover or a click away from the form (a heading, a link, the
  // page's logo) is the same hand that fills the form on this page.
  return { widget, hints: fields.slice(0, 60).map(hintsOf), pageHints: fieldsIn(doc).slice(0, 60).map(hintsOf) };
}

// A widget seen on a page stays seen until it goes to another address (the page's main frame
// then holds another document): one solved or tucked away still scores what follows. A form
// found on a page stays found the same way (forms: page -> { at, form }), so every move on a
// sign-in page goes at the everyday pace, a scroll or a click at coordinates too, not only the
// ones whose target sits in the form: the measurement read a sign-in page's strokes as a mix of
// the two paces (the fast hops as short as 287 ms and nearly straight) where a hand on that page
// is one hand.
const seen = new WeakMap(); // page -> the address it was seen at
const forms = new WeakMap(); // page -> { at, form }: the form kind found at that address
const mainUrl = (page) => { try { return page.mainFrame?.().url?.() ?? page.url?.() ?? ""; } catch { return ""; } };
// The page's frames, as the driver already knows them (no call into the page).
const framesShow = (page) => {
  try { return (page.frames?.() ?? []).some((f) => CHALLENGE.test(f.url())); } catch { return false; }
};

// The pace for an action on page (the field or element at loc, or none), as setting says. Each
// read bounded; a read that doesn't answer counts as nothing found there.
// scope "field" (typing: the field's own form decides, so a name is typed quickly and the card
// next to it as a hand does, spec step 51) or "page" (pointer tools: the page's strokes are one
// hand's, so a form found anywhere on the page, now or before at this address, decides).
export async function paceFor(page, loc = null, setting = "adaptive", scope = "field") {
  if (setting === "fast" || setting === "human") return decidePace(setting);
  const at = mainUrl(page);
  let widget = framesShow(page) || (!!at && seen.get(page) === at);
  const known = scope === "page" ? forms.get(page) : null;
  const remembered = known && at && known.at === at ? known.form : "";
  // The target's own form first (a sign-up form next to the sign-in one is its own kind), then
  // the document's, then what was found on this page before. No target: the document itself is
  // scanned (a scroll, a click at coordinates), when the page is one the driver can look into.
  const scanned = loc ?? (scope !== "page" || remembered || typeof page?.locator !== "function" ? null : page.locator("body").first());
  let form = "";
  if (scanned) {
    const got = await within(1500, Promise.resolve().then(() => scanned.evaluate(scanForPace, { source: CHALLENGE.source, boxes: WIDGET_BOXES }, { timeout: 1200 })).catch(() => null));
    if (got && typeof got === "object") {
      widget ||= got.widget === true;
      form = formKind(Array.isArray(got.hints) ? got.hints : []) || (scope === "page" ? formKind(Array.isArray(got.pageHints) ? got.pageHints : []) : "");
    }
  }
  form ||= remembered;
  if (widget && page && at) seen.set(page, at);
  if (form && page && at) forms.set(page, { at, form });
  return decidePace(setting, { widget, form });
}
