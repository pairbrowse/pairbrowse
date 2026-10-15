#!/usr/bin/env node
// What the PairBrowse browser runs when a person opens it by hand (plans/555 item 6; the record it
// finds this script by: scripts/opener.mjs). Asks the helper, starting it if it isn't running, to
// open the browser as its own (or bring its open window to the front), and exits 0 when it took
// it: the bare browser that ran this then ends without a window. Any other exit (no answer in
// time, the helper declined, no helper could start) and the browser opens as a plain window, as
// before. Prints nothing secret; the reason for a no goes to stderr.
//
// Which helper: the record of the app that ran this (its own record in the opener registry,
// openers.mjs) names the helper's home when that record is this very script's; the home is set
// before the modules that read it load. Otherwise the default home's helper, as before.
import { fileURLToPath } from "node:url";
import { HOOK_MARK, requestLine } from "./hookline.mjs";
import { openerEnv, programOf } from "./openers.mjs";
import { selectHome } from "./home.mjs";
import { within } from "./util.mjs";

const OPEN_ANSWER_MS = 12_000; // opener.mjs's (it loads after the home is chosen); its test checks they agree

const say = (s) => process.stderr.write(`pairbrowse open: ${s}\n`);

// The answer line ({ ok, why? }) to one open request on a connected socket, or null.
export async function askOpen(sock, waitMs = OPEN_ANSWER_MS) {
  const { openLine } = await import("./opener.mjs");
  const line = await requestLine(sock, openLine(HOOK_MARK), waitMs);
  try { return line === null ? null : JSON.parse(line); } catch { return null; }
}

async function main() {
  const chosen = process.platform === "darwin" ? openerEnv({ parentExe: programOf(process.ppid), script: fileURLToPath(import.meta.url) }) : null;
  selectHome(process.env, chosen); // else opener.json's helper, whatever folder this runs in
  const { connectOnce, connectLocal } = await import("./launcher/daemon-connect.mjs");
  // A running helper first (nothing to prepare); else the bridge's way: prepare, start, connect.
  const sock = await connectOnce().catch(() => within(OPEN_ANSWER_MS, connectLocal(say)).catch((e) => { say(e?.message || String(e)); return null; }));
  if (!sock) { say("no helper answered"); return 1; }
  const answer = await askOpen(sock);
  if (answer?.ok === true) return 0;
  say(answer?.why ? `the helper declined: ${answer.why}` : "no answer from the helper in time");
  return 1;
}

if (process.argv[1]?.endsWith("open.mjs")) main().then((code) => process.exit(code), (e) => { say(e?.message || String(e)); process.exit(1); });
