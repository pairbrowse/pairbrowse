// Shared by the side panel, the browser's own pages (the strip, the docks, the timeline, the
// approval bubble, settings), the new tab page and the live view (which serves this file from
// here: an extension can load only its own files). It also holds helperStream, the one owner
// event stream those pages share per origin. The live view's server imports it in tests, so
// this module must stay free of side effects: definitions only, nothing runs on import. The words
// and colors the helper shares with the pages are in vocab.js, the browser's own addresses in
// urls.js (addressToUrl, servedByBrowser), re-exported here.
import { STATE_WORDS, PAGE_KINDS, isColor } from "./vocab.js";
import { SHARED_STREAM_EVENTS, DELTA_EVENTS, OWN_EVENTS } from "./events.js";
import { addressToUrl, servedByBrowser, REPORT_URL, TOP_CHROME_HOST, ownPage } from "./urls.js";
import { postJson, UNREACHABLE_RETRY, UNREACHABLE } from "./helper.js";
export { STATE_WORDS, isColor, addressToUrl, servedByBrowser, REPORT_URL };
import { $, el } from "./dom.js";
export * from "./dom.js";
import { leave, busy } from "./motion.js";
export * from "./motion.js";
import { rich } from "./words.js";
export * from "./words.js";

// A request row's failure, said in the row (DESIGN.md Part I: nothing silent); the next answer
// clears it.
function rowSay(row, text) {
  let m = row.querySelector(":scope > small.fail");
  if (!m) { m = el("small", { className: "fail" }); m.setAttribute("role", "status"); row.append(m); }
  m.textContent = text;
}
// People asking to join: Allow or Deny; people let in: Remove. Always by a click. Banners go
// into container; base(): the live view address (null: not connected yet). Returns draw(list of
// requests, asking and let in).
export function joinBanners(container, base) {
  const rows = new Map(); // `${request id}:${state}` -> banner
  function answer(op, row, btn) {
    if (!base()) return;
    for (const b of row.querySelectorAll("button")) b.disabled = true;
    btn?.setAttribute("aria-busy", "true");
    postJson(base() + "approve", op)
      .finally(() => btn?.removeAttribute("aria-busy"))
      .then((r) => { if (!r.ok) throw r; })
      .catch((r) => {
        // Gone meanwhile (answered elsewhere, timed out after 10 minutes): say so, rather than a button that does nothing.
        if (r?.status === 404) { const t = row.querySelector("strong"); t.textContent = t.title = "That request is gone (answered, or it timed out)."; return; }
        for (const b of row.querySelectorAll("button")) b.disabled = false;
        rowSay(row, r?.status ? "That didn't go through. Try again." : UNREACHABLE_RETRY);
      });
  }
  return function draw(list) {
    const open = Array.isArray(list) ? list.filter((r) => r && r.id && (!r.state || r.state === "pending" || r.state === "approved")) : [];
    const keyOf = (r) => `${r.id}:${r.state === "approved" ? "in" : "asking"}`;
    const keys = new Set(open.map(keyOf));
    for (const [k, row] of rows) if (!keys.has(k)) { leave(row); rows.delete(k); } // answered: it folds away
    for (const r of open) {
      const k = keyOf(r);
      if (rows.has(k)) continue;
      const who = `${r.name || "Someone"}${r.app ? ` (${r.app})` : ""}`;
      const role = r.role === "drive" ? "can drive" : "watch";
      let row;
      if (r.state === "approved") {
        const remove = el("button", { className: "mini", type: "button", textContent: "Remove", title: "Take them out now. If they try their code again, you're asked again." });
        const text = `${who} is in (${role})`;
        row = el("div", { className: "join in" }, el("strong", { textContent: text, title: text }), el("span", {}, remove));
        remove.addEventListener("click", (ev) => { if (ev.isTrusted && ev.detail > 0) answer({ id: r.id, remove: true }, row, remove); });
      } else {
        const allow = el("button", { className: "primary", type: "button", textContent: "Allow" });
        const deny = el("button", { className: "mini", type: "button", textContent: "Deny" });
        const text = `${who} wants to join (${role})`;
        row = el("div", { className: "join" }, el("strong", { textContent: text, title: text }), el("span", {}, allow, deny));
        // A real pointer click only: no synthetic events, no keyboard default.
        allow.addEventListener("click", (ev) => { if (ev.isTrusted && ev.detail > 0) answer({ id: r.id, allow: true }, row, allow); });
        deny.addEventListener("click", (ev) => { if (ev.isTrusted) answer({ id: r.id, allow: false }, row, deny); });
      }
      rows.set(k, row);
      container.append(row);
    }
  };
}

// A join code whose address isn't a PairBrowse one (*.trycloudflare.com) or one this person
// allowed: the question in asks, with the address plainly and Allow once / Always allow / Cancel,
// and in list the addresses allowed (Remove). The person decides here, never an agent or a page:
// real clicks only, posted to the live view with the owner's key. Returns draw({ asks, hosts }).
export function hostPanel(asks, list, section, base) {
  const send = (body, buttons) => {
    if (!base()) return;
    for (const b of buttons) b.disabled = true;
    const pressed = buttons.find((b) => b === document.activeElement) || buttons[0];
    pressed?.setAttribute("aria-busy", "true");
    const row = pressed?.closest(".join, li");
    postJson(base() + "joinhost", body).then((r) => { if (!r.ok) throw r; if (row) rowSay(row, ""); })
      .catch((r) => { if (row) rowSay(row, r?.status ? "That didn't go through. Try again." : UNREACHABLE_RETRY); })
      .finally(() => { pressed?.removeAttribute("aria-busy"); for (const b of buttons) b.disabled = false; });
  };
  const real = (fn) => (ev) => { if (ev.isTrusted && ev.detail > 0) fn(); };
  return function draw(state) {
    const s = state && typeof state === "object" ? state : {};
    asks.replaceChildren(...(Array.isArray(s.asks) ? s.asks : []).map((a) => {
      const once = el("button", { className: "primary", type: "button", textContent: "Allow once", title: "Join through this address this time only." });
      const always = el("button", { className: "mini", type: "button", textContent: "Always allow", title: "Remember this address in your config (joinHosts). Remove it below any time." });
      const cancel = el("button", { className: "mini", type: "button", textContent: "Cancel" });
      const text = `This code leads to ${String(a.host)}, not a PairBrowse address. Join through it?`;
      const buttons = [once, always, cancel];
      once.addEventListener("click", real(() => send({ op: "allow", id: a.id, always: false }, buttons)));
      always.addEventListener("click", real(() => send({ op: "allow", id: a.id, always: true }, buttons)));
      cancel.addEventListener("click", (ev) => { if (ev.isTrusted) send({ op: "cancel", id: a.id }, buttons); });
      return el("div", { className: "join host" }, el("strong", { textContent: text, title: text }),
        ...(a.who ? [el("small", { textContent: `The code came from ${a.who}. Only you can allow an address.` })] : []), el("span", {}, ...buttons));
    }));
    const rows = (Array.isArray(s.hosts) ? s.hosts : []).map((h) => {
      const remove = el("button", { className: "mini", type: "button", textContent: "Remove", ariaLabel: `Remove ${String(h.host)}` });
      remove.addEventListener("click", real(() => send({ op: "forget", host: h.host }, [remove])));
      const name = `${String(h.host)} · ${h.always ? "always" : "this time"}`;
      return el("li", { className: "dev" }, el("span", { textContent: name, title: name }), remove);
    });
    list.replaceChildren(...rows);
    section.hidden = !rows.length;
  };
}

// The same question on the session picker and the sessions page, after a join code whose address
// isn't a PairBrowse one: Allow once / Always allow / Cancel in box, a person's own click only
// (Allow: a pointer's). send(op, label) posts op to joinhost (the page shows label meanwhile and
// keeps its own busy state) -> the reply's JSON; canSend(): false while the page can't send.
// done(op, { kind, text }) says how it ended ("error", "" for a cancel, "ok"). -> the Cancel path
// (Escape).
export function joinHostAsk(box, { id, host }, { canSend, send, done }) {
  const once = el("button", { className: "primary", type: "button", textContent: "Allow once" });
  const always = el("button", { className: "secondary", type: "button", textContent: "Always allow", title: "Remember this address in your config (joinHosts)." });
  const cancel = el("button", { className: "secondary", type: "button", textContent: "Cancel" });
  const buttons = [once, always, cancel];
  async function answer(op, label) {
    if (!canSend()) return;
    for (const b of buttons) b.disabled = true;
    const r = (await send(op, label)) || { error: UNREACHABLE_RETRY };
    box.hidden = true;
    box.replaceChildren();
    if (r.error || (op.op === "allow" && !r.joined)) done(op, { kind: "error", text: r.error || r.text || "That didn't work." });
    else if (op.op === "cancel") done(op, { kind: "", text: "Not joined." });
    else done(op, { kind: "ok", text: r.text || "Done." });
  }
  const asking = "Asking to join…";
  once.addEventListener("click", (ev) => { if (ev.isTrusted && ev.detail > 0) answer({ op: "allow", id, always: false }, asking); });
  always.addEventListener("click", (ev) => { if (ev.isTrusted && ev.detail > 0) answer({ op: "allow", id, always: true }, asking); });
  cancel.addEventListener("click", (ev) => { if (ev.isTrusted) answer({ op: "cancel", id }, ""); });
  box.replaceChildren(el("strong", {}, "This code leads to ", el("code", { className: "host", textContent: String(host) }), ", not a PairBrowse address. Join through it?"), el("span", { className: "buttons" }, ...buttons));
  box.hidden = false;
  once.focus();
  return () => answer({ op: "cancel", id }, "");
}

// Dev servers (the helper's devshare): an agent's question to share one (Yes / No) in asks, and
// in list the localhost dev servers open in tabs (Share) and those shared (Stop), for the people
// in the session. Only real clicks answer. section: shown when there is something to show.
export function devPanel(asks, list, section, base) {
  const send = (body, buttons) => {
    if (!base()) return;
    for (const b of buttons) b.disabled = true;
    const pressed = buttons.find((b) => b === document.activeElement) || buttons[0];
    pressed?.setAttribute("aria-busy", "true");
    const row = pressed?.closest(".join, li");
    postJson(base() + "dev", body).then((r) => { if (!r.ok) throw r; if (row) rowSay(row, ""); })
      .catch((r) => { if (row) rowSay(row, r?.status ? "That didn't go through. Try again." : UNREACHABLE_RETRY); })
      .finally(() => { pressed?.removeAttribute("aria-busy"); for (const b of buttons) b.disabled = false; });
  };
  const real = (fn) => (ev) => { if (ev.isTrusted && ev.detail > 0) fn(); };
  return function draw(state) {
    const s = state && typeof state === "object" ? state : {};
    asks.replaceChildren(...(Array.isArray(s.asks) ? s.asks : []).map((a) => {
      const yes = el("button", { className: "primary", type: "button", textContent: "Yes" });
      const no = el("button", { className: "mini", type: "button", textContent: "No" });
      const text = `${a.who || "An agent"} wants to share localhost:${Number(a.port)} with the people in your session`;
      yes.addEventListener("click", real(() => send({ op: "answer", id: a.id, allow: true }, [yes, no])));
      no.addEventListener("click", (ev) => { if (ev.isTrusted) send({ op: "answer", id: a.id, allow: false }, [yes, no]); });
      return el("div", { className: "join" }, el("strong", { textContent: text, title: text }), el("span", {}, yes, no));
    }));
    const rows = [
      ...(Array.isArray(s.shared) ? s.shared : []).map((d) => {
        const stop = el("button", { className: "mini", type: "button", textContent: "Stop" });
        stop.addEventListener("click", real(() => send({ op: "unshare", port: d.port }, [stop])));
        return el("li", { className: "dev" }, el("span", { textContent: `localhost:${Number(d.port)} · shared` }), stop);
      }),
      ...(Array.isArray(s.open) ? s.open : []).map((d) => {
        const share = el("button", { className: "mini", type: "button", textContent: "Share" });
        share.addEventListener("click", real(() => send({ op: "share", port: d.port }, [share])));
        const name = `localhost:${Number(d.port)}${d.title ? ` · ${d.title}` : ""}`;
        return el("li", { className: "dev" }, el("span", { textContent: name, title: name }), share);
      }),
    ];
    list.replaceChildren(...rows);
    section.hidden = !rows.length || (!s.joiners && !(s.shared || []).length);
  };
}

// The Profile panel: remembered details and passwords, in the page's #details, #secrets,
// #add-detail, #add-secret and #profile-msg. base(): the live view address (null: not yet).
export function profilePanel(base) {
  const pmsg = $("profile-msg");
  const say = (text, kind = "") => { pmsg.textContent = text; pmsg.dataset.kind = kind; };
  const sourceLabel = (d) => d.source === "you" ? "Added by you" : d.source === "claude" ? "Told to Claude" : `Seen in a form${d.site ? ` on ${d.site}` : ""}`;
  const toName = (label) => String(label).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "S_$1");

  async function change(op) {
    if (!base()) return "Not connected to PairBrowse yet.";
    const r = await postJson(base() + "profile", op).then(async (x) => {
      const b = await x.json().catch(() => null);
      return b && typeof b === "object" ? (x.ok || b.error ? b : { error: "That didn't save." }) : { error: x.ok ? null : "That didn't save." };
    }, () => ({ error: UNREACHABLE }));
    if (r.profile && typeof r.profile === "object") draw(r.profile);
    return r.error ? String(r.error) : null;
  }
  // A reply of the wrong shape (an error, an older helper) draws empty lists, never throws.
  function draw(raw) {
    const p = raw && typeof raw === "object" ? raw : {};
    const details = Array.isArray(p.details) ? p.details.filter((d) => d && typeof d.label === "string") : [];
    const secrets = Array.isArray(p.secrets) ? p.secrets.filter((x) => x && typeof x.name === "string").map((x) => ({ ...x, domains: Array.isArray(x.domains) ? x.domains.map(String) : [] })) : [];
    $("details").replaceChildren(...(details.length ? details.map((d) => {
      const input = el("input", { className: "field", value: String(d.value ?? ""), ariaLabel: d.label });
      input.addEventListener("change", async () => { const e = await change({ op: "setDetail", label: d.label, value: input.value }); say(e || `Saved ${d.label}.`, e ? "error" : "ok"); });
      const del = el("button", { className: "mini", type: "button", textContent: "Remove", ariaLabel: `Remove ${d.label}` });
      del.addEventListener("click", async () => { const e = await change({ op: "forgetDetail", label: d.label }); say(e || `Removed ${d.label}.`, e ? "error" : "ok"); });
      return el("div", { className: "row" }, el("div", { className: "label", title: d.label }, d.label, el("small", { textContent: sourceLabel(d) })), input, del);
    }) : [el("p", { className: "empty-row", textContent: "Nothing yet. Add details below, or tell Claude." })]));
    $("secrets").replaceChildren(...(secrets.length ? secrets.map((x) => {
      const replace = el("button", { className: "mini", type: "button", textContent: "Replace", ariaLabel: `Replace ${x.name}` });
      replace.addEventListener("click", () => {
        const f = $("add-secret");
        f.label.value = x.name; f.domains.value = x.domains.join(", "); f.value.value = "";
        f.value.placeholder = "New password (empty: keep the current one)"; f.value.focus();
      });
      const del = el("button", { className: "mini", type: "button", textContent: "Delete", ariaLabel: `Delete ${x.name}` });
      // An in-row question (pages in a window slot or a side panel get no confirm() dialog).
      const acts = el("span", {}, replace, del);
      del.addEventListener("click", () => {
        const yes = el("button", { className: "mini bad", type: "button", textContent: "Delete", ariaLabel: `Yes, delete ${x.name}` });
        const keep = el("button", { className: "mini", type: "button", textContent: "Keep" });
        const back = () => { acts.replaceChildren(replace, del); del.focus(); };
        keep.addEventListener("click", back);
        for (const b of [yes, keep]) b.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !yes.disabled) { ev.preventDefault(); ev.stopPropagation(); back(); } });
        yes.addEventListener("click", async () => { yes.disabled = true; const e = await change({ op: "deleteSecret", name: x.name }); say(e || `Deleted ${x.name}.`, e ? "error" : "ok"); if (e) back(); });
        acts.replaceChildren(el("small", { className: "ask", textContent: "Delete it?" }), yes, keep);
        keep.focus();
      });
      return el("div", { className: "row secret" }, el("div", { className: "label", title: x.name }, x.name), el("div", { className: "sites", title: x.domains.join(", "), textContent: x.domains.join(", ") }), acts);
    }) : [el("p", { className: "empty-row", textContent: "No passwords saved." })]));
    if (p.problem) say(String(p.problem), "error");
  }
  // Shows the current profile; false when it couldn't be loaded (an error reply says why).
  async function load() {
    if (!base()) return false;
    const r = await fetch(base() + "profile.json", { signal: AbortSignal.timeout(8000) })
      .then(async (x) => ({ ok: x.ok, body: await x.json().catch(() => null) }), () => ({ ok: false, body: null }));
    const p = r.body && typeof r.body === "object" ? r.body : null;
    if (!r.ok || !p || p.error) { if (p?.error) say(String(p.error), "error"); return false; }
    draw(p);
    return true;
  }

  $("add-detail").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = await change({ op: "setDetail", label: f.label.value, value: f.value.value });
    if (err) return say(err, "error");
    say(`Remembered ${f.label.value}.`, "ok"); f.reset(); f.label.focus();
  });
  $("add-secret").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const name = /^[A-Z][A-Z0-9_]+$/.test(f.label.value) ? f.label.value : toName(f.label.value) + (toName(f.label.value).includes("PASSWORD") || toName(f.label.value).endsWith("_PW") ? "" : "_PASSWORD");
    const err = await change({ op: "setSecret", name, value: f.value.value, domains: f.domains.value });
    f.value.value = ""; // never keep a password in the page longer than needed
    if (err) return say(err, "error");
    say(`Saved ${name}. Claude can use it by that name on ${f.domains.value}.`, "ok");
    f.reset(); f.value.placeholder = "Password";
  });
  return { draw, load, say };
}

// Report a problem (Settings → About and diagnostics). reportPayload builds exactly the JSON the
// PairBrowse server receives; the review screen shows it before anything is sent. It holds the
// person's words, the app's versions, the platform, the helper's state (counts, never names) and
// the diagnostics report the helper already masks; the tab's address only when the person ticked
// it (origin and path, no query or fragment). Never page contents, form values, passwords,
// secrets, cookies or other tabs. sendReport posts it to the helper's owner route `report`, which
// relays it to the report address in the helper's config: the pages hold no key, token or server
// address (connect-src is the helper's origin only). -> { ok, id? } or { ok: false, error }.
export const REPORT_SCHEMA = "pairbrowse-report/1";
export const REPORT_WHAT_MAX = 4000;
export function reportPayload({ what = "", host = "", page = "", connection = "", diag = null, report = "", tab = null, now = new Date() } = {}) {
  const h = diag?.helper || {}, b = diag?.browser || {}, c = diag?.connections || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const ua = globalThis.navigator?.userAgentData;
  return {
    schema: REPORT_SCHEMA,
    createdAt: now.toISOString(),
    what: String(what || "").trim().slice(0, REPORT_WHAT_MAX),
    app: {
      host: host === "pairbrowse" ? "pairbrowse" : "chromium",
      page: String(page || ""),
      helper: h.version ? String(h.version) : null,
      browser: { engine: b.engine ?? null, version: b.version ?? null, build: b.build ?? null },
    },
    platform: { os: String(ua?.platform || globalThis.navigator?.platform || ""), mobile: !!ua?.mobile, language: String(globalThis.navigator?.language || "") },
    helperState: { connection: String(connection || ""), uptime: num(h.uptime), agents: num(c.agents), viewers: num(c.viewers), joiners: num(c.joiners), streams: num(c.streams), errors: Array.isArray(diag?.errors) ? diag.errors.length : null },
    diagnostics: String(report || ""),
    tab: tab ? { url: String(tab) } : null,
  };
}
export async function sendReport(base, payload) {
  if (!base) return { ok: false, error: "PairBrowse isn't connected." };
  let r;
  try {
    r = await postJson(base + "report", payload);
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  const body = await r.json().catch(() => null);
  if (r.ok && body?.ok !== false) return { ok: true, ...(typeof body?.id === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(body.id) ? { id: body.id } : {}) };
  if (r.status === 404) return { ok: false, error: "This PairBrowse doesn't send reports." };
  return { ok: false, error: typeof body?.error === "string" && body.error ? body.error.slice(0, 200) : "The report server didn't take it." };
}
// The offer on a page's error state: a "Report a problem" link to Settings' review screen, only
// while the helper relays reports (config.json report). -> the element, or null. A window slot
// page opens Settings with the browser's tabs; a tab page of the browser follows the link itself;
// the extension opens its own settings page.
export async function reportOffer(base) {
  if (!base) return null;
  const c = await fetch(base + "config.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (c?.report !== true) return null;
  const a = el("a", { className: "report-offer", href: REPORT_URL, textContent: "Report a problem", target: "_blank", rel: "noopener" });
  a.addEventListener("click", (ev) => {
    const pb = globalThis.pairbrowse;
    if (pb && location.host === TOP_CHROME_HOST) { ev.preventDefault(); pb.tabs.create(ownPage("settings#report"), true, -1).catch(() => {}); return; }
    if (pb) return; // a tab page: the link itself
    const tabs = globalThis.chrome?.tabs, runtime = globalThis.chrome?.runtime;
    if (tabs?.create && runtime?.getURL) { ev.preventDefault(); tabs.create({ url: runtime.getURL("settings/index.html#report") }); }
  });
  return a;
}

// Participants as the side panel shows them: a color only when it is a plain #rrggbb (board
// colors cross from other computers), "Name · App" split in two, and a round avatar with the
// name's initial and the name as its accessible name.
export const splitLabel = (who) => { const [name, app] = String(who || "").split(" · "); return { name: name || "", app: app || "" }; };
export const initialOf = (name) => (String(name || "").trim()[0] || "?").toUpperCase();
// The ink for text on a #rrggbb fill: white or the sheet's dark ink (--bg), whichever has the higher
// WCAG contrast on it (DESIGN.md B11). Every participant color takes the dark ink; a dark fill white.
export const INK_LIGHT = "#FFFFFF", INK_DARK = "#0B1421";
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function inkOn(color) {
  if (!isColor(color)) return INK_DARK;
  const l = luminance(color);
  const light = 1.05 / (l + 0.05), dark = (l + 0.05) / (luminance(INK_DARK) + 0.05);
  return light > dark ? INK_LIGHT : INK_DARK;
}
// decorative: beside the name in words (a row, a card): hidden from assistive tech, no role, label
// or tooltip of its own.
export function avatar(name, color, { tag = "span", decorative = false } = {}) {
  const a = el(tag, { className: "avatar", textContent: initialOf(name) });
  if (decorative) a.setAttribute("aria-hidden", "true");
  else {
    a.title = String(name || "");
    a.setAttribute("role", "img");
    a.setAttribute("aria-label", String(name || ""));
  }
  if (isColor(color)) { a.style.background = color; a.style.color = inkOn(color); }
  else a.classList.add("plain");
  return a;
}

// A done line of the goal log, as the log writes it: "Title <url>: act; act", or "url: act; act".
export function doneLine(line) {
  const s = String(line);
  let head = s, url, rest = "";
  const m = s.match(/^(.*?) <([^>]*)>(?:: (.*))?$/s);
  if (m) { head = m[1]; url = m[2]; rest = m[3] || ""; }
  else { const i = s.indexOf(": "); if (i > 0) { head = s.slice(0, i); rest = s.slice(i + 2); } url = /^https?:\/\//.test(head) ? head : ""; }
  const li = el("li", {}, el("span", { className: "page", textContent: head, title: url }));
  if (rest) {
    const acts = el("span", { className: "acts" });
    rest.split("; ").forEach((a, i) => { if (i) acts.append(" · "); acts.append(rich(a)); });
    li.append(acts);
  }
  return li;
}

// The goal log as a checklist (the side panel's agent card): what was done, oldest first, the
// newest done line marked current while the agent is driving, then what was handed to you and
// what is left. Only the log's own lines; each row says its state in a glyph and in words.
const CHECK = { done: ["✓", "Done:"], current: ["◉", "Current:"], waiting: ["●", "Waiting for you:"], pending: ["○", "Pending:"] };
export function checkState(li, state) {
  const [glyph, words] = CHECK[state];
  li.dataset.state = state;
  li.querySelector(".mark").textContent = glyph;
  li.querySelector(".sr").textContent = `${words} `;
}
export function checklistItems(run, { driving = false } = {}) {
  const empty = (text) => [el("li", { className: "empty", textContent: text })];
  if (!run || typeof run !== "object") return empty("No goal log yet: it starts with the first browser action.");
  const row = (state, ...kids) => {
    const mark = el("span", { className: "mark" });
    mark.setAttribute("aria-hidden", "true");
    const li = el("li", {}, mark, el("span", { className: "text" }, el("span", { className: "sr" }), ...kids));
    checkState(li, state);
    return li;
  };
  const done = Array.isArray(run.done) ? run.done : [];
  const items = [
    ...done.map((d, i) => row(driving && i === done.length - 1 ? "current" : "done", ...[...doneLine(d).childNodes])),
    ...(Array.isArray(run.yourTurn) ? run.yourTurn : []).map((x) => row("waiting", String(x))),
    ...(Array.isArray(run.left) ? run.left : []).map((x) => row("pending", String(x))),
  ];
  return items.length ? items : empty("Nothing done yet.");
}

// Share (the side panel's header, the live view's toolbar): a card under btn that makes a join
// code (shared browser, can drive) or a watch link with the owner's own key, through the
// helper's own invite code. The code or link is shown once, in a read-only field, and cleared
// when the card closes. Asks the owner's first name once (the helper says when). card holds
// the ids share-name-row, share-name, share-make, share-result, share-code, share-copy,
// share-rights and share-msg. base(): the live view address (null: not connected yet). btn may
// be null (the left dock's card, opened only by the strip's Share): open() and close() then touch
// no button; returnTo (optional) takes the focus back when it was inside the card (F6 into the
// dock, then Escape), else close() moves no focus.
// dismissable(): false while a host owns dismissal (the strip's #share bubble): no outside click or Escape closes it.
// onToggle(open) runs on every open and close (the right dock tells the strip's Share, which asked).
export function shareCard({ btn, card, base, onCopy = () => {}, dismissable = () => true, returnTo = null, onToggle = () => {} }) {
  const q = (id) => card.querySelector(`#${id}`);
  const nameRow = q("share-name-row"), name = q("share-name"), make = q("share-make"), result = q("share-result");
  const code = q("share-code"), copy = q("share-copy"), rights = q("share-rights"), msg = q("share-msg");
  const say = (text, kind = "") => { msg.textContent = text; msg.dataset.kind = kind; };
  const radios = () => [...card.querySelectorAll('input[name="share"]')];
  const outside = (e) => { if (!card.contains(e.target) && !btn?.contains(e.target)) close(false); };
  function open() {
    card.hidden = false;
    btn?.setAttribute("aria-expanded", "true");
    if (dismissable()) document.addEventListener("pointerdown", outside, true);
    (radios().find((r) => r.checked) || radios()[0])?.focus();
    onToggle(true);
  }
  function close(refocus = true) {
    if (card.hidden) return;
    card.hidden = true;
    onToggle(false);
    btn?.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    code.value = ""; rights.textContent = ""; result.hidden = true; nameRow.hidden = true; say("");
    if (refocus) btn?.focus();
    // No button to return to: focus never stays on a control the card just hid; it goes to
    // returnTo when there is one, so the next Tab goes on from there.
    else if (!btn && card.contains(document.activeElement)) {
      if (returnTo) returnTo.focus();
      else document.activeElement.blur();
    }
  }
  btn?.addEventListener("click", () => (card.hidden ? open() : close()));
  // With no button of its own (opened from another page's: the strip's Share asks the left dock)
  // nothing here takes the focus back on close: the asking control keeps it.
  const onEscape = (e) => { if (e.key === "Escape" && !card.hidden && dismissable()) { e.preventDefault(); close(!!btn); } };
  card.addEventListener("keydown", onEscape);
  btn?.addEventListener("keydown", onEscape);
  // A non-modal card: Tab out of it (not onto its button) closes it, so it never lingers.
  card.addEventListener("focusout", (e) => { if (!card.hidden && e.relatedTarget && !card.contains(e.relatedTarget) && e.relatedTarget !== btn) close(!!btn); });
  // A person's click or key press only: a synthetic event makes nothing.
  async function makeInvite() {
    if (make.disabled) return;
    if (!base()) return say("Not connected to PairBrowse yet.", "error");
    const share = radios().find((r) => r.checked)?.value === "link" ? "link" : "code";
    const given = name.value.trim();
    make.disabled = true;
    say("");
    const r = await busy(make, () => postJson(base() + "invite", { share, ...(given ? { name: given } : {}) }).then((x) => x.json()).catch(() => ({ error: UNREACHABLE })));
    make.disabled = false;
    if (r?.needName) { nameRow.hidden = false; name.focus(); return say(r.error || "Your first name, please.", "error"); }
    if (!r?.ok) return say(r?.error || "Couldn't make the invite.", "error");
    nameRow.hidden = true;
    code.value = r.code || r.link || "";
    rights.textContent = [r.rights, r.hint].filter(Boolean).join(" ");
    result.hidden = false;
    say(share === "code" ? "Join code made. Send it yourself; it's shown here only now." : "Watch link made. Send it yourself; it's shown here only now.", "ok");
    code.focus();
    code.select();
  }
  make.addEventListener("click", (ev) => { if (ev.isTrusted) makeInvite(); });
  name.addEventListener("keydown", (e) => { if (e.isTrusted && e.key === "Enter") { e.preventDefault(); makeInvite(); } });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code.value);
      say("Copied.", "ok");
      onCopy(code.value);
    } catch {
      code.focus();
      code.select();
      say("Select and press Ctrl/Cmd+C to copy.", "error");
    }
  });
  return { open, close, isOpen: () => !card.hidden };
}

// The session switcher (the strip's chevron, the left dock's Workspace header and Sessions row):
// ui/picker in a same-origin iframe inside pop, loaded only while open and unloaded on close. It
// closes on the picker's "picked" or "close" notice (from that frame and this origin only), on
// Escape and on a click outside pop and every opener; focus goes back to the opener that opened
// it, except after a click outside. The parent never posts to the frame. openers: the buttons
// that toggle it (each gets aria-expanded). dismissable(): false while a host owns dismissal (the
// strip's #switcher bubble): no notice, Escape or outside click closes it then.
// onToggle(open) runs on every open and close (the left dock tells the strip's logo, which asked).
// noHelper(): true when the parent knows there is no helper to ask; the frame then opens as
// picker/index.html#none and shows the resting state (a frame in a slot gets no Session binding
// of its own, DESIGN.md H4.1, so it can't tell by itself). The hash carries no key or name.
// The frame unloads once the popover has faded out (at once under reduced motion).
export function pickerPopover({ pop, frame, openers, dismissable = () => true, onToggle = () => {}, noHelper = () => false }) {
  let opener = null;
  const isOpen = () => !pop.hidden;
  const outside = (e) => { if (dismissable() && !pop.contains(e.target) && !openers.some((b) => b.contains(e.target))) close(false); };
  const onMessage = (e) => {
    if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
    if (e.data?.source !== "pairbrowse-picker" || (e.data.op !== "picked" && e.data.op !== "close")) return;
    if (dismissable()) close(true);
  };
  function open(by) {
    if (isOpen()) return;
    opener = by || openers[0];
    frame.src = noHelper() ? "../picker/index.html#none" : "../picker/index.html";
    pop.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    if (dismissable()) document.addEventListener("pointerdown", outside, true);
    window.addEventListener("message", onMessage);
    frame.focus();
    onToggle(true);
  }
  function close(refocus = true) {
    if (!isOpen()) return;
    pop.hidden = true;
    const unload = () => { if (pop.hidden) frame.removeAttribute("src"); };
    const fading = pop.getAnimations?.() || [];
    if (fading.length) Promise.all(fading.map((a) => a.finished)).then(unload, unload); else unload();
    onToggle(false);
    opener?.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("message", onMessage);
    if (refocus) opener?.focus();
  }
  const onEscape = (e) => { if (e.key === "Escape" && isOpen() && dismissable()) { e.preventDefault(); close(); } };
  for (const b of openers) {
    b.addEventListener("click", () => (isOpen() ? close() : open(b)));
    b.addEventListener("keydown", onEscape);
  }
  pop.addEventListener("keydown", onEscape);
  return { open, close, isOpen };
}

// The question POST pick answers with 428 while other agents are at work ({ text, error, confirm:
// "<question>", agents: [names] }): asked in the page itself, since a page in a dock slot gets no
// confirm() dialog. box: the card's element (emptied and hidden once answered). The question is
// the helper's own; agents it doesn't name are listed under it. Only a person's own click or key
// press answers: yes() resends the same pick with confirm: true, no() drops it. -> the Cancel path
// (for Escape).
export function askSwitch(box, r, { yes, no }) {
  const agents = Array.isArray(r?.agents) ? r.agents.filter((a) => typeof a === "string" && a.trim()).map((a) => a.slice(0, 60)).slice(0, 8) : [];
  const many = agents.length !== 1;
  const question = typeof r?.confirm === "string" && r.confirm.trim() ? r.confirm.slice(0, 300)
    : `${agents.length ? agents.join(", ") : "Agents"} ${many ? "are" : "is"} using the browser. Switching closes every tab for them. Switch anyway?`;
  const unnamed = agents.filter((a) => !question.includes(a));
  const go = el("button", { className: "primary", type: "button", textContent: "Switch anyway" });
  const cancel = el("button", { className: "secondary", type: "button", textContent: "Cancel" });
  let done = false;
  const finish = (fn) => {
    if (done) return;
    done = true;
    box.hidden = true;
    box.replaceChildren();
    fn();
  };
  go.addEventListener("click", (ev) => { if (ev.isTrusted) finish(yes); });
  cancel.addEventListener("click", (ev) => { if (ev.isTrusted) finish(no); });
  box.replaceChildren(el("strong", { textContent: question }),
    ...(unnamed.length ? [el("small", { className: "agents", textContent: `At work: ${agents.join(", ")}` })] : []),
    el("span", { className: "buttons" }, go, cancel));
  box.hidden = false;
  cancel.focus();
  return () => finish(no);
}

// Asks for one dock's state: the browser's Layout.Set in the build (the last state with one side
// changed), else the helper's POST layout; false when neither channel is there (nothing asked).
const DOCK_STATE = { hidden: "kHidden", rail: "kRail", open: "kOpen" };
export function askDock({ pb, layout, base, side, state, onFail }) {
  if (pb) {
    if (!layout) return false;
    pb.layout.set({ ...layout, [side]: pb.DockState[DOCK_STATE[state]] }).catch(() => onFail?.());
    return true;
  }
  if (!base) return false;
  postJson(base + "layout", { [side]: state }).then((r) => { if (!r.ok) onFail?.(); }, () => onFail?.());
  return true;
}

// ---- the helper's event stream, one per origin ----
// Why one: a browser opens at most 6 connections per host, and the window's slot pages alone are
// 7 (the strip, its two nav fragments, the left and right docks, the timeline, the approval
// bubble), so a stream each would leave a page waiting for a connection that never comes. A Web
// Lock named after the helper's address (its origin: no key in it) picks one page, which opens
// the owner stream (events?panel=1, never a viewer) and relays every event over a
// BroadcastChannel of the same name; the other pages listen. When that page closes, is frozen or
// hides, the lock passes and the next page opens the stream. The lock and the channel are scoped
// to the page's own origin, so a web page, another extension or the live view page can neither
// take the lock nor hear the channel. Owner-only filtering stays the helper's: the same events
// reach the same pages. A page that joins late gets the last value of each state event from the
// page holding the stream; deltas (approval, timeline, downloads, handoffs, a tab-order request) are never replayed:
// pages fetch their snapshot in onOpen. One-shot fields are never replayed either: a layout
// event's `tab` (the right dock opening on a tab) and a record event's `op` ("saved", with its
// item), so a late page neither jumps to a tab nor adds a recording from an old event. Without Web Locks or BroadcastChannel (or when the lock is refused) a page
// opens its own stream as before. No timer, frame or observer anywhere here.
// The names come from events.js, the one list of the helper's events (pages: "shared", delta).
export const STREAM_EVENTS = SHARED_STREAM_EVENTS;
const STREAM_DELTAS = new Set(DELTA_EVENTS);
// What the holder keeps of a state event for a late page: no delta, and no one-shot field.
function replayable(name, v) {
  if (STREAM_DELTAS.has(name)) return undefined;
  const obj = v && typeof v === "object" && !Array.isArray(v);
  if (name === "layout" && obj && "tab" in v) { const { tab, ...rest } = v; return rest; }
  if (name === "record" && obj && "op" in v) {
    // A saved notice alone is never kept; one that also says the recording state keeps the state.
    if (typeof v.recording !== "boolean") return undefined;
    const { op, item, ...rest } = v;
    return rest;
  }
  return v;
}
// Events one page kind's own stream carries and no other page hears: never on the shared stream,
// never relayed or replayed. The capture page's calls from the helper (`capture`, plans/550 D4:
// SDPs and recordings for the capture page alone). A page of such a kind always gets a stream of
// its own (helperStream below), whatever it asks.
export const OWN_STREAM_EVENTS = OWN_EVENTS;

// The helper's page kinds: one of them on the stream gets the browser pages' initial burst
// (agent-tabs); the helper sends the same burst to every kind, so one kind stands for all.
const STREAM_KINDS = new Set(PAGE_KINDS);

// One EventSource to the helper: event(name, parsed data) for every STREAM_EVENTS name (a body
// that is not JSON is dropped), state("live" | "connecting" | "closed").
// own: the kind's OWN_STREAM_EVENTS too (a page's own stream only).
function openStream(base, kind, { event, state }, own = []) {
  const es = new EventSource(base + "events?panel=1" + (kind ? `&page=${kind}` : ""));
  es.onopen = () => state("live");
  es.onerror = () => state(es.readyState === EventSource.CLOSED ? "closed" : "connecting");
  for (const name of [...STREAM_EVENTS, ...own]) {
    es.addEventListener(name, (e) => { let v; try { v = JSON.parse(e.data); } catch { return; } event(name, v); });
  }
  return es;
}

// helperStream(base, { kind, shared, onState, onOpen }) -> { on(name, fn), close() }. base: the
// helper's `${origin}/${key}/`. kind: the page's own helper page kind, or "". shared: false opens a
// stream of this page's own, never the origin's shared one: the helper counts a page kind only
// from the stream that carries it, so a page that must count on its own (the approval bubble, 530
// D2) says so; a kind with OWN_STREAM_EVENTS (the capture page) always does, and only its own
// stream delivers those events. onState(s) on every state change; onOpen() each time the stream goes live (fetch
// snapshots there). Nothing is delivered during the call itself, so on() calls made right after it
// miss nothing.
export function helperStream(base, { kind = "", shared = true, onState = () => {}, onOpen = () => {} } = {}) {
  const handlers = new Map(); // event name -> [fn]
  const on = (name, fn) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); };
  const deliver = (name, data) => {
    for (const fn of handlers.get(name) || []) {
      try { fn(data); } catch (e) { reportError(e); } // one handler never stops the relay
    }
  };
  let state = "connecting";
  const setState = (s) => {
    const was = state;
    state = s;
    onState(s);
    if (s === "live" && was !== "live") onOpen();
  };
  const ownKind = STREAM_KINDS.has(kind) ? kind : "";
  const ownEvents = Object.hasOwn(OWN_STREAM_EVENTS, ownKind) ? OWN_STREAM_EVENTS[ownKind] : [];
  if (ownEvents.length) shared = false;
  let closed = false;
  let es = null;

  // A stream of this page's own (shared: false, no Web Locks or BroadcastChannel, or the lock refused).
  function own() {
    if (closed) return;
    es = openStream(base, ownKind, { event: deliver, state: setState }, ownEvents);
  }

  let name = "";
  try { name = "pairbrowse-stream " + new URL(base).origin; } catch { name = ""; }
  if (!shared || !name || typeof navigator.locks?.request !== "function" || typeof BroadcastChannel !== "function" || typeof crypto?.randomUUID !== "function") {
    // The first delivery still comes from the stream's own callbacks, never from this call.
    own();
    return { on, close() { closed = true; es?.close(); es = null; } };
  }

  let cur = base; // the newest address announced under this name
  // When cur was learned: a holder takes on another address only from a hello that learned it
  // later, so a page still on a dead key (back from the cache, or resumed) never moves the stream.
  let since = performance.timeOrigin + performance.now();
  const id = crypto.randomUUID();
  const ch = new BroadcastChannel(name);
  const post = (msg) => { try { ch.postMessage(msg); } catch {} };
  const cache = new Map(); // state event name -> its last value (the holder's)
  let holder = false;
  let release = null; // resolves the lock callback's promise
  let ctl = null; // aborts a pending lock request
  let streamKind = ownKind;

  // The holder: one stream, every event delivered here and posted to the others.
  // A stream that ends for good gives the lock up, so a page on a live address can take it.
  const shareState = (s) => {
    setState(s);
    post({ t: "state", base: cur, s });
    if (s === "closed" && holder) suspend();
  };
  function openHeld() {
    es?.close();
    cache.clear();
    shareState("connecting");
    es = openStream(cur, streamKind, {
      event: (n, v) => {
        deliver(n, v);
        const kept = replayable(n, v);
        if (kept !== undefined) cache.set(n, kept);
        post({ t: "event", base: cur, name: n, data: v });
      },
      state: shareState,
    });
  }
  function request() {
    if (closed || ctl || holder) return;
    const c = new AbortController();
    ctl = c;
    navigator.locks.request(name, { signal: c.signal }, () => new Promise((resolve) => {
      ctl = null;
      if (closed) { resolve(); return; }
      holder = true;
      release = resolve;
      openHeld();
    })).catch((e) => {
      if (ctl === c) ctl = null;
      if (e?.name === "AbortError" || closed) return;
      // The lock refused: a stream of this page's own, as before.
      holder = false;
      ch.onmessage = null;
      try { ch.close(); } catch {}
      own();
    });
  }
  // Frozen or hidden for good: the stream and the lock go to the next page.
  function suspend() {
    ctl?.abort();
    ctl = null;
    if (!holder) return;
    holder = false;
    es?.close();
    es = null;
    const r = release;
    release = null;
    r?.();
  }
  function resume() {
    if (closed) return;
    post({ t: "hello", id, base: cur, kind, since });
    request();
  }

  ch.onmessage = (e) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (holder) {
      if (m.t !== "hello" || typeof m.base !== "string") return;
      if (m.base !== cur) {
        // A helper restarted: the newer address wins, the old key is dead. An older one is ignored.
        if (typeof m.since === "number" && m.since > since) { cur = m.base; since = m.since; openHeld(); }
        return;
      }
      if (!streamKind && STREAM_KINDS.has(m.kind)) { streamKind = m.kind; openHeld(); return; }
      post({ t: "state", base: cur, s: state, to: m.id });
      for (const [n, data] of cache) post({ t: "event", base: cur, name: n, data, to: m.id });
      return;
    }
    if (m.base !== cur || (m.to !== undefined && m.to !== id)) return;
    if (m.t === "state" && typeof m.s === "string") setState(m.s);
    else if (m.t === "event" && typeof m.name === "string") deliver(m.name, m.data);
  };
  const onFreeze = () => suspend();
  const onResume = () => resume();
  const onPageHide = () => suspend();
  const onPageShow = (e) => { if (e.persisted) resume(); };
  document.addEventListener("freeze", onFreeze);
  document.addEventListener("resume", onResume);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  post({ t: "hello", id, base: cur, kind, since });
  request();

  return {
    on,
    close() {
      if (closed) return;
      closed = true;
      ctl?.abort();
      ctl = null;
      es?.close();
      es = null;
      holder = false;
      const r = release;
      release = null;
      r?.();
      ch.onmessage = null;
      try { ch.close(); } catch {}
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", onResume);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    },
  };
}
