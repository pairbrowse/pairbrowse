// Reading and filling a shared tab's form fields, in the page and its frames (tabsync.mjs decides
// what may cross). A value from the other side is set the way a framework notices (the value
// itself, then an "input" event) and nothing more: no key presses, no "change", no submit, so a
// site's own handlers that send a form never run because of it. Sensitive fields here never take
// a value from there; they show "filled by ..." in their placeholder instead.
import { randomBytes } from "node:crypto";
import { formUrl, onSecretDomain, FIELDS_MAX } from "../tabsync.mjs";
import { within } from "../util.mjs";

const FRAMES_MAX = 6;
const READ_MS = 1500;
// Where a field's own placeholder is kept while it shows "filled by ...": a name new each time
// the helper starts, so a page can't count on it.
const MARK = `__pb${randomBytes(6).toString("hex")}`;

// Runs in the page: mode "read" lists the fields; mode "apply" sets the given ones. Fields are
// keyed the same way both times: a unique id, else name (plus value for checkboxes and radios),
// else label, else position; a repeated key gets "#n".
function inPage([mode, max, mark, list, who]) {
  const out = [];
  const keys = new Map();
  const byKey = new Map();
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 8; n = n.parentElement) {
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(`${n.tagName.toLowerCase()}:${i}`);
    }
    return parts.join("/");
  };
  for (const el of document.querySelectorAll("input, textarea, select")) {
    if (byKey.size >= max) break;
    const tag = el.tagName;
    const type = tag === "INPUT" ? String(el.type || "text").toLowerCase() : tag.toLowerCase();
    if (/^(hidden|submit|button|reset|image|file)$/.test(type)) continue;
    if (!el.getClientRects().length) continue; // not on screen: hidden fields often carry tokens
    const label = String(el.getAttribute("aria-label") || el.labels?.[0]?.innerText || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const id = el.id && !/\d{5,}/.test(el.id) && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1 ? el.id : "";
    const name = el.getAttribute("name") || "";
    let key = id ? `#${id}` : name ? `n:${name}${type === "checkbox" || type === "radio" ? `=${el.value}` : ""}` : label ? `l:${label}` : `p:${path(el)}`;
    const n = keys.get(key) || 0;
    keys.set(key, n + 1);
    if (n) key += `#${n}`;
    key = key.slice(0, 200);
    byKey.set(key, { el, type });
    if (mode !== "read") continue;
    const v = type === "checkbox" || type === "radio" ? el.checked : type === "select" ? [...el.selectedOptions].map((o) => o.value) : String(el.value);
    const hints = [label, name, el.id, el.getAttribute("autocomplete") || "", el.getAttribute("placeholder") || "", el.getAttribute("inputmode") === "numeric" && /code/i.test(label) ? "code" : ""].join(" ").slice(0, 300);
    out.push({ k: key, t: type, v, hints });
  }
  if (mode === "read") return out;
  const sensitive = (el, type) => type === "password" || /cc-|one-time-code|password/i.test(el.getAttribute("autocomplete") || "");
  const set = (el, prop, value) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, prop)?.set?.call(el, value);
  };
  const done = [];
  for (const x of list) {
    const hit = byKey.get(x.k);
    if (!hit || hit.type !== x.t) continue;
    const { el, type } = hit;
    if (x.m || sensitive(el, type)) {
      // Filled there: say so here, without a value (only on an empty field).
      if (!(mark in el)) Object.defineProperty(el, mark, { value: el.getAttribute("placeholder"), writable: true, enumerable: false });
      if (x.m && x.filled && !el.value) el.setAttribute("placeholder", `•••••• (filled by ${who})`);
      else if (el[mark] === null) el.removeAttribute("placeholder"); else el.setAttribute("placeholder", el[mark]);
      done.push(x.k);
      continue;
    }
    if (type === "checkbox" || type === "radio") { if (el.checked === !!x.v) { done.push(x.k); continue; } set(el, "checked", !!x.v); }
    else if (type === "select") { for (const o of el.options) o.selected = x.v.includes(o.value); }
    else {
      if (el.value === x.v) { done.push(x.k); continue; }
      // Someone here has this field focused: their caret stays where it was.
      let sel = null;
      if (el === document.activeElement) try { sel = [el.selectionStart, el.selectionEnd]; } catch {}
      set(el, "value", x.v);
      if (sel && sel[0] !== null) try { el.setSelectionRange(Math.min(sel[0], x.v.length), Math.min(sel[1], x.v.length)); } catch {}
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    done.push(x.k);
  }
  return done;
}

// The frames of a page whose fields may cross, each with a key the other side's copy shares:
// "top", or the frame's origin and path (plus "#n" for repeats). Never frames on secretDomains.
function framesOf(page, secretDomains) {
  const out = [];
  const seen = new Map();
  for (const frame of page.frames().slice(0, FRAMES_MAX * 2)) {
    if (out.length >= FRAMES_MAX) break;
    const url = frame.url();
    if (onSecretDomain(url, secretDomains)) continue;
    if (frame === page.mainFrame()) { out.push({ frame, key: "top" }); continue; }
    const base = formUrl(url);
    if (!base) continue;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.push({ frame, key: n ? `${base}#${n}` : base });
  }
  return out;
}

// The page's fields, as read here (tabsync's shareFields decides what crosses), or null when the
// page itself can't share any (not a web page, or a secret domain).
export async function readFields(page, secretDomains = []) {
  const url = formUrl(page.url());
  if (!url || onSecretDomain(page.url(), secretDomains)) return null;
  const fields = [];
  for (const { frame, key } of framesOf(page, secretDomains)) {
    const list = await within(READ_MS, frame.evaluate(inPage, ["read", FIELDS_MAX, MARK, [], ""]).catch(() => null));
    for (const x of Array.isArray(list) ? list : []) if (fields.length < FIELDS_MAX) fields.push({ ...x, f: key });
  }
  return { url, fields };
}

// Sets fields (already checked) in the page; returns the ones now showing those values.
export async function applyFields(page, fields, who, secretDomains = []) {
  const done = [];
  for (const { frame, key } of framesOf(page, secretDomains)) {
    const mine = fields.filter((x) => x.f === key);
    if (!mine.length) continue;
    const keys = await within(READ_MS, frame.evaluate(inPage, ["apply", FIELDS_MAX, MARK, mine, String(who).slice(0, 60)]).catch(() => null));
    if (Array.isArray(keys)) done.push(...mine.filter((x) => keys.includes(x.k)));
  }
  return done;
}
