// The words and colors the helper, the in-page script (scripts/hud/, which browser.mjs
// hudScript fills in from here) and the pages share: one copy of each. Pure data and tiny pure
// functions: no DOM, no Node API, nothing runs on import. The helper imports it in Node, the
// live view serves it (scripts/liveview/http.mjs), the extension and the native build ship it as
// a flat file at the ui/ root (the build refuses a ui/<dir> without index.html).

// ---- colors ----
// Each connected agent's color is its app's: Claude Code orange, Codex purple, Gemini blue, Grok silver. An
// agent whose app has none, or whose app's color another agent here already has, takes the first
// of AGENT_FALLBACKS no agent here has (daemon/hud.mjs pickAgentColor). People's colors
// (PEOPLE_COLORS) are never any of these.
export const APP_COLORS = Object.freeze({ claude: "#e9763f", codex: "#9b7bfa", gemini: "#4b8ffb", grok: "#c9d1dc" });
// Claude's own orange: the color of an agent whose color isn't known, the sheets' --spark
// (ui/tokens.css; tokens.test keeps them equal).
export const AGENT_COLOR = APP_COLORS.claude;
export const AGENT_FALLBACKS = Object.freeze(["#4fd1e8", APP_COLORS.claude, APP_COLORS.codex, APP_COLORS.gemini]);
// Every color an agent can have; [0] is Claude's own.
export const SPARK_COLORS = Object.freeze([...new Set([...Object.values(APP_COLORS), ...AGENT_FALLBACKS])]);
// A stable color per name, for people's pointers and tags (tabsync.mjs personColor): pink, yellow,
// lime, green, fuchsia. None is near an agent's color, so a tag's color alone says person or
// agent, and each carries the tags' dark ink (#0B1421) at WCAG AA (colors.test).
export const PEOPLE_COLORS = Object.freeze(["#f472b6", "#fde047", "#a3e635", "#4ade80", "#ee78f0"]);
// Which app: its MCP clientInfo.name ("claude-code", "codex-mcp-client", "grok-shell-browser", a
// joiner's agent's "remote:..."), or the app part of a label ("Alice · Codex", "Codex 1a2b"). ""
// for any other.
export function appKey(name) {
  const s = String(name || "").replace(/^remote:/, "");
  const app = s.includes(" · ") ? s.split(" · ").pop() : s;
  if (/^claude/i.test(app)) return "claude";
  if (/^codex/i.test(app)) return "codex";
  if (/gemini/i.test(app)) return "gemini";
  if (/^grok/i.test(app)) return "grok";
  return "";
}
// The mark on an agent's tab icon and spark: its app's, a rounded square for any other app,
// Claude's spark when nothing names one.
export const markOf = (name) => appKey(name) || (String(name || "").trim() ? "agent" : "claude");
// The marks, on a 16 x 16 grid: filled (f) or stroked with round ends (s, w its width). PairBrowse's
// own drawings, never the apps' logos. The page script keeps the same (scripts/hud/spark.js MARKS;
// marks.test keeps them equal).
const CLAUDE_SPARK = "M8 0.8c.5 0 .8.4.9.9l.5 4 3.3-2.3c.4-.3 1-.2 1.3.2.3.4.2 1-.2 1.3L10.6 7.3l4 .6c.5.1.9.5.8 1-.1.5-.5.8-1 .7l-4-.5 2.3 3.3c.3.4.2 1-.2 1.3-.4.3-1 .2-1.3-.2L8.9 10.2l-.5 4c-.1.5-.5.9-1 .8-.5 0-.8-.5-.8-1l.6-4-3.3 2.3c-.4.3-1 .2-1.3-.2-.3-.4-.2-1 .2-1.3l3.2-2.4-4-.5c-.5-.1-.9-.5-.8-1 .1-.5.5-.8 1-.8l4 .6L3.9 3.5c-.3-.4-.2-1 .2-1.3.4-.3 1-.2 1.3.2l2.4 3.3.5-4c0-.5.4-.9.9-.9Z";
export const AGENT_MARKS = Object.freeze({
  claude: Object.freeze({ f: CLAUDE_SPARK }),
  codex: Object.freeze({ s: "M5.6 2.4 1.6 8l4 5.6M10.4 2.4l4 5.6-4 5.6", w: 3.4 }),
  grok: Object.freeze({ s: "M12.8 2 3.2 14", w: 4.2 }),
  gemini: Object.freeze({ f: "M8 0C8.9 4.9 11.1 7.1 16 8 11.1 8.9 8.9 11.1 8 16 7.1 11.1 4.9 8.9 0 8 4.9 7.1 7.1 4.9 8 0Z" }),
  agent: Object.freeze({ f: "M4.5 1h7A3.5 3.5 0 0 1 15 4.5v7a3.5 3.5 0 0 1-3.5 3.5h-7A3.5 3.5 0 0 1 1 11.5v-7A3.5 3.5 0 0 1 4.5 1Z" }),
});

// A color as it may cross between the helper, the pages and the page script: #rrggbb.
export const COLOR = /^#[0-9a-f]{6}$/i;
export const isColor = (c) => COLOR.test(c || "");

// ---- an agent's state ----
// pairbrowse_status kinds: the badge's ("claude": working, for every app; "agent" the same,
// read as "claude"; "you": the user's turn, "done", and "clear" to take it down).
export const STATUS_KINDS = Object.freeze(["claude", "agent", "you", "done", "clear"]);
// The session board's status per participant (daemon/board.mjs), and its words, so a state
// never shows by color alone.
export const BOARD_STATES = Object.freeze(["working", "you", "done", "idle"]);
export const STATE_WORDS = Object.freeze({ working: "working", you: "waiting for their person", done: "done", idle: "idle" });

// ---- people who joined ----
// An invite's role: watch (only looks), drive (clicks, types, and their agent acts here) or
// approve (drive, and may also answer the host's approval cards in their own browser: shared
// browser join codes only). An invite keeps role "watch" or "drive" and approve: true for the
// last (liveview/invites.mjs roleOf), so every drive check holds for it as it is.
export const ROLES = Object.freeze(["watch", "drive", "approve"]);
// How a join code shares: the host's own browser (shared) or a copy that follows it (follow).
export const SHARE_MODES = Object.freeze(["shared", "follow"]);

// ---- the browser's own pages ----
// The helper's page kinds: the browser's own pages that open an event stream with ?page=<kind>
// (the owner's key only; liveview.mjs counts them, common.js helperStream names its own).
export const PAGE_KINDS = Object.freeze(["strip", "left", "right", "timeline", "approve", "picker", "screen", "capture"]);
