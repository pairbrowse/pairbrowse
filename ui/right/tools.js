// The right dock's Tools tab, its four sections from TOOLS-CONTRACT.md: Hand-offs (steps only the
// person can do, oldest first, Show brings up the tab), Downloads (this session's, newest first),
// Recordings (the helper's saved videos, newest first; the Record button stays in right.js) and
// Diagnostics (what the helper reports about itself, and a scrubbed report to copy or save).
// When it reads: the three lists once per connection, only while the Tools tab is shown in the
// open dock and the page is visible (show()); the `downloads`, `handoffs` and `record` (saved)
// events keep them current after that, and an event that comes before its list has loaded is
// dropped (the read brings the whole list). diagnostics.json when Diagnostics is opened, on
// Refresh, and again whenever the Tools tab comes back into view (or the stream reconnects) with
// Diagnostics open; never while it is folded or the tab is not shown. Rows are patched in place by id, never rebuilt. Open, Open in Word,
// Show in Finder, Show (a hand-off's tab) and a confirmed Delete count only for a person's click or key press.
// A download's Open (POST downloads/<id>/open) and Open in Word (Word-type names only, POST
// downloads/<id>/open-app: the original in its default app) are answered { ok, opened: tab |
// preview | app }; the row's status line says where only as the helper answered (nothing for an
// answer without `opened`), one line across the list, emptied when the next Downloads action starts.
// Nothing is sent anywhere: Prepare report shows the helper's text, Copy uses the clipboard and
// Save is a download made in the page. No timer, observer or frame loop here; no markup strings.
import { $, el, avatar, splitLabel, shortClock } from "../common.js";

const MAC = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || "");
const REVEAL = MAC ? "Show in Finder" : "Show in folder";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
// Names the page can hint about: Word-type documents (Open in Word) and the types Chromium shows in
// a tab. Titles only: what really opens, asks first or is refused is the helper's answer.
const WORD = /\.(docx?|rtf|odt)$/i;
const IN_TAB = /\.(pdf|png|jpe?g|gif|webp|avif|bmp|mp4|m4v|webm|ogv|mp3|wav|ogg|oga|m4a|aac|flac|opus|txt)$/i;
const OPENED = { tab: "Opened in a new tab", preview: "Opened as a read-only preview", app: "Opened in its app" };
const openHint = (name) => (IN_TAB.test(name) ? "Opens in a new tab" : WORD.test(name) ? (MAC ? "Opens as a read-only preview in a new tab" : "Opens in its app") : "");
const idOf = (x) => ((typeof x === "string" || typeof x === "number") && ID.test(String(x)) ? String(x) : null);
const str = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
// at: epoch ms, or an ISO string; null when it is neither.
const timeOf = (at) => { const t = typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : NaN; return Number.isFinite(t) ? t : null; };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const pad = (n) => String(n).padStart(2, "0");

// Bytes in decimal units, as Finder shows them: "812 bytes", "2.4 MB", "42 MB".
function sizeWords(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v < 1000) return plural(Math.round(v), "byte");
  const units = ["KB", "MB", "GB"];
  let x = v / 1000, i = 0;
  while (x >= 1000 && i < units.length - 1) { x /= 1000; i++; }
  return `${x < 10 ? Math.round(x * 10) / 10 : Math.round(x)} ${units[i]}`;
}
// Seconds as "m:ss", or "h:mm:ss" from one hour.
function durationWords(s) {
  const v = Number(s);
  if (!Number.isFinite(v) || v < 0) return "";
  const t = Math.round(v), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
// Seconds the helper has been up, in words.
function uptimeWords(s) {
  const v = Number(s);
  if (!Number.isFinite(v) || v < 0) return "";
  if (v < 60) return "under a minute";
  if (v < 3600) return `${Math.floor(v / 60)} min`;
  if (v < 86400) return `${Math.floor(v / 3600)} h ${Math.floor((v % 3600) / 60)} min`;
  return `${Math.floor(v / 86400)} d ${Math.floor((v % 86400) / 3600)} h`;
}
const KIND = { login: "Sign in", "2fa": "Two-step code", captcha: "CAPTCHA", payment: "Payment", other: "Your turn" };
const STATE = { done: "Done", failed: "Failed", "in-progress": "Downloading" };
const ENGINE = { pairbrowse: "PairBrowse browser", chromium: "Chromium", path: "Your own browser" };
const has = (o, k) => !!o && typeof o === "object" && Object.hasOwn(o, k);

// base(): the helper's `${origin}/${key}/` or null. shown(): the Tools tab is visible in the open
// dock. onRecording({ on, since }): recordings.json's recorder state, for right.js's Record button.
export function toolsPanel({ base, shown, onRecording = () => {} }) {
  let stale = true; // the lists need a read (a new connection)
  let gen = 0; // bumped on stale() and forget(): an older read's answer is dropped
  const say = (id, text, kind = "") => { const m = $(id); m.textContent = text; m.dataset.kind = kind; };
  const ok = (r) => r.status >= 200 && r.status < 300 && r.body?.ok !== false;
  const getJson = (from, route) => fetch(from + route, { signal: AbortSignal.timeout(8000) })
    .then(async (x) => ({ status: x.status, body: x.ok ? await x.json().catch(() => null) : null }), () => ({ status: 0, body: null }));
  // A POST (no body, or a JSON one) or DELETE to the helper: { status, body } (status 0 when not reached).
  const send = (route, method = "POST", json) => {
    const from = base();
    if (!from) return Promise.resolve({ status: 0, body: null });
    const init = { method, signal: AbortSignal.timeout(8000) };
    if (json !== undefined) { init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(json); }
    return fetch(from + route, init)
      .then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }), () => ({ status: 0, body: null }));
  };
  // One request per button at a time (a disabled button would drop the focus).
  const busy = new WeakSet();
  async function once(btn, fn) {
    if (busy.has(btn)) return;
    busy.add(btn);
    try { await fn(); } finally { busy.delete(btn); }
  }
  // The one download row status showing (p.said), or null; emptied when the next Downloads action starts.
  let said = null;
  const unsay = () => { if (said) said.textContent = ""; said = null; };
  // Only a person's click or key press reaches outside the page.
  const real = (fn) => (ev) => { if (ev.isTrusted) once(ev.currentTarget, fn); };
  const button = (text, label, className = "act") => {
    const b = el("button", { className, type: "button", textContent: text });
    if (label) b.setAttribute("aria-label", label);
    return b;
  };

  // ---- one controller per list: rows by id, patched in place, ordered without moving rows
  // that stay where they are (a moved row would lose the focus). ----
  function makeList({ ul, valid, newest, build, update, changed, fallback }) {
    const L = { loaded: false, busy: false, pending: [], rows: new Map(), seq: 0 };
    const order = () => {
      const all = [...L.rows.values()].sort((a, b) => (newest ? (b.t - a.t) || (b.seq - a.seq) : (a.t - b.t) || (a.seq - b.seq)));
      all.forEach((row, i) => { if (ul.children[i] !== row.li) ul.insertBefore(row.li, ul.children[i] || null); });
    };
    L.upsert = (item, top = false) => {
      const id = idOf(item?.id);
      if (!id || !item || typeof item !== "object" || !valid(item)) return;
      let row = L.rows.get(id);
      const t = top ? Infinity : timeOf(item.at) ?? 0;
      if (row) { row.item = item; if (top || timeOf(item.at) !== null) row.t = t; update(row, item, id); }
      else { row = { id, item, t, seq: L.seq++, li: null }; row.li = build(row, item, id); L.rows.set(id, row); }
      order();
      changed();
    };
    L.remove = (id) => {
      const row = L.rows.get(String(id));
      if (!row) return;
      // The focus goes to the next row's first button, else the previous row's, else the fallback.
      if (row.li.contains(document.activeElement)) {
        const near = row.li.nextElementSibling || row.li.previousElementSibling;
        const to = near?.querySelector("button:not([hidden])") || fallback();
        row.li.remove();
        to?.focus();
      } else row.li.remove();
      L.rows.delete(row.id);
      changed();
    };
    L.replace = (items) => {
      const list = Array.isArray(items) ? items : [];
      const keep = new Set(list.map((it) => idOf(it?.id)).filter(Boolean));
      for (const id of [...L.rows.keys()]) if (!keep.has(id)) L.remove(id);
      for (const it of list) L.upsert(it);
      changed();
    };
    L.clear = () => { L.rows.clear(); ul.replaceChildren(); L.loaded = false; L.busy = false; L.pending = []; L.seq = 0; changed(); };
    // An event: applied once the list has loaded, held while its read is under way, else dropped.
    L.event = (apply) => { if (L.loaded) apply(); else if (L.busy) L.pending.push(apply); };
    return L;
  }

  // ---- Hand-offs ----
  let saidN = 0;
  const handoffs = makeList({
    ul: $("handoffs"),
    newest: false,
    valid: (it) => Object.hasOwn(KIND, it.kind) && typeof it.text === "string",
    fallback: () => $("sec-handoffs").querySelector(".disclose"),
    build: (row, it, id) => {
      const li = el("li", { className: "tool handoff" });
      li.dataset.kind = it.kind;
      const host = str(it.tab?.host);
      const label = str(it.by?.label);
      const kids = [];
      if (label) {
        const name = splitLabel(label).name;
        const face = avatar(name, it.by?.color);
        face.setAttribute("aria-hidden", "true");
        face.title = name;
        kids.push(face);
      } else li.classList.add("bare");
      const show = button("Show", host ? `Show the tab on ${host}` : "Show the tab", "act go");
      show.addEventListener("click", real(async () => {
        say("handoffs-msg", "");
        const r = await send(`handoffs/${encodeURIComponent(id)}/show`);
        if (r.status === 404) { handoffs.remove(id); return say("handoffs-msg", "That step is no longer waiting."); }
        if (!ok(r)) say("handoffs-msg", r.body?.error || "Couldn't reach PairBrowse.", "error");
      }));
      li.append(...kids,
        el("div", { className: "head" }, el("strong", { className: "kind", textContent: KIND[it.kind] }), el("small", { className: "meta", textContent: [host, label].filter(Boolean).join(" · "), title: str(it.tab?.title) })),
        el("span", { className: "acts" }, show),
        el("p", { className: "text", textContent: it.text }));
      return li;
    },
    update: (row, it) => {
      row.li.dataset.kind = it.kind;
      row.li.querySelector(".kind").textContent = KIND[it.kind];
      row.li.querySelector(".text").textContent = it.text;
    },
    changed: () => {
      const n = handoffs ? handoffs.rows.size : 0;
      const c = $("handoffs-count");
      c.hidden = !n;
      c.textContent = n ? String(n) : "";
      $("handoffs-empty").hidden = n > 0;
      if (n !== saidN) { saidN = n; $("handoffs-said").textContent = n ? `${plural(n, "step")} waiting for you` : "Nothing waiting for you"; }
    },
  });

  // Open and Show in Finder for a download or a recording: POST <route>/<id>/open | reveal.
  function fileActs(route, id, name, msg) {
    const open = button("Open", `Open ${name}`);
    const reveal = button(REVEAL, MAC ? `Show ${name} in Finder` : `Show ${name} in its folder`);
    const go = (what, fail) => real(async () => {
      say(msg, "");
      const r = await send(`${route}/${encodeURIComponent(id)}/${what}`);
      if (!ok(r)) say(msg, r.body?.error || fail, "error");
    });
    open.addEventListener("click", go("open", "Couldn't open it."));
    reveal.addEventListener("click", go("reveal", "Couldn't show it."));
    return [open, reveal];
  }

  // A download's Open, Open in Word (Word-type names) and Show in Finder, plus the helper's answers
  // in the row: 200 { opened } in the row's status line; 428 { confirm } (a program, script or web
  // page) asks there, and Open anyway repeats the POST that asked with { confirm: true }; 409 (e.g.
  // the download mark is gone, or no app) says why, with Show in Finder still there.
  function downloadActs(id, name) {
    const open = button("Open", `Open ${name}`);
    const hint = openHint(name);
    if (hint) open.title = hint;
    const word = WORD.test(name) ? button("Open in Word", `Open ${name} in Word`) : null;
    if (word) word.title = "Opens the original in its default app, for editing";
    const status = el("p", { className: "said" });
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    let asked = "open", from = open; // the route that answered 428 and the button that asked
    const reveal = button(REVEAL, MAC ? `Show ${name} in Finder` : `Show ${name} in its folder`);
    const q = el("p", { id: `dl-q-${id}` });
    const yes = button("Open anyway", `Open ${name} anyway`);
    const no = button("Cancel", `Don't open ${name}`);
    const choice = el("div", { className: "confirm-row" }, yes, no);
    const box = el("div", { className: "confirm", id: `dl-confirm-${id}`, hidden: true }, q, choice);
    box.setAttribute("role", "group");
    box.setAttribute("aria-labelledby", q.id);
    const shut = (refocus) => { const had = box.contains(document.activeElement); box.hidden = true; q.textContent = ""; if (refocus || had) from.focus(); };
    // The box joins the row only once the helper has something to say there.
    const place = () => { if (!box.isConnected) open.closest("li")?.append(box); };
    const answer = (r, btn, what) => {
      if (ok(r)) {
        shut(false);
        const words = typeof r.body?.opened === "string" && Object.hasOwn(OPENED, r.body.opened) ? OPENED[r.body.opened] : "";
        if (words) { unsay(); status.textContent = words; said = status; }
        return;
      }
      if (r.status === 428 && typeof r.body?.confirm === "string" && r.body.confirm) {
        asked = what;
        from = btn;
        place();
        q.textContent = r.body.confirm;
        choice.hidden = false;
        box.hidden = false;
        return no.focus();
      }
      if (r.status === 409 && typeof r.body?.error === "string" && r.body.error) {
        const had = box.contains(document.activeElement);
        place();
        q.textContent = r.body.error;
        choice.hidden = true;
        box.hidden = false;
        if (had) reveal.focus();
        return;
      }
      shut(false);
      say("downloads-msg", r.body?.error || "Couldn't open it.", "error");
    };
    const route = (what) => `downloads/${encodeURIComponent(id)}/${what}`;
    open.addEventListener("click", real(async () => { unsay(); say("downloads-msg", ""); answer(await send(route("open")), open, "open"); }));
    word?.addEventListener("click", real(async () => { unsay(); say("downloads-msg", ""); answer(await send(route("open-app")), word, "open-app"); }));
    yes.addEventListener("click", real(async () => { unsay(); say("downloads-msg", ""); answer(await send(route(asked), "POST", { confirm: true }), from, asked); }));
    no.addEventListener("click", real(async () => { unsay(); shut(true); }));
    box.addEventListener("keydown", (e) => { if (e.key === "Escape" && !choice.hidden) { e.preventDefault(); unsay(); shut(true); } });
    reveal.addEventListener("click", real(async () => {
      unsay();
      say("downloads-msg", "");
      const r = await send(route("reveal"));
      if (!ok(r)) say("downloads-msg", r.body?.error || "Couldn't show it.", "error");
    }));
    return el("span", { className: "acts" }, open, ...(word ? [word] : []), reveal, status);
  }

  // ---- Downloads ----
  const downloadMeta = (it) => [sizeWords(it.size), str(it.from?.host), str(it.by?.label)].filter(Boolean).join(" · ");
  function drawDownload(row, it, id) {
    const li = row.li;
    li.dataset.state = it.state;
    const name = li.querySelector(".name");
    name.textContent = it.name;
    name.title = it.name;
    const meta = li.querySelector(".meta");
    meta.textContent = downloadMeta(it);
    meta.title = str(it.from?.title);
    li.querySelector(".state .word").textContent = STATE[it.state];
    const acts = li.querySelector(".acts");
    if (it.state === "done" && !acts) li.append(downloadActs(id, it.name));
    else if (it.state !== "done" && acts) { if (said && acts.contains(said)) said = null; acts.remove(); li.querySelector(".confirm")?.remove(); }
  }
  const downloads = makeList({
    ul: $("downloads"),
    newest: true,
    valid: (it) => typeof it.name === "string" && !!it.name && Object.hasOwn(STATE, it.state),
    fallback: () => $("sec-downloads").querySelector(".disclose"),
    build: (row, it, id) => {
      const label = str(it.by?.label);
      const li = el("li", { className: label ? "tool" : "tool bare" });
      if (label) {
        const name = splitLabel(label).name;
        const face = avatar(name, it.by?.color);
        face.setAttribute("aria-hidden", "true");
        face.title = name;
        li.append(face);
      }
      const dot = el("i", { className: "sd" });
      dot.setAttribute("aria-hidden", "true");
      li.append(el("div", { className: "head" }, el("strong", { className: "name" }), el("small", { className: "meta" })),
        el("span", { className: "state" }, dot, el("span", { className: "word" })));
      row.li = li;
      drawDownload(row, it, id);
      return li;
    },
    update: drawDownload,
    changed: () => { if (downloads) $("downloads-empty").hidden = downloads.rows.size > 0; },
  });

  // ---- Recordings ----
  const recordingMeta = (it) => [durationWords(it.duration), sizeWords(it.size), timeOf(it.at) !== null ? shortClock(timeOf(it.at)) : ""].filter(Boolean).join(" · ");
  const recordings = makeList({
    ul: $("recordings"),
    newest: true,
    valid: (it) => typeof it.name === "string" && !!it.name,
    fallback: () => $("sec-recordings").querySelector(".disclose"),
    build: (row, it, id) => {
      const name = it.name;
      const del = button("Delete", `Delete ${name}`, "act bad");
      const q = el("p", { id: `rec-q-${id}`, textContent: `Delete ${name} from your Downloads folder?` });
      const yes = button("Delete", `Delete ${name} now`, "act bad");
      const keep = button("Keep", `Keep ${name}`);
      keep.id = `rec-keep-${id}`;
      const box = el("div", { className: "confirm", id: `rec-confirm-${id}`, hidden: true }, q, el("div", { className: "confirm-row" }, yes, keep));
      box.setAttribute("role", "group");
      box.setAttribute("aria-labelledby", q.id);
      del.setAttribute("aria-expanded", "false");
      del.setAttribute("aria-controls", box.id);
      // A dock slot has no confirm(): the question in the row, focus on Keep (a second Enter keeps it).
      const ask = (open, refocus) => {
        box.hidden = !open;
        del.setAttribute("aria-expanded", String(open));
        if (open) keep.focus(); else if (refocus) del.focus();
      };
      del.addEventListener("click", () => ask(box.hidden, false));
      keep.addEventListener("click", () => ask(false, true));
      box.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); ask(false, true); } });
      yes.addEventListener("click", real(async () => {
        say("recordings-msg", "");
        const shownName = row.item.name;
        const r = await send(`recordings/${encodeURIComponent(id)}`, "DELETE");
        if (ok(r)) { recordings.remove(id); return say("recordings-msg", `Deleted ${shownName}.`, "ok"); }
        if (r.status === 404) { recordings.remove(id); return say("recordings-msg", "That recording is no longer there."); }
        say("recordings-msg", r.body?.error || "Couldn't delete it.", "error");
      }));
      return el("li", { className: "tool bare rec" },
        el("div", { className: "head" }, el("strong", { className: "name", textContent: name, title: name }), el("small", { className: "meta", textContent: recordingMeta(it) })),
        el("span", { className: "acts" }, ...fileActs("recordings", id, name, "recordings-msg"), del),
        box);
    },
    update: (row, it) => { row.li.querySelector(".meta").textContent = recordingMeta(it); },
    changed: () => { if (recordings) $("recordings-empty").hidden = !recordings.loaded || recordings.rows.size > 0; },
  });

  // ---- reading the lists ----
  const LISTS = [
    { L: handoffs, route: "handoffs.json",
      found: () => { $("sec-handoffs").hidden = false; },
      absent: () => { $("sec-handoffs").hidden = true; } },
    { L: downloads, route: "downloads.json",
      found: () => { $("sec-downloads").hidden = false; },
      absent: () => { $("sec-downloads").hidden = true; } },
    { L: recordings, route: "recordings.json",
      found: (body) => {
        $("recordings").hidden = false;
        const rec = body?.recording;
        if (rec && typeof rec === "object") onRecording({ on: !!rec.on, since: Number(rec.since) || Date.now() });
      },
      absent: () => { $("recordings").hidden = true; $("recordings-empty").hidden = true; } },
  ];
  async function load(s, from) {
    const g = gen;
    s.L.busy = true;
    const r = await getJson(from, s.route);
    if (g !== gen || base() !== from) {
      // A newer connection meanwhile: its own read follows.
      if (g !== gen && base() === from) { s.L.busy = false; s.L.pending = []; stale = true; show(); }
      return;
    }
    s.L.busy = false;
    const pending = s.L.pending;
    s.L.pending = [];
    if (r.status === 200 && r.body && typeof r.body === "object") {
      s.L.loaded = true;
      s.found(r.body);
      s.L.replace(r.body.items);
      for (const apply of pending) apply();
    } else if (r.status === 404) {
      // This helper has no such route: asked no more on this connection.
      s.L.loaded = true;
      s.L.replace([]);
      s.absent();
    } else stale = true; // not reached: the next show reads again
  }

  // The Tools tab came into view (the tab, the page or the dock).
  function show() {
    if (!base() || !shown()) return;
    if (stale) {
      stale = false;
      const from = base();
      for (const s of LISTS) if (!s.L.loaded && !s.L.busy) load(s, from);
    }
    if (!$("diag-body").hidden) diagnostics();
  }
  // The stream went live again: every list is read once more on the next show.
  function markStale() {
    gen++;
    stale = true;
    for (const s of LISTS) { s.L.loaded = false; s.L.busy = false; s.L.pending = []; }
    show();
  }

  // ---- Diagnostics ----
  let diagBusy = false;
  let reportUrl = null;
  // The values, the errors list and its empty line start hidden (index.html): nothing shows
  // before the first answer, and a failed read says so in #diag-msg.
  function diagNone(on) {
    $("diag-none").hidden = !on;
    for (const id of ["diag", "diag-errors-head", "diag-errors", "diag-prepare"]) $(id).hidden = on;
    if (on) { $("diag-errors-empty").hidden = true; $("diag-report-box").hidden = true; }
  }
  function drawDiagnostics(d) {
    const h = d.helper && typeof d.helper === "object" ? d.helper : null;
    const helper = h ? [str(h.version), has(h, "node") && str(h.node) ? `Node ${str(h.node)}` : "", uptimeWords(h.uptime) ? `up ${uptimeWords(h.uptime)}` : ""].filter(Boolean).join(" · ") : "";
    const b = d.browser && typeof d.browser === "object" ? d.browser : null;
    let browser = "";
    if (b && (str(b.engine) || str(b.version))) {
      browser = [ENGINE[b.engine] || "Browser", str(b.version)].filter(Boolean).join(" ");
      if (str(b.build)) browser += ` (build ${str(b.build)})`;
    }
    const c = d.connections && typeof d.connections === "object" ? d.connections : null;
    const conn = c ? [["agents", "agent"], ["viewers", "viewer"], ["joiners", "joiner"], ["streams", "stream"]]
      .filter(([k]) => Number.isFinite(c[k])).map(([k, w]) => plural(c[k], w)).join(" · ") : "";
    const joined = Array.isArray(d.joined)
      ? (d.joined.map((p) => { const l = str(p?.label); return l ? (str(p.role) ? `${l} (${str(p.role)})` : l) : ""; }).filter(Boolean).join(", ") || "Nobody")
      : "";
    $("diag-helper").textContent = helper || "Not reported";
    $("diag-browser").textContent = browser || "Not reported";
    $("diag-conn").textContent = conn || "Not reported";
    $("diag-joined").textContent = joined || "Not reported";
    const errors = (Array.isArray(d.errors) ? d.errors : []).filter((e) => e && typeof e === "object" && str(e.text))
      .map((e, i) => ({ e, i, t: timeOf(e.at) ?? 0 })).sort((a, b) => (b.t - a.t) || (b.i - a.i)).slice(0, 20);
    $("diag-errors").replaceChildren(...errors.map(({ e, t }) => {
      const kids = [];
      if (t) kids.push(el("time", { textContent: shortClock(t), dateTime: new Date(t).toISOString() }), " ");
      if (str(e.where)) kids.push(el("strong", { textContent: str(e.where) }), " ");
      kids.push(el("span", { textContent: str(e.text) }));
      return el("li", {}, ...kids);
    }));
    $("diag-errors-empty").hidden = errors.length > 0;
  }
  async function diagnostics() {
    if (!base() || !shown() || $("diag-body").hidden || diagBusy) return;
    diagBusy = true;
    const from = base(), g = gen;
    const r = await getJson(from, "diagnostics.json");
    diagBusy = false;
    if (base() !== from || g !== gen) return;
    if (r.status === 404) return diagNone(true);
    if (r.status !== 200 || !r.body || typeof r.body !== "object") return say("diag-msg", "Couldn't read diagnostics from PairBrowse. Try Refresh.", "error");
    diagNone(false);
    say("diag-msg", "");
    drawDiagnostics(r.body);
  }
  $("diag-refresh").addEventListener("click", () => diagnostics());
  $("diag-prepare").addEventListener("click", async () => {
    const btn = $("diag-prepare");
    if (btn.disabled || !base()) return;
    const had = document.activeElement === btn;
    btn.disabled = true;
    say("diag-msg", "");
    const r = await send("diagnostics/report");
    btn.disabled = false;
    if (r.status === 200 && typeof r.body?.text === "string") {
      const box = $("diag-report");
      box.value = r.body.text;
      $("diag-report-box").hidden = false;
      box.focus();
      return;
    }
    if (had) btn.focus();
    say("diag-msg", r.body?.error || "Couldn't prepare the report.", "error");
  });
  $("diag-copy").addEventListener("click", async () => {
    const box = $("diag-report");
    try {
      await navigator.clipboard.writeText(box.value);
      say("diag-msg", "Copied.", "ok");
    } catch {
      box.focus();
      box.select();
      say("diag-msg", `Copy it with ${MAC ? "Cmd" : "Ctrl"}+C.`, "error");
    }
  });
  // Save: the report's text as a file, made in the page (a blob: link); no request anywhere.
  $("diag-save").addEventListener("click", () => {
    const value = $("diag-report").value;
    const d = new Date();
    const name = `pairbrowse-diagnostics-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
    if (reportUrl) URL.revokeObjectURL(reportUrl);
    reportUrl = URL.createObjectURL(new Blob([value], { type: "text/plain;charset=utf-8" }));
    el("a", { href: reportUrl, download: name }).click();
    say("diag-msg", "Saved to your Downloads folder.", "ok");
  });

  // Another helper: nothing of the last one's stays on screen as if current.
  function forget() {
    gen++;
    said = null;
    stale = true;
    for (const s of LISTS) s.L.clear();
    $("sec-handoffs").hidden = true;
    $("sec-downloads").hidden = true;
    $("recordings").hidden = true;
    $("recordings-empty").hidden = true;
    for (const id of ["handoffs-msg", "downloads-msg", "recordings-msg", "diag-msg"]) say(id, "");
    for (const id of ["diag-helper", "diag-browser", "diag-conn", "diag-joined"]) $(id).textContent = "Not reported";
    $("diag-errors").replaceChildren();
    $("diag-errors-empty").hidden = false;
    diagNone(false);
    $("diag-report").value = "";
    $("diag-report-box").hidden = true;
    if (reportUrl) URL.revokeObjectURL(reportUrl);
    reportUrl = null;
    diagBusy = false;
  }

  return {
    show,
    stale: markStale,
    forget,
    // { op: add | update, item }
    downloads: (ev) => { if (ev?.item && (ev.op === "add" || ev.op === "update")) downloads.event(() => downloads.upsert(ev.item)); },
    // { op: add, item } | { op: remove, item: { id } }
    handoffs: (ev) => {
      if (ev?.op === "add" && ev.item) handoffs.event(() => handoffs.upsert(ev.item));
      else if (ev?.op === "remove" && idOf(ev.item?.id)) handoffs.event(() => handoffs.remove(idOf(ev.item.id)));
    },
    // A recording just saved (record { op: "saved", item }): first in the list.
    saved: (item) => recordings.event(() => recordings.upsert(item, true)),
    diagnostics,
  };
}
