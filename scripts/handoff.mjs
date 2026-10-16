// A plugin update, handed over to the helper: after an update the old helper (scripts/daemon.mjs)
// keeps running, and every new bridge would connect to it, so the new version would never run.
// So a bridge first says its own version (its package.json) on the helper's private socket, as one
// line of the hooks' kind (hookline.mjs HOOK_MARK; daemon/approvals.mjs routeConnection), and a
// helper that is older and idle answers { restart: true } and stops cleanly (daemon.mjs shutdown:
// cookies written, tabs saved for the next start); the bridge then starts the helper from its own
// copy (launcher/daemon-connect.mjs connectLocal). A helper in use answers { restart: false, why }
// and remembers the newer version, which pairbrowse_status names; it never restarts later on its
// own (closing a window under someone reading is worse than staying old).
//
// The line: {"pairbrowse":"hook","op":"version","v":1,"version":"<x.y.z>"}. The answer: one line,
// {"restart":true} or {"restart":false,"why":"..."}. An older helper answers the op as a failed
// hook request ({"answer":"none"}) or not at all: a bridge treats every answer but
// { restart: true } as "connect as before".
import { utimesSync } from "node:fs";
import { HOOK_MARK, requestLine } from "./hookline.mjs";
import { pidAlive, sleep } from "./util.mjs";

export const VERSION_OP = "version";
export const VERSION_MAX = 32; // the most a version string may be (longer: no version)
export const HELLO_MS = 1500; // how long a bridge waits for the helper's answer
export const HANDOFF_WAIT_MS = 15_000; // how long a bridge waits for the old helper to be gone
export const PERSON_QUIET_MS = 120_000; // no person's input in the browser for this long: idle
const STOP_AFTER_MS = 300; // the helper stops once its yes is written, at most this long after

// A plain release version, x.y.z, each part a whole number without leading zeros (no prerelease,
// no build, no "v"): its three numbers, else null.
export function parseVersion(v) {
  if (typeof v !== "string" || v.length > VERSION_MAX) return null;
  const m = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Whether version a is strictly newer than b; false when either isn't a plain release version.
export function isNewer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// The bridge's line (it starts with HOOK_MARK: the helper reads it as a single line, not an agent).
export function helloLine(version) {
  const line = `${JSON.stringify({ pairbrowse: "hook", op: VERSION_OP, v: 1, version: String(version) })}\n`;
  if (!line.startsWith(HOOK_MARK)) throw new Error("the version line lost its mark");
  return line;
}

// The helper's answer as the bridge reads it: { restart: true } only for exactly that answer;
// anything else (an older helper's {"answer":"none"}, nothing, garbage) is { restart: false }.
export function readAnswer(line) {
  let v = null;
  try { v = JSON.parse(String(line)); } catch {}
  if (!v || typeof v !== "object" || Array.isArray(v)) return { restart: false };
  return v.restart === true ? { restart: true } : { restart: false, ...(typeof v.why === "string" ? { why: v.why.slice(0, 200) } : {}) };
}

// The bridge's side: says its version on sock (connected to the helper) and resolves the answer
// (readAnswer); { restart: false } on no answer within ms. sock is destroyed after.
export async function askVersion(sock, version, ms = HELLO_MS) {
  return readAnswer(await requestLine(sock, helloLine(version), ms));
}

// The bridge's side, after a yes: waits until the old helper is gone, its socket no longer
// answering (reachable(): true while it does) and its lock no longer held by a running process
// (holder(): the lock's pid, 0 for none). true once gone, false when it is still there after ms.
export async function waitGone({ reachable, holder, alive = pidAlive, ms = HANDOFF_WAIT_MS, step = 150, now = Date.now, nap = sleep }) {
  const end = now() + ms;
  for (;;) {
    const pid = Number(holder()) || 0;
    if (!(pid && alive(pid)) && !(await reachable())) return true;
    if (now() >= end) return false;
    await nap(step);
  }
}

// Why the helper is in use, in plain words, or null when it is idle. state (read now, all numbers
// or booleans): agents (agent connections), people (joiners and invite-link viewers in the live
// view), shared (people in a shared browser session), joined (this browser joined another's
// session), recording, approvals (asks waiting), downloads (in progress), personAt (when a person
// last used the browser by hand, ms), now.
export function busyReason(s = {}) {
  const n = (x) => Number(x) || 0;
  if (n(s.agents) > 0) return n(s.agents) === 1 ? "an agent is connected" : `${n(s.agents)} agents are connected`;
  if (n(s.people) > 0 || n(s.shared) > 0) return "people are in this browser's session";
  if (s.joined) return "this browser joined another session";
  if (s.recording) return "a recording is running";
  if (n(s.approvals) > 0) return "an approval is waiting";
  if (n(s.downloads) > 0) return "a download is in progress";
  const now = Number.isFinite(s.now) ? s.now : Date.now();
  if (n(s.personAt) > 0 && now - n(s.personAt) < PERSON_QUIET_MS) return "someone used the browser in the last 2 minutes";
  return null;
}

// What pairbrowse_status says while a newer version waits.
export const pendingLine = (version) => `PairBrowse ${version} is installed; this browser moves to it the next time a session starts while nobody is using the browser.`;

// The helper's side. own: this helper's version; state(): busyReason's state now; stop(): the
// clean shutdown; lock: the helper's lock file (freshened before the stop, so a helper another
// bridge starts meanwhile sees it held and leaves); log. answer(sock, line): true when the line was
// a version hello (answered here), false for any other line. note(): the status line, or "".
export function createVersionHandoff({ own, state, stop, lock = null, log = () => {} }) {
  let newest = null; // the newest version a bridge said, while this helper was in use
  let stopping = false;
  function decide(msg) {
    if (msg.v !== 1 || !parseVersion(msg.version)) return { restart: false, why: "unknown request" };
    if (!isNewer(msg.version, own)) return { restart: false, why: msg.version === own ? "same version" : "not newer" };
    if (stopping) return { restart: true }; // already handing over: this bridge waits for the stop too
    const why = busyReason({ ...state(), now: Date.now() });
    return why ? { restart: false, why } : { restart: true };
  }
  function answer(sock, line) {
    if (typeof line !== "string" || line.length > 512) return false;
    let msg;
    try { msg = JSON.parse(line); } catch { return false; }
    if (!msg || typeof msg !== "object" || msg.op !== VERSION_OP) return false;
    sock.on("error", () => {});
    sock.resume(); // nothing more is read; its end must still be seen
    let d;
    try { d = decide(msg); } catch (e) { d = { restart: false, why: "state unknown" }; log(`version: ${e?.message || e}`); }
    const said = parseVersion(msg.version) ? msg.version : "(none)";
    const reply = `${JSON.stringify(d)}\n`;
    if (d.restart && stopping) {
      if (!sock.destroyed) sock.end(reply);
      log(`version: a bridge has PairBrowse ${said}; already stopping for the new version`);
    } else if (d.restart) {
      stopping = true;
      log(`version: a bridge has PairBrowse ${said} (this helper ${own}) and nobody is using the browser: stopping so it starts the new one`);
      // The lock freshened: a helper another bridge starts while this one closes sees it held.
      if (lock) { try { const t = new Date(); utimesSync(lock, t, t); } catch {} }
      // The stop (it closes the socket's server) once the yes is written, at most STOP_AFTER_MS on.
      let gone = false;
      const go = () => { if (!gone) { gone = true; stop(); } };
      if (sock.destroyed) go();
      else { sock.end(reply, go); setTimeout(go, STOP_AFTER_MS).unref?.(); }
    } else if (d.why === "same version" || d.why === "not newer") {
      if (!sock.destroyed) sock.end(reply);
      log(`version: a bridge has PairBrowse ${said} (this helper ${own}): ${d.why}, nothing to do`);
    } else if (d.why === "unknown request") {
      if (!sock.destroyed) sock.end(reply);
      log("version: a hello this helper doesn't read; answered no");
    } else {
      if (!sock.destroyed) sock.end(reply);
      if (!newest || isNewer(msg.version, newest)) newest = msg.version;
      log(`version: a bridge has PairBrowse ${said} (this helper ${own}), but ${d.why}: staying on ${own} until a session starts while nobody uses the browser`);
    }
    return true;
  }
  return { answer, note: () => (newest && isNewer(newest, own) ? pendingLine(newest) : ""), newest: () => newest };
}
