// The live view's picture: which tab is on screen, its CDP session and screencast, the last frame
// and one sharp still once the page settles, following the tab Claude works in. Its state is one
// explicit object (cast.state) the rest of the live view reads; only this module changes it.
import { keepFocus } from "../focus.mjs";
import { hiddenFromLiveView, isPaymentSettings } from "../../ui/urls.js";
import { FRAME_EVERY_MS } from "../../ui/limits.js";

const SETTLE_MS = 180; // the page is still this long: send one sharp frame
// Frames come as fast as they're acknowledged: at most one every FRAME_EVERY_MS (ui/limits.js; a
// form being filled or a page scrolling reads fine at 30; unpaced, a busy page encodes 60 a second).
const SHARP_QUALITY = 90;

// Shows a tab in its browser window. (document.visibilityState can't tell: Playwright emulates focus.)
export const bringTabForward = (page) => keepFocus(() => page.bringToFront().catch(() => {}));

// Runs tasks one at a time, in order; a failed task doesn't stop the next.
export function serially() {
  let last = Promise.resolve();
  return (task) => {
    const run = last.then(task);
    last = run.catch(() => {});
    return run;
  };
}

// Stops a tab's screencast and gives its window its normal size back.
export async function release(cdp) {
  await cdp.send("Page.stopScreencast").catch(() => {});
  await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await cdp.detach().catch(() => {});
}

// getContext(), currentUrl(): as startLiveView's. personTab(page): a person's own tab. replayer:
// the input replayer (attach, startCast, resetFit). broadcast(event, data), tabsInfo(): the live
// view's. viewers: the streams that show the page; watching(): someone does. isClosed(): the live
// view is closing. log(...): daemon.log. pinned(): the tabs the picture is held to while a hand-off
// viewer watches (spec server-mode B4: a grant's scope, its handed-over tab first), or null.
export function createCast({ getContext, currentUrl, personTab, replayer, broadcast, tabsInfo, viewers, watching, isClosed, log, pinned = () => null }) {
  const state = {
    shown: null, // the tab on screen: { page, cdp }
    lastFrame: null,
    lastFrameFrom: null, // the tab lastFrame came from (guests never get a person's tab's)
    followed: undefined, // URL of the tab Claude is working in
    followedPage: null,
    // Switches in progress: while one runs no tab is shown for a moment, which isn't "nothing
    // shown" (follow() would otherwise pull the viewer back to Claude's tab mid-switch).
    switching: 0,
  };
  const showQueue = serially(); // switching the shown tab: one CDP session at a time

  // Light frames while the page moves (scrolling, animations), then one sharp still at the viewer's
  // real pixel size once it settles, like a remote desktop. Smooth in motion, crisp at rest.
  let settleTimer = null;
  let frameSeq = 0;
  function sharpenSoon(cdp) {
    clearTimeout(settleTimer);
    const seq = frameSeq;
    settleTimer = setTimeout(async () => {
      if (!viewers.size || state.shown?.cdp !== cdp) return; // the sharp still is for the owner's viewers
      try {
        const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: SHARP_QUALITY });
        if (seq !== frameSeq || state.shown?.cdp !== cdp || !state.lastFrame) return; // the page moved again meanwhile
        state.lastFrame = { img: data, w: state.lastFrame.w, h: state.lastFrame.h };
        broadcast("frame", state.lastFrame);
      } catch {}
    }, SETTLE_MS);
  }

  // Shows a tab: its own CDP session and screencast. One switch at a time, so two callers (the
  // follow tick and a tab click) never leave a session behind.
  const wired = new WeakSet(); // tabs whose closing is watched
  let casting = null; // the CDP session whose frames are taken (set before its cast starts)
  const show = (page) => { state.switching++; return showQueue(() => showNow(page)).finally(() => { state.switching--; }); };
  async function showNow(page) {
    // Never the browser's own pages, but the payment methods page the person opened as their own
    // tab ("Add a saved card"): a person's own tab reaches the owner's streams only (guest frames,
    // hand-off viewers and their input never get it).
    if (isClosed() || state.shown?.page === page || (hiddenFromLiveView(page.url()) && !(personTab(page) && isPaymentSettings(page.url())))) return;
    if (state.shown) {
      const old = state.shown.cdp;
      // Switching away from a person's own tab: its last picture goes with it.
      if (personTab(state.shown.page)) { state.lastFrame = null; state.lastFrameFrom = null; }
      state.shown = null;
      casting = null;
      await release(old);
    }
    const cdp = await page.context().newCDPSession(page);
    casting = cdp;
    try {
      let lastAt = 0;
      cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
        // The next frame comes once this one is acknowledged: paced to FRAME_EVERY_MS.
        const wait = Math.max(0, FRAME_EVERY_MS - (Date.now() - lastAt));
        lastAt = Date.now() + wait;
        const ack = () => cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
        if (wait) setTimeout(ack, wait).unref(); else ack();
        // A frame still in flight from a session already released (a switch away): dropped.
        if (casting !== cdp) return;
        frameSeq++;
        state.lastFrame = { img: data, w: metadata.deviceWidth, h: metadata.deviceHeight };
        state.lastFrameFrom = page;
        broadcast("frame", state.lastFrame);
        sharpenSoon(cdp);
      });
      await bringTabForward(page);
      // A clean, browser-like view: no classic scrollbars (scroll with the wheel or trackpad).
      await cdp.send("Emulation.setScrollbarsHidden", { hidden: true }).catch(() => {});
      await replayer.attach(cdp);
      await replayer.startCast(cdp);
    } catch (e) {
      if (casting === cdp) casting = null;
      await release(cdp);
      throw e;
    }
    if (isClosed()) { casting = null; return release(cdp); }
    state.shown = { page, cdp };
    if (!wired.has(page)) {
      wired.add(page);
      page.once("close", () => { if (state.lastFrameFrom === page) { state.lastFrame = null; state.lastFrameFrom = null; } if (state.shown?.page === page) { state.shown = null; casting = null; } if (watching()) follow(); });
    }
    broadcast("tabs", await tabsInfo());
  }

  // Follow the tab Claude is working in, whenever that changes. Between changes, the tab you
  // picked in the viewer stays put. Pinned to a hand-off's tabs, the picture stays on them while
  // the agent's tab changes elsewhere, and comes back to them when what was shown goes away.
  async function follow() {
    try {
      const ctx = await getContext();
      const url = await currentUrl();
      const pin = (pinned() || []).filter((p) => !p.isClosed?.());
      if (pin.length) {
        const stay = state.shown ? pin.includes(state.shown.page) : state.switching > 0;
        // No address recorded: once the pin goes, the next follow() shows the agent's tab again
        // even if its address never changed. The tab list still marks the agent's tab.
        state.followed = undefined;
        const at = url && ctx.pages().find((p) => p.url() === url);
        if (at && !hiddenFromLiveView(at.url())) state.followedPage = at;
        if (!stay) await show(pin[0]);
        return;
      }
      if ((state.shown || state.switching) && url === state.followed) return;
      state.followed = url;
      // The browser's own pages are never shown; followedPage stays the agents' page (a browser
      // page is never listed, so no tab is marked as Claude's).
      const at = ctx.pages().find((p) => p.url() === url);
      const page = (at && !hiddenFromLiveView(at.url()) ? at : null) || state.shown?.page || ctx.pages().filter((p) => !hiddenFromLiveView(p.url()) && !personTab(p)).at(-1);
      if (url) state.followedPage = at || page;
      if (page) await show(page);
    } catch (e) {
      log("liveview follow", e?.message || e);
    }
  }

  // Nobody watching: stop the page streams and give the real window its normal size back.
  function stopIfIdle() {
    if (watching() || !state.shown) return;
    showQueue(async () => {
      if (watching() || !state.shown) return;
      const { cdp } = state.shown;
      state.shown = null;
      casting = null;
      state.followed = undefined;
      replayer.resetFit();
      await release(cdp);
    });
  }

  // The live view closes: no sharp still pending, the shown tab's session released.
  function close() {
    clearTimeout(settleTimer);
    if (state.shown) { release(state.shown.cdp); state.shown = null; }
  }

  return { state, show, follow, stopIfIdle, close };
}
