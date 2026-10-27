// The part of a handed-over tab that matters, for the phone viewer's first zoom (liveview-turn.js):
// a rectangle in the tab's viewport (CSS px) with the viewport's size, or null. Read from the page's
// layout alone, no site list: the largest visible frame that is not the whole page (a verification
// widget, a card form, a sign-in pop-in are frames), else the focused field with its form, else the
// box around the page's visible fields and buttons. Bounded: a page that doesn't answer gives null.
import { within } from "../util.mjs";

export const FOCUS_MS = 1500;

// Runs in the page: its own rectangles only, nothing of its text or values.
function readFocus() {
  const vw = innerWidth, vh = innerHeight;
  const seen = (r) => r.width >= 8 && r.height >= 8 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
  const shown = (e) => { const s = getComputedStyle(e); return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05; };
  const clip = (r) => { const x = Math.max(0, r.left), y = Math.max(0, r.top); return { x, y, w: Math.min(vw, r.right) - x, h: Math.min(vh, r.bottom) - y }; };
  const out = (r, kind) => { const c = clip(r); return c.w >= 8 && c.h >= 8 ? { ...c, vw, vh, kind } : null; };
  let best = null, area = 0;
  for (const f of document.querySelectorAll("iframe, frame")) {
    const r = f.getBoundingClientRect();
    const a = r.width * r.height;
    if (!seen(r) || r.width < 60 || r.height < 60 || a > vw * vh * 0.6 || !shown(f)) continue;
    if (a > area) { area = a; best = r; }
  }
  if (best) return out(best, "frame");
  const a = document.activeElement;
  if (a && a !== document.body && a !== document.documentElement && a.matches?.("input, textarea, select, [contenteditable]")) {
    const box = (a.closest("form") || a).getBoundingClientRect();
    if (seen(box) && box.width * box.height < vw * vh * 0.8) return out(box, "field");
    const r = a.getBoundingClientRect();
    if (seen(r)) return out(r, "field");
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (const e of document.querySelectorAll("input:not([type=hidden]), select, textarea, button, [role=button], [role=checkbox]")) {
    if (n > 200) break;
    const r = e.getBoundingClientRect();
    if (!seen(r) || !shown(e)) continue;
    n++;
    x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
  }
  if (!n) return null;
  return out({ left: x0 - 16, top: y0 - 16, right: x1 + 16, bottom: y1 + 16 }, "fields");
}

// A sane rectangle or null.
export function cleanFocus(f) {
  if (!f || typeof f !== "object") return null;
  const n = (v) => (Number.isFinite(v) ? Math.round(v) : NaN);
  const r = { x: n(f.x), y: n(f.y), w: n(f.w), h: n(f.h), vw: n(f.vw), vh: n(f.vh) };
  if (Object.values(r).some(Number.isNaN) || r.vw < 1 || r.vh < 1 || r.w < 1 || r.h < 1 || r.x < 0 || r.y < 0 || r.x + r.w > r.vw + 1 || r.y + r.h > r.vh + 1) return null;
  return { ...r, kind: ["frame", "field", "fields"].includes(f.kind) ? f.kind : "fields" };
}

// page: the tab on screen. The focus rectangle, or null.
export async function focusOf(page) {
  if (!page || page.isClosed?.()) return null;
  const got = await within(FOCUS_MS, Promise.resolve().then(() => page.evaluate(readFocus)).catch(() => null));
  return cleanFocus(got);
}
