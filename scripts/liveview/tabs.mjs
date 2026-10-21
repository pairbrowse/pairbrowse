// The tab strip and overview: favicons, and what people other than the owner see of tabs and
// activity (addresses without query strings or fragments).
import { stripUrl, stripText } from "../sharing/join.mjs";
import { urlHost, within } from "../util.mjs";

// A web address's host (with its port), or "" for anything else.
export const hostOf = (url) => urlHost(url);

const ICON_TIMEOUT_MS = 1000;
const ICON_MAX_CHARS = 90_000; // about 64 KB of image
const ICONS_MAX = 200; // sites kept
const ICON_DATA = /^data:image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|gif|jpeg|webp)[;,]/;

// Favicons the page itself carries as data: images, kept once per site (the viewer loads nothing
// from the web). Never fetched: a request from the helper would leave outside the browser, with
// another client's headers and around a session's proxy, so a site that links its icon by address
// shows the viewer's plain tile instead.
export function createIcons() {
  const icons = new Map(); // origin -> data: URL, or null
  return async (page) => {
    let origin;
    try { origin = new URL(page.url()).origin; } catch { return null; }
    if (!/^https?:/.test(origin)) return null;
    if (icons.has(origin)) return icons.get(origin);
    if (icons.size >= ICONS_MAX) icons.delete(icons.keys().next().value); // the oldest site goes
    icons.set(origin, null); // read once per site, also while this read waits
    const read = page.evaluate(() => document.querySelector('link[rel~="icon"]')?.getAttribute("href") || null).catch(() => null);
    const href = await within(ICON_TIMEOUT_MS, read);
    const icon = typeof href === "string" && href.length < ICON_MAX_CHARS && ICON_DATA.test(href) ? href : null;
    icons.set(origin, icon);
    return icon;
  };
}

export const guestTabs = (tabs) => tabs.map((t) => ({ ...t, url: stripUrl(t.url), title: stripText(t.title), last: t.last ? { ...t.last, text: stripText(t.last.text) } : null }));
export const guestActivity = (list) => list.map((a) => ({ ...a, text: stripText(a.text) }));
export const withoutIcons = (tabs) => tabs.map(({ icon, ...t }) => t);
