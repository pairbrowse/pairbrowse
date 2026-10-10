// Joining someone's session from another computer with a code.
//
// The host's PairBrowse makes a join code: one string with the session's temporary public
// address (a Cloudflare Quick Tunnel), an invite key, the role (watch or drive) and the host's
// name. The joiner pastes it into their own PairBrowse (pairbrowse_join). Nobody gets in on the
// code alone: the host approves each new joiner, and until then nothing of the session is served.
//
// Once in, the joiner's own browser follows the host's tabs (tabsync.mjs).
//
// This file has no side effects on import: codes, the approval list, names and addresses as others
// see them, and the joiner's allowed addresses (saveJoinHosts is the one thing here that writes:
// config.json, on the person's "Always allow" or "Remove").
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const JOIN_PREFIX = "pb-join:";
const KEY = /^[0-9a-f]{64}$/;
export const JOINER_ID = /^[0-9a-f]{32}$/;
// Quick Tunnel addresses: https://<words>.trycloudflare.com, nothing else.
const QUICK_TUNNEL_HOST = /^[a-z0-9]+(-[a-z0-9]+)*\.trycloudflare\.com$/;
// A host name as joinHosts holds it: lower-case labels with dots between, no port, path or
// wildcard. Anything else is "" (never written, never matched).
const HOST_NAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;
export const cleanHost = (h) => { const host = textOf(h).trim().toLowerCase(); return host.length <= 253 && HOST_NAME.test(host) ? host : ""; };
// The joiner's allowed addresses from their config (joinHosts), cleaned; junk entries are skipped.
export const joinHostsOf = (config) => [...new Set((Array.isArray(config?.joinHosts) ? config.joinHosts : []).map(cleanHost).filter(Boolean))];
// Whether a join code's address is taken: a Quick Tunnel, or exactly one of the hosts the person
// allowed (no suffix or wildcard match: share.example.com allows nothing else).
export const hostAllowed = (host, hosts = []) => QUICK_TUNNEL_HOST.test(host) || hosts.includes(host);

// Any value as text, never a throw: a request body can hold { "toString": "" }, which String() can't convert.
export const textOf = (v) => { try { return String(v ?? ""); } catch { return ""; } };
export const numOf = (v) => { try { return Number(v); } catch { return NaN; } };

// A name to show, not markup: no control or formatting characters (bidi, zero-width, broken
// surrogates), at most 40 characters (joiners, participants and invite labels).
export const cleanName = (name, fallback = "Guest") => textOf(name).normalize("NFC")
  .replace(/[\p{Cc}\p{Cf}\p{Cs}<>"'`]/gu, "")
  .replace(/\s+/g, " ").trim().slice(0, 40).replace(/[\ud800-\udbff]$/, "").trim() || fallback;

// What a participant is called everywhere: "Alice · Claude Code", "Alice · Codex", "Alice (by hand)".
export function appName(clientName) {
  const c = textOf(clientName || "");
  if (c === "claude-code") return "Claude Code";
  if (c === "codex-mcp-client" || /^codex/i.test(c)) return "Codex";
  return c ? cleanName(c, "Agent").slice(0, 24) : "Agent";
}
// Which kind of computer someone is on, as the session picker shows it ("Alice · Linux"): the
// operating system only, never the machine's own name.
const COMPUTERS = { darwin: "Mac", linux: "Linux", win32: "Windows" };
export const computerName = (platform = process.platform) => COMPUTERS[platform] || "";
export const cleanComputer = (value) => (Object.values(COMPUTERS).includes(value) ? value : "");
// What this computer's person is called in a shared session: the first real name of
// participantName, PAIRBROWSE_PARTICIPANT, their account's full name and their login. Stand-ins
// like "Host" or "You" are skipped: the other side would see them instead of a name.
const STAND_INS = new Set(["host", "the host", "guest", "pairbrowse", "you", "me", "someone"]);
export function displayName({ configured, env, fullName, username } = {}) {
  const names = [configured, env, fullName, username].map((n) => cleanName(n, ""));
  return names.find((n) => n && !STAND_INS.has(n.toLowerCase())) || names.find(Boolean) || "";
}
export const personLabel = (name, app) => (app ? `${cleanName(name)} · ${app}` : `${cleanName(name)} (by hand)`);

export const newJoinerId = () => randomBytes(16).toString("hex");

// The host's name in a join code: their participantName, or "the host" when they have none
// ("PairBrowse": what older codes carried instead).
const hostLabel = (name) => { const n = cleanName(name, ""); return !n || n === "PairBrowse" ? "the host" : n; };

// mode "shared": the joiner works in the host's own browser, seeing it live (shared browser mode);
// "follow" (and codes from before modes): their browser opens the host's tabs and follows them.
export function encodeJoinCode({ url, key, role, label, mode = "follow" }) {
  const body = JSON.stringify({ v: 1, u: new URL(url).origin, k: key, r: role, l: cleanName(label, ""), ...(mode === "shared" ? { m: "s" } : {}) });
  return JOIN_PREFIX + Buffer.from(body).toString("base64url");
}

// Reads a join code, strictly: an https Quick Tunnel address (or a host you allowed: hosts is
// joinHosts plus the ones allowed once), a well-formed key, and a known role. Throws with a plain
// reason otherwise; for a well-formed https address that just isn't allowed, the error has code
// "unlisted-host" and the host, so the person can be asked (the one check that is theirs to decide).
// allowLocal (tests only, PAIRBROWSE_TEST_JOIN_LOCAL) also takes http://127.0.0.1:<port>.
export function parseJoinCode(code, { hosts = [], allowLocal = false } = {}) {
  const text = textOf(code).trim();
  if (!text.startsWith(JOIN_PREFIX)) throw new Error(`A join code starts with ${JOIN_PREFIX}`);
  const packed = text.slice(JOIN_PREFIX.length);
  if (!packed || packed.length > 1500 || !/^[A-Za-z0-9_-]+$/.test(packed)) throw new Error("That join code is damaged. Ask for it again.");
  let v;
  try { v = JSON.parse(Buffer.from(packed, "base64url").toString("utf8")); } catch { throw new Error("That join code is damaged. Ask for it again."); }
  if (!v || typeof v !== "object" || Array.isArray(v) || v.v !== 1) throw new Error("That join code is from another PairBrowse version.");
  let u;
  try { u = new URL(String(v.u)); } catch { throw new Error("That join code has no valid address."); }
  const local = allowLocal && u.protocol === "http:" && u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !local) throw new Error("A join code's address must start with https://.");
  if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new Error("That join code's address has extra parts. Ask for it again.");
  if (typeof v.k !== "string" || !KEY.test(v.k)) throw new Error("That join code's key is damaged. Ask for it again.");
  if (v.r !== "watch" && v.r !== "drive") throw new Error('A join code\'s role is "watch" or "drive".');
  // Last, once the rest of the code is sound: the address (a damaged code never asks the person).
  const host = u.hostname.toLowerCase();
  if (!local && (u.port || !hostAllowed(host, hosts))) {
    const e = new Error(`That join code points to ${host}, which isn't a Cloudflare Quick Tunnel address (*.trycloudflare.com) or an address you allowed.`);
    if (!u.port && cleanHost(host)) { e.code = "unlisted-host"; e.host = host; }
    throw e;
  }
  return { url: u.origin, host: u.host, key: v.k, role: v.r, label: hostLabel(v.l), mode: v.m === "s" ? "shared" : "follow" };
}

// Writes the joiner's allowed addresses (the person's "Always allow" or "Remove" in the side
// panel) into config.json, keeping the rest of the file, and into the running config. Only clean
// host names are written. file: the config's path (paths.config; a test's own).
export function saveJoinHosts(config, hosts, file) {
  const list = [...new Set((Array.isArray(hosts) ? hosts : []).map(cleanHost).filter(Boolean))];
  config.joinHosts = list;
  let saved = {};
  try { const read = JSON.parse(readFileSync(file, "utf8")); if (read && typeof read === "object" && !Array.isArray(read)) saved = read; } catch {}
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ ...saved, joinHosts: list }, null, 2) + "\n");
  return list;
}

// ---- the joiner's own questions: a code whose address they haven't allowed -----------------
// Each is one code waiting for the person's Allow once / Always allow / Cancel in the side panel
// or the session picker (never an agent's). It keeps the code and the name, so a yes starts the
// join at once. Few wait at once, each for ten minutes, like join requests at the host.
export function createHostAsks({ now = () => Date.now(), maxPending = 5, pendingMs = 10 * 60_000 } = {}) {
  const all = new Map(); // id -> { id, host, code, name, owner, app, who, at }
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) try { fn(); } catch {} };
  const publicView = ({ id, host, who, at }) => ({ id, host, who, at });
  const sweep = () => {
    let gone = false;
    for (const [k, a] of all) if (a.at + pendingMs <= now()) { all.delete(k); gone = true; }
    if (gone) changed();
  };
  return {
    // A new question, or the one already waiting for the same code (asked twice: shown once).
    // null when too many wait already.
    add({ host, code, name = "", owner = null, app = "", who = "" }) {
      sweep();
      const same = [...all.values()].find((a) => a.code === code);
      if (same) return publicView(same);
      if (all.size >= maxPending) return null;
      let id;
      do id = `h${randomBytes(3).toString("hex")}`; while (all.has(id));
      const entry = { id, host: cleanHost(host), code, name, owner, app, who: cleanName(who, ""), at: now() };
      all.set(id, entry);
      changed();
      return publicView(entry);
    },
    // The question whole (code included), off the list: the person answered it.
    take(id) {
      sweep();
      const a = all.get(textOf(id));
      if (!a) return null;
      all.delete(a.id);
      changed();
      return { ...a };
    },
    list() { sweep(); return [...all.values()].map(publicView); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// ---- host approval ------------------------------------------------------------------------
// Each joiner (a random id their PairBrowse makes, plus their name) needs the host's OK once per
// invite. An approval is bound to that joiner: someone else with the same code asks again.
// Few requests may wait at once, and new ones are rate-limited, so a leaked code can't flood
// the host with prompts.
export function createApprovals({ now = () => Date.now(), maxPending = 5, maxNew = 10, windowMs = 10 * 60_000, pendingMs = 10 * 60_000 } = {}) {
  const all = new Map(); // `${inviteId}:${joinerId}` -> entry
  const recent = []; // times new requests came in
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) try { fn(); } catch {} };
  const publicView = ({ id, inviteId, name, app, computer, role, state, at }) => ({ id, inviteId, name, app, computer, role, state, at });
  const sweep = () => {
    let gone = false;
    for (const [k, e] of all) if (e.state === "pending" && e.at + pendingMs <= now()) { all.delete(k); gone = true; }
    if (gone) changed();
  };
  const find = (ref) => {
    const r = textOf(ref);
    return [...all.values()].find((e) => e.id === r || e.joinerId === r) || null;
  };
  const settle = (ref, state) => {
    sweep();
    const e = find(ref);
    if (!e || (state === "approved" && (e.state === "denied" || e.state === "removed"))) return null;
    e.state = state;
    changed();
    return publicView(e);
  };
  return {
    // Where this joiner stands. A new joiner becomes a request (unless too many wait already).
    check(invite, joinerId, name, app = "", computer = "") {
      sweep();
      if (!JOINER_ID.test(textOf(joinerId || ""))) return { state: "bad" };
      const k = `${invite.id}:${joinerId}`;
      const e = all.get(k);
      if (e) return { state: e.state, entry: publicView(e) };
      const t = now();
      while (recent.length && recent[0] <= t - windowMs) recent.shift();
      if ([...all.values()].filter((x) => x.state === "pending").length >= maxPending) return { state: "full" };
      if (recent.length >= maxNew) return { state: "busy" };
      recent.push(t);
      let id;
      do id = `r${randomBytes(3).toString("hex")}`; while (find(id));
      const entry = { id, inviteId: invite.id, joinerId, name: cleanName(name), app: app ? appName(app) : "", computer: cleanComputer(computer), role: invite.role, state: "pending", at: t };
      all.set(k, entry);
      changed();
      return { state: "pending", entry: publicView(entry), isNew: true };
    },
    approve: (ref) => settle(ref, "approved"),
    deny: (ref) => settle(ref, "denied"),
    // The host takes back a yes: that joiner is out at once, and this invite never lets them in
    // again (their key belongs to it; a new invite asks anew). Returns the entry with its key.
    remove(ref) {
      const e = find(ref);
      if (!e || e.state !== "approved") return null;
      e.state = "removed";
      changed();
      return { ...publicView(e), key: `${e.inviteId}:${e.joinerId}` };
    },
    // The joiner left: their approval ends with them (joining again asks again).
    leave(inviteId, joinerId) { if (all.delete(`${inviteId}:${joinerId}`)) changed(); },
    get(inviteId, joinerId) { const e = all.get(`${inviteId}:${joinerId}`); return e ? publicView(e) : null; },
    pending() { sweep(); return [...all.values()].filter((e) => e.state === "pending").map(publicView); },
    // Asking and let in, for the owner's Allow / Deny and Remove.
    open() { sweep(); return [...all.values()].filter((e) => e.state === "pending" || e.state === "approved").map(publicView); },
    list() { sweep(); return [...all.values()].map(publicView); },
    // Invites that ended take their approvals and requests with them.
    forget(inviteIds) {
      let gone = false;
      for (const [k, e] of all) if (inviteIds.includes(e.inviteId)) { all.delete(k); gone = true; }
      if (gone) changed();
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // The yeses (and removals), whole, for the helper's saved sharing state.
    saved() { return [...all.values()].filter((e) => e.state === "approved" || e.state === "removed").map((e) => ({ ...e })); },
    // From that saved state, each checked; only for invites that came back (validInvite(id)).
    restore(list, validInvite = () => true) {
      for (const e of Array.isArray(list) ? list : []) {
        if (!e || !JOINER_ID.test(textOf(e.joinerId || "")) || !/^r[0-9a-f]{6}$/.test(textOf(e.id || "")) || !validInvite(textOf(e.inviteId))) continue;
        if (e.state !== "approved" && e.state !== "removed") continue;
        const k = `${e.inviteId}:${e.joinerId}`;
        if (all.has(k) || find(e.id)) continue;
        all.set(k, { id: e.id, inviteId: textOf(e.inviteId), joinerId: e.joinerId, name: cleanName(e.name), app: e.app ? appName(e.app) : "", computer: cleanComputer(e.computer), role: e.role === "drive" ? "drive" : "watch", state: e.state, at: numOf(e.at) || now() });
      }
      changed();
    },
  };
}

// ---- what invite link guests see ----------------------------------------------------------

// Addresses without their query string and fragment (where tokens, emails and order numbers live).
export function stripUrl(raw) {
  const s = textOf(raw);
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin + u.pathname;
    return u.href === "about:blank" ? s : `${u.protocol}`;
  } catch {
    return s.replace(/[?#][\s\S]*$/, "");
  }
}
// Each web address in a text, through fn. Brackets are part of an address (a query string or a
// path can hold them, and IPv6 hosts do), except closing ones it ends with: "(see https://a.b/c)".
export const eachUrl = (text, fn) => textOf(text).replace(/https?:\/\/[^\s"'`<>]+/gi, (m) => { const [, url, close] = /^([\s\S]*?)([)\]]*)$/.exec(m); return fn(url) + close; });
export const stripText = (text) => eachUrl(text, stripUrl);
