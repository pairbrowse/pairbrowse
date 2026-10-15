// The goal log as the pages show it: a done line, and the agent card's checklist. Shared by the
// right dock and the live view (common.js re-exports it; the live view serves it). A flat file at
// the ui/ root; definitions only, nothing runs on import.
import { el } from "./dom.js";
import { rich } from "./words.js";

// A done line of the goal log, as the log writes it: "Title <url>: act; act", or "url: act; act".
export function doneLine(line) {
  const s = String(line);
  let head = s, url, rest = "";
  const m = s.match(/^(.*?) <([^>]*)>(?:: (.*))?$/s);
  if (m) { head = m[1]; url = m[2]; rest = m[3] || ""; }
  else { const i = s.indexOf(": "); if (i > 0) { head = s.slice(0, i); rest = s.slice(i + 2); } url = /^https?:\/\//.test(head) ? head : ""; }
  const li = el("li", {}, el("span", { className: "page", textContent: head, title: url }));
  if (rest) {
    const acts = el("span", { className: "acts" });
    rest.split("; ").forEach((a, i) => { if (i) acts.append(" · "); acts.append(rich(a)); });
    li.append(acts);
  }
  return li;
}

// The goal log as a checklist (the side panel's agent card): what was done, oldest first, the
// newest done line marked current while the agent is driving, then what was handed to you and
// what is left. Only the log's own lines; each row says its state in a glyph and in words.
const CHECK = { done: ["✓", "Done:"], current: ["◉", "Current:"], waiting: ["●", "Waiting for you:"], pending: ["○", "Pending:"] };
export function checkState(li, state) {
  const [glyph, words] = CHECK[state];
  li.dataset.state = state;
  li.querySelector(".mark").textContent = glyph;
  li.querySelector(".sr").textContent = `${words} `;
}
export function checklistItems(run, { driving = false } = {}) {
  const empty = (text) => [el("li", { className: "empty", textContent: text })];
  if (!run || typeof run !== "object") return empty("No goal log yet: it starts with the first browser action.");
  const row = (state, ...kids) => {
    const mark = el("span", { className: "mark" });
    mark.setAttribute("aria-hidden", "true");
    const li = el("li", {}, mark, el("span", { className: "text" }, el("span", { className: "sr" }), ...kids));
    checkState(li, state);
    return li;
  };
  const done = Array.isArray(run.done) ? run.done : [];
  const items = [
    ...done.map((d, i) => row(driving && i === done.length - 1 ? "current" : "done", ...[...doneLine(d).childNodes])),
    ...(Array.isArray(run.yourTurn) ? run.yourTurn : []).map((x) => row("waiting", String(x))),
    ...(Array.isArray(run.left) ? run.left : []).map((x) => row("pending", String(x))),
  ];
  return items.length ? items : empty("Nothing done yet.");
}
