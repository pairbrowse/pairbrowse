// The Tools tab's data (the browser's own pages, the owner only): this session's downloads, the
// recordings this helper saved, the hand-offs waiting for the person, and opening or revealing a
// file with the OS opener. Every file is named by a random 12-hex id; its path stays here, never in
// an answer or an event. Node's standard library only; nothing here runs on a timer.
import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn, execFile as nodeExecFile } from "node:child_process";
import { lstatSync, unlinkSync, chmodSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { paths } from "../paths.mjs";
import { readJson, writeJsonAtomic, within } from "../util.mjs";

const DOWNLOADS_KEPT = 100;
const RECORDINGS_KEPT = 500;
const newId = () => randomBytes(6).toString("hex");

// Downloads open like a browser's: any file, with the system's default app (see downloadMarked and
// PROGRAMS below). Recordings, files the helper made itself, open only as these types.
// (Not .svg: its usual opener is a web browser, where an SVG runs script under file://.)
export const OPENABLE = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "txt", "csv", "json", "md",
  "mp4", "mov", "webm", "m4v", "mp3", "wav", "m4a"]);
const ext = (path) => extname(String(path || "")).slice(1).toLowerCase();
export const openable = (path) => OPENABLE.has(ext(path));

// Programs and scripts: a download of one of these opens only after the person confirms.
export const PROGRAMS = new Set(["app", "pkg", "mpkg", "dmg", "command", "sh", "bash", "zsh", "py", "rb", "pl", "js", "jar",
  "exe", "msi", "bat", "cmd", "ps1", "scpt", "workflow", "terminal", "tool"]);
export const isProgram = (path) => PROGRAMS.has(ext(path));

// On macOS a download opens only while it still carries com.apple.quarantine, the mark Gatekeeper
// and Office's Protected View act on; the helper never adds or removes it. Elsewhere true (Windows
// keeps its own Mark of the Web, untouched). xattr(path): resolves the attribute's value or null.
const XATTR_MS = 3000;
const readQuarantine = (path, execFile = nodeExecFile) => new Promise((resolve) => {
  try {
    execFile("/usr/bin/xattr", ["-p", "com.apple.quarantine", path], { timeout: XATTR_MS }, (err, out) => resolve(err ? null : String(out || "")));
  } catch { resolve(null); }
});
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
export function createDownloads({ session = () => "" } = {}) {
  const all = new Map(); // id -> { id, name, host, title, by, at, state, path, ino, size, session }
  const changes = listeners();
  const pub = (e) => ({ id: e.id, name: e.name, size: e.size, at: e.at, from: { host: e.host, title: e.title }, state: e.state, by: e.by });
  const changed = (op, e) => changes.emit({ op, item: pub(e) });
  return {
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
  };
}

// The recordings this helper saved, indexed in an owner-only file so only they can be deleted,
// across restarts. Each entry carries the file's inode and size, checked before any action.
export function createRecordings({ file = join(paths.home, "recordings.json") } = {}) {
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
