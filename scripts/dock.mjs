// The desktop-app pane (macOS): a borderless panel inside the right edge of the Claude window,
// showing the browser's live view. Runs on the user's computer, from the
// bridge. See scripts/dock/dock-mac.js.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The tool's definition lives in the catalog (tools/catalog.mjs).
export { DOCK_TOOL } from "./tools/catalog.mjs";

export const dockSupported = () => process.platform === "darwin";

// Starts the pane. Resolves with the process once it's showing, or rejects with the reason.
export function startPane({ url, width = 0, host = "Claude", top = 52, makeRoom = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-l", "JavaScript", join(here, "dock", "dock-mac.js"), url, String(width), host, String(top), makeRoom ? "1" : "0"], { stdio: ["ignore", "ignore", "pipe"] });
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    child.stderr.on("data", (d) => {
      const text = String(d);
      if (text.includes("PANE_READY")) done(resolve, child);
      else if (text.includes("BAD_URL")) done(reject, new Error("the live view address wasn't local"));
    });
    child.on("error", (e) => done(reject, e));
    child.on("exit", (code) => done(reject, new Error(`the pane stopped (code ${code})`)));
    setTimeout(() => done(reject, new Error("the pane didn't start within 10 seconds")), 10000);
  });
}
