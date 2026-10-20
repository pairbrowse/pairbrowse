// browser_wait_for, run by PairBrowse itself.
import { sleep, within } from "../../../util.mjs";

const WAIT_FOR_MS = 8000; // browser_wait_for: how long text gets to appear or go

// What the wait says when the hand-off it waited on ended (spec server-mode B15): at its expiry, stop
// (the person didn't finish; yourturn.mjs TIMEOUT_NOTE); otherwise look before going on.
export function endedLine({ id, reason }) {
  if (reason === "expired") return `The hand-off ${id} timed out: nobody finished the step in time. Stop here, tell the user where you are, and don't retry the step or work around it.`;
  return `The hand-off ${id} ended (${reason}). Take a browser_snapshot to see what the person did before you go on; Done is only a hint.`;
}

export function createWaitForTool(conn, api) {
  const { context, serverPage, yourTurn = null } = api;
  const { disconnected, participant } = conn;
  return {
    // browser_wait_for, looking in the page and its frames (a consent wall or a sign-in box
    // often lives in one; Playwright's own looks at the page alone, so a wall "was gone" while
    // it stood). Bounded: time at most 120 s, text at most WAIT_FOR_MS. With a hand-off open and
    // nothing named (no time, no text), it waits for that hand-off, as long as time 120 would.
    async browser_wait_for(args) {
      const page = conn.actingIn || await serverPage();
      if (!page) return { text: "No page open to wait on.", error: true };
      let time = args.time === undefined ? 0 : Math.min(120, Math.max(0, Number(args.time) || 0));
      // The wait ends with the browser (closed, or reset by the turn cap) or the agent leaving:
      // it never holds the shared queue after that.
      let unwatch = () => {};
      const over = new Promise((resolve) => { unwatch = context.watchClose(() => resolve("closed")); disconnected.signal.addEventListener("abort", () => resolve("left"), { once: true }); });
      const ended = () => (page.isClosed() ? { text: "The tab closed while waiting. browser_tabs list shows what's open.", error: true } : null);
      // A hand-off the agent waits on (its own, or one covering this tab): the wait ends with it.
      const turn = yourTurn?.ended?.(page, participant) || null;
      const handed = turn ? turn.then((e) => ({ turn: e })) : null;
      // Settled while text is looked for: the text loops stop there too.
      let settled = null;
      handed?.then((w) => { settled = w.turn; }, () => {});
      const started = Date.now();
      const endedNow = () => ({ text: `Waited ${Math.round((Date.now() - started) / 100) / 10} s. ${endedLine(settled)}`, error: settled.reason === "expired", url: page.isClosed() ? undefined : page.url() });
      const named = (typeof args.text === "string" && args.text) || (typeof args.textGone === "string" && args.textGone);
      if (handed && args.time === undefined && !named) time = 120;
      let timer = null;
      try {
        if (time) {
          // Cleared once the wait ends otherwise: no timer left behind for up to 120 s.
          const slept = new Promise((resolve) => { timer = setTimeout(() => resolve("ok"), time * 1000); });
          const w = await Promise.race([slept, over, ...(handed ? [handed] : [])]);
          if (w === "closed") return { text: "The browser closed while waiting.", error: true };
          if (w === "left") return { text: "Stopped waiting.", error: true };
          if (w?.turn) { settled = w.turn; return endedNow(); }
        }
        const want = typeof args.text === "string" && args.text ? args.text : null;
        const gone = typeof args.textGone === "string" && args.textGone ? args.textGone : null;
        const seen = async (t) => {
          for (const f of page.frames()) if (await within(500, f.getByText(t).first().isVisible()).catch(() => false)) return true;
          return false;
        };
        const deadline = Date.now() + WAIT_FOR_MS;
        const found = [];
        if (gone) {
          while (!ended() && !settled && !disconnected.signal.aborted && await seen(gone)) {
            if (Date.now() > deadline) return { text: `"${gone.slice(0, 80)}" is still on the page after ${WAIT_FOR_MS / 1000} s (in the page or one of its frames). Look at the screenshot: a dialog or banner has its own buttons (browser_find finds them).`, error: true, url: page.url() };
            await sleep(150);
          }
          if (ended()) return ended();
          if (settled) return endedNow();
          found.push(`"${gone.slice(0, 80)}" is gone`);
        }
        if (want) {
          while (!ended() && !settled && !disconnected.signal.aborted && !(await seen(want))) {
            if (Date.now() > deadline) return { text: `Didn't see "${want.slice(0, 80)}" within ${WAIT_FOR_MS / 1000} s (looked in the page and its frames). Take a browser_snapshot to see what's there.`, error: true, url: page.url() };
            await sleep(150);
          }
          if (ended()) return ended();
          if (settled) return endedNow();
          found.push(`"${want.slice(0, 80)}" is on the page`);
        }
        return { text: `Waited${time ? ` ${time} s` : ""}${found.length ? `${time ? ";" : ":"} ${found.join("; ")}` : ""}.`, url: page.url() };
      } finally {
        clearTimeout(timer);
        unwatch();
      }
    },
  };
}
