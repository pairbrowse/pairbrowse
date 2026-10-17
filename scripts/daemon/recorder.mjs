// Recording the browser to a video file (pairbrowse_record, the side panel's Record button). The
// side panel's extension captures the tab in front and encodes the video (record.js), following
// tab switches, under a strip naming each tab's agent; this side tells it who works where, and
// at the end takes the file over the browser's private pipe (never over the network) and saves
// it in the Downloads folder.
import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { shortLabel } from "./tablabels.mjs";
import { NO_CAPTURE_RECORD, RECORD_READY_MS } from "./capture.mjs";
import { within } from "../util.mjs";
import { createCoverLoop } from "./covers.mjs";
import { PAGE_CHUNK_BYTES } from "../../ui/limits.js";

const LABELS_EVERY_MS = 1500; // who works in which tab, while recording
const DWELL_MS = 4000; // following agents: a tab stays in the video at least this long while they work there
const CHUNK_BYTES = 4 * 1024 * 1024; // the file comes over in pieces this size (from the extension)
// From the browser's own capture page: PAGE_CHUNK_BYTES (ui/limits.js; its reply route takes at most 2 MB).
const EXT = { "video/mp4": "mp4", "video/webm": "webm" };
const COVER_PAGES = 6; // tabs whose card fields are kept covered while recording (the one in front first)

// The screen's pixel ratio, asked of the open tabs in turn, each within ms: a tab whose renderer
// crashed ("Aw, Snap!") answers with an error and one whose scripts never pause answers nothing;
// both are skipped, never taken for 1x. null when no tab answered (the first PAGES_ASKED only).
const PAGES_ASKED = 4;
export async function pixelRatio(pages, ms = 1500) {
  for (const page of (pages || []).filter((p) => p && !p.isClosed?.()).slice(0, PAGES_ASKED)) {
    const v = await within(ms, page.evaluate(() => devicePixelRatio)).catch(() => null);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

// The file's name, from when the recording started: "PairBrowse recording 2026-10-07 23.41.05".
export function recordingName(at, type, n = 0) {
  const d = new Date(at);
  const p = (v) => String(v).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
  return `PairBrowse recording ${stamp}${n ? ` (${n})` : ""}.${EXT[type] || "webm"}`;
}

const minutes = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

// call(fn, arg, ms): runs fn(arg) in the extension's worker (daemon/panel.mjs). owners(): the agents
// at work, [{ page, who, color }]. dir(): where recordings go. scale(): the screen's pixel ratio
// (pixelRatio), null when no tab told it: the last one told stands.
// changed(state): the side panels show it. onActivity(fn): fn(text, who, page) for each thing an
// agent does (follow "agents"). onSaved({ path, at, ms, size }): a recording was saved (the Tools
// tab's Recordings index, daemon/toolstab.mjs); a throw there never fails the save.
// capture: where tabs are captured (daemon/capture.mjs); without it, the extension as before.
// pages(): the open tabs (for the covers: the tab in front may be any). shared(): the pages
// joiners are shown (screenshare.mjs sharedPages): their covers are kept fresh and sent too.
// Nowhere to capture (a PairBrowse build without its capture page): recording is refused.
export function createRecorder({ onSaved = () => {}, call, owners = () => [], dir, scale = async () => 1, log = () => {}, changed = () => {}, onActivity = () => () => {}, capture = null, pages = async () => [], shared = () => [] }) {
  let on = null; // { since, timer, follow, shown, shownAt, next }
  let knownScale = null; // the last pixel ratio a tab told: kept for when none answers
  let saving = null;
  const tabIds = new WeakMap(); // page -> the browser's tab id
  const ext = (arg, ms = 15_000) => (capture?.kind() === "page" ? capture.record(arg, ms) : call((a) => { if (!globalThis.pbRecord) throw new Error("not ready"); return globalThis.pbRecord(a); }, arg, ms));
  const chunkBytes = () => (capture?.kind() === "page" ? PAGE_CHUNK_BYTES : CHUNK_BYTES);

  async function tabIdOf(page) {
    if (tabIds.has(page)) return tabIds.get(page);
    if (capture) {
      const ref = await capture.tabRef(page, 4000);
      if (ref != null) tabIds.set(page, ref);
      return ref;
    }
    const cdp = await page.context().newCDPSession(page);
    let targetId;
    try { ({ targetInfo: { targetId } } = await cdp.send("Target.getTargetInfo")); } finally { cdp.detach().catch(() => {}); }
    const id = await call((t) => globalThis.pbTabId(t), targetId, 4000);
    if (id != null) tabIds.set(page, id);
    return id;
  }
  async function labels() {
    const out = {};
    for (const { page, who, color } of owners()) {
      if (!page || page.isClosed()) continue;
      const id = await tabIdOf(page).catch(() => null);
      if (id != null && !out[id]) out[id] = { who: String(who || "").slice(0, 40), color, prefix: `${shortLabel(who)} · ` };
    }
    return out;
  }

  const state = () => ({ recording: !!on, since: on?.since || 0 });

  // follow: "front" (the tab the person sees) or "agents" (the tab where agents are at work, held
  // DWELL_MS at least; the browser's own tabs stay as they are).
  async function start(follow = "front") {
    // A build with a capture page that hasn't said hello yet (just launched): wait for it a little.
    if (capture && (typeof capture.waitReady === "function" ? await capture.waitReady(RECORD_READY_MS) : capture.kind()) === null) return { text: NO_CAPTURE_RECORD, error: true };
    if (on) return { text: `Already recording (${minutes(Date.now() - on.since)} so far). Stop it with pairbrowse_record action "stop".` };
    follow = follow === "agents" ? "agents" : "front";
    const asked = await scale().catch(() => null);
    if (Number.isFinite(asked) && asked > 0) knownScale = asked;
    // The tabs' covers first, and kept fresh while the start waits for the tab's first picture:
    // the capture page lets a picture out only with covers read after it (whole, failing that).
    starting = true;
    let r;
    try {
      await within(2500, covers.tick()).catch(() => {});
      r = await ext({ op: "start", follow, labels: await labels().catch(() => ({})), scale: knownScale ?? 1 });
    } finally { starting = false; }
    if (!r || r.error) return { text: `Couldn't start recording: ${r?.error || "no answer from the browser"}.`, error: true };
    on = { since: Date.now(), follow, shown: null, shownAt: 0, next: null };
    on.timer = setInterval(tick, LABELS_EVERY_MS);
    on.timer.unref?.();
    if (follow === "agents") on.stopFollowing = onActivity((_text, _who, page) => { if (page && !page.isClosed()) show(page).catch(() => {}); });
    log(`recording started (${r.type}, ${r.w}x${r.h}, following ${follow === "agents" ? "the agents" : "the tab in front"})`);
    changed(state());
    return { text: `Recording the browser (${r.w}x${r.h}): ${follow === "agents" ? "the tabs where agents work, switching as they do" : "the tab in front, following tab switches"}. Stop with pairbrowse_record action "stop"; the video is saved in ${(() => { try { return dir(); } catch { return "your downloads folder, once one qualifies"; } })()}.` };
  }

  // Following agents: an agent did something in page. Shown now if the tab in the video has been
  // there long enough, else once it has (the latest wins).
  async function show(page) {
    if (!on) return;
    if (on.shown === page) { on.shownAt = Math.max(on.shownAt, Date.now() - DWELL_MS / 2); return; }
    const wait = on.shownAt + DWELL_MS - Date.now();
    if (on.shown && wait > 0) {
      const first = !on.next;
      on.next = page;
      if (first) setTimeout(() => { const p = on?.next; if (on) on.next = null; if (p && !p.isClosed()) show(p).catch(() => {}); }, wait).unref?.();
      return;
    }
    const tabId = await tabIdOf(page);
    if (tabId == null || !on) return;
    on.shown = page;
    on.shownAt = Date.now();
    await ext({ op: "show", tabId }, 8000);
  }

  let ticking = false;
  async function tick() {
    if (ticking || !on) return;
    ticking = true;
    try {
      const r = await ext({ op: "labels", labels: await labels() }, 5000);
      if (r?.full) await stop("it reached an hour");
      else if (r === false) { log("recording ended in the browser"); end(); }
    } catch {} finally { ticking = false; }
  }

  function end() {
    if (!on) return;
    clearInterval(on.timer);
    on.stopFollowing?.();
    on = null;
    changed(state());
  }

  // Stops and saves. why: said in the log when it wasn't asked for.
  async function stop(why = "") {
    if (saving) return saving;
    if (!on) return { text: "Not recording. Start with pairbrowse_record action \"start\".", error: true };
    const since = on.since;
    end();
    saving = (async () => {
      const r = await ext({ op: "stop" }, 30_000);
      if (!r || r.error) return { text: `The recording couldn't be finished: ${r?.error || "no answer from the browser"}.`, error: true };
      const folder = dir();
      mkdirSync(folder, { recursive: true });
      let path, fd;
      for (let n = 0; ; n++) {
        path = join(folder, recordingName(since, r.type, n));
        try { fd = openSync(path, "wx", 0o600); break; } // never over an existing file
        catch (e) { if (e.code !== "EEXIST" || n > 500) throw e; }
      }
      try {
        const piece = chunkBytes();
        for (let offset = 0; offset < r.size; offset += piece) {
          const b64 = await ext({ op: "chunk", offset, size: piece }, 30_000);
          if (typeof b64 !== "string") throw new Error(b64?.error || "a piece of the file didn't come");
          writeSync(fd, Buffer.from(b64, "base64"));
        }
      } finally { closeSync(fd); }
      try { onSaved({ path, at: since, ms: r.ms, size: r.size }); } catch {}
      await ext({ op: "clear" }).catch(() => {});
      log(`recording saved: ${path} (${(r.size / 1e6).toFixed(1)} MB, ${minutes(r.ms)})${why ? `, stopped because ${why}` : ""}`);
      return { text: `Saved the recording (${minutes(r.ms)}, ${(r.size / 1e6).toFixed(1)} MB) to ${path}.`, path };
    })();
    try { return await saving; } finally { saving = null; }
  }

  async function command(args = {}) {
    if (args.action === "start") return start(args.follow);
    if (args.action === "stop") return stop();
    return { text: on ? `Recording, ${minutes(Date.now() - on.since)} so far.` : "Not recording." };
  }

  // The browser closed: what it recorded is gone with it.
  const browserClosed = () => { if (on) log("recording lost: the browser closed"); end(); };

  // ---- card fields covered (daemon/covers.mjs) ----
  let frontId = null; // the tab in front of the recording, as record.js said last
  let starting = false; // a start sends the covers it knows before the first picture
  const ids = new Map(); // tab id -> page, for the tabs asked about
  async function idOf(page) {
    const id = await within(4500, tabIdOf(page)).catch(() => null);
    if (id != null) ids.set(String(id), page);
    return id;
  }
  // The pages whose covers the recording needs: the tab in front first (found among all the open
  // tabs by its tab id), then the agents' and the open ones, up to COVER_PAGES. [] when not
  // recording.
  async function coverPages() {
    if (!on && !starting) return [];
    const open = ((await pages().catch(() => [])) || []).filter((p) => p && !p.isClosed?.());
    let front = frontId != null ? ids.get(String(frontId)) : null;
    if (frontId != null && (!front || front.isClosed?.())) {
      front = null;
      for (const p of open) if (String(await idOf(p)) === String(frontId)) { front = p; break; }
    }
    const out = [];
    const add = (p) => { if (p && !p.isClosed?.() && !out.includes(p)) out.push(p); };
    add(front);
    for (const { page } of owners()) add(page);
    for (const p of open) add(p);
    return out.slice(0, COVER_PAGES);
  }
  // Each page's covers (Map page -> rects) to where tabs are captured, by its tab id: drawn on
  // the recording's frames and on joiners' pictures. Only while recording or shared to. fresh:
  // the pages read this time (the others aren't sent again); mark: when, on the capture page's
  // clock, the reads began (covers.mjs createCoverLoop).
  let said = false;
  const live = () => on || starting || (shared() || []).length;
  async function sendCovers(got, { mark = null, fresh = null } = {}) {
    if (!live()) return;
    if (capture && capture.kind() === null) return;
    const covers = {};
    for (const [page, rects] of got) {
      if (fresh && !fresh.has(page)) continue;
      const id = await idOf(page);
      if (id != null) covers[String(id)] = rects;
    }
    if (!Object.keys(covers).length) return;
    const r = await ext({ op: "covers", covers, ...(Number.isFinite(mark) ? { mark } : {}) }, 3000).catch((e) => ({ error: e?.message || String(e) }));
    if (r && !r.error) frontId = r.front ?? frontId;
    else if (!said) { said = true; log(`covers: ${r?.error || "no answer from the browser"}`); }
  }
  // A picture (base64 JPEG of a page's view) with rects drawn on, where tabs are captured (never
  // in the page's own renderer: a cross-site frame's pixels don't go into the top site's). The
  // covered JPEG, or null (the picture then never leaves).
  let saidNowhere = false;
  async function coverPicture(data, rects) {
    if (capture && capture.kind() === null) {
      if (!saidNowhere) { saidNowhere = true; log("covers: nowhere to draw them (no capture page yet): pictures with card fields aren't sent or kept"); }
      return null;
    }
    const r = await within(4000, ext({ op: "coverPicture", data, rects }, 3500)).catch(() => null);
    return typeof r === "string" && r ? r : null;
  }
  // When the reads begin, on the capture page's clock (performance.now() there), or null.
  async function coverMark() {
    if (!live() || (capture && capture.kind() === null)) return null;
    const r = await within(1500, ext({ op: "coverMark" }, 1000)).catch(() => null);
    return Number.isFinite(r) ? r : null;
  }

  // The covers, kept fresh while recording or shared to (covers.mjs createCoverLoop): recordings
  // and joiners' direct pictures get them here (sendCovers); the slower route's frames, live view
  // guests' pictures (their own want) and the timeline's are covered through covers.picture.
  const covers = createCoverLoop({ compose: (_page, data, rects) => coverPicture(data, rects), mark: coverMark, log });
  covers.want(coverPages);
  covers.want(() => shared() || []);
  covers.onTick(sendCovers);

  return { command, start, stop, state, browserClosed, coverPages, sendCovers, coverPicture, covers };
}
