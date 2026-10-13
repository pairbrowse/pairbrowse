import { within } from "../util.mjs";

// Where a tab's picture, sound and recordings are captured: the side panel extension (Chromium
// and the PairBrowse build without its own pages, as before), the browser's own capture page (a
// build with its own pages that declares one, once that page said hello; liveview/capture.mjs),
// or nowhere (a build with its own pages and no capture page yet). Nowhere means: a shared
// browser sends pictures through the join channel (the slower route, no sound) and recording is
// refused; nothing new is captured in its place.
//
// chromePages(): the browser has its own pages. capturePages(): its build declares a capture page.
// panelCall(fn, arg, ms): runs fn(arg) in the extension's worker (daemon/panel.mjs). channel: the
// capture page's channel. env: PAIRBROWSE_TEST_NO_CAPTURE=1 (tests only) makes it nowhere.
export const NO_CAPTURE_RECORD = "Recording isn't available in this PairBrowse browser yet: it needs the browser's capture page, which comes with a later build. Nothing was recorded.";
export const NO_CAPTURE_SHARE = "This PairBrowse browser has no capture page yet: the picture goes through the join channel, without sound.";

export function createCaptureBackend({ chromePages = () => false, capturePages = () => false, panelCall, channel = null, env = process.env }) {
  // "extension", "page", or null (nowhere).
  function kind() {
    if (env.PAIRBROWSE_TEST_NO_CAPTURE === "1") return null;
    if (!chromePages()) return "extension";
    return capturePages() && channel?.ready() ? "page" : null;
  }
  // The tab as the capturer knows it: the extension's tab id (its worker maps the CDP target), or
  // the CDP target id itself for the browser's own capture page.
  // A page whose scripts never pause answers nothing: the session and the question are bounded,
  // and a tab's target id (it never changes) is asked once.
  const targets = new WeakMap(); // page -> its CDP target id
  async function tabRef(page, ms = 4000) {
    let targetId = targets.get(page);
    if (!targetId) {
      targetId = await within(Math.min(ms, 3000), (async () => {
        const cdp = await page.context().newCDPSession(page);
        try { return (await cdp.send("Target.getTargetInfo"))?.targetInfo?.targetId || null; } finally { cdp.detach().catch(() => {}); }
      })());
      if (typeof targetId !== "string" || !targetId) throw new Error("the tab didn't answer");
      targets.set(page, targetId);
    }
    if (kind() === "page") return targetId;
    return panelCall((t) => { if (!globalThis.pbTabId) throw new Error("not ready"); return globalThis.pbTabId(t); }, targetId, ms);
  }
  function share(arg, ms = 8000) {
    if (kind() === "page") return channel.call("share", arg, ms);
    return panelCall((a) => { if (!globalThis.pbShare) throw new Error("not ready"); return globalThis.pbShare(a); }, arg, ms);
  }
  function record(arg, ms = 15_000) {
    if (kind() === "page") return channel.call("record", arg, ms);
    return panelCall((a) => { if (!globalThis.pbRecord) throw new Error("not ready"); return globalThis.pbRecord(a); }, arg, ms);
  }
  return { kind, tabRef, share, record };
}
