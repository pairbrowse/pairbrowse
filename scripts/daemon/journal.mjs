// The goal log the helper keeps by itself: one run file per browser session (runs.mjs shape, so
// run_get and run_list read it; source "auto"), opened by the first browser action and named
// after its site and time. Every page acted on is a line in `done` (its title or URL, then the
// bar's one-line descriptions of what was done there), hand-offs go to `yourTurn`, the open tabs
// to `tabs`, what a fast-mode run left empty to `left`. So a bigger task survives a context reset,
// a new Claude Code session or a helper restart even when the agent never called run_save.
// Written at most every few seconds, from a timer: it never holds up a call. Values never
// reach it beyond what the bar shows (names for passwords; card numbers and codes masked), and
// addresses keep their origin and path only (no query or fragment).
// read() gives the live view's Timeline the current run, every line masked again on read (a
// run_save can take the file over with lines the journal never masked), capped, never polled.
import { runFile, readRuns, currentFile, STALE_MS, liveAutoRun } from "../runs.mjs";
import { clipActivity, readJson, writeJsonAtomic, within } from "../util.mjs";

const FLUSH_MS = 3000;
const MAX_LINES = 150; // pages kept in `done`
const MAX_ACTS = 12; // descriptions kept per page line
const ACT_MAX = 100; // characters per description
const MAX_TABS = 20;
// When an opened page's title is looked for: the tab shows the address and has loaded by the
// first or second look, mostly; a title a script sets later is caught by a later one.
const TITLE_LOOKS_MS = [150, 400, 800, 1500, 3000];
const uniq = (a) => [...new Set(a.filter(Boolean))];
const isoNow = (t) => new Date(t).toISOString();
const siteOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, "") || "page"; } catch { return "page"; } };
const webUrl = (url) => /^https?:\/\//.test(String(url || ""));
// A page's key: its address without the fragment (a single-page form stays one page).
const keyOf = (url) => String(url).split("#")[0];
// An address as it is kept: origin and path, no query or fragment (they carry search terms,
// one-time codes and sign-in tokens), as the activity log keeps them.
const bare = (url) => String(url).replace(/[?#][\s\S]*$/, "");
// The run's name: "shopify.com 2026-10-10 14:05", local time.
function stamp(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// session(): the browser session's name. openPages(): the open tabs (pages). mask(text): as the
// results are masked (saved passwords). strip(title): the agent's name off a tab's title (the tab
// strip carries it). onActivity(fn): the bar's activities (hud.onActivity).
export function createJournal({ session = () => "default", openPages = async () => [], mask = (t) => t, strip = (t) => t, onActivity = () => {}, log = () => {}, now = () => Date.now(), delayMs = FLUSH_MS } = {}) {
  let file = null; // the run file being kept: the auto run's, or the agent's run after a run_save took it over
  let openedFor = null; // the session the file is for
  let current = null; // the page being acted on: { key, url, title, page, acts: [], written }
  let entries = []; // the pages acted on since the last write, current last
  const clean = (s) => mask(String(s || "")).replace(/\s+/g, " ").trim();
  const titleOf = async (page) => clean(strip(await within(500, page.title()).catch(() => ""))).slice(0, 120);
  const showing = (e) => e.page && !e.page.isClosed() && keyOf(e.page.url()) === e.key;
  // A page's title with the address it goes with, in one read: read as the tab moves on, the
  // title is the page's or nothing, never the next page's.
  const titled = (page) => { if (page.evaluate) return page.evaluate(() => [document.title, location.href]); const url = page.url(); return page.title().then((t) => [t, url]); };
  // The page's title, once it has one (a navigation's comes when the page has loaded), while the
  // tab still shows that page.
  const entitle = (e) => (showing(e) ? within(500, titled(e.page)).then((r) => { const t = r && keyOf(r[1]) === e.key ? clean(strip(r[0])).slice(0, 120) : ""; if (t) e.title = t; }).catch(() => {}) : Promise.resolve());
  // The tab showing the page (an agent's first navigation has no tab of its own yet; a tab given
  // with the opening may still show the page before), then its title.
  const locate = async (e) => { if (!showing(e)) e.page = (await openPages()).find((p) => !p.isClosed() && keyOf(p.url()) === e.key) || e.page; await entitle(e); };
  // An opened page's title, looked for a few times over three seconds (TITLE_LOOKS_MS) once the
  // tab shows the address and the page has loaded: a page opened and left again before its next
  // action, or one that gets its title from a script, keeps its title. A title found after the
  // line was written writes it again.
  function watch(e) {
    const look = async (i) => {
      if (e.title || e.page?.isClosed()) return;
      await locate(e);
      if (!e.title && showing(e) && e.page.waitForLoadState) { await within(1500, e.page.waitForLoadState("domcontentloaded").catch(() => {})); await entitle(e); }
      if (e.title) { if (e.written) { if (!entries.includes(e)) entries.push(e); schedule(); } return; }
      if (i + 1 < TITLE_LOOKS_MS.length) setTimeout(() => look(i + 1).catch(() => {}), TITLE_LOOKS_MS[i + 1] - TITLE_LOOKS_MS[i]).unref?.();
    };
    setTimeout(() => look(0).catch(() => {}), TITLE_LOOKS_MS[0]).unref?.();
  }
  let yourTurn = []; // hand-offs set since the last write
  let over = []; // hand-offs ended since the last write (the agent went on)
  let lastHandoff = "";
  let left = null; // a fast-mode run's list of what's still empty, when one ran
  let timer = null;
  let writing = Promise.resolve();

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; writing = flush().catch((e) => log("goal log", e?.message || e)); }, delayMs);
    timer.unref?.();
  }

  // After a helper restart: this session's latest auto run that is still going, or the agent's
  // run it was taken over by (not finished, touched within a day).
  function resume() {
    const mine = readRuns().filter((r) => r.source === "auto" && r.session === session()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    for (const r of mine) {
      const target = r.mergedInto ? readJson(runFile(r.mergedInto)) : r;
      if (!target || target.status === "finished" || now() - Date.parse(target.updatedAt) > STALE_MS) continue;
      return runFile(target.name);
    }
    return null;
  }

  function open(url) {
    const t = now();
    let name = `${siteOf(url)} ${stamp(t)}`;
    if (readJson(runFile(name))) name += `:${String(new Date(t).getSeconds()).padStart(2, "0")}`; // two tasks in one minute
    const run = { name, status: "in progress", source: "auto", session: session(), createdAt: isoNow(t), updatedAt: isoNow(t), done: [], left: [], yourTurn: [], drafted: [], tabs: [] };
    writeJsonAtomic(runFile(name), run);
    return runFile(name);
  }

  // The run file as it stands: a run_save may have taken it over (its run is kept from here on)
  // or finished it (the log closes, and the next action opens a new one).
  function follow() {
    let run = readJson(file);
    for (let hops = 0; run?.mergedInto && hops < 3; hops++) { file = runFile(run.mergedInto); run = readJson(file); }
    if (!run || run.status === "finished") { file = null; current = null; entries = []; yourTurn = []; over = []; left = null; lastHandoff = ""; }
    return run;
  }

  function ensureFile(url) {
    if (file && openedFor !== session()) { file = null; current = null; entries = []; } // the browser switched session
    if (file) follow();
    if (!file) { file = resume() || open(url); openedFor = session(); }
    // Which file is being kept, for run_save: the agent's run takes exactly this log over.
    const pointer = readJson(currentFile);
    if (pointer?.file !== file) writeJsonAtomic(currentFile, { file, session: openedFor, at: isoNow(now()) });
  }

  // One of the bar's lines (hud.addActivity): text, who did it, the tab, the joiner it came from.
  function activity(text, _who = "", page = null, from = "") {
    if (!text || from) return; // a joined session keeps its own log
    const act = clipActivity(clean(text), ACT_MAX);
    // Opening a page: the bar says so before the tab moves, so the address is in the line.
    const opened = act.match(/^Opened (\S+)/);
    let url = opened ? opened[1] : page && !page.isClosed() ? page.url() : "";
    if (!webUrl(url)) { if (!current) return; url = current.url; page = page || current.page; }
    ensureFile(url);
    if (!current || current.key !== keyOf(url)) {
      // The page before, still without a title: now, while the tab still shows it (an opening is
      // said before the tab moves). Without a tab known yet (the first navigation): this tab was it.
      if (current && !current.title) { if (!current.page && page) current.page = page; entitle(current); }
      current = { key: keyOf(url), url: bare(url).slice(0, 200), title: "", page, acts: [], written: "" };
      entries.push(current);
    }
    if (page && !page.isClosed()) current.page = page;
    if (!opened || current.acts.length) current.acts.push(act);
    if (current.acts.length > MAX_ACTS) current.acts.splice(0, current.acts.length - MAX_ACTS);
    if (opened) watch(current);
    else entitle(current);
    schedule();
  }

  // pairbrowse_status: kind "you" is a hand-off; any other kind after one means the agent went on.
  function status(kind, text = "") {
    if (!file) return;
    if (kind === "you") { lastHandoff = mask(String(text || "Your turn")).slice(0, 140); yourTurn.push(lastHandoff); if (current) current.acts.push(`Your turn: ${lastHandoff}`); }
    else if (lastHandoff) { over.push(lastHandoff); lastHandoff = ""; }
    schedule();
  }

  // What a pairbrowse_run left: fields skipped for the people filling them, and the page's
  // "still empty" and "left empty" checks. An empty list means nothing is left on that page.
  function ranLeft({ skipped = [], checks = [] } = {}) {
    if (!file) return;
    const names = skipped.map((s) => s.label);
    for (const c of checks) {
      const m = String(c).match(/^(?:still empty and required|left empty[^:]*): (.*)$/);
      if (m) names.push(...m[1].split(/",\s*"/).map((n) => n.replace(/^"|"$/g, "")));
    }
    left = uniq(names.map((n) => mask(String(n)).slice(0, 80)));
    schedule();
  }

  async function tabs() {
    const pages = (await openPages().catch(() => [])).filter((p) => !p.isClosed() && webUrl(p.url())).slice(0, MAX_TABS);
    return Promise.all(pages.map(async (p) => ({ title: await titleOf(p), url: bare(p.url()).slice(0, 500) })));
  }

  const lineOf = (c) => `${c.title ? `${c.title} <${c.url}>` : c.url}${c.acts.length ? `: ${c.acts.join("; ")}` : ""}`;
  // A written line's descriptions back (lineOf the other way).
  const actsIn = (line, url) => { const i = line.indexOf(">: "); const rest = i >= 0 ? line.slice(i + 3) : line.startsWith(`${url}: `) ? line.slice(url.length + 2) : ""; return rest ? rest.split("; ") : []; };

  async function flush() {
    if (!file) return;
    const run = follow();
    if (!run || !file) return; // finished meanwhile: the log closed (follow), nothing to write
    await Promise.all(entries.map(entitle));
    const done = run.done || [];
    for (const e of entries) {
      // Picking up after a restart: the same page's line goes on rather than a second one.
      const last = done[done.length - 1];
      if (!e.written && last && (last.includes(`<${e.url}>`) || last.startsWith(`${e.url}:`) || last === e.url)) {
        e.acts = [...actsIn(last, e.url), ...e.acts].slice(-MAX_ACTS);
        e.written = last;
      }
      // A line written before keeps its place (a title that came late); a new one goes last.
      const at = e.written ? done.indexOf(e.written) : -1;
      e.written = lineOf(e);
      if (at >= 0) done[at] = e.written;
      else done.push(e.written);
    }
    entries = current ? [current] : [];
    run.done = done.slice(-MAX_LINES);
    run.yourTurn = uniq([...(run.yourTurn || []).filter((x) => !over.includes(x)), ...yourTurn]);
    yourTurn = []; over = [];
    if (left !== null) { run.left = left; left = null; }
    run.tabs = await tabs();
    run.updatedAt = isoNow(now());
    // Read again right before the write: a session rename meanwhile (runs.mjs renameRunsSession)
    // keeps the run's new session name.
    const onDisk = readJson(file);
    if (typeof onDisk?.session === "string") run.session = onDisk.session;
    writeJsonAtomic(file, run);
  }

  // Everything pending, now (tests, and the helper shutting down).
  async function flushNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    await writing;
    await flush();
  }

  // The run as the Timeline shows it: the file being kept (following a run_save's takeover, read
  // only: nothing here changes what the log keeps), or the auto run still going after a helper
  // restart; null when there is none.
  function shown() {
    let run;
    if (file) {
      run = readJson(file);
      for (let hops = 0; run?.mergedInto && hops < 3; hops++) run = readJson(runFile(run.mergedInto));
    } else run = liveAutoRun(now());
    return run && typeof run === "object" ? run : null;
  }
  function read() {
    const run = shown();
    if (!run) return null;
    const list = (a) => (Array.isArray(a) ? a : []);
    return {
      name: clean(run.name).slice(0, 120),
      status: run.status === "finished" ? "finished" : "in progress",
      done: list(run.done).slice(-MAX_LINES).map((l) => clean(l).slice(0, 400)),
      yourTurn: uniq(list(run.yourTurn).map((x) => clean(x).slice(0, 140))).slice(0, 20),
      left: uniq(list(run.left).map((x) => clean(x).slice(0, 80))).slice(0, 50),
      updatedAt: typeof run.updatedAt === "string" ? run.updatedAt.slice(0, 40) : "",
    };
  }

  // When the run read() shows was last written ("Saved N min ago" on the session card), only
  // when that run is this session's; else "".
  function savedAt() {
    const run = shown();
    return run && run.session === session() && typeof run.updatedAt === "string" ? run.updatedAt.slice(0, 40) : "";
  }
  // The browser session was renamed (context.mjs renameCurrent): the log goes on under its new name.
  function renamed(from, to) { if (openedFor === from) openedFor = to; }

  onActivity(activity);
  // The page the log is on now ({ url, title }, the title masked), or null: a timeline card's step.
  return { activity, status, ranLeft, flushNow, read, savedAt, renamed, file: () => file, step: () => (current ? { url: current.url, title: current.title } : null) };
}
