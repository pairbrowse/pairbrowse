// The pages' words: activity text, clocks, an agent's state and the resting state's lines, the
// same on every page. Shared by the pages and the live view (common.js re-exports it; the live view
// serves it). A flat file at the ui/ root; definitions only, nothing runs on import.
import { STATE_WORDS } from "./vocab.js";
import { el } from "./dom.js";

// Activity text: **bold** and `code`, rendered safely (text nodes only, never markup).
export function rich(text) {
  const frag = document.createDocumentFragment();
  for (const part of String(text).split(/(\*\*[^*]+\*\*|`[^`]*`)/)) {
    if (!part) continue;
    if (part.startsWith("**")) frag.append(el("strong", { textContent: part.slice(2, -2) }));
    else if (part.startsWith("`")) frag.append(el("code", { textContent: part.slice(1, -1) }));
    else frag.append(part);
  }
  return frag;
}
export const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
// Hours and minutes only on a 24-hour clock (the timeline's cards: "10:24", the mockup).
export const shortClock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
// How long ago, worked out once when drawn (nothing ticks): "just now", "N min ago", else the date and time.
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = (now - t) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  return new Date(t).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}
// An agent's status in words (STATE_WORDS, vocab.js), so it never shows by color alone.
export const stateWord = (s) => (Object.hasOwn(STATE_WORDS, s) ? STATE_WORDS[s] : "idle");
// One vocabulary for an agent's or a person's state, the left dock's and the right dock's alike
// (545): agents "Working", "Waiting for you" ("Waiting for their person" for an agent in another
// browser), "Paused", "Done", "Idle"; people "Online". The state is the helper's (the board's
// status, its pause) and the agent's own last action (driving: within the last 8 s), read the same
// way in both docks, never the number of its tabs: a caller that counts them (the left dock) gets
// them after the state ("Idle · 1 tab"). state is the word's key, for a dot that repeats it (never
// alone).
export function agentWords(p, { tabs = 0, driving = false, paused = false } = {}) {
  if (p?.kind === "person") return { state: "online", words: "Online" };
  const n = Number.isInteger(tabs) && tabs > 0 ? ` · ${tabs} tab${tabs === 1 ? "" : "s"}` : "";
  if (p?.status === "you") return { state: "waiting", words: (p.where ? "Waiting for their person" : "Waiting for you") + n };
  if (paused) return { state: "paused", words: `Paused${n}` };
  if (p?.status === "working" || driving) return { state: "working", words: `Working${n}` };
  if (p?.status === "done") return { state: "done", words: `Done${n}` };
  return { state: "idle", words: `Idle${n}` };
}
// An agent's own action in the activity list (not a joiner's line from the other browser, not a
// note): what "working" counts, in both docks.
export const ownAgentLine = (a) => !!a?.who && !a.from && !String(a.text || "").startsWith("Note: ");
// "Alice" -> "Alice's Claude". Unnamed ("Claude 3fed") and app-labelled ("Alice · Codex") stay as they are.
export const whose = (who) => !who ? "Claude" : /^Claude\b| · /.test(who) ? who : `${who}'s Claude`;
// The activity line's head: who did it, and in which tab.
export const activityHead = (a) => [a.who, a.tab ? `in ${a.tab}` : ""].filter(Boolean).join(" ");

// No helper to ask, or none reached (DESIGN.md B2, B4): the resting state, not an error. The same
// words on every page, muted, no red and no retry line; `what` is what shows on that page once an
// agent starts ("Its task, checklist and status", "Your sessions").
export const NO_AGENT = "No agent connected";
export const noAgentLine = (what) => `Ask Claude Code, Codex or Grok to use PairBrowse. ${what} show here.`;
