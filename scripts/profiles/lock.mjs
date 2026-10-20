// The identity lock (spec server-mode D3): a browser profile that pins a seed (persona.seed) is one
// device to every site, so it runs in one browser at a time across the instances of one shared
// home (home.mjs). Each pinned seed has one owner-only lock file in paths.identityLocks (the shared
// home's identity-locks/, 0700), named by the seed's SHA-256 (the seed itself is never written):
// { pid, start, token, session, profileId, instance, at }. A launch takes it after every other
// check passed (daemon/sessions/profiles.mjs) and the browser's close or a failed launch gives it
// back; a lock whose process is gone, or whose pid now belongs to a process that started at another
// time (install-lock.mjs startOf), is taken over, the takeover rule of install-lock.mjs. A live
// holder refuses the launch, naming the session, instance and process that hold it. There is no
// time-out: a browser may run for weeks, and its helper is alive all along.
// Profiles without a pinned seed take no lock: each session gets its own seed (today's
// sha256(directory), native-engine.mjs), so two sessions on one such profile are two devices.
//
// Node's standard library only.
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { paths, INSTANCE } from "../paths.mjs";
import { sha256, writeJsonAtomic } from "../util.mjs";
import { holderAlive, startOf } from "../install-lock.mjs";
import { PROFILE_ID } from "./schema.mjs";

const ownStart = startOf(process.pid);
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const fail = (code, message) => Object.assign(new Error(message), { code });

// The locks this process holds: file -> token. Given back when the process exits, so a helper that
// stops cleanly never leaves one for the next to take over.
const held = new Map();
let exitHook = false;
function watchExit() {
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => { for (const [file, token] of held) giveBack(file, token); });
}

// The lock file for a seed: <dir>/<sha256(seed)>.lock.
export const identityFile = (seed, dir = paths.identityLocks) => join(dir, `${sha256(String(seed))}.lock`);

// A lock file's holder, or null when there is none. One that can't be read as a holder (empty,
// cut short, not JSON, unreadable) is a holder with no process ({ pid: 0 }), taken over as a dead one is
// (install-lock.mjs readHolder's rule): a lock is written whole and linked into place, so only a
// crash or another program leaves such a file, and it never blocks the profile for good.
export function readIdentityHolder(file) {
  let text, raw;
  try { text = readFileSync(file, "utf8"); } catch (e) { return e?.code === "ENOENT" ? null : { pid: 0, start: null, token: null }; }
  try { raw = JSON.parse(text); } catch { return { pid: 0, start: null, token: null }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { pid: 0, start: null, token: null };
  return {
    pid: Number.isInteger(raw.pid) ? raw.pid : 0,
    start: typeof raw.start === "string" ? raw.start : null,
    token: typeof raw.token === "string" ? raw.token : null,
    session: typeof raw.session === "string" && SESSION.test(raw.session) ? raw.session : null,
    profileId: typeof raw.profileId === "string" && PROFILE_ID.test(raw.profileId) ? raw.profileId : null,
    instance: typeof raw.instance === "string" && SESSION.test(raw.instance) ? raw.instance : null,
  };
}

function giveBack(file, token) {
  if (readIdentityHolder(file)?.token === token) rmSync(file, { force: true });
  held.delete(file);
}

// Who holds it, in words: session "x" of instance "y" (process n).
const holderText = (h) => `${h.session ? `session "${h.session}"` : "another browser"}${h.instance ? ` of PairBrowse instance "${h.instance}"` : ""}${h.pid ? ` (process ${h.pid})` : ""}`;

// Takes the identity lock of seed for one launch: { file, token, release() }. holder: { session,
// profileId, name } (name: the profile's, for the refusal). A lock this process already holds for
// the same session and profile is taken again (a launch after a close that never came). A live
// holder refuses (err.code PROFILE_IDENTITY_HELD), naming it; a dead one is taken over.
// alive and started: tests pass their own (install-lock.mjs holderAlive's).
export function takeIdentity(seed, { session, profileId, name } = {}, { dir = paths.identityLocks, instance = INSTANCE || null, now = Date.now, alive, started } = {}) {
  if (typeof seed !== "string" || !seed) throw fail("PROFILE_IDENTITY", "Only a pinned seed takes the identity lock.");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  const file = identityFile(seed, dir);
  watchExit();
  for (let i = 0; i < 3; i++) {
    const token = randomBytes(16).toString("hex");
    const record = { pid: process.pid, start: ownStart, token, session: session ?? null, profileId: profileId ?? null, instance, at: new Date(now()).toISOString() };
    // Written whole to a file of this try's own, then linked into place: the link fails when a lock
    // is there, and a reader never sees half of one.
    const mine = `${file}.${process.pid}.${token}.new`;
    try {
      writeJsonAtomic(mine, record, { mode: 0o600, indent: 0 });
      linkSync(mine, file);
      held.set(file, token);
      return { file, token, release: () => giveBack(file, token) };
    } catch (e) {
      if (e?.code !== "EEXIST") throw fail("PROFILE_IDENTITY", `The identity lock of browser profile "${name || profileId}" couldn't be taken (${e?.code || "error"}).`);
    } finally { rmSync(mine, { force: true }); }
    const h = readIdentityHolder(file);
    if (!h) continue; // gone meanwhile: try again
    const ours = h.pid === process.pid && h.start === ownStart && held.get(file) === h.token;
    if (ours && h.session === (session ?? null) && h.profileId === (profileId ?? null)) {
      return { file, token: h.token, release: () => giveBack(file, h.token) };
    }
    if (!ours && holderAlive(h, { ...(alive ? { alive } : {}), ...(started ? { started } : {}) })) {
      throw fail("PROFILE_IDENTITY_HELD", `browser profile "${name || profileId}" pins its seed, so it runs in one browser at a time, and ${holderText(h)} has it open now: close that browser first, or give this session a profile without a pinned seed; nothing was started.`);
    }
    if (ours) throw fail("PROFILE_IDENTITY_HELD", `browser profile "${name || profileId}" pins its seed, and ${holderText(h)} in this PairBrowse has it open now: close that browser first; nothing was started.`);
    // A dead holder: moved aside atomically (only one taker wins), then removed, and the next try writes ours.
    const aside = `${file}.${process.pid}.${token}.dead`;
    try { renameSync(file, aside); } catch { continue; }
    const moved = readIdentityHolder(aside);
    if (!moved || moved.token !== h.token || moved.pid !== h.pid) { try { renameSync(aside, file); } catch {} continue; }
    try { rmSync(aside, { force: true }); } catch {} // moved out of the way either way
  }
  throw fail("PROFILE_IDENTITY", `The identity lock of browser profile "${name || profileId}" is changing hands; try again in a moment.`);
}
