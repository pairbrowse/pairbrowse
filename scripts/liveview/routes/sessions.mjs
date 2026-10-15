// The sessions' routes on the owner's port (the owner only): the session picker's list and pick,
// "End session" (the picker again), and the session card's rename and save. startLiveView mounts them.
import { readPick } from "../../daemon/pick.mjs";
import { json, readJsonBody, BODY_MAX } from "../http.mjs";

const SESSION_OP = 'A session change is { op: "rename", name, from? } or { op: "save" }.';

// picker: { state(), pick(op), open() } or null. sessionOps: the session card's { state(),
// current(), rename(name, from?), save() } or null. broadcast(event, data). ownerSession(): the
// session as the owner's streams get it. linkGuests, layouts: the live view's (guests watching;
// each session's docks layout). joinersNow(), recordState(), clickApprovals: what holds a rename.
export function createSessionRoutes({ picker, sessionOps, broadcast, ownerSession, linkGuests, layouts, joinersNow, recordState, clickApprovals }) {
  return [
    // The session picker (an extension page, with the owner's key from the side panel's memory):
    // the saved sessions, and the person's pick. picker: { state(), pick(op) } from the helper.
    { method: "GET", path: "sessions.json", right: "session", needs: () => picker, handler: ({ res }) => json(res, 200, picker.state()) },
    // While a session is open too (the switcher, the new tab page's chips, the sessions page): the
    // helper decides (daemon/pick.mjs). 428 { confirm, agents } while other agents are at work and
    // the body has no confirm: true; 409 { text, error } for a refusal; the open pages hear the
    // sessions event after a change.
    { method: "POST", path: "pick", right: "session", needs: () => picker, handler: async ({ req, res }) => {
      const given = await readJsonBody(req, res, BODY_MAX.approve);
      if (given === undefined) return;
      const { op, error } = readPick(given);
      if (error) return json(res, 409, { text: error, error: true });
      const r = (await picker.pick(op)) || { text: "That didn't work. Try again.", error: true };
      json(res, r.confirm ? 428 : r.error ? 409 : 200, r);
      if (!r.error) { try { broadcast("sessions", picker.state()); } catch {} }
    } },
    // "End session" in the side panel (the right dock in the browser): the picker again, in a new tab (the owner only).
    { method: "POST", path: "picker", right: "session", needs: () => picker?.open, handler: async ({ res }) => {
      json(res, 200, await picker.open());
    } },
    // The session card (the owner only): { op: "rename", name } restarts the browser on the renamed
    // session ({ op: "rename", name, from }: a saved one that isn't open, renamed without a
    // restart; the sessions page), { op: "save" } writes its tabs now. sessionOps from the helper (daemon.mjs).
    { method: "POST", path: "session", right: "session", needs: () => sessionOps, handler: async ({ req, res }) => {
      const op = await readJsonBody(req, res, BODY_MAX.approve);
      if (op === undefined) return;
      if (!op || typeof op !== "object" || Array.isArray(op) || (op.op !== "rename" && op.op !== "save")) return json(res, 409, { error: SESSION_OP });
      if (op.op === "save") {
        const r = await sessionOps.save();
        if (!r || r.error) return json(res, 409, { error: r?.error || "That didn't work. Try again." });
        json(res, 200, { ok: true, savedAt: r.savedAt || "" });
        broadcast("session", ownerSession());
        return;
      }
      // from: a saved session that isn't open (the sessions page): renamed in place, nothing
      // restarts, so who is in this session, a recording or an approval don't hold it up.
      if (op.from !== undefined && (typeof op.from !== "string" || !op.from.trim() || op.from.length > 40)) return json(res, 409, { error: "from is a saved session's name." });
      const from = op.from === undefined ? undefined : op.from.trim();
      const saved = from !== undefined && from !== sessionOps.current?.();
      if (!saved) {
        if (linkGuests.size || joinersNow().length) return json(res, 409, { error: "People are in this session; rename it once they have left." });
        if (recordState()?.recording) return json(res, 409, { error: "Stop the recording first." });
        if (clickApprovals?.pending().length) return json(res, 409, { error: "An approval is waiting; answer it first." });
      }
      const name = String(op.name ?? "").trim();
      const r = await (saved ? sessionOps.rename(name, from) : sessionOps.rename(name));
      if (!r || r.error) return json(res, 409, { error: r?.error || "That didn't work. Try again." });
      if (r.from && r.from !== r.name && layouts.has(r.from)) { layouts.set(r.name, layouts.get(r.from)); layouts.delete(r.from); }
      // Answered before the browser restarts: the dock that asked closes with the window.
      json(res, 200, { ok: true, name: r.name, restarting: !!r.restarting });
      broadcast("session", ownerSession());
      if (saved && picker) { try { broadcast("sessions", picker.state()); } catch {} }
    } },
  ];
}
