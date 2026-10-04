// Joining someone's session from another computer with a code.
//
// The host's PairBrowse makes a join code: one string with the session's temporary public
// address (a Cloudflare Quick Tunnel), an invite key, the role (watch or drive) and the host's
// name. The joiner pastes it into their own PairBrowse (pairbrowse_join). Nobody gets in on the
// code alone: the host approves each new joiner, and until then nothing of the session is served.
//
// Once in, the joiner's own browser follows the host's tabs (tabsync.mjs).
//
// This file has no side effects: codes, the approval list, and names and addresses as others see them.
import { randomBytes } from "node:crypto";

const JOIN_PREFIX = "pb-join:";
const KEY = /^[0-9a-f]{64}$/;
export const JOINER_ID = /^[0-9a-f]{32}$/;
// Quick Tunnel addresses: https://<words>.trycloudflare.com, nothing else.
const QUICK_TUNNEL_HOST = /^[a-z0-9]+(-[a-z0-9]+)*\.trycloudflare\.com$/;

// A name to show, not markup: no control or formatting characters, at most 40 characters
// (joiners, participants and invite labels).
export const cleanName = (name, fallback = "Guest") => String(name ?? "").normalize("NFC")
  .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿<>"'`]/g, "")
  .replace(/\s+/g, " ").trim().slice(0, 40) || fallback;

// What a participant is called everywhere: "Alice · Claude Code", "Alice · Codex", "Alice (by hand)".
export function appName(clientName) {
  const c = String(clientName || "");
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

export function encodeJoinCode({ url, key, role, label }) {
  const body = JSON.stringify({ v: 1, u: new URL(url).origin, k: key, r: role, l: cleanName(label, "") });
  return JOIN_PREFIX + Buffer.from(body).toString("base64url");
}

// Reads a join code, strictly: an https Quick Tunnel address (or a host you listed in
// joinHosts), a well-formed key, and a known role. Throws with a plain reason otherwise.
// allowLocal (tests only, PAIRBROWSE_TEST_JOIN_LOCAL) also takes http://127.0.0.1:<port>.
export function parseJoinCode(code, { hosts = [], allowLocal = false } = {}) {
  const text = String(code ?? "").trim();
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
  const host = u.hostname.toLowerCase();
  if (!local && (u.port || !(QUICK_TUNNEL_HOST.test(host) || hosts.includes(host)))) {
    throw new Error(`That join code points to ${host}, which isn't a Cloudflare Quick Tunnel address (*.trycloudflare.com) or one of your joinHosts.`);
  }
  if (typeof v.k !== "string" || !KEY.test(v.k)) throw new Error("That join code's key is damaged. Ask for it again.");
  if (v.r !== "watch" && v.r !== "drive") throw new Error('A join code\'s role is "watch" or "drive".');
  return { url: u.origin, host: u.host, key: v.k, role: v.r, label: hostLabel(v.l) };
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
    const r = String(ref ?? "");
    return [...all.values()].find((e) => e.id === r || e.joinerId === r) || null;
  };
  const settle = (ref, state) => {
    sweep();
    const e = find(ref);
    if (!e || (state === "approved" && e.state === "denied")) return null;
    e.state = state;
    changed();
    return publicView(e);
  };
  return {
    // Where this joiner stands. A new joiner becomes a request (unless too many wait already).
    check(invite, joinerId, name, app = "", computer = "") {
      sweep();
      if (!JOINER_ID.test(String(joinerId || ""))) return { state: "bad" };
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
    // The joiner left: their approval ends with them (joining again asks again).
    leave(inviteId, joinerId) { if (all.delete(`${inviteId}:${joinerId}`)) changed(); },
    get(inviteId, joinerId) { const e = all.get(`${inviteId}:${joinerId}`); return e ? publicView(e) : null; },
    pending() { sweep(); return [...all.values()].filter((e) => e.state === "pending").map(publicView); },
    list() { sweep(); return [...all.values()].map(publicView); },
    // Invites that ended take their approvals and requests with them.
    forget(inviteIds) {
      let gone = false;
      for (const [k, e] of all) if (inviteIds.includes(e.inviteId)) { all.delete(k); gone = true; }
      if (gone) changed();
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// ---- what invite link guests see ----------------------------------------------------------

// Addresses without their query string and fragment (where tokens, emails and order numbers live).
export function stripUrl(raw) {
  const s = String(raw ?? "");
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin + u.pathname;
    return u.href === "about:blank" ? s : `${u.protocol}`;
  } catch {
    return s.replace(/[?#].*$/, "");
  }
}
export const stripText = (text) => String(text ?? "").replace(/https?:\/\/[^\s"'`<>()[\]]+/gi, (m) => stripUrl(m));
