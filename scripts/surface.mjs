import { readFileSync } from "node:fs";

// Where Claude Code is running, from the environment it gives plugins. These variables aren't a
// documented API, so anything unknown falls back to "terminal" (the PairBrowse browser window).
export function detectSurface(env = process.env) {
  if (env.CLAUDE_CODE_REMOTE === "true") return "cloud";
  const entry = String(env.CLAUDE_CODE_ENTRYPOINT || "").toLowerCase();
  if (entry.includes("desktop")) return "desktop";
  if (/vscode|jetbrains|ide|cursor|windsurf/.test(entry)) return "ide";
  return "terminal";
}

// Which app runs the session hook: Codex keeps its transcripts as rollout-<time>-<id>.jsonl,
// Claude Code as <session id>.jsonl in its projects folder. Codex hooks may inherit Claude Code's
// environment (Codex started from Claude Code), so the transcript decides.
export function detectHost(input = {}) {
  return /(^|[/\\])rollout-[^/\\]*\.jsonl$/.test(String(input.transcript_path || "")) ? "codex" : "claude";
}

// One or two lines for the agent at session start: how the user sees the browser here.
export function surfaceGuidance(surface, host = "claude") {
  const who = host === "codex" ? "Codex" : "Claude";
  const own = `The browser is the PairBrowse browser: a Chromium window of its own (named PairBrowse on macOS) where the user watches, clicks and types directly. The PairBrowse side panel (pinned toolbar button, or Cmd+Shift+Y) and the bar at the bottom of each page show what ${who} is doing; ${who}'s tab carries an orange spark. No live view is needed.`;
  if (host === "codex") return `pairbrowse: Codex. ${own} Pay, publish, delete, send and submit-for-review steps are the user's: PairBrowse refuses them here, so set pairbrowse_status to "you" and ask the user to click those themselves.`;
  switch (surface) {
    case "desktop":
      return "pairbrowse: Claude desktop app. The user works in the Claude workspace: before the first browser action, call pairbrowse_dock so the browser shows as a pane attached to the right of the Claude window (macOS). If docking isn't available, open pairbrowse_liveview's link in the Browser pane. The PairBrowse browser window also exists, but the user watches and steps in from the pane.";
    case "cloud":
      return "pairbrowse: cloud session. The browser runs in this cloud container and the user can't see or click it, and most sites may be blocked by the network policy. Use it only for tasks that need no logins or handoffs, and send screenshots; for signups, suggest a local session.";
    case "ide":
      return `pairbrowse: IDE extension. ${own}`;
    default:
      return `pairbrowse: terminal. ${own}`;
  }
}

const FINAL = {
  claude: "PairBrowse's guard asks the user before those clicks: say what will happen, then click with browser_click. Never route around it with page scripts or by pressing Enter.",
  codex: "In Codex those clicks are refused: set pairbrowse_status kind \"you\", tell the user which button to click in the PairBrowse window and what it does, and wait.",
};

// Claude Code's own tools for the user's other sessions on this browser (Codex has none).
const SAME = {
  claude: " Your user's other Claude Code sessions on this browser: agree who takes which tab or task with ListAgents and SendMessage.",
  codex: "",
};

// Choosing the browser session. picker: the browser asks the person itself (config
// sessionPicker, on by default; never in the cloud, where nobody sees the window).
const SESSIONS = {
  picker: "Sessions: if the user said which (a saved one, a fresh one, or a pb-join code), do that first: pairbrowse_session use, new with clean true, or pairbrowse_join. Otherwise don't ask: the browser's first tab asks them, and your first browser action waits for their pick and says which.",
  ask: "Before the first browser action: pairbrowse_session list, then use the user's choice (or new with clean true).",
};

// The always-on core, worded for the app running the session.
export function coreText(host = "claude", { picker = false } = {}) {
  let text;
  try { text = readFileSync(new URL("./core.md", import.meta.url), "utf8").trim(); } catch { return ""; }
  return text.replace("{{FINAL}}", FINAL[host] || FINAL.claude).replace("{{SAME}}", SAME[host] ?? SAME.claude).replace("{{SESSIONS}}", picker ? SESSIONS.picker : SESSIONS.ask);
}
