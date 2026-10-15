// Who decides a click: the page's structure (daemon/page.mjs clickRisk), the agent already in the
// loop (Claude Code or Codex), or the user. Nothing here leaves the computer: no model is called,
// no network is used. Pure, so the hook-free rules can be tested on their own.
// - Strong structural signals (payment fields or frames, danger styling, a DELETE method, a
//   confirmation after a delete or payment, an element that can't be read) make a click a final
//   action the user confirms, whatever the agent calls it: refused until named with that class.
// - Everything else goes: ordinary submits (sign-up steps, settings saves) and script buttons are
//   too common to stop on, so the agent names the ones it knows commit something from its task
//   ("Pay:", "Delete:", "Publish:", "Send:", "Submit:"), and the hook asks the user about those.

// A click Claude knows commits something is named with its class first: "Pay: Submit order",
// "Delete: OK", "Submit: Create account", "Send: Reply", "Publish: Submit for review". The helper
// works out from the page's structure what the click does (daemon/page.mjs clickRisk, never its
// words) and refuses one with strong signals until it's named (scripts/rules/clicks.mjs); ordinary
// submits go unless Claude names them. This hook asks you about every named click. Publish is the class
// Claude gives a submit-for-review or go-live click (the listing skill), and it's blocked until a
// passing pre-submit review.
export const CLICK_CLASSES = ["publish", "pay", "delete", "send", "submit"];
export const CLASS_TEXT = { publish: "publishes or submits for review", pay: "pays", delete: "deletes or ends something", send: "sends something to other people", submit: "sends or submits something" };

// The class an element description starts with ("Pay: Submit order" -> "pay"), or "".
export function clickClass(element) {
  const c = String(element || "").match(/^[\s"'“‘([]*([A-Za-z]+)\s*:/)?.[1]?.toLowerCase();
  return CLICK_CLASSES.includes(c) ? c : "";
}

// The class an element starts with, as clickClass reads it, with what follows it.
export const CLICK_PREFIX = /^[\s"'“‘([]*[A-Za-z]+\s*:\s*/;

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
