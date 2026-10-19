// The system's own notification "PairBrowse needs you", for when the browser's panel can't show
// it (text only). On macOS through PairBrowse Agent (the app a native build carries, the helper
// runs on it: PairBrowse Agent --notify), so it shows PairBrowse's name and logo; macOS asks the
// person once whether "PairBrowse Agent" may send notifications. Without a native build, or with
// an older Agent that lacks --notify, through osascript (shown as the script runner's). On Linux
// notify-send. The text always goes as an argument, never into a script.
import { execFile } from "node:child_process";
import { agentProgram } from "./launcher/daemon-connect.mjs";

export const NOTIFY_TITLE = "PairBrowse needs you";
const MAX_SAY = 2000; // the Agent takes 2048 bytes at most
// The Agent's answers that end it: 3 the person doesn't allow PairBrowse's notifications, 4 no
// answer yet to macOS's question (both: nothing else is sent, the person chose or is choosing).
const SETTLED = new Set([3, 4]);
const ASK_MS = 150_000; // the Agent waits two minutes for the person's answer

// platform, agent() (the Agent's program or null) and run (execFile) are for tests.
export function osNotify(say, { platform = process.platform, agent = () => agentProgram(), run = execFile } = {}) {
  const text = String(say).slice(0, MAX_SAY);
  if (platform === "linux") { run("notify-send", [NOTIFY_TITLE, text], () => {}); return "notify-send"; }
  if (platform !== "darwin") return "none";
  const script = () => run("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv) sound name \"Glass\"", "-e", "end run", NOTIFY_TITLE, text], () => {});
  let program;
  try { program = agent(); } catch { program = null; }
  if (!program) { script(); return "osascript"; }
  run(program, ["--notify", NOTIFY_TITLE, text], { timeout: ASK_MS }, (err) => {
    if (err && !err.killed && !SETTLED.has(err.code)) script();
  });
  return "agent";
}
