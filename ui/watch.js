// Watch links in the owner's own pages (the side panel and the Handoff page): "Copy watch link" makes
// one with a click (the helper's own invite code: POST invite { share: "watch", hours }) and copies
// it at once, and the watch links open now are listed from the invites event, each with how many
// pages watch through it, when it ends and Stop, with Stop all under them. The link is in the click's
// answer alone: never kept here, listed or sent in an event (the invites event carries ids, counts and
// times, never a key). A flat file at the ui/ root, imported by those pages only (the live view
// doesn't serve it); definitions only, nothing runs on import.
import { el } from "./dom.js";
import { busy } from "./motion.js";
import { postJson, UNREACHABLE } from "./helper.js";

// The durations offered, in hours (liveview/invites.mjs WATCH_HOURS), and their words.
export const WATCH_CHOICES = Object.freeze([[0.25, "15 minutes"], [1, "1 hour"], [4, "4 hours"], [24, "24 hours"]]);
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const watchingWords = (n) => (n > 0 ? `${n} watching` : "Nobody watching yet");

// Copies text from a click, the click's permission kept across the wait for the link: the clipboard
// takes a promise of the text (ClipboardItem) where the browser allows it, else the text once it is
// there. Resolves true when copied.
export async function copyLater(textPromise, scope = globalThis) {
  const clip = scope.navigator?.clipboard;
  if (clip?.write && typeof scope.ClipboardItem === "function") {
    try {
      await clip.write([new scope.ClipboardItem({ "text/plain": textPromise.then((t) => { if (!t) throw new Error("no link"); return new Blob([t], { type: "text/plain" }); }) })]);
      return true;
    } catch {}
  }
  const text = await textPromise.catch(() => "");
  if (!text) return false;
  try { await clip.writeText(text); return true; } catch { return false; }
}

// button: Copy watch link. list: the <ul> of open watch links. msg: the status line. field: a
// read-only input that shows the link when it couldn't be copied (or null). base(): the helper's
// address, or null. hours(): the duration picked (1 by default). onMade(answer): a link was made.
// row: what holds them all (or null), shown once the helper answers invites.json (a helper without
// the route shows none of it).
// Returns { draw(items) (items: the invites event's, or invites.json's), load() (reads invites.json) }.
export function watchLinks({ button, list, msg, field = null, row = null, base, hours = () => 1, onMade = () => {} }) {
  const say = (text, kind = "") => { msg.textContent = text; msg.dataset.kind = kind; };
  const post = (body) => postJson(base() + "invite", body).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })).catch(() => ({ status: 0, body: {} }));

  // A person's click or key press only: a synthetic event makes nothing.
  button.addEventListener("click", async (ev) => {
    if (!ev.isTrusted || button.getAttribute("aria-busy") === "true") return;
    if (!base()) return say(UNREACHABLE, "error");
    say("");
    if (field) { field.hidden = true; field.value = ""; }
    let answer = null;
    const made = post({ share: "watch", hours: hours() }).then((r) => { answer = r; return r.status === 200 && typeof r.body?.link === "string" ? r.body.link : ""; });
    const copied = await busy(button, () => copyLater(made));
    const link = await made;
    if (!link) return say(answer?.body?.error || (answer?.status === 0 ? UNREACHABLE : "Couldn't make the watch link."), "error");
    const until = answer.body.expiresAt ? ` until ${time(answer.body.expiresAt)}` : "";
    if (copied) say(`Copied. Anyone with the link can watch${until}, view only.`, "ok");
    else {
      say(`Made, but not copied: select the link and copy it. Anyone with it can watch${until}.`, "error");
      if (field) { field.value = link; field.hidden = false; field.focus(); field.select(); }
    }
    onMade(answer.body);
  });

  async function stop(body, row) {
    if (!base()) return say(UNREACHABLE, "error");
    const r = await busy(row, () => post(body));
    if (r.status === 200) say(body.op === "stop_watch" ? "Every watch link stopped. Their pages went dark." : "Stopped. That link's pages went dark.", "ok");
    else say(r.body?.error || (r.status === 0 ? UNREACHABLE : "Couldn't stop it."), "error");
  }

  function draw(items) {
    const open = (Array.isArray(items) ? items : []).filter((i) => i?.share === "watch").sort((a, b) => a.expires - b.expires);
    list.hidden = !open.length;
    const rows = open.map((i) => {
      const stopBtn = el("button", { className: "mini watch-stop", type: "button", textContent: "Stop" });
      stopBtn.setAttribute("aria-label", `Stop the watch link ending at ${time(i.expires)}`);
      stopBtn.addEventListener("click", (ev) => { if (ev.isTrusted) stop({ op: "revoke", id: i.id }, stopBtn); });
      const n = Number(i.watching) || 0;
      const li = el("li", { className: "watch-item" },
        el("span", { className: "watch-text" }, el("strong", { textContent: watchingWords(n) }), el("small", { textContent: `${i.label || "Watch link"}, until ${time(i.expires)}` })),
        stopBtn);
      li.dataset.id = i.id;
      li.dataset.watching = String(n);
      return li;
    });
    if (open.length) {
      const all = el("button", { className: "mini watch-stop-all", type: "button", textContent: "Stop all" });
      all.setAttribute("aria-label", "Stop every watch link");
      all.addEventListener("click", (ev) => { if (ev.isTrusted) stop({ op: "stop_watch" }, all); });
      rows.push(el("li", { className: "watch-all" }, all));
    }
    list.replaceChildren(...rows);
  }
  // The list as it stands, read once per connection (the invites event keeps it current).
  async function load() {
    if (!base()) return;
    const r = await fetch(base() + "invites.json").then((x) => (x.ok ? x.json() : null)).catch(() => null);
    if (!r) return;
    if (row) row.hidden = false;
    draw(r.items);
  }
  return { draw, load };
}
