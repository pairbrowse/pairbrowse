// Invite links: a link for someone else. "drive" (the default) sees the page, tabs and activity
// and can click, type and switch tabs; "watch" (view-only, when asked for) only looks. Neither ever reaches the Profile panel (remembered details,
// password names). Each has its own key, expires, and can be revoked; links live in memory only.
import { randomBytes } from "node:crypto";
import { cleanName } from "../join.mjs";
import { keyOk } from "./http.mjs";

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_HOURS = 24;
const INVITE_MAX_HOURS = 24 * 7;
const HOUR_MS = 3_600_000;

// config.liveViewHosts, checked: plain host names only (no ports, schemes, paths or wildcards).
export function liveViewHostsFrom(value) {
  const hosts = [];
  const problems = [];
  for (const raw of Array.isArray(value) ? value : value == null ? [] : [value]) {
    const h = typeof raw === "string" ? raw.trim().toLowerCase().replace(/\.$/, "") : "";
    if (!HOST_NAME.test(h) || LOOPBACK_NAMES.has(h)) problems.push(`liveViewHosts: "${String(raw).slice(0, 80)}" isn't a plain host name, ignored.`);
    else if (!hosts.includes(h)) hosts.push(h);
  }
  return { hosts, problems };
}

// config.inviteBaseUrl, checked: http(s), a host from liveViewHosts, nothing after the host.
// Gives the origin invite links start with, or null.
export function inviteBaseFrom(value, hosts = []) {
  if (value == null || value === "") return { base: null, problem: null };
  let u;
  try { u = new URL(String(value)); } catch { return { base: null, problem: `inviteBaseUrl "${String(value).slice(0, 80)}" isn't a URL, ignored.` }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { base: null, problem: "inviteBaseUrl must start with https:// (or http://), ignored." };
  if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return { base: null, problem: "inviteBaseUrl must be just the address, like https://myhost.example.ts.net, ignored." };
  if (!hosts.includes(u.hostname)) return { base: null, problem: `inviteBaseUrl's host ${u.hostname} must also be listed in liveViewHosts, ignored.` };
  return { base: u.origin, problem: null };
}

// A name to show, not markup: the same rule as joiners' names.
export const inviteLabel = (label) => cleanName(label);

// The invites, for as long as the helper runs (the live view may restart with the browser). Join
// codes are also saved (sharing.mjs) so they outlive a restart of the helper; links never are.
export function createInvites({ now = () => Date.now() } = {}) {
  const all = new Map(); // id -> invite
  const listeners = new Set(); // called with the ids that stopped working
  const ended = (ids) => { if (ids.length) for (const fn of listeners) fn(ids); };
  const sweep = () => {
    const gone = [...all.values()].filter((i) => i.expiresAt <= now()).map((i) => i.id);
    for (const id of gone) all.delete(id);
    ended(gone);
  };
  const publicView = ({ id, role, label, share, mode, createdAt, expiresAt }) => ({ id, role, label, share, mode, createdAt, expiresAt });
  return {
    // share: "link" (a live view link, reached through an SSH tunnel or liveViewHosts) or "code"
    // (a join code: reached only through the sharing tunnel, and only after the host approves).
    // mode (join codes): "shared" (the default: they work in this browser, seeing it live) or
    // "follow" (their own browser opens these tabs and follows them).
    create({ role = "drive", label, hours, share = "link", mode = "shared" } = {}) {
      if (role !== "watch" && role !== "drive") throw new Error('role must be "watch" or "drive".');
      const h = hours === undefined || hours === null || hours === "" ? DEFAULT_HOURS : Number(hours);
      if (!Number.isFinite(h) || h <= 0) throw new Error("hours must be a number above 0.");
      const createdAt = now();
      let id;
      do id = randomBytes(4).toString("hex"); while (all.has(id));
      if (share !== "link" && share !== "code") throw new Error('share must be "link" or "code".');
      if (mode !== "shared" && mode !== "follow") throw new Error('mode must be "shared" or "follow".');
      const invite = { id, role, share, mode, label: inviteLabel(label), key: randomBytes(32).toString("hex"), createdAt, expiresAt: createdAt + Math.min(h, INVITE_MAX_HOURS) * HOUR_MS };
      all.set(id, invite);
      return { ...invite };
    },
    list() { sweep(); return [...all.values()].map(publicView); },
    revoke(id) {
      const had = all.delete(String(id ?? ""));
      if (had) ended([String(id)]);
      return had;
    },
    revokeAll() { const ids = [...all.keys()]; all.clear(); ended(ids); return ids.length; },
    // The invite this key belongs to, if it's still valid. Compares against every invite, in
    // constant time each, so timing doesn't tell which one (or whether any) came close.
    match(given) {
      sweep();
      let found = null;
      for (const invite of all.values()) if (keyOk(given, invite.key)) found = invite;
      return found ? publicView(found) : null;
    },
    sweep,
    onEnd(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // Join codes still valid, whole (keys too), for the helper's saved sharing state.
    savedCodes() { sweep(); return [...all.values()].filter((i) => i.share === "code").map((i) => ({ ...i })); },
    // Join codes from that saved state, each checked: nothing malformed or expired comes back.
    restore(list) {
      let n = 0;
      for (const i of Array.isArray(list) ? list : []) {
        if (!i || !/^[0-9a-f]{8}$/.test(i.id) || !/^[0-9a-f]{64}$/.test(i.key) || i.share !== "code" || all.has(i.id)) continue;
        if (!["watch", "drive"].includes(i.role) || !["shared", "follow"].includes(i.mode)) continue;
        const createdAt = Number(i.createdAt), expiresAt = Number(i.expiresAt);
        if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt - createdAt > INVITE_MAX_HOURS * HOUR_MS) continue;
        all.set(i.id, { id: i.id, role: i.role, share: "code", mode: i.mode, label: inviteLabel(i.label), key: i.key, createdAt, expiresAt });
        n++;
      }
      return n;
    },
  };
}

// What each kind of link may do. The owner's own link (and the side panel) may do everything.
const RIGHTS = {
  owner: new Set(["page", "events", "thumb", "state", "input", "tab", "profile", "approve", "session"]),
  drive: new Set(["page", "events", "thumb", "state", "input", "tab"]),
  watch: new Set(["page", "events", "thumb", "state"]),
};
export const roleMay = (role, right) => Object.hasOwn(RIGHTS, role) && RIGHTS[role].has(right);
