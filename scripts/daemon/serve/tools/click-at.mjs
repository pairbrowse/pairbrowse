// pairbrowse_click_at: a click at a spot in the agent's last screenshot (screenshot.mjs clickAt).
import { clickClass } from "../../../rules/clicks.mjs";
import { settle } from "../../page.mjs";
import { SAME_PICTURE, SETTLE_MS, image } from "../result.mjs";
import { agentPicture, coverRects, NOT_COVERED_NOTE } from "../../covers.mjs";

export function createClickAtTool(conn, api) {
  const { closing, config, hud, myLabel, popups, rememberPicture, screenshots } = api;
  const { ownTab, participant, remote } = conn;
  return {
    async pairbrowse_click_at(args) {
      // The adaptive input pace its moves took (rewrite.mjs paceUp), for its result.
      const pace = conn.paceNote ? `\n${conn.paceNote}` : "";
      conn.paceNote = "";
      // A final action the agent names (Pay, Delete, Publish, Send, Submit) goes through
      // browser_click, where the user confirms it (and a publish needs its review).
      const cls = clickClass(args.element);
      if (cls) return { text: `Refused: "${String(args.element).slice(0, 60)}" names a final action (${cls}). Take a browser_snapshot and use browser_click with its ref, so the user confirms it.`, error: true };
      const here = ownTab();
      const r = await screenshots.clickAt(args, participant, { current: here, cursor: (x, y) => hud.cursorTo(here || hud.sparkPage(participant), { boundingBox: async () => ({ x, y, width: 0, height: 0 }) }, "click", myLabel()) });
      if (r.error) return r;
      hud.addActivity(`Clicked ${String(args.element || "a spot").slice(0, 80)}`, myLabel(), r.page);
      await popups.dismissOverlay(r.page, { markOwn: true, ...closing });
      await settle(r.page, SETTLE_MS);
      await popups.dismissOverlay(r.page, { closeOffers: true, ...closing });
      const content = [{ type: "text", text: r.text + pace + popups.drain(r.page) }];
      // A joiner's agent's picture leaves this screen, and a tab handed to the person is theirs
      // (yourturn.mjs masked): card fields covered (result.mjs does the same).
      const veiled = remote || !!api.yourTurn?.masked(r.page);
      const shot = config.screenshots !== false ? await screenshots.take(r.page, participant, { covers: veiled || api.timeline?.enabled ? coverRects : null }) : null;
      const data = shot?.data ? await agentPicture(shot.data, r.page, veiled, { before: shot.before, compose: (d, rects) => api.recorder?.coverPicture?.(d, rects) }) : null;
      if (data === "") content.push({ type: "text", text: NOT_COVERED_NOTE });
      else if (data) { content.push(image(data)); rememberPicture(veiled ? { ...shot, data, covered: true } : shot, r.page, "pairbrowse_click_at", args); }
      else if (shot?.same) content.push({ type: "text", text: SAME_PICTURE });
      return { content };
    },
  };
}
