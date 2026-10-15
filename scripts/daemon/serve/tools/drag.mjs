// browser_drag, run by PairBrowse itself (daemon/drag.mjs).
import { isRef } from "../../../policy.mjs";
import { dragBetween, reason as dragReason } from "../../drag.mjs";
import { settle } from "../../page.mjs";
import { CLICK_SETTLE_MS } from "../result.mjs";

export function createDragTool(conn, api) {
  const { host, hud, internal, myLabel, pause, presence, serverPage } = api;
  const { participant } = conn;
  return {
    // browser_drag: press on the first element, a short move that starts the drag, steps across
    // to the second, let go (daemon/drag.mjs). The guard's rules ran first (refusal): a drag
    // named as a final action at either end asked the user. The result carries a fresh snapshot,
    // as Playwright's would.
    async browser_drag(args) {
      const page = conn.actingIn || await serverPage();
      if (!page) return { text: "No page open to drag in.", error: true };
      const named = (el, target) => String(el || target || "").slice(0, 80);
      const what = `**${named(args.startElement, args.startTarget)}** to **${named(args.endElement, args.endTarget)}**`;
      const locate = (t) => { if (typeof t !== "string" || !t) return null; try { return page.locator(isRef(t) ? `aria-ref=${t}` : t).first(); } catch { return null; } };
      const from = locate(args.startTarget), to = locate(args.endTarget);
      if (!from || !to) return { text: "browser_drag takes startTarget and endTarget: refs from a browser_snapshot (or selectors), with startElement and endElement saying what they are.", error: true };
      hud.addActivity(`Dragging ${what}`, myLabel(), page);
      try {
        await dragBetween(page, from, to, {
          cursor: (el, act) => hud.cursorTo(page, el, act, myLabel()),
          interrupted: () => { const held = pause.heldFor(participant); if (held.paused) return `Paused by ${held.by} mid-drag: let go where it was.`; const who = presence.actingIn(page); return who ? `${who === host ? "The user" : who} took over this tab mid-drag: let go where it was.` : ""; },
        });
      } catch (e) {
        const why = dragReason(e);
        hud.addActivity(`That didn't work: ${why}`, myLabel(), page);
        return { text: `Couldn't drag ${what.replace(/\*\*/g, "")}: ${why}. Look at the screenshot, take a browser_snapshot, then try again.`, error: true, url: page.url() };
      }
      hud.addActivity(`Dragged ${what}`, myLabel(), page);
      await settle(page, CLICK_SETTLE_MS).catch(() => {});
      const snap = ((await internal("browser_snapshot", {})).result?.content || []).map((c) => c.text || "").join("\n");
      return { text: `Dragged ${what.replace(/\*\*/g, "")}. Check the picture: the card or item should be where you meant it.\n${snap}`, url: page.url() };
    },
  };
}
