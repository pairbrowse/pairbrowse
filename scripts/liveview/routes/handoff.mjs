// The Handoff page's routes on the owner's port (Settings, view=handoff; daemon/phonelink.mjs):
// the owner only (the "handoff" right: the owner's key and the browser's own pages' key; no invite
// link, joiner, hand-off grant or agent has it), each write from a same-origin page or the
// browser's own pages, as every owner write (liveview.mjs). startLiveView mounts them.
//   GET handoff.json: the summary { on, server, ready, send: { approvals, checks, submits, runs },
//     answer, telegram: { state: "none" | "pending" | "linked", bot, chat, code?, expiresAt?, error? },
//     discord: { same } }: never a token, a chat id or a user id.
//   POST handoff { op: "link", app, token? } | { op: "cancel", app } | { op: "unlink", app } |
//     { op: "test", app } | { op: "set", answer?, send? }: 200 { text, handoff } and a handoff
//     event with the summary to the owner's streams, or 409 { error }.
// A token is in no answer, event or log line.
import { json, readJsonBody, BODY_MAX } from "../http.mjs";

// handoff: the helper's part (daemon/phonelink.mjs createPhoneLink), or null (404).
export function createHandoffRoutes({ handoff, broadcast }) {
  return [
    { method: "GET", path: "handoff.json", right: "handoff", needs: () => handoff, handler: ({ res }) => json(res, 200, handoff.read()) },
    { method: "POST", path: "handoff", right: "handoff", needs: () => handoff, handler: async ({ req, res }) => {
      const op = await readJsonBody(req, res, BODY_MAX.profile, { object: true });
      if (op === undefined) return;
      const r = await handoff.op(op);
      if (r.error) return json(res, 409, { error: r.error });
      broadcast("handoff", r.handoff);
      json(res, 200, r);
    } },
  ];
}
