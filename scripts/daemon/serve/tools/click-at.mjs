// pairbrowse_click_at: a click at a spot in the agent's last screenshot (screenshot.mjs clickAt).
import { clickClass } from "../../../rules/clicks.mjs";
import { settle } from "../../page.mjs";
import { SAME_PICTURE, SETTLE_MS, image } from "../result.mjs";

export function createClickAtTool(conn, api) {
  const { closing, config, hud, myLabel, popups, rememberPicture, screenshots } = api;
  const { ownTab, participant } = conn;
  return {
    async pairbrowse_click_at(args) {
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
      const content = [{ type: "text", text: r.text + popups.drain(r.page) }];
      const shot = config.screenshots !== false ? await screenshots.take(r.page, participant) : null;
      if (shot?.data) { content.push(image(shot.data)); rememberPicture(shot, r.page, "pairbrowse_click_at", args); }
      else if (shot?.same) content.push({ type: "text", text: SAME_PICTURE });
      return { content };
    },
  };
}
