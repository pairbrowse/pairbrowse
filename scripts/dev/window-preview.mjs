#!/usr/bin/env node
// A dev tool, not plugin code: renders the whole PairBrowse window, as the hybrid 500-shell will
// lay it out, from the real ui/ pages in iframes over the pages' harness (the fake helper and the
// ui server from test/helpers), before the native build exists.
//   PAIRBROWSE_TEST_RUNTIME=~/.pairbrowse/runtime node scripts/dev/window-preview.mjs --out <dir>
//     [--rail] [--reduced-motion] [--mockup <png>] [--one-host] [--plain] [--no-helper]
// --no-helper: the browser started without a helper (session.helper() answers no address): every
// dock and page in its resting state (DESIGN.md B2-B4, "No agent connected").
// The scene is scripts/dev/preview/fixtures.json. The contents card is the stand-in page in
// scripts/dev/preview/ with scripts/hud/ added the way the helper adds it, rendered as its own
// top-level page (as the build's contents is a WebContents of its own) and shown as an image.
// The scene's page is docked (hud.docked: the helper tells pages inside the PairBrowse browser's
// window that its docks carry the bottom bar, DESIGN.md Part G) before the bar it sends every page;
// --plain also writes contents-plain.png, the same page as the open build shows it (not docked:
// the 30 px bottom bar with who drives, the steps and Pause agents).
// Writes window.png, window@2x.png, contents.png, contents@2x.png, pictures/<card>.jpg (the
// timeline's pictures: real renders of the sample page at each step), side-by-side.png and
// regions/<name>.png (crop pairs against the mockup's window area), harness-log.json and
// frames.json. Exit 1 on any error, page error, rejection or CSP entry, on a render failure, on a
// frame still connecting, or on a timeline picture that did not load.
// For the composition only, a loopback proxy in front of the ui server lifts the pages'
// frame-ancestors to 'self' (X-Frame-Options SAMEORIGIN) and nothing else, and by default splits
// the frames over two host names for the helper (127.0.0.1 and localhost). The pages share one
// event stream per helper host (ui/common.js helperStream: a Web Lock and a BroadcastChannel per
// helper origin), so the default run opens two streams and --one-host, what the build does, one.
// The mockup is read in place, never copied.
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchright, inPage, ensureHud } from "../../test/helpers/live.mjs";
import { startFakeHelper, merge } from "../../test/helpers/fake-helper.mjs";
import { startUiServer, insertTags } from "../../test/helpers/ui-server.mjs";
import { defaultFixture, shimScript, bridgeExtensionScript } from "../../test/helpers/pairbrowse-shim.mjs";
import { SECURITY_HEADERS, listen, plain } from "../liveview/http.mjs";
import { hudScript } from "../browser.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
const PREVIEW_DIR = join(here, "preview");
export const FIXTURES = join(PREVIEW_DIR, "fixtures.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The frames each helper host name serves, by default; --one-host puts them all on 127.0.0.1. The
// shared stream means one event stream per helper host (the nav fragments open none).
export const HOST_GROUPS = { "127.0.0.1": ["strip", "left", "right", "approve"], localhost: ["nav-left", "nav-right", "timeline"] };
export const FRAMES = ["strip", "nav-left", "nav-right", "left", "right", "timeline", "approve"];
export const REGIONS = ["strip", "nav", "left", "right", "timeline", "approval"];
// The mockup's areas in mockup.png pixels (measured by eye).
export const MOCKUP = {
  window: { x: 22, y: 83, w: 1492, h: 842 },
  strip: { x: 22, y: 83, w: 1492, h: 55 },
  nav: { x: 228, y: 138, w: 950, h: 42 },
  left: { x: 22, y: 138, w: 206, h: 787 },
  right: { x: 1178, y: 138, w: 336, h: 787 },
  timeline: { x: 228, y: 795, w: 950, h: 130 },
  approval: { x: 776, y: 588, w: 375, h: 197 },
};
const BAD_KINDS = new Set(["error", "pageerror", "rejection", "csp"]);

// The window's rects at the 500-shell geometry as 525 measures it to the mockup (DESIGN.md B1). The
// CSS gives the same: the docks run from under the tab row to the bottom; the nav row, the card
// (right under the nav row, inset 8 px on the sides and the bottom) and the timeline share the
// contents column between them.
export function geometry({ rail = false } = {}) {
  const W = 1536, H = 1024, row = 53, nav = 42, tl = 125, inset = 8, topInset = 0;
  const left = rail ? 44 : 205, right = rail ? 44 : 346, top = row + nav;
  return {
    window: { w: W, h: H },
    strip: { x: 0, y: 0, w: W, h: row },
    nav: { x: left, y: row, w: W - left - right, h: nav },
    left: { x: 0, y: row, w: left, h: H - row },
    right: { x: W - right, y: row, w: right, h: H - row },
    card: { x: left + inset, y: top + topInset, w: W - left - right - 2 * inset, h: H - top - topInset - tl - inset },
    timeline: { x: left, y: H - tl, w: W - left - right, h: tl },
  };
}

// A deep copy; a negative number under t or at becomes now + it, under updatedAt or savedAt an ISO
// string; an "HH:MM" string under t becomes that time today (the mockup's 10:24 cards), or
// yesterday when that is still ahead of now.
export function resolveTimes(value, now, key = "") {
  if (Array.isArray(value)) return value.map((v) => resolveTimes(v, now));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTimes(v, now, k)]));
  if (key === "t" && typeof value === "string" && /^\d\d:\d\d$/.test(value)) {
    const d = new Date(now);
    d.setHours(Number(value.slice(0, 2)), Number(value.slice(3)), 0, 0);
    return d.getTime() > now ? d.getTime() - 86400000 : d.getTime();
  }
  if (typeof value === "number" && value < 0) {
    if (key === "t" || key === "at") return now + value;
    if (key === "updatedAt" || key === "savedAt") return new Date(now + value).toISOString();
  }
  return value;
}

export function loadFixtures(file = FIXTURES) {
  const fx = JSON.parse(readFileSync(file, "utf8"));
  const keys = ["helper", "shim", "sample", "hud"];
  const extra = Object.keys(fx).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !(k in fx));
  if (extra.length || missing.length) throw new Error(`fixtures are { ${keys.join(", ")} }${extra.length ? `; unknown: ${extra.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`);
  return fx;
}

const TYPES = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8" };
const WINDOW_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
const PRELUDE_TAG = '<script src="/__harness/prelude.js"></script>';

// The preview proxy: the preview's own files, then everything else from the ui server, with only
// the framing of its HTML documents lifted to same-origin (and, for ?via=localhost, the helper
// reached as localhost).
export async function startPreviewServer({ ui, helper, shim, mockupPath, out }) {
  let contents = null;
  const helperPort = new URL(helper.origin).port;
  const localOrigin = `http://localhost:${helperPort}`;
  const file = (res, path, type, extra = {}) => {
    try { const body = readFileSync(path); res.writeHead(200, { ...SECURITY_HEADERS, "content-type": type, ...extra }); res.end(body); } catch { plain(res, 404); }
  };
  const server = http.createServer((req, res) => {
    if (req.method !== "GET") return plain(res, 405);
    let url, path;
    try { url = new URL(req.url, "http://x"); path = decodeURIComponent(url.pathname); } catch { return plain(res, 400); }
    const parts = posix.normalize(path).split("/").filter(Boolean);
    if (path.includes("..") || path.includes("\0") || parts.some((p) => p.startsWith("."))) return plain(res, 404);
    const via = url.searchParams.get("via") === "localhost";
    const m = /^\/preview\/window-preview\.(html|css|js)$/.exec(path);
    if (m) {
      const p = join(here, `window-preview.${m[1]}`);
      if (m[1] !== "html") return file(res, p, TYPES[m[1]]);
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": TYPES.html, "content-security-policy": WINDOW_CSP });
      return res.end(insertTags(readFileSync(p, "utf8"), PRELUDE_TAG));
    }
    if (path === "/preview/contents.png") {
      if (!contents) return plain(res, 404);
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "image/png" });
      return res.end(contents);
    }
    if (path === "/preview/mockup.png") return mockupPath ? file(res, mockupPath, "image/png") : plain(res, 404);
    if (path === "/preview/window.png") return file(res, join(out, "window.png"), "image/png");
    if (path === "/sample/index.html") {
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": TYPES.html });
      return res.end(insertTags(readFileSync(join(PREVIEW_DIR, "sample.html"), "utf8"), PRELUDE_TAG));
    }
    if (path === "/sample/sample.css") return file(res, join(PREVIEW_DIR, "sample.css"), TYPES.css);
    if (via && path === "/__harness/pairbrowse-api.js") {
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": TYPES.js });
      return res.end(shimScript({ ...shim, helper: shim.helper === null ? { origin: "", key: "" } : { origin: localOrigin, key: helper.key } }));
    }
    if (via && path === "/__harness/chrome.js") {
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": TYPES.js });
      return res.end(bridgeExtensionScript(`${localOrigin}/${helper.key}/`));
    }
    const upstream = http.get(ui.origin + url.pathname + url.search, (up) => {
      const headers = { ...up.headers };
      if (!String(headers["content-type"] || "").startsWith("text/html")) { res.writeHead(up.statusCode, headers); return up.pipe(res); }
      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");
        let csp = String(headers["content-security-policy"] || "").replace("frame-ancestors 'none'", "frame-ancestors 'self'");
        if (via) {
          csp = csp.replaceAll(helper.origin, localOrigin);
          body = body.replace('src="/__harness/pairbrowse-api.js"', 'src="/__harness/pairbrowse-api.js?via=localhost"').replace('src="/__harness/chrome.js"', 'src="/__harness/chrome.js?via=localhost"');
        }
        if (headers["content-security-policy"]) headers["content-security-policy"] = csp;
        headers["x-frame-options"] = "SAMEORIGIN";
        delete headers["transfer-encoding"];
        headers["content-length"] = Buffer.byteLength(body);
        res.writeHead(up.statusCode, headers);
        res.end(body);
      });
      up.on("error", () => { if (!res.headersSent) plain(res, 502); });
    });
    upstream.on("error", () => { if (!res.headersSent) plain(res, 502); });
  });
  await listen(server, 0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    setContents: (buf) => { contents = buf; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const rectOf = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

// The fields of a sample step, filled as a person would.
async function fill(page, fields) {
  for (const [sel, value] of Object.entries(fields || {})) {
    if (sel === "#ws-use") await page.selectOption(sel, value);
    else await page.fill(sel, value);
  }
}

// The timeline's pictures: one real render of the sample page per step, at the helper's 820 px.
export async function renderPictures(browser, { proxy, geo, fx, helper, out, reducedMotion }) {
  const page = await browser.newPage({ viewport: { width: geo.card.w, height: geo.card.h }, deviceScaleFactor: 820 / geo.card.w, reducedMotion });
  try {
    mkdirSync(join(out, "pictures"), { recursive: true });
    await page.goto(`${proxy.origin}/sample/index.html`, { waitUntil: "load" });
    for (const step of fx.sample.steps) {
      await page.reload({ waitUntil: "load" });
      await fill(page, step.fill);
      const jpg = await page.screenshot({ type: "jpeg", quality: 70 });
      helper.fixtures.pictures[step.card] = jpg.toString("base64");
      writeFileSync(join(out, "pictures", `${step.card}.jpg`), jpg);
    }
  } finally {
    await page.close().catch(() => {});
  }
}

// The contents card: the sample page filled, with scripts/hud/ added and called the helper's
// way (scripts/daemon/hud.mjs: ensure, then window[name](token, value, kind)). -> PNG buffer.
export async function renderContents(browser, { proxy, geo, raw, scale, reducedMotion, log, plain = false }) {
  const page = await browser.newPage({ viewport: { width: geo.card.w, height: geo.card.h }, deviceScaleFactor: scale, reducedMotion });
  page.on("pageerror", (e) => log.push({ frame: "contents", kind: "pageerror", text: String(e).slice(0, 500) }));
  try {
    await page.goto(`${proxy.origin}/sample/index.html`, { waitUntil: "load" });
    await fill(page, raw.sample.final);
    const hud = hudScript();
    await ensureHud(page, hud.source, hud.name);
    const call = (value, kind) => page.evaluate(([n, t, v, k]) => window[n]?.(t, v, k), [hud.name, hud.token, value, kind]);
    const rect = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, sx: scrollX, sy: scrollY }; }, sel);
    // Docked first, as the helper does in the PairBrowse browser (scripts/daemon/hud.mjs
    // onPageLoad), then the bar it sends every page: docked, only a join card would show.
    if (raw.hud.docked && !plain) await call(JSON.stringify({ on: true }), "docked");
    if (raw.hud.bar) {
      const bar = resolveTimes(raw.hud.bar, Date.now());
      await call(JSON.stringify({ items: bar.items, canPause: raw.hud.bar.canPause !== false }), "bar");
    }
    const c = raw.hud.cursor, r = await rect(c.field);
    const sent = await call(JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, act: c.act, who: c.who, color: c.color, w: Math.round(Math.min(r.width, r.height)), bw: Math.round(r.width), bh: Math.round(r.height) }), "cursor");
    // The cursor glides in (its motion model); the peers fade out 3 s after they stop moving.
    await sleep(Math.min(2000, Math.max(0, Number(sent?.ms) || 0)) + 100);
    const peers = [];
    for (const p of raw.hud.peers) {
      const pr = await rect(p.field);
      peers.push({ k: p.k, x: pr.x + pr.width * p.fx + pr.sx, y: pr.y + pr.height * p.fy + pr.sy, who: p.who, color: p.color });
    }
    await call(JSON.stringify(peers), "cursors");
    await sleep(450);
    const png = await page.screenshot({ type: "png" });
    for (const e of await inPage(page, () => window.__harness?.log || [{ kind: "error", text: "harness missing" }])) log.push({ frame: "contents", kind: e.kind, text: e.text });
    return png;
  } finally {
    await page.close().catch(() => {});
  }
}

// Waits up to ms for fn (run in the frame's page world) to be truthy.
export async function until(frame, fn, ms, arg) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await inPage(frame, fn, arg).catch(() => false)) return true;
    await sleep(50);
  }
  return false;
}

// The window at scale (1 or 2) -> { file, frames, rects, streams }.
export async function renderWindow(browser, { proxy, helper, geo, raw, scale, reducedMotion, oneHost, rail, out, log }) {
  const page = await browser.newPage({ viewport: { width: geo.window.w, height: geo.window.h }, deviceScaleFactor: scale, reducedMotion });
  page.on("pageerror", (e) => log.push({ frame: "window", kind: "pageerror", text: String(e).slice(0, 500) }));
  try {
    await page.goto(`${proxy.origin}/preview/window-preview.html?rail=${rail ? 1 : 0}&onehost=${oneHost ? 1 : 0}`, { waitUntil: "load" });
    const named = new Map();
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const el = await frame.frameElement().catch(() => null);
      const id = el ? await el.getAttribute("id").catch(() => null) : null;
      if (id && FRAMES.includes(id)) named.set(id, frame);
    }
    await Promise.all([...named.values()].map((f) => until(f, () => document.body && document.body.dataset.s !== "connecting", 5000)));
    const approve = named.get("approve");
    if (approve && await until(approve, () => Number(document.body?.dataset.pending) >= 1, 3000)) {
      const r = await inPage(approve, () => { const b = document.getElementById("card").getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
      await page.evaluate((b) => {
        const box = document.getElementById("approval"), fr = document.getElementById("approve");
        box.style.width = `${Math.round(b.w)}px`;
        box.style.height = `${Math.round(b.h)}px`;
        fr.style.left = `${-Math.round(b.x)}px`;
        fr.style.top = `${-Math.round(b.y)}px`;
      }, r);
    }
    const tl = named.get("timeline");
    const pictureCards = raw.helper.timeline.cards.filter((c) => !c.note).length;
    if (tl) await until(tl, (n) => { const imgs = [...document.querySelectorAll("img.thumb")]; return imgs.filter((i) => i.getAttribute("src")).length >= n && imgs.every((i) => i.complete); }, 3000, pictureCards);
    // Every picture card's thumbnail has really loaded (decoded, not a broken image).
    const thumbs = tl ? await inPage(tl, () => [...document.querySelectorAll("img.thumb")].filter((i) => i.complete && i.naturalWidth > 0).length).catch(() => 0) : 0;
    // The agent drives right now (the pages' 8 s window), so the capture shows it driving.
    const now = Date.now();
    const activity = resolveTimes(raw.helper.activity, now);
    activity.at(-1).t = now;
    helper.set("activity", activity);
    await sleep(400);
    const file = join(out, scale === 1 ? "window.png" : `window@${scale}x.png`);
    await page.screenshot({ path: file, type: "png" });

    const frames = [];
    for (const name of FRAMES) {
      const frame = named.get(name);
      if (!frame) { log.push({ frame: name, kind: "error", text: "frame missing" }); continue; }
      const url = frame.url();
      const host = new URL(url).searchParams.get("via") === "localhost" ? "localhost" : "127.0.0.1";
      const info = await inPage(frame, () => (window.__harness ? { s: document.body?.dataset.s ?? null, live: window.__harness.live(), log: window.__harness.log } : null)).catch(() => null);
      if (!info) { log.push({ frame: name, kind: "error", text: "harness missing" }); frames.push({ name, url, host, s: null, live: null }); continue; }
      for (const e of info.log) log.push({ frame: name, kind: e.kind, text: e.text });
      frames.push({ name, url, host, s: info.s, live: info.live });
    }
    for (const e of await inPage(page, () => window.__harness?.log || [{ kind: "error", text: "harness missing" }])) log.push({ frame: "window", kind: e.kind, text: e.text });
    const rects = await page.evaluate(() => {
      const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      return { strip: r("#strip"), nav: r(".nav"), left: r("#left"), right: r("#right"), timeline: r("#timeline"), card: r(".card"), approval: r("#approval") };
    });
    for (const k of Object.keys(rects)) rects[k] = rectOf(rects[k]);
    const byHost = { "127.0.0.1": 0, localhost: 0 };
    for (const f of frames) byHost[f.host] += f.live?.eventSources || 0;
    return { file, frames, rects, streams: { total: byHost["127.0.0.1"] + byHost.localhost, byHost }, thumbs: { loaded: thumbs, cards: pictureCards } };
  } finally {
    await page.close().catch(() => {});
  }
}

// Static compare pages: the mockup's area and ours, side by side at 1:1.
export async function compose(browser, { proxy, out, rects, geo }) {
  const pad = (r, p) => {
    const x = Math.max(0, r.x - p), y = Math.max(0, r.y - p);
    return { x, y, w: Math.min(geo.window.w, r.x + r.w + p) - x, h: Math.min(geo.window.h, r.y + r.h + p) - y };
  };
  const ours = { ...rects, approval: pad(rects.approval, 12) };
  const crop = (src, r, label) => `<figure><figcaption>${label}</figcaption><div style="width:${r.w}px;height:${r.h}px;overflow:hidden;position:relative"><img src="${proxy.origin}${src}" style="position:absolute;left:${-r.x}px;top:${-r.y}px"></div></figure>`;
  const doc = (a, b) => `<!doctype html><html><head><style>body{margin:0;background:#05080D;color:#A2B2C6;font:13px system-ui,sans-serif}main{display:flex;gap:32px;padding:24px;align-items:flex-start;width:max-content}figure{margin:0}figcaption{margin:0 0 8px}img{display:block;max-width:none}</style></head><body><main>${a}${b}</main></body></html>`;
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  const files = [];
  try {
    const shot = async (html, file) => {
      await page.setContent(html, { waitUntil: "load" });
      await page.screenshot({ path: file, fullPage: true });
      files.push(file);
    };
    const W = MOCKUP.window;
    await shot(doc(crop("/preview/mockup.png", W, `mockup: window area ${W.w} x ${W.h}`), crop("/preview/window.png", { x: 0, y: 0, w: geo.window.w, h: geo.window.h }, `preview: ${geo.window.w} x ${geo.window.h}`)), join(out, "side-by-side.png"));
    mkdirSync(join(out, "regions"), { recursive: true });
    for (const name of REGIONS) {
      const m = MOCKUP[name], o = ours[name];
      await shot(doc(crop("/preview/mockup.png", m, `mockup: ${name} ${m.w} x ${m.h}`), crop("/preview/window.png", o, `preview: ${name} ${o.w} x ${o.h}`)), join(out, "regions", `${name}.png`));
    }
  } finally {
    await page.close().catch(() => {});
  }
  return files;
}

export async function main(args) {
  const flag = (name) => args.includes(name);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null; };
  const out = value("--out");
  if (!out) {
    console.error("usage: node scripts/dev/window-preview.mjs --out <dir> [--rail] [--reduced-motion] [--mockup <png>] [--one-host] [--plain] [--no-helper]");
    return 2;
  }
  const rail = flag("--rail"), oneHost = flag("--one-host");
  const reducedMotion = flag("--reduced-motion") ? "reduce" : "no-preference";
  const mockupPath = value("--mockup") || join(REPO, "mockup.png");
  const runtime = process.env.PAIRBROWSE_TEST_RUNTIME || join(homedir(), ".pairbrowse", "runtime");
  const geo = geometry({ rail });
  const raw = loadFixtures();
  const fx = resolveTimes(raw, Date.now());
  mkdirSync(out, { recursive: true });

  const log = [];
  const written = [];
  let helper = null, ui = null, proxy = null, browser = null, failed = false;
  try {
    helper = await startFakeHelper({ pageOrigin: null, fixtures: fx.helper });
    // The scene's owners replace the default fixture's whole (a deep merge would keep its tab 11).
    let shim = { ...merge(defaultFixture(), fx.shim), owners: fx.shim.owners };
    if (flag("--no-helper")) shim = { ...shim, helper: null, owners: { agents: {}, colors: {} } };
    if (rail) {
      helper.fixtures.layout = { left: "rail", right: "rail", strip: 53 };
      shim = merge(shim, { layout: { left: 1, right: 1 } });
    }
    ui = await startUiServer({ helper, fixture: shim });
    proxy = await startPreviewServer({ ui, helper, shim, mockupPath: existsSync(mockupPath) ? mockupPath : null, out });
    helper.setPageOrigin(proxy.origin);
    browser = await patchright(runtime).chromium.launch();

    await renderPictures(browser, { proxy, geo, fx, helper, out, reducedMotion });
    written.push(...fx.sample.steps.map((s) => join(out, "pictures", `${s.card}.jpg`)));
    const contents = {};
    for (const scale of [1, 2]) {
      contents[scale] = await renderContents(browser, { proxy, geo, raw, scale, reducedMotion, log });
      const file = join(out, scale === 1 ? "contents.png" : `contents@${scale}x.png`);
      writeFileSync(file, contents[scale]);
      written.push(file);
    }
    // The open build (no docks): the same page, not docked.
    if (flag("--plain")) {
      const file = join(out, "contents-plain.png");
      writeFileSync(file, await renderContents(browser, { proxy, geo, raw, scale: 1, reducedMotion, log, plain: true }));
      written.push(file);
    }
    let first = null;
    for (const scale of [1, 2]) {
      proxy.setContents(contents[scale]);
      const r = await renderWindow(browser, { proxy, helper, geo, raw, scale, reducedMotion, oneHost, rail, out, log });
      written.push(r.file);
      first ??= r;
    }
    if (existsSync(mockupPath)) written.push(...await compose(browser, { proxy, out, rects: first.rects, geo }));
    else console.log(`no mockup at ${mockupPath}: side-by-side.png and regions/ skipped`);

    const files = { log: join(out, "harness-log.json"), frames: join(out, "frames.json") };
    writeFileSync(files.log, JSON.stringify(log, null, 2) + "\n");
    writeFileSync(files.frames, JSON.stringify({ geometry: geo, rects: first.rects, frames: first.frames, streams: first.streams, thumbs: first.thumbs }, null, 2) + "\n");
    written.push(files.log, files.frames);

    for (const f of written) console.log(f);
    for (const f of first.frames) console.log(`  ${f.name} ${f.host} ${f.s ?? "no stream"} eventSources=${f.live?.eventSources ?? "?"}`);
    const { total, byHost } = first.streams;
    console.log(`event streams to the helper: ${total}`);
    for (const h of Object.keys(byHost)) if (byHost[h] || !oneHost) console.log(`  ${h}: ${byHost[h]}`);
    const { loaded, cards } = first.thumbs;
    console.log(`timeline pictures loaded: ${loaded} of ${cards}`);
    if (loaded < cards && !flag("--no-helper")) failed = true;
    const bad = log.filter((e) => BAD_KINDS.has(e.kind));
    for (const e of bad) console.log(`  ${e.frame} ${e.kind}: ${e.text}`);
    const stalled = first.frames.filter((f) => f.s === "connecting").map((f) => f.name);
    if (stalled.length) { console.log(`still connecting: ${stalled.join(", ")}`); failed = true; }
    else console.log("every frame live or with no stream");
    if (bad.length) failed = true;
  } catch (e) {
    console.error(`could not render the window: ${e?.stack || e}`);
    failed = true;
  } finally {
    await browser?.close().catch(() => {});
    await proxy?.close();
    await ui?.close();
    await helper?.close();
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(await main(process.argv.slice(2)));
