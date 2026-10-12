// Shared by the side panel, the browser's own pages (the strip, the docks, the timeline, the
// approval bubble, settings), the new tab page and the live view (which serves this file from
// here: an extension can load only its own files). It also holds helperStream, the one owner
// event stream those pages share per origin. The live view's server imports addressToUrl too, so
// this module must stay free of side effects: definitions only, nothing runs on import.

export const $ = (id) => document.getElementById(id);
export function el(tag, props = {}, ...kids) { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; }

// Activity text: **bold** and `code`, rendered safely (text nodes only, never markup).
export function rich(text) {
  const frag = document.createDocumentFragment();
  for (const part of String(text).split(/(\*\*[^*]+\*\*|`[^`]*`)/)) {
    if (!part) continue;
    if (part.startsWith("**")) frag.append(el("strong", { textContent: part.slice(2, -2) }));
    else if (part.startsWith("`")) frag.append(el("code", { textContent: part.slice(1, -1) }));
    else frag.append(part);
  }
  return frag;
}
export const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
// Hours and minutes only on a 24-hour clock (the timeline's cards: "10:24", the mockup).
export const shortClock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
// How long ago, worked out once when drawn (nothing ticks): "just now", "N min ago", else the date and time.
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = (now - t) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  return new Date(t).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}
// An agent's status (pairbrowse_status kinds) in words, so it never shows by color alone.
export const STATE_WORDS = { working: "working", you: "waiting for their person", done: "done", idle: "idle" };
export const stateWord = (s) => (Object.hasOwn(STATE_WORDS, s) ? STATE_WORDS[s] : "idle");
// "Alice" -> "Alice's Claude". Unnamed ("Claude 3fed") and app-labelled ("Alice · Codex") stay as they are.
export const whose = (who) => !who ? "Claude" : /^Claude\b| · /.test(who) ? who : `${who}'s Claude`;
// The activity line's head: who did it, and in which tab.
export const activityHead = (a) => [a.who, a.tab ? `in ${a.tab}` : ""].filter(Boolean).join(" ");

// What you type in an address bar, as a URL: a web address, or a Google search.
export function addressToUrl(text) {
  const t = String(text || "").trim().slice(0, 2000);
  if (!t) return null;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(t)) return `http://${t}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/\s]+:\d+([/?#]|$)/.test(t)) return t;
  if (!/\s/.test(t) && /^[^/?#]+\.[a-z]{2,}([:/?#]|$)/i.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

// Claude's orange spark, as an icon.
const SPARK = "M8 0.8c.5 0 .8.4.9.9l.5 4 3.3-2.3c.4-.3 1-.2 1.3.2.3.4.2 1-.2 1.3L10.6 7.3l4 .6c.5.1.9.5.8 1-.1.5-.5.8-1 .7l-4-.5 2.3 3.3c.3.4.2 1-.2 1.3-.4.3-1 .2-1.3-.2L8.9 10.2l-.5 4c-.1.5-.5.9-1 .8-.5 0-.8-.5-.8-1l.6-4-3.3 2.3c-.4.3-1 .2-1.3-.2-.3-.4-.2-1 .2-1.3l3.2-2.4-4-.5c-.5-.1-.9-.5-.8-1 .1-.5.5-.8 1-.8l4 .6L3.9 3.5c-.3-.4-.2-1 .2-1.3.4-.3 1-.2 1.3.2l2.4 3.3.5-4c0-.5.4-.9.9-.9Z";
export function sparkIcon(className, label = "") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", className);
  if (label) svg.setAttribute("aria-label", label);
  else svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", SPARK);
  svg.append(path);
  return svg;
}

const postJson = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// People asking to join: Allow or Deny; people let in: Remove. Always by a click. Banners go
// into container; base(): the live view address (null: not connected yet). Returns draw(list of
// requests, asking and let in).
export function joinBanners(container, base) {
  const rows = new Map(); // `${request id}:${state}` -> banner
  function answer(op, row) {
    if (!base()) return;
    for (const b of row.querySelectorAll("button")) b.disabled = true;
    postJson(base() + "approve", op)
      .then((r) => { if (!r.ok) throw r; })
      .catch((r) => {
        // Gone meanwhile (answered elsewhere, timed out after 10 minutes): say so, rather than a button that does nothing.
        if (r?.status === 404) { const t = row.querySelector("strong"); t.textContent = t.title = "That request is gone (answered, or it timed out)."; return; }
        for (const b of row.querySelectorAll("button")) b.disabled = false;
      });
  }
  return function draw(list) {
    const open = Array.isArray(list) ? list.filter((r) => r && r.id && (!r.state || r.state === "pending" || r.state === "approved")) : [];
    const keyOf = (r) => `${r.id}:${r.state === "approved" ? "in" : "asking"}`;
    const keys = new Set(open.map(keyOf));
    for (const [k, row] of rows) if (!keys.has(k)) { row.remove(); rows.delete(k); }
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
        remove.addEventListener("click", (ev) => { if (ev.isTrusted && ev.detail > 0) answer({ id: r.id, remove: true }, row); });
      } else {
        const allow = el("button", { className: "primary", type: "button", textContent: "Allow" });
        const deny = el("button", { className: "mini", type: "button", textContent: "Deny" });
        const text = `${who} wants to join (${role})`;
        row = el("div", { className: "join" }, el("strong", { textContent: text, title: text }), el("span", {}, allow, deny));
        // A real pointer click only: no synthetic events, no keyboard default.
        allow.addEventListener("click", (ev) => { if (ev.isTrusted && ev.detail > 0) answer({ id: r.id, allow: true }, row); });
        deny.addEventListener("click", (ev) => { if (ev.isTrusted) answer({ id: r.id, allow: false }, row); });
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
    postJson(base() + "joinhost", body).catch(() => {}).finally(() => { for (const b of buttons) b.disabled = false; });
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

// Dev servers (the helper's devshare): an agent's question to share one (Yes / No) in asks, and
// in list the localhost dev servers open in tabs (Share) and those shared (Stop), for the people
// in the session. Only real clicks answer. section: shown when there is something to show.
export function devPanel(asks, list, section, base) {
  const send = (body, buttons) => {
    if (!base()) return;
    for (const b of buttons) b.disabled = true;
    postJson(base() + "dev", body).catch(() => {}).finally(() => { for (const b of buttons) b.disabled = false; });
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
    const r = await postJson(base() + "profile", op).then((x) => x.json()).catch(() => ({ error: "Couldn't reach PairBrowse." }));
    if (r.profile) draw(r.profile);
    return r.error || null;
  }
  function draw(p) {
    $("details").replaceChildren(...(p.details.length ? p.details.map((d) => {
      const input = el("input", { className: "field", value: d.value, ariaLabel: d.label });
      input.addEventListener("change", async () => { const e = await change({ op: "setDetail", label: d.label, value: input.value }); say(e || `Saved ${d.label}.`, e ? "error" : "ok"); });
      const del = el("button", { className: "mini", type: "button", textContent: "Remove", ariaLabel: `Remove ${d.label}` });
      del.addEventListener("click", async () => { await change({ op: "forgetDetail", label: d.label }); say(`Removed ${d.label}.`, "ok"); });
      return el("div", { className: "row" }, el("div", { className: "label", title: d.label }, d.label, el("small", { textContent: sourceLabel(d) })), input, del);
    }) : [el("p", { className: "empty-row", textContent: "Nothing yet. Add details below, or tell Claude." })]));
    $("secrets").replaceChildren(...(p.secrets.length ? p.secrets.map((x) => {
      const replace = el("button", { className: "mini", type: "button", textContent: "Replace", ariaLabel: `Replace ${x.name}` });
      replace.addEventListener("click", () => {
        const f = $("add-secret");
        f.label.value = x.name; f.domains.value = x.domains.join(", "); f.value.value = "";
        f.value.placeholder = "New password (empty: keep the current one)"; f.value.focus();
      });
      const del = el("button", { className: "mini", type: "button", textContent: "Delete", ariaLabel: `Delete ${x.name}` });
      del.addEventListener("click", async () => { if (!confirm(`Delete the saved password ${x.name}?`)) return; await change({ op: "deleteSecret", name: x.name }); say(`Deleted ${x.name}.`, "ok"); });
      return el("div", { className: "row secret" }, el("div", { className: "label", title: x.name }, x.name), el("div", { className: "sites", title: x.domains.join(", "), textContent: x.domains.join(", ") }), el("span", {}, replace, del));
    }) : [el("p", { className: "empty-row", textContent: "No passwords saved." })]));
    if (p.problem) say(p.problem, "error");
  }
  // Shows the current profile; false when it couldn't be loaded.
  async function load() {
    if (!base()) return false;
    const p = await fetch(base() + "profile.json").then((x) => x.json()).catch(() => null);
    if (p) draw(p);
    return !!p;
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

// Participants as the side panel shows them: a color only when it is a plain #rrggbb (board
// colors cross from other computers), "Name · App" split in two, and a round avatar with the
// name's initial and the name as its accessible name.
export const isColor = (c) => /^#[0-9a-f]{6}$/i.test(c || "");
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
export function avatar(name, color, tag = "span") {
  const a = el(tag, { className: "avatar", textContent: initialOf(name), title: String(name || "") });
  a.setAttribute("role", "img");
  a.setAttribute("aria-label", String(name || ""));
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
// share-rights and share-msg. base(): the live view address (null: not connected yet).
// dismissable(): false while a host owns dismissal (the strip's #share bubble): no outside click or Escape closes it.
export function shareCard({ btn, card, base, onCopy = () => {}, dismissable = () => true }) {
  const q = (id) => card.querySelector(`#${id}`);
  const nameRow = q("share-name-row"), name = q("share-name"), make = q("share-make"), result = q("share-result");
  const code = q("share-code"), copy = q("share-copy"), rights = q("share-rights"), msg = q("share-msg");
  const say = (text, kind = "") => { msg.textContent = text; msg.dataset.kind = kind; };
  const radios = () => [...card.querySelectorAll('input[name="share"]')];
  const outside = (e) => { if (!card.contains(e.target) && !btn.contains(e.target)) close(false); };
  function open() {
    card.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    if (dismissable()) document.addEventListener("pointerdown", outside, true);
    (radios().find((r) => r.checked) || radios()[0])?.focus();
  }
  function close(refocus = true) {
    card.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    code.value = ""; rights.textContent = ""; result.hidden = true; nameRow.hidden = true; say("");
    if (refocus) btn.focus();
  }
  btn.addEventListener("click", () => (card.hidden ? open() : close()));
  const onEscape = (e) => { if (e.key === "Escape" && !card.hidden && dismissable()) { e.preventDefault(); close(); } };
  card.addEventListener("keydown", onEscape);
  btn.addEventListener("keydown", onEscape);
  // A non-modal card: Tab out of it (not onto its button) closes it, so it never lingers.
  card.addEventListener("focusout", (e) => { if (!card.hidden && e.relatedTarget && !card.contains(e.relatedTarget) && e.relatedTarget !== btn) close(); });
  // A person's click or key press only: a synthetic event makes nothing.
  async function makeInvite() {
    if (make.disabled) return;
    if (!base()) return say("Not connected to PairBrowse yet.", "error");
    const share = radios().find((r) => r.checked)?.value === "link" ? "link" : "code";
    const given = name.value.trim();
    make.disabled = true;
    say("");
    const r = await postJson(base() + "invite", { share, ...(given ? { name: given } : {}) }).then((x) => x.json()).catch(() => ({ error: "Couldn't reach PairBrowse." }));
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
  return { open, close };
}

// The session switcher (the strip's chevron, the left dock's Workspace header and Sessions row):
// ui/picker in a same-origin iframe inside pop, loaded only while open and unloaded on close. It
// closes on the picker's "picked" or "close" notice (from that frame and this origin only), on
// Escape and on a click outside pop and every opener; focus goes back to the opener that opened
// it, except after a click outside. The parent never posts to the frame. openers: the buttons
// that toggle it (each gets aria-expanded). dismissable(): false while a host owns dismissal (the
// strip's #switcher bubble): no notice, Escape or outside click closes it then.
export function pickerPopover({ pop, frame, openers, dismissable = () => true }) {
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
    frame.src = "../picker/index.html";
    pop.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    if (dismissable()) document.addEventListener("pointerdown", outside, true);
    window.addEventListener("message", onMessage);
    frame.focus();
  }
  function close(refocus = true) {
    if (!isOpen()) return;
    frame.removeAttribute("src");
    pop.hidden = true;
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

// The page is served by the PairBrowse browser itself, on its own hosts (the window's slots on
// chrome://pairbrowse.top-chrome, the tab pages on chrome://pairbrowse), with or without
// window.pairbrowse; anything else is a page in a plain browser (the extension, the harness).
export const servedByBrowser = (loc = globalThis.location) => loc?.protocol === "chrome:" && (loc.host === "pairbrowse.top-chrome" || loc.host === "pairbrowse");

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
  fetch(base + "layout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [side]: state }) }).then((r) => { if (!r.ok) onFail?.(); }, () => onFail?.());
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
// page holding the stream; deltas (approval, timeline, downloads, handoffs) are never replayed:
// pages fetch their snapshot in onOpen. One-shot fields are never replayed either: a layout
// event's `tab` (the right dock opening on a tab) and a record event's `op` ("saved", with its
// item), so a late page neither jumps to a tab nor adds a recording from an old event. Without Web Locks or BroadcastChannel (or when the lock is refused) a page
// opens its own stream as before. No timer, frame or observer anywhere here.
export const STREAM_EVENTS = ["activity", "agent-tabs", "board", "collaboration", "dev", "join", "joinhost", "layout", "pause", "profile", "record", "session", "status", "tabs", "timeline", "approval", "driving", "downloads", "handoffs"];
const STREAM_DELTAS = new Set(["approval", "timeline", "downloads", "handoffs"]);
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
// The helper's page kinds: one of them on the stream gets the browser pages' initial burst
// (agent-tabs); the helper sends the same burst to every kind, so one kind stands for all.
const STREAM_KINDS = new Set(["strip", "left", "right", "timeline", "approve", "picker", "screen", "capture"]);

// One EventSource to the helper: event(name, parsed data) for every STREAM_EVENTS name (a body
// that is not JSON is dropped), state("live" | "connecting" | "closed").
function openStream(base, kind, { event, state }) {
  const es = new EventSource(base + "events?panel=1" + (kind ? `&page=${kind}` : ""));
  es.onopen = () => state("live");
  es.onerror = () => state(es.readyState === EventSource.CLOSED ? "closed" : "connecting");
  for (const name of STREAM_EVENTS) {
    es.addEventListener(name, (e) => { let v; try { v = JSON.parse(e.data); } catch { return; } event(name, v); });
  }
  return es;
}

// helperStream(base, { kind, onState, onOpen }) -> { on(name, fn), close() }. base: the helper's
// `${origin}/${key}/`. kind: the page's own helper page kind, or "". onState(s) on every state
// change; onOpen() each time the stream goes live (fetch snapshots there). Nothing is delivered
// during the call itself, so on() calls made right after it miss nothing.
export function helperStream(base, { kind = "", onState = () => {}, onOpen = () => {} } = {}) {
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
  let closed = false;
  let es = null;

  // A stream of this page's own (no Web Locks or BroadcastChannel, or the lock refused).
  function own() {
    if (closed) return;
    es = openStream(base, ownKind, { event: deliver, state: setState });
  }

  let name = "";
  try { name = "pairbrowse-stream " + new URL(base).origin; } catch { name = ""; }
  if (!name || typeof navigator.locks?.request !== "function" || typeof BroadcastChannel !== "function" || typeof crypto?.randomUUID !== "function") {
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
