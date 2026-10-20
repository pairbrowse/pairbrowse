// The Tools tab's data (the browser's own pages, the owner only): this session's downloads, the
// recordings this helper saved, the hand-offs waiting for the person, how a download opens (in a
// person-owned tab, as a read-only preview there, or with the OS opener; openWay) and the person's
// own tabs (createPersonTabs), and opening or revealing a file with the OS opener. Every file is
// named by a random 12-hex id; its path stays here, never in an answer or an event. Node's
// standard library only; nothing here runs on a timer.
import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn, execFile as nodeExecFile } from "node:child_process";
import { lstatSync, unlinkSync, chmodSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { paths } from "../paths.mjs";
import { readJson, writeJsonAtomic, within, urlHost } from "../util.mjs";

const DOWNLOADS_KEPT = 100;
const RECORDINGS_KEPT = 500;
const newId = () => randomBytes(6).toString("hex");

// Downloads open like a browser's: in a person's tab where the engine renders them, else with the
// system's default app (see openWay, downloadMarked and PROGRAMS below). Recordings, files the
// helper made itself, open with the OS opener and only as these types.
// (Not .svg: its usual opener is a web browser, where an SVG runs script under file://.)
export const OPENABLE = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "txt", "csv", "json", "md",
  "mp4", "mov", "webm", "m4v", "mp3", "wav", "m4a"]);
const ext = (path) => extname(String(path || "")).slice(1).toLowerCase();
export const openable = (path) => OPENABLE.has(ext(path));

// Web pages and web shortcuts: they open in a web browser under file:// (or send it to a page)
// and can run script, so they count as programs below.
export const WEB_FILES = new Set(["html", "htm", "xhtml", "svg", "svgz", "shtml", "mht", "mhtml", "webarchive", "url", "webloc", "inetloc"]);
// Programs and scripts: a download of one of these opens only after the person confirms.
export const PROGRAMS = new Set(["app", "pkg", "mpkg", "dmg", "command", "sh", "bash", "zsh", "py", "rb", "pl", "js", "jar",
  "exe", "msi", "bat", "cmd", "ps1", "scpt", "workflow", "terminal", "tool", ...WEB_FILES]);

// Downloads the engine renders itself open in a new tab that belongs to the person (no agent reads
// or acts in it). Not .csv (the engine's MIME table maps it to text/csv, a type blink downloads
// rather than shows) or .log (no MIME entry): those come as an escaped text preview. Not .mov
// (video/quicktime, which the engine doesn't play) or .aac (no entry in the engine's own table): those
// open with their app.
export const TAB_TYPES = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "webm", "ogv", "mp3", "wav", "ogg", "oga", "opus", "flac", "txt", "md", "json"]);
// Proprietary codecs: only the macOS PairBrowse build plays them (proprietary_codecs in its build).
export const CODEC_TYPES = new Set(["mp4", "m4v", "m4a"]);
export const TEXT_TYPES = new Set(["csv", "log"]);
// Word-type documents: on macOS a read-only preview made by textutil (daemon/preview.mjs).
export const DOCUMENT_TYPES = new Set(["doc", "docx", "rtf", "odt"]);
export const TEXT_PREVIEW_MAX = 10 * 1024 * 1024;
export const DOCUMENT_PREVIEW_MAX = 50 * 1024 * 1024;
export const isDocument = (path) => DOCUMENT_TYPES.has(ext(path));

// How a download opens: "tab" (the file in a person's tab), "text" or "document" (a preview in
// one), or "app" (the OS opener). tab / preview: whether the helper can open a tab / make a preview.
export function openWay(path, { platform = process.platform, engine = null, size = 0, tab = false, preview = false } = {}) {
  const x = ext(path);
  if (tab && TAB_TYPES.has(x)) return "tab";
  if (tab && CODEC_TYPES.has(x) && engine === "pairbrowse" && platform === "darwin") return "tab";
  if (tab && preview && TEXT_TYPES.has(x) && size <= TEXT_PREVIEW_MAX) return "text";
  if (tab && preview && DOCUMENT_TYPES.has(x) && platform === "darwin" && size <= DOCUMENT_PREVIEW_MAX) return "document";
  return "app";
}

// The confirm a download needs before it opens with its app, worded for what it is; null: none.
export function confirmFor(path) {
  const x = ext(path);
  if (WEB_FILES.has(x)) return "This is a web page saved to your computer. It opens in your web browser and can run its own scripts. Open it anyway?";
  if (PROGRAMS.has(x)) return "This is a program or script. Open it anyway?";
  return null;
}

// The person's own tabs: a file they opened from Downloads. Theirs for the tab's whole life (the
// entry goes when it closes); any file: tab counts too, however it came to show a file.
export function createPersonTabs() {
  const set = new WeakSet();
  return {
    add(page) { if (page) set.add(page); },
    delete(page) { if (page) set.delete(page); },
    has(page) {
      if (!page) return false;
      if (set.has(page)) return true;
      try { return String(page.url?.() ?? "").toLowerCase().startsWith("file:"); } catch { return false; }
    },
  };
}

// On macOS a download opens only while it still carries com.apple.quarantine, the mark Gatekeeper
// and Office's Protected View act on; the helper never adds or removes it. Elsewhere true (Windows
// keeps its own Mark of the Web, untouched). xattr(path): resolves the attribute's value or null.
const XATTR_MS = 3000;
const readQuarantine = (path, execFile = nodeExecFile) => new Promise((resolve) => {
  try {
    execFile("/usr/bin/xattr", ["-p", "com.apple.quarantine", path], { timeout: XATTR_MS }, (err, out) => resolve(err ? null : String(out || "")));
  } catch { resolve(null); }
});
// A copy drops extended attributes, the browser's download mark among them: carry the browser's own
// mark from its file to the helper's copy (never one of our own: no mark on the source, none on the copy).
const writeQuarantine = (path, value, execFile = nodeExecFile) => new Promise((resolve) => {
  try {
    execFile("/usr/bin/xattr", ["-w", "com.apple.quarantine", value, path], { timeout: XATTR_MS }, (err) => resolve(!err));
  } catch { resolve(false); }
});
export async function keepDownloadMark(from, to, { platform = process.platform, read = readQuarantine, write = writeQuarantine } = {}) {
  if (platform !== "darwin") return false;
  const v = await within(XATTR_MS, Promise.resolve().then(() => read(String(from))).catch(() => null));
  if (typeof v !== "string" || v.trim() === "") return false;
  return (await within(XATTR_MS, Promise.resolve().then(() => write(String(to), v.trim())).catch(() => false))) === true;
}
export async function downloadMarked(path, { platform = process.platform, xattr = readQuarantine } = {}) {
  if (platform !== "darwin") return true;
  const v = await within(XATTR_MS, Promise.resolve().then(() => xattr(String(path))).catch(() => null));
  return typeof v === "string" && v.trim() !== "";
}

// The file the helper saved is still that file: a regular file (not a symlink), same inode and size.
export function fileStill(entry) {
  if (!entry?.path) return false;
  try {
    const st = lstatSync(entry.path);
    return st.isFile() && !st.isSymbolicLink() && st.ino === entry.ino && st.size === entry.size;
  } catch { return false; }
}

const listeners = () => {
  const set = new Set();
  return {
    on(fn) { set.add(fn); return () => set.delete(fn); },
    emit(change) { for (const fn of set) { try { fn(change); } catch {} } },
    get size() { return set.size; },
  };
};

// The downloads of the browser session open now (session(): its name), in memory only.
// agentOf(page): the agent at work in a tab ({ label, color }) or null, for event().
export function createDownloads({ session = () => "", agentOf = () => null } = {}) {
  const all = new Map(); // id -> { id, name, host, title, by, at, state, path, ino, size, session }
  const changes = listeners();
  const pub = (e) => ({ id: e.id, name: e.name, size: e.size, at: e.at, from: { host: e.host, title: e.title }, state: e.state, by: e.by });
  const changed = (op, e) => changes.emit({ op, item: pub(e) });
  const api = {
    add({ name, host = "", title = "", by = null } = {}) {
      const id = newId();
      const e = { id, name: String(name || "download"), host: String(host || ""), title: String(title || ""), by: by ? { label: String(by.label || ""), color: String(by.color || "") } : null,
        at: Date.now(), state: "in-progress", path: null, ino: 0, size: 0, session: session() };
      all.set(id, e);
      while (all.size > DOWNLOADS_KEPT) all.delete(all.keys().next().value);
      changed("add", e);
      return id;
    },
    done(id, path) {
      const e = all.get(id);
      if (!e) return;
      try {
        const st = lstatSync(path);
        Object.assign(e, { path, ino: st.ino, size: st.size, name: basename(path), state: "done" });
      } catch { e.state = "failed"; }
      changed("update", e);
    },
    failed(id) { const e = all.get(id); if (e) { e.state = "failed"; changed("update", e); } },
    setTitle(id, title) { const e = all.get(id); if (e && title) { e.title = String(title); changed("update", e); } },
    list() { const s = session(); return [...all.values()].filter((e) => e.session === s).reverse().map(pub); },
    // Only this browser session's downloads, as list() shows them: an earlier session's id is unknown.
    entry: (id) => { const e = all.get(id); return e && e.session === session() ? e : null; },
    onChange: (fn) => changes.on(fn),
    listeners: () => changes.size,
    // Downloads still running, in any session (handoff.mjs: the helper isn't idle). One started
    // over DOWNLOAD_STALE_MS ago counts no more (a browser that died under it never says it ended).
    inProgress: (now = Date.now()) => [...all.values()].filter((e) => e.state === "in-progress" && now - e.at < DOWNLOAD_STALE_MS).length,
    // A download started, finished or failed in the browser (context.mjs keepDownloads): its id.
    // A start is named by its tab's host and the agent at work there; the tab's title follows.
    event({ op, name, page, id, path } = {}) {
      if (op === "start") {
        let by = null;
        try { const a = agentOf(page); if (a) by = { label: a.label, color: a.color }; } catch {}
        const newId = api.add({ name, host: urlHost(page?.url?.() || ""), title: "", by });
        within(1000, Promise.resolve(page?.title?.()).catch(() => "")).then((t) => { if (t) api.setTitle(newId, t); }).catch(() => {});
        return newId;
      }
      if (!id) return null;
      if (op === "done") api.done(id, path);
      else if (op === "failed") api.failed(id);
      return id;
    },
  };
  return api;
}
const DOWNLOAD_STALE_MS = 60 * 60_000;

// The recordings this helper saved, indexed in an owner-only file so only they can be deleted,
// across restarts. Each entry carries the file's inode and size, checked before any action.
export function createRecordings({ file = paths.recordings } = {}) {
  let index = null; // newest first: { id, path, at, ms, size, ino }
  const changes = listeners();
  const load = () => {
    if (index) return index;
    const raw = readJson(file, []);
    return (index = (Array.isArray(raw) ? raw : []).filter((e) => e && typeof e.id === "string" && typeof e.path === "string"));
  };
  const save = () => { writeJsonAtomic(file, index); try { chmodSync(file, 0o600); } catch {} };
  const pub = (e) => ({ id: e.id, name: basename(e.path), size: e.size, at: e.at, duration: e.ms });
  return {
    add({ path, at = Date.now(), ms = 0, size = 0 } = {}) {
      let st;
      try { st = lstatSync(path); } catch { return null; }
      load();
      const e = { id: newId(), path: String(path), at: Number(at) || Date.now(), ms: Number(ms) || 0, size: st.size ?? size, ino: st.ino };
      index.unshift(e);
      index.length = Math.min(index.length, RECORDINGS_KEPT);
      save();
      const item = pub(e);
      changes.emit({ op: "saved", item });
      return item;
    },
    // Newest first; entries whose file is gone leave the index (no file is touched).
    list() {
      load();
      const kept = index.filter((e) => { try { lstatSync(e.path); return true; } catch { return false; } });
      if (kept.length !== index.length) { index = kept; save(); }
      return index.map(pub);
    },
    entry: (id) => load().find((e) => e.id === id) || null,
    itemFor: (path) => { const e = load().find((x) => x.path === path); return e ? pub(e) : null; },
    remove(id) {
      const e = load().find((x) => x.id === id);
      if (!e) return { status: 404 };
      if (!fileStill(e)) return { status: 410 };
      try { unlinkSync(e.path); } catch { return { status: 410 }; }
      index = index.filter((x) => x !== e);
      save();
      changes.emit({ op: "removed", id });
      return { ok: true };
    },
    onChange: (fn) => changes.on(fn),
    listeners: () => changes.size,
  };
}

// What a hand-off is about, from the agent's own words (a label only: the text is shown as said).
export function handoffKind(text) {
  const t = String(text || "");
  if (/captcha|bot check|not a robot|are you (a )?human|solve the check|turnstile/i.test(t)) return "captcha";
  if (/\b(2fa|mfa|otp|two[- ]factor|one[- ]time (code|password)|verification code|security code|authenticator|sms code)\b/i.test(t)) return "2fa";
  if (/\b(pay|payment|card|billing|checkout|purchase|cvv|cvc)\b/i.test(t)) return "payment";
  if (/\b(log ?in|sign ?in|password|passkey)\b/i.test(t)) return "login";
  return "other";
}

// Steps waiting for the person, by the helper's own key (an agent's status, a run's step, the
// CAPTCHA turn): { id, kind, text, page, by, at }. Setting a key again keeps its id.
export function createHandoffs() {
  const all = new Map(); // key -> item
  const changes = listeners();
  return {
    set(key, { text, page = null, kind, by = null } = {}) {
      const was = all.get(key);
      const t = String(text || "");
      if (was && was.text === t && was.page === page) return was.id;
      const item = { id: was?.id || newId(), kind: kind || handoffKind(t), text: t, page, by: by ? { label: String(by.label || ""), color: String(by.color || "") } : null, at: was?.at || Date.now() };
      all.set(key, item);
      changes.emit({ op: "add", item });
      return item.id;
    },
    clear(key) {
      const was = all.get(key);
      if (!was) return;
      all.delete(key);
      changes.emit({ op: "remove", id: was.id });
    },
    forgetPage(page) {
      for (const [key, item] of all) if (item.page === page) { all.delete(key); changes.emit({ op: "remove", id: item.id }); }
    },
    list: () => [...all.values()].filter((h) => !h.page?.isClosed?.()).sort((a, b) => b.at - a.at),
    entry: (id) => [...all.values()].find((h) => h.id === id) || null,
    onChange: (fn) => changes.on(fn),
    listeners: () => changes.size,
  };
}

// Opens a file (how: "open") or shows it in its folder ("reveal") with the OS opener, on a
// person's click only. Resolves { ok: true } once the opener started, { error } if it couldn't;
// its exit code is not waited for. Never throws.
export function openFile(path, how, { platform = process.platform, spawn = nodeSpawn } = {}) {
  const p = String(path);
  const reveal = how === "reveal";
  const [cmd, args] = platform === "darwin" ? ["open", reveal ? ["-R", p] : [p]]
    : platform === "win32" ? ["explorer", [reveal ? `/select,${p}` : p]]
      : ["xdg-open", [reveal ? dirname(p) : p]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
      child.once("spawn", () => resolve({ ok: true }));
      child.once("error", (e) => resolve({ error: e?.code || "couldn't start the opener" }));
      child.unref?.();
    } catch (e) { resolve({ error: e?.code || "couldn't start the opener" }); }
  });
}
