// "Pause agents": a person stops every agent in the session (both browsers of a joined one)
// before its next browser action, and anyone who may drive resumes them. Only people do this:
// there's no tool for it, so an agent can neither pause nor resume, and a message asking for it
// changes nothing. The host's helper holds the state; a joined helper mirrors it.
// "Pause this agent" (the owner's pages only): the same for one agent, keyed by its connection
// (an agent renaming itself doesn't get out of it), dropped when that connection ends. A person
// resumes it, or presses the global Resume, which resumes every agent paused this way too, pressed
// here or in a session joined from here (where the host decides the shared pause); an agent never
// resumes itself.
import { cleanName } from "../sharing/join.mjs";

export const PAUSE_REPLY_MS = 60_000; // a paused agent hears back after this, so it isn't stuck
const POLL_MS = 200;
const EVENTS_MAX = 20;
const OWN_EVENTS_MAX = 8; // one agent's own pauses and resumes, kept apart from the shared ones

// onChange(view): the state changed (bars, side panels and joiners show it).
export function createPause({ onChange = () => {}, now = () => Date.now(), replyMs = PAUSE_REPLY_MS } = {}) {
  let state = null; // { by, at } while paused
  let resumedBy = "";
  const own = new Map(); // agent connection id -> { by, at }: paused on its own
  // { n, kind: "paused" | "resumed", who, id?, pausedBy? }, for agents' next results. The shared
  // ones in events; one agent's own (with its id) in ownEvents, so clicks on one agent never push a
  // shared event out before an idle agent reads it. Its own go when its connection ends.
  const events = [];
  const ownEvents = new Map(); // agent connection id -> its own events
  let seq = 0;

  const view = () => ({ paused: !!state, by: state?.by || "", at: state?.at || 0, resumedBy });
  const changed = () => { try { onChange(view()); } catch {} };
  const note = (e) => {
    const list = e.id ? (ownEvents.get(e.id) || ownEvents.set(e.id, []).get(e.id)) : events;
    list.push({ n: ++seq, ...e });
    if (list.length > (e.id ? OWN_EVENTS_MAX : EVENTS_MAX)) list.shift();
  };
  function set(paused, who) {
    const name = cleanName(who) || "Someone";
    if (paused === !!state) return false;
    state = paused ? { by: name, at: now() } : null;
    if (!paused) resumedBy = name;
    note({ kind: paused ? "paused" : "resumed", who: name });
    changed();
    return true;
  }
  // Every agent paused on its own goes on (the global Resume): true when there was one.
  function resumeOwn(name) {
    if (!own.size) return false;
    for (const [id, held] of own) note({ kind: "resumed", who: name, id, pausedBy: held.by });
    own.clear();
    return true;
  }

  return {
    view,
    pause: (who) => set(true, who),
    // The global Resume also resumes every agent paused on its own, so a pause always has a
    // visible way back. True when anything was held.
    resume(who) {
      const name = cleanName(who) || "Someone";
      const hadOwn = resumeOwn(name);
      const was = set(false, who);
      if (hadOwn && !was) changed();
      return was || hadOwn;
    },
    // Every agent paused on its own goes on; the shared (or mirrored) pause stays as it is. True
    // when there was one.
    resumeAgents(who) {
      const had = resumeOwn(cleanName(who) || "Someone");
      if (had) changed();
      return had;
    },
    // A joined helper: the host's state, as it came (who paused, who resumed).
    mirror(remote) {
      if (remote?.paused) return set(true, remote.by);
      return set(false, remote?.resumedBy || "someone");
    },
    // One agent (its connection id), by a person. False when it was paused on its own already.
    pauseOne(id, who) {
      if (!id || own.has(id)) return false;
      const name = cleanName(who) || "Someone";
      own.set(id, { by: name, at: now() });
      note({ kind: "paused", who: name, id });
      changed();
      return true;
    },
    resumeOne(id, who) {
      const held = own.get(id);
      if (!held) return false;
      own.delete(id);
      note({ kind: "resumed", who: cleanName(who) || "Someone", id, pausedBy: held.by });
      changed();
      return true;
    },
    // Its connection ended: its own pause goes with it.
    forget(id) { ownEvents.delete(id); if (own.delete(id)) changed(); },
    // Whether this agent is held now, and by whom: the global pause first, then its own.
    heldFor(id) {
      if (state) return { paused: true, by: state.by };
      const held = id ? own.get(id) : null;
      return held ? { paused: true, by: held.by } : { paused: false, by: "" };
    },
    // The agents paused on their own: [{ id, by, at }].
    agents: () => [...own].map(([id, { by, at }]) => ({ id, by, at })),
    // Waits while paused (globally, or this agent on its own), at most replyMs. Resolves null
    // when not paused (or no longer), or { by } when still paused then (nothing was done).
    async wait(signal = null, id = null) {
      const held = () => state || (id ? own.get(id) : null);
      const until = now() + replyMs;
      while (held() && now() < until && !signal?.aborted) await new Promise((r) => setTimeout(r, POLL_MS));
      const h = held();
      return h ? { by: h.by } : null;
    },
    // The latest event number: an agent connecting now hasn't missed anything before it.
    seq: () => seq,
    // One line for an agent's next result: pauses and resumes after n (another agent's own are
    // skipped). Returns { text, n }.
    noteAfter(n, id = null) {
      const fresh = [...events, ...(id ? ownEvents.get(id) || [] : [])].filter((e) => e.n > n).sort((a, b) => a.n - b.n);
      if (!fresh.length) return { text: "", n };
      const lines = [];
      const shared = fresh.filter((e) => !e.id);
      if (shared.length) {
        const said = shared.map((e) => `${e.kind} by ${e.who}`).join(", then ");
        lines.push(state
          ? `- Agents are paused (${said}). Browser actions wait until a person resumes; nothing is done meanwhile.`
          : `- Agents were ${said}. Nothing was done meanwhile; look at the page again (browser_snapshot) before you go on.`);
      }
      const mine = fresh.filter((e) => e.id);
      if (mine.length) {
        const held = own.get(id);
        if (held) lines.push(`- You were paused by ${held.by} (this agent only). Browser actions wait until a person resumes you; nothing is done meanwhile.`);
        else {
          const resumed = mine.findLast((e) => e.kind === "resumed");
          if (resumed) lines.push(`- You were paused by ${resumed.pausedBy}, then resumed by ${resumed.who}. Nothing was done meanwhile; look at the page again (browser_snapshot) before you go on.`);
        }
      }
      return { text: lines.join("\n"), n: fresh.at(-1).n };
    },
  };
}

// A person pressed "Pause agents" or "Resume" (the bar in a page, the side panel, a drive guest's
// viewer). joined: in a session joined from here, where the host decides the shared pause and its
// state comes back (say forwards the press); a Resume pressed here still lets this helper's own
// paused agents go at once, since the host can't see them. canPause(): this person may drive.
// agent: "Pause this agent" (the owner's pages only): every agent here with that name
// (agentIds(name) -> connection ids). Resuming one is always possible; pausing one isn't in a
// session joined from here. Returns { ok } or { problem }.
export function pressPause(pause, { paused, who, agent = null, joined = false, canPause = () => true, say = () => {}, agentIds = () => [] }) {
  if (agent !== null) {
    if (paused && joined) return { problem: "In a session joined from here, Pause agents pauses everyone; one agent can't be paused on its own." };
    const ids = agentIds(agent);
    if (!ids.length) return { problem: `No agent named "${agent}" works in this browser.` };
    for (const id of ids) if (paused) pause.pauseOne(id, who); else pause.resumeOne(id, who);
    return { ok: true };
  }
  if (joined) {
    const hadOwn = !paused && pause.resumeAgents(who);
    if (!canPause()) return hadOwn && !pause.view().paused ? { ok: true } : { problem: "You joined to watch: only drive participants can pause agents." };
    say({ op: "pause", paused });
    return { ok: true };
  }
  if (paused) pause.pause(who); else pause.resume(who);
  return { ok: true };
}
