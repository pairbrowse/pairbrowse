// PairBrowse remembers the open tabs itself and brings them back one by one after Chrome
// starts, behind an "Opening tabs" screen. Chrome's own restore reloads every tab at once
// during startup, which made the first action wait many seconds.
import { ownTitle } from "./daemon/tablabels.mjs";
import { readJson, sleep, writeJsonAtomic } from "./util.mjs";

const restorable = (url) => /^https?:\/\//i.test(url);

// file: the session's tabs file (tabsFile in sessions.mjs).
export function readSavedTabs(file) {
  const saved = readJson(file);
  const tabs = (Array.isArray(saved?.tabs) ? saved.tabs : []).filter((t) => restorable(t?.url));
  return { tabs, active: Math.min(Math.max(0, saved?.active | 0), Math.max(0, tabs.length - 1)) };
}

// Keeps tabs.json in step with the browser. Writes are debounced, and a pending write is dropped
// when the whole browser closes, so quitting Chrome doesn't record an empty set of tabs.
export function trackTabs(ctx, { file, activePage = () => null, log = () => {} } = {}) {
  let timer = null;
  let stopped = false;
  // The tabs as last seen (their addresses from the navigations, titles from the last save): what
  // gets written when the browser dies before a pending save ran (a crash in the second and a
  // half after a navigation would otherwise lose that tab).
  const known = new Map(); // page -> { url, title }
  const titles = new Map(); // url -> title, from the last save
  let order = []; // the pages of the last save, in its order: a tab's place there is its identity (indexOf)
  const snapshot = async () => {
    const pages = ctx.pages();
    const tabs = [];
    const saved = [];
    for (const p of pages) {
      const url = p.url();
      if (!restorable(url)) continue;
      const title = (await ownTitle(p)).slice(0, 120);
      tabs.push({ url, title });
      saved.push(p);
      titles.set(url, title);
    }
    order = saved;
    const active = Math.max(0, tabs.findIndex((t) => t.url === activePage()?.url()));
    return { tabs, active, savedAt: new Date().toISOString() };
  };
  const saveNow = async () => {
    clearTimeout(timer);
    timer = null;
    if (stopped) return;
    for (const [page, k] of known) if (k.closedAt !== undefined) known.delete(page); // closed by a person, saved as such now
    try {
      writeJsonAtomic(file, await snapshot());
    } catch (e) {
      log("saving tabs failed", e?.message || e);
    }
  };
  // What's known without asking the browser (gone, or going): written at once.
  // Tabs closed in the last moment went down with the browser (a quit or a crash closes them
  // all at once), not by a person: they count as open. Nothing is written for an empty set.
  const saveKnown = () => {
    const now = Date.now();
    const tabs = [...known.values()].filter((t) => restorable(t.url) && (t.closedAt === undefined || now - t.closedAt < 1000)).map((t) => ({ url: t.url, title: t.title || titles.get(t.url) || "" }));
    if (!tabs.length) return;
    const active = Math.max(0, tabs.findIndex((t) => t.url === activePage()?.url()));
    try { writeJsonAtomic(file, { tabs, active, savedAt: new Date().toISOString() }); } catch (e) { log("saving tabs failed", e?.message || e); }
  };
  const soon = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(saveNow, 1500);
  };
  const watch = (page) => {
    known.set(page, { url: page.url(), title: "" });
    page.on("framenavigated", (frame) => { if (frame !== page.mainFrame()) return; known.set(page, { url: page.url(), title: "" }); soon(); });
    page.on("close", () => { const k = known.get(page); if (k) k.closedAt = Date.now(); soon(); });
  };
  ctx.pages().forEach(watch);
  ctx.on("page", (p) => { watch(p); soon(); });
  ctx.on("close", () => {
    // A save was due (the browser died before it ran): what was known goes down now. A deliberate
    // stop saved already (saveNow, then stop) and never comes here with a save pending.
    if (!stopped && timer) saveKnown();
    stopped = true;
    clearTimeout(timer);
  });
  // indexOf(page): where the page stands in the last save (-1: not in it). Restored tabs come back in
  // that order (restoreTabs onPage), so it names the same tab after a browser restart.
  return { saveNow, stop: () => { stopped = true; clearTimeout(timer); }, indexOf: (page) => order.indexOf(page) };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const host = (url) => { try { return new URL(url).host; } catch { return url; } };

// The side column's row: the site's initial on a plain avatar (the panel's .avatar.plain; no favicon
// yet, the tabs have not loaded), the title over the host, a state mark at the right. The words
// before the host ("waiting · " ...) keep the state readable without color.
const initialOf = (h) => (String(h).trim()[0] || "?").toUpperCase();
const CHECK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.6 6.3l2.2 2.2 4.6-4.9' fill='none' stroke='%2320C997' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;
const BAD = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M6 2v4.8' stroke='%23EF6468' stroke-width='1.9' stroke-linecap='round'/%3E%3Ccircle cx='6' cy='9.6' r='1.15' fill='%23EF6468'/%3E%3C/svg%3E")`;

export function loadingHtml(tabs) {
  const rows = tabs.map((t, i) => { const h = host(t.url); return `<li data-i="${i}" data-s="waiting"><span class="av" aria-hidden="true">${esc(initialOf(h))}</span><span class="t">${esc(t.title || h)}</span><span class="h">${esc(h)}</span><span class="m" aria-hidden="true"></span></li>`; }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Opening tabs</title><style>
  :root{--bg:#0B1421;--sidebar:#101B26;--elevated:#192A3D;--edge:#293B50;--ink:#F1F5FA;--ink-2:#A2B2C6;--muted:#8699B1;--accent:#3285F6;--ok:#20C997;--bad:#EF6468}
  *{box-sizing:border-box}html,body{margin:0;height:100%}
  body{display:grid;place-items:center;padding:24px;color:var(--ink);background:var(--bg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  main{width:min(460px,100%);padding:28px 28px 18px;border-radius:10px;background:var(--sidebar);border:1px solid var(--edge)}
  h1{font-size:20px;font-weight:600;margin:0 0 4px;letter-spacing:-0.01em}
  p{margin:0 0 18px;color:var(--ink-2)}
  .bar{height:4px;border-radius:4px;background:var(--edge);overflow:hidden;margin-bottom:12px}
  .bar i{display:block;height:100%;width:0;border-radius:4px;background:var(--accent);transition:width 160ms cubic-bezier(0.22,1,0.36,1)}
  ol{list-style:none;margin:0;padding:0}
  li{display:grid;grid-template-columns:24px minmax(0,1fr) 16px;grid-template-rows:auto auto;gap:0 10px;align-items:center;padding:8px 0;border-top:1px solid var(--edge)}
  li:first-child{border-top:0}
  .av{grid-row:1/3;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--elevated);color:var(--ink);border:1px solid var(--edge);font-size:12px;font-weight:600;line-height:1}
  .t{grid-column:2;grid-row:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font-weight:600;transition:color 160ms}
  li[data-s=waiting] .t{color:var(--muted)}
  .h{grid-column:2;grid-row:2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/1.4 ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:var(--muted)}
  .m{grid-column:3;grid-row:1/3;justify-self:center;width:8px;height:8px;border-radius:50%;border:1.5px solid var(--muted)}
  li[data-s=opening] .m{border:0;background:var(--accent)}
  li[data-s=open] .m,li[data-s=failed] .m{width:12px;height:12px;border:0;border-radius:0;background:${CHECK} center/12px 12px no-repeat}
  li[data-s=failed] .m{background-image:${BAD}}
  li[data-s=waiting] .h::before{content:"waiting · "}
  li[data-s=opening] .h::before{content:"opening · "}
  li[data-s=failed] .h::before{content:"failed · ";color:var(--bad)}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  </style></head><body><main>
  <h1>Opening tabs</h1><p id="sub">0 of ${tabs.length}, in the order you left them</p>
  <div class="bar"><i id="bar"></i></div><ol>${rows}</ol></main></body></html>`;
}

// Brings back saved tabs one by one, in order. Each tab starts loading before the next one opens,
// so they appear in sequence but load side by side.
// screen: the tab to show the progress in (default: the first one); it closes at the end.
// list false (a build with its own pages): no progress page; the start tab closes at the end only
// while it is still the untouched new tab page.
// onPage(i, page): saved tab i opened as page.
export async function restoreTabs(ctx, saved, { onProgress = () => {}, log = () => {}, screen: given = null, list = true, onPage = () => {} } = {}) {
  const { tabs, active } = saved;
  if (!tabs.length) { if (given) await given.close().catch(() => {}); return; }
  if (!list) return restoreQuietly(ctx, saved, { onProgress, log, start: given || ctx.pages()[0] || null, onPage });
  const screen = given || ctx.pages()[0] || (await ctx.newPage());
  await screen.setContent(loadingHtml(tabs)).catch(() => {});
  await screen.bringToFront().catch(() => {});
  const mark = (i, state, n) => screen.evaluate(([i, state, n, total]) => {
    const li = document.querySelector(`li[data-i="${i}"]`);
    if (li) li.dataset.s = state;
    document.getElementById("sub").textContent = `${n} of ${total}, in the order you left them`;
    document.getElementById("bar").style.width = `${Math.round((n / total) * 100)}%`;
  }, [i, state, n, tabs.length]).catch(() => {});

  const pages = [];
  for (const [i, t] of tabs.entries()) {
    onProgress(i + 1, tabs.length, t);
    await mark(i, "opening", i);
    const page = await ctx.newPage();
    try { onPage(i, page); } catch {}
    await screen.bringToFront().catch(() => {}); // keep the loading screen in view
    const ok = await page.goto(t.url, { waitUntil: "commit", timeout: 5000 }).then(() => true, (e) => { log(`restore ${t.url}: ${e.message.split("\n")[0]}`); return false; });
    pages.push(page);
    await mark(i, ok ? "open" : "failed", i + 1);
  }
  await sleep(350); // let the finished list register
  await (pages[active] || pages[0]).bringToFront().catch(() => {});
  await screen.close().catch(() => {});
}

// The new tab page as a start tab shows it: the browser's address or PairBrowse's own.
export const isUntouchedStart = (url) => /^chrome:\/\/(newtab|pairbrowse\/newtab)\/?([?#].*)?$/i.test(String(url ?? ""));

// restoreTabs without the progress page: the saved tabs open in order, the one that was active
// comes forward, and the start tab closes if nobody used it (still the new tab page).
async function restoreQuietly(ctx, { tabs, active }, { onProgress, log, start, onPage = () => {} }) {
  const pages = [];
  for (const [i, t] of tabs.entries()) {
    onProgress(i + 1, tabs.length, t);
    const page = await ctx.newPage();
    try { onPage(i, page); } catch {}
    await page.goto(t.url, { waitUntil: "commit", timeout: 5000 }).catch((e) => log(`restore ${t.url}: ${e.message.split("\n")[0]}`));
    pages.push(page);
  }
  await (pages[active] || pages[0]).bringToFront().catch(() => {});
  if (start && !start.isClosed?.() && isUntouchedStart(start.url())) await start.close().catch(() => {});
}
