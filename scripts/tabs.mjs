// PairBrowse remembers the open tabs itself and brings them back one by one after Chrome
// starts, behind an "Opening tabs" screen. Chrome's own restore reloads every tab at once
// during startup, which made the first action wait many seconds.
import { writeFileSync } from "node:fs";
import { readJson, sleep } from "./util.mjs";

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
  const snapshot = async () => {
    const pages = ctx.pages();
    const tabs = [];
    for (const p of pages) {
      const url = p.url();
      if (!restorable(url)) continue;
      tabs.push({ url, title: (await p.title().catch(() => "")).slice(0, 120) });
    }
    const active = Math.max(0, tabs.findIndex((t) => t.url === activePage()?.url()));
    return { tabs, active, savedAt: new Date().toISOString() };
  };
  const saveNow = async () => {
    clearTimeout(timer);
    timer = null;
    if (stopped) return;
    try {
      writeFileSync(file, JSON.stringify(await snapshot(), null, 2));
    } catch (e) {
      log("saving tabs failed", e?.message || e);
    }
  };
  const soon = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(saveNow, 1500);
  };
  const watch = (page) => {
    page.on("framenavigated", (frame) => frame === page.mainFrame() && soon());
    page.on("close", soon);
  };
  ctx.pages().forEach(watch);
  ctx.on("page", (p) => { watch(p); soon(); });
  ctx.on("close", () => { stopped = true; clearTimeout(timer); });
  return { saveNow, stop: () => { stopped = true; clearTimeout(timer); } };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const host = (url) => { try { return new URL(url).host; } catch { return url; } };

export function loadingHtml(tabs) {
  const rows = tabs.map((t, i) => `<li data-i="${i}" data-s="waiting"><span class="dot"></span><span class="t">${esc(t.title || host(t.url))}</span><span class="h">${esc(host(t.url))}</span></li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Opening tabs</title><style>
  :root{--ink:oklch(0.985 0.004 265);--ink-2:oklch(0.90 0.02 265);--muted:oklch(0.80 0.03 265);--glass:oklch(1 0 0 / 0.09);--edge:oklch(1 0 0 / 0.16);--cyan:oklch(0.84 0.12 215);--ok:oklch(0.82 0.16 155);--bad:oklch(0.74 0.17 25)}
  *{box-sizing:border-box}html,body{margin:0;height:100%}
  body{display:grid;place-items:center;padding:24px;color:var(--ink);font:14px/1.45 "Segoe UI Variable",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;
    background:radial-gradient(60% 55% at 12% 8%,oklch(0.60 0.17 240 / 0.85),transparent 70%),radial-gradient(55% 60% at 92% 22%,oklch(0.52 0.22 300 / 0.8),transparent 70%),radial-gradient(70% 60% at 50% 110%,oklch(0.62 0.14 215 / 0.7),transparent 70%),oklch(0.26 0.10 268)}
  main{width:min(460px,100%);padding:28px 28px 18px;border-radius:16px;background:var(--glass);border:1px solid var(--edge);box-shadow:inset 0 1px 0 oklch(1 0 0 / 0.16);-webkit-backdrop-filter:blur(22px) saturate(150%);backdrop-filter:blur(22px) saturate(150%)}
  h1{font-size:20px;font-weight:650;margin:0 0 4px;letter-spacing:-0.01em}
  p{margin:0 0 18px;color:var(--muted)}
  .bar{height:4px;border-radius:4px;background:oklch(1 0 0 / 0.12);overflow:hidden;margin-bottom:12px}
  .bar i{display:block;height:100%;width:0;border-radius:4px;background:var(--cyan);transition:width 200ms cubic-bezier(0.22,1,0.36,1)}
  ol{list-style:none;margin:0;padding:0}
  li{display:grid;grid-template-columns:14px 1fr auto;gap:10px;align-items:center;padding:9px 0;border-top:1px solid oklch(1 0 0 / 0.08)}
  li:first-child{border-top:0}
  .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);transition:color 180ms}
  li[data-s=waiting] .t{color:var(--muted)}
  .h{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
  .dot{width:8px;height:8px;border-radius:50%;background:oklch(1 0 0 / 0.22);justify-self:center;transition:background 180ms}
  li[data-s=opening] .dot{background:var(--cyan);box-shadow:0 0 0 3px oklch(0.84 0.12 215 / 0.25);animation:p .9s ease-in-out infinite}
  li[data-s=open] .dot{background:var(--ok)}
  li[data-s=failed] .dot{background:var(--bad)}
  @keyframes p{50%{opacity:.4}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  </style></head><body><main>
  <h1>Opening tabs</h1><p id="sub">0 of ${tabs.length}, in the order you left them</p>
  <div class="bar"><i id="bar"></i></div><ol>${rows}</ol></main></body></html>`;
}

// Brings back saved tabs one by one, in order. Each tab starts loading before the next one opens,
// so they appear in sequence but load side by side.
// screen: the tab to show the progress in (default: the first one); it closes at the end.
export async function restoreTabs(ctx, saved, { onProgress = () => {}, log = () => {}, screen: given = null } = {}) {
  const { tabs, active } = saved;
  if (!tabs.length) { if (given) await given.close().catch(() => {}); return; }
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
    await screen.bringToFront().catch(() => {}); // keep the loading screen in view
    const ok = await page.goto(t.url, { waitUntil: "commit", timeout: 5000 }).then(() => true, (e) => { log(`restore ${t.url}: ${e.message.split("\n")[0]}`); return false; });
    pages.push(page);
    await mark(i, ok ? "open" : "failed", i + 1);
  }
  await sleep(350); // let the finished list register
  await (pages[active] || pages[0]).bringToFront().catch(() => {});
  await screen.close().catch(() => {});
}
