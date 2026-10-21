// The helper's questions and lists as the docks, Settings and the live view show them: people
// asking to join, join addresses, dev servers, the profile. Real clicks only. Shared by the pages
// and the live view (common.js re-exports it; the live view serves it). A flat file at the ui/
// root; definitions only, nothing runs on import.
import { postJson, UNREACHABLE, UNREACHABLE_RETRY } from "./helper.js";
import { $, el } from "./dom.js";
import { leave } from "./motion.js";

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
      const role = r.role === "approve" ? "can drive and approve" : r.role === "drive" ? "can drive" : "watch";
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

// A press on one of a row's buttons, posted to route: the buttons wait meanwhile (the pressed one
// busy), and a failure is said in the row (rowSay), cleared by the next answer.
const sender = (base, route) => (body, buttons) => {
  if (!base()) return;
  for (const b of buttons) b.disabled = true;
  const pressed = buttons.find((b) => b === document.activeElement) || buttons[0];
  pressed?.setAttribute("aria-busy", "true");
  const row = pressed?.closest(".join, li");
  postJson(base() + route, body).then((r) => { if (!r.ok) throw r; if (row) rowSay(row, ""); })
    .catch((r) => { if (row) rowSay(row, r?.status ? "That didn't go through. Try again." : UNREACHABLE_RETRY); })
    .finally(() => { pressed?.removeAttribute("aria-busy"); for (const b of buttons) b.disabled = false; });
};
// A person's own pointer click only: no synthetic event, no keyboard default.
const real = (fn) => (ev) => { if (ev.isTrusted && ev.detail > 0) fn(); };

// A join code whose address isn't a PairBrowse one (*.trycloudflare.com) or one this person
// allowed: the question in asks, with the address plainly and Allow once / Always allow / Cancel,
// and in list the addresses allowed (Remove). The person decides here, never an agent or a page:
// real clicks only, posted to the live view with the owner's key. Returns draw({ asks, hosts }).
export function hostPanel(asks, list, section, base) {
  const send = sender(base, "joinhost");
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
  const send = sender(base, "dev");
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
      // A reserved one (PairBrowse's own credential, a proxy's or a hand-off channel's) has no
      // sites and is set from Settings, not here: delete only.
      const own = x.reserved === true;
      const tools = own ? [del] : [replace, del];
      const acts = el("span", {}, ...tools);
      del.addEventListener("click", () => {
        const yes = el("button", { className: "mini bad", type: "button", textContent: "Delete", ariaLabel: `Yes, delete ${x.name}` });
        const keep = el("button", { className: "mini", type: "button", textContent: "Keep" });
        const back = () => { acts.replaceChildren(...tools); del.focus(); };
        keep.addEventListener("click", back);
        for (const b of [yes, keep]) b.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !yes.disabled) { ev.preventDefault(); ev.stopPropagation(); back(); } });
        yes.addEventListener("click", async () => { yes.disabled = true; const e = await change({ op: "deleteSecret", name: x.name }); say(e || `Deleted ${x.name}.`, e ? "error" : "ok"); if (e) back(); });
        acts.replaceChildren(el("small", { className: "ask", textContent: "Delete it?" }), yes, keep);
        keep.focus();
      });
      const sites = own ? "PairBrowse's own, never typed into pages" : x.domains.join(", ");
      return el("div", { className: "row secret" }, el("div", { className: "label", title: x.name }, x.name), el("div", { className: "sites", title: sites, textContent: sites }), acts);
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
    // Back to the label for the next one only when the person is still here: a reply that comes
    // while they type elsewhere leaves the focus where they are (nothing jumps).
    const here = f.contains(document.activeElement) || document.activeElement === document.body || !document.activeElement;
    say(`Remembered ${f.label.value}.`, "ok"); f.reset();
    if (here) f.label.focus();
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

// The Away switch (spec server-mode decision 8): while it is on, a step handed to the person from
// this computer also goes to their phone through their hand-off channel; the step stays in the
// window too, and whichever they use first completes it. Off by default, remembered (config.json
// handoff.away), and only with a channel set up (the line says so if none is); on a server always
// on, and not a switch there. btn: a role="switch" button; note: its line; base(): the live view
// address (null: not yet). Real clicks only. Returns draw(away), with config.json's away
// ({ on, server, ready, publicLink, privateRoute }; anything else: an older helper, the switch
// stays off and disabled).
// The public link (step 21b, handoff.publicLink): with a channel set up and no private route (no
// inviteBaseUrl, so a phone elsewhere can't reach the link), a line under the switch offers it, its
// exposure in one sentence; once on, the same line says so and turns it off. On a server too.
export const AWAY_WORDS = {
  server: "This browser runs on a server: steps handed to you always go to your phone.",
  none: "Set up a hand-off channel first (handoff in config.json), then turn this on.",
  on: "On: steps handed to you also go to your phone. They stay here too.",
  off: "Off: steps handed to you stay in this window.",
};
export const PUBLIC_WORDS = {
  offer: "Away from this network, the link needs a public address: while a step is handed over, a free relay (Cloudflare) carries that one tab to whoever opens the link first, until it ends.",
  on: "Public link on: while a step is handed over, its link works from anywhere through a free relay (Cloudflare).",
  turnOn: "Use a public link",
  turnOff: "Stop the public link",
};
export function awaySwitch(btn, note, base) {
  let st = null;
  const say = (text, kind = "") => { note.textContent = text; note.dataset.kind = kind; };
  // The public link's line, under the switch's own.
  const pubText = el("span");
  const pubBtn = el("button", { className: "mini", type: "button" });
  const pub = el("small", { className: "away-offer", hidden: true }, pubText, " ", pubBtn);
  note.after(pub);
  function draw(away) {
    st = away && typeof away === "object" && typeof away.on === "boolean" ? away : null;
    const on = !!st && (st.server === true || st.on);
    btn.setAttribute("aria-checked", String(on));
    btn.disabled = !st || st.server === true || (!st.on && st.ready !== true);
    say(!st ? "" : st.server === true ? AWAY_WORDS.server : st.ready !== true ? AWAY_WORDS.none : on ? AWAY_WORDS.on : AWAY_WORDS.off);
    const pubOn = st?.publicLink === true;
    pub.hidden = !st || (!pubOn && (st.ready !== true || st.privateRoute === true));
    pubText.textContent = pubOn ? PUBLIC_WORDS.on : PUBLIC_WORDS.offer;
    pubBtn.textContent = pubOn ? PUBLIC_WORDS.turnOff : PUBLIC_WORDS.turnOn;
    pubBtn.disabled = false;
  }
  // One setting posted; the answer's away drawn, or the error said.
  async function post(body, was) {
    const r = await postJson(base() + "config", body).then(async (x) => ({ ok: x.ok, body: await x.json().catch(() => null) }), () => null);
    if (r?.ok && r.body?.away) return draw(r.body.away);
    draw(was);
    say(r?.body?.error ? String(r.body.error) : UNREACHABLE_RETRY, "error");
  }
  btn.addEventListener("click", async (ev) => {
    if (!ev.isTrusted || !st || btn.disabled || !base()) return;
    btn.disabled = true;
    await post({ away: !st.on }, st);
  });
  pubBtn.addEventListener("click", async (ev) => {
    if (!ev.isTrusted || !st || pubBtn.disabled || !base()) return;
    pubBtn.disabled = true;
    await post({ publicLink: st.publicLink !== true }, st);
  });
  return { draw };
}

// The Profile panel's saved card (spec server-mode B12), the owner's only: what the running
// browser's profile asked for and got (GET saved-card.json: { asked, on, line }), and "Add a saved
// card", which opens the browser's payment methods page as the person's own tab and shows it here
// (POST saved-card). Agents never open it; a hand-off fills the saved card with "Fill saved card".
// box: its section (hidden while the profile asks for no saved card); note, btn, msg: its line, its
// button and its answer line; base(): the live view address. Real clicks only. Returns { load }.
export const CARD_WORDS = {
  on: "On for this session. Card details are saved encrypted on the machine the browser runs on; only you fill them, during a hand-off. Claude never sees or types them.",
  opened: "The payment methods page is open: add the card there.",
};
export function savedCardPanel(box, note, btn, msg, base) {
  const say = (text, kind = "") => { msg.textContent = text; msg.dataset.kind = kind; };
  function draw(c) {
    box.hidden = !(c && c.asked === true);
    if (box.hidden) return;
    note.textContent = c.on === true ? CARD_WORDS.on : String(c.line || "");
    btn.hidden = c.on !== true;
  }
  const load = () => (base() ? fetch(base() + "saved-card.json", { signal: AbortSignal.timeout(8000) }).then((x) => (x.ok ? x.json() : null)).then(draw, () => {}) : Promise.resolve());
  btn.addEventListener("click", async (ev) => {
    if (!ev.isTrusted || btn.disabled || !base()) return;
    btn.disabled = true;
    say("");
    const r = await postJson(base() + "saved-card", {}).then(async (x) => ({ ok: x.ok, body: await x.json().catch(() => null) }), () => null);
    btn.disabled = false;
    if (r?.ok) say(CARD_WORDS.opened);
    else say(r?.body?.error ? String(r.body.error) : UNREACHABLE_RETRY, "error");
  });
  return { load };
}
