// The Page tab's outline: the whole-page snapshot (yaml) a local agent last got for a tab, kept
// in memory per tab and dropped when the tab closes. It is taken from the result text after that
// result went out to the agent (already masked and cut as the agent got it): nothing is captured
// for it and no page is asked anything (only url() and isClosed() are read). Read by the owner's
// live view routes (GET outline.json, masked again there) and their `outline` event (metadata
// only, never the text).
import { isChromePage } from "../../ui/urls.js";

export const OUTLINE_MAX = 32_000;
const CUT_NOTE = "This page's snapshot is long"; // output.mjs capSnapshot's note

// The first fenced yaml block of a result's text: { text, cut } (cut: the agent got the first
// part only), or null when there is none. It ends at a fence on a line of its own: a ``` inside a
// snapshot line (a page showing a code block) is text.
export function yamlOf(text) {
  const s = String(text ?? "");
  const m = /```yaml\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/.exec(s);
  if (!m) return null;
  return { text: m[1], cut: s.includes(CUT_NOTE) };
}

// mask(text): as results are masked (applied again on read by the route). now(): the clock.
export function createOutlines({ mask = (t) => t, now = Date.now } = {}) {
  const held = new Map(); // page -> { text, who, at, cut }
  const watched = new WeakSet(); // pages whose close drops their entry (one listener each)
  const listeners = new Set();
  const emit = (change) => { for (const fn of listeners) { try { fn(change); } catch {} } };
  const open = (page) => { try { return !page.isClosed(); } catch { return false; } };
  const urlOf = (page) => { try { return String(page.url() || ""); } catch { return ""; } };

  return {
    // A result's text for this page (its yaml block, if any): kept, replacing the one before.
    // True when an outline was kept.
    record(page, { text, who = "" } = {}) {
      if (!page || !open(page) || isChromePage(urlOf(page))) return false;
      const y = yamlOf(text);
      if (!y) return false;
      let body = y.text, cut = y.cut;
      if (body.length > OUTLINE_MAX) {
        const at = body.lastIndexOf("\n", OUTLINE_MAX);
        body = body.slice(0, at > 0 ? at : OUTLINE_MAX);
        cut = true;
      }
      const entry = { text: body, who: String(who || "").slice(0, 80), at: now(), cut };
      held.set(page, entry);
      if (!watched.has(page) && typeof page.once === "function") {
        watched.add(page);
        page.once("close", () => { if (held.delete(page)) emit({ op: "drop", page }); });
      }
      emit({ op: "set", page, ...entry });
      return true;
    },
    // This page's outline ({ text, who, at, cut }, the text masked again), or null.
    get(page) {
      const e = page && open(page) ? held.get(page) : null;
      return e ? { ...e, text: mask(e.text) } : null;
    },
    // The open page whose outline came last, or null.
    latest() {
      let best = null, at = -Infinity;
      for (const [page, e] of held) if (open(page) && e.at >= at) { best = page; at = e.at; }
      return best;
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    size: () => held.size,
  };
}
