// The tab strip and overview: favicons, and what people other than the owner see of tabs and
// activity (addresses without query strings or fragments).
import { stripUrl, stripText } from "../join.mjs";

const ICON_TIMEOUT_MS = 3000;
const ICON_MAX_BYTES = 64_000;
const ICONS_MAX = 200; // sites kept
const ICON_TYPE = /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|gif|jpeg|webp)$/;

// Favicons, fetched once per site and inlined (the viewer loads nothing from the web).
export function createIcons() {
  const icons = new Map(); // origin -> data: URL, or null
  return async (page) => {
    let origin;
    try { origin = new URL(page.url()).origin; } catch { return null; }
    if (!/^https?:/.test(origin)) return null;
    if (icons.has(origin)) return icons.get(origin);
    if (icons.size >= ICONS_MAX) icons.delete(icons.keys().next().value); // the oldest site goes
    icons.set(origin, null);
    try {
      const href = await page.evaluate(() => document.querySelector('link[rel~="icon"]')?.href || null).catch(() => null);
      const res = await page.context().request.get(href || `${origin}/favicon.ico`, { timeout: ICON_TIMEOUT_MS, maxRedirects: 3 });
      const type = (res.headers()["content-type"] || "").split(";")[0];
      const body = await res.body();
      if (res.ok() && ICON_TYPE.test(type) && body.length < ICON_MAX_BYTES) icons.set(origin, `data:${type};base64,${body.toString("base64")}`);
    } catch {}
    return icons.get(origin);
  };
}

export const guestTabs = (tabs) => tabs.map((t) => ({ ...t, url: stripUrl(t.url), title: stripText(t.title), last: t.last ? { ...t.last, text: stripText(t.last.text) } : null }));
export const guestActivity = (list) => list.map((a) => ({ ...a, text: stripText(a.text) }));
export const withoutIcons = (tabs) => tabs.map(({ icon, ...t }) => t);
