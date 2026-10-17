// What the tool server reads in a page for its checks: a button's own label, whether a field is
// sensitive by its own kind, and whether a navigation got where it was asked to. Each read bounded.
import { isRef, sensitiveHints, sensitiveLabel, UNKNOWN_VALUES } from "../../rules/policy.mjs";
import { within, sleep } from "../../util.mjs";
import { buttonLabel } from "../page.mjs";

// The button's own label, as the page shows it (the click guard only sees what Claude calls it).
// null when a snapshot ref can't be found (the click would fail anyway).
export async function realLabel(page, target) {
  if (!page || !target) return "";
  let el;
  try {
    el = page.locator(isRef(target) ? `aria-ref=${target}` : String(target)).first();
  } catch {
    return undefined; // not a ref, not a selector Playwright reads
  }
  // A selector (not a ref) that matches nothing on the page, or that Playwright can't read.
  if (!isRef(target)) {
    const n = await within(1500, el.count()).catch(() => undefined);
    if (n === undefined) return undefined;
    if (n === 0) return null;
  }
  // Read in the page: ariaSnapshot() would renumber the refs Claude just got.
  const got = await within(2000, el.evaluate(buttonLabel, undefined, { timeout: 1500 }).then(String, () => null));
  if (got === null) return isRef(target) ? null : "";
  return got;
}

// Whether a field Claude types into is sensitive by its own kind (a password, card or one-time
// code field), whatever Claude calls it: its value is then masked in the activity line, which
// joiners of a shared session see too.
export async function sensitiveTarget(page, target) {
  if (!page || !isRef(target)) return false;
  const read = page.locator(`aria-ref=${target}`).first().evaluate((el) => [el.type, el.getAttribute("autocomplete"), el.getAttribute("name"), el.id, el.getAttribute("aria-label"), el.labels?.[0]?.innerText].join(" "), undefined, { timeout: 1000 }).catch(() => "");
  const hints = String(await within(1500, read) || "");
  return /^password\b/.test(hints) || /cc-(?!name)|one-time-code|current-password|new-password/i.test(hints) || sensitiveLabel(hints);
}

// The values now in the page's fields that are sensitive by their kind (password type, card or
// one-time-code autocomplete, card, security code, expiry, PIN, IBAN, a one-time code's boxes and
// similar labels), in every frame: what an agent reads of the page is masked by them (policy.mjs
// maskForAgent), as a field's value or a typing call's. Dropdowns (a month on its own) stay. Each
// frame's read is bounded. Fails closed: UNKNOWN_VALUES (every value masked) when the page, or any
// frame still attached, doesn't answer or has more fields than are read, or there are more
// than FRAMES_MAX frames.
export const FRAMES_MAX = 40;
// [[hints, value]] of the frame's fields, open shadow roots included; null when past its bounds
// (1000 fields, 100000 elements looked through): then not all are known.
const fieldValues = () => {
  const roots = [document];
  let looked = 0;
  for (let i = 0; i < roots.length; i++) {
    for (const el of roots[i].querySelectorAll("*")) {
      if (++looked > 100000) return null;
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  const out = [];
  let n = 0;
  for (const root of roots) {
    for (const el of root.querySelectorAll("input, textarea")) {
      if (++n > 1000) return null;
      if (["checkbox", "radio", "hidden", "submit", "button", "file", "image", "reset"].includes(el.type) || !el.value) continue;
      const hints = [el.type, el.getAttribute("autocomplete"), el.getAttribute("inputmode"), el.name, el.id, el.getAttribute("aria-label"), el.labels?.[0]?.innerText, el.placeholder].map((x) => String(x || "").replace(/\s+/g, " ").slice(0, 80));
      if (el.maxLength > 0 && el.maxLength <= 8) hints.push(`maxlength${el.maxLength}`);
      out.push([hints.join(" "), String(el.value).slice(0, 200)]);
    }
  }
  return out;
};
export async function sensitiveValues(page) {
  if (!page || page.isClosed?.()) return [];
  let frames;
  try { frames = page.frames(); } catch { return UNKNOWN_VALUES; }
  if (frames.length > FRAMES_MAX) return UNKNOWN_VALUES;
  const read = await Promise.all(frames.map((f) => within(800, f.evaluate(fieldValues).catch(() => null)).then((list) => (Array.isArray(list) || f.isDetached?.() ? list || [] : null))));
  if (read.some((list) => list === null)) return UNKNOWN_VALUES;
  const out = new Set();
  for (const list of read) for (const [hints, value] of list) if (sensitiveHints(hints) && String(value).trim()) out.add(String(value).trim());
  return [...out];
}

// The tab came to the address asked for (its committed URL: the same document, whatever the
// fragment), within ms: the page, or null. A navigation the browser "interrupted" with its own
// error page may still get there (serve.mjs, browser_navigate).
export async function arrivedAt(page, wanted, ms = 5000) {
  if (!page || typeof wanted !== "string") return null;
  const key = (u) => { try { const x = new URL(u); x.hash = ""; return x.href; } catch { return null; } };
  const want = key(wanted);
  if (!want) return null;
  for (const end = Date.now() + ms; ; await sleep(100)) {
    if (page.isClosed?.()) return null;
    if (key(page.url()) === want) return page;
    if (Date.now() >= end) return null;
  }
}
