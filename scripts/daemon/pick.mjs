// The person's session choices from PairBrowse's own pages (the owner-only live view route POST
// pick, liveview.mjs): the session picker at the browser's start, the session switcher and the new
// tab page's chips while a session is open, and the sessions page's Delete on a saved session. The answer to
// an address question a join code raised there (POST joinhost) lands here too.
//
// readPick(body) -> { op } (only the fields that action takes) or { error }:
//   { action: "use", name, confirm? }   a saved session
//   { action: "new", confirm? }         a fresh, throwaway session
//   { action: "join", code, joinName? } join someone's shared session with their code
//   { action: "delete", name }          delete a saved session (never the open one or "default")
// confirm: true is the page saying the person was told agents are at work and still chose to
// switch (the answer before asked them: { confirm: "<question>", agents }).
//
// createPick(deps).pick(op) -> { text } or { text, error: true } (plus { confirm, agents } when
// agents are at work and the page hasn't said so). With the picker showing, use and new answer it
// (context.pickSession) as before; with a session open they switch to another one, after the same
// checks a rename takes (nobody joined in, no recording, no approval waiting) and, while other
// agents are at work, only once the page confirms. Joining keeps the session open (the shared
// tabs open in a window of their own) and answers a showing picker (context.pickedJoin), so
// agents waiting for the pick go on. hostDecision(op): follow.decideHost, and a join it started for
// the picker answers the pick the same way.
import { validName, isTemporary } from "../sessions.mjs";
import { JOIN_CODE_MAX as CODE_MAX, JOIN_NAME_MAX } from "../../ui/limits.js";

const KEYS = { use: ["action", "name", "confirm"], new: ["action", "confirm"], join: ["action", "code", "joinName"], delete: ["action", "name"] };
const SHAPE = 'A pick is { action: "use", name }, { action: "new" }, { action: "join", code, joinName } or { action: "delete", name }.';

export function readPick(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(KEYS, body.action)) return { error: SHAPE };
  const keys = KEYS[body.action];
  const extra = Object.keys(body).find((k) => !keys.includes(k));
  if (extra !== undefined) return { error: `Unknown field "${String(extra).slice(0, 40)}" for "${body.action}".` };
  const op = { action: body.action };
  if (keys.includes("name")) {
    if (!validName(body.name)) return { error: "name is a session's name (letters, numbers, - and _, up to 40)." };
    op.name = body.name;
  }
  if (body.confirm !== undefined) {
    if (typeof body.confirm !== "boolean") return { error: "confirm is true or false." };
    op.confirm = body.confirm;
  }
  if (body.action === "join") {
    if (typeof body.code !== "string" || !body.code.trim() || body.code.length > CODE_MAX) return { error: "code is the join code you were given (pb-join:...)." };
    if (body.joinName !== undefined && (typeof body.joinName !== "string" || body.joinName.length > JOIN_NAME_MAX)) return { error: `joinName is your name, up to ${JOIN_NAME_MAX} characters.` };
    op.code = body.code.trim();
    if (body.joinName !== undefined) op.joinName = body.joinName;
  }
  return { op };
}

const listOf = (names) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

// context: { picking(), pickSession(op), pickedJoin(text), switchForPerson(op), sessionName(),
// sessionCommand(op) }. follow: { command(args, who), decideHost(op) }. activeAgents(): the agents at
// work in this browser now (their names). busy(): a sentence when a switch must wait (people joined
// in, a recording, an approval), else null. hostNote(text): for the agents' next result.
export function createPick({ context, follow, activeAgents = () => [], busy = () => null, hostNote = () => {}, log = () => {} }) {
  async function join(op) {
    const picking = context.picking();
    const r = await follow.command({ action: "join", code: op.code.slice(0, CODE_MAX), name: String(op.joinName || "").slice(0, JOIN_NAME_MAX) }, { owner: "picker", app: "PairBrowse" });
    if (r.needsName) return { text: "Type your name too: the host sees it before letting you in. It's remembered for next time.", error: true };
    if (r.error) return r;
    const asked = `${String(r.text || "").split(". Then")[0]}.`; // "Asked Bob to let Alice in (drive). They have to approve first."
    if (picking && context.picking()) context.pickedJoin(`The person joined a shared session from the browser's session picker: ${asked} Check with pairbrowse_join status.`);
    else hostNote(`The person joined a shared session from the browser: ${asked} Check with pairbrowse_join status.`);
    return { text: asked };
  }

  async function pick(given) {
    const { op, error } = readPick(given);
    if (error) return { text: error, error: true };
    if (op.action === "join") return join(op);
    if (op.action === "delete") {
      if (isTemporary(op.name)) return { text: "A clean session is deleted by itself when you switch away.", error: true };
      const r = await context.sessionCommand({ action: "delete", name: op.name });
      if (!r.error) { hostNote(`The person deleted the browser session "${op.name}" in PairBrowse's sessions page.`); log(`session ${op.name} deleted by the person`); }
      return r.error ? { text: r.text, error: true } : { text: r.text };
    }
    if (context.picking()) return context.pickSession({ action: op.action, name: op.name });
    // A session is open: the person switches from it (the switcher, the new tab page's chips).
    if (op.action === "use" && op.name === context.sessionName()) return { text: `You're in session "${op.name}" already.` };
    const why = busy();
    if (why) return { text: why, error: true };
    const agents = [...new Set(activeAgents())];
    if (agents.length && op.confirm !== true) {
      const n = agents.length === 1 ? `${agents[0]} is` : `${listOf(agents)} are`;
      return { text: `${n} using the browser: switching closes its tabs for them.`, error: true, confirm: `${n} using the browser. Switching closes every tab for them. Switch anyway?`, agents };
    }
    const r = await context.switchForPerson({ action: op.action, name: op.name });
    if (!r.error) {
      const to = op.action === "new" ? "a fresh, throwaway session (no logins)" : `session "${op.name}"`;
      hostNote(`The person switched the browser to ${to}${agents.length ? " while you were working" : ""}; the browser restarted, so tab numbers changed: use browser_tabs list.`);
      log(`the person switched to ${op.action === "new" ? "a fresh session" : `session ${op.name}`}${agents.length ? ` (confirmed over ${agents.length} active)` : ""}`);
    }
    return r;
  }

  async function hostDecision(op) {
    const r = await follow.decideHost(op);
    if (r.joined && r.owner === "picker") {
      const text = `${String(r.text || "").split(". Then")[0]}`;
      if (context.picking()) context.pickedJoin(`The person joined a shared session from the browser's session picker, after allowing its address ${r.host}: ${text}. Check with pairbrowse_join status.`);
      else hostNote(`The person joined a shared session from the browser, after allowing its address ${r.host}: ${text}. Check with pairbrowse_join status.`);
    }
    return r;
  }

  return { pick, hostDecision };
}
