// The order of tabs as they stand in the browser window (the tab strip), and moving them: for a
// shared session, whose tabs keep the same order in both browsers. Playwright only knows tabs in
// the order they opened, so the side panel extension (its worker) reads and moves them; a tab
// is matched to its page by address, and among same-address tabs by the order they opened.
import { within } from "../util.mjs";

const ASK_MS = 3000;
// A worker that is just starting answers before its script has defined these: such an answer is
// an error, so panel.call asks again rather than taking "undefined" for "no tabs".

// call(fn, arg, timeoutMs): runs fn(arg) in the side panel's worker (panel.mjs).
export function createTabOrder({ call, getContext, log = () => {} }) {
  // page -> { id, windowId, index }, for the pages that could be matched.
  async function places() {
    const tabs = await within(ASK_MS + 500, call(() => { if (!globalThis.pbTabs) throw new Error("not ready"); return globalThis.pbTabs(); }, null, ASK_MS).catch((e) => { log("tab order", e?.message || e); return null; }));
    if (!Array.isArray(tabs)) return null;
    const ctx = await getContext();
    const pagesBy = new Map(), tabsBy = new Map();
    for (const p of ctx.pages()) if (!p.isClosed()) pagesBy.set(p.url(), [...(pagesBy.get(p.url()) || []), p]);
    for (const t of [...tabs].sort((a, b) => a.id - b.id)) tabsBy.set(t.url, [...(tabsBy.get(t.url) || []), t]);
    const out = new Map();
    for (const [url, pages] of pagesBy) {
      const list = tabsBy.get(url) || [];
      if (list.length !== pages.length) continue; // can't tell them apart: left where they are
      pages.forEach((p, i) => out.set(p, list[i]));
    }
    return out;
  }
  return {
    // The page in front (the active tab of the window last focused), or null when it can't be told.
    async front() {
      const id = await within(ASK_MS + 500, call(() => { if (!globalThis.pbFront) throw new Error("not ready"); return globalThis.pbFront(); }, null, ASK_MS).catch(() => null));
      if (id === null || id === undefined) return null;
      const at = await places();
      for (const [page, t] of at || []) if (t.id === id) return page;
      return null;
    },
    // The given pages in the order they stand (window, then position); null when unknown.
    async order(pages) {
      const at = await places();
      if (!at || pages.some((p) => !at.has(p))) return null;
      return [...pages].sort((a, b) => (at.get(a).windowId - at.get(b).windowId) || (at.get(a).index - at.get(b).index));
    },
    // The given pages as the tab strip shows them; ones that can't be matched keep their place
    // after the rest. null when the strip can't be read (the host then sends the open order).
    async strip(pages) {
      const at = await places();
      if (!at) return null;
      const known = pages.filter((p) => at.has(p)), rest = pages.filter((p) => !at.has(p));
      return [...known.sort((a, b) => (at.get(a).windowId - at.get(b).windowId) || (at.get(a).index - at.get(b).index)), ...rest];
    },
    // Puts the given pages in this order, in the places they hold now.
    async arrange(pages) {
      const at = await places();
      if (!at) return false;
      const ids = pages.filter((p) => at.has(p)).map((p) => at.get(p).id);
      return !!(await within(ASK_MS + 500, call((list) => { if (!globalThis.pbArrange) throw new Error("not ready"); return globalThis.pbArrange(list); }, ids, ASK_MS).catch(() => null)));
    },
    // Tests only (daemon.mjs, PAIRBROWSE_TEST_TAB_ORDER=1). list: the addresses as the strip
    // shows them. move: the tab at url to where the tab at before stands, as dragging it would.
    // The functions passed to call() run in the side panel extension, where chrome is defined.
    /* global chrome */
    async testCommand({ action, url, before } = {}) {
      if (action === "move") {
        const moved = await call(([u, b]) => chrome.tabs.query({}).then((ts) => {
          const at = (x) => ts.find((t) => (t.url || t.pendingUrl) === x);
          const t = at(u), there = at(b);
          return t && there ? chrome.tabs.move(t.id, { windowId: there.windowId, index: there.index }).then(() => true) : false;
        }), [String(url), String(before)], 15_000);
        return moved ? { text: "moved" } : { text: `no tab at ${url} or ${before}`, error: true };
      }
      const tabs = await call(() => { if (!globalThis.pbTabs) throw new Error("not ready"); return globalThis.pbTabs(); }, null, 15_000);
      return { text: JSON.stringify(tabs.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index)).map((t) => t.url)) };
    },
  };
}
