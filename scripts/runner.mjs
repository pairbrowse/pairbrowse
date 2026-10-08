// Fast mode: Claude sends a whole page (or flow) of steps in one call, and they run here at
// machine speed, with no model turn between steps. Returns a short summary plus an outline of
// the page it ended on, so the next page can be planned without a full snapshot.
//
// The same safety rules apply as for single actions: web pages only, passwords only on their
// domains, uploads only of checked media and documents, final actions (pay, publish, submit for
// review, delete, message people) are left for browser_click so the user confirms them.
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.mjs";
import { navigationProblem, isRef, SENSITIVE } from "./policy.mjs";
import { hostAllowed } from "./secrets.mjs";
import { isLocalNetwork, clickClass } from "./guard.mjs";
import { strongSignal } from "./clickrule.mjs";
import { uploadProblem, uploadFiles } from "./upload.mjs";
import { slug } from "./runs.mjs";
import { readJson, sleep, within } from "./util.mjs";
import { withHelpers, buttonLabel, isVisible, nearbyText, clickRisk, clickContext, settle } from "./daemon/page.mjs";

// A stroke's pace: one small move this often (a steady hand drawing).
const STROKE_STEP_MS = 8;
const strokeEnds = new WeakMap(); // page -> where its last stroke let go (moves the humanized mouse doesn't know of)
// How long a handoff waits for the user (a sign-in, a CAPTCHA).
const HANDOFF_MS = 10 * 60_000;

export const RUN_TOOL = {
  name: "pairbrowse_run",
  description:
    "Run several browser steps in one call, fast, on the current tab. Use it for each page (or a whole saved flow) instead of one tool call per field. " +
    'Steps, one key each: {"go":url} {"fill":{"Label":"value",...}} {"check":"Label"} {"uncheck":"Label"} {"select":{"Label":"Option"}} ' +
    '{"click":"Button or link text"} {"press":"Enter"} {"scroll":"down"|"up"|pixels} {"drag":[[x,y],...]} (press at the first point, move through the rest, let go: drawing on canvases; x, y are fractions 0-1 of the visible page) {"upload":{"Label":"/abs/path"}} {"waitFor":"text"} {"expect":"text"} ' +
    '{"handoff":{"say":"what the user must do","until":"text that appears after"}} (or "untilGone"). ' +
    "Labels match the field's label, placeholder or name. Values may use {{var}} from vars. Stops at the first problem and says why. " +
    "Returns where it ended and an outline of the page (fields, buttons, errors). Save a working flow with saveAs, replay it with playbook + vars; list saved ones with list:true. " +
    "Ordinary buttons and form submits run here. Payments, deletions (judged by what a click does) and a click step you name as a final action (\"Send: Reply\") stop the run: use browser_click so the user confirms.",
  inputSchema: {
    type: "object",
    properties: {
      steps: { type: "array", items: { type: "object" } },
      vars: { type: "object", additionalProperties: { type: "string" } },
      playbook: { type: "string", description: "Run a saved playbook" },
      saveAs: { type: "string", description: "Save these steps as a playbook if they all succeed" },
      list: { type: "boolean", description: "List saved playbooks" },
    },
  },
};

// A single scroll that glides like a person's, with the agent's cursor on the page. Fast mode's
// scroll step goes at once instead.
export const SCROLL_TOOL = {
  name: "pairbrowse_scroll",
  description: 'Scroll the current tab the way a person does: the cursor moves onto the page and the wheel turns smoothly, so people watching see it. direction "down" or "up" (a screen), or pixels (negative: up). Use it instead of PageDown or End.',
  inputSchema: {
    type: "object",
    properties: {
      direction: { type: "string", enum: ["down", "up"] },
      pixels: { type: "integer", minimum: -20000, maximum: 20000 },
    },
  },
};

const PLAYBOOKS = join(paths.home, "playbooks");
const playbookFile = (name) => join(PLAYBOOKS, `${slug(name, "playbook")}.json`);

export function listPlaybooks() {
  mkdirSync(PLAYBOOKS, { recursive: true, mode: 0o700 });
  return readdirSync(PLAYBOOKS).filter((f) => f.endsWith(".json")).map((f) => {
    const p = readJson(join(PLAYBOOKS, f));
    if (!Array.isArray(p?.steps)) return null;
    const vars = [...new Set(JSON.stringify(p.steps).match(/\{\{(\w+)\}\}/g) || [])].map((v) => v.slice(2, -2));
    return `${p.name} (${p.steps.length} steps${vars.length ? `; vars: ${vars.join(", ")}` : ""})`;
  }).filter(Boolean);
}

export function loadPlaybook(name) {
  return JSON.parse(readFileSync(playbookFile(name), "utf8")).steps;
}

export function savePlaybook(name, steps) {
  mkdirSync(PLAYBOOKS, { recursive: true, mode: 0o700 });
  writeFileSync(playbookFile(name), JSON.stringify({ name, steps, savedAt: new Date().toISOString() }, null, 2));
}

export function substitute(value, vars = {}) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (m, k) => {
      if (!Object.hasOwn(vars, k)) throw new Error(`missing var ${k}`); // not inherited: {{constructor}} is missing too
      return String(vars[k]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [substitute(k, vars), substitute(v, vars)]));
  return value;
}

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
    // A busy computer or a page still loading can miss the first second; a second, longer try
    // keeps that from reading as unreadable (which asks the user).
    for (const ms of [1000, 4000]) {
      const run = el ? el.evaluate(inPage, args, { timeout: ms }) : page.evaluate(focused, args);
      const ctx = await within(ms + 500, run.catch(() => null));
      if (ctx?.risk) return ctx;
    }
    return { risk: UNREADABLE };
  } catch {
    return { risk: UNREADABLE };
  }
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

// Checks a step list before anything runs. Returns a problem string, or null.
export function preflight(steps, uploadsDir) {
  if (!Array.isArray(steps) || !steps.length) return "No steps.";
  if (steps.length > 200) return "Too many steps (max 200).";
  for (const [i, step] of steps.entries()) {
    const [kind, arg] = Object.entries(step || {})[0] || [];
    const at = `Step ${i + 1} (${kind})`;
    if (kind === "go") {
      const p = navigationProblem(arg);
      if (p) return `${at}: ${p}`;
      if (isLocalNetwork(arg)) return `${at}: ${arg} is on the local network. Use browser_navigate so the user can approve it.`;
    } else if (kind === "click") {
      // What the click does is checked when it runs (the page isn't there yet).
    } else if (kind === "upload") {
      for (const p of Object.values(arg || {})) {
        const problem = uploadProblem(p, uploadsDir); // the same checks as pairbrowse_upload
        if (problem) return `${at}: ${problem}`;
      }
    } else if (kind === "drag") {
      const ok = Array.isArray(arg) && arg.length >= 2 && arg.length <= 200 && arg.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && n >= 0 && n <= 1));
      if (!ok) return `${at}: drag takes 2 to 200 points [x, y], fractions 0-1 of the visible page.`;
      const far = Math.max(...arg.map(([x, y]) => Math.hypot(x - arg[0][0], y - arg[0][1])));
      if (far < 0.01) return `${at}: a drag has to move (for a click use click).`;
    } else if (kind === "scroll") {
      if (!(arg === "down" || arg === "up" || (Number.isFinite(Number(arg)) && Number(arg) !== 0 && Math.abs(Number(arg)) <= 20000))) return `${at}: scroll takes "down", "up" or a number of pixels (negative: up).`;
    } else if (!["fill", "check", "uncheck", "select", "press", "waitFor", "expect", "handoff"].includes(kind)) {
      return `${at}: unknown step. Use one of go, fill, check, uncheck, select, click, press, scroll, upload, waitFor, expect, handoff.`;
    }
  }
  return null;
}

// Where fields are looked for: the page, then its frames that show (a form embedded from a
// forms or signup service lives in one). Never a payment provider's card frame: card details are
// the user's to enter.
const rootsSeen = new WeakMap(); // page -> { at, roots }: frames change rarely within a run
const ROOTS_FRESH_MS = 2000;
async function formRoots(page) {
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

// First visible match among candidate locators, each made for a root (the page or a frame).
// frames: false for clicks (their safety checks read the page itself).
async function find(page, candidates, { frames = true } = {}) {
  // The page first; its frames only when the page has no match.
  const hit = await findIn(page, candidates);
  if (hit || !frames) return hit;
  for (const root of (await formRoots(page)).slice(1)) {
    const one = await findIn(root, candidates);
    if (one) return one;
  }
  return null;
}
async function findIn(root, candidates) {
  for (const make of candidates) {
    const loc = make(root);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) {
      const one = loc.nth(i);
      if (await one.isVisible().catch(() => false)) return one;
    }
  }
  return null;
}

// The first of these that's visible within the time (a locator matching several elements).
async function visibleSoon(loc, timeout) {
  const until = Date.now() + timeout;
  do {
    for (let i = 0, n = Math.min(await loc.count().catch(() => 0), 50); i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return true;
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
async function byFirstOption(root, label) {
  const all = root.locator("select");
  const index = await all.evaluateAll((els, want) => {
    const norm = (t) => String(t || "").replace(/[\s*:]+/g, " ").trim().toLowerCase();
    const hits = els.map((el, i) => { const o = el.options[0]; const r = el.getBoundingClientRect(); return o && (o.disabled || o.value === "") && norm(o.text) === norm(want) && r.width > 0 ? i : -1; }).filter((i) => i >= 0);
    return hits.length === 1 ? hits[0] : -1;
  }, label).catch(() => -1);
  return index >= 0 ? all.nth(index) : null;
}
async function byNearbyText(page, label) {
  const all = page.locator("input, textarea, select");
  const index = await all.evaluateAll(nearbyMatch, label).catch(() => -1);
  if (index >= 0) return all.nth(index);
  const own = await all.evaluateAll(ownBoxMatch, label).catch(() => -1);
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
const cssString = (s) => s.replace(/[\\"]/g, "\\$&");
const field = (page, label) => find(page, [
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
// What a click or typing opens: the short texts that show now and didn't before (a dropdown's
// choices, a field's suggestions), whatever the list is built from: role="option" or plain
// elements (many dropdown libraries). before(root): marks what shows now; after(root): the new
// texts, each clickable by its index (choiceAt). Works in the page or a frame.
const markShown = (mark) => {
  for (const el of document.querySelectorAll("body *")) {
    if (el.children.length) continue;
    const r = el.getBoundingClientRect();
    // Seen means a person sees it: a list drawn in advance but invisible (visibility, opacity)
    // shows its choices only once opened.
    if (r.width > 0 && r.height > 0 && el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) !== false) el.setAttribute("data-pb-seen", mark);
  }
};
const newlyShown = (arg) => {
  const [mark, near] = Array.isArray(arg) ? arg : [arg, null];
  const out = [];
  // Marks from an earlier look (a list that redrew as it was typed into) would point at old rows.
  for (const el of document.querySelectorAll(`[data-pb-choice^="${mark}-"]`)) el.removeAttribute("data-pb-choice");
  for (const el of document.querySelectorAll("body *")) {
    if (el.getAttribute("data-pb-seen") === mark) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) continue;
    const t = (el.innerText || "").replace(/\s+/g, " ").trim();
    // A choice: short text of its own (a leaf, or an option-like element), not a field, not filler.
    if (!t || t.length > 80 || !/[\p{L}\p{N}]/u.test(t) || /^(INPUT|TEXTAREA|SELECT|SCRIPT|STYLE)$/.test(el.tagName) || (el.tagName === "LABEL" && el.control)) continue;
    const optionLike = /^(option|menuitem|menuitemradio|treeitem)$/.test(el.getAttribute("role") || "") || el.tagName === "LI";
    if (el.children.length && !optionLike) continue;
    if (el.closest("nav, header, footer, [role=navigation], [role=banner]")) continue;
    // In a list that popped up: a listbox or menu, or a box laid over the page (absolute or
    // fixed), not page text that showed on the way (a hint under a field, a section that opened).
    // (An element that says it's a choice, role=option, counts wherever its list opens: also a
    // panel that unfolds in place.)
    let inPopup = !!el.closest('[role=listbox], [role=menu], [role=tree], [role=grid], datalist') || /^(option|menuitemradio)$/.test(el.getAttribute("role") || "");
    for (let a = el; !inPopup && a && a !== document.body; a = a.parentElement) {
      const pos = getComputedStyle(a).position;
      if (pos === "absolute" || pos === "fixed") inPopup = true;
    }
    if (!inPopup) continue;
    // Not a skip link (they show on focus), and close to what was opened: a list opens next to its
    // dropdown, a floating label or a page section elsewhere doesn't count.
    // Not a link to another page (a choice changes the field, it doesn't go anywhere) nor text only
    // screen readers get ("Opens in new window", drawn 1px wide).
    if (/^skip to/i.test(t) || (el.closest("a[href]") && !el.closest("[role=listbox], [role=menu], [role=option]"))) continue;
    if (r.width < 3 || r.height < 3) continue;
    { let a = el.parentElement, field = false; for (let k = 0; a && k < 3 && a !== document.body; a = a.parentElement, k++) { if (a.getBoundingClientRect().height > 140) break; if (a.querySelector("input:not([type=hidden]), textarea, select")) { field = true; break; } } if (field && !el.closest("[role=listbox], [role=menu]")) continue; }
    // A long list scrolls inside its box: its rows count by where the list is, not each row.
    let list = el.closest("[role=listbox], [role=menu], [role=tree]");
    // Or the box it scrolls in, when the list has no role (plain rows in a scrolling box).
    for (let a = el.parentElement, k = 0; !list && a && k < 6 && a !== document.body; a = a.parentElement, k++) if (/(auto|scroll)/.test(getComputedStyle(a).overflowY) && a.scrollHeight > a.clientHeight + 4) list = a;
    const at = list ? list.getBoundingClientRect() : r;
    if (near && (at.left > near.right + 400 || at.right < near.left - 400 || at.top > near.bottom + 600 || at.bottom < near.top - 600)) continue;
    if (out.some((o) => o.t === t)) continue;
    el.setAttribute("data-pb-choice", `${mark}-${out.length}`);
    out.push({ t });
  }
  for (const el of document.querySelectorAll(`[data-pb-seen="${mark}"]`)) el.removeAttribute("data-pb-seen");
  return out.slice(0, 400).map((o) => o.t);
};
const rectOf = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
async function choicesBefore(page) {
  const mark = `c${Math.random().toString(36).slice(2, 9)}`;
  for (const root of await formRoots(page)) await within(1500, root.evaluate(markShown, mark).catch(() => {}));
  return mark;
}
// The choices that showed after the click: [{ root, text, index }], and the one matching want (the
// same text, else one starting with it, else one containing it), clicked by its mark.
async function choicesAfter(page, mark, near = null) {
  const all = [];
  for (const root of await formRoots(page)) {
    const texts = (await within(1500, root.evaluate(newlyShown, [mark, near]).catch(() => []))) || [];
    texts.forEach((text, index) => all.push({ root, text, index }));
  }
  return all;
}
function bestChoice(choices, want) {
  const w = String(want).trim().toLowerCase();
  const norm = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const loose = (t) => norm(t).replace(/[\s,.\-–]/g, "");
  return choices.find((c) => norm(c.text) === w) || choices.find((c) => loose(c.text) === loose(w)) || choices.find((c) => norm(c.text).startsWith(w)) || choices.find((c) => w.length > 2 && norm(c.text).includes(w)) || null;
}
const choiceAt = (c, mark) => c.root.locator(`[data-pb-choice="${mark}-${c.index}"]`).first();
async function clearChoices(page, mark) {
  for (const root of await formRoots(page)) await within(1000, root.evaluate((m) => { for (const el of document.querySelectorAll("[data-pb-choice]")) if (el.getAttribute("data-pb-choice").startsWith(m)) el.removeAttribute("data-pb-choice"); }, mark).catch(() => {}));
}
// A styled list opened by clicking `opener`: the choice matching option, clicked. Returns "" when
// clicked, else why not (with the choices it saw).
async function pickFromOpened(page, opener, option, label, hooks) {
  let mark = await choicesBefore(page);
  try {
    await hooks.cursor?.(opener, "click");
    // Covered by a menu still open from before: close it as a person would (Escape), then again.
    const opened = await opener.click({ timeout: 2500 }).then(() => true, async () => {
      await page.keyboard.press("Escape").catch(() => {});
      await opener.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      return opener.click({ timeout: 3000 }).then(() => true, () => false);
    });
    if (!opened) return `"${label}" couldn't be opened: something covers it (a banner, a chat box, another open list) or it's disabled. Look at the screenshot, close what covers it, then try again.`;
    let choices = [];
    const near = await opener.evaluate(rectOf, null, { timeout: 1000 }).catch(() => null); // in its own frame
    for (const until = Date.now() + SUGGEST_MS; Date.now() < until;) {
      choices = await choicesAfter(page, mark, near);
      if (bestChoice(choices, option) || (choices.length && Date.now() > until - SUGGEST_MS + 400)) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    let best = bestChoice(choices, option);
    // A long list with its own search box (focused when it opens): type the option there, as a person would.
    if (!best) {
      // Focused in the page or in the frame the list lives in.
      let typed = false;
      for (const root of await formRoots(page)) if (await within(1000, root.evaluate(() => { const f = document.activeElement; return !!f && f.matches("input:not([type=hidden]):not([type=checkbox]):not([type=radio])") && !f.readOnly && !f.hasAttribute("data-pb-dropdown"); }).catch(() => false))) { typed = true; break; }
      const same = typed && await opener.evaluate((n) => n === document.activeElement || n.contains(document.activeElement)).catch(() => true);
      if (typed && !same) {
        await page.keyboard.type(String(option), { delay: 10 }).catch(() => {});
        for (const until = Date.now() + SUGGEST_MS; Date.now() < until && !best; await new Promise((r) => setTimeout(r, 80))) best = bestChoice(await choicesAfter(page, mark, near), option);
      }
    }
    // A list that filled in late or redrew while it was read (a form in a frame from another site):
    // closed and opened once more, then given longer.
    if (!best) {
      await page.keyboard.press("Escape").catch(() => {});
      await clearChoices(page, mark);
      const again = await choicesBefore(page);
      if (await opener.click({ timeout: 2500 }).then(() => true, () => false)) {
        for (const until = Date.now() + 2 * SUGGEST_MS; Date.now() < until && !best; await new Promise((r) => setTimeout(r, 100))) {
          choices = await choicesAfter(page, again, near);
          best = bestChoice(choices, option);
        }
        if (best) mark = again; else await clearChoices(page, again);
      }
    }
    if (!best) {
      await page.keyboard.press("Escape").catch(() => {});
      return `Opened "${label}" but found no option "${option}".${choices.length ? ` Its options: ${choices.map((c) => c.text).slice(0, 25).join(", ")}.` : ""}`;
    }
    // Lists that redraw their options under the pointer replace the marked one: then the visible
    // option with that exact text.
    // The option scrolled into view first, so the cursor shows where the click lands: its own, not a person's.
    await choiceAt(best, mark).scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    await hooks.cursor?.(choiceAt(best, mark), "click");
    const clicked = await choiceAt(best, mark).click({ timeout: 1500 }).then(() => true, async () => {
      const again = await findIn(best.root, [(r) => r.getByRole("option", { name: best.text, exact: true }), (r) => r.getByText(best.text, { exact: true })]);
      return again ? again.click({ timeout: 3000 }).then(() => true, () => false) : false;
    });
    if (!clicked) return `Opened "${label}" and found "${best.text}", but couldn't click it (the list closed or something covers it). Look at the screenshot, then try again.`;
    return "";
  } finally {
    await clearChoices(page, mark);
  }
}


// After typing into a field that suggests as you type: the suggestion matching the value (the same
// text, else one starting with it), clicked as a person would. Waits up to SUGGEST_MS for the list.
const SUGGEST_MS = 1200;
async function pickSuggestion(page, el, value, mark, typed = "", hooks = {}) {
  if (!String(value).trim()) return { picked: "", seen: [] };
  let choices = [];
  const near = await el.evaluate(rectOf, null, { timeout: 1000 }).catch(() => null); // in its own frame
  for (const until = Date.now() + SUGGEST_MS; Date.now() < until;) {
    choices = await choicesAfter(page, mark, near);
    // The value itself, else (after typing a shorter part) the one suggestion starting with that part.
    const lead = typed ? choices.filter((c) => c.text.toLowerCase().startsWith(typed.toLowerCase())) : [];
    const best = bestChoice(choices, value) || (lead.length === 1 ? lead[0] : null);
    if (best) {
      // The cursor first, on the suggestion: the click is the agent's, never taken for a person's.
      await hooks.cursor?.(choiceAt(best, mark), "click");
      await choiceAt(best, mark).click({ timeout: 3000 }).catch(() => {});
      return { picked: best.text, seen: choices };
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return { picked: "", seen: choices };
}

// A date written in a common way, as YYYY-MM-DD, or "" when it could mean two days.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function isoDate(v) {
  const t = String(v).trim().toLowerCase();
  const pad = (n) => String(n).padStart(2, "0");
  const ok = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1000 ? `${y}-${pad(m)}-${pad(d)}` : "");
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    if (a > 12 && b <= 12) return ok(y, b, a); // 15/03/1990
    if (b > 12 && a <= 12) return ok(y, a, b); // 03/15/1990
    return a === b ? ok(y, a, b) : "";
  }
  m = t.match(/^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/) || t.match(/^(\d{1,2}) ([a-z]{3})[a-z]*\.?,? (\d{4})$/);
  if (m) {
    const [mon, day] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const i = MONTHS.indexOf(mon);
    return i >= 0 ? ok(+m[3], i + 1, +day) : "";
  }
  return "";
}

// A field inside a section a person opens first (a closed <details>): opened, so it can be filled.
async function openSectionOf(page, label) {
  for (const root of await formRoots(page)) {
    const loc = root.getByLabel(label, { exact: true }).first();
    if (!(await loc.count().catch(() => 0))) continue;
    const opened = await loc.evaluate((n) => { const d = n.closest("details:not([open])"); if (!d) return false; d.open = true; return true; }).catch(() => false);
    if (opened) return loc;
  }
  return null;
}

// Whether the form has a field by that name that it hides at the moment.
async function hiddenNow(page, label) {
  for (const root of await formRoots(page)) {
    for (const loc of [root.getByLabel(label, { exact: true }), root.getByRole("combobox", { name: label, exact: true })]) {
      if ((await loc.count().catch(() => 0)) && !(await loc.first().isVisible().catch(() => true))) return true;
    }
  }
  return false;
}

// A native <select> chosen as its own list would (no click: it may be drawn invisible over or under
// a styled box), with the events a person's choice fires. The option by its text or value, else the
// one option holding that text ("United States" for "US - United States").
async function chooseNative(sel, option) {
  return sel.evaluate((n, want) => {
    const w = want.trim().toLowerCase();
    const opts = [...n.options].filter((x) => !x.disabled);
    const words = (t) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(t.trim().toLowerCase());
    const holding = opts.filter((x) => words(x.text));
    // Spacing and dashes aside too ("0-500" for "0 - 500").
    const loose = (t) => t.toLowerCase().replace(/[\s,.\-–]/g, "");
    const o = opts.find((x) => x.text.trim().toLowerCase() === w || x.value === want) || opts.find((x) => loose(x.text) === loose(w)) || opts.find((x) => x.text.trim().toLowerCase().startsWith(w)) || (holding.length === 1 ? holding[0] : null);
    if (!o) return { options: [...n.options].map((x) => x.text.trim()).filter(Boolean).slice(0, 25) };
    n.focus(); n.value = o.value;
    n.dispatchEvent(new Event("input", { bubbles: true })); n.dispatchEvent(new Event("change", { bubbles: true }));
    return { picked: o.text.trim() };
  }, String(option)).catch(() => ({ options: [] }));
}
// A native <select> named exactly that (its label, aria-label, name or id), shown or drawn invisible.
async function nativeNamed(page, label) {
  for (const root of await formRoots(page)) {
    const all = root.locator("select");
    const i = await all.evaluateAll((els, want) => {
      const norm = (t) => String(t || "").replace(/[\s*:]+/g, " ").trim().toLowerCase();
      const w = norm(want);
      const hits = els.map((n, i) => ([...(n.labels || [])].some((l) => norm(l.innerText) === w) || norm(n.getAttribute("aria-label")) === w || n.name === want || n.id === want) && !n.disabled && n.closest("body") && getComputedStyle(n).display !== "none" && n.parentElement?.getBoundingClientRect().width > 0 ? i : -1).filter((i) => i >= 0);
      return hits.length === 1 ? hits[0] : -1;
    }, label).catch(() => -1);
    if (i >= 0) return all.nth(i);
  }
  return null;
}

// A label whose for= points at nothing (or at a hidden input), next to the one control that opens
// its list (a button, often unnamed: "open menu"): that control.
async function labelOpener(page, label) {
  for (const root of await formRoots(page)) {
    const mark = `o${Math.random().toString(36).slice(2, 10)}`;
    const ok = await within(1500, root.evaluate(({ want, mark }) => {
      const norm = (t) => String(t || "").replace(/[\s*:]+/g, " ").trim().toLowerCase();
      const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
      const labels = [...document.querySelectorAll("label")].filter((l) => norm(l.innerText) === norm(want) && shown(l) && !(l.control && shown(l.control)));
      if (labels.length !== 1) return false;
      for (let a = labels[0].parentElement, k = 0; a && k < 3; a = a.parentElement, k++) {
        const fields = [...a.querySelectorAll("input:not([type=hidden]), select, textarea")].filter(shown);
        const openers = [...a.querySelectorAll("button, [role=combobox], [aria-haspopup]")].filter(shown);
        if (fields.length || openers.length > 1) return false;
        if (openers.length === 1) { openers[0].setAttribute("data-pb-dropdown", mark); return true; }
      }
      return false;
    }, { want: label, mark }).catch(() => false));
    if (ok) return root.locator(`[data-pb-dropdown="${mark}"]`).first();
  }
  return null;
}

// A dropdown known by its name whose own input is hidden: the nearest box around it that shows.
async function hiddenDropdown(page, label) {
  for (const root of await formRoots(page)) {
    for (const loc of [root.getByRole("combobox", { name: label, exact: true }), root.getByRole("textbox", { name: label, exact: true }), root.getByLabel(label, { exact: true }), root.getByLabel(label)]) {
      const el = loc.first();
      if (!(await el.count().catch(() => 0)) || (await el.isVisible().catch(() => false))) continue;
      // The box is marked for the one click that opens it, then unmarked (select, below).
      const mark = `d${Math.random().toString(36).slice(2, 10)}`;
      const marked = await el.evaluate((n, mark) => {
        // The box a person clicks: shown, dropdown-sized, and holding no other field. A form that
        // hid the field itself (it applies to other answers) has no such box.
        for (let a = n.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) {
          const others = [...a.querySelectorAll("input, select, textarea, [role=combobox]")].filter((f) => f !== n && f.type !== "hidden");
          // The one control beside it that opens a list (its label points at the hidden input that
          // holds the answer): that is what a person clicks.
          if (others.length === 1 && others[0].matches("[role=combobox], [aria-haspopup], input[readonly]") && others[0].getBoundingClientRect().width > 0) {
            others[0].setAttribute("data-pb-dropdown", mark);
            return true;
          }
          if (others.length) return false;
          const r = a.getBoundingClientRect();
          if (r.width > 20 && r.height > 12) {
            if (r.width > 700 || r.height > 120) return false;
            a.setAttribute("data-pb-dropdown", mark);
            return true;
          }
        }
        return false;
      }, mark).catch(() => false);
      if (marked) return Object.assign(root.locator(`[data-pb-dropdown="${mark}"]`), { field: el });
    }
  }
  return null;
}

// The page's only visible field of a kind, when it has no label at all: the one meant by a name
// nothing on the page carries. A field with a name of its own is never taken for another name
// (a form that just dropped the field asked for must say so, not fill its neighbour).
async function onlyOne(page, selector, label = "") {
  const all = page.locator(selector);
  const shown = [];
  for (let i = 0, n = Math.min(await all.count().catch(() => 0), 20); i < n; i++) if (await all.nth(i).isVisible().catch(() => false)) shown.push(all.nth(i));
  if (shown.length !== 1) return null;
  // Nor when the name asked for shows on the page away from it: that is another control's name.
  const named = await shown[0].evaluate((n, want) => {
    if (n.labels?.length || n.getAttribute("aria-label") || n.getAttribute("aria-labelledby") || n.title) return true;
    const norm = (t) => String(t || "").replace(/[\s*:]+/g, " ").trim().toLowerCase();
    const w = norm(want);
    if (!w) return false;
    let box = n.parentElement;
    for (let k = 0; box && k < 3 && box.parentElement && box.parentElement.querySelectorAll("input:not([type=hidden]), select, textarea").length <= 1; k++) box = box.parentElement;
    return [...document.querySelectorAll("body *")].some((e) => !e.children.length && norm(e.textContent) === w && !box?.contains(e));
  }, label).catch(() => true);
  return named ? null : shown[0];
}

const clickable = (page, name) => find(page, [
  (root) => root.getByRole("button", { name, exact: true }),
  (root) => root.getByRole("link", { name, exact: true }),
  (root) => root.getByRole("button", { name }),
  (root) => root.getByRole("link", { name }),
  (root) => root.getByRole("tab", { name }),
  (root) => root.getByRole("menuitem", { name }),
  (root) => root.getByText(name, { exact: true }),
], { frames: false });

// Compact description of what's on the page now: enough to plan the next steps.
const describePage = withHelpers(() => {
  const name = (el) => {
    const id = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return (el.getAttribute("aria-label") || id?.innerText || el.closest("label")?.innerText || el.placeholder || nearbyText(el) || el.name || "").replace(/\s+/g, " ").trim().slice(0, 50);
  };
  const fields = [...document.querySelectorAll("input, select, textarea")].filter((el) => isVisible(el) && el.type !== "hidden" && el.type !== "submit").slice(0, 25).map((el) => {
    const type = el.tagName === "SELECT" ? "select" : el.type || "text";
    const val = type === "checkbox" || type === "radio" ? (el.checked ? "on" : "off") : type === "password" ? (el.value ? "(set)" : "") : String((type === "select" ? el.selectedOptions[0]?.text.trim() : el.value) || "").slice(0, 30);
    return `${name(el) || "(unlabeled)"} [${type}${el.required ? ", required" : ""}${el.getAttribute("aria-invalid") === "true" ? ", INVALID" : ""}]${val ? ` = ${val}` : ""}`;
  });
  const buttons = [...document.querySelectorAll("button, [role=button], input[type=submit], a[href]")].filter(isVisible)
    .map((el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40)).filter(Boolean);
  // Real messages only: short text with no fields inside (a wrapper named "...error-handling"
  // isn't an error), plus what an invalid field points to with aria-describedby.
  const described = [...document.querySelectorAll('[aria-invalid="true"][aria-describedby]')].flatMap((f) => f.getAttribute("aria-describedby").split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean));
  const errors = [...document.querySelectorAll('[role=alert], [aria-live=assertive], .error, .errors, [class*="error" i], [class*="invalid" i]'), ...described].filter(isVisible)
    .filter((el) => !el.matches("input, select, textarea, button, option") && !el.querySelector("input, select, textarea, button") && (el.innerText || "").trim().length <= 160)
    .map((el) => el.innerText.replace(/\s+/g, " ").trim().slice(0, 100)).filter(Boolean);
  const h = document.querySelector("h1, h2")?.innerText.replace(/\s+/g, " ").trim().slice(0, 80);
  return [
    `Page: ${document.title.slice(0, 80)} <${location.href.slice(0, 120)}>`,
    h && `Heading: ${h}`,
    fields.length && `Fields: ${fields.join("; ")}`,
    buttons.length && `Buttons/links: ${[...new Set(buttons)].slice(0, 20).join(" | ")}`,
    errors.length && `Errors: ${[...new Set(errors)].slice(0, 5).join(" | ")}`,
  ].filter(Boolean).join("\n");
}, isVisible, nearbyText);
export const outline = (page) => page.evaluate(describePage);

// Cancel passive waits when a participant disconnects; active browser operations finish
// before the daemon releases their queued turn.
async function waitOrDisconnect(promise, signal) {
  if (!signal) return promise;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(new Error("Participant disconnected."));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

// Runs steps on page. hooks: { secrets: {values, domains}, uploadsDir, signal, beforeStep(kind, el),
// status(text, kind), activity(text), cursor(el, act), remember(label, value, site), owner(el) }.
// beforeStep gets "enter" for an Enter press, and a click's element. owner(el): the person
// filling that field ({ who }) or null: such a field is skipped (in skipped) and the run goes on.
// Fast mode is just fast: the engine's human-like mouse and typing (on by default for single
// actions) are off for the run, and a scroll step goes at once. hooks.smooth: a single action
// (pairbrowse_scroll) that glides like a person.
export async function runSteps(page, steps, hooks) {
  const human = !hooks.smooth && page._pairbrowseHumanized === true;
  if (human) page._pairbrowseHumanized = false;
  const touched = new Touched(); // [{ el, label }]: the fields the run filled or chose in
  // Fields are brought into view at once: a page's smooth scrolling (CSS scroll-behavior) would
  // animate every jump to the next field. Put back when the run ends.
  const instant = hooks.smooth || typeof page.evaluate !== "function" ? null : await within(500, Promise.resolve().then(() => page.evaluate(() => { const st = document.createElement("style"); st.textContent = "html, body, * { scroll-behavior: auto !important; }"; st.setAttribute("data-pb-instant", ""); (document.head || document.documentElement).appendChild(st); return true; })).catch(() => null));
  try {
    const result = await stepsIn(page, steps, hooks, touched);
    // A value the page rewrites a moment after it was filled (a lookup from another answer, a
    // location guess, a script on blur): looked at again once the page is quiet.
    const late = await lateRewrites(page, touched).catch(() => []);
    result.checks = [...late.map((c) => c.text), ...await fieldProblems(touched.filter((t) => !late.some((c) => c.t === t))).catch(() => [])];
    // What's still blank in that form: often fields the form added while it was filled (a state once
    // the country is chosen). Only after a run that filled something, and not when it stopped.
    if (result.ok && touched.length) {
      const left = await leftovers(page, touched).catch(() => ({ required: [], optional: [] }));
      const list = (names) => names.map((n) => `"${n}"`).join(", ");
      if (left.required.length) result.checks.push(`still empty and required: ${list(left.required)}`);
      if (left.optional.length) result.checks.push(`left empty (optional; fill them if the user's details or task cover them): ${list(left.optional)}`);
    }
    return result;
  } finally {
    // Elements held by hand (a styled dropdown): let go of them.
    for (const t of touched) {
      if (typeof t.el?.asElement === "function") t.el.dispose().catch(() => {});
      Promise.resolve(t.handle).then((h) => h?.dispose()).catch(() => {});
    }
    if (human) page._pairbrowseHumanized = true;
    if (instant) await within(500, page.evaluate(() => document.querySelectorAll("style[data-pb-instant]").forEach((n) => n.remove())).catch(() => {}));
  }
}

// The fields a run filled or chose in, each with what it showed right after (seen, a promise) and
// when: what lateRewrites compares against.
// Each is also held by its element (handle): a field found by a name the page then changes (a
// dropdown that shows its choice in its name, a label that moves) is still read at once, never
// waited for by a name nothing has any more.
class Touched extends Array {
  push(...ts) {
    for (const t of ts) {
      if (!t?.el || t.seen) continue;
      t.at = Date.now();
      t.handle = typeof t.el.elementHandle === "function" ? t.el.elementHandle({ timeout: 700 }).catch(() => null) : null;
      t.seen = shownValue(t.el);
    }
    return super.push(...ts);
  }
}
// The element a touched field is now: the one it was, while it's in the page; else found again
// by its name (a form that drew the field anew). null: neither is there (never waited for).
async function nodeOf(t) {
  const h = await t.handle;
  if (h && (await within(500, h.evaluate((n) => n.isConnected)).catch(() => false))) return h;
  if (typeof t.el?.count === "function" && !(await t.el.count().catch(() => 0))) return null;
  return t.el;
}
// What a field shows a person: a dropdown's chosen text, a box ticked or not, a field's value, or
// the text of a styled control. null: couldn't be read.
const shownValue = (el) => within(800, el.evaluate((n) => {
  if (n.tagName === "SELECT") return n.selectedOptions[0]?.text?.trim() || "";
  if (n.type === "checkbox" || n.type === "radio") return n.checked ? "ticked" : "unticked";
  // A styled control's text also holds its label: not a value to compare.
  return /^(INPUT|TEXTAREA)$/.test(n.tagName) ? String(n.value) : null;
}, null, { timeout: 700 })).catch(() => null);
export const LATE_MIN_MS = 400; // a page's rewrite on a timer after blur: waited for since the last field
export const LATE_MAX_MS = 800;
// Every value the run filled or chose, read again after a short wait for the page to go quiet
// (at least LATE_MIN_MS after the last field, at most LATE_MAX_MS in all): any the page changed
// since, named with what it shows now. [{ t, text }]
async function lateRewrites(page, touched) {
  if (!touched.length || typeof page?.evaluate !== "function") return [];
  const started = Date.now();
  const last = Math.max(...touched.map((t) => t.at || 0));
  const gap = Math.min(LATE_MAX_MS, Math.max(0, LATE_MIN_MS - (started - last)));
  if (gap) await sleep(gap);
  if (typeof page.isClosed === "function") await settle(page, Math.max(0, LATE_MAX_MS - (Date.now() - started))).catch(() => {});
  const digits = (v) => String(v).replace(/[\s\-()./+]/g, "");
  const same = (a, b) => a.trim() === b.trim() || (/\d/.test(a) && digits(a) === digits(b));
  const out = [];
  const seen = new Set();
  for (const t of touched.slice(0, 40)) {
    if (seen.has(t.el)) continue; // a field filled twice: its last value counts
    const was = await (touched.findLast((x) => x.el === t.el) || t).seen;
    seen.add(t.el);
    if (typeof was !== "string") continue;
    const node = await nodeOf(t);
    if (!node) continue;
    const now = await shownValue(node);
    if (typeof now !== "string") continue;
    // Also a text answer another answer overwrote during the run (a lookup from the email): one
    // with digits may be just reformatted (a date, a phone), so only its later changes count.
    const given = typeof t.value === "string" && !/\d/.test(t.value) && now.trim() && !same(now, t.value) ? t.value : null;
    if (same(now, was) && !given) continue;
    // The value filled, now shown the field's way (a date with its weekday): kept.
    if (typeof t.value === "string" && sameDate(now, t.value)) continue;
    const say = (v) => (v.trim() ? `"${v.trim().slice(0, 60)}"` : "empty");
    const what = t.secret ? "changed it after it was filled" : now === "ticked" || now === "unticked" ? `${now} it after the run` : `changed it to ${say(now)} after it was filled (it ${given ? "was filled with" : "showed"} ${say(given ?? was)})`;
    out.push({ t, text: `"${t.label}": the page ${what}; ${now.trim() ? "set it back with another step if that's not what the user wants" : "fill it again"}` });
  }
  return out;
}

// What the run left undone in the form(s) it filled (the page and its frames): visible fields still
// blank, dropdowns still on a placeholder they can't go back to, radio questions with no answer,
// required boxes unticked. Only in the forms the run touched, so a footer's newsletter box or the
// site's search field never counts. { required: [names], optional: [names] }.
async function leftovers(page, touched) {
  const out = { required: [], optional: [] };
  const nodes = (await Promise.all(touched.map(nodeOf))).filter(Boolean);
  for (const n of nodes) await n.evaluate((x) => x.setAttribute("data-pb-touched", ""), null, { timeout: 1000 }).catch(() => {});
  try {
    for (const root of await formRoots(page)) {
      const found = await within(1500, root.evaluate(() => {
        const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
        const clean = (t) => String(t || "").replace(/\s+/g, " ").replace(/[\s*:]+$/, "").replace(/^[\s*]+/, "").trim().slice(0, 80);
        // The text a person reads next to the field: when it has no label of its own, the heading
        // or label just before it (a question over a row of buttons), never a code name like
        // "account.help_desk_size".
        const near = (el) => { for (let a = el, i = 0; a && i < 5; a = a.parentElement, i++) { for (let p = a.previousElementSibling, j = 0; p && j < 3; p = p.previousElementSibling, j++) { const t = (p.innerText || "").trim(); if (t && t.length < 80 && !/[.!]$/.test(t)) return t; } } return ""; };
        const coded = (t) => !!t && !/\s/.test(t) && /[._[\]]|[a-z][A-Z]/.test(t);
        const nameOf = (el) => clean(([...(el.labels || [])].map((l) => l.innerText).join(" ") || el.getAttribute("aria-label") || (el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ") || el.placeholder || el.title || near(el) || el.name).replace(/"/g, "'"));
        // Fields inside web components too (open shadow roots), as the run's own lookups see them.
        const all = [];
        const walk = (r) => { for (const el of r.querySelectorAll("*")) { if (el.matches("input, select, textarea")) all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
        walk(document);
        const touched = all.filter((el) => el.hasAttribute("data-pb-touched"));
        if (!touched.length) return null;
        // The forms the run worked in; a form without a <form> element: the closest box holding them all.
        // Across web component boundaries: a field in a shadow root belongs to its host's place.
        const hosts = (el) => { const out = [el]; for (let h = el.getRootNode()?.host; h; h = h.getRootNode()?.host) out.push(h); return out; };
        const formOf = (el) => hosts(el).map((n) => n.closest("form")).find(Boolean) || null;
        const contains = (box, el) => hosts(el).some((n) => box.contains(n));
        const forms = new Set(touched.map(formOf).filter(Boolean));
        let box = null;
        if (!forms.size) {
          box = hosts(touched[0]).at(-1).parentElement;
          while (box && !touched.every((el) => contains(box, el))) box = box.parentElement;
          // A form without a <form> element: up to the box that holds its fields (at least four), not
          // just the ones this run touched.
          const fieldsIn = (b) => [...b.querySelectorAll("input:not([type=hidden]), select, textarea")].length;
          while (box && box.parentElement && box !== document.body && fieldsIn(box) < Math.max(4, touched.length + 2)) box = box.parentElement;
        }
        const inScope = (el) => (forms.size ? forms.has(formOf(el)) : !!box && contains(box, el));
        const required = (el) => el.required || el.getAttribute("aria-required") === "true";
        const res = { required: [], optional: [] };
        const radios = new Map();
        for (const el of all) {
          if (!inScope(el) || el.disabled || el.readOnly || !shown(el)) continue;
          if (/^(hidden|submit|button|image|reset|file|password|search|range|color)$/i.test(el.type)) continue;
          if (el.type === "radio") { const k = el.name || nameOf(el); if (!radios.has(k)) radios.set(k, []); radios.get(k).push(el); continue; }
          if (el.type === "checkbox") { if (required(el) && !el.checked) res.required.push(nameOf(el)); continue; }
          const empty = el.tagName === "SELECT" ? !el.value || el.selectedOptions[0]?.disabled : !el.value.trim();
          if (!empty) continue;
          const placeholderOnly = el.tagName === "SELECT" && el.selectedOptions[0]?.disabled;
          (required(el) || placeholderOnly ? res.required : res.optional).push(nameOf(el));
        }
        for (const [k, group] of radios) {
          if (group.some((r) => r.checked)) continue;
          const set = group[0].closest("fieldset, [role=radiogroup]");
          const q = clean((set?.querySelector("legend")?.innerText || set?.getAttribute("aria-label") || (coded(k) ? near(group[0]) : "") || k).replace(/"/g, "'"));
          (group.some(required) ? res.required : res.optional).push(q);
        }
        res.required = [...new Set(res.required.filter(Boolean))].slice(0, 12);
        res.optional = [...new Set(res.optional.filter(Boolean))].slice(0, 12);
        return res;
      }).catch(() => null));
      for (const k of ["required", "optional"]) for (const n of found?.[k] || []) if (!out[k].includes(n)) out[k].push(n);
    }
  } finally {
    for (const n of nodes) await n.evaluate((x) => x.removeAttribute("data-pb-touched"), null, { timeout: 1000 }).catch(() => {});
  }
  return out;
}

// What the page says is wrong with the fields the run just filled (its own error text, or the
// browser's validation message), so the agent fixes them before going on: an address the site
// wants in another format, a date out of range, a choice that didn't stick.
async function fieldProblems(touched) {
  const out = [];
  for (const t of touched.slice(0, 40)) {
    const { label, want, note } = t;
    if (note) { out.push(`"${label}": ${note}`); continue; }
    const el = await nodeOf(t);
    if (!el) continue;
    const p = await within(1500, el.evaluate((n, want) => {
      const text = (id) => id.split(/\s+/).map((x) => document.getElementById(x)?.innerText || "").join(" ").replace(/\s+/g, " ").trim();
      // The browser's own check counts only where the form uses it (not novalidate): a form that
      // checks fields itself marks them aria-invalid.
      const browserSays = !n.form?.noValidate && n.willValidate && n.validity && !n.validity.valid && (n.value !== "" || n.required);
      // aria-invalid left over from before the answer (a valid value, no error text to show): not a problem.
      const stale = n.getAttribute("aria-invalid") === "true" && n.value && n.validity?.valid && !text(n.getAttribute("aria-errormessage") || "") && !text(n.getAttribute("aria-describedby") || "");
      const invalid = (n.getAttribute("aria-invalid") === "true" && !stale) || browserSays;
      let says = "";
      if (invalid) says = text(n.getAttribute("aria-errormessage") || "") || text(n.getAttribute("aria-describedby") || "") || n.validationMessage || "marked as not valid";
      // An error the page shows next to the field without marking it (red text under it): an
      // element close after it that looks like an error (role=alert, or "error"/"invalid" in its class).
      if (!says) {
        const box = n.closest("label, .field, [class*=field i], [class*=input i], div") || n.parentElement;
        for (let a = box, k = 0; a && k < 3 && !says; a = a.parentElement, k++) {
          if (a.querySelectorAll("input:not([type=hidden]), select, textarea").length > 2) break;
          for (const e of a.querySelectorAll('[role=alert], [class*="error" i], [class*="invalid" i]')) {
            const r = e.getBoundingClientRect();
            const t = (e.innerText || "").replace(/\s+/g, " ").trim();
            // Not just the required mark ("*") drawn in red.
            if (r.width && r.height && t && /[\p{L}\p{N}]/u.test(t) && t.length < 160 && e !== n && !e.contains(n)) { says = t; break; }
          }
        }
      }
      // A choice that didn't stick: the dropdown shows something else.
      if (!says && want) {
        const shown = n.tagName === "SELECT" ? n.selectedOptions[0]?.text || "" : (n.value ?? n.innerText ?? "");
        if (!String(shown).toLowerCase().includes(String(want).toLowerCase())) says = `shows "${String(shown).slice(0, 60)}", not "${want}"`;
      }
      return says.slice(0, 160);
    }, want || "").catch(() => "")).catch(() => "");
    if (p) out.push(`"${label}": ${p}`);
  }
  return out;
}


// The same date written the field's way (a shown "Fri, Nov 20" for a filled "Nov 20, 2026"): same
// month and day, and the same year when the field shows one.
// Both must read as a date (a month by name with a day, or day and month in figures): the
// browser's date reading takes almost anything ("nope 1234" is a date in year 1234).
const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const DATE_LIKE = new RegExp(`\\b${MONTH}\\s+\\d{1,2}\\b|\\b\\d{1,2}\\.?\\s+${MONTH}|\\b\\d{1,2}[/.-]\\d{1,2}([/.-]\\d{2,4})?\\b|\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b`, "i");
export function sameDate(a, b) {
  if (!DATE_LIKE.test(String(a)) || !DATE_LIKE.test(String(b))) return false;
  const weekday = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i;
  const d = (t) => { const x = new Date(String(t).replace(weekday, "")); return isNaN(x) ? null : x; };
  const y = d(b);
  // A shown date without a year ("Fri, Nov 20") takes the typed one's to be read at all.
  const x = d(/\d{4}/.test(a) || !y ? a : `${String(a).replace(weekday, "")} ${y.getFullYear()}`);
  if (!x || !y || !/[A-Za-z]{3}|\d{1,2}[/.-]\d{1,2}/.test(a)) return false;
  return x.getMonth() === y.getMonth() && x.getDate() === y.getDate() && (!/\d{4}/.test(a) || x.getFullYear() === y.getFullYear());
}

async function stepsIn(page, steps, hooks, touched = []) {
  const started = Date.now();
  const done = [];
  const skipped = []; // [{ label, who }]
  const theirs = async (el, label) => {
    const o = await hooks.owner?.(el);
    // Its owner couldn't be read in time (a very busy page): left, never typed over.
    if (o) skipped.push({ label, who: o.unknown ? "maybe a person: the page was too busy to check, try it again" : o.who });
    return !!o;
  };
  // No bringToFront here: on macOS it raises the whole browser window over the app you're in.
  // Background tabs aren't slowed down anyway (the browser starts with throttling switched off).
  for (const [i, step] of steps.entries()) {
    const [kind, arg] = Object.entries(step)[0];
    const fail = (why) => ({ ok: false, done, skipped, stoppedAt: i + 1, why });
    // A field missing after earlier steps of this run: forms add and remove fields as they're answered.
    const gone = () => (touched.length ? " An earlier answer in this run may have removed it (forms add and remove fields as they're filled): take a snapshot, then fill what's there now." : "");
    try {
      if (kind !== "click") await hooks.beforeStep?.(kind === "press" && activatingKey(arg) === "enter" ? "enter" : kind);
      if (kind === "go") {
        // Wait for the page to arrive, not for every script and image: a slow resource on the
        // site mustn't fail the step when the page itself is there and usable.
        await page.goto(arg, { waitUntil: "commit", timeout: 30000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        // Sites built in JavaScript draw their forms a moment after the page arrives.
        await page.locator("input:not([type=hidden]), textarea, select").first().waitFor({ state: "visible", timeout: 2500 }).catch(() => {});
        hooks.activity(`Opened ${arg}`);
      } else if (kind === "fill") {
        const filled = [];
        const suggestionsSeen = new Map(); // label -> what a suggesting field offered
        for (const [label, raw] of Object.entries(arg)) {
          // A person using the tab: wait until they're done, then go on (their fields stay theirs).
          await hooks.holdForPeople?.();
          let el = await field(page, label);
          if (!el && (await openSectionOf(page, label))) el = await field(page, label);
          if (!el) {
            // Its input hidden inside a box a person clicks: a styled dropdown, picked with select.
            const box = await hiddenDropdown(page, label);
            if (box) { await box.evaluate((n) => n.removeAttribute("data-pb-dropdown"), null, { timeout: 1000 }).catch(() => {}); return fail(`"${label}" is a dropdown: use a select step with the option's text ({"select": {"${label}": "..."}}).`); }
            return fail(await hiddenNow(page, label) ? `"${label}" is hidden right now: the form shows it only for some answers. Leave it, or change the answer it depends on.` : `No field "${label}".${gone()}`);
          }
          if (await theirs(el, label)) continue;
          let value = String(raw);
          const isSecret = Object.hasOwn(hooks.secrets.values, value);
          // Remember what was filled for next time; never passwords or one-time codes.
          if (!isSecret && value && !SENSITIVE.test(label)) {
            const type = await el.getAttribute("type").catch(() => null);
            if (type !== "password") hooks.remember?.(label, value, (() => { try { return new URL(page.url()).hostname; } catch { return ""; } })());
          }
          if (isSecret) {
            // The address of the document the field is in: a frame's own, not the page around it.
            const where = await el.evaluate(() => location.href).catch(() => "");
            if (!where || !hostAllowed(where, hooks.secrets.domains[value] || []) || !hostAllowed(page.url(), hooks.secrets.domains[value] || [])) return fail(`${value} may only be typed on HTTPS pages of ${(hooks.secrets.domains[value] || []).join(", ") || "(no domains set)"}; this field is on ${where || page.url()}. Hand this field to the user.`);
            value = hooks.secrets.values[value];
          }
          hooks.cursor?.(el, "type");
          // A field that suggests as you type (a combobox): a person picks the suggestion that
          // matches; typing alone often doesn't count. Wait briefly for the list, then click it.
          const kindOf = await el.evaluate((n) => ({ readOnly: !!n.readOnly, number: n.type === "number", date: n.type === "date" })).catch(() => ({}));
          // A date field takes YYYY-MM-DD: a date written another way is turned into that when it
          // can only mean one day (03/15/1990, 15.03.1990, March 15, 1990); an ambiguous one (03/04) isn't.
          if (kindOf.date && !isSecret) value = isoDate(value) || value;
          if (kindOf.readOnly) return fail(`"${label}" can't be typed into (a picker): use a select step with the choice's text ({"select": {"${label}": "..."}}).`);
          if (kindOf.number && !/^-?\d+([.,]\d+)?$/.test(value.trim())) return fail(`"${label}" takes a number only (it got "${value.slice(0, 40)}").`);
          const suggests = !isSecret && (await el.evaluate((n) => n.getAttribute("role") === "combobox" || !!n.getAttribute("aria-autocomplete") || n.hasAttribute("aria-controls") && n.getAttribute("aria-haspopup") === "listbox").catch(() => false));
          const mark = suggests ? await choicesBefore(page) : "";
          try {
            await el.fill(value, { timeout: 5000 });
          } catch (e) {
            const m = String(e?.message);
            if (/type "(radio|checkbox)" cannot be filled/i.test(m)) return fail(`"${label}" is a choice to tick, not a text field: use a check step with the choice's own text ({"check": "..."}).`);
            if (/not an <input>|not an input|contenteditable/i.test(m)) return fail(`"${label}" isn't a text field (it's a dropdown or a button): use a select step ({"select": {"${label}": "..."}}) or click it.`);
            if (/Malformed value/i.test(m)) {
              const type = await el.evaluate((n) => n.type).catch(() => "");
              const shape = { date: "YYYY-MM-DD", "datetime-local": "YYYY-MM-DDThh:mm", month: "YYYY-MM", week: "YYYY-Www", time: "hh:mm", color: "#rrggbb" }[type];
              return fail(`"${label}" is a ${type || "special"} field: it takes ${shape ? `a value like ${shape}` : "a value in its own format"} (it got "${value.slice(0, 40)}").`);
            }
            if (/Timeout/i.test(m)) return fail(`"${label}" didn't take typing: it's read-only, disabled or covered by something (a banner, a closed section). Look at the screenshot: open or uncover it first, or skip it.`);
            throw e;
          }
          if (suggests) {
            let s2 = await pickSuggestion(page, el, value, mark, "", hooks).finally(() => clearChoices(page, mark));
            // Nothing matched the whole text: as a person would, type less (its first word, then its
            // first letters) and take the suggestion that matches the value.
            for (const shorter of [String(value).trim().split(/\s+/)[0], String(value).trim().slice(0, 3)]) {
              if (s2.picked || !shorter || shorter === String(value).trim()) continue;
              const m2 = await choicesBefore(page);
              await el.fill(shorter, { timeout: 5000 }).catch(() => {});
              s2 = await pickSuggestion(page, el, value, m2, shorter, hooks).finally(() => clearChoices(page, m2));
            }
            if (s2.picked) { hooks.activity(`Picked **${s2.picked}** for **${label}**`); touched.push({ el, label }); continue; }
            suggestionsSeen.set(label, s2.seen.map((c) => c.text));
            await el.fill(value, { timeout: 5000 }).catch(() => {});
          }
          filled.push({ el, label, value, secret: isSecret });
        }
        // Check every field kept its value once focus has moved on: date pickers, masks and
        // autocompletes can throw a filled value away on blur. Retype those key by key; if one
        // still doesn't keep it, stop and say so rather than report it done.
        // Leave each field with Tab, like a person: a picker that didn't take a pasted value clears it then.
        // The same value, also when the field only formatted it (a phone or card mask adding spaces,
        // dashes, dots or brackets: "4155550142" shown as "(415) 555-0142").
        const bare = (v) => String(v).replace(/\r\n/g, "\n").trim();
        // A phone field may also put the country's code in front ("+1 415 555 0142").
        const digits = (v) => bare(v).replace(/[\s\-()./]/g, "");
        // Or take it off when the form picks the country separately ("+1 415 555 0142" shown as "415 555 0142").
        const coded = (withCode, plain) => /^\+\d{1,4}/.test(withCode) && /^\d{6,}$/.test(plain) && withCode.endsWith(plain) && withCode.length - plain.length >= 2 && withCode.length - plain.length <= 5;
        const same = (a, b) => sameDate(a, b) || bare(a) === bare(b) || (/\d/.test(b) && (digits(a) === digits(b) || coded(digits(a), digits(b)) || coded(digits(b), digits(a))));
        for (const f of filled) {
          const multiline = await f.el.evaluate((n) => n.tagName === "TEXTAREA" || n.isContentEditable).catch(() => true);
          if (!multiline) await f.el.press("Tab", { timeout: 2000 }).catch(() => {});
          const now = await f.el.inputValue({ timeout: 2000 }).catch(() => null);
          if (now !== null && !f.secret && coded(digits(f.value), digits(now))) {
            // Kept without its country code: the form takes the country from its own picker.
            f.note = `shows "${now}": the field dropped ${digits(f.value).slice(0, digits(f.value).length - digits(now).length)}; make sure the form's country or code picker shows that country`;
          } else if (now !== null && !f.secret && digits(now) !== digits(f.value) && !sameDate(now, f.value) && same(now, f.value)) {
            // Kept, with a country code the field put in front: right only if that's the number's country.
            f.note = `shows "${now}": the field put ${digits(now).slice(0, digits(now).length - digits(f.value).length)} in front; if the number is from another country, choose that country in the field first`;
          }
          if (now === null || same(now, f.value)) continue; // not a plain field (contenteditable): nothing to read
          // A phone field that reads each keystroke as part of a number with its country code: the
          // number in one piece ("+14155550142") is what it parses best.
          const compact = digits(f.value);
          if (!f.secret && /^\+?\d{7,15}$/.test(compact) && compact !== bare(f.value)) {
            await f.el.fill(compact, { timeout: 3000 }).catch(() => {});
            if (!multiline) await f.el.press("Tab", { timeout: 2000 }).catch(() => {});
            const kept = await f.el.inputValue({ timeout: 2000 }).catch(() => null);
            if (kept !== null && same(kept, f.value)) continue;
          }
          await f.el.fill("", { timeout: 3000 }).catch(() => {});
          await hooks.cursor?.(f.el, "click"); // its own click, never taken for a person's
          await f.el.click({ timeout: 3000 }).catch(() => {});
          await f.el.pressSequentially(f.value, { delay: 15, timeout: 15000 }).catch(() => {});
          await f.el.press("Tab").catch(() => {});
          const after = await f.el.inputValue({ timeout: 2000 }).catch(() => null);
          if (after !== null && !same(after, f.value)) {
            const offered = suggestionsSeen.get(f.label);
            const code = !f.secret && /^\+/.test(String(after).trim()) && !/^\+/.test(bare(f.value)) ? " It puts a country code in front: fill the number with its code, like +1 415 555 0142." : "";
            return fail(`"${f.label}" didn't keep the value${f.secret ? "" : ` "${f.value}"`} (it shows ${f.secret ? "something else" : `"${after}"`}).${code}${offered?.length ? ` It suggested: ${offered.slice(0, 20).join(", ")}; fill one of those.` : offered ? " It suggests as you type but offered nothing for that text (or a shorter part of it): try another wording, or use a select step." : " It may need its picker or a different format: check the screenshot, then fill it step by step."}`);
          }
        }
        for (const f of filled) touched.push({ el: f.el, label: f.label, note: f.note, secret: f.secret, value: f.secret ? undefined : String(f.value) });
        if (filled.length) hooks.activity(`Filled ${filled.map((f) => `**${f.label}**`).join(", ")}`);
      } else if (kind === "check" || kind === "uncheck") {
        // Also a bare box followed by its text, with no label element ("<input> checkbox 1").
        const bare = String(arg).includes('"') ? null : (root) => root.locator(`xpath=//text()[normalize-space(.)="${String(arg).trim()}"]/preceding-sibling::input[@type="checkbox" or @type="radio"][1]`);
        // Any kind of quote mark in the name matches any other ("Submit" / 'Submit' / “Submit”).
        const quoteless = new RegExp(String(arg).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/["'“”‘’]/g, "[\"'“”‘’]"), "i");
        const el = await find(page, [(root) => root.getByLabel(arg, { exact: true }), (root) => root.getByRole("checkbox", { name: arg }), (root) => root.getByRole("radio", { name: arg }), (root) => root.getByLabel(arg), ...(bare ? [bare] : []),
          (root) => root.getByRole("checkbox", { name: quoteless }), (root) => root.getByRole("radio", { name: quoteless })]);
        if (!el) {
          // A styled box: the real checkbox is hidden and its text (beside it, not a <label>) is what
          // a person clicks. Click that text, then make sure the box really changed.
          let hidden = null;
          for (const root of await formRoots(page)) {
            const box = root.getByRole("checkbox", { name: String(arg), exact: true }).first();
            if (await box.count().catch(() => 0)) { hidden = box; break; }
          }
          const want = kind === "check";
          const was = hidden ? await hidden.isChecked().catch(() => null) : null;
          const text = was === null ? null : await find(page, [(root) => root.getByText(String(arg), { exact: true }), (root) => root.getByText(String(arg))]);
          if (!text) return fail(`No checkbox "${arg}".${gone()}`);
          if (was !== want) {
            await hooks.cursor?.(text, "click");
            await text.click({ timeout: 5000 });
            if ((await hidden.isChecked().catch(() => null)) !== want) return fail(`Clicked "${String(arg).slice(0, 60)}" but its box is still ${want ? "unticked" : "ticked"}. Look at the screenshot and click the box itself.`);
          }
          hooks.activity(`${want ? "Ticked" : "Unticked"} **${arg}**`);
          touched.push({ el: hidden, label: String(arg) });
          done.push(kind);
          continue;
        }
        if (await theirs(el, String(arg))) { done.push(kind); continue; }
        await hooks.cursor?.(el, "click"); // sent before the press, which puts it on the click
        // A box drawn over by its styled look: click its label as a person does, then make sure.
        await (kind === "check" ? el.check({ timeout: 3000 }) : el.uncheck({ timeout: 3000 })).catch(async () => {
          const label = await el.evaluate((n) => !!n.labels?.length).catch(() => false);
          if (label) await el.evaluate((n) => n.labels[0].click());
          if ((await el.isChecked().catch(() => null)) !== (kind === "check")) throw new Error(`Couldn't ${kind} "${String(arg).slice(0, 60)}": something covers it. Look at the screenshot.`);
        });
        touched.push({ el, label: String(arg) });
        hooks.activity(`${kind === "check" ? "Ticked" : "Unticked"} **${arg}**`);
      } else if (kind === "select") {
        for (const [label, option] of Object.entries(arg)) {
          // Named exactly first: "Country" is never taken for "Country code" when both are there.
          let el = await find(page, [(root) => root.getByLabel(label, { exact: true }), (root) => root.getByRole("combobox", { name: label, exact: true }),
            (root) => root.getByRole("button", { name: label, exact: true }),
            (root) => root.locator(`select[name="${cssString(label)}"], select[id="${cssString(label)}"]`)]);
          // A native <select> by that exact name that's drawn invisible (a styled box shows instead).
          if (!el || !(await el.evaluate((n) => n.tagName === "SELECT").catch(() => false))) {
            const native = await nativeNamed(page, label);
            if (native) {
              if (await theirs(native, label)) continue;
              const picked = await chooseNative(native, option);
              if (!picked.picked) return fail(`"${label}" has no option "${option}". Its options: ${picked.options.join(", ")}.`);
              touched.push({ el: native, label, want: picked.picked });
              continue;
            }
          }
          // A label whose own field is missing or hidden, beside the one button that opens its list.
          if (!el) el = await labelOpener(page, label);
          // A <select> named only by the text before or beside it (no label), or by its own first
          // choice ("Organization Type*", a placeholder the form shows in the box).
          if (!el) for (const root of await formRoots(page)) { const hit = await byNearbyText(root, label) || await byFirstOption(root, label); if (hit && (await hit.evaluate((n) => n.tagName === "SELECT").catch(() => false))) { el = hit; break; } }
          // Then a name that holds the words ("Country*", "Select your country"); last, the page's one
          // unnamed dropdown, when nothing else on the page carries the name.
          if (!el) el = await find(page, [(root) => root.getByRole("combobox", { name: label }), (root) => root.getByLabel(label), (root) => root.getByRole("button", { name: label })]) || await onlyOne(page, "select", label);
          // A styled dropdown whose own input is hidden (0x0 inside the box a person clicks): open
          // the box around it, then pick the option as for any styled list.
          const control = el ? null : await hiddenDropdown(page, label);
          // A native <select> drawn invisible over (or under) its styled box: chosen as its own list
          // would, with the events a person's choice fires.
          if (control && (await control.field.evaluate((n) => n.tagName === "SELECT").catch(() => false))) {
            await control.evaluate((n) => n.removeAttribute("data-pb-dropdown"), null, { timeout: 1000 }).catch(() => {});
            const picked = await chooseNative(control.field, option);
            if (!picked.picked) return fail(`"${label}" has no option "${option}". Its options: ${picked.options.join(", ")}.`);
            touched.push({ el: control.field, label, want: picked.picked });
            continue;
          }
          if (control) {
            const why = await pickFromOpened(page, control, option, label, hooks).finally(() => control.evaluate((n) => n.removeAttribute("data-pb-dropdown"), null, { timeout: 1000 }).catch(() => {}));
            if (why) return fail(why);
            touched.push({ el: control.field, label });
            continue;
          }
          if (!el) return fail(await hiddenNow(page, label) ? `"${label}" is hidden right now: the form shows it only for some answers. Leave it, or change the answer it depends on.` : `No dropdown "${label}".${gone()}`);
          if (await theirs(el, label)) continue;
          await hooks.cursor?.(el, "click");
          const isSelect = await el.evaluate((n) => n.tagName === "SELECT").catch(() => false);
          if (isSelect) {
            // An option it doesn't have: say which ones it has rather than wait for it.
            const options = await el.evaluate((n) => [...n.options].map((o) => [o.label || o.text, o.value])).catch(() => []);
            const want = String(option);
            if (options.length && !options.some(([l, v]) => l.trim() === want || v === want)) {
              // The one option holding that text ("US - United States" for "United States").
              const near = await chooseNative(el, want);
              if (near.picked) { touched.push({ el, label, want: near.picked }); continue; }
              return fail(`"${label}" has no option "${want}". Its options: ${options.map(([l]) => l.trim()).filter(Boolean).slice(0, 25).join(", ")}${options.length > 25 ? ", ..." : ""}.`);
            }
            const chosen = await el.selectOption({ label: want }, { timeout: 3000 }).then(() => true, () => el.selectOption(want, { timeout: 3000 }).then(() => true, () => false));
            if (!chosen) {
              const off = await el.evaluate((n) => n.disabled || !!n.closest("fieldset[disabled]")).catch(() => false);
              return fail(`"${label}" didn't take "${want}": ${off ? "it's disabled until another answer is given (often the field before it)" : "something covers it or it's waiting for another answer"}. Fill the fields above it first, then choose again.`);
            }
          }
          else {
            // A styled dropdown (a button or combobox with its own list): open it, click the option.
            // Its name often says the choice ("Ticket type. Round trip"), so the name it was found by
            // no longer finds it once chosen: the element itself is held for what comes after.
            const node = await el.elementHandle({ timeout: 1000 }).catch(() => null);
            const why = await pickFromOpened(page, el, option, label, hooks).finally(() => (node || el).evaluate((n) => n.removeAttribute("data-pb-dropdown"), null, { timeout: 1000 }).catch(() => {}));
            if (why) return fail(why);
            if (node) { touched.push({ el: node, label, want: "" }); continue; }
          }
          touched.push({ el, label, want: isSelect ? String(option) : "" });
        }
        hooks.activity(`Chose ${Object.entries(arg).map(([k, v]) => `**${k}** = \`${v}\``).join(", ")}`);
      } else if (kind === "click") {
        // A step the agent named as a final action ("Send: Reply") goes through browser_click, which asks the user.
        if (clickClass(arg)) return fail(`"${arg}" is named as a final action. Run the steps before it, then use browser_click on it so the user confirms.`);
        const el = await clickable(page, String(arg));
        if (!el) return fail(`Nothing to click named "${arg}".`);
        await hooks.beforeStep?.("click", el);
        // What the matched element does, by the page's structure, whatever it says: strong signals
        // (payment, danger, DELETE, unreadable) make it the user's to confirm; ordinary submits go.
        const real = String(await el.evaluate(buttonLabel, undefined, { timeout: 2000 }).catch(() => ""));
        const { risk } = await contextAt(page, el, "click");
        if (strongSignal(risk)) return fail(`"${arg}" is the "${real.slice(0, 60)}" button: ${riskReason(risk)}. Run the steps before it, then use browser_click on it so the user confirms.`);
        await hooks.cursor?.(el, "click"); // sent before the press, which puts it on the click
        await el.click({ timeout: 5000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        hooks.activity(`Clicked **${arg}**`);
      } else if (kind === "press") {
        const key = activatingKey(arg);
        if (key) {
          const risk = await riskAt(page, null, key);
          if (strongSignal(risk)) {
            const label = await enterButtonLabel(page, null, key);
            return fail(`${String(arg)} here would ${label ? `press "${label.slice(0, 60)}" and ` : ""}commit something (${riskReason(risk)}). Use browser_click on its button so the user confirms.`);
          }
        }
        await page.keyboard.press(String(arg));
      } else if (kind === "drag") {
        // Drawing, as a person does: the mouse goes down at the first point and follows the rest
        // (in the PairBrowse browser its moves take human paths and timing), then lets go.
        const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]);
        const pts = arg.map(([x, y]) => ({ x: Math.round(x * w), y: Math.round(y * h) }));
        const mark = (p) => hooks.cursor?.({ boundingBox: async () => ({ x: p.x, y: p.y, width: 0, height: 0 }) }, "");
        const glide = Math.min(600, Number(await mark(pts[0])) || 0); // how long the cursor takes to get there
        // The stroke goes straight to the browser's input at a steady drawing pace: the humanized
        // mouse gives every move a hand's whole reach-and-settle time (about half a second per
        // point, seconds for a long reach) and presses where its own last move ended.
        const cdp = await page.context().newCDPSession(page);
        const send = (type, p) => cdp.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
        const from = strokeEnds.get(page);
        if (!from) {
          // The first stroke here: the hand comes to the start as a person's does (human paths in
          // the PairBrowse browser).
          await page.mouse.move(pts[0].x, pts[0].y);
        } else {
          // From the last stroke's end: along a gentle curve, eased, in the time the cursor glides.
          const dx = pts[0].x - from.x, dy = pts[0].y - from.y;
          const n = Math.max(3, Math.round(glide / 16));
          for (let k = 1; k <= n; k++) {
            const e = (1 - Math.cos((Math.PI * k) / n)) / 2, bend = 0.08 * Math.sin(Math.PI * e);
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(from.x + dx * e - dy * bend), y: Math.round(from.y + dy * e + dx * bend), button: "none", buttons: 0 });
            await new Promise((r) => setTimeout(r, glide / n));
          }
        }
        let at = pts[0];
        try {
          await send("mousePressed", at);
          // Let go whatever happens on the way: a stroke that fails must never leave the button held.
          try {
            for (const p of pts.slice(1)) {
              // A person took over (clicked, typed, paused agents): the stroke stops where it is.
              const why = hooks.interrupted?.();
              if (why) throw new Error(why);
              const n = Math.max(2, Math.min(12, Math.round(Math.hypot(p.x - at.x, p.y - at.y) / 12)));
              for (let k = 1; k <= n; k++) {
                await send("mouseMoved", { x: Math.round(at.x + (p.x - at.x) * k / n), y: Math.round(at.y + (p.y - at.y) * k / n) });
                await new Promise((r) => setTimeout(r, STROKE_STEP_MS));
              }
              at = p;
              await mark(p);
            }
          } finally {
            await send("mouseReleased", at).catch(() => {});
            strokeEnds.set(page, at);
          }
        } finally {
          cdp.detach().catch(() => {});
        }
        hooks.activity(`Drew a stroke (${pts.length} points)`);
      } else if (kind === "scroll") {
        // The cursor onto the page, then the wheel: in small eased steps that glide like a person
        // (pairbrowse_scroll), or in two quick ones (fast mode). A screen for "down" / "up".
        const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]);
        const total = arg === "down" ? Math.round(h * 0.8) : arg === "up" ? -Math.round(h * 0.8) : Math.round(Number(arg));
        const x = Math.round(w / 2), y = Math.round(h / 2);
        await hooks.cursor?.({ boundingBox: async () => ({ x, y, width: 0, height: 0 }) }, "");
        await page.mouse.move(x, y);
        // A glide: about a third of a second a screen, in up to a dozen eased steps (smooth to watch,
        // never slow); fast mode: two quick turns.
        const n = hooks.smooth ? Math.min(12, Math.max(6, Math.ceil(Math.abs(total) / 90))) : 2;
        let sent = 0;
        for (let k = 1; k <= n; k++) {
          const eased = Math.round(total * (1 - Math.cos((Math.PI * k) / n)) / 2); // slow, fast, slow
          await page.mouse.wheel(0, eased - sent);
          sent = eased;
          if (k % 10 === 0) await hooks.cursor?.({ boundingBox: async () => ({ x, y, width: 0, height: 0 }) }, ""); // still the agent's
          if (hooks.smooth) await new Promise((r) => setTimeout(r, 16));
        }
        await new Promise((r) => setTimeout(r, 60)); // the page catches up with the last turn of the wheel
        hooks.activity(`Scrolled ${total > 0 ? "down" : "up"}`);
      } else if (kind === "upload") {
        // Like pairbrowse_upload: files from anywhere (checked, copied into the uploads folder),
        // into a field, an upload button or a drop zone.
        for (const [label, file] of Object.entries(arg)) {
          const r = await uploadFiles(page, { files: [file], target: label }, { uploadsDir: hooks.uploadsDir });
          if (!r.ok) return fail(r.text);
        }
        hooks.activity(`Uploaded ${Object.values(arg).map((p) => String(p).split(/[\\/]/).pop()).join(", ")}`);
      } else if (kind === "waitFor" || kind === "expect") {
        // Page text, or a field shown by its placeholder or label ("Enter your email").
        const shown = page.getByText(String(arg)).or(page.getByPlaceholder(String(arg))).or(page.getByLabel(String(arg)));
        const ok = await waitOrDisconnect(visibleSoon(shown, kind === "expect" ? 3000 : 15000), hooks.signal);
        if (!ok) return fail(`"${arg}" didn't appear.`);
      } else if (kind === "handoff") {
        hooks.status(arg.say || "Your turn", "you");
        hooks.activity(`Waiting for you: ${arg.say || ""}`);
        const target = arg.until ? page.getByText(arg.until).first().waitFor({ state: "visible", timeout: HANDOFF_MS })
          : page.getByText(arg.untilGone).first().waitFor({ state: "hidden", timeout: HANDOFF_MS });
        let ok;
        try { ok = await waitOrDisconnect(target.then(() => true, () => false), hooks.signal); }
        finally { hooks.status("", "clear"); } // also when the participant disconnected
        if (!ok) return fail(`The user didn't finish within ${HANDOFF_MS / 60_000} minutes.`);
      }
      done.push(kind);
    } catch (e) {
      return fail(String(e?.message || e).split("\n")[0].slice(0, 200));
    }
  }
  return { ok: true, done, skipped, ms: Date.now() - started };
}
