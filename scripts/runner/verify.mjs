// Fast mode's after-run checks: the fields a run touched (Touched), values the page rewrote a
// moment later, problems the page shows, and required fields left empty.
import { sleep, within, bounded } from "../util.mjs";
import { settle } from "../daemon/page.mjs";
import { formRoots } from "./locate.mjs";
import { sameDate } from "./dates.mjs";

// The fields a run filled or chose in, each with what it showed right after (seen, a promise) and
// when: what lateRewrites compares against.
// Each is also held by its element (handle): a field found by a name the page then changes (a
// dropdown that shows its choice in its name, a label that moves) is still read at once, never
// waited for by a name nothing has any more.
export class Touched extends Array {
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
  // One match only: with two fields of that name, reading the other one would blame the wrong field.
  if (typeof t.el?.count === "function" && (await bounded(t.el.count(), 0)) !== 1) return null;
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
export async function lateRewrites(page, touched) {
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
export async function leftovers(page, touched) {
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
        // A label's text as a person sees it: hidden helper text inside it (a "Validation Error"
        // kept for screen readers, clipped to nothing) stays out, and two labels saying the same
        // thing (one visible, one for screen readers) count once.
        const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 1 && r.height > 1 && st.clip === "auto" && st.visibility !== "hidden"; };
        const textOf = (node) => !node ? "" : node.nodeType === 3 ? node.textContent : node.nodeType !== 1 || !vis(node) ? "" : [...node.childNodes].map(textOf).join(" ");
        const once = (texts) => [...new Set(texts.map(clean).filter(Boolean))].join(" ");
        const nameOf = (el) => clean((once([...(el.labels || [])].map(textOf)) || el.getAttribute("aria-label") || once((el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.innerText || "")) || el.placeholder || el.title || near(el) || el.name).replace(/"/g, "'"));
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
        const overlayOf = (el) => { for (let a = el.parentElement, i = 0; a && a !== document.body && i < 30; a = a.parentElement, i++) if (getComputedStyle(a).position === "fixed") return a; return null; };
        const required = (el) => el.required || el.getAttribute("aria-required") === "true";
        const res = { required: [], optional: [] };
        const radios = new Map();
        for (const el of all) {
          if (!inScope(el) || el.disabled || el.readOnly || !shown(el)) continue;
          if (/^(hidden|submit|button|image|reset|file|password|search|range|color)$/i.test(el.type)) continue;
          // A site's search box, or a chat widget's input (a box fixed over the page that the run
          // never touched), is no field of this form, whatever box it shares with it.
          if (el.getAttribute("role") === "searchbox" || el.closest("[role=search], [role=searchbox], [role=log]")) continue;
          const over = overlayOf(el);
          if (over && !touched.some((t) => over.contains(t))) continue;
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
export async function fieldProblems(touched) {
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
