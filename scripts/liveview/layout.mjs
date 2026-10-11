// The docks' layout the browser's own pages start from: each dock open, a rail or hidden; the
// tab strip's height in pixels. Read by the live view (its layout route and start) and by the
// profile default a browser with its own pages starts from (browser.mjs profilePreferences).
export const LAYOUT_STATES = new Set(["open", "rail", "hidden"]);
export const LAYOUT_FALLBACK = { left: "open", right: "open", strip: 88 };
export const STRIP_MIN = 44, STRIP_MAX = 176;

// given merged over base: a valid { left, right, strip }, or { error }.
export function readLayout(given, base) {
  if (!given || typeof given !== "object" || Array.isArray(given)) return { error: "A layout is { left, right, strip }." };
  const next = { ...base };
  for (const side of ["left", "right"]) {
    if (given[side] === undefined) continue;
    if (!LAYOUT_STATES.has(given[side])) return { error: `${side} is "open", "rail" or "hidden".` };
    next[side] = given[side];
  }
  if (given.strip !== undefined) {
    if (!Number.isInteger(given.strip) || given.strip < STRIP_MIN || given.strip > STRIP_MAX) return { error: `strip is a whole number of pixels from ${STRIP_MIN} to ${STRIP_MAX}.` };
    next.strip = given.strip;
  }
  return next;
}

// config.layout as a valid layout: an invalid or missing one is the fallback.
export const layoutFrom = (given) => { const r = readLayout(given, LAYOUT_FALLBACK); return r.error ? { ...LAYOUT_FALLBACK } : r; };

// The right dock's tab a POST layout may ask for (the left dock's Tools button opens it on
// "tools"): relayed in that answer and its layout event only, never kept, never in layout.json.
export const DOCK_TABS = new Set(["agent", "page", "pictures", "tools"]);
// given.tab checked: { tab } (one of DOCK_TABS), { tab: null } (none asked for) or { error }.
export function readDockTab(given) {
  const tab = given && typeof given === "object" && !Array.isArray(given) ? given.tab : undefined;
  if (tab === undefined) return { tab: null };
  return DOCK_TABS.has(tab) ? { tab } : { error: "tab is agent, page, pictures or tools." };
}
