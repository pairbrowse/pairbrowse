// Motion (DESIGN.md Part I), the same for every page: the sheet's tokens (tokens.css). Shared by
// the pages and the live view (common.js re-exports it; the live view serves it). A flat file at
// the ui/ root; definitions only, nothing runs on import.
// Rows, cards and tabs that join or leave a list move in and out instead of jumping; a page that is
// hidden, a node not on screen and reduced motion get the end state at once. No timer and no frame
// loop: the browser runs each animation and its finished promise ends it.
export const calm = () => { try { return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches !== false; } catch { return true; } };
function timing(open) {
  const cs = getComputedStyle(document.documentElement);
  const duration = Number.parseFloat(cs.getPropertyValue(open ? "--dur-open" : "--dur-close")) || (open ? 160 : 120);
  return { duration, easing: cs.getPropertyValue(open ? "--ease-out" : "--ease-in").trim() || "ease-out" };
}
const still = (node) => calm() || document.hidden || !node?.isConnected || typeof node.animate !== "function";
const px = (name) => `${Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 4}px`;
// A node that just joined its list: it grows from nothing to its size (height, or width for a tab
// in a row: axis "inline") and fades in, so what is after it slides along; axis "fade" only fades.
export function enter(node, { axis = "block" } = {}) {
  if (still(node)) return null;
  // "fade": the same box with new content (a dock's open and rail): opacity only.
  if (axis === "fade") return node.animate([{ opacity: 0 }, { opacity: 1 }], timing(true));
  const r = node.getBoundingClientRect();
  const from = axis === "inline"
    ? { opacity: 0, minWidth: "0px", maxWidth: "0px", width: "0px", paddingInline: "0px" }
    : { opacity: 0, height: "0px", paddingBlock: "0px", marginBlock: "0px", translate: `0 -${px("--rise")}` };
  const to = axis === "inline" ? { opacity: 1, minWidth: `${r.width}px`, maxWidth: `${r.width}px`, width: `${r.width}px` } : { opacity: 1, height: `${r.height}px`, translate: "0 0" };
  const was = node.style.overflow;
  node.style.overflow = "clip";
  const a = node.animate([from, to], timing(true));
  const done = () => { node.style.overflow = was; };
  a.finished.then(done, done);
  return a;
}
// A node leaving its list: it fades and folds to nothing (out of reach and out of the reading
// order meanwhile, data-leaving set), then is removed; then() runs after.
export function leave(node, { axis = "block", then } = {}) {
  const gone = () => { node.remove(); then?.(); };
  if (still(node)) { gone(); return; }
  node.dataset.leaving = "true";
  node.inert = true;
  node.setAttribute("aria-hidden", "true");
  const r = node.getBoundingClientRect();
  const frames = axis === "inline"
    ? [{ opacity: 1, minWidth: `${r.width}px`, maxWidth: `${r.width}px`, width: `${r.width}px` }, { opacity: 0, minWidth: "0px", maxWidth: "0px", width: "0px", paddingInline: "0px", borderWidth: "0px" }]
    : [{ opacity: 1, height: `${r.height}px` }, { opacity: 0, height: "0px", paddingBlock: "0px", marginBlock: "0px", borderWidth: "0px" }];
  node.style.overflow = "clip";
  node.animate(frames, { ...timing(false), fill: "forwards" }).finished.then(gone, gone);
}
// A keyed list (each child's data-key) drawn again: rows that stay are replaced in place (keeping
// a focused control focused when the new row has one of the same name), new rows enter, gone rows
// leave. The first draw only places the rows.
export function syncList(box, next) {
  const first = box.dataset.listed !== "true";
  box.dataset.listed = "true";
  const old = new Map();
  for (const n of [...box.children]) {
    if (n.dataset.leaving) continue;
    if (n.dataset.key && !old.has(n.dataset.key)) old.set(n.dataset.key, n);
    else n.remove();
  }
  const keys = new Set(next.map((n) => n.dataset.key));
  for (const [k, n] of old) if (!keys.has(k)) leave(n);
  const added = [];
  for (const n of next) {
    const o = old.get(n.dataset.key);
    if (!o) { added.push(n); continue; }
    if (o === n) continue;
    const had = o.contains(document.activeElement) ? document.activeElement : null;
    o.replaceWith(n);
    if (had) {
      const name = had.getAttribute("aria-label");
      const same = (name && [...n.querySelectorAll("[aria-label]")].find((x) => x.getAttribute("aria-label") === name))
        || (had.className && n.querySelector(`.${String(had.className).trim().split(/\s+/).join(".")}`));
      same?.focus?.();
    }
  }
  let prev = null;
  for (const n of next) {
    let at = prev ? prev.nextSibling : box.firstChild;
    while (at && at !== n && at.dataset?.leaving) at = at.nextSibling;
    if (at !== n) box.insertBefore(n, at);
    prev = n;
  }
  if (!first) for (const n of added) enter(n);
}
// A container just shown again (a tab's pane, a dock back from its rail): what folds or pops inside
// it is drawn as it was, with no motion of its own (tokens.css [data-entering]); only the container
// itself moves. Call it right after the container is shown.
export function revealed(node) {
  if (!node) return;
  node.dataset.entering = "";
  document.documentElement.getBoundingClientRect(); // the style, computed with the folds held still
  delete node.dataset.entering;
}
// A control whose request is out: aria-busy while work() runs (tokens.css draws the bar after
// 300 ms); the control keeps the focus (it is not disabled). -> work()'s result.
export async function busy(btn, work) {
  btn?.setAttribute("aria-busy", "true");
  try { return await work(); } finally { btn?.removeAttribute("aria-busy"); }
}
