// The browser's tabs: finding them, the tab cap, what watches each page, the saved tabs coming
// back (and which page each tab came back as), and a file opened in a tab of the person's own.
// st: the browser's state (browser/state.mjs); api: the other parts' functions, read when called.
import { computerName } from "../../sharing/join.mjs";
import { keepFocus } from "../../focus.mjs";
import { readSavedTabs, trackTabs, restoreTabs } from "../../tabs.mjs";
import { recordPerson, tabsFile } from "../../sessions.mjs";
import { within } from "../../util.mjs";
import { isBrowserPage } from "../../../ui/urls.js";

const TRIM_EVERY_MS = 60_000;
const KEEP_ENTRIES = 200;
// Playwright MCP listens to every request of every tab for its network tools, which PairBrowse
// doesn't offer. While anything listens, Playwright mirrors each request into this process and
// keeps it until the tab closes: about a third of a megabyte per action, for good. Drop those
// listeners (MCP adds its own short-lived ones while an action waits for the network).
const NETWORK_EVENTS = ["request", "response", "requestfailed", "requestfinished"];

export function stopRequestMirroring(page) {
  setTimeout(() => {
    for (const event of NETWORK_EVENTS) for (const fn of page.listeners(event)) page.off(event, fn);
  }, 1500).unref?.();
}

export function createTabs(st, deps, api) {
  const { config, hostNote, hud, log, onTabClosed, personTabs, popups, presence, status } = deps;
  const focusing = (own, change) => (own ? change() : keepFocus(change));

  const findPage = (ctx, url) => ctx.pages().find((p) => p.url() === url);

  // The open tabs, without starting the browser.
  const openPages = async () => (st.contextPromise ? (await st.contextPromise.catch(() => null))?.pages() || [] : []);

  // The tab showing url, else the last one; null while the browser is closed.
  async function pageAt(url) {
    if (!st.contextPromise) return null;
    const ctx = await api.getContext();
    return findPage(ctx, url) || ctx.pages().findLast((p) => !isBrowserPage(p.url()) && !personTabs.has(p)) || null;
  }

  // Playwright MCP keeps every network request and page event of each tab until it navigates or
  // snapshots that tab itself; busy background tabs (video, news, ads) grow those lists for good.
  // PairBrowse offers no network tools, so keep only the latest of each. (Its own per-tab object,
  // found defensively: if a runtime update changes it, nothing is touched.)
  setInterval(async () => {
    for (const page of await openPages()) {
      stopRequestMirroring(page); // a newly connected session's server adds its listeners again
      const sym = Object.getOwnPropertySymbols(page).find((x) => x.description === "tabSymbol");
      const tab = sym && page[sym];
      for (const key of ["_requests", "_recentEventEntries"]) {
        const list = tab?.[key];
        if (Array.isArray(list) && list.length > KEEP_ENTRIES) list.splice(0, list.length - KEEP_ENTRIES);
      }
    }
  }, TRIM_EVERY_MS).unref();

  // At most config.maxTabs tabs (20): when one more opens, the one used longest ago closes.
  // "Used" means an agent acted in it or a person clicked, typed or scrolled in it. Never the tab
  // Claude is in, one that just opened, or one anyone used in the last minutes (in a shared
  // session that could be another agent's or person's tab): then more tabs stay open. Claude is
  // told which tab went.
  // Read at each check: Settings can change it while the browser runs.
  const maxTabs = () => Math.max(2, Number(config.maxTabs) || 20);
  const IN_USE_MS = 10 * 60_000;
  const lastUsed = new WeakMap();
  const touch = (page) => page && lastUsed.set(page, Date.now());

  async function capTabs(ctx, keep = null) {
    if (st.restoring) return; // tabs coming back after a restart: decide once they're all open
    const pages = ctx.pages().filter((p) => !p.isClosed() && /^(https?:|about:blank)/.test(p.url()));
    const MAX_TABS = maxTabs();
    if (pages.length <= MAX_TABS) return;
    const current = findPage(ctx, st.lastCurrentUrl);
    const idleSince = Date.now() - IN_USE_MS;
    const candidates = pages.filter((p) => p !== keep && p !== current && (lastUsed.get(p) || 0) < idleSince).sort((a, b) => (lastUsed.get(a) || 0) - (lastUsed.get(b) || 0));
    for (const p of candidates.slice(0, pages.length - MAX_TABS)) {
      const url = p.url();
      await p.close({ runBeforeUnload: false }).catch(() => {});
      hostNote(`Closed an old tab to keep ${MAX_TABS} open: ${url.slice(0, 120)}. Tab numbers changed: use browser_tabs list.`);
      log(`closed old tab ${url}`);
    }
  }

  // Everything that watches a page, for the tabs there at launch and each new one.
  function adopt(page, ctx, { opened = false } = {}) {
    // No badge or bar is drawn into the browser's own pages.
    page.on("domcontentloaded", () => { if (!isBrowserPage(page.url())) hud.onPageLoad(page); });
    popups.watchPage(page, ctx);
    api.keepDownloads(page);
    presence.watchUser(page, { opened });
    stopRequestMirroring(page);
    page.once("close", () => onTabClosed(page)); // a closed tab's turn ends with it
    touch(page);
  }

  // screen: the tab that shows "Opening tabs" (default: the first one).
  // A tab's identity across a browser restart (a session switch, a rename): its place in its
  // session's last save. Before the browser closes, each saved page is noted with that place
  // (placeOf); as the session's tabs come back, each new page takes the place's (successors), so an
  // agent's tab is the same tab when its session comes back, never another one on the same address.
  const successors = new WeakMap(); // old page -> the page that tab came back as
  const comingBack = new Map(); // `${session}|${i}` -> [old pages]

  function notePlaces() {
    if (!st.tabTracker?.indexOf || !st.contextPromise) return;
    return st.contextPromise.then((ctx) => {
      for (const p of ctx.pages()) {
        const i = st.tabTracker.indexOf(p);
        if (i < 0) continue;
        const k = `${st.session}|${i}`;
        comingBack.set(k, [...(comingBack.get(k) || []).filter((x) => x !== p), p].slice(-8));
      }
    }).catch(() => {});
  }

  const successorOf = (page) => { let p = page; for (let n = 0; p && n < 8 && successors.has(p); n++) p = successors.get(p); return p && p !== page && !p.isClosed() ? p : null; };

  function restore(ctx, screen = null, { own = false } = {}) {
    recordPerson(st.session, { who: "You", computer: computerName(), kind: "you" }); // the session is in use now
    const saved = readSavedTabs(tabsFile(st.session));
    const restoredSession = st.session;
    // Nothing is written while the saved tabs come back (a stop or a crash meanwhile keeps the whole list).
    let tracker = null;
    tracker = st.tabTracker = trackTabs(ctx, { file: tabsFile(st.session), activePage: () => findPage(ctx, st.lastCurrentUrl), log, holding: () => st.restoring !== null && st.tabTracker === tracker });
    if (!saved.tabs.length) { screen?.close().catch(() => {}); return; }
    st.restoredActiveUrl = saved.tabs[saved.active]?.url || null;
    const restoreAt = Date.now();
    st.restoring = focusing(own, () => restoreTabs(ctx, saved, {
      log, screen,
      // A build with its own pages: no "Opening tabs" list (setContent fails on its new tab page,
      // and the strip shows the progress); its untouched start tab closes after (plans/555 D1.4).
      list: !st.ownPages,
      // Progress shows in the live view and side panel only (never as a badge in the pages),
      // and only when there's more than one tab to bring back.
      onProgress: (n, total) => { if (total > 1) status({ text: `Opening tabs ${n} of ${total}`, kind: "claude" }); },
      onPage: (i, page) => { for (const old of comingBack.get(`${restoredSession}|${i}`) || []) successors.set(old, page); comingBack.delete(`${restoredSession}|${i}`); },
    }).catch((e) => log("restore failed", e?.message || e)).finally(() => {
      status(hud.badge());
      st.restoring = null;
      log(`restored ${saved.tabs.length} tabs`);
      log(`launch: restore ${Date.now() - restoreAt} ms`);
      capTabs(ctx).catch(() => {});
    }));
  }

  // The tab the user was on before a restart, once (then null): the first action starts there.
  function takeRestoredActive() {
    const url = st.restoredActiveUrl;
    st.restoredActiveUrl = null;
    return url;
  }

  // A file the person opened from Downloads, in a new active tab that is theirs for its whole
  // life (personTabs): no agent reads or acts in it. onClose(): called once the tab closes.
  // Resolves { ok: true, page } or { error }; never throws.
  const NO_TAB = "The file couldn't be shown in a tab.";

  async function openForPerson(url, { onClose } = {}) {
    if (!st.contextPromise || st.switching || st.pick.state === "showing") return { error: "The browser isn't open, so the file can't be shown in a tab." };
    const ctx = await within(5000, api.getContext().catch(() => null));
    const page = ctx ? await within(5000, keepFocus(() => ctx.newPage()).catch(() => null)) : null;
    if (!page) return { error: NO_TAB };
    personTabs.add(page);
    page.once("close", () => {
      personTabs.delete(page);
      try { onClose?.(); } catch {}
    });
    const ok = await within(10_000, page.goto(url, { waitUntil: "commit" }).then(() => true, () => false));
    if (ok !== true) {
      await within(3000, page.close({ runBeforeUnload: false }).catch(() => {}));
      return { error: NO_TAB };
    }
    await within(3000, keepFocus(() => page.bringToFront()).catch(() => {}));
    return { ok: true, page };
  }

  return { focusing, findPage, openPages, pageAt, touch, capTabs, adopt, notePlaces, successorOf, restore, takeRestoredActive, openForPerson };
}
