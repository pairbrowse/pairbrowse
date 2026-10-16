// Fast mode's field finding: a field by its label, placeholder or nearby text, in the page and its
// frames; folded sections opened; buttons and links found by name.
import { strongSignal } from "../rules/clicks.mjs";
import { sleep, within, bounded, urlOrigin } from "../util.mjs";
import { withHelpers, isVisible, nearbyText, settle } from "../daemon/page.mjs";
import { scanReveal, pickReveal, revealNote } from "../daemon/reveal.mjs";
import { contextAt } from "./risk.mjs";

// Where fields are looked for: the page, then its frames that show (a form embedded from a
// forms or signup service lives in one). Never a payment provider's card frame: card details are
// the user's to enter.
const rootsSeen = new WeakMap(); // page -> { at, roots }: frames change rarely within a run
const ROOTS_FRESH_MS = 2000;
export async function formRoots(page) {
  const known = rootsSeen.get(page);
  if (known && Date.now() - known.at < ROOTS_FRESH_MS && known.roots.slice(1).every((f) => !f.isDetached())) return known.roots;
  const roots = [page];
  for (const f of page.frames().filter((x) => x !== page.mainFrame()).slice(0, 12)) {
    if (roots.length > 8) break;
    const shown = await within(800, f.frameElement().then((el) => el.isVisible()).catch(() => false));
    if (!shown) continue;
    const card = await within(800, f.evaluate(() => !!document.querySelector('input[autocomplete*="cc-" i]')).catch(() => true));
    if (!card) roots.push(f);
  }
  rootsSeen.set(page, { at: Date.now(), roots });
  return roots;
}

// A page read that gives up quietly: its value, or `fallback` when it failed or didn't answer
// within ms (a page whose scripts never pause answers nothing).
// The page's inner size; a page that doesn't answer is taken as 1280 x 800 (the step then says so
// by doing little harm: a scroll or a stroke in the middle of a usual window).
export async function viewSize(page) {
  const v = await bounded(page.evaluate(() => [innerWidth, innerHeight]), null);
  return Array.isArray(v) && v.every((n) => Number.isFinite(n) && n > 0) ? v : [1280, 800];
}

// First visible match among candidate locators, each made for a root (the page or a frame).
// frames: false for clicks (their safety checks read the page itself).
export async function find(page, candidates, { frames = true } = {}) {
  // The page first; its frames only when the page has no match.
  const hit = await findIn(page, candidates);
  if (hit || !frames) return hit;
  for (const root of (await formRoots(page)).slice(1)) {
    const one = await findIn(root, candidates);
    if (one) return one;
  }
  return null;
}
// Each look is bounded: a page whose scripts never pause answers nothing, and a run must still
// end (with a word about the page) rather than hold every agent behind it.
const LOOK_MS = 2500;
export async function findIn(root, candidates) {
  for (const make of candidates) {
    const loc = make(root);
    const n = (await within(LOOK_MS, loc.count().catch(() => 0))) ?? 0;
    for (let i = 0; i < Math.min(n, 5); i++) {
      const one = loc.nth(i);
      if (await within(LOOK_MS, one.isVisible().catch(() => false))) return one;
    }
  }
  return null;
}

// The first of these that's visible within the time (a locator matching several elements).
export async function visibleSoon(loc, timeout) {
  const until = Date.now() + timeout;
  do {
    for (let i = 0, n = Math.min(await bounded(loc.count(), 0), 50); i < n; i++) if (await bounded(loc.nth(i).isVisible(), false)) return true;
    await sleep(200);
  } while (Date.now() < until);
  return false;
}

// A field named only by the text just before it in its row (a "Date of Birth" div or label
// with no for=): the one visible fillable field whose nearby text is exactly that, or none if
// that's ambiguous. The same rule names fields in the outline.
const nearbyMatch = withHelpers((els, want) => {
  const norm = (t) => t.replace(/[\s*:]+$/g, "").trim().toLowerCase();
  const fillable = (el) => !(el.matches("input") && /^(hidden|submit|button|image|reset|checkbox|radio|file|range|color)$/i.test(el.type));
  const hits = els.map((el, i) => (fillable(el) && isVisible(el) && norm(nearbyText(el)) === norm(want) ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? hits[0] : -1;
}, isVisible, nearbyText);
// A <select> whose first choice is its name (a placeholder: "Organization Type*"), the one such.
export async function byFirstOption(root, label) {
  const all = root.locator("select");
  const index = await bounded(all.evaluateAll((els, want) => {
    const norm = (t) => String(t || "").replace(/[\s*:]+/g, " ").trim().toLowerCase();
    const hits = els.map((el, i) => { const o = el.options[0]; const r = el.getBoundingClientRect(); return o && (o.disabled || o.value === "") && norm(o.text) === norm(want) && r.width > 0 ? i : -1; }).filter((i) => i >= 0);
    return hits.length === 1 ? hits[0] : -1;
  }, label), -1);
  return index >= 0 ? all.nth(index) : null;
}
export async function byNearbyText(page, label) {
  const all = page.locator("input, textarea, select");
  const index = await bounded(all.evaluateAll(nearbyMatch, label), -1);
  if (index >= 0) return all.nth(index);
  const own = await bounded(all.evaluateAll(ownBoxMatch, label), -1);
  return own >= 0 ? all.nth(own) : null;
}
// A field named by text inside the small box that holds only it (a floating label drawn over the
// field, as some page builders make them): the one such field, or none if ambiguous.
const ownBoxMatch = (els, want) => {
  const norm = (t) => String(t || "").replace(/[\s*:]+/g, " ").trim().toLowerCase();
  const w = norm(want);
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // Only a name that appears once on the page: two "Email" texts are ambiguous, never a guess.
  // (Menus and footers don't count: a "Company" link up top isn't the form's "Company".)
  const texts = [...document.querySelectorAll("body *")].filter((e) => !e.children.length && norm(e.textContent) === w && shown(e) && !e.closest("nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]"));
  if (texts.length !== 1) return -1;
  const hits = [];
  els.forEach((el, i) => {
    // Nor a field in a menu or footer (the site's search box) for a name the form carries.
    if (!shown(el) || (el.matches("input") && /^(hidden|submit|button|image|reset|checkbox|radio|file)$/i.test(el.type)) || el.closest("nav, header, footer, [role=navigation], [role=banner], [role=contentinfo]")) return;
    for (let a = el.parentElement, k = 0; a && k < 4; a = a.parentElement, k++) {
      if (a.querySelectorAll("input:not([type=hidden]), select, textarea").length > 1) break;
      // The box's own words, not a dropdown's list of choices.
      const words = [];
      for (let it = document.createTreeWalker(a, NodeFilter.SHOW_TEXT), t = it.nextNode(); t; t = it.nextNode()) if (!t.parentElement?.closest("select, option, script, style")) words.push(t.textContent);
      if (norm(words.join(" ")) === w) { hits.push(i); break; }
    }
  });
  return hits.length === 1 ? hits[0] : -1;
};

// A CSS attribute value in double quotes: backslashes and quotes escaped.
export const cssString = (s) => s.replace(/[\\"]/g, "\\$&");
export const field = (page, label) => find(page, [
  (root) => root.getByLabel(label, { exact: true }),
  (root) => root.getByPlaceholder(label, { exact: true }),
  (root) => root.getByRole("textbox", { name: label, exact: true }),
  (root) => root.getByRole("spinbutton", { name: label, exact: true }),
  (root) => root.getByRole("searchbox", { name: label, exact: true }),
  (root) => root.getByLabel(label),
  (root) => root.getByPlaceholder(label),
  (root) => root.locator(`[name="${cssString(label)}"]`),
  (root) => root.locator(`[id="${cssString(label)}"]`),
]).then(async (el) => {
  if (el) return el;
  for (const root of await formRoots(page)) { const hit = await byNearbyText(root, label); if (hit) return hit; }
  return null;
});
// A field inside a section a person opens first (a closed <details>): opened, so it can be filled.
export async function openSectionOf(page, label) {
  for (const root of await formRoots(page)) {
    const loc = root.getByLabel(label, { exact: true }).first();
    if (!(await bounded(loc.count(), 0))) continue;
    const opened = await bounded(loc.evaluate((n) => { const d = n.closest("details:not([open])"); if (!d) return false; d.open = true; return true; }), false);
    if (opened) return loc;
  }
  return null;
}

// Something looked for that the page's compact layout folded away (a narrow window turns a search
// box into a "Search" button, a menu into a hamburger): the one control that clearly unfolds it
// (daemon/reveal.mjs) is opened, as a person would, only when the click checks call that click safe
// (a disclosure, never a submit or a final action), then look() runs again. Returns { el } when it
// was found then, else { note }: the controls that may unfold it, for the failure's message. A
// control opened for nothing is folded back.
export async function unfold(page, want, look, hooks, { exact = false } = {}) {
  const found = await pickReveal(page, want, { exact });
  const scan = found?.scan || null;
  const note = revealNote(scan);
  const handle = found?.el || null;
  if (!scan || scan.auto < 0 || !handle) { handle?.dispose().catch(() => {}); return { note, scan }; }
  const pick = scan.list[scan.auto];
  const origin = originOf(page.url());
  try {
    if (!(await revealable(page, handle))) return { note, scan };
    await hooks.beforeStep?.("click", handle);
    await hooks.cursor?.(handle, "click");
    if (!(await within(6000, handle.click({ timeout: 5000 }).then(() => true, () => false)))) return { note, scan };
    await within(5000, page.waitForLoadState("domcontentloaded", { timeout: 4500 }).catch(() => {}));
    // It took the tab to another site: nothing more is done there (no field filled, nothing
    // remembered for that site); the tab goes back to where the run was.
    const now = originOf(page.url());
    if (now !== origin) {
      hooks.left = true;
      await within(6000, page.goBack({ timeout: 5000 }).catch(() => {}));
      return { note: ` Opening ${pick.name ? `"${pick.name}"` : "the page's menu"} went to another site (${now || "an unknown address"}), so the run stopped and went back.`, scan, left: true };
    }
    await settle(page, 1500);
    const el = await look();
    if (el) {
      hooks.activity(`Opened **${pick.name || "the menu"}** first: the page had folded it away`);
      return { el };
    }
    const open = await within(1000, handle.evaluate((n) => {
      const b = n.matches("label[for]") ? n.control : n;
      return b?.getAttribute("aria-expanded") === "true" || (b?.type === "checkbox" && b.checked) || !!n.closest("details[open]");
    }).catch(() => false));
    // Folded back with the same checks as the click that opened it (the page may have changed it).
    if (open && originOf(page.url()) === origin && (await revealable(page, handle))) await within(4000, handle.click({ timeout: 3000 }).catch(() => {}));
    // The control just tried isn't offered again.
    const after = (await scanReveal(page, want, { exact })) || scan;
    const rest = { ...after, list: after.list.filter((c) => !(c.name === pick.name && c.ref === pick.ref)) };
    return { note: `${revealNote(rest)} (Opening ${pick.name ? `"${pick.name}"` : "the page's menu"} didn't show it.)`, scan: rest };
  } finally {
    handle.dispose().catch(() => {});
  }
}
const originOf = (url) => urlOrigin(url);

// Whether fast mode may click a control to unfold something: only a click the checks call safe
// and whose effect the markup says (a disclosure, a link on this site): never one that submits a
// form (even one the checks let through, a search or a sign-in), sends a request, commits, only
// runs the page's scripts, or goes to another site.
export async function revealable(page, handle) {
  const { risk } = await contextAt(page, handle, "click");
  if (risk?.level !== "safe" || risk.unclear || strongSignal(risk)) return false;
  if (risk.does === "submits a form" || /^sends /.test(risk.does || "")) return false;
  const away = await within(1000, handle.evaluate((n) => {
    const a = n.closest("a[href]");
    if (!a || /^\s*(#|javascript:)/i.test(a.getAttribute("href") || "")) return false;
    try { return new URL(a.href).origin !== location.origin; } catch { return true; }
  }).catch(() => true));
  return away === false;
}

// Whether the form has a field by that name that it hides at the moment.
export async function hiddenNow(page, label) {
  for (const root of await formRoots(page)) {
    for (const loc of [root.getByLabel(label, { exact: true }), root.getByRole("combobox", { name: label, exact: true })]) {
      if ((await bounded(loc.count(), 0)) && !(await bounded(loc.first().isVisible(), true))) return true;
    }
  }
  return false;
}

// The page's only visible field of a kind, when it has no label at all: the one meant by a name
// nothing on the page carries. A field with a name of its own is never taken for another name
// (a form that just dropped the field asked for must say so, not fill its neighbour).
export async function onlyOne(page, selector, label = "") {
  const all = page.locator(selector);
  const shown = [];
  for (let i = 0, n = Math.min(await bounded(all.count(), 0), 20); i < n; i++) if (await bounded(all.nth(i).isVisible(), false)) shown.push(all.nth(i));
  if (shown.length !== 1) return null;
  // Nor when the name asked for shows on the page away from it: that is another control's name.
  const named = await bounded(shown[0].evaluate((n, want) => {
    if (n.labels?.length || n.getAttribute("aria-label") || n.getAttribute("aria-labelledby") || n.title) return true;
    const norm = (t) => String(t || "").replace(/[\s*:]+/g, " ").trim().toLowerCase();
    const w = norm(want);
    if (!w) return false;
    let box = n.parentElement;
    for (let k = 0; box && k < 3 && box.parentElement && box.parentElement.querySelectorAll("input:not([type=hidden]), select, textarea").length <= 1; k++) box = box.parentElement;
    return [...document.querySelectorAll("body *")].some((e) => !e.children.length && norm(e.textContent) === w && !box?.contains(e));
  }, label), true); // a page that doesn't answer: as if named elsewhere, so nothing is guessed
  return named ? null : shown[0];
}

// A control named by the page's own markup rather than its text: "#login-button" (its id), or a
// test id the page gives it (data-test, data-testid, data-test-id, data-cy, data-qa: what a site's
// own tests click by). Its clicks get the same checks as any other.
export const TEST_IDS = ["data-test", "data-testid", "data-test-id", "data-cy", "data-qa"];
export const byMarkup = (page, name) => {
  const id = /^#([A-Za-z_][\w:.-]*)$/.exec(name)?.[1];
  if (id) return find(page, [(root) => root.locator(`[id="${cssString(id)}"]`)], { frames: false });
  if (!/^[\w:.-]{1,100}$/.test(name)) return Promise.resolve(null);
  return find(page, [(root) => root.locator(TEST_IDS.map((a) => `[${a}="${cssString(name)}"]`).join(", "))], { frames: false });
};

export const exactlyClickable = (page, name) => find(page, [
  (root) => root.getByRole("button", { name, exact: true }),
  (root) => root.getByRole("link", { name, exact: true }),
  (root) => root.getByRole("tab", { name, exact: true }),
  (root) => root.getByRole("menuitem", { name, exact: true }),
  // A day in a date picker, a cell in a grid: by its name (often a fuller one: "Choose Friday, October 17th").
  (root) => root.getByRole("gridcell", { name, exact: true }),
  (root) => root.getByRole("option", { name, exact: true }),
], { frames: false }).then((el) => el || (/^#/.test(name) ? byMarkup(page, name) : null));
// Named loosely: of every visible button, link, tab and menu item whose name holds the words, the
// one named most like them: the same name first, then one that starts with it ("Pull requests 10"
// for "Pull requests"), then one with it as whole words, then any; within each, one in the page's
// navigation (nav, header, a tab list) before one in its content (an issue row's "2 linked pull
// requests"), then page order. Text named exactly is the last resort.
export function clickScore(label, want, inNav) {
  const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
  const l = norm(label), w = norm(want);
  if (!w) return 9;
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tier = l === w ? 0 : l.startsWith(w) && !/[\p{L}\p{N}]/u.test(l[w.length] || " ") ? 1 : l.startsWith(w) ? 2 : new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, "u").test(l) ? 3 : l.includes(w) ? 4 : 9;
  return tier * 2 + (inNav ? 0 : 1);
}
const CLICK_ROLES = ["button", "link", "tab", "menuitem", "gridcell", "option"];
export async function clickable(page, name) {
  const exact = await find(page, [(root) => root.getByRole("button", { name, exact: true }), (root) => root.getByRole("link", { name, exact: true })], { frames: false });
  if (exact) return exact;
  let best = null;
  for (const role of CLICK_ROLES) {
    const loc = page.getByRole(role, { name });
    const n = Math.min((await within(LOOK_MS, loc.count().catch(() => 0))) ?? 0, 25);
    for (let i = 0; i < n; i++) {
      const one = loc.nth(i);
      if (!(await within(LOOK_MS, one.isVisible().catch(() => false)))) continue;
      const seen = await within(LOOK_MS, one.evaluate((el) => [el.getAttribute("aria-label") || el.innerText || el.textContent || "", !!el.closest("nav, header, [role=navigation], [role=banner], [role=tablist], [role=menubar]")]).catch(() => null));
      if (!seen) continue;
      const score = clickScore(seen[0], name, seen[1]);
      if (score < 18 && (!best || score < best.score)) best = { el: one, score };
      if (score === 0) return one;
    }
  }
  if (best) return best.el;
  return (await find(page, [(root) => root.getByText(name, { exact: true })], { frames: false })) || byMarkup(page, name);
}
