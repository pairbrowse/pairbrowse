// The order of tabs as they stand in the browser window (the tab strip), and moving them: for a
// shared session, whose tabs keep the same order in both browsers. Playwright only knows tabs in
// the order they opened, so the side panel extension (its worker) reads and moves them; a tab
// is matched to its page by address, and among same-address tabs by the order they opened.
import { within } from "../util.mjs";

const ASK_MS = 3000;
// A worker that is just starting answers before its script has defined these: such an answer is
// an error, so panel.call asks again rather than taking "undefined" for "no tabs".

// call(fn, arg, timeoutMs): runs fn(arg) in the side panel's worker (panel.mjs).
// strip: in a PairBrowse build with its own pages (no side panel), the tab strip's own report
// instead: { chrome(): whether this browser has them, snapshot(): the strip's last report
// ({ tabs: [{ target, window, index, active }], focused, last }) or null, arrange(targets): asks
// the strip for that order }. There the worker is never asked, and without a report every answer
// is "unknown", quietly.
export function createTabOrder({ call, getContext, log = () => {}, strip = null }) {
  const ownPages = () => !!strip?.chrome?.();
  const targets = new WeakMap(); // page -> its CDP target id (a tab keeps it for its life)
  async function targetOf(page) {
    if (targets.has(page)) return targets.get(page);
    const id = await within(1500, (async () => {
      const cdp = await page.context().newCDPSession(page);
      try { return (await cdp.send("Target.getTargetInfo"))?.targetInfo?.targetId || null; } finally { cdp.detach().catch(() => {}); }
    })().catch(() => null));
    if (typeof id === "string" && id) targets.set(page, id.toUpperCase());
    return targets.get(page) ?? null;
  }
  // From the strip's report: page -> { id: its target, windowId, index, active }.
  async function stripPlaces() {
    const snap = strip.snapshot();
    if (!snap || !Array.isArray(snap.tabs)) return null;
    const byTarget = new Map(snap.tabs.map((t) => [t.target, t]));
    const ctx = await getContext();
    const out = new Map();
    for (const p of ctx.pages()) {
      if (p.isClosed()) continue;
      const t = byTarget.get(await targetOf(p));
      if (t) out.set(p, { id: t.target, windowId: t.window, index: t.index, active: t.active });
    }
    return out;
  }
  // page -> { id, windowId, index }, for the pages that could be matched.
  async function places(ms = ASK_MS) {
    if (ownPages()) return stripPlaces();
    const tabs = await within(ms + 500, call(() => { if (!globalThis.pbTabs) throw new Error("not ready"); return globalThis.pbTabs(); }, null, ms).catch((e) => { log("tab order", e?.message || e); return null; }));
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
    // ms: how long each question to the worker may take.
    async front(ms = ASK_MS) {
      if (ownPages()) {
        const snap = strip.snapshot();
        if (!snap) return null;
        const win = snap.focused !== -1 ? snap.focused : snap.last;
        const tab = snap.tabs.find((t) => t.window === win && t.active);
        if (!tab) return null;
        for (const [page, t] of (await stripPlaces()) || []) if (t.id === tab.target) return page;
        return null;
      }
      const id = await within(ms + 500, call(() => { if (!globalThis.pbFront) throw new Error("not ready"); return globalThis.pbFront(); }, null, ms).catch(() => null));
      if (id === null || id === undefined) return null;
      const at = await places(ms);
      for (const [page, t] of at || []) if (t.id === id) return page;
      return null;
    },
    // Whether the browser window has the system's focus (not minimized, no other app in front):
    // true or false, or null when the side panel's worker can't say (pbFocused, background.js).
    async focused() {
      if (ownPages()) { const snap = strip.snapshot(); return snap ? snap.focused !== -1 : null; }
      const v = await within(ASK_MS + 500, call(() => { if (!globalThis.pbFocused) throw new Error("not ready"); return globalThis.pbFocused(); }, null, ASK_MS).catch(() => null));
      return typeof v === "boolean" ? v : null;
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
      if (ownPages()) { strip.arrange(pages.filter((p) => at.has(p)).map((p) => at.get(p).id)); return true; }
      const ids = pages.filter((p) => at.has(p)).map((p) => at.get(p).id);
      return !!(await within(ASK_MS + 500, call((list) => { if (!globalThis.pbArrange) throw new Error("not ready"); return globalThis.pbArrange(list); }, ids, ASK_MS).catch(() => null)));
    },
    // Tests only (daemon.mjs, PAIRBROWSE_TEST_TAB_ORDER=1). list: the addresses as the strip
    // shows them. move: the tab at url to where the tab at before stands, as dragging it would.
    // The functions passed to call() run in the side panel extension, where chrome is defined.
    /* global chrome */
    async testCommand({ action, url, before } = {}) {
      // The browser's own pages: the strip's report, read only (moves are a person's, by hand).
      if (ownPages()) {
        if (action === "move" || action === "front") return { text: "not in a browser with its own pages", error: true };
        const at = await stripPlaces();
        if (!at) return { text: "no tab order from the strip yet", error: true };
        return { text: JSON.stringify([...at].sort(([, a], [, b]) => (a.windowId - b.windowId) || (a.index - b.index)).map(([p]) => p.url())) };
      }
      if (action === "move") {
        const moved = await call(([u, b]) => chrome.tabs.query({}).then((ts) => {
          const at = (x) => ts.find((t) => (t.url || t.pendingUrl) === x);
          const t = at(u), there = at(b);
          return t && there ? chrome.tabs.move(t.id, { windowId: there.windowId, index: there.index }).then(() => true) : false;
        }), [String(url), String(before)], 15_000);
        return moved ? { text: "moved" } : { text: `no tab at ${url} or ${before}`, error: true };
      }
      // front: the person clicks the tab at url (or, with before: "new", opens a new tab there).
      if (action === "front") {
        const shown = await call(([u, b]) => (b === "new" ? chrome.tabs.create({ url: u, active: true }).then(() => true) : chrome.tabs.query({}).then((ts) => {
          const t = ts.find((x) => (x.url || x.pendingUrl) === u);
          return t ? chrome.tabs.update(t.id, { active: true }).then(() => chrome.windows.update(t.windowId, { focused: true })).then(() => true) : false;
        })), [String(url), String(before ?? "")], 15_000);
        return shown ? { text: "shown" } : { text: `no tab at ${url}`, error: true };
      }
      const tabs = await call(() => { if (!globalThis.pbTabs) throw new Error("not ready"); return globalThis.pbTabs(); }, null, 15_000);
      return { text: JSON.stringify(tabs.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index)).map((t) => t.url)) };
    },
  };
}
