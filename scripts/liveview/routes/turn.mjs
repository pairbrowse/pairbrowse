// A hand-off grant's own routes on the owner's port (spec server-mode B3, B4): the landing page's
// "Take over" (role redeem), Done and switching among the grant's tabs (role turn, right "turn"),
// "Fill saved card" in a saved-card session (role turn, B12), and calling a hand-off off from the
// Tools tab (the owner, right "tools"). The landing page itself
// is GET "" (routes/viewer.mjs hands role redeem to liveview/grants.mjs). startLiveView mounts them.
import { json, plain, readJsonBody, BODY_MAX } from "../http.mjs";

const GRANT_ID = /^[0-9a-f]{8}$/;
const TAB_ID = /^[0-9a-f]{8}$/;

// gate: the live view's grant gate (liveview/grants.mjs createTurnGate).
export function createTurnRoutes(gate) {
  const body = (req, res) => readJsonBody(req, res, BODY_MAX.approve, { object: true });
  return [
    // The tap on "Take over": the redeem key is used up once and the answer names the viewer's
    // address ({ view: "/<viewKey>/" }); a key used already, ended or unknown is 404 alike.
    { method: "POST", path: "redeem", right: "page", needs: () => gate.on, handler: ({ req, res, role }) => (role === "redeem" ? gate.redeem(req, res) : plain(res, 404)) },
    // Done: the person finished the step; the grant ends ("done") and its stream hears turn-ended.
    { method: "POST", path: "turn-done", right: "turn", needs: () => gate.on, handler: async ({ req, res, invite }) => {
      if ((await body(req, res)) === undefined) return;
      gate.end(invite, "done");
      json(res, 200, { ok: true });
    } },
    // { show: tabId }: another of the grant's tabs on screen (a sign-in pop-up); never one outside it.
    { method: "POST", path: "turn", right: "turn", needs: () => gate.on, handler: async ({ req, res, invite }) => {
      const op = await body(req, res);
      if (op === undefined) return;
      if (typeof op.show !== "string" || !TAB_ID.test(op.show)) return json(res, 409, { error: "show is a tab's id, as the turn event lists it." });
      await gate.showTab(res, invite, op.show);
    } },
    // "Fill saved card" (B12): the person's own ArrowDown and Enter in the focused card number field
    // of the tab on screen, so the browser's autofill picks the saved card (liveview/grants.mjs).
    { method: "POST", path: "turn-fill-card", right: "turn", needs: () => gate.on, handler: async ({ req, res, invite }) => {
      if ((await body(req, res)) === undefined) return;
      await gate.fillCard(res, invite);
    } },
    // { id }: the owner calls a hand-off off (the Tools tab); it ends "revoked".
    { method: "POST", path: "turn-revoke", right: "tools", needs: () => gate.on, handler: async ({ req, res }) => {
      const op = await body(req, res);
      if (op === undefined) return;
      if (typeof op.id !== "string" || !GRANT_ID.test(op.id)) return json(res, 409, { error: "id is a hand-off's id." });
      if (!gate.end(op.id, "revoked")) return json(res, 404, { error: "No such hand-off (it may have ended already). Reload the list of hand-offs." });
      json(res, 200, { ok: true });
    } },
  ];
}
