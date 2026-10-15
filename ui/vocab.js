// The words and colors the helper, the in-page script (scripts/hud.js, which browser.mjs
// hudScript fills in from here) and the pages share: one copy of each. Pure data and tiny pure
// functions: no DOM, no Node API, nothing runs on import. The helper imports it in Node, the
// live view serves it (scripts/liveview/http.mjs), the extension and the native build ship it as
// a flat file at the ui/ root (the build refuses a ui/<dir> without index.html).

// ---- colors ----
// Each connected agent's color is its app's: Claude Code orange, Codex purple, Gemini blue. An
// agent whose app has none, or whose app's color another agent here already has, takes the first
// of AGENT_FALLBACKS no agent here has (daemon/hud.mjs pickAgentColor). People's colors
// (PEOPLE_COLORS) are never any of these.
export const APP_COLORS = Object.freeze({ claude: "#e9763f", codex: "#9b7bfa", gemini: "#4b8ffb" });
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
// A color as it may cross between the helper, the pages and the page script: #rrggbb.
export const COLOR = /^#[0-9a-f]{6}$/i;
export const isColor = (c) => COLOR.test(c || "");

// ---- an agent's state ----
// pairbrowse_status kinds: the badge's ("claude": working, "you": the user's turn, "done", and
// "clear" to take it down).
export const STATUS_KINDS = Object.freeze(["claude", "you", "done", "clear"]);
// The session board's status per participant (daemon/board.mjs), and its words, so a state
// never shows by color alone.
export const BOARD_STATES = Object.freeze(["working", "you", "done", "idle"]);
export const STATE_WORDS = Object.freeze({ working: "working", you: "waiting for their person", done: "done", idle: "idle" });

// ---- people who joined ----
// An invite's role: watch (only looks) or drive (clicks, types, and their agent acts here).
export const ROLES = Object.freeze(["watch", "drive"]);
// How a join code shares: the host's own browser (shared) or a copy that follows it (follow).
export const SHARE_MODES = Object.freeze(["shared", "follow"]);

// ---- the browser's own pages ----
// The helper's page kinds: the browser's own pages that open an event stream with ?page=<kind>
// (the owner's key only; liveview.mjs counts them, common.js helperStream names its own).
export const PAGE_KINDS = Object.freeze(["strip", "left", "right", "timeline", "approve", "picker", "screen", "capture"]);
