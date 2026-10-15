// What the tool server reads in a page for its checks: a button's own label, whether a field is
// sensitive by its own kind, and whether a navigation got where it was asked to. Each read bounded.
import { isRef, sensitiveLabel } from "../../rules/policy.mjs";
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
