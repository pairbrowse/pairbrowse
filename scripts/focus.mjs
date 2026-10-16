// Tab changes on macOS bring the PairBrowse browser in front of whatever you were using (the
// Claude desktop app with its pane, for example). keepFocus runs such a change and, for a couple
// of seconds, puts the app you were in back in front each time the browser jumps up.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sleep } from "./util.mjs";

const run = promisify(execFile);
// macOS: which app is in front ("pid bundle-id"), and bringing an app back to the front.
const FRONT = 'ObjC.import("Cocoa"); const f = $.NSWorkspace.sharedWorkspace.frontmostApplication; f.processIdentifier + " " + ObjC.unwrap(f.bundleIdentifier)';
const ACTIVATE = (pid) => `ObjC.import("Cocoa"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(pid)}).activateWithOptions(0)`;
const jxa = (code) => run("osascript", ["-l", "JavaScript", "-e", code], { timeout: 3000 }).then((r) => r.stdout.trim());
// The PairBrowse browser's bundle ids: the open build scripts/browser.mjs brands, and the
// native build (release app.pairbrowse.browser, dev builds app.pairbrowse.browser.dev). Only the
// fallback: focus follows this helper's own browser by its process (below), so another helper's
// PairBrowse window (a named instance, a dev build) counts as any other app.
const BROWSER_IDS = new Set(["dev.pairbrowse.browser", "app.pairbrowse.browser", "app.pairbrowse.browser.dev"]);
export const isBrowser = (front) => BROWSER_IDS.has(String(front).split(" ")[1] || "");

// The processes this helper started (`ps -A -o pid=,ppid=` lines): its browser is one of them
// (Playwright runs it as the helper's child, over its pipe), the only one that can be an app in front.
export function childPids(psText, parent = process.pid) {
  const out = new Set();
  for (const line of String(psText).split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid > 0 && ppid === parent) out.add(pid);
  }
  return out;
}
const ownPids = () => run("/bin/ps", ["-A", "-o", "pid=,ppid="], { timeout: 3000, maxBuffer: 8 << 20 }).then((r) => childPids(r.stdout)).catch(() => new Set());
// Whether the app in front ("pid bundle-id") is this helper's browser: by its process when this
// helper's children are known, else (ps failed) by the PairBrowse bundle ids.
export const isOwnBrowser = (front, own) => (own?.size ? own.has(Number(String(front).split(" ")[0])) : isBrowser(front));

// Runs a tab change (showing a tab, opening one) without taking over the screen. On macOS that
// activates the PairBrowse browser, sometimes a second or two later, so for a short while focus
// goes back to the app you were in (the Claude workspace with its pane, another PairBrowse
// window, for example) whenever this helper's browser jumps in front.
// A build whose automation tab changes never activate it (its manifest's quietTabs, 585) needs none
// of this: the change runs alone. Set at each launch from the browser's shell (daemon/browser/launch.mjs).
let quiet = false;
export const setQuietTabs = (on) => { quiet = !!on; };
export async function keepFocus(change, { children = ownPids } = {}) {
  if (quiet) return change();
  const before = process.platform === "darwin" ? await jxa(FRONT).catch(() => "") : "";
  const [pid] = before.split(" ");
  const result = await change();
  if (pid) {
    const own = await children(); // after the change: it may have started the browser
    if (isOwnBrowser(before, own)) return result;
    (async () => { // in the background: the change itself is done
      for (let i = 0; i < 20; i++) {
        await sleep(125);
        if (isOwnBrowser(await jxa(FRONT).catch(() => ""), own)) await jxa(ACTIVATE(pid)).catch(() => {});
      }
    })();
  }
  return result;
}
