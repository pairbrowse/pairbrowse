// Tab changes on macOS bring the PairBrowse browser in front of whatever you were using (the
// Claude desktop app with its pane, for example). keepFocus runs such a change and, for a couple
// of seconds, puts the app you were in back in front each time the browser jumps up.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
// macOS: which app is in front ("pid bundle-id"), and bringing an app back to the front.
const FRONT = 'ObjC.import("Cocoa"); const f = $.NSWorkspace.sharedWorkspace.frontmostApplication; f.processIdentifier + " " + ObjC.unwrap(f.bundleIdentifier)';
const ACTIVATE = (pid) => `ObjC.import("Cocoa"); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(pid)}).activateWithOptions(0)`;
const jxa = (code) => run("osascript", ["-l", "JavaScript", "-e", code], { timeout: 3000 }).then((r) => r.stdout.trim());
const BROWSER_ID = "dev.pairbrowse.browser"; // scripts/browser.mjs

// Runs a tab change (showing a tab, opening one) without taking over the screen. On macOS that
// activates the PairBrowse browser, sometimes a second or two later, so for a short while focus
// goes back to the app you were in (the Claude workspace with its pane, for example) whenever
// the browser jumps in front.
export async function keepFocus(change) {
  const before = process.platform === "darwin" ? await jxa(FRONT).catch(() => "") : "";
  const [pid, id] = before.split(" ");
  const result = await change();
  if (pid && id !== BROWSER_ID) {
    (async () => { // in the background: the change itself is done
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 125));
        if ((await jxa(FRONT).catch(() => "")).endsWith(` ${BROWSER_ID}`)) await jxa(ACTIVATE(pid)).catch(() => {});
      }
    })();
  }
  return result;
}

