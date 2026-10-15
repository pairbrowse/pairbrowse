// browser_wait_for, run by PairBrowse itself.
import { sleep, within } from "../../../util.mjs";

const WAIT_FOR_MS = 8000; // browser_wait_for: how long text gets to appear or go

export function createWaitForTool(conn, api) {
  const { context, serverPage } = api;
  const { disconnected } = conn;
  return {
    // browser_wait_for, looking in the page and its frames (a consent wall or a sign-in box
    // often lives in one; Playwright's own looks at the page alone, so a wall "was gone" while
    // it stood). Bounded: time at most 120 s, text at most WAIT_FOR_MS.
    async browser_wait_for(args) {
      const page = conn.actingIn || await serverPage();
      if (!page) return { text: "No page open to wait on.", error: true };
      const time = args.time === undefined ? 0 : Math.min(120, Math.max(0, Number(args.time) || 0));
      // The wait ends with the browser (closed, or reset by the turn cap) or the agent leaving:
      // it never holds the shared queue after that.
      let unwatch = () => {};
      const over = new Promise((resolve) => { unwatch = context.watchClose(() => resolve("closed")); disconnected.signal.addEventListener("abort", () => resolve("left"), { once: true }); });
      const ended = () => (page.isClosed() ? { text: "The tab closed while waiting. browser_tabs list shows what's open.", error: true } : null);
      try {
        if (time) { const w = await Promise.race([sleep(time * 1000).then(() => "ok"), over]); if (w === "closed") return { text: "The browser closed while waiting.", error: true }; if (w === "left") return { text: "Stopped waiting.", error: true }; }
        const want = typeof args.text === "string" && args.text ? args.text : null;
        const gone = typeof args.textGone === "string" && args.textGone ? args.textGone : null;
        const seen = async (t) => {
          for (const f of page.frames()) if (await within(500, f.getByText(t).first().isVisible()).catch(() => false)) return true;
          return false;
        };
        const deadline = Date.now() + WAIT_FOR_MS;
        const found = [];
        if (gone) {
          while (!ended() && !disconnected.signal.aborted && await seen(gone)) {
            if (Date.now() > deadline) return { text: `"${gone.slice(0, 80)}" is still on the page after ${WAIT_FOR_MS / 1000} s (in the page or one of its frames). Look at the screenshot: a dialog or banner has its own buttons (browser_find finds them).`, error: true, url: page.url() };
            await sleep(150);
          }
          if (ended()) return ended();
          found.push(`"${gone.slice(0, 80)}" is gone`);
        }
        if (want) {
          while (!ended() && !disconnected.signal.aborted && !(await seen(want))) {
            if (Date.now() > deadline) return { text: `Didn't see "${want.slice(0, 80)}" within ${WAIT_FOR_MS / 1000} s (looked in the page and its frames). Take a browser_snapshot to see what's there.`, error: true, url: page.url() };
            await sleep(150);
          }
          if (ended()) return ended();
          found.push(`"${want.slice(0, 80)}" is on the page`);
        }
        return { text: `Waited${time ? ` ${time} s` : ""}${found.length ? `${time ? ";" : ":"} ${found.join("; ")}` : ""}.`, url: page.url() };
      } finally {
        unwatch();
      }
    },
  };
}
