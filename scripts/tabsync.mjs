// Same tabs: how joining works. The joiner's own PairBrowse browser opens the host's tabs and
// keeps following them; a drive joiner's own changes in those tabs go back to the host's browser.
// Only tab addresses (and titles and activity lines to show) cross, never cookies, storage,
// passwords or remembered details, and never a picture of the page: each person stays signed in
// as themselves, in their own browser. Also crossing: what is typed in the shared tabs' form fields
// (sensitive ones only as "filled", never their values), the tabs' order, the agents in them
// (their spark colors) and everyone's mouse pointer (a position, nothing under it).
//
// This file has no side effects: which addresses may cross, the requests' limits, and the
// bookkeeping that keeps an update applied on one side from bouncing back.
import { SENSITIVE, looksLikeCard } from "./policy.mjs";
import { isLocalNetwork } from "./guard.mjs";
import { stripText } from "./join.mjs";

export const TABS_MAX = 40; // tabs that cross, in order
export const URL_MAX = 2048;
export const OPS_MAX = 20; // changes in one request from a drive joiner
export const ACTIVITY_MAX = 12; // activity lines that cross
const TEXT_MAX = 200;
const ID = /^[0-9a-f]{8}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const REF = /^[a-z0-9]{1,16}$/;
// Query parameters that sign someone in or confirm something, besides SENSITIVE's.
const CREDENTIAL = /auth|key|sig|session|sid$|state|nonce|ticket|jwt|saml|assertion|credential|login|magic|invite|reset|verif|confirm|email|mail|phone/i;
// Values that look like a secret: an email address, a JWT, or a long run of letters and digits.
const secretish = (v) => /@|%40/.test(v) || /^eyJ/.test(v) || [...String(v).matchAll(/[A-Za-z0-9_~+/=-]{24,}/g)].some(([m]) => /\d/.test(m) && /[A-Za-z]/.test(m));
const clean = (s, max = TEXT_MAX) => stripText(String(s ?? "")).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, max);

// Addresses on someone's own computer or network: the local-network rule, plus single-label
// names ("router") and IPv6 literals.
export function localAddress(u) {
  const host = u.hostname.toLowerCase();
  return isLocalNetwork(u.href) || host.startsWith("[") || !host.includes(".") || host.endsWith(".");
}

// A tab's address as it may cross, or null when the tab doesn't cross at all: http(s) only, no
// user:pass@, nothing local. full (a drive session): the query string too, minus parameters that
// look like sign-in links, one-time codes or personal details, and "#/route" fragments; else, and
// on secretDomains (sites the sender keeps passwords for), origin + path only.
export function shareableUrl(raw, { full = false, secretDomains = [] } = {}) {
  let u;
  try { u = new URL(String(raw ?? "")); } catch { return null; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || localAddress(u)) return null;
  const host = u.hostname.toLowerCase();
  const base = u.origin + u.pathname;
  if (base.length > URL_MAX) return null;
  if (!full || secretDomains.some((d) => d && (host === d || host.endsWith(`.${d}`)))) return base;
  const keep = [...u.searchParams].filter(([k, v]) => !SENSITIVE.test(k) && !CREDENTIAL.test(k) && !secretish(v));
  let out = base + (keep.length ? `?${new URLSearchParams(keep)}` : "");
  if (/^#!?\/[^=&@]*$/.test(u.hash) && !secretish(u.hash)) out += u.hash;
  return out.length <= URL_MAX ? out : base;
}

export const onSecretDomain = (raw, secretDomains = []) => {
  try { const host = new URL(String(raw)).hostname.toLowerCase(); return secretDomains.some((d) => d && (host === d || host.endsWith(`.${d}`))); } catch { return false; }
};

// The host's side: what one joiner gets. tabs: [{ id, url, title, agent, person, did }] in order
// (agent: the agent's label holding it; person: who uses it by hand right now; did: [{ n, who,
// line }], what people did there: field and button names, never values). activity: [{ t, text,
// who, tabId, from }]; people: who is in the session (labels). Nothing about a tab that doesn't
// cross; on secretDomains, nothing but the address; and nothing that came from this joiner.
export function stateForJoiner({ tabs = [], activity = [], people = [] }, { drive = false, secretDomains = [], name = "", from = "" } = {}) {
  const out = [];
  const quiet = new Set(); // tabs that cross as addresses only
  for (const t of tabs) {
    const url = shareableUrl(t.url, { full: drive, secretDomains });
    if (!url || out.length >= TABS_MAX) continue;
    if (onSecretDomain(t.url, secretDomains)) { quiet.add(t.id); out.push({ id: t.id, url }); continue; }
    const did = (Array.isArray(t.did) ? t.did : []).filter((e) => e.who !== name).slice(-10).map((e) => ({ n: Number(e.n) || 0, who: clean(e.who, 60), line: clean(e.line, 80) }));
    out.push({ id: t.id, url, title: clean(t.title), ...(t.agent ? { agent: clean(t.agent, 60), ...(COLOR.test(t.color || "") ? { color: t.color } : {}) } : {}), ...(t.person && t.person !== name ? { person: clean(t.person, 60), ...(t.acting ? { acting: true } : {}) } : {}), ...(did.length ? { did } : {}) });
  }
  const shared = new Set(out.map((t) => t.id).filter((id) => !quiet.has(id)));
  return {
    tabs: out,
    // Activity in tabs that don't cross stays home, and so does the tab it happened in.
    activity: activity.filter((a) => (!a.tabId || shared.has(a.tabId)) && (!from || a.from !== from)).slice(-ACTIVITY_MAX)
      .map((a) => ({ t: Number(a.t) || 0, text: clean(a.text), who: clean(a.who, 60), ...(a.tabId ? { tabId: a.tabId } : {}) })),
    people: people.filter((p) => p && p !== name).slice(0, 20).map((p) => clean(p, 60)),
  };
}

// The host's side: a drive joiner's changes, checked. ids: the tab ids the joiner may know.
// Returns { ops } or { problem }. Every address passes shareableUrl, so a joiner never opens a
// local-network address, a file or a browser page in the host's browser.
export function readOps(body, ids) {
  if (!Array.isArray(body?.ops) || body.ops.length > OPS_MAX) return { problem: `Send at most ${OPS_MAX} changes at a time.` };
  const ops = [];
  for (const o of body.ops) {
    const op = o?.op;
    if (op === "close" && ids.has(o.id)) { ops.push({ op, id: o.id }); continue; }
    // A person used their copy of the tab (field and button names only), or their agent did something there.
    // acting: they click, type or scroll there now (only moving the pointer holds nobody up).
    if (op === "person" && ids.has(o.id)) { ops.push({ op, id: o.id, did: (Array.isArray(o.did) ? o.did : []).slice(0, 10).map((x) => clean(x, 80)).filter(Boolean), acting: o.acting === true }); continue; }
    if (op === "activity" && ids.has(o.id) && o.text) { ops.push({ op, id: o.id, text: clean(o.text), who: clean(o.who, 60) }); continue; }
    // Their agent in a tab (its spark color), or none any more.
    if (op === "agent" && ids.has(o.id)) { ops.push({ op, id: o.id, who: clean(o.who, 60), color: COLOR.test(o.color || "") ? o.color : "" }); continue; }
    // Their tab order: the known ids, as they now stand.
    if (op === "order" && Array.isArray(o.ids)) { ops.push({ op, ids: [...new Set(o.ids.filter((id) => ids.has(id)))].slice(0, TABS_MAX) }); continue; }
    // Values typed there (checked again here: sensitive ones never carry a value).
    if (op === "form" && ids.has(o.id)) {
      const form = readForm(o);
      if (!form) return { problem: "Refused: a form update too large or malformed." };
      ops.push({ op, id: o.id, ...form });
      continue;
    }
    if (op !== "navigate" && op !== "open") return { problem: "Unknown change." };
    const url = shareableUrl(o?.url, { full: true });
    if (!url) return { problem: "Refused: only public web addresses (http or https, not on someone's local network) cross between browsers." };
    if (op === "navigate" && ids.has(o.id)) ops.push({ op, id: o.id, url });
    else if (op === "open" && REF.test(String(o.ref))) ops.push({ op, ref: o.ref, url });
    else return { problem: "Unknown change." };
  }
  return { ops };
}

// The joiner's side: the bookkeeping per shared tab (by the host's tab id).
// - From the host: a tab is opened, navigated or closed here only when the host's address for it
//   changed since the last one seen (or it's new or gone).
// - From here (drive only): a change counts once the tab settled after the last update applied
//   from the host (redirects and the page's own address changes are absorbed into the baseline),
//   and only when it differs from both that baseline and the host's address. So an applied update
//   never goes back; a tab that keeps bouncing anyway (a site sending each side elsewhere) stops
//   sending for a while.
export function createMirror({ now = () => Date.now(), settleMs = 2500, staleMs = 5000, bounceMax = 6, bounceMs = 30_000 } = {}) {
  const links = new Map(); // id -> { remote, baseline, settleUntil, stale, staleUntil, sends, closedHere }
  let refSeq = 0;
  const link = (id, url) => {
    const l = { remote: url, baseline: undefined, settleUntil: now() + settleMs, stale: null, staleUntil: 0, sends: [], closedHere: false };
    links.set(id, l);
    return l;
  };
  return {
    links,
    // The host's tabs (already filtered by the host; checked again: never trust the other side).
    // local: the ids with a live tab here. Returns { open: [{ id, url }], navigate: [...], close: [id] }.
    fromHost(tabs, local) {
      const plan = { open: [], navigate: [], close: [] };
      const seen = new Set();
      for (const t of (Array.isArray(tabs) ? tabs : []).slice(0, TABS_MAX)) {
        const url = shareableUrl(t?.url, { full: true });
        if (!ID.test(String(t?.id)) || !url || seen.has(t.id)) continue;
        seen.add(t.id);
        const l = links.get(t.id);
        if (!l) { link(t.id, url); plan.open.push({ id: t.id, url }); continue; }
        if (url === l.remote) { if (!l.closedHere && !local.has(t.id)) l.closedHere = true; continue; }
        // The host hasn't applied our change yet: its older address isn't news.
        if (url === l.stale && now() < l.staleUntil) continue;
        l.remote = url;
        l.settleUntil = now() + settleMs;
        if (l.closedHere || !local.has(t.id)) { l.closedHere = false; plan.open.push({ id: t.id, url }); } else plan.navigate.push({ id: t.id, url });
      }
      for (const id of [...links.keys()]) if (!seen.has(id)) { links.delete(id); if (local.has(id)) plan.close.push(id); }
      return plan;
    },
    // An update from the host was applied to the tab here: its own redirects come next.
    applied(id) { const l = links.get(id); if (l) { l.settleUntil = now() + settleMs; l.baseline = undefined; } },
    // The tab's address here now (shareableUrl'd, or null). Returns a change to send, or null.
    fromLocal(id, url) {
      const l = links.get(id);
      if (!l || l.closedHere) return null;
      if (now() < l.settleUntil || l.baseline === undefined) { l.baseline = url; return null; }
      if (url === l.baseline) return null;
      l.baseline = url;
      if (!url || url === l.remote) return null;
      const t = now();
      l.sends = l.sends.filter((s) => s > t - bounceMs);
      if (l.sends.length >= bounceMax) return null;
      l.sends.push(t);
      l.stale = l.remote;
      l.staleUntil = t + staleMs;
      l.remote = url;
      return { op: "navigate", id, url };
    },
    // The tab here was closed by hand (a drive joiner sends the returned change).
    closedHere(id) { const l = links.get(id); if (!l) return null; l.closedHere = true; return { op: "close", id }; },
    // A new tab opened here from a shared one (a drive joiner sends it; the host answers its id).
    opening(url) { return { op: "open", ref: `n${++refSeq}`, url }; },
    opened(id, url) { if (!ID.test(String(id))) return false; const l = link(id, url); l.baseline = url; return true; },
  };
}

// ---- Form values ----
// What is typed in a shared tab shows in the same field of the same tab on the other side. A
// field is found by its frame and a stable key (id, name, label or position); a value applies
// only on the same page (origin and path). Sensitive fields (passwords, card numbers, codes,
// IBAN, SSN, a saved password's value...) cross as "filled" or "empty", never with their value.
export const FIELDS_MAX = 100; // fields per tab
export const VALUE_MAX = 1000; // characters per value
const KEY_MAX = 200;
const FIELD_TYPES = new Set(["text", "search", "email", "url", "tel", "number", "date", "datetime-local", "month", "week", "time", "color", "range", "textarea", "select", "checkbox", "radio", "password", ""]);
// Hints (label, name, id, autocomplete, placeholder) of fields whose values never cross.
const SENSITIVE_HINT = /cc-|one-time-code|current-password|new-password|\bcsc\b|\bcvn\b|\bsecurity\b/i;
const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
const SSN = /^\d{3}-?\d{2}-?\d{4}$/;
const sameDoc = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; } catch { return false; } };
// A page's address as a form's key: origin and path.
export const formUrl = (raw) => { try { const u = new URL(String(raw)); return /^https?:$/.test(u.protocol) ? u.origin + u.pathname : null; } catch { return null; } };

// Whether a field's value must stay on this side: by its kind and hints, or because the value
// looks like a card number, IBAN, SSN, a token, or is (or holds) a saved password.
export function sensitiveField({ type = "", hints = "", v = "" }, secretValues = []) {
  if (type === "password" || SENSITIVE.test(hints) || SENSITIVE_HINT.test(hints)) return true;
  const values = Array.isArray(v) ? v : [v];
  return values.some((x) => {
    if (typeof x !== "string" || !x) return false;
    const flat = x.replace(/[\s-]/g, "");
    return looksLikeCard(x) || [...x.matchAll(/\d[\d -]{11,22}\d/g)].some(([m]) => looksLikeCard(m)) || IBAN.test(flat.toUpperCase()) || SSN.test(x.trim()) || /^eyJ/.test(x) ||
      [...x.matchAll(/[A-Za-z0-9_~+/=-]{24,}/g)].some(([m]) => /\d/.test(m) && /[A-Za-z]/.test(m)) ||
      secretValues.some((s) => s && String(s).length >= 4 && x.includes(String(s)));
  });
}

// One field as it may cross, or null. Values are cut to size; anything else is dropped.
function oneField(x, { secretValues = [], trusted = false } = {}) {
  if (!x || typeof x.k !== "string" || !x.k || x.k.length > KEY_MAX || typeof (x.f ?? "") !== "string" || String(x.f ?? "").length > KEY_MAX) return null;
  const t = String(x.t ?? "");
  if (!FIELD_TYPES.has(t)) return null;
  // o: the person who filled it (never a value): agents on both sides leave it to them.
  const base = { f: String(x.f ?? ""), k: x.k, t, ...(x.o ? { o: clean(x.o, 60) } : {}) };
  // From the page (trusted: this side's own reading): judged here. From the other side: a
  // masked field stays masked, and a value that looks sensitive is dropped all the same.
  if (x.m || t === "password" || (trusted && sensitiveField({ type: t, hints: String(x.hints ?? ""), v: x.v }, secretValues))) {
    const filled = trusted ? (Array.isArray(x.v) ? x.v.length > 0 : typeof x.v === "string" ? x.v.length > 0 : !!x.v) : !!x.filled;
    return { ...base, m: 1, filled };
  }
  let v = x.v;
  if (t === "checkbox" || t === "radio") v = !!v;
  else if (t === "select") v = (Array.isArray(v) ? v : [v]).filter((s) => typeof s === "string").slice(0, 50).map((s) => s.slice(0, KEY_MAX));
  else if (typeof v === "string") v = v.slice(0, VALUE_MAX);
  else return null;
  if (!trusted && sensitiveField({ type: t, v }, secretValues)) return { ...base, m: 1, filled: true };
  return { ...base, v };
}

// This side's own reading of a page (scripts/daemon/forms.mjs) as it may cross.
export function shareFields(raw, { secretValues = [] } = {}) {
  return (Array.isArray(raw) ? raw : []).slice(0, FIELDS_MAX).map((x) => oneField(x, { secretValues, trusted: true })).filter(Boolean);
}

// The host's side: a tab's form values for a joiner, or null. Only for a tab that fully crosses
// (a public address, not on the sender's secret domains) and only for the page it shows.
export function formForJoiner(tabUrl, form, { secretDomains = [] } = {}) {
  const shown = shareableUrl(tabUrl, { secretDomains });
  if (!shown || onSecretDomain(tabUrl, secretDomains)) return null;
  const checked = readForm(form);
  return checked && sameDoc(shown, checked.url) ? checked : null;
}

// A form from the other side, checked: { url, fields }, or null.
export function readForm(o) {
  const url = formUrl(o?.url);
  if (!url || !Array.isArray(o?.fields) || o.fields.length > FIELDS_MAX) return null;
  const fields = o.fields.map((x) => oneField(x)).filter(Boolean);
  return { url, fields };
}

const sig = (x) => JSON.stringify(x.m ? ["m", x.filled] : ["v", x.v]);
const fkey = (x) => `${x.f}\u0001${x.k}`;

// The bookkeeping per shared tab that keeps an applied value from going back. known: each
// field's last value seen on both sides (sent from here, or applied here). A field read here
// with another value than known changed here: it's sent. A value from there applies unless the
// field changed here just now (the person typing here wins; their value goes there instead).
export function createFormSync({ now = () => Date.now(), localWinsMs = 1500, sendGapMs = 300 } = {}) {
  const tabs = new Map(); // id -> { url, known: Map, touched: Map, sentAt }
  const pending = new Map(); // id -> { url, fields: Map }: the other side's values, until they apply here
  const tab = (id, url) => {
    let s = tabs.get(id);
    if (!s || s.url !== url) { s = { url, known: new Map(), touched: new Map(), sentAt: s?.sentAt || 0 }; tabs.set(id, s); }
    return s;
  };
  return {
    tabs,
    // This side's reading of tab id at url. Returns the changed fields to send (maybe none).
    local(id, url, fields) {
      if (!url) return [];
      const s = tab(id, url);
      const out = [];
      for (const x of fields) {
        const k = fkey(x);
        const was = s.known.get(k);
        if (was === sig(x)) continue;
        s.known.set(k, sig(x));
        if (was === undefined) continue; // a field as the page loaded (defaults, autofill): not a change made here
        s.touched.set(k, now());
        out.push(x);
      }
      return out.slice(0, FIELDS_MAX);
    },
    // Whether to read tab id again now (at most every sendGapMs).
    maySend(id) { const s = tabs.get(id); if (s && now() - s.sentAt < sendGapMs) return false; if (s) s.sentAt = now(); return true; },
    // A form from the other side (checked with readForm). Kept until it can apply here.
    remote(id, form) {
      if (!form) return;
      let p = pending.get(id);
      if (!p || p.url !== form.url) { p = { url: form.url, fields: new Map() }; pending.set(id, p); }
      for (const x of form.fields) p.fields.set(fkey(x), x);
    },
    // What to apply in tab id, now at url: the other side's values that differ from what's known.
    toApply(id, url) {
      const p = pending.get(id);
      if (!url || !p || p.url !== url) return [];
      const s = tab(id, url);
      const out = [];
      for (const [k, x] of p.fields) {
        if (s.known.get(k) === sig(x)) { p.fields.delete(k); continue; }
        if (now() - (s.touched.get(k) || 0) < localWinsMs) { p.fields.delete(k); continue; }
        out.push(x);
      }
      return out;
    },
    // These fields now show the other side's values here: they never go back.
    applied(id, fields) {
      const s = tabs.get(id);
      const p = pending.get(id);
      for (const x of fields) { s?.known.set(fkey(x), sig(x)); p?.fields.delete(fkey(x)); }
    },
    drop(id) { tabs.delete(id); pending.delete(id); },
  };
}

// ---- Tab order ----
// Whether the ids both lists share stand in the same order.
export function sameOrder(a, b) {
  const inB = new Set(b);
  const inA = new Set(a);
  const x = a.filter((id) => inB.has(id)), y = b.filter((id) => inA.has(id));
  return x.length === y.length && x.every((id, i) => id === y[i]);
}
// The joiner's side: the host's order applies here, and (drive) a move made here goes there.
// baseline: the order here as last arranged or seen; a change from it was made here.
export function createOrderSync({ now = () => Date.now(), holdMs = 5000 } = {}) {
  let host = [], baseline = null, holdUntil = 0;
  return {
    fromHost(ids) { host = ids.filter((id) => ID.test(String(id))).slice(0, TABS_MAX); },
    // The order here now (shared ids, left to right). Returns { send } (a move made here),
    // { arrange } (the host's order to apply here), or {}.
    fromLocal(ids) {
      if (baseline && !sameOrder(ids, baseline) && ids.length === baseline.filter((id) => ids.includes(id)).length) {
        baseline = ids;
        holdUntil = now() + holdMs; // the host hasn't taken it up yet: its older order isn't news
        if (!sameOrder(ids, host)) return { send: { op: "order", ids } };
      }
      baseline = ids;
      if (now() < holdUntil || sameOrder(ids, host)) return {};
      return { arrange: host.filter((id) => ids.includes(id)) };
    },
    arranged(ids) { baseline = ids; },
  };
}

// ---- Pointers ----
// Each side sees the others' mouse pointers (people's and agents') in its own copy of a shared
// tab, at the same place in the document. Only a tab id, a position, a name and a color cross:
// never what is under the pointer, and nothing for tabs on secret domains.
export const POINTER_MAX = 1_000_000;
const coord = (n) => Math.max(0, Math.min(POINTER_MAX, Math.round(Number(n) || 0)));
export function readPointer(p, ids) {
  if (!p || !ids.has(p.id) || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return null;
  return { id: p.id, x: coord(p.x), y: coord(p.y), ...(p.who ? { who: clean(p.who, 60) } : {}), ...(COLOR.test(p.color || "") ? { color: p.color } : {}) };
}
// A joiner's pointers: theirs (me) and their agents' (agents), checked.
export function readPointers(body, ids) {
  return {
    me: readPointer(body?.me, ids),
    agents: (Array.isArray(body?.agents) ? body.agents : []).slice(0, 8).map((p) => readPointer(p, ids)).filter((p) => p && p.who),
  };
}
// A stable color per name, for people's pointers.
const PEOPLE_COLORS = ["#f472b6", "#facc15", "#38bdf8", "#fb923c", "#34d399", "#c084fc"];
export function personColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return PEOPLE_COLORS[h % PEOPLE_COLORS.length];
}
