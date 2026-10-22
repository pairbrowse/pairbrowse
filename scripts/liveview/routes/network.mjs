// The Network section's routes on the owner's port (spec server-mode C14): the owner only (the
// "network" right: no invite link, joiner, hand-off grant or agent has it), each write from a
// same-origin page or the browser's own pages, as every owner write (liveview.mjs). startLiveView
// mounts them.
//   GET network.json: the summary (net/settings.mjs networkSummary): proxies with whether their
//     username and password are saved (never the values), the default, each session's choice.
//   POST network { op: "add" | "edit" | "remove" | "default" | "session", ... }: one change,
//     written to config.json's network and secrets.env; 200 { text, network } and a network
//     event with the summary to the owner's streams, or 409 { error }, nothing written.
//   POST network { op: "forget", id } | { op: "clear-recent" }: the recently removed list only
//     (a removed proxy's name, type, host, port and auth, kept to add again; never a credential),
//     config.json untouched; answered and broadcast as a change.
//   POST network { op: "test", ... }: the Test (liveview/network.mjs): 200 { verdict, reason,
//     exit, sameAsDirect, coherence, locale, note } or 409 { error }; no event.
// A credential is in no answer, event or log line.
import { json, readJsonBody, BODY_MAX } from "../http.mjs";

// network: the helper's part (liveview/network.mjs createNetworkSettings), or null (404).
export function createNetworkRoutes({ network, broadcast }) {
  return [
    { method: "GET", path: "network.json", right: "network", needs: () => network, handler: ({ res }) => json(res, 200, network.read()) },
    { method: "POST", path: "network", right: "network", needs: () => network, handler: async ({ req, res }) => {
      const op = await readJsonBody(req, res, BODY_MAX.profile, { object: true });
      if (op === undefined) return;
      if (op.op === "test") {
        const r = await network.test(op);
        return json(res, r.error ? 409 : 200, r);
      }
      const r = network.write(op);
      if (r.error) return json(res, 409, { error: r.error });
      broadcast("network", r.network);
      json(res, 200, r);
    } },
  ];
}
