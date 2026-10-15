// The browser's bubbles (530 E1) as a page opens them: the strip's Share and app menu, the
// timeline's picture. A flat file at the ui/ root (the native build refuses a ui/<dir> without
// index.html); definitions only, nothing runs on import.

// The browser can open a bubble for this page (window.pairbrowse.bubbles, a newer browser).
export const hasBubbles = (pb) => typeof pb?.bubbles?.open === "function";

// A trigger's box in this page's CSS pixels, rounded outward and kept inside the page (the browser
// refuses an anchor outside its slot).
export function anchorRect(node) {
  const r = node.getBoundingClientRect();
  const x = Math.max(0, Math.floor(r.left)), y = Math.max(0, Math.floor(r.top));
  const right = Math.min(window.innerWidth, Math.ceil(r.right)), bottom = Math.min(window.innerHeight, Math.ceil(r.bottom));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

// A click outside closes a bubble before that click lands: when it lands on that bubble's own
// trigger it is the close, not a new open. The browser says it closed (OnClosed, not by Escape),
// and how recently is kept per key (a bubble kind, a card): a timestamp, no timer. A close this page
// asked for itself (a second press on the trigger) never blocks the next open.
export const REOPEN_MS = 400;
export function reopenGuard(ms = REOPEN_MS) {
  const closedAt = new Map(); // key -> when the browser closed it
  const own = new Set(); // keys this page is closing
  return {
    // This page closes key itself.
    closing: (key) => { own.add(key); },
    // The browser's OnClosed for key. -> true when this page asked for it.
    closed(key, byEscape) {
      const mine = own.delete(key);
      if (!byEscape && !mine) closedAt.set(key, performance.now());
      return mine;
    },
    // An open of key now would be the click that just closed it.
    blocked: (key) => performance.now() - (closedAt.get(key) ?? -Infinity) < ms,
  };
}
