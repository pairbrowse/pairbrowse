// Card fields covered in pictures that leave the host's own screen: recordings, the session
// timeline's pictures, and what joiners and live view guests see of the host's tabs. The host's
// own live screen and the screenshots the host's agent gets stay as they are.
//
// Covered: an input or textarea sensitive by its own kind (policy.mjs sensitiveHints: card
// number, security code, expiry, one-time code, password and the like) or whose value is a card
// number (looksLikeCard), and every text that holds a card number (maskCards would mask it). In
// every frame, a child frame's rectangles mapped into the main viewport through its frame
// element's box (clipped to it). A child frame that doesn't answer is covered whole: what it
// shows is unknown. Rectangles are fractions of the main viewport: [x, y, w, h], each 0..1.
import { sensitiveHints, looksLikeCard, maskCards } from "../rules/policy.mjs";
import { within } from "../util.mjs";

export const COVER_COLOR = "#293B50"; // ui/tokens.css --edge; ui/capture/capture.js COVER_COLOR
const FRAMES_MAX = 20;
const PAGE_MS = 600; // one frame's read, at most
const PAD = 4; // CSS pixels around each cover: a picture taken a moment later may have moved a little
export const RECTS_MAX = 200; // past this many, the whole view is covered

// In the page (each frame): candidates only; the checks run in the helper (policy.mjs).
// { w, h, fields: [[hints, value, x, y, w, h]], texts: [[run, x, y, w, h]] } in the frame's own
// viewport, CSS pixels. Bounded: 300 fields, 5000 text nodes, 3000 elements looked through for
// open shadow roots.
export const pageCovers = () => {
  const W = innerWidth, H = innerHeight;
  const seen = (r) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H;
  const roots = [document];
  let looked = 0;
  for (let i = 0; i < roots.length && looked < 3000; i++) {
    for (const el of roots[i].querySelectorAll("*")) {
      if (++looked > 3000) break;
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  const SKIP = new Set(["checkbox", "radio", "hidden", "submit", "button", "file", "image", "reset", "range", "color"]);
  const fields = [];
  for (const root of roots) {
    for (const el of root.querySelectorAll("input, textarea")) {
      if (fields.length >= 300) break;
      if (SKIP.has(el.type)) continue;
      const r = el.getBoundingClientRect();
      if (!seen(r)) continue;
      const hints = [el.type, el.getAttribute("autocomplete"), el.getAttribute("inputmode"), el.name, el.id, el.getAttribute("aria-label"), el.labels?.[0]?.innerText, el.placeholder].map((x) => String(x || "").replace(/\s+/g, " ").slice(0, 80)).join(" ");
      fields.push([hints, String(el.value || "").slice(0, 40), r.left, r.top, r.width, r.height]);
    }
  }
  const texts = [];
  const RUN = /(?<!\d)(?:\d[ \t\u00a0-]{0,3}){12,}\d(?!\d)/g;
  let nodes = 0;
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && nodes < 5000 && texts.length < 300; n = walker.nextNode()) {
      nodes++;
      const s = n.nodeValue;
      if (!s || s.length < 13 || !/\d/.test(s)) continue;
      const tag = n.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "NOSCRIPT") continue;
      for (const m of s.matchAll(RUN)) {
        const range = document.createRange();
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        const r = range.getBoundingClientRect();
        if (seen(r)) texts.push([m[0].replace(/[\t\u00a0]/g, " "), r.left, r.top, r.width, r.height]);
      }
    }
  }
  return { w: W, h: H, fields, texts };
};

const num = (n) => typeof n === "number" && Number.isFinite(n);
// What in one frame's read is covered: [[x, y, w, h]] in that frame's CSS pixels.
export function hitsOf(read) {
  const out = [];
  for (const f of Array.isArray(read?.fields) ? read.fields : []) {
    if (!Array.isArray(f) || f.length < 6) continue;
    const [hints, value, ...r] = f;
    if (!r.every(num)) continue;
    if (sensitiveHints(String(hints ?? "")) || looksLikeCard(String(value ?? ""))) out.push(r);
  }
  for (const t of Array.isArray(read?.texts) ? read.texts : []) {
    if (!Array.isArray(t) || t.length < 5) continue;
    const [run, ...r] = t;
    if (!r.every(num)) continue;
    if (maskCards(String(run ?? "")) !== String(run ?? "")) out.push(r);
  }
  return out;
}

// A child frame's rectangles (in its own viewport of fw x fh) in the main viewport, through its
// frame element's box there ({ x, y, width, height }), clipped to that box.
export function mapToFrame(rects, fw, fh, box) {
  if (!box || !(box.width > 0) || !(box.height > 0) || !(fw > 0) || !(fh > 0)) return [];
  const sx = box.width / fw, sy = box.height / fh;
  const out = [];
  for (const [x, y, w, h] of rects) {
    const x0 = Math.max(box.x, box.x + x * sx), y0 = Math.max(box.y, box.y + y * sy);
    const x1 = Math.min(box.x + box.width, box.x + (x + w) * sx), y1 = Math.min(box.y + box.height, box.y + (y + h) * sy);
    if (x1 > x0 && y1 > y0) out.push([x0, y0, x1 - x0, y1 - y0]);
  }
  return out;
}

// CSS-pixel rectangles of a vw x vh viewport as fractions of it, padded, clipped, rounded outward
// (a cover never shrinks). More than RECTS_MAX: the whole view.
export function toFractions(rects, vw, vh, pad = PAD) {
  if (!(vw > 0) || !(vh > 0)) return null;
  const out = [];
  for (const r of rects) {
    if (!Array.isArray(r) || !r.every(num)) continue;
    const x0 = Math.max(0, r[0] - pad), y0 = Math.max(0, r[1] - pad);
    const x1 = Math.min(vw, r[0] + r[2] + pad), y1 = Math.min(vh, r[1] + r[3] + pad);
    if (x1 <= x0 || y1 <= y0) continue;
    // In ten-thousandths, so each value is exact and x + w never passes 1.
    const ax = Math.floor((x0 / vw) * 1e4), ay = Math.floor((y0 / vh) * 1e4);
    const bx = Math.min(1e4, Math.ceil((x1 / vw) * 1e4)), by = Math.min(1e4, Math.ceil((y1 / vh) * 1e4));
    out.push([ax / 1e4, ay / 1e4, (bx - ax) / 1e4, (by - ay) / 1e4]);
  }
  return out.length > RECTS_MAX ? [[0, 0, 1, 1]] : out;
}

// Where the page's card fields and card numbers are, as fractions of the main viewport:
// [[x, y, w, h], ...], [] when there are none, null when the page didn't answer (callers then
// fail safe). Every frame (up to FRAMES_MAX) is read at once, each within ms.
export async function coverRects(page, ms = PAGE_MS) {
  if (!page || page.isClosed?.()) return null;
  let frames, main;
  try { main = page.mainFrame(); frames = page.frames().slice(0, FRAMES_MAX); } catch { return null; }
  if (!frames.includes(main)) frames = [main, ...frames.slice(0, FRAMES_MAX - 1)];
  const reads = await Promise.all(frames.map(async (f) => {
    const read = await within(ms, f.evaluate(pageCovers).catch(() => null));
    if (f === main) return { f, read };
    const box = await within(ms, (async () => {
      const el = await f.frameElement();
      try { return await el.boundingBox(); } finally { el.dispose().catch(() => {}); }
    })().catch(() => null));
    return { f, read, box };
  }));
  const top = reads.find((r) => r.f === main)?.read;
  if (!top || !(top.w > 0) || !(top.h > 0)) return null;
  const rects = [];
  for (const { f, read, box } of reads) {
    if (f === main) { rects.push(...hitsOf(read)); continue; }
    if (!box || !(box.width > 0) || !(box.height > 0)) continue; // not shown
    if (!read || !(read.w > 0)) { rects.push([box.x, box.y, box.width, box.height]); continue; } // unknown: covered whole
    rects.push(...mapToFrame(hitsOf(read), read.w, read.h, box));
  }
  return toFractions(rects, top.w, top.h);
}

// Covers drawn on a JPEG (base64) in the page's own renderer, in an isolated world of its own
// (the page's scripts neither see nor change it): for when no capture page or extension can.
// The covered JPEG as base64, or null.
function composeFn(data, rects, color, quality) {
  return (async () => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    bmp.close();
    g.fillStyle = color;
    for (const [x, y, w, h] of rects) {
      const X = Math.floor(x * c.width), Y = Math.floor(y * c.height);
      g.fillRect(X, Y, Math.ceil((x + w) * c.width) - X, Math.ceil((y + h) * c.height) - Y);
    }
    const out = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality })).arrayBuffer());
    let s = "";
    for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
    return btoa(s);
  })();
}
const worlds = new WeakMap(); // page -> { cdp, frameId, contextId }
export async function composeInPage(page, data, rects, ms = 1500) {
  if (!page || page.isClosed?.() || typeof data !== "string" || !Array.isArray(rects)) return null;
  const attempt = async (fresh) => {
    let w = worlds.get(page);
    if (fresh && w) { worlds.delete(page); w.cdp.detach().catch(() => {}); w = null; }
    if (!w) {
      const cdp = await page.context().newCDPSession(page);
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "pairbrowse-covers" });
      w = { cdp, contextId: executionContextId };
      worlds.set(page, w);
      page.once("close", () => { worlds.delete(page); });
    }
    const expression = `(${composeFn})(${JSON.stringify(data)}, ${JSON.stringify(rects)}, ${JSON.stringify(COVER_COLOR)}, 0.8)`;
    const r = await w.cdp.send("Runtime.evaluate", { expression, contextId: w.contextId, awaitPromise: true, returnByValue: true });
    if (r?.exceptionDetails || typeof r?.result?.value !== "string") throw new Error("not covered");
    return r.result.value;
  };
  // A navigation took the isolated world with it: one fresh try.
  const run = attempt(false).catch(() => attempt(true)).catch(() => null);
  return within(ms, run);
}

// The covers, kept fresh while anyone needs them: every `every` ms (never overlapping) the pages
// each source wants (want(fn): fn() -> pages, sync or not) are read again; onTick(fn) gets
// Map(page -> rects) with each page's latest (a page that didn't answer keeps its last).
// picture(page, data): a JPEG (base64) of the page's view with its covers drawn on, the same when
// there are none, null when they can't be known or drawn (the picture then never leaves).
// compose(page, data, rects): draws them (recorder.coverPicture). rectsOf: coverRects (tests).
export function createCoverLoop({ compose, every = 250, rectsOf = coverRects, log = () => {} }) {
  const sources = [];
  const subs = [];
  const latest = new WeakMap();
  let busy = false;
  let said = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const pages = new Set();
      for (const fn of sources) {
        const list = await within(1500, Promise.resolve().then(fn)).catch(() => null);
        for (const p of Array.isArray(list) ? list : []) if (p && !p.isClosed?.()) pages.add(p);
      }
      if (!pages.size) return;
      const got = new Map();
      await Promise.all([...pages].slice(0, 12).map(async (p) => {
        const r = await rectsOf(p).catch(() => null);
        if (Array.isArray(r)) latest.set(p, r);
        if (latest.has(p)) got.set(p, latest.get(p));
      }));
      for (const fn of subs) await within(3000, Promise.resolve().then(() => fn(got))).catch((e) => { if (!said) { said = true; log("covers", e?.message || e); } });
    } finally { busy = false; }
  }
  const timer = setInterval(() => { tick().catch(() => {}); }, every);
  timer.unref?.();
  async function picture(page, data) {
    if (typeof data !== "string" || !data) return null;
    let rects = latest.get(page);
    if (!rects) {
      rects = await rectsOf(page).catch(() => null);
      if (!Array.isArray(rects)) return null;
      latest.set(page, rects);
    }
    if (!rects.length) return data;
    const out = await Promise.resolve(compose(page, data, rects)).catch(() => null);
    return typeof out === "string" && out ? out : null;
  }
  return {
    want: (fn) => { sources.push(fn); },
    onTick: (fn) => { subs.push(fn); },
    latest: (page) => latest.get(page),
    picture,
    tick,
    close: () => clearInterval(timer),
  };
}

// A picture for an agent's result: a joiner's agent's (remote) leaves this screen, so its card
// fields are covered first (compose(data, rects): recorder.coverPicture); the host's own agents'
// stays as it is. The picture's base64, or "" when it can't be covered (then none is sent).
export const NOT_COVERED_NOTE = "\n### PairBrowse\n- No screenshot this time: card fields couldn't be covered.";
export async function agentPicture(data, page, remote, { rectsOf = coverRects, compose } = {}) {
  if (!remote) return data;
  const rects = await rectsOf(page).catch(() => null);
  if (!Array.isArray(rects)) return "";
  if (!rects.length) return data;
  const out = await Promise.resolve(compose?.(data, rects, page)).catch(() => null);
  return typeof out === "string" && out ? out : "";
}
