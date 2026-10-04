// "Pause agents": a person stops every agent in the session (both browsers of a joined one)
// before its next browser action, and anyone who may drive resumes them. Only people do this:
// there's no tool for it, so an agent can neither pause nor resume, and a message asking for it
// changes nothing. The host's helper holds the state; a joined helper mirrors it.
import { cleanName } from "../join.mjs";

export const PAUSE_REPLY_MS = 60_000; // a paused agent hears back after this, so it isn't stuck
const POLL_MS = 200;
const EVENTS_MAX = 20;

// onChange(view): the state changed (bars, side panels and joiners show it).
export function createPause({ onChange = () => {}, now = () => Date.now(), replyMs = PAUSE_REPLY_MS } = {}) {
  let state = null; // { by, at } while paused
  let resumedBy = "";
  const events = []; // { n, kind: "paused" | "resumed", who }, for agents' next results
  let seq = 0;

  const view = () => ({ paused: !!state, by: state?.by || "", at: state?.at || 0, resumedBy });
  function set(paused, who) {
    const name = cleanName(who) || "Someone";
    if (paused === !!state) return false;
    state = paused ? { by: name, at: now() } : null;
    if (!paused) resumedBy = name;
    events.push({ n: ++seq, kind: paused ? "paused" : "resumed", who: name });
    if (events.length > EVENTS_MAX) events.shift();
    try { onChange(view()); } catch {}
    return true;
  }

  return {
    view,
    pause: (who) => set(true, who),
    resume: (who) => set(false, who),
    // A joined helper: the host's state, as it came (who paused, who resumed).
    mirror(remote) {
      if (remote?.paused) return set(true, remote.by);
      return set(false, remote?.resumedBy || "someone");
    },
    // Waits while paused, at most replyMs. Resolves null when not paused (or no longer), or
    // { by } when still paused then (nothing was done).
    async wait(signal = null) {
      const until = now() + replyMs;
      while (state && now() < until && !signal?.aborted) await new Promise((r) => setTimeout(r, POLL_MS));
      return state ? { by: state.by } : null;
    },
    // The latest event number: an agent connecting now hasn't missed anything before it.
    seq: () => seq,
    // One line for an agent's next result: pauses and resumes after n. Returns { text, n }.
    noteAfter(n) {
      const fresh = events.filter((e) => e.n > n);
      if (!fresh.length) return { text: "", n };
      const said = fresh.map((e) => `${e.kind} by ${e.who}`).join(", then ");
      const text = state
        ? `- Agents are paused (${said}). Browser actions wait until a person resumes; nothing is done meanwhile.`
        : `- Agents were ${said}. Nothing was done meanwhile; look at the page again (browser_snapshot) before you go on.`;
      return { text, n: fresh.at(-1).n };
    },
  };
}
