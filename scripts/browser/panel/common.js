// Shared by the side panel, the new tab page and the live view (which serves this file from here:
// an extension can load only its own files). The live view's server imports addressToUrl too, so
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

// People asking to join: Allow or Deny, always by a click. Banners go into container; base():
// the live view address (null: not connected yet). Returns draw(list of requests).
export function joinBanners(container, base) {
  const rows = new Map(); // request id -> banner
  function answer(id, allow, row) {
    if (!base()) return;
    for (const b of row.querySelectorAll("button")) b.disabled = true;
    postJson(base() + "approve", { id, allow })
      .then((r) => { if (!r.ok) throw new Error(); })
      .catch(() => { for (const b of row.querySelectorAll("button")) b.disabled = false; });
  }
  return function draw(list) {
    const pending = Array.isArray(list) ? list.filter((r) => r && r.id && (!r.state || r.state === "pending")) : [];
    const ids = new Set(pending.map((r) => String(r.id)));
    for (const [id, row] of rows) if (!ids.has(id)) { row.remove(); rows.delete(id); }
    for (const r of pending) {
      const id = String(r.id);
      if (rows.has(id)) continue;
      const allow = el("button", { className: "primary", type: "button", textContent: "Allow" });
      const deny = el("button", { className: "mini", type: "button", textContent: "Deny" });
      const text = `${r.name || "Someone"}${r.app ? ` (${r.app})` : ""} wants to join (${r.role === "drive" ? "can drive" : "watch"})`;
      const row = el("div", { className: "join" }, el("strong", { textContent: text, title: text }), el("span", {}, allow, deny));
      // A real pointer click only: no synthetic events, no keyboard default.
      allow.addEventListener("click", (ev) => { if (ev.isTrusted && ev.detail > 0) answer(r.id, true, row); });
      deny.addEventListener("click", (ev) => { if (ev.isTrusted) answer(r.id, false, row); });
      rows.set(id, row);
      container.append(row);
    }
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
    const name = /^[A-Z][A-Z0-9_]+$/.test(f.label.value) ? f.label.value : toName(f.label.value) + (/PASSWORD|_PW$/.test(toName(f.label.value)) ? "" : "_PASSWORD");
    const err = await change({ op: "setSecret", name, value: f.value.value, domains: f.domains.value });
    f.value.value = ""; // never keep a password in the page longer than needed
    if (err) return say(err, "error");
    say(`Saved ${name}. Claude can use it by that name on ${f.domains.value}.`, "ok");
    f.reset(); f.value.placeholder = "Password";
  });
  return { draw, load, say };
}
