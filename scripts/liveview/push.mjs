// The host's side of a join code's push channel: one WebSocket (over the sharing tunnel) per
// approved joiner, carrying tiny messages as things happen: the shared tabs,
// form values, pointers, who is doing what, and messages between participants. Nothing is polled
// over the tunnel and nothing is a picture: helper to helper, and page to helper through the page
// script. What may cross is decided in tabsync.mjs, per joiner.
import { shareableUrl, onSecretDomain, readPointers, personColor, formForJoiner, VIEW_FRESH_MS, TABS_MAX } from "../tabsync.mjs";
import { cleanName } from "../join.mjs";

const STATE_DEBOUNCE_MS = 20; // changes that come together go as one
const STATE_AGAIN_MS = 1000; // titles and the like, which no event announces
// While a person uses a shared tab here, the tabs go out again this often even when unchanged:
// the joiner's agents wait while that person is fresh there (2 s after the last word of them).
const PERSON_AGAIN_MS = 900;
const POINTER_MS = 33; // pointers go out at most 30 times a second
const POINTER_FRESH_MS = 3000; // a pointer still for this long fades out
const AGENT_POINTER_MS = 12000; // an agent's stays as long as its cursor here does (hud.js CURSOR_HOLD_MS)
const HEARTBEAT_MS = 1000; // keeps the tunnel from closing an idle stream, and lets a joiner see a stalled one in seconds
// A joiner that answered no ping (their side pongs each one) for this long is gone, even while
// the tunnel keeps the socket open (their helper killed): a slow computer may miss a few.
const SILENT_MS = Number(process.env.PAIRBROWSE_TEST_SILENT_MS) || 10_000;
// A joiner whose channel closed and didn't come back within this is gone. A reconnect takes a
// second or two; one through another tunnel address (relay.mjs, when one went down) a few more,
// so this leaves room for that: the joiner comes back on the same key and nothing is lost.
export const GONE_MS = Number(process.env.PAIRBROWSE_TEST_GONE_MS) || 25_000;
const STREAMS_PER_JOINER = 2;
const FRAME_SKIP_BYTES = 1 << 20; // a joiner this far behind gets no new pictures until it catches up
const STALLED_BYTES = 16 << 20; // this far behind: the stream is cut (the joiner reconnects)
// Logs how long a joiner's pointer took from their page (for the live check).
const latencyLog = process.env.PAIRBROWSE_LATENCY_LOG === "1";

// idOf(page): the tab's id for joiners. tabsFor(j): the shared tabs for joiner j (no form values).
// joinerKey(j). shared: the helper's hooks (see liveview.mjs). tabMeta(page). sessionFor(j): who
// is doing what, as joiner j may see it.
// mapUrl(url): a tab's shared dev server address for its localhost one (devshare.mjs), else null.
// onLost(j): joiner j's channel is gone and didn't come back (their helper died or lost the network).
export function createPush({ getContext, idOf, tabsFor, joinerKey, secretDomains, shared, tabMeta, isIn = () => true, sessionFor = () => null, mapUrl = () => null, onLost = () => {}, log = () => {} }) {
  const streams = new Map(); // conn -> { j, key, conn, stateSig, pointersSig, formSigs: Map id -> sig }
  const lost = new Map(); // joinerKey -> name: channels down but not yet gone (the joiner is moving to another address)
  const forms = new WeakMap(); // tab -> { sig, form, t }
  const hostPointers = new WeakMap(); // tab -> { me, agent }
  const joinerPointers = new Map(); // joinerKey -> { t, list: [{ id, x, y, who, color, k, t }] }
  const joinerViews = new Map(); // joinerKey -> { id, x, y, h, v, who, color, k, t }: where they read
  const drawn = new Set(); // tabs showing joiners' pointers here
  let stateTimer = null, pointerTimer = null, lastPointers = 0;
  let hostView = null; // { page, t }: the tab the host scrolled in last

  const send = (st, event, data) => {
    // A joiner that stopped reading would otherwise collect every picture here in memory.
    const behind = st.conn.buffered || 0;
    if (behind > STALLED_BYTES) { st.conn.close(); streams.delete(st.conn); return; }
    if (behind > FRAME_SKIP_BYTES && event === "screen" && data?.op === "frame") return;
    try { st.conn.send(JSON.stringify({ event, data })); } catch {}
  };
  const active = () => streams.size > 0;

  // The tabs that fully cross (a public address, not on a secret domain): id -> page.
  async function crossing() {
    const ctx = await getContext();
    const out = new Map();
    for (const p of ctx.pages()) {
      if (out.size >= TABS_MAX) break;
      if (!p.isClosed() && shareableUrl(mapUrl(p.url()) || p.url()) && !onSecretDomain(p.url(), secretDomains())) out.set(idOf(p), p);
    }
    return out;
  }

  // ---- tabs ----
  async function pushState() {
    stateTimer = null;
    for (const [conn, st] of streams) {
      if (!isIn(st.key)) { conn.close(); streams.delete(conn); lost.delete(st.key); continue; } // left, revoked
      const state = await tabsFor(st.j).catch(() => null);
      if (!state) continue;
      const sig = JSON.stringify(state);
      const person = Array.isArray(state.tabs) && state.tabs.some((t) => t?.person);
      if (sig !== st.stateSig || (person && Date.now() - st.stateAt >= PERSON_AGAIN_MS)) { st.stateSig = sig; st.stateAt = Date.now(); send(st, "tabs", state); }
      const session = sessionFor(st.j);
      const ssig = JSON.stringify(session);
      if (session && ssig !== st.sessionSig) { st.sessionSig = ssig; send(st, "session", session); }
    }
  }
  const changed = () => { if (active() && !stateTimer) stateTimer = setTimeout(() => pushState().catch((e) => log("push", e?.message || e)), STATE_DEBOUNCE_MS); };
  const again = setInterval(changed, STATE_AGAIN_MS);
  again.unref();

  // ---- form values ----
  // A form is read when the page says a field changed (and on connect); each joiner gets it if
  // that tab fully crosses for them and it differs from what they last got.
  const reading = new WeakMap(); // tab -> promise
  async function readForm(page) {
    if (reading.get(page)) { reading.set(page, "again"); return; }
    reading.set(page, true);
    try {
      do {
        reading.set(page, true);
        const t = Date.now();
        const form = await shared.readForm(page).catch(() => null);
        const sig = JSON.stringify(form);
        const prev = forms.get(page);
        if (!prev || prev.sig !== sig) { forms.set(page, { sig, form, t }); pushForm(page); }
      } while (reading.get(page) === "again");
    } finally {
      reading.delete(page);
    }
  }
  function pushForm(page, only = null) {
    const f = forms.get(page);
    if (!f?.form || page.isClosed()) return;
    const id = idOf(page);
    for (const st of only ? [only] : streams.values()) {
      const shown = mapUrl(f.form.url);
      const form = formForJoiner(mapUrl(page.url()) || page.url(), shown ? { ...f.form, url: shown } : f.form, { secretDomains: secretDomains() });
      if (!form) continue;
      const sig = JSON.stringify(form);
      if (st.formSigs.get(id) === sig) continue;
      st.formSigs.set(id, sig);
      send(st, "form", { id, ...form, t: f.t });
    }
  }

  // ---- pointers ----
  function pointersFor(st, pages) {
    const out = [];
    const fresh = (p) => p && Date.now() - Number(p.t) < POINTER_FRESH_MS;
    for (const [id, page] of pages) {
      const r = hostPointers.get(page);
      if (fresh(r?.me)) out.push({ id, x: r.me.x, y: r.me.y, t: r.me.t, who: shared.host || "Host", color: personColor(shared.host || "Host"), k: "host" });
      if (r?.view && Date.now() - Number(r.view.t) < VIEW_FRESH_MS && !(hostView && hostView.page !== page && hostView.t > r.view.t)) out.push({ id, x: 0, y: r.view.y, h: r.view.h, v: 1, t: r.view.t, who: shared.host || "Host", color: personColor(shared.host || "Host"), k: "host-view" });
      let meta = {};
      try { meta = tabMeta(page) || {}; } catch {}
      if (r?.agent && Date.now() - Number(r.agent.t) < AGENT_POINTER_MS && meta.agent && !meta.agent.joined) out.push({ id, x: r.agent.x, y: r.agent.y, t: r.agent.t, who: meta.agent.label, color: meta.agent.color || "#e9763f", k: `host-agent:${id}` });
    }
    for (const [key, e] of joinerPointers) if (key !== st.key && Date.now() - e.t < POINTER_FRESH_MS) out.push(...e.list);
    for (const [key, v] of joinerViews) if (key !== st.key && pages.has(v.id) && Date.now() - v.t < VIEW_FRESH_MS) out.push(v);
    // Shared browser mode: their page shows the picture of the tab, so pointers go as places in
    // the tab's view (fractions), drawn over it.
    if (st.j?.invite?.mode === "shared" && shared.toView) {
      for (const p of out) { if (p.v) continue; const at = shared.toView(pages.get(p.id), p.x, p.y); if (at) Object.assign(p, at); }
    }
    return out;
  }
  async function pushPointers() {
    pointerTimer = null;
    lastPointers = Date.now();
    const pages = await crossing();
    for (const st of streams.values()) {
      const list = pointersFor(st, pages);
      const sig = JSON.stringify(list.map(({ t, ...p }) => p));
      if (sig === st.pointersSig) continue;
      st.pointersSig = sig;
      send(st, "pointers", list);
    }
    // Joiners' pointers, drawn in this browser's tabs.
    const byPage = new Map();
    for (const [key, e] of joinerPointers) {
      if (Date.now() - e.t > POINTER_FRESH_MS * 3) { joinerPointers.delete(key); continue; }
      for (const p of e.list) { const page = pages.get(p.id); if (page) byPage.set(page, [...(byPage.get(page) || []), p]); }
    }
    for (const [key, v] of joinerViews) {
      if (Date.now() - v.t > VIEW_FRESH_MS || !isIn(key)) { joinerViews.delete(key); continue; }
      const page = pages.get(v.id);
      if (page) byPage.set(page, [...(byPage.get(page) || []), v]);
    }
    for (const page of drawn) if (!byPage.has(page) && !page.isClosed()) shared.showPointers(page, []);
    drawn.clear();
    for (const [page, list] of byPage) { drawn.add(page); shared.showPointers(page, list.map(({ k, who, color, x, y, v, h }) => ({ k, who, color, x, y, ...(v ? { v: 1, h } : {}) }))); }
  }
  const pointersChanged = () => {
    if (pointerTimer) return;
    pointerTimer = setTimeout(() => pushPointers().catch((e) => log("push", e?.message || e)), Math.max(0, POINTER_MS - (Date.now() - lastPointers)));
  };

  return {
    active,
    changed,
    // The joiner whose channel is down but not yet gone (their helper is moving to another
    // address): their name, or null. The host's agents hold their tab work meanwhile (serve.mjs);
    // except: a joiner key not to count (that joiner's own forwarded calls never wait for it).
    reconnecting: (except = null) => {
      for (const [key, name] of lost) {
        if (!isIn(key)) { lost.delete(key); continue; } // left or taken out since: gone, not reconnecting
        if (key !== except) return name;
      }
      return null;
    },
    // An approved joiner's channel opens: everything as it stands now, then changes.
    async open(j, conn) {
      const key = joinerKey(j);
      const mine = [...streams.values()].filter((x) => x.key === key);
      if (mine.length >= STREAMS_PER_JOINER) { mine[0].conn.close(); streams.delete(mine[0].conn); }
      const st = { j, key, conn, openedAt: Date.now(), stateSig: "", stateAt: 0, sessionSig: "", pointersSig: "", formSigs: new Map() };
      streams.set(conn, st);
      lost.delete(key);
      // The joiner counts as there while it answers the pings (a pong to each); an open socket
      // alone says nothing behind a tunnel. The heartbeat also keeps the tunnel from closing it.
      const seen = setInterval(() => { if (Date.now() - (conn.heard ?? Date.now()) > SILENT_MS) conn.close(); else j.seen = Date.now(); }, 2000);
      const beat = setInterval(() => { send(st, "ping", Date.now()); try { conn.ping?.(); } catch {} }, HEARTBEAT_MS);
      seen.unref?.(); beat.unref?.();
      conn.onClose(() => {
        clearInterval(seen); clearInterval(beat); streams.delete(conn);
        log(`push: ${j.name}'s channel closed after ${Math.round((Date.now() - st.openedAt) / 1000)} s; ${[...streams.values()].filter((x) => x.key === key).length} of theirs still open`);
        // Down but still in: reconnecting. A joiner who left or was taken out is just gone.
        if (isIn(key) && ![...streams.values()].some((x) => x.key === key)) lost.set(key, j.name);
        const gone = setTimeout(() => { if (![...streams.values()].some((x) => x.key === key)) { lost.delete(key); try { onLost(j); } catch (e) { log("push", e?.message || e); } } }, GONE_MS);
        gone.unref?.();
      });
      await pushState();
      for (const page of (await crossing()).values()) { if (!forms.has(page)) await readForm(page); else pushForm(page, st); }
      pointersChanged();
    },
    // A joiner's stream ends with their invite or approval.
    end(key) { lost.delete(key); for (const [conn, st] of streams) if (st.key === key) { conn.close(); streams.delete(conn); } },
    // From the page script (daemon/cobrowse.mjs): a field changed; the person or agent pointed.
    dirty(page) { if (active()) readForm(page).catch(() => {}); },
    // A field's plain value as last shared from this tab (frame and key), or undefined.
    sharedValue(page, f, k) { const x = forms.get(page)?.form?.fields?.find((y) => y.f === f && y.k === k); return x && !x.m && typeof x.v === "string" ? x.v : undefined; },
    // An agent's cursor moved here: its pointer goes out now, the person's and their view stay.
    agentPointed(page, agent) {
      hostPointers.set(page, { ...(hostPointers.get(page) || {}), agent });
      if (active()) pointersChanged();
    },
    pointed(page, value) {
      hostPointers.set(page, value);
      // The host reads in one tab at a time: the one they scrolled in last.
      if (value?.view && (!hostView || value.view.t > hostView.t)) hostView = { page, t: value.view.t };
      if (active()) pointersChanged();
    },
    // A joiner's pointers ({ me, agents }); they move or pause nothing.
    async fromJoiner(body, j) {
      const pages = await crossing();
      const { me, agents, view } = readPointers(body, new Set(pages.keys()));
      const key = joinerKey(j);
      const t = Number(body?.t) > 0 ? Math.min(Date.now(), Number(body.t)) : Date.now();
      const list = [];
      if (me) list.push({ ...me, t, who: cleanName(j.name), color: personColor(j.name), k: `${key}:me` });
      agents.forEach((a, i) => list.push({ ...a, t, color: a.color || "#e9763f", k: `${key}:a${i}` }));
      joinerPointers.set(key, { t: Date.now(), list });
      // Where they read stays shown while they stay put (a pointer fades after a few seconds).
      if (view) { const was = joinerViews.get(key); joinerViews.set(key, { ...view, who: cleanName(j.name), color: personColor(j.name), k: `${key}:view`, t: was && was.id === view.id && was.y === view.y && was.h === view.h ? was.t : Date.now() }); }
      else if (body && "view" in body) joinerViews.delete(key);
      if (latencyLog && me) log(`latency pointer-in ${Date.now() - t} ms`);
      pointersChanged();
      return { ok: true };
    },
    // Something for everyone (or one joiner): who does what, a message.
    broadcast(event, data, { to = null, except = null } = {}) {
      for (const st of streams.values()) if ((!to || st.key === to) && st.key !== except) send(st, event, data);
    },
    forgetForm: (page) => forms.delete(page),
    close() { clearInterval(again); clearTimeout(stateTimer); clearTimeout(pointerTimer); for (const conn of streams.keys()) conn.close(); streams.clear(); },
  };
}
