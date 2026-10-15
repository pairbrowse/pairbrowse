// pairbrowse_status: what the agent says it is doing, in the side panels, the docks and the badge
// in every tab (bounded per tab), and the goal log.
import { within } from "../../../util.mjs";

const BADGE_MS = 4000; // pairbrowse_status waits this long at most for the badge in every tab

export function createStatusTool(conn, api) {
  const { context, hud, journal, myLabel, session } = api;
  const { participant } = conn;
  return {
    async pairbrowse_status(args) {
      await context.getContext();
      // The side panels and docks (session) and the badge in the tabs (hud) say the same. The
      // badge goes to every tab: bounded, so one frozen tab never holds this agent (nor the
      // others behind the shared queue).
      session.setStatus(participant, args.text, args.kind); // the side panels in a shared session show it
      await within(BADGE_MS, hud.setBadgeFor(participant, args.text, args.kind, myLabel()).catch(() => {}));
      if (args.kind === "done" || args.kind === "clear") await within(BADGE_MS, Promise.resolve(hud.hideCursor(hud.sparkPage(participant))).catch(() => {}));
      journal.status(args.kind, args.text); // a hand-off goes to the goal log's yourTurn
      return { text: "ok" };
    },
  };
}
