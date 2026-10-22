// The addresses of the PairBrowse browser's own pages, and the rules about them: one copy for the
// helper (policy.mjs, the live view, the session picker and the joiner's picture page) and for
// the pages themselves. Pure: no DOM, no Node API, nothing runs on import (the helper imports it
// in Node; the live view serves it, scripts/liveview/http.mjs; the extension and the native build
// ship it as a flat file at the ui/ root).
//
// A native build with its own pages serves them from two hosts: the window's slot pages (the tab
// strip, the docks, the timeline, the approval bubble, the capture page) on
// chrome://pairbrowse.top-chrome, the tab pages (picker, screen, sessions, settings, activity,
// new tab) on chrome://pairbrowse. It shows every page as pairbrowse://<its own host>, as Brave
// shows brave:// (patch 570: a display rewrite; the committed address stays chrome://, which is
// what a tab reports): every host keeps its own name (pairbrowse://settings is the engine's
// settings, pairbrowse://chrome-urls its list of pages), and the older renamed hosts
// (browser-settings, browser-newtab, browser-signin) only forward to theirs. PairBrowse's own
// settings are, in a build that declares it (its manifest's settingsSection, 580; the helper's
// config.json says so to the pages), a "PairBrowse" section of the engine's settings:
// chrome://settings/pairbrowse[#section], shown as pairbrowse://settings/pairbrowse, which frames
// chrome://pairbrowse/settings/; that old address opened as a tab goes there. In an older build
// (no settingsSection) the settings page is that tab page itself, opened as pairbrowse://settings.

export const TOP_SHELL_HOST = "pairbrowse.top-chrome";
export const TAB_HOST = "pairbrowse";
// The origins the browser's own pages send (the live view lets them in by CORS, the owner's key only).
export const BROWSER_PAGE_ORIGINS = Object.freeze([`chrome://${TAB_HOST}`, `chrome://${TOP_SHELL_HOST}`]);
// The address to open one of the browser's own pages by its shown name ("settings#passwords").
export const ownPage = (name) => `pairbrowse://${name}`;
// The session picker and the joiner's picture page, in a build with its own pages.
export const BROWSER_PICKER = `chrome://${TAB_HOST}/picker`;
export const BROWSER_SCREEN = `chrome://${TAB_HOST}/screen/`;
// PairBrowse's own settings, at one of its sections ("passwords"): its tab page's own address,
// which every build opens right, whatever the helper knows: an older build shows the tab page, a
// build with the engine settings' PairBrowse section (580) sends it there at the same section.
export const settingsPage = (at = "") => `chrome://${TAB_HOST}/settings${at ? `#${at}` : ""}`;
// The engine's settings page around it (chrome://settings), where its frame posts its height.
export const ENGINE_SETTINGS_ORIGIN = "chrome://settings";
// Settings' report section, as a link: the tab page's address (settingsPage), right in every build.
export const REPORT_URL = settingsPage("report");

// Every pairbrowse: address is the browser's own, whichever spelling a tab or a call carries:
// never an agent's to open, read or act in. So is the engine's settings page (chrome://settings
// at any of its sections, shown as pairbrowse://settings): its PairBrowse section frames
// PairBrowse's own settings page.
export const isBrowserPage = (url) => /^(chrome:\/\/(pairbrowse(\.top-chrome)?|settings)([/?#]|$)|pairbrowse:)/i.test(String(url ?? "").trim());
// A joiner's picture page in a build with its own pages: the browser's own page that shows a
// host's tab, as the extension's screen page does elsewhere. The live view lists, shows and
// replays a person's input into it like that page; the browser's other pages stay out of it.
export const isBrowserScreenPage = (url) => /^(chrome:\/\/pairbrowse\/screen|pairbrowse:\/\/screen)\/(?:[?#]|$)/i.test(String(url ?? "").trim());
export const hiddenFromLiveView = (url) => isBrowserPage(url) && !isBrowserScreenPage(url);
// The engine's payment methods page, where the person adds a saved card ("Add a saved card", spec
// server-mode B12). It opens as the person's own tab (no agent, guest or hand-off viewer reaches
// it); the owner's live view may show that one tab, though it is the browser's own page.
export const PAYMENT_SETTINGS = "chrome://settings/payments";
export const isPaymentSettings = (url) => /^chrome:\/\/settings\/payments(?:[/?#]|$)/i.test(String(url ?? "").trim());
// One of the browser's tab pages by its name ("sessions"), under either spelling. ends: what may
// follow the name (a regular expression's alternatives).
export const isOwnTabPage = (name, url, ends = "\\/|#|\\?|$") => new RegExp(`^(pairbrowse:\\/\\/|chrome:\\/\\/pairbrowse\\/)${name}(${ends})`).test(url || "");
// PairBrowse's settings at any of its sections ("settings#report"): the tab the docks bring
// forward. Its home is the engine settings' PairBrowse section, chrome://settings/pairbrowse (what
// its tab reports), or pairbrowse://settings/pairbrowse; the older own addresses count too.
export const isSettingsPage = (url) => isOwnTabPage("settings", url, "\\/|#|$") || /^(chrome|pairbrowse):\/\/settings\/pairbrowse([/#?]|$)/.test(url || "");
// The browser's proxies: the engine settings' Proxies page (580), which frames PairBrowse's settings
// page in its proxies view. Opened by its shown address; its tab reports chrome://settings/proxies.
export const PROXIES_PAGE = "pairbrowse://settings/proxies";
// Handoff: the engine settings' Handoff page (580), which frames PairBrowse's settings page in its
// handoff view (Telegram and Discord linked to your phone). Opened by its shown address; its tab
// reports chrome://settings/handoff.
export const HANDOFF_PAGE = "pairbrowse://settings/handoff";
// The view the engine settings' page asks of PairBrowse's settings page it frames (?view=):
// "proxies", "handoff" or "pairbrowse", "" for anything else.
const VIEWS = new Set(["proxies", "handoff", "pairbrowse"]);
export const viewOf = (search) => { const v = new URLSearchParams(String(search ?? "")).get("view"); return VIEWS.has(v) ? v : ""; };
export const isProxiesPage = (url) => /^(chrome|pairbrowse):\/\/settings\/proxies([/#?]|$)/.test(url || "");
export const isHandoffPage = (url) => /^(chrome|pairbrowse):\/\/settings\/handoff([/#?]|$)/.test(url || "");
// The picture page under the name the browser shows for it.
export const isShownScreenPage = (url) => /^pairbrowse:\/\/screen(?:[/#?]|$)/.test(String(url || ""));

// The page is served by the PairBrowse browser itself, on its own hosts, with or without
// window.pairbrowse; anything else is a page in a plain browser (the extension, the harness).
export const servedByBrowser = (loc = globalThis.location) => loc?.protocol === "chrome:" && (loc.host === TOP_SHELL_HOST || loc.host === TAB_HOST);
// Where PairBrowse's settings page goes when the browser opened it as a whole tab of its own
// (framed: false) in a build with the settings section (section: true): its home, the engine
// settings' PairBrowse section at the same section (chrome://settings/pairbrowse#report). null
// where it stays: framed there, an older build (the tab page is its home), or not the browser's
// own page (the extension's options page, the harness).
export const settingsHomeFor = (loc = globalThis.location, framed = true, section = false) => (section && !framed && servedByBrowser(loc) && loc.host === TAB_HOST ? `${ENGINE_SETTINGS_ORIGIN}/pairbrowse${loc.hash || ""}` : null);

// The side panel extension's pages: chrome-extension://<id>/<path>, and the origin such a page
// sends (URL.origin is "null" for chrome-extension: URLs).
export const extensionUrl = (id, path = "") => `chrome-extension://${id}/${path}`;
export const extensionOrigin = (url) => { const { host } = new URL(url); return `chrome-extension://${host}`; };

// What you type in an address bar, as a URL: a web address, or a Google search (the live view's
// bar, over Playwright's build). { search: false }: a web address only, else null (PairBrowse's
// own new tab page, which never sends words to a search engine: the omnibox's "Type a URL").
export function addressToUrl(text, { search = true } = {}) {
  const t = String(text || "").trim().slice(0, 2000);
  if (!t) return null;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(t)) return `http://${t}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/\s]+:\d+([/?#]|$)/.test(t)) return t;
  if (!/\s/.test(t) && /^[^/?#]+\.[a-z]{2,}([:/?#]|$)/i.test(t)) return `https://${t}`;
  return search ? `https://www.google.com/search?q=${encodeURIComponent(t)}` : null;
}
