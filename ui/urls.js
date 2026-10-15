// The addresses of the PairBrowse browser's own pages, and the rules about them: one copy for the
// helper (policy.mjs, the live view, the session picker and the joiner's picture page) and for
// the pages themselves. Pure: no DOM, no Node API, nothing runs on import (the helper imports it
// in Node; the live view serves it, scripts/liveview/http.mjs; the extension and the native build
// ship it as a flat file at the ui/ root).
//
// A native build with its own pages serves them from two hosts: the window's slot pages (the tab
// strip, the docks, the timeline, the approval bubble, the capture page) on
// chrome://pairbrowse.top-chrome, the tab pages (picker, screen, sessions, settings, activity,
// new tab) on chrome://pairbrowse. It shows its own pages and Chromium's as pairbrowse://<name>
// (patch 570: a display rewrite; the committed address stays chrome://, which is what a tab
// reports), and opens the browser's pages when one is typed so.

export const TOP_CHROME_HOST = "pairbrowse.top-chrome";
export const TAB_HOST = "pairbrowse";
// The origins the browser's own pages send (the live view lets them in by CORS, the owner's key only).
export const CHROME_PAGE_ORIGINS = Object.freeze([`chrome://${TAB_HOST}`, `chrome://${TOP_CHROME_HOST}`]);
// The address to open one of the browser's own pages by its shown name ("settings#passwords").
export const ownPage = (name) => `pairbrowse://${name}`;
// The session picker and the joiner's picture page, in a build with its own pages.
export const CHROME_PICKER = `chrome://${TAB_HOST}/picker`;
export const CHROME_SCREEN = `chrome://${TAB_HOST}/screen/`;
// Settings' report section, as a link a plain browser shows.
export const REPORT_URL = `chrome://${TAB_HOST}/settings#report`;

// Every pairbrowse: address is the browser's own, whichever spelling a tab or a call carries:
// never an agent's to open, read or act in.
export const isChromePage = (url) => /^(chrome:\/\/pairbrowse(\.top-chrome)?([/?#]|$)|pairbrowse:)/i.test(String(url ?? "").trim());
// A joiner's picture page in a build with its own pages: the browser's own page that shows a
// host's tab, as the extension's screen page does elsewhere. The live view lists, shows and
// replays a person's input into it like that page; the browser's other pages stay out of it.
export const isChromeScreenPage = (url) => /^(chrome:\/\/pairbrowse\/screen|pairbrowse:\/\/screen)\/(?:[?#]|$)/i.test(String(url ?? "").trim());
export const hiddenFromLiveView = (url) => isChromePage(url) && !isChromeScreenPage(url);
// One of the browser's tab pages by its name ("sessions"), under either spelling. ends: what may
// follow the name (a regular expression's alternatives).
export const isOwnTabPage = (name, url, ends = "\\/|#|\\?|$") => new RegExp(`^(pairbrowse:\\/\\/|chrome:\\/\\/pairbrowse\\/)${name}(${ends})`).test(url || "");
// Settings at any of its sections ("settings#report"): the tab the docks bring forward.
export const isSettingsPage = (url) => isOwnTabPage("settings", url, "\\/|#|$");
// The picture page under the name the browser shows for it.
export const isShownScreenPage = (url) => /^pairbrowse:\/\/screen(?:[/#?]|$)/.test(String(url || ""));

// The page is served by the PairBrowse browser itself, on its own hosts, with or without
// window.pairbrowse; anything else is a page in a plain browser (the extension, the harness).
export const servedByBrowser = (loc = globalThis.location) => loc?.protocol === "chrome:" && (loc.host === TOP_CHROME_HOST || loc.host === TAB_HOST);

// The side panel extension's pages: chrome-extension://<id>/<path>, and the origin such a page
// sends (URL.origin is "null" for chrome-extension: URLs).
export const extensionUrl = (id, path = "") => `chrome-extension://${id}/${path}`;
export const extensionOrigin = (url) => { const { host } = new URL(url); return `chrome-extension://${host}`; };

// What you type in an address bar, as a URL: a web address, or a Google search (the live view's
// bar, over Playwright's Chromium). { search: false }: a web address only, else null (PairBrowse's
// own new tab page, which never sends words to a search engine: the omnibox's "Type a URL").
export function addressToUrl(text, { search = true } = {}) {
  const t = String(text || "").trim().slice(0, 2000);
  if (!t) return null;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(t)) return `http://${t}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/\s]+:\d+([/?#]|$)/.test(t)) return t;
  if (!/\s/.test(t) && /^[^/?#]+\.[a-z]{2,}([:/?#]|$)/i.test(t)) return `https://${t}`;
  return search ? `https://www.google.com/search?q=${encodeURIComponent(t)}` : null;
}
