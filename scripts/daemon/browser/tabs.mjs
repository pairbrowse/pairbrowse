// The browser's tabs: finding them, the tab cap, what watches each page, the saved tabs coming
// back (and which page each tab came back as), and a file opened in a tab of the person's own.
// st: the browser's state (browser/state.mjs); api: the other parts' functions, read when called.
import { computerName } from "../../sharing/join.mjs";
import { keepFocus } from "../../focus.mjs";
import { readSavedTabs, trackTabs, restoreTabs, isUntouchedStart } from "../../tabs.mjs";
import { recordPerson, tabsFile } from "../../sessions.mjs";
import { sleep, within } from "../../util.mjs";
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

// The browser's own new tab page, untouched: the native build's (isUntouchedStart); in a browser
// without PairBrowse's pages, the side panel extension's (ui/newtab, its chrome_url_overrides) or
// the engine's own at chrome://new-tab-page/.
export const isOwnNewTab = (url) => isUntouchedStart(url) || /^(chrome:\/\/new-tab-page\/?|chrome-extension:\/\/[a-p]{32}\/newtab\/index\.html)([?#].*)?$/i.test(String(url ?? ""));

// The start tab's own first load. A build with its own pages opens its new tab page in the first
// tab (not about:blank), and the launch counts as done once that tab exists, not once its page has
// loaded: on a slow machine that page's late load cut off an agent's first browser_navigate
// (net::ERR_ABORTED, the tab left on the new tab page). The first agent call waits for it (ready()):
// until the tab shows the new tab page and that page has loaded, at most ms in all. "loaded", or
// "elsewhere" (the tab went to another page: the picker, a person's address), "closed" (a restore
// closed it) or "timeout". Every read of the page is bounded.
export const START_LOAD_MS = 5000;
export async function startTabLoaded(page, { ms = START_LOAD_MS, every = 100, now = Date.now } = {}) {
  const until = now() + ms;
  const url = () => { try { return page.url(); } catch { return ""; } };
  // Not committed yet: a tab that has just opened reads about:blank (or nothing) until then.
  while (!page.isClosed() && /^(about:blank)?$/.test(url())) {
    if (now() >= until) return "timeout";
    await sleep(every);
  }
  if (page.isClosed()) return "closed";
  if (!isOwnNewTab(url())) return "elsewhere";
  const loaded = await within(Math.max(0, until - now()), page.waitForLoadState("load", { timeout: Math.max(1, until - now()) }).then(() => true, () => false));
  return loaded ? "loaded" : page.isClosed() ? "closed" : "timeout";
}

// When a download last started in each tab (adopt): a browser_navigate that ended in one is never
// sent again (serve.mjs, retryAborted).
const downloads = new WeakMap();
export const downloadStartedAt = (page) => (page && downloads.get(page)) || 0;

// A browser_navigate that failed with net::ERR_ABORTED goes once more only when nothing but the
// start tab's own late load can have cut it off: the tab still shows the browser's untouched new
// tab page, or nothing yet (that page's load cut the call off before it committed itself), so the
// address asked for never committed and no page sent the browser anywhere; and no download started
// in it since the call went out (sentAt, ms; unknown: never). Pure.
export function retryAborted({ tool, raw, page, sentAt, retried = false }) {
  if (retried || tool !== "browser_navigate" || !/net::ERR_ABORTED/i.test(String(raw ?? ""))) return false;
  const url = page && !page.isClosed?.() ? String(page.url() ?? "") : null;
  if (url === null || !(isOwnNewTab(url) || /^(about:blank)?$/.test(url))) return false;
  const at = downloadStartedAt(page);
  return Number.isFinite(sentAt) && !(at && at >= sentAt - 1000);
}

export function createTabs(st, deps, api) {
  const { config, hostNote, hud, log, onTabClosed, personTabs, popups, presence, status, onRestored = () => {} } = deps;
  // The session's tabs are back (or there were none): a hand-off a restart cut short is reissued
  // to its tab (deps.onRestored: yourturn.mjs recover, spec server-mode B16).
  const restored = () => { try { Promise.resolve(onRestored()).catch((e) => log(`after restore: ${e?.message || e}`)); } catch (e) { log(`after restore: ${e?.message || e}`); } };
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
    page.on("download", () => downloads.set(page, Date.now()));
    presence.watchUser(page, { opened });
    stopRequestMirroring(page);
    page.once("close", () => onTabClosed(page)); // a closed tab's turn ends with it
    touch(page);
  }

  // screen: the tab that shows "Opening tabs" (default: the first one).
  // A tab's identity across a browser restart (a session switch, a rename, a crash): its place in its
  // session's last save. Before the browser closes, each saved page is noted with that place
  // (notePlaces); as the session's tabs come back, each new page takes the place's (successors), so an
  // agent's tab is the same tab when its session comes back, never another one on the same address.
  const successors = new WeakMap(); // old page -> the page that tab came back as
  const comingBack = new Map(); // `${session}|${i}` -> [old pages]

  // From the tracker's last save, not the browser's tabs: after a crash (launch.mjs's close
  // handler) the browser lists none, yet each tab comes back in its place. A save due is made
  // first (flush), whichever close handler runs first. While the saved tabs come back, the places
  // are the ones back so far (seat); one not back yet keeps its older pages waiting.
  function notePlaces() {
    st.tabTracker?.flush?.();
    const saved = st.tabTracker?.pages?.() || [];
    saved.forEach((p, i) => {
      if (!p) return;
      const k = `${st.session}|${i}`;
      comingBack.set(k, [...(comingBack.get(k) || []).filter((x) => x !== p), p].slice(-8));
    });
  }

  const successorOf = (page) => { let p = page; for (let n = 0; p && n < 8 && successors.has(p); n++) p = successors.get(p); return p && p !== page && !p.isClosed() ? p : null; };

  function restore(ctx, screen = null, { own = false } = {}) {
    recordPerson(st.session, { who: "You", computer: computerName(), kind: "you" }); // the session is in use now
    const saved = readSavedTabs(tabsFile(st.session));
    const restoredSession = st.session;
    // Nothing is written while the saved tabs come back (a stop or a crash meanwhile keeps the whole list).
    let tracker = null;
    tracker = st.tabTracker = trackTabs(ctx, { file: tabsFile(st.session), activePage: () => findPage(ctx, st.lastCurrentUrl), activeUrl: () => st.lastCurrentUrl, log, holding: () => st.restoring !== null && st.tabTracker === tracker });
    if (!saved.tabs.length) { screen?.close().catch(() => {}); restored(); return; }
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
      onPage: (i, page) => { tracker.seat?.(i, page); for (const old of comingBack.get(`${restoredSession}|${i}`) || []) successors.set(old, page); comingBack.delete(`${restoredSession}|${i}`); },
    }).catch((e) => log("restore failed", e?.message || e)).finally(() => {
      status(hud.badge());
      st.restoring = null;
      log(`restored ${saved.tabs.length} tabs`);
      log(`launch: restore ${Date.now() - restoreAt} ms`);
      capTabs(ctx).catch(() => {});
      restored();
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
