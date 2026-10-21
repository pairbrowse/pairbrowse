// The audit trail (spec server-mode B17): one JSON line per hand-off event, appended to
// paths.audit (~/.pairbrowse/audit.jsonl) and never rewritten. A line is { t, kind, grant, session,
// tab, detail } and nothing else: t the time (epoch ms, from now()), kind one of KINDS, grant a
// grant's 8-hex id (never a key), session a session's name, tab the page's origin and path only (a
// query or fragment carries codes and tokens; a path segment that looks like a key or token, as in
// the live view's and invite links' own addresses or a site's reset link, becomes "*"), detail one
// word or a short list of words from the
// kind's fixed vocabulary (DETAILS). A field this doesn't know, a kind or word outside the
// vocabulary, or a value of the wrong shape refuses the whole line (logged by field name, never by
// value), so no key, link, secret value, typed text or page content can reach the file by mistake.
// The file is owner-only (0600), opened without following a link at its name, without waiting on a
// pipe, and only when it is a regular file of this user's; before a line would take it past maxBytes (1 MB) it moves to
// <file>.1 (the one older generation, replaced each time, owner-only too) and a new file starts.
// Writes are synchronous: events are rare, and a line cut short by a helper stop is a line lost.
import { closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, writeFileSync, constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { validName } from "../sessions.mjs";

export const AUDIT_MAX_BYTES = 1024 * 1024;
export const KINDS = ["minted", "notified", "notify-failed", "reminded", "redeemed", "reuse", "stream-refused", "input-refused", "request-refused", "ended"];
// The hand-off channels (B6). A sender added to the notify table passes its type through
// createAudit's `channels`, so the composition root hands the table's types over.
export const CHANNEL_TYPES = ["webhook", "ntfy", "telegram", "discord", "slack"];
// Each kind's words. minted: the action kind (B7) and "replacement" for a link reissued after a
// restart (B16); notified, notify-failed: the channels; reminded: the channels and whether the
// redeem key was spent already; reuse: which key; stream-refused, input-refused, request-refused (any
// other request on a grant key, such as the landing page): why; ended: the
// grant's end reason (B15). Kinds not listed take no detail. "channels" stands for CHANNEL_TYPES.
export const DETAILS = {
  minted: ["captcha", "2fa", "payment", "login", "other", "replacement"],
  notified: ["channels", "no-link"],
  "notify-failed": ["channels", "no-channel"],
  reminded: ["channels", "no-link", "already-opened"],
  reuse: ["redeem-key", "view-key"],
  "stream-refused": ["second-stream", "other-origin", "other-session", "expired"],
  "input-refused": ["out-of-scope", "not-allowed", "expired"],
  "request-refused": ["other-origin"],
  ended: ["done", "window", "cleared", "agent", "tab-closed", "session-switched", "revoked", "expired", "browser-restarted", "helper-stopped"],
};
const FIELDS = new Set(["kind", "grant", "session", "tab", "detail"]);
const GRANT_ID = /^[0-9a-f]{8}$/;
const DETAIL_MAX = 8;
const TAB_MAX = 300;
// A path segment this long in key or token letters (hex, base64url) is written as "*".
const KEYLIKE = /^[A-Za-z0-9_-]{32,}$/;

// A page address as a line keeps it: origin and path for http(s), with key-like path segments as
// "*", "about:blank" as itself; anything else (another scheme, not an address) is null.
export function tabPlace(url) {
  if (url === "about:blank") return url;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const path = u.pathname.split("/").map((seg) => (KEYLIKE.test(seg) ? "*" : seg)).join("/");
  return `${u.origin}${path}`.slice(0, TAB_MAX);
}

// entry ({ kind, grant?, session?, tab?, detail? }) as the line written: { line } (with its t), or
// { error } naming what was refused (field names and rules only, never a value).
export function auditLine(entry, { now = Date.now, channels = CHANNEL_TYPES } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { error: "an audit entry is an object" };
  const unknown = Object.keys(entry).filter((k) => !FIELDS.has(k));
  if (unknown.length) return { error: `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}` };
  const { kind, grant = null, session = null, tab = null, detail = null } = entry;
  if (!KINDS.includes(kind)) return { error: "kind isn't one of the audit's kinds" };
  if (grant !== null && !(typeof grant === "string" && GRANT_ID.test(grant))) return { error: "grant is a grant's 8-hex id" };
  if (session !== null && !validName(session)) return { error: "session is a session's name" };
  const place = tab === null ? null : tabPlace(tab);
  if (tab !== null && place === null) return { error: "tab is a web page's address" };
  const words = new Set((DETAILS[kind] || []).flatMap((w) => (w === "channels" ? channels : [w])));
  const list = detail === null ? [] : Array.isArray(detail) ? detail : [detail];
  if (list.length > DETAIL_MAX || list.some((w) => typeof w !== "string" || !words.has(w)) || new Set(list).size !== list.length) {
    return { error: `detail isn't from ${kind}'s words` };
  }
  return { line: { t: now(), kind, grant, session, tab: place, detail: list.length ? detail : null } };
}

// file: where lines go (paths.audit). now(): the clock (tests). log(line): refusals and failed
// writes, by field name or error code. maxBytes: the size a file reaches before it moves to
// <file>.1. channels: the hand-off channel types detail may name.
// append(entry): true when the line was written, false when it was refused or couldn't be.
export function createAudit({ file, now = Date.now, log = () => {}, maxBytes = AUDIT_MAX_BYTES, channels = CHANNEL_TYPES } = {}) {
  if (typeof file !== "string" || !file) throw new Error("createAudit needs the audit file");
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const NOFOLLOW = fsConstants.O_NOFOLLOW || 0; // not on Windows
  // A pipe at the name with no reader would block a plain open, and the helper with it; this way
  // the open fails (ENXIO) instead.
  const NONBLOCK = fsConstants.O_NONBLOCK || 0;
  const refuse = (message, code) => Object.assign(new Error(message), { code });
  let made = false;

  // The name holds nothing yet or a regular file; anything else (a link, a pipe, a folder) refuses
  // the line before an open could follow or wait on it.
  function check() {
    let st;
    try { st = lstatSync(file); } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
    if (!st.isFile()) throw refuse("not a regular file", "ENOTFILE");
    return st;
  }

  // The current file moves aside when this line would take it past maxBytes: only this user's
  // regular file, put back to owner-only first so .1 is never wider than the file.
  function rotate(st, bytes) {
    if (!st || st.size === 0 || st.size + bytes <= maxBytes) return;
    if (uid !== null && st.uid !== uid) return; // not ours: the open below refuses it
    const fd = openSync(file, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
    try {
      const fst = fstatSync(fd);
      if (!fst.isFile() || (uid !== null && fst.uid !== uid)) return;
      if (uid !== null && (fst.mode & 0o077)) fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    renameSync(file, `${file}.1`);
  }

  function write(text) {
    if (!made) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); made = true; }
    rotate(check(), Buffer.byteLength(text));
    const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NOFOLLOW | NONBLOCK, 0o600);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw refuse("not a regular file", "ENOTFILE");
      if (uid !== null && st.uid !== uid) throw refuse("not this user's file", "ENOTOWNER");
      if (uid !== null && (st.mode & 0o077)) fchmodSync(fd, 0o600); // made wider by hand: owner-only again
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
  }

  function append(entry) {
    const { line, error } = auditLine(entry, { now, channels });
    if (error) { try { log(`audit: refused a line (${error})`); } catch {} return false; }
    try {
      write(`${JSON.stringify(line)}\n`);
      return true;
    } catch (e) {
      try { log(`audit: couldn't write ${file} (${e?.code || "error"})`); } catch {}
      return false;
    }
  }

  return { append, file };
}
