// Invite links: a link for someone else. "drive" (the default) sees the page, tabs and activity
// and can click, type and switch tabs; "watch" (view-only, when asked for) only looks. Neither ever reaches the Profile panel (remembered details,
// password names). Each has its own key, expires, and can be revoked; links live in memory only.
// A watch link (share "watch") is a view-only link anyone who holds it may open from any browser,
// through the public address (liveview/public-turn.mjs): role watch always, an hour by default and
// a day at most, never on the owner's port, never kept across a restart of the helper.
// "approve" (shared browser join codes only) is drive plus answering the host's approval cards in
// the joiner's own browser: kept as role "drive" with approve: true, so every right a drive invite
// has (and every check for one) stays as it is; roleOf names it. The host may switch a code
// between drive and approve while it runs (setRole); never to or from watch.
import { randomBytes } from "node:crypto";
import { cleanName } from "../sharing/join.mjs";
import { keyOk } from "./http.mjs";
import { ROLES, SHARE_MODES } from "../../ui/vocab.js";

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_HOURS = 24;
const INVITE_MAX_HOURS = 24 * 7;
export const WATCH_DEFAULT_HOURS = 1;
export const WATCH_MAX_HOURS = 24;
// The durations the side panel and the Handoff page offer for a watch link, in hours.
export const WATCH_HOURS = Object.freeze([0.25, 1, 4, 24]);
const HOUR_MS = 3_600_000;

// config.liveViewHosts, checked: plain host names only (no ports, schemes, paths or wildcards).
// A config value as text for a message or a URL; never throws (an object whose toString isn't one).
const asText = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v) ?? String(v); } catch { return typeof v; } };

export function liveViewHostsFrom(value) {
  const hosts = [];
  const problems = [];
  for (const raw of Array.isArray(value) ? value : value == null ? [] : [value]) {
    const h = typeof raw === "string" ? raw.trim().toLowerCase().replace(/\.$/, "") : "";
    if (!HOST_NAME.test(h) || LOOPBACK_NAMES.has(h)) problems.push(`liveViewHosts: "${asText(raw).slice(0, 80)}" isn't a plain host name, ignored. Fix it in config.json.`);
    else if (!hosts.includes(h)) hosts.push(h);
  }
  return { hosts, problems };
}

// config.inviteBaseUrl, checked: http(s), a host from liveViewHosts, nothing after the host.
// Gives the origin invite links start with, or null.
export function inviteBaseFrom(value, hosts = []) {
  if (value == null || value === "") return { base: null, problem: null };
  let u;
  try { u = new URL(asText(value)); } catch { return { base: null, problem: `inviteBaseUrl "${asText(value).slice(0, 80)}" isn't a URL, ignored. Fix it in config.json.` }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { base: null, problem: "inviteBaseUrl must start with https:// (or http://), ignored. Fix it in config.json." };
  if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return { base: null, problem: "inviteBaseUrl must be just the address, like https://myhost.example.ts.net, ignored. Fix it in config.json." };
  if (!hosts.includes(u.hostname)) return { base: null, problem: `inviteBaseUrl's host ${u.hostname} must also be listed in liveViewHosts, ignored. Fix it in config.json.` };
  return { base: u.origin, problem: null };
}

// A name to show, not markup: the same rule as joiners' names.
export const inviteLabel = (label) => cleanName(label);

// An invite's role as people and agents read it: "watch", "drive" or "approve".
export const roleOf = (i) => (i?.approve === true && i.role === "drive" ? "approve" : i?.role === "drive" ? "drive" : "watch");
const ACCESS = ["watch", "drive"];
// Whether an invite may hold the approve role: a join code that shares this browser itself (a
// follow code's joiner never sees the page the click is on; a link has no browser of its own).
const mayApprove = (share, mode) => share === "code" && mode === "shared";
const APPROVE_ONLY = 'role "approve" is for shared browser join codes only (share "code", mode "shared").';

// The invites, for as long as the helper runs (the live view may restart with the browser). Join
// codes are also saved (sharing.mjs) so they outlive a restart of the helper; links never are.
// now: the wall clock (expiresAt, as people read it); mono: a clock that never jumps (performance.now).
// An invite ends at expiresAt, or once its whole lifetime has passed on mono, whichever comes first:
// a clock set back never stretches an invite past the hours it was made for.
export function createInvites({ now = () => Date.now(), mono = () => performance.now() } = {}) {
  const all = new Map(); // id -> invite
  const monoEnd = new Map(); // id -> the mono time its lifetime is over
  const listeners = new Set(); // called with the ids that stopped working
  const ended = (ids) => { for (const id of ids) monoEnd.delete(id); if (ids.length) for (const fn of listeners) fn(ids); };
  const sweep = () => {
    const t = now(), m = mono();
    const gone = [...all.values()].filter((i) => i.expiresAt <= t || (monoEnd.get(i.id) ?? Infinity) <= m).map((i) => i.id);
    for (const id of gone) all.delete(id);
    ended(gone);
  };
  const roleListeners = new Set(); // called with an invite's id when its role changed
  const allListeners = new Set(); // called when every invite is revoked at once (hand-offs end too)
  const publicView = ({ id, role, approve, label, share, mode, createdAt, expiresAt }) => ({ id, role, approve: approve === true, label, share, mode, createdAt, expiresAt });
  return {
    // share: "link" (a live view link, reached through an SSH tunnel or liveViewHosts), "code"
    // (a join code: reached only through the sharing tunnel, and only after the host approves) or
    // "watch" (a watch link: view only, through the public address, for whoever holds it).
    // mode (join codes): "shared" (the default: they work in this browser, seeing it live) or
    // "follow" (their own browser opens these tabs and follows them).
    create({ role, label, hours, share = "link", mode = "shared" } = {}) {
      if (share !== "link" && share !== "code" && share !== "watch") throw new Error('share must be "link", "code" or "watch".');
      role ??= share === "watch" ? "watch" : "drive";
      if (!ROLES.includes(role)) throw new Error('role must be "watch", "drive" or "approve".');
      if (share === "watch" && role !== "watch") throw new Error('A watch link (share "watch") is view only: role "watch".');
      const h = hours === undefined || hours === null || hours === "" ? (share === "watch" ? WATCH_DEFAULT_HOURS : DEFAULT_HOURS) : Number(hours);
      if (!Number.isFinite(h) || h <= 0) throw new Error("hours must be a number above 0.");
      const createdAt = now();
      let id;
      do id = randomBytes(4).toString("hex"); while (all.has(id));
      if (mode !== "shared" && mode !== "follow") throw new Error('mode must be "shared" or "follow".');
      if (role === "approve" && !mayApprove(share, mode)) throw new Error(APPROVE_ONLY);
      const invite = { id, role: role === "approve" ? "drive" : role, approve: role === "approve", share, mode, label: inviteLabel(label ?? (share === "watch" ? "Watch link" : undefined)), key: randomBytes(32).toString("hex"), createdAt, expiresAt: createdAt + Math.min(h, share === "watch" ? WATCH_MAX_HOURS : INVITE_MAX_HOURS) * HOUR_MS };
      all.set(id, invite);
      monoEnd.set(id, mono() + (invite.expiresAt - createdAt));
      return { ...invite };
    },
    list() { sweep(); return [...all.values()].map(publicView); },
    // One invite by id, as it stands now (its role read fresh), or null.
    get(id) { sweep(); const i = all.get(String(id ?? "")); return i ? publicView(i) : null; },
    // The host switches a code between drive and approve. Returns the invite as it stands now;
    // throws with a sentence when that change isn't possible.
    setRole(id, role) {
      sweep();
      const i = all.get(String(id ?? ""));
      if (!i) throw new Error("No such invite (it may have expired or been revoked already).");
      if (role !== "drive" && role !== "approve") throw new Error('role must be "drive" or "approve" (watch and drive are fixed when the invite is made: make a new one).');
      if (i.role !== "drive") throw new Error("This invite is watch only: make a new one to let them drive or approve.");
      if (role === "approve" && !mayApprove(i.share, i.mode)) throw new Error(APPROVE_ONLY);
      const approve = role === "approve";
      if (i.approve !== approve) {
        i.approve = approve;
        for (const fn of roleListeners) try { fn(i.id); } catch {}
      }
      return publicView(i);
    },
    onRole(fn) { roleListeners.add(fn); return () => roleListeners.delete(fn); },
    revoke(id) {
      const had = all.delete(String(id ?? ""));
      if (had) ended([String(id)]);
      return had;
    },
    // Every invite of one kind (share), at once: "Stop all" for watch links. Returns how many.
    revokeShare(share) {
      sweep();
      const ids = [...all.values()].filter((i) => i.share === share).map((i) => i.id);
      for (const id of ids) all.delete(id);
      ended(ids);
      return ids.length;
    },
    revokeAll() {
      const ids = [...all.keys()];
      all.clear();
      ended(ids);
      for (const fn of allListeners) try { fn(); } catch {}
      return ids.length;
    },
    onRevokeAll(fn) { allListeners.add(fn); return () => allListeners.delete(fn); },
    // The invite this key belongs to, if it's still valid. Compares against every invite, in
    // constant time each, so timing doesn't tell which one (or whether any) came close.
    match(given) {
      sweep();
      let found = null;
      for (const invite of all.values()) if (keyOk(given, invite.key)) found = invite;
      return found ? publicView(found) : null;
    },
    // A watch link's key, for the helper's own use (the link said again in the linked chat): never
    // in a list, an event or a log. null for anything else.
    watchKey(id) { sweep(); const i = all.get(String(id ?? "")); return i?.share === "watch" ? i.key : null; },
    // Whether text holds the key of a link still valid (a live view link or a watch link): an agent
    // typing one into a page is refused (daemon/serve/refuse.mjs). Join codes carry theirs encoded.
    keyIn(text) {
      const t = String(text ?? "");
      if (t.length < 64) return false;
      sweep();
      for (const i of all.values()) if (i.share !== "code" && t.includes(i.key)) return true;
      return false;
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
        if (!ACCESS.includes(i.role) || !SHARE_MODES.includes(i.mode)) continue;
        const createdAt = Number(i.createdAt), expiresAt = Number(i.expiresAt);
        if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt - createdAt > INVITE_MAX_HOURS * HOUR_MS) continue;
        all.set(i.id, { id: i.id, role: i.role, approve: i.approve === true && i.role === "drive" && mayApprove("code", i.mode), share: "code", mode: i.mode, label: inviteLabel(i.label), key: i.key, createdAt, expiresAt });
        monoEnd.set(i.id, mono() + (expiresAt - now())); // what's left of it, from here on
        n++;
      }
      return n;
    },
  };
}

// What each kind of link may do. The owner's own link (and the side panel) may do everything.
// "journal" (the live view's Timeline: the goal log) and "invite" (the Share card makes an invite)
// are the owner's only, as are "layout", "strip", "timeline", "config" and "outline" (the browser's
// own pages: the docks' layout, the tab strip's list, the session's timeline of pictures, the
// Settings page, the Page tab's outline: the last whole-page snapshot an agent got for a tab).
// "session" also covers renaming and saving the session (POST session), the owner's alone.
// "tools" (the Tools tab: this session's downloads, the helper's recordings, hand-offs and
// diagnostics, with Open, Reveal and Delete by id) is the owner's alone too, as is "capture" (the
// browser's own capture page answering the helper: liveview/capture.mjs), as is "activity" (the
// session's activity log, GET activity.json: the whole history, where guests get the latest lines),
// as is "network" (Settings' Network section: proxies, their credentials and each session's choice),
// as is "handoff" (the Handoff page: linking Telegram or Discord, their tokens, what goes to the phone).
// "turn" and "redeem" are a hand-off grant's (daemon/grants.mjs, spec server-mode B2), never an
// invite's: "redeem" (the link as delivered) only reaches its landing page and, there, a still of
// the handed-over tab with card fields covered (thumb); "turn" (the view key
// it gives) sees and drives the handed-over tabs and reaches the turn routes ("turn"), and never
// tab, profile, approve, invite, tools, session or config. The live view refuses it POST pause too
// (routes/viewer.mjs), though pause needs only input.
const RIGHTS = {
  owner: new Set(["page", "events", "thumb", "state", "input", "tab", "profile", "approve", "session", "record", "journal", "invite", "layout", "strip", "timeline", "config", "outline", "tools", "capture", "activity", "network", "handoff"]),
  drive: new Set(["page", "events", "thumb", "state", "input", "tab"]),
  watch: new Set(["page", "events", "thumb", "state"]),
  turn: new Set(["page", "events", "thumb", "state", "input", "turn"]),
  redeem: new Set(["page", "thumb"]),
};
export const roleMay = (role, right) => Object.hasOwn(RIGHTS, role) && RIGHTS[role].has(right);
