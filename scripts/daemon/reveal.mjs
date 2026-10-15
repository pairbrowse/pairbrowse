// Compact layouts: a narrow window folds a site's search box into a "Search" button, its menu
// into a hamburger, a sidebar behind a toggle. What an agent asks for by name is then hidden or not
// drawn yet. This finds, by the page's structure only (never a list of sites or words), the
// controls that unfold something: a control whose aria-controls points at the hidden part, a
// collapsed toggle (aria-expanded="false", aria-haspopup, a closed <details>, a checkbox menu
// toggle and its label) beside the hidden part, a control named with the same words, the page's
// one collapsed menu. Fast mode opens the one that clearly unfolds what it looks for (only a
// disclosure the click checks call safe); every other path names them, with their refs, so the
// agent opens one and tries again.
import { withHelpers, isVisible, buttonLabel } from "./page.mjs";
import { within } from "../util.mjs";

// How many controls a note names, at most.
export const REVEAL_MAX = 5;

// Runs in the page (with isVisible and buttonLabel). want: the name or text asked for ("" for none:
// only the page's folded controls). opts.target: the element the agent tried (a ref that couldn't
// be clicked), else looked for by want. opts.pick: the result is { scan, el } with el the one
// control fast mode may open (the element itself, so the page can't move a mark to another).
// Returns { hidden, list: [{ role, name, ref, why, tier, auto }], auto }: auto is the index in list
// of that control, or -1.
export function revealScan(want, opts = {}) {
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const low = (t) => norm(t).toLowerCase();
  const wordsOf = (t) => low(t).split(/[^\p{L}\p{N}]+/u).filter((x) => x.length >= 3);
  const w = low(want);
  const wantWords = wordsOf(want);
  // Through open shadow roots too (sites built from web components): the parent across a root,
  // closest() and contains() that cross them, and every root on the page, found once.
  const up = (n) => n.parentElement || n.getRootNode?.()?.host || null;
  const closest = (el, sel) => { for (let x = el; x; x = up(x)) if (x.matches?.(sel)) return x; return null; };
  const inside = (a, b) => { for (let x = b; x; x = up(x)) if (x === a) return true; return false; };
  const roots = [document];
  for (let i = 0, seen = 0; i < roots.length && i < 200; i++) {
    for (const el of roots[i].querySelectorAll("*")) { if (el.shadowRoot) roots.push(el.shadowRoot); if (++seen > 30000) break; }
  }
  const all = (sel, cap = 4000) => { const out = []; for (const r of roots) { for (const el of r.querySelectorAll(sel)) { out.push(el); if (out.length >= cap) return out; } } return out; };
  const vw = innerWidth;
  const offscreen = (el) => { const r = el.getBoundingClientRect(); return r.right <= 0 || r.left >= vw; };
  const shown = (el) => isVisible(el) && !offscreen(el) && !closest(el, "[inert], [aria-hidden=true]");
  const FIELDS = "input:not([type=hidden]), textarea, select, button, a[href], summary, [role=button], [role=link], [role=menuitem], [role=searchbox], [role=textbox], [role=combobox], [role=tab], [role=checkbox], [role=radio], [contenteditable=true]";
  // Every name it goes by: aria-label, its labels, placeholder, own text, title, value.
  const namesOf = (el) => [el.getAttribute("aria-label"), [...(el.labels || [])].map((l) => l.textContent).join(" "), el.getAttribute("placeholder"), el.textContent, el.getAttribute("title"), el.value].map((t) => low(String(t || "").slice(0, 300))).filter(Boolean);

  // What was asked for, present on the page but not shown: by its name (opts.exact: only that),
  // else a field or text holding it.
  let targets = [];
  if (opts.target) targets = [opts.target];
  else if (w) {
    const hidden = all(FIELDS).filter((el) => !shown(el) && !closest(el, "template, noscript"));
    const exact = hidden.filter((el) => namesOf(el).includes(w));
    targets = (exact.length || opts.exact ? exact : hidden.filter((el) => namesOf(el).some((n) => n.includes(w)))).slice(0, 3);
    if (!targets.length && !opts.exact && document.body) {
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n, k = 0; (n = walk.nextNode()) && k < 20000; k++) {
        const p = n.parentElement;
        if (p && n.nodeValue.toLowerCase().includes(w) && !p.closest("script, style, template, noscript, head") && !shown(p)) { targets.push(p); break; }
      }
    }
  }
  targets = targets.filter((t) => !shown(t));
  // The part that hides it: its highest ancestor that isn't shown (the drawer, the closed panel);
  // a box drawn only through its children (display: contents) is passed through.
  const regionOf = (t) => {
    let r = t;
    for (let a = up(t); a && a !== document.body && a !== document.documentElement && !shown(a); a = up(a)) if (getComputedStyle(a).display !== "contents") r = a;
    return r;
  };
  const regions = targets.map(regionOf);
  // Folded: a part around it is hidden, not only the element itself (a styled dropdown's own input
  // is hidden inside a box that shows; that is no compact layout).
  const folded = regions.map((r, i) => r !== targets[i]);

  // A checkbox that works as a menu toggle (CSS-only menus), outside any form (a form's checkbox is
  // an answer, never a toggle to flip): a button by role, tied to a region, or hidden with a label
  // that shows.
  const toggleBox = (cb) => !!cb && cb.matches?.("input[type=checkbox]") && !cb.checked && !cb.form && !closest(cb, "form") &&
    (cb.getAttribute("role") === "button" || cb.hasAttribute("aria-controls") || cb.hasAttribute("aria-expanded") || cb.hasAttribute("aria-haspopup") || !isVisible(cb));
  const CTRL = "button, a[href], summary, label[for], [role=button], [role=link], [role=menuitem], [aria-expanded], [aria-haspopup], [aria-controls], input[type=checkbox]";
  const NOT = "input:not([type=checkbox]), select, textarea, [role=combobox], [role=tab], [role=option], [role=listbox], [role=menuitemcheckbox], [role=menuitemradio]";
  // A form's submit button sends the form: never one that unfolds something.
  const submits = (c) => c.matches("button") && (c.getAttribute("type") || "submit").toLowerCase() === "submit" && !!c.form;
  const ctrls = all(CTRL).filter((c) => shown(c) && !c.matches(NOT) && !submits(c) && !closest(c, "[role=tablist]"));
  // How many controls a box holds (a label counts with its field once): up to 5.
  const counted = new Map();
  const controlCount = (box) => {
    if (!counted.has(box)) { let n = 0; for (const c of ctrls) { if (inside(box, c) && !(c.matches("label[for]") && c.control && shown(c.control)) && ++n > 4) break; } counted.set(box, n); }
    return counted.get(box);
  };
  const found = [];
  const seen = new Set();
  for (const c of ctrls) {
    const box = c.matches("label[for]") ? c.control : c.matches("input[type=checkbox]") ? c : null;
    if (c.matches("label[for], input[type=checkbox]") && !toggleBox(box)) continue;
    // A label and its checkbox are one control: the one that shows, once.
    const key = box || c;
    if (seen.has(key)) continue;
    seen.add(key);
    const state = key.getAttribute("aria-expanded");
    const summary = c.matches("summary") && c.parentElement?.matches("details");
    if (state === "true" || (summary && c.parentElement.open)) continue; // already open
    const pop = (key.getAttribute("aria-haspopup") || "").toLowerCase();
    const popup = !!pop && pop !== "false" && pop !== "listbox";
    const toggle = state === "false" || popup || summary || !!box;
    // Words read cheaply here (no layout); the full label only for the controls named in the end.
    if (!toggle && !wantWords.length && !targets.length) continue;
    const scope = c.getRootNode();
    const controlled = [c, box].filter(Boolean).flatMap((x) => (x.getAttribute("aria-controls") || "").split(/\s+/)).filter(Boolean).map((id) => scope.getElementById?.(id) || document.getElementById(id)).filter(Boolean);
    if (summary) controlled.push(c.parentElement);
    const words = wordsOf([c.getAttribute("aria-label"), c.getAttribute("title"), c.textContent, box?.getAttribute("aria-label")].filter(Boolean).join(" ").slice(0, 200));
    const role = c.getAttribute("role") || (c.matches("a[href]") ? "link" : c.matches("button, summary, input[type=checkbox]") ? "button" : "control");
    const href = c.matches("a[href]") ? c.getAttribute("href") || "" : "";
    const navigates = !!href && !/^\s*(#|javascript:)/i.test(href) && !c.hasAttribute("aria-controls") && !c.hasAttribute("aria-expanded") && c.getAttribute("role") !== "button";
    const anchor = !!href && /^\s*#/.test(href) && !c.hasAttribute("aria-controls") && !c.hasAttribute("aria-expanded");
    // A link to another site (whatever its ARIA says): never opened for the agent.
    const offsite = !!href && !/^\s*(#|javascript:)/i.test(href) && (() => { try { return new URL(c.href).origin !== location.origin; } catch { return true; } })();
    const shares = wantWords.some((x) => words.some((y) => y === x || (x.length >= 4 && y.length >= 4 && (y.startsWith(x) || x.startsWith(y)))));
    const where = { main: !!closest(c, "main, [role=main]"), foot: !!closest(c, "footer, [role=contentinfo]"), top: c.getBoundingClientRect().top + scrollY };
    let tier = 9, depth = 99, why = "";
    targets.forEach((t, i) => {
      // It opens the part holding it.
      if (controlled.some((x) => inside(x, t))) { tier = 1; depth = 0; why = "opens the part that holds it"; return; }
      // It sits next to it: the smallest box around both holds only a few controls.
      if (tier <= 2 && depth <= 1) return;
      if (inside(regions[i], c)) return;
      // (Close by: a few boxes up from the hidden part, never the page's body or main content.)
      for (let a = up(regions[i]), d = 1; a && d <= 4 && !a.matches("body, html, main, [role=main]"); a = up(a), d++) {
        if (!inside(a, c)) continue;
        if ((toggle || shares) && controlCount(a) <= 4 && (tier > 2 || (tier === 2 && d < depth))) { tier = 2; depth = d; why = "next to it"; }
        break;
      }
    });
    // The page's menu, collapsed (outside the main content and the footer): tier 3 when the hidden
    // part is outside the main content too.
    const menu = (state === "false" || !!box || popup) && !where.main && !where.foot;
    if (tier > 3 && menu && regions.some((r) => !closest(r, "main, [role=main]"))) { tier = 3; why = "a collapsed menu"; }
    if (tier > 4 && shares && (toggle || role === "button" || !where.main) && !where.foot) { tier = 4; why = "named like it"; }
    if (tier > 5 && menu) { tier = 5; why = "a collapsed menu"; }
    if (tier > 5 && toggle && !where.foot && !where.main && where.top < 600) { tier = 5; why = "collapsed"; }
    // A button in the page's header, an icon or a word or two, with no ARIA state (many hamburgers
    // and search buttons are built so): named, never opened for the agent (it may as well switch
    // the theme).
    const text = norm(c.textContent);
    if (tier > 5 && c.matches("button, [role=button]") && !where.main && !where.foot && !closest(c, "form") && where.top < 150 && (text ? text.split(" ").length <= 3 : !!c.querySelector("svg, img, i, span"))) { tier = 6; why = "a button in the page's header"; }
    if (tier > 6) continue;
    // Within a tier: what unfolds things in place first, a link to a spot on the page or elsewhere last.
    found.push({ el: c, box, controlled, role, ref: c._ariaRef?.ref || box?._ariaRef?.ref || "", why, tier, depth, top: where.top, navigates, offsite, toggle, shares, rank: toggle ? 0 : anchor || navigates ? 2 : 1 });
  }
  // Tier 3 counts only for the page's one collapsed menu; two menus are a choice for the agent.
  const menus = found.filter((f) => f.tier === 3);
  if (menus.length > 1) for (const f of menus) f.tier = 5;
  found.sort((a, b) => a.tier - b.tier || a.depth - b.depth || a.rank - b.rank || a.top - b.top);
  // The one control fast mode may open: it clearly unfolds what was asked for (it controls it, or a
  // part around it is folded and it's alone beside it), and a link that leaves the page only when
  // it's named like what was asked for. The page's menu in general (tier 3) is only named: a
  // guess at it would open notifications or a theme switch as often as the menu.
  let auto = -1;
  const best = found[0];
  if (best && (best.tier === 1 || (best.tier === 2 && folded.some(Boolean))) && !(found[1] && found[1].tier === best.tier && found[1].depth === best.depth && found[1].rank === best.rank)) {
    // Never a button that only runs the page's scripts ("Subscribe to newsletter" beside a hidden
    // "Newsletter email"): a disclosure by its markup, or a link named like what was asked for.
    const ok = best.tier === 1 || best.toggle || (best.shares && best.role === "link" && !!best.el.getAttribute("href"));
    if (ok && !best.offsite && (!best.navigates || best.shares)) auto = 0;
  }
  // Its accessible name first (what the snapshot calls it), else its label as the page shows it.
  const labelOf = (f) => norm(f.el.getAttribute("aria-label") || f.el.innerText || buttonLabel(f.el) || f.box?.getAttribute("aria-label") || f.controlled[0]?.getAttribute("aria-label") || "").slice(0, 60);
  const list = found.slice(0, opts.max || 5).map((f, i) => ({ role: f.role, name: labelOf(f), ref: f.ref, why: f.why, tier: f.tier, auto: i === auto }));
  // Where a hidden link goes: the agent can open that address when nothing unfolds it. Its origin
  // and path only: a page's query string or fragment can carry anything (a token, an instruction).
  const link = targets.find((t) => t.matches("a[href]") && /^https?:/i.test(t.href));
  const href = link ? (() => { const u = new URL(link.href); return (u.origin + u.pathname).slice(0, 300); })() : "";
  const out = { hidden: targets.length > 0, list, auto, href };
  return opts.pick ? { scan: out, el: auto === 0 ? best.el : null } : out;
}

const scanIn = withHelpers(([want, opts]) => revealScan(want, opts), revealScan, isVisible, buttonLabel);
const scanAt = withHelpers((el, [want, opts]) => revealScan(want, { ...opts, target: el }), revealScan, isVisible, buttonLabel);

// The scan on a page (its main frame) or for an element (a locator or handle): bounded, null when
// the page didn't answer in time.
export async function scanReveal(page, want, { target = null, max = REVEAL_MAX, ms = 2500, exact = false } = {}) {
  try {
    const run = target ? target.evaluate(scanAt, [String(want || ""), { max }], { timeout: ms }) : page.evaluate(scanIn, [String(want || ""), { max, exact }]);
    return (await within(ms, run.catch(() => null))) ?? null;
  } catch {
    return null;
  }
}

// The scan, with the one control fast mode may open as an element handle (the very element the
// scan chose): { scan, el }, el null when there is none; null when the page didn't answer.
export async function pickReveal(page, want, { max = REVEAL_MAX, ms = 2500, exact = false } = {}) {
  let h = null;
  try {
    const run = page.evaluateHandle(scanIn, [String(want || ""), { max, exact, pick: true }]);
    h = await within(ms, run.catch(() => null));
    if (!h) { run.then((x) => x?.dispose(), () => {}); return null; }
    const scan = await within(1000, h.getProperty("scan").then((p) => p.jsonValue()).catch(() => null));
    if (!scan) return null;
    const prop = await within(1000, h.getProperty("el").catch(() => null));
    const el = prop?.asElement?.() || null;
    if (!el) prop?.dispose().catch(() => {});
    return { scan, el };
  } catch {
    return null;
  } finally {
    h?.dispose().catch(() => {});
  }
}

// One control as an agent reads it: its role and name, its ref, and why it's named.
export function revealItem(c) {
  const what = c.name ? `${c.role === "control" ? "toggle" : c.role} "${c.name}"` : `an unnamed ${c.role === "control" ? "menu toggle" : c.role}`;
  return `${what} (${[c.ref && `ref ${c.ref}`, c.why].filter(Boolean).join(", ")})`;
}

// The sentence a failed look ends with: the controls that may unfold it, or "" when there are none.
export function revealNote(scan) {
  const list = scan?.list || [];
  if (!list.length) return "";
  const head = scan.hidden
    ? `It's on the page, hidden behind a control (a search box or menu that opens on a click; narrow windows fold more of them).`
    : `It may be behind a control that opens it (a search box or menu that opens on a click; narrow windows fold more of them).`;
  return ` ${head} Open ${list.length > 1 ? "one of these" : "this"}, then try again: ${list.slice(0, REVEAL_MAX).map(revealItem).join("; ")}.`;
}

// The line under a whole-page snapshot of a narrow page: its folded controls, or "".
export function foldedLine(scan) {
  const list = (scan?.list || []).filter((c) => c.tier >= 3 && c.tier <= 5);
  if (!list.length) return "";
  return `- This page is laid out for a narrow window: some of it is folded behind ${list.map(revealItem).join("; ")}. Open one when what you need isn't in the snapshot.`;
}
