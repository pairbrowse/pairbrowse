// Who decides a click: the page's structure (daemon/page.mjs clickRisk), the agent already in the
// loop (Claude Code or Codex), or the user. Nothing here leaves the computer: no model is called,
// no network is used. Pure, so the hook-free rules can be tested on their own.
// - Strong structural signals (payment fields or frames, danger styling, a DELETE method, a
//   confirmation after a delete or payment, an element that can't be read) make a click a final
//   action the user confirms, whatever the agent calls it: refused until named with that class.
// - Everything else goes: ordinary submits (sign-up steps, settings saves) and script buttons are
//   too common to stop on, so the agent names the ones it knows commit something from its task
//   ("Pay:", "Delete:", "Publish:", "Send:", "Submit:"), and the hook asks the user about those.
import { clickClass } from "./guard.mjs";

export const strongSignal = (risk) => !!risk && (risk.level === "strong" || risk.unreadable === true || ["pay", "delete"].includes(risk.word));

// What happens to a click: "go" (on to the hook, which asks about any named class) or "name"
// (refused until it carries the class its strong signals found; a plain submit class can't stand
// in for pay or delete).
export function clickRule(risk, element) {
  if (!strongSignal(risk)) return "go";
  const cls = clickClass(element);
  return cls && (cls === risk.word || !["pay", "delete"].includes(risk.word)) ? "go" : "name";
}

// OK on a page's own confirm or prompt dialog. prev: what the click before it committed ("pay",
// "delete"), which makes the OK that same final action. Any other OK follows the agent's label.
export function dialogRule(accept, prev, element) {
  if (!accept || !["pay", "delete"].includes(prev)) return "go";
  return clickClass(element) === prev ? "go" : "name";
}
