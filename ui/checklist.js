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

// The goal log as a checklist (the side panel's agent card): newest first. What is left on top
// (last to do first), then what was handed to you, then what was done, the newest done line
// marked current while the agent is driving. Only the log's own lines; each row says its state in
// a glyph and in words, and carries a key that stays the row's own as the log grows (d<n>: the
// n-th done line from the oldest), which lets the page keep a row in place across redraws.
// A long log draws its newest CHECKLIST_PAGE done lines; older ones come in pages (doneRows).
export const CHECKLIST_PAGE = 200;
const CHECK = { done: ["✓", "Done:"], current: ["◉", "Current:"], waiting: ["●", "Waiting for you:"], pending: ["○", "Pending:"] };
export function checkState(li, state) {
  const [glyph, words] = CHECK[state];
  li.dataset.state = state;
  li.querySelector(".mark").textContent = glyph;
  li.querySelector(".sr").textContent = `${words} `;
}
const row = (key, state, ...kids) => {
  const mark = el("span", { className: "mark" });
  mark.setAttribute("aria-hidden", "true");
  const li = el("li", {}, mark, el("span", { className: "text" }, el("span", { className: "sr" }), ...kids));
  li.dataset.key = key;
  checkState(li, state);
  return li;
};
const lines = (x) => (Array.isArray(x) ? x : []);
// The done lines from..to-1 (indexes from the oldest), newest first.
export function doneRows(run, from, to, { driving = false } = {}) {
  const done = lines(run?.done);
  const out = [];
  for (let i = Math.min(to, done.length) - 1; i >= Math.max(0, from); i--) {
    out.push(row(`d${i}`, driving && i === done.length - 1 ? "current" : "done", ...[...doneLine(done[i]).childNodes]));
  }
  return out;
}
// from: the oldest done line drawn (by default the newest CHECKLIST_PAGE are).
export function checklistItems(run, { driving = false, from } = {}) {
  const empty = (text) => [el("li", { className: "empty", textContent: text })];
  if (!run || typeof run !== "object") return empty("No goal log yet: it starts with the first browser action.");
  const done = lines(run.done);
  const first = from === undefined ? Math.max(0, done.length - CHECKLIST_PAGE) : Math.max(0, Math.min(from, done.length));
  const items = [
    ...lines(run.left).map((x, i) => row(`p${i}`, "pending", String(x))).reverse(),
    ...lines(run.yourTurn).map((x, i) => row(`w${i}`, "waiting", String(x))).reverse(),
    ...doneRows(run, first, done.length, { driving }),
  ];
  return items.length ? items : empty("Nothing done yet.");
}

// The checklist in its own scroll area (box, holding list): items(run) gives the rows to draw,
// draw(items, run) puts them in. Scrolled down, a redraw keeps the older pages already drawn and
// the row at the top of the view where it was, so steps arriving on top move nothing; at the top
// it follows the newest page again. The next page of older steps comes in once the list's end is
// within a view of being shown. driving(): whether the agent drives (the newest step is current).
export function checklistView(box, list, driving) {
  let run = null, from = 0;
  const more = () => {
    if (!run || from <= 0 || box.hidden) return;
    if (box.scrollTop + box.clientHeight < box.scrollHeight - box.clientHeight) return;
    const to = from;
    from = Math.max(0, to - CHECKLIST_PAGE);
    list.append(...doneRows(run, from, to, { driving: driving() }));
  };
  box.addEventListener("scroll", more, { passive: true });
  return {
    items(r) {
      if (!r || typeof r !== "object") return checklistItems(r);
      const done = lines(r.done).length, newest = Math.max(0, done - CHECKLIST_PAGE);
      // A log that started over (shorter than what was drawn) starts over here too.
      from = box.scrollTop > 0 && run && from <= done ? Math.min(from, newest) : newest;
      return checklistItems(r, { driving: driving(), from });
    },
    draw(items, r = null) {
      const top = box.getBoundingClientRect().top;
      const anchor = box.scrollTop > 0 ? [...list.children].find((li) => li.dataset.key && li.getBoundingClientRect().bottom > top) : null;
      const was = anchor ? anchor.getBoundingClientRect().top : 0;
      list.replaceChildren(...items);
      run = r;
      const now = anchor && list.querySelector(`li[data-key="${anchor.dataset.key}"]`);
      if (now) box.scrollTop += now.getBoundingClientRect().top - was;
      more();
    },
  };
}
