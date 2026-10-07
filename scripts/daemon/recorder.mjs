// Recording the browser to a video file (pairbrowse_record, the side panel's Record button). The
// side panel's extension captures the tab in front and encodes the video (record.js), following
// tab switches, under a strip naming each tab's agent; this side tells it who works where, and
// at the end takes the file over the browser's private pipe (never over the network) and saves
// it in the Downloads folder.
import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { shortLabel } from "./tablabels.mjs";

const LABELS_EVERY_MS = 1500; // who works in which tab, while recording
const DWELL_MS = 4000; // following agents: a tab stays in the video at least this long while they work there
const CHUNK_BYTES = 4 * 1024 * 1024; // the file comes over in pieces this size
const EXT = { "video/mp4": "mp4", "video/webm": "webm" };

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
// at work, [{ page, who, color }]. dir(): where recordings go. scale(): the screen's pixel ratio.
// changed(state): the side panels show it. onActivity(fn): fn(text, who, page) for each thing an
// agent does (follow "agents").
export function createRecorder({ call, owners = () => [], dir, scale = async () => 1, log = () => {}, changed = () => {}, onActivity = () => () => {} }) {
  let on = null; // { since, timer, follow, shown, shownAt, next }
  let saving = null;
  const tabIds = new WeakMap(); // page -> the browser's tab id
  const ext = (arg, ms = 15_000) => call((a) => { if (!globalThis.pbRecord) throw new Error("not ready"); return globalThis.pbRecord(a); }, arg, ms);

  async function tabIdOf(page) {
    if (tabIds.has(page)) return tabIds.get(page);
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
    if (on) return { text: `Already recording (${minutes(Date.now() - on.since)} so far). Stop it with pairbrowse_record action "stop".` };
    follow = follow === "agents" ? "agents" : "front";
    const r = await ext({ op: "start", follow, labels: await labels().catch(() => ({})), scale: await scale().catch(() => 1) });
    if (!r || r.error) return { text: `Couldn't start recording: ${r?.error || "no answer from the browser"}.`, error: true };
    on = { since: Date.now(), follow, shown: null, shownAt: 0, next: null };
    on.timer = setInterval(tick, LABELS_EVERY_MS);
    on.timer.unref?.();
    if (follow === "agents") on.stopFollowing = onActivity((_text, _who, page) => { if (page && !page.isClosed()) show(page).catch(() => {}); });
    log(`recording started (${r.type}, ${r.w}x${r.h}, following ${follow === "agents" ? "the agents" : "the tab in front"})`);
    changed(state());
    return { text: `Recording the browser (${r.w}x${r.h}): ${follow === "agents" ? "the tabs where agents work, switching as they do" : "the tab in front, following tab switches"}. Stop with pairbrowse_record action "stop"; the video is saved in ${dir()}.` };
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
        for (let offset = 0; offset < r.size; offset += CHUNK_BYTES) {
          const b64 = await ext({ op: "chunk", offset, size: CHUNK_BYTES }, 30_000);
          if (typeof b64 !== "string") throw new Error(b64?.error || "a piece of the file didn't come");
          writeSync(fd, Buffer.from(b64, "base64"));
        }
      } finally { closeSync(fd); }
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

  return { command, start, stop, state, browserClosed };
}
