// Fast mode's dropdowns: native selects, styled dropdowns and suggestion lists, opened and chosen
// in as a person would, the choice matched to what was asked.
import { within, bounded } from "../util.mjs";
import { findIn, formRoots } from "./locate.mjs";

// What a click or typing opens: the short texts that show now and didn't before (a dropdown's
// choices, a field's suggestions), whatever the list is built from: role="option" or plain
// elements (many dropdown libraries). before(root): marks what shows now; after(root): the new
// texts, each clickable by its index (choiceAt). Works in the page or a frame.
// Both look through open shadow roots too (a list built as a web component), and read a choice
// with no text of its own (an icon, a flag, a colour swatch) by its accessible name: aria-label,
// aria-labelledby, title or its picture's alt text.
const markShown = (mark) => {
  const all = (root, out = []) => { for (const el of root.querySelectorAll("*")) { out.push(el); if (el.shadowRoot) all(el.shadowRoot, out); } return out; };
  const optionLike = (el) => /^(option|menuitem|menuitemradio|treeitem)$/.test(el.getAttribute("role") || "") || el.tagName === "LI" || (!(el.innerText || "").trim() && el.hasAttribute("aria-label"));
  for (const el of all(document.body)) {
    if (el.children.length && !optionLike(el)) continue;
    const r = el.getBoundingClientRect();
    // Seen means a person sees it: a list drawn in advance but invisible (visibility, opacity)
    // shows its choices only once opened.
    if (r.width > 0 && r.height > 0 && el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) !== false) el.setAttribute("data-pb-seen", mark);
  }
};
const newlyShown = (arg) => {
  const [mark, near] = Array.isArray(arg) ? arg : [arg, null];
  const out = [];
  const all = (root, out2 = []) => { for (const el of root.querySelectorAll("*")) { out2.push(el); if (el.shadowRoot) all(el.shadowRoot, out2); } return out2; };
  const everything = all(document.body);
  // Marks from an earlier look (a list that redrew as it was typed into) would point at old rows.
  for (const el of everything) if ((el.getAttribute("data-pb-choice") || "").startsWith(`${mark}-`)) el.removeAttribute("data-pb-choice");
  const nameOf = (el) => {
    const own = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (own) return own;
    const byIds = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean).map((id) => el.getRootNode().getElementById?.(id)?.textContent || "").join(" ");
    return (el.getAttribute("aria-label") || byIds || el.getAttribute("title") || el.querySelector?.("img[alt], [aria-label]")?.getAttribute("alt") || el.querySelector?.("[aria-label]")?.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  };
  for (const el of everything) {
    if (el.getAttribute("data-pb-seen") === mark) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) continue;
    const t = nameOf(el);
    // A choice: short text of its own (a leaf, or an option-like element), not a field, not filler.
    if (!t || t.length > 80 || !/[\p{L}\p{N}]/u.test(t) || /^(INPUT|TEXTAREA|SELECT|SCRIPT|STYLE)$/.test(el.tagName) || (el.tagName === "LABEL" && el.control)) continue;
    const optionLike = /^(option|menuitem|menuitemradio|treeitem)$/.test(el.getAttribute("role") || "") || el.tagName === "LI" || (!(el.innerText || "").trim() && el.hasAttribute("aria-label"));
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
  for (const el of everything) if (el.getAttribute("data-pb-seen") === mark) el.removeAttribute("data-pb-seen");
  return out.slice(0, 400).map((o) => o.t);
};
const rectOf = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
export async function choicesBefore(page) {
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
export async function clearChoices(page, mark) {
  for (const root of await formRoots(page)) await within(1000, root.evaluate((m) => { const all = (r, out = []) => { for (const el of r.querySelectorAll("[data-pb-choice], *")) { if (el.hasAttribute("data-pb-choice")) out.push(el); if (el.shadowRoot) all(el.shadowRoot, out); } return out; }; for (const el of all(document)) if (el.getAttribute("data-pb-choice").startsWith(m)) el.removeAttribute("data-pb-choice"); }, mark).catch(() => {}));
}
// A styled list opened by clicking `opener`: the choice matching option, clicked. Returns "" when
// clicked, else why not (with the choices it saw).
export async function pickFromOpened(page, opener, option, label, hooks) {
  let mark = await choicesBefore(page);
  try {
    await hooks.cursor?.(opener, "click");
    // Covered by a menu still open from before: close it as a person would (Escape), then again.
    const opened = await opener.click({ timeout: 2500 }).then(() => true, async () => {
      await within(3000, page.keyboard.press("Escape").catch(() => {}));
      await opener.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await hooks.cursor?.(opener, "click"); // it moved: the press is declared where it is now
      return opener.click({ timeout: 3000 }).then(() => true, () => false);
    });
    if (!opened) return `"${label}" couldn't be opened: something covers it (a banner, a chat box, another open list) or it's disabled. Look at the screenshot, close what covers it, then try again.`;
    let choices = [];
    const near = await bounded(opener.evaluate(rectOf, null, { timeout: 1000 }), null); // in its own frame
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
      const same = typed && await bounded(opener.evaluate((n) => n === document.activeElement || n.contains(document.activeElement)), true);
      if (typed && !same) {
        await within(8000, page.keyboard.type(String(option), { delay: 10 }).catch(() => {}));
        for (const until = Date.now() + SUGGEST_MS; Date.now() < until && !best; await new Promise((r) => setTimeout(r, 80))) best = bestChoice(await choicesAfter(page, mark, near), option);
      }
    }
    // A list that filled in late or redrew while it was read (a form in a frame from another site):
    // closed and opened once more, then given longer.
    if (!best) {
      await within(3000, page.keyboard.press("Escape").catch(() => {}));
      await clearChoices(page, mark);
      const again = await choicesBefore(page);
      await hooks.cursor?.(opener, "click"); // declared once more: the first declaration may have run out
      if (await opener.click({ timeout: 2500 }).then(() => true, () => false)) {
        for (const until = Date.now() + 2 * SUGGEST_MS; Date.now() < until && !best; await new Promise((r) => setTimeout(r, 100))) {
          choices = await choicesAfter(page, again, near);
          best = bestChoice(choices, option);
        }
        if (best) mark = again; else await clearChoices(page, again);
      }
    }
    if (!best) {
      await within(3000, page.keyboard.press("Escape").catch(() => {}));
      // No choice could be read at all (pictures with no name, a list drawn on a canvas): the
      // agent looks for itself instead of trying other spellings.
      return `Opened "${label}" but found no option "${option}".${choices.length ? ` Its options: ${choices.map((c) => c.text).slice(0, 25).join(", ")}.` : " Its list shows nothing readable (pictures or icons without names): look at the screenshot, take a browser_snapshot, and click the choice by its ref with browser_click."}`;
    }
    // Lists that redraw their options under the pointer replace the marked one: then the visible
    // option with that exact text.
    // The option scrolled into view first, so the cursor shows where the click lands: its own, not a person's.
    await choiceAt(best, mark).scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    await hooks.cursor?.(choiceAt(best, mark), "click");
    const clicked = await choiceAt(best, mark).click({ timeout: 1500 }).then(() => true, async () => {
      const again = await findIn(best.root, [(r) => r.getByRole("option", { name: best.text, exact: true }), (r) => r.getByText(best.text, { exact: true })]);
      if (again) await hooks.cursor?.(again, "click"); // another element: its own declaration
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
export async function pickSuggestion(page, el, value, mark, typed = "", hooks = {}) {
  if (!String(value).trim()) return { picked: "", seen: [] };
  let choices = [];
  const near = await bounded(el.evaluate(rectOf, null, { timeout: 1000 }), null); // in its own frame
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

// A native <select> chosen as its own list would (no click: it may be drawn invisible over or under
// a styled box), with the events a person's choice fires. The option by its text or value, else the
// one option holding that text ("United States" for "US - United States").
export async function chooseNative(sel, option) {
  return within(5000, sel.evaluate((n, want) => {
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
  }, String(option)).then((r) => r, () => ({ options: [] }))).then((r) => r ?? { options: [] });
}
// A native <select> named exactly that (its label, aria-label, name or id), shown or drawn invisible.
export async function nativeNamed(page, label) {
  for (const root of await formRoots(page)) {
    const all = root.locator("select");
    const i = await bounded(all.evaluateAll((els, want) => {
      const norm = (t) => String(t || "").replace(/[\s*:]+/g, " ").trim().toLowerCase();
      const w = norm(want);
      const hits = els.map((n, i) => ([...(n.labels || [])].some((l) => norm(l.innerText) === w) || norm(n.getAttribute("aria-label")) === w || n.name === want || n.id === want) && !n.disabled && n.closest("body") && getComputedStyle(n).display !== "none" && n.parentElement?.getBoundingClientRect().width > 0 ? i : -1).filter((i) => i >= 0);
      return hits.length === 1 ? hits[0] : -1;
    }, label), -1);
    if (i >= 0) return all.nth(i);
  }
  return null;
}

// A label whose for= points at nothing (or at a hidden input), next to the one control that opens
// its list (a button, often unnamed: "open menu"): that control.
export async function labelOpener(page, label) {
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
export async function hiddenDropdown(page, label) {
  for (const root of await formRoots(page)) {
    for (const loc of [root.getByRole("combobox", { name: label, exact: true }), root.getByRole("textbox", { name: label, exact: true }), root.getByLabel(label, { exact: true }), root.getByLabel(label)]) {
      const el = loc.first();
      if (!(await bounded(el.count(), 0)) || (await bounded(el.isVisible(), false))) continue;
      // The box is marked for the one click that opens it, then unmarked (select, below).
      const mark = `d${Math.random().toString(36).slice(2, 10)}`;
      const marked = await bounded(el.evaluate((n, mark) => {
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
      }, mark), false);
      if (marked) return Object.assign(root.locator(`[data-pb-dropdown="${mark}"]`), { field: el });
    }
  }
  return null;
}
