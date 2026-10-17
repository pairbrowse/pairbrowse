// Card fields covered in pictures that leave the host's own screen: recordings, the session
// timeline's pictures, and what joiners and live view guests see of the host's tabs. The host's
// own live screen and the screenshots the host's agent gets stay as they are.
//
// Covered: an input or textarea sensitive by its own kind (policy.mjs sensitiveHints: card
// number, security code, expiry, one-time code, password and the like) or whose value is a card
// number (looksLikeCard), and every text that holds a card number (maskCards would mask it). In
// every frame, a child frame's rectangles mapped into the main viewport through its frame
// element's box (clipped to it). A child frame that doesn't answer is covered whole: what it
// shows is unknown; so is one past FRAMES_MAX. Rectangles are fractions of the main viewport:
// [x, y, w, h], each 0..1.
import { sensitiveHints, looksLikeCard, maskCards } from "../rules/policy.mjs";
import { within } from "../util.mjs";

export const COVER_COLOR = "#293B50"; // ui/tokens.css --edge; ui/capture/capture.js COVER_COLOR
const FRAMES_MAX = 20; // frames read in full (the main one among them)
const BOXES_MAX = 60; // frames past FRAMES_MAX covered whole by their box; past these, the whole view
const PAGE_MS = 600; // one frame's read, at most
const PAD = 4; // CSS pixels around each cover: a picture taken a moment later may have moved a little
export const RECTS_MAX = 200; // past this many, the whole view is covered

// In the page (each frame): candidates only; the checks run in the helper (policy.mjs).
// { w, h, fields: [[hints, value, x, y, w, h]], texts: [[run, x, y, w, h]] } in the frame's own
// viewport, CSS pixels. Runs in a world of its own with the default driver (Patchright's reads
// are isolated): the page's scripts can't change the DOM methods it calls. A text run is read
// across a block's inline pieces ("<span>4242</span> <span>4242</span>..."), whitespace between
// them as the page shows it. Bounded: 1000 fields, 50000 text nodes, 300 runs, 100000 elements
// looked through for open shadow roots; past any of them the read says partial (the caller then
// covers the frame whole). sx, sy: the frame's scroll, for a cover's path between two reads.
export const pageCovers = () => {
  const W = innerWidth, H = innerHeight;
  const seen = (r) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H;
  const roots = [document];
  let looked = 0, partial = false;
  for (let i = 0; i < roots.length && !partial; i++) {
    for (const el of roots[i].querySelectorAll("*")) {
      if (++looked > 100000) { partial = true; break; }
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  const SKIP = new Set(["checkbox", "radio", "hidden", "submit", "button", "file", "image", "reset", "range", "color"]);
  const fields = [];
  for (const root of roots) {
    for (const [at, el] of [...root.querySelectorAll("input, textarea")].entries()) {
      if (fields.length >= 1000) { partial = true; break; }
      if (SKIP.has(el.type)) continue;
      const r = el.getBoundingClientRect();
      if (!seen(r)) continue;
      const hints = [el.type, el.getAttribute("autocomplete"), el.getAttribute("inputmode"), el.name, el.id, el.getAttribute("aria-label"), el.labels?.[0]?.innerText, el.placeholder].map((x) => String(x || "").replace(/\s+/g, " ").slice(0, 80));
      if (el.maxLength > 0 && el.maxLength <= 8) hints.push(`maxlength${el.maxLength}`);
      fields.push([hints.join(" "), String(el.value || "").slice(0, 40), r.left, r.top, r.width, r.height, `f${roots.indexOf(root)}.${at}`]);
    }
  }
  const texts = [];
  const RUN = /(?<!\d)(?:\d[\s-]{0,12}){12,}\d(?!\d)/g;
  const INLINE = new Set(["SPAN", "B", "I", "EM", "STRONG", "FONT", "SMALL", "BIG", "A", "LABEL", "MARK", "CODE", "SUB", "SUP", "U", "S", "BDI", "BDO", "DATA", "TIME", "ABBR", "CITE", "DFN", "KBD", "Q", "SAMP", "VAR", "INS", "DEL", "TT"]);
  const blockOf = (n) => { let e = n.parentElement; while (e && INLINE.has(e.tagName)) e = e.parentElement; return e || n.parentNode; };
  let nodes = 0, group = [], owner = null, text = "";
  const runs = Object.create(null); // each run's count so far: its key among same-text ones
  // The node and offset of position i in the group's text (end: the end of a run).
  const place = (i, end) => {
    let k = 0;
    while (k < group.length - 1 && (end ? group[k].at + group[k].len < i : group[k].at + group[k].len <= i)) k++;
    return [group[k].node, Math.max(0, Math.min(group[k].len, i - group[k].at))];
  };
  const flush = () => {
    if (text.length >= 13 && /\d/.test(text)) {
      for (const m of text.matchAll(RUN)) {
        if (texts.length >= 300) { partial = true; break; }
        const range = document.createRange();
        range.setStart(...place(m.index, false));
        range.setEnd(...place(m.index + m[0].length, true));
        const r = range.getBoundingClientRect();
        const run = m[0].replace(/\s+/g, " ");
        runs[run] = (runs[run] || 0) + 1;
        if (seen(r)) texts.push([run, r.left, r.top, r.width, r.height, `t${run}#${runs[run]}`]);
      }
    }
    group = []; owner = null; text = "";
  };
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && !partial; n = walker.nextNode()) {
      if (++nodes > 50000) { partial = true; break; }
      const tag = n.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "NOSCRIPT") continue;
      const s = n.nodeValue || "";
      const b = blockOf(n);
      if (b !== owner || text.length > 4000) flush();
      owner = b;
      group.push({ node: n, at: text.length, len: s.length });
      text += s;
    }
    flush();
  }
  return { w: W, h: H, sx: scrollX, sy: scrollY, partial, fields, texts };
};

const num = (n) => typeof n === "number" && Number.isFinite(n);
// What in one frame's read is covered: [[x, y, w, h]] in that frame's CSS pixels.
// Each rect's key (what it covers: a field by its place among the frame's fields, a run by its
// text and count) rides along as a non-enumerable `keys` list, so two reads can be matched.
const keyed = (rects, keys) => Object.defineProperty(rects, "keys", { value: keys });
export function hitsOf(read) {
  const out = [], keys = [];
  for (const f of Array.isArray(read?.fields) ? read.fields : []) {
    if (!Array.isArray(f) || f.length < 6) continue;
    const [hints, value, ...r] = f;
    if (!r.slice(0, 4).every(num)) continue;
    if (sensitiveHints(String(hints ?? "")) || looksLikeCard(String(value ?? ""))) { out.push(r.slice(0, 4)); keys.push(typeof r[4] === "string" ? r[4] : null); }
  }
  for (const t of Array.isArray(read?.texts) ? read.texts : []) {
    if (!Array.isArray(t) || t.length < 5) continue;
    const [run, ...r] = t;
    if (!r.slice(0, 4).every(num)) continue;
    if (maskCards(String(run ?? "")) !== String(run ?? "")) { out.push(r.slice(0, 4)); keys.push(typeof r[4] === "string" ? r[4] : null); }
  }
  return keyed(out, keys);
}

// A child frame's rectangles (in its own viewport of fw x fh) in the main viewport, through its
// frame element's box there ({ x, y, width, height }), clipped to that box.
export function mapToFrame(rects, fw, fh, box) {
  if (!box || !(box.width > 0) || !(box.height > 0) || !(fw > 0) || !(fh > 0)) return [];
  const sx = box.width / fw, sy = box.height / fh;
  const out = [], keys = [];
  rects.forEach(([x, y, w, h], i) => {
    const x0 = Math.max(box.x, box.x + x * sx), y0 = Math.max(box.y, box.y + y * sy);
    const x1 = Math.min(box.x + box.width, box.x + (x + w) * sx), y1 = Math.min(box.y + box.height, box.y + (y + h) * sy);
    if (x1 > x0 && y1 > y0) { out.push([x0, y0, x1 - x0, y1 - y0]); keys.push(rects.keys?.[i] ?? null); }
  });
  return keyed(out, keys);
}

// CSS-pixel rectangles of a vw x vh viewport as fractions of it, padded, clipped, rounded outward
// (a cover never shrinks). More than RECTS_MAX: the whole view.
export function toFractions(rects, vw, vh, pad = PAD) {
  if (!(vw > 0) || !(vh > 0)) return null;
  const out = [], keys = [];
  for (const [i, r] of rects.entries()) {
    if (!Array.isArray(r) || !r.every(num)) continue;
    const x0 = Math.max(0, r[0] - pad), y0 = Math.max(0, r[1] - pad);
    const x1 = Math.min(vw, r[0] + r[2] + pad), y1 = Math.min(vh, r[1] + r[3] + pad);
    if (x1 <= x0 || y1 <= y0) continue;
    // In ten-thousandths, so each value is exact and x + w never passes 1.
    const ax = Math.floor((x0 / vw) * 1e4), ay = Math.floor((y0 / vh) * 1e4);
    const bx = Math.min(1e4, Math.ceil((x1 / vw) * 1e4)), by = Math.min(1e4, Math.ceil((y1 / vh) * 1e4));
    out.push([ax / 1e4, ay / 1e4, (bx - ax) / 1e4, (by - ay) / 1e4]);
    keys.push(rects.keys?.[i] ?? null);
  }
  return out.length > RECTS_MAX ? [[0, 0, 1, 1]] : keyed(out, keys);
}

export const WHOLE = Object.freeze([Object.freeze([0, 0, 1, 1])]);
// Two reads around a picture (coverRects answers, before it and after it), joined: both, and the
// way each field went between them (betweenReads).
export const joinReads = (before, after) => unionRects(before, betweenReads(before, after));
// Rects (fractions) of several reads joined, each once; more than RECTS_MAX: the whole view.
export function unionRects(...lists) {
  const out = new Map();
  for (const list of lists) for (const r of list || []) out.set(r.join(","), r);
  return out.size > RECTS_MAX ? [[0, 0, 1, 1]] : [...out.values()];
}

// Where the page's card fields and card numbers are, as fractions of the main viewport:
// [[x, y, w, h], ...], [] when there are none, null when the main frame didn't answer (callers then
// fail safe). The first FRAMES_MAX frames are read at once, each within ms; past them, each frame
// shown is covered whole by its frame element's box, and past BOXES_MAX more the whole view is.
// A frame (still attached) whose box can't be read covers the whole view: where it is is unknown.
export async function coverRects(page, ms = PAGE_MS) {
  if (!page || page.isClosed?.()) return null;
  let children, main;
  try { main = page.mainFrame(); children = page.frames().filter((f) => f !== main); } catch { return null; }
  if (children.length > FRAMES_MAX - 1 + BOXES_MAX) return [[0, 0, 1, 1]];
  // { box } (null: not shown), or null when it couldn't be read in time.
  const boxOf = (f) => within(ms, (async () => {
    const el = await f.frameElement();
    try { return { box: await el.boundingBox() }; } finally { el.dispose().catch(() => {}); }
  })().catch(() => null));
  const read = (f) => within(ms, f.evaluate(pageCovers).catch(() => null));
  const [top, ...rest] = await Promise.all([
    read(main),
    ...children.map(async (f, i) => {
      const [got, b] = await Promise.all([i < FRAMES_MAX - 1 ? read(f) : null, boxOf(f)]);
      return { f, read: got, b };
    }),
  ]);
  if (!top || !(top.w > 0) || !(top.h > 0)) return null;
  const view = { sx: num(top.sx) ? top.sx : 0, sy: num(top.sy) ? top.sy : 0, w: top.w, h: top.h };
  if (top.partial) return Object.defineProperty(withView([[0, 0, 1, 1]], view), "tooLarge", { value: true }); // too much to read in time: all of it
  const hits = hitsOf(top);
  const rects = [...hits], keys = hits.keys.map((k) => (k == null ? null : `m/${k}`));
  for (const [i, { f, read: got, b }] of rest.entries()) {
    if (!b) { if (f.isDetached?.()) continue; return withView([[0, 0, 1, 1]], view); }
    const box = b.box;
    if (!box || !(box.width > 0) || !(box.height > 0)) continue; // not shown
    if (!got || !(got.w > 0) || got.partial) { rects.push([box.x, box.y, box.width, box.height]); keys.push(`b${i}`); continue; } // unknown: covered whole
    const mapped = mapToFrame(hitsOf(got), got.w, got.h, box);
    rects.push(...mapped);
    keys.push(...mapped.keys.map((k) => (k == null ? null : `${i}/${k}`)));
  }
  return withView(toFractions(keyed(rects, keys), top.w, top.h), view);
}

// What covers a picture taken between two reads (coverRects answers) besides the first: the second
// read, each field matched by its key in the first hulled with where it stood then (whatever moved
// it: the page, a box scrolled inside it, a frame, a layout shift), and every field of either read
// swept along the main frame's scroll between them (alongPath both ways: one that scrolled into
// view, or out of it). The second's view kept. Without a first: the second as it is.
export function betweenReads(before, after) {
  if (!Array.isArray(after) || !Array.isArray(before)) return after;
  const was = new Map();
  before.forEach((r, i) => { const k = before.keys?.[i]; if (k != null) was.set(k, r); });
  const moved = [];
  after.forEach((r, i) => {
    const b = was.get(after.keys?.[i] ?? null);
    if (!b) return;
    const x0 = Math.min(r[0], b[0]), y0 = Math.min(r[1], b[1]);
    moved.push([x0, y0, Math.max(r[0] + r[2], b[0] + b[2]) - x0, Math.max(r[1] + r[3], b[1] + b[3]) - y0]);
  });
  // The first's fields swept forward only when the page scrolled (they're in force anyway).
  const a = before.view, b = after.view;
  const scrolled = a && b && b.w > 0 && b.h > 0 && (Math.abs(b.sx - a.sx) > PAD || Math.abs(b.sy - a.sy) > PAD);
  const out = unionRects(alongPath(after, before), scrolled ? alongPath(before, after) : [], moved);
  return after.view ? withView(out, after.view) : out;
}

// The main frame's scroll and size when rects were read, kept on them (not sent anywhere).
const withView = (rects, view) => Object.defineProperty(rects, "view", { value: view });
// rects read after `before` (both coverRects answers), each widened to the path it took while
// the page scrolled between the two reads (so a picture taken in between, wherever the field
// was then, has it covered); as they are when either has no scroll known or it didn't change.
// Only the main frame's scroll counts: a box scrolled inside the page, or a layout that shifted,
// isn't followed.
export function alongPath(rects, before) {
  const a = before?.view, b = rects?.view;
  if (!Array.isArray(rects) || !a || !b || !(b.w > 0) || !(b.h > 0)) return rects;
  const dx = (b.sx - a.sx) / b.w, dy = (b.sy - a.sy) / b.h;
  if (Math.abs(dx * b.w) <= PAD && Math.abs(dy * b.h) <= PAD) return rects;
  if (rects.length === 1 && rects[0].join(",") === "0,0,1,1") return rects;
  const out = [];
  for (const [x, y, w, h] of rects) {
    // Scrolled down by dy, a field stood dy lower in the view before: the hull of both places.
    // In ten-thousandths, rounded outward, as toFractions does.
    // (A hair of float error is no cover's worth: 1e-6 of a ten-thousandth.)
    const lo = (v) => Math.floor(v * 1e4 + 1e-6), hi = (v) => Math.ceil(v * 1e4 - 1e-6);
    const x0 = lo(Math.max(0, Math.min(x, x + dx))), y0 = lo(Math.max(0, Math.min(y, y + dy)));
    const x1 = hi(Math.min(1, Math.max(x + w, x + w + dx))), y1 = hi(Math.min(1, Math.max(y + h, y + h + dy)));
    if (x1 > x0 && y1 > y0) out.push([x0 / 1e4, y0 / 1e4, (x1 - x0) / 1e4, (y1 - y0) / 1e4]);
  }
  return withView(out.length > RECTS_MAX ? [[0, 0, 1, 1]] : out, b);
}

// The covers, kept fresh while anyone needs them: every `every` ms (never overlapping) the pages
// each source wants (want(fn): fn() -> pages, sync or not) are read again. onTick(fn): fn(got,
// { mark, fresh }) with got Map(page -> rects), each page's latest; fresh: the pages read this
// time (or covered whole: no answer for staleMs); mark: mark() asked just before the
// reads (the capture page's clock: what it draws waits for covers read after its picture), null
// when it didn't answer. A page whose main frame navigates is covered whole at once where covers
// are drawn as they come (fn(Map(page -> WHOLE), { mark: null, fresh })), until it is read again;
// pictures matched to reads by time (picture, the capture page's) need no such step.
// picture(page, data, at): a JPEG (base64) of the page's view taken by `at` (Date.now(), default
// now) with covers drawn on that were read after it, joined with those in force just before (a
// field that moved or went away meanwhile stays covered); the same JPEG when there are none; null
// when they can't be known in time or drawn (the picture then never leaves).
// compose(page, data, rects): draws them (recorder.coverPicture). rectsOf: coverRects (tests).
const HISTORY = 40; // reads kept per page
const LAG_MS = 100; // a picture shows the page as it was a moment before it was taken
export function createCoverLoop({ compose, every = 250, rectsOf = coverRects, mark = async () => null, staleMs = 1000, log = () => {} }) {
  const sources = [];
  const subs = [];
  const history = new WeakMap(); // page -> [{ rects, at }], oldest first
  const answered = new WeakMap(); // page -> when it last answered
  const ticked = new WeakMap(); // page -> when the loop last read it
  const lastRead = new WeakMap(); // page -> its last answer as read (with its view), for alongPath
  // A page's answer, widened along the path its fields took since the last one (alongPath).
  const fresh_ = (page, r) => { const out = betweenReads(lastRead.get(page), r); lastRead.set(page, r); return out; };
  const hooked = new WeakSet();
  const saidLarge = new WeakSet();
  const waiters = new Set();
  let busy = false;
  let said = false;
  const remember = (page, rects, at) => {
    const h = history.get(page) || [];
    h.push({ rects, at });
    if (h.length > HISTORY) h.splice(0, h.length - HISTORY);
    history.set(page, h);
  };
  const latest = (page) => history.get(page)?.at(-1)?.rects;
  const wake = () => { for (const fn of [...waiters]) fn(); };
  const tell = async (got, info) => {
    for (const fn of subs) await within(3000, Promise.resolve().then(() => fn(got, info))).catch((e) => { if (!said) { said = true; log("covers", e?.message || e); } });
  };
  // A navigation in the main frame: what was read of the page before no longer holds.
  const hook = (page) => {
    if (hooked.has(page) || typeof page.on !== "function") return;
    hooked.add(page);
    try {
      page.on("framenavigated", (f) => {
        if (f !== page.mainFrame?.()) return;
        tell(new Map([[page, WHOLE]]), { mark: null, fresh: new Set([page]) }).catch(() => {});
      });
    } catch {}
  };
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
      const at = subs.length ? await within(1000, Promise.resolve().then(mark)).catch(() => null) : null;
      const startedAt = Date.now();
      const got = new Map();
      const fresh = new Set();
      await Promise.all([...pages].slice(0, 12).map(async (p) => {
        hook(p);
        ticked.set(p, startedAt);
        if (!answered.has(p)) answered.set(p, startedAt); // a page new to the loop: staleMs from now
        const r = await rectsOf(p).catch(() => null);
        if (Array.isArray(r)) { remember(p, fresh_(p, r), startedAt); answered.set(p, Date.now()); fresh.add(p); }
        if (r?.tooLarge && !saidLarge.has(p)) { saidLarge.add(p); log("covers: a page too large to read in time is covered whole in what leaves this screen"); }
        else if (Date.now() - (answered.get(p) ?? 0) > staleMs) { remember(p, WHOLE, startedAt); fresh.add(p); }
        if (latest(p)) got.set(p, latest(p));
      }));
      wake();
      await tell(got, { mark: Number.isFinite(at) ? at : null, fresh });
    } finally { busy = false; }
  }
  const timer = setInterval(() => { tick().catch(() => {}); }, every);
  timer.unref?.();
  // The covers of page read at or after `at`, joined with the ones in force LAG_MS before it; null
  // when none came within ms. A page the loop isn't reading is read here.
  async function rectsSince(page, at, ms = 1500) {
    const end = Date.now() + ms;
    for (;;) {
      const h = history.get(page) || [];
      const i = h.findIndex((e) => e.at >= at);
      if (i >= 0) {
        let from = i;
        while (from > 0 && h[from - 1].at > at - LAG_MS) from--;
        if (from > 0) from--;
        return unionRects(...h.slice(from, i + 1).map((e) => e.rects));
      }
      if (Date.now() >= end) return null;
      if (Date.now() - (ticked.get(page) ?? 0) > every * 3 + 1500) {
        const startedAt = Date.now();
        const r = await rectsOf(page).catch(() => null);
        if (!Array.isArray(r)) return null;
        remember(page, fresh_(page, r), startedAt);
        continue;
      }
      await new Promise((done) => {
        const fn = () => { waiters.delete(fn); clearTimeout(t); done(); };
        const t = setTimeout(fn, Math.max(1, end - Date.now()));
        waiters.add(fn);
      });
    }
  }
  async function picture(page, data, at = Date.now()) {
    if (typeof data !== "string" || !data) return null;
    const rects = await rectsSince(page, at);
    if (!Array.isArray(rects)) return null;
    if (!rects.length) return data;
    const out = await Promise.resolve(compose(page, data, rects)).catch(() => null);
    return typeof out === "string" && out ? out : null;
  }
  return {
    want: (fn) => { sources.push(fn); },
    onTick: (fn) => { subs.push(fn); },
    latest,
    picture,
    rectsSince,
    tick,
    close: () => { clearInterval(timer); wake(); },
  };
}

// A picture for an agent's result: a joiner's agent's (remote) leaves this screen, so its card
// fields are covered first (compose(data, rects, page): recorder.coverPicture), with the covers
// read just before the picture was taken (before: rects, from screenshot.mjs take's covers) and
// again after it, both; the host's own agents' stays as it is. The picture's base64, or "" when
// it can't be covered (then none is sent).
export const NOT_COVERED_NOTE = "\n### PairBrowse\n- No screenshot this time: card fields couldn't be covered.";
export async function agentPicture(data, page, remote, { rectsOf = coverRects, compose, before } = {}) {
  if (!remote) return data;
  if (!Array.isArray(before)) return "";
  const after = await rectsOf(page).catch(() => null);
  if (!Array.isArray(after)) return "";
  const rects = joinReads(before, after);
  if (!rects.length) return data;
  const out = await Promise.resolve(compose?.(data, rects, page)).catch(() => null);
  return typeof out === "string" && out ? out : "";
}
