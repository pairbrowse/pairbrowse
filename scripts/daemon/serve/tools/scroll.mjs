// pairbrowse_scroll: a smooth scroll of the agent's tab, as fast mode's scroll step.
import { paths } from "../../../paths.mjs";
import { preflight, runSteps } from "../../../runner.mjs";
import { within } from "../../../util.mjs";

export function createScrollTool(conn, api) {
  const { hud, myLabel, serverPage } = api;
  const { disconnected } = conn;
  return {
    async pairbrowse_scroll(args) {
      // The adaptive input pace (rewrite.mjs paceUp), taken before any refusal so none is left
      // for the next call.
      const pace = conn.paceNote ? ` ${conn.paceNote}` : "";
      conn.paceNote = "";
      const step = { scroll: args.pixels ?? args.direction ?? "down" };
      const problem = preflight([step], paths.uploads);
      if (problem) return { text: problem.replace(/^Step 1 \(scroll\): /, ""), error: true };
      const page = await serverPage();
      if (!page) return { text: "No page open to scroll.", error: true };
      const r = await runSteps(page, [step], { smooth: true, signal: disconnected.signal,
        cursor: (el, act) => hud.cursorTo(page, el, act, myLabel()), activity: (text) => hud.addActivity(text, myLabel(), page) });
      return r.ok === false ? { text: r.why, error: true } : { text: `Scrolled.${pace} ${(await within(2000, page.evaluate(() => `Now ${Math.min(Math.round(scrollY), Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)))} of ${Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight))} px down.`).catch(() => ""))) ?? ""}`, url: page.url() };
    },
  };
}
