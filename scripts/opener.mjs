// The PairBrowse browser opened by hand (the Dock, Finder, Spotlight, a login item) opens as the
// helper's own browser (plans/555 item 6). A browser started bare, with no helper, never learns of
// a helper that starts later (its pages learn the helper's address only from their launch switch,
// and the helper drives a browser only over the pipe it launched it with), so a bare start hands
// itself to the helper instead: the native build (from 555 item 6) reads the record this module
// writes, runs scripts/open.mjs with Node, and when that says yes it ends before opening any
// window. The helper then launches the browser as it always does (its pipe, its profile, its
// persona), and an agent that starts later finds that browser already there.
//
// The record: ~/.pairbrowse/run/opener.json, { "v": 1, "node": <absolute Node>, "script":
// <absolute .../scripts/open.mjs> }, written by the helper at each start, readable only by this
// account (0600 in a 0700 folder). parseOpener() is the browser's rule, mirrored for the tests:
// the browser checks the same again on its side, plus each file's owner and mode.
import { mkdirSync, writeFileSync, renameSync, rmSync, chmodSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { paths } from "./paths.mjs";

export const OPENER_FILE = "opener.json";
export const OPENER_VERSION = 1;
export const OPENER_MAX_BYTES = 4096;
// The open request on the private socket: one line, the same mark as a hook's (routeConnection
// tells it from an agent's MCP stream), answered with one line { ok, why? }.
export const OPEN_OP = "open";
// How long the opener waits for the helper's answer; the browser waits a little longer for the
// opener (the native side's own bound), then opens as a plain window.
export const OPEN_ANSWER_MS = 12_000;
// The helper's answer comes once the browser is up (or its start failed: no), or after this long
// while it is still starting (a first start that measures this computer can take a while; the
// launch goes on, and a start that fails after that is told to the person in the browser's place:
// a notification). Inside the opener's own wait (OPEN_ANSWER_MS), so a no still reaches it.
export const OPEN_ACCEPT_MS = 10_000;

export const openerPath = (home = paths.home) => join(home, "run", OPENER_FILE);

// The browser's rule for the record's contents (the native ParseOpener): JSON with v 1, node and
// script absolute paths without "..", NUL or a line break, the script named open.mjs inside a
// "scripts" folder. Returns { node, script } or null.
export function parseOpener(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > OPENER_MAX_BYTES) return null;
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v) || v.v !== OPENER_VERSION) return null;
  const ok = (p) => typeof p === "string" && p.length > 1 && p.length <= 1024 && isAbsolute(p) && !/[\0\r\n]/.test(p) && !p.split(/[\\/]/).includes("..");
  if (!ok(v.node) || !ok(v.script)) return null;
  if (basename(v.script) !== "open.mjs" || basename(dirname(v.script)) !== "scripts") return null;
  return { node: v.node, script: v.script };
}

// Writes the record (atomically: a reader sees the old one or the new one, never half). Returns its
// path. Throws on a record the browser would refuse.
export function writeOpener({ node = process.execPath, script, home = paths.home } = {}) {
  const text = JSON.stringify({ v: OPENER_VERSION, node, script });
  if (!parseOpener(text)) throw new Error("the opener record has a form the browser refuses");
  const dir = join(home, "run");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700); // the browser refuses a folder others can open
  const file = join(dir, OPENER_FILE);
  const tmp = join(dir, `.${OPENER_FILE}.${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") chmodSync(tmp, 0o600); // a umask can strip owner bits
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

// The socket line scripts/open.mjs sends (mark: hookline.mjs HOOK_MARK, the private socket's
// one-line requests).
export const openLine = (mark) => `${mark},${JSON.stringify({ op: OPEN_OP, v: 1 }).slice(1)}\n`;

// The helper's answer to an open request: whether it took the launch, and why not.
export const openAnswer = (ok, why = "") => `${JSON.stringify(ok ? { ok: true } : { ok: false, why: String(why).slice(0, 300) })}\n`;

// The helper's side of an open request: true when `line` is one (answered on `sock` with
// open()'s { ok, why }), false for any other line (an approval hook's, answered elsewhere).
export function answerOpen(sock, line, open, log = () => {}) {
  let msg;
  try { msg = JSON.parse(line); } catch { return false; }
  if (!msg || typeof msg !== "object" || msg.op !== OPEN_OP) return false;
  sock.on("error", () => {});
  sock.resume(); // nothing more is read; its end must still be seen
  const reply = (ok, why) => { if (!sock.destroyed) sock.end(openAnswer(ok, why)); };
  if (msg.v !== 1) { reply(false, "unknown request"); return true; }
  Promise.resolve().then(open).then((a) => {
    if (a?.ok !== true) log(`the browser opened by hand opens as a plain window: ${a?.why || "declined"}`);
    else log("the browser opened by hand is the helper's");
    reply(a?.ok === true, a?.why);
  }, (e) => { log(`open: ${e?.message || e}`); reply(false, e?.message || String(e)); });
  return true;
}
