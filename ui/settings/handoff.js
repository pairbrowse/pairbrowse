// Settings' Handoff section (spec Handoff; the engine settings' Handoff page frames the settings page
// with ?view=handoff, 580): link Telegram or Discord to your phone with a bot of your own and a
// one-time code, choose what goes there, answer approvals from chat. Once an app is linked, every
// step handed to you goes to your phone too (no switch: unlinking stops it), and the linked card
// says so in one sentence with what the link exposes (panels.js phoneLine, config.json's phone).
// Reads GET handoff.json, writes POST handoff { op: link | cancel | unlink | test | set } (owner
// only), redraws from each answer's summary and from the helper's `handoff` event. The summary
// never holds a token, a chat id or a user id; a token typed here leaves the field as it is posted.
// Real clicks only. The one timer: a pending code's countdown,
// once a second while a code waits and the page shows; nothing is polled.
import { el } from "../dom.js";
import { phoneLine } from "../panels.js";
import { postReply, UNREACHABLE } from "../helper.js";
import { watchLinks } from "../watch.js";
import { copyText, copyFailed } from "../clipboard.js";

const SVG = "http://www.w3.org/2000/svg";
const real = (fn) => (ev) => { if (ev.isTrusted) fn(ev); };

// An icon of stroked paths (and filled dots), as the page's other icons, built without markup.
function icon(viewBox, paths, dots = []) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG, "path");
    for (const [k, v] of [["d", d], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.5"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]]) p.setAttribute(k, v);
    svg.append(p);
  }
  for (const [cx, cy] of dots) {
    const c = document.createElementNS(SVG, "circle");
    for (const [k, v] of [["cx", cx], ["cy", cy], ["r", "1.1"], ["fill", "currentColor"]]) c.setAttribute(k, String(v));
    svg.append(c);
  }
  return svg;
}

// Each app: its neutral mark (a paper plane, a chat bubble: not the apps' own art), its words.
export const APPS = {
  telegram: {
    name: "Telegram",
    mark: () => icon("0 0 20 20", ["M17.6 2.8 2.4 9.2l5.4 2 2 5.6 2.9-3.8 4 3.1z", "M7.8 11.2 17.6 2.8"]),
    via: "Bot API",
    steps: [
      "In Telegram, open @BotFather and send /newbot.",
      "Give the bot a name. BotFather answers with its token.",
      "Paste the token here and press Link.",
    ],
    placeholder: "123456789:AA…",
    sendTo: (bot) => `Send this code to ${bot || "your bot"} in Telegram.`,
  },
  discord: {
    name: "Discord",
    mark: () => icon("0 0 20 20", ["M4 4.5h12A1.5 1.5 0 0 1 17.5 6v7a1.5 1.5 0 0 1-1.5 1.5H9.2l-3.7 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5z"], [[7.4, 9.5], [12.6, 9.5]]),
    via: "Bot, direct messages",
    steps: [
      "In the Discord Developer Portal, make an application. On its Bot tab, press Reset Token and copy it.",
      "Under Installation, add the bot to a server you are in (Guild Install, scope bot) and allow direct messages from that server's members.",
      "Paste the token here and press Link.",
    ],
    placeholder: "Bot token",
    sendTo: (bot) => `Send this code to ${bot || "your bot"} in a direct message on Discord.`,
  },
};
const STATES = new Set(["none", "pending", "linked"]);
const PILL = { none: "Not linked", pending: "Waiting for your message", linked: "Linked" };
const SEND_KEYS = ["approvals", "checks", "submits", "runs"];

// "9:42 left" for a code that ends at `at` (epoch ms), "" once it has ended.
export function timeLeft(at, now = Date.now()) {
  const s = Math.ceil((Number(at) - now) / 1000);
  if (!Number.isFinite(s) || s <= 0) return "";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
}

// One app as the summary has it, its fields checked; null for anything else.
function appOf(a) {
  if (!a || typeof a !== "object" || !STATES.has(a.state)) return null;
  const str = (v) => (typeof v === "string" ? v : "");
  return { state: a.state, bot: str(a.bot), chat: str(a.chat), code: a.state === "pending" ? str(a.code) : "", expiresAt: a.state === "pending" ? Number(a.expiresAt) || 0 : 0, error: str(a.error) };
}
export function summaryOf(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const telegram = appOf(raw.telegram), discord = appOf(raw.discord);
  if (!telegram || !discord) return null;
  const send = raw.send && typeof raw.send === "object" ? raw.send : {};
  return { on: raw.on === true, server: raw.server === true, ready: raw.ready === true, answer: raw.answer === true,
    watchCommand: raw.watchCommand !== false, watchInMessages: raw.watchInMessages === true,
    send: Object.fromEntries(SEND_KEYS.map((k) => [k, send[k] === true])), telegram, discord };
}

// $: the page's lookup by id; base(): the live view address (null: not connected); live(): the
// stream is up; shown(on): whether there is a section (the helper answered handoff.json), told on
// every draw; missing(): the helper answered 404 (an older one).
export function handoffPanel({ $, base, live, shown = () => {}, missing = () => {} }) {
  let state = null; // the summary drawn last
  let phone = null; // config.json's phone ({ ready, server, privateRoute, via }) drawn last
  const cards = {};
  const say = (node, text, kind = "") => { node.textContent = text; node.dataset.kind = kind; };

  async function post(body) {
    if (!base() || !live()) return { error: "Not connected to PairBrowse." };
    const r = await postReply(base() + "handoff", body);
    if (r.status === 200 && r.body) return r.body;
    return { error: r.body?.error ? String(r.body.error) : r.status === 0 ? UNREACHABLE : r.status === 404 ? "This PairBrowse helper has no Handoff yet." : "That didn't work." };
  }
  // A button's request: it waits (busy) meanwhile, the answer is said in its card's line.
  async function run(btn, body, msg, busy) {
    const was = btn.textContent;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    if (busy) btn.textContent = busy;
    say(msg, "");
    const r = await post(body);
    btn.removeAttribute("aria-busy");
    btn.textContent = was;
    btn.disabled = !live();
    if (r.error) { say(msg, r.error, "error"); return null; }
    if (r.handoff) draw(r.handoff);
    if (r.text) say(msg, String(r.text), "ok");
    return r;
  }

  // ---- one card per app ----
  function card(app) {
    const A = APPS[app];
    const pill = el("span", { className: "ho-pill" });
    const sub = el("small", { className: "ho-sub" });
    const name = el("h4", { className: "ho-name", id: `ho-${app}-name`, textContent: A.name });
    const head = el("div", { className: "ho-head" }, el("span", { className: "ho-mark" }, A.mark()), el("div", { className: "ho-title" }, name, sub), pill);
    const body = el("div", { className: "ho-body" });
    const err = el("p", { className: "ho-err", id: `ho-${app}-err`, hidden: true });
    const msg = el("p", { className: "msg ho-msg", id: `ho-${app}-msg` });
    msg.setAttribute("role", "status");
    msg.setAttribute("aria-live", "polite");
    // The app's own error (a webhook set, a token refused) under its head, so the body's last row
    // stays at the card's foot in line with the other card's.
    const root = el("section", { className: "ho-card", id: `ho-${app}` }, head, err, body, msg);
    root.setAttribute("aria-labelledby", name.id);
    const c = { app, A, root, pill, sub, body, err, msg, sig: "", left: null, expired: false };
    cards[app] = c;
    return c;
  }

  // Not linked: the steps, the token field and Link.
  function noneBody(c, a) {
    const input = el("input", { className: "field mono", id: `ho-${c.app}-token`, type: "password", autocomplete: "off", spellcheck: false, maxLength: 200, placeholder: c.A.placeholder });
    input.setAttribute("autocapitalize", "off");
    const link = el("button", { className: "primary", type: "submit", id: `ho-${c.app}-link`, textContent: "Link" });
    const steps = el("ol", { className: "ho-steps" }, ...c.A.steps.map((t) => el("li", { textContent: t })));
    const form = el("form", { className: "ho-form", autocomplete: "off" },
      el("label", { className: "lab", htmlFor: input.id }, `${c.A.name} bot token`),
      el("div", { className: "ho-field" }, input, link));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = input.value.trim();
      if (!token && !a.bot) { say(c.msg, `Paste the ${c.A.name} bot token first.`, "error"); input.focus(); return; }
      input.value = ""; // never kept in the page
      const body = token ? { op: "link", app: c.app, token } : { op: "link", app: c.app };
      await run(link, body, c.msg, "Checking…");
    });
    return [steps, form];
  }
  // Waiting for your message: the code, Copy, where to send it, the countdown, Cancel.
  function pendingBody(c, a) {
    const code = el("code", { className: "ho-code-text", id: `ho-${c.app}-code`, textContent: a.code });
    const copy = el("button", { className: "mini ho-copy", type: "button", id: `ho-${c.app}-copy`, textContent: "Copy", ariaLabel: `Copy the code ${a.code}` });
    copy.addEventListener("click", real(async () => {
      if (await copyText(a.code)) {
        copy.textContent = "Copied";
        say(c.msg, "Copied the code.", "ok");
        setTimeout(() => { if (copy.isConnected) copy.textContent = "Copy"; }, 1600);
      } else {
        say(c.msg, copyFailed("the code"), "error");
        try { getSelection()?.selectAllChildren(code); } catch {} // selected, ready for the shortcut
      }
    }));
    const left = el("span", { className: "ho-left", id: `ho-${c.app}-left` });
    const wait = el("p", { className: "ho-wait" }, el("span", { className: "ho-dot", ariaHidden: "true" }), el("span", { className: "ho-wait-text", textContent: "Listening for the code" }), left);
    const cancel = el("button", { className: "action", type: "button", id: `ho-${c.app}-cancel`, textContent: "Cancel" });
    cancel.addEventListener("click", real(() => run(cancel, { op: "cancel", app: c.app }, c.msg, "Cancelling…")));
    const again = el("button", { className: "primary", type: "button", id: `ho-${c.app}-again`, textContent: "New code", hidden: true });
    again.addEventListener("click", real(() => run(again, { op: "link", app: c.app }, c.msg, "Asking…")));
    c.left = { left, wait, again, code };
    return [
      el("div", { className: "ho-code" }, code, copy),
      el("p", { className: "ho-line", textContent: c.A.sendTo(a.bot) }),
      wait,
      el("div", { className: "acts ho-acts" }, again, cancel),
    ];
  }
  // Linked: who, Send a test, Unlink (asked in place).
  function linkedBody(c, a) {
    const who = el("p", { className: "ho-linked" }, icon("0 0 16 16", ["M3.5 8.4 6.6 11.4 12.5 5"]),
      el("span", {}, "Linked to ", el("b", { textContent: a.chat || "your chat" }), a.bot ? ` via ${a.bot}` : ""));
    const test = el("button", { className: "action", type: "button", id: `ho-${c.app}-test`, textContent: "Send a test" });
    const unlink = el("button", { className: "mini bad", type: "button", id: `ho-${c.app}-unlink`, textContent: "Unlink" });
    const acts = el("div", { className: "acts ho-acts" }, test, unlink);
    test.addEventListener("click", real(() => run(test, { op: "test", app: c.app }, c.msg, "Sending…")));
    unlink.addEventListener("click", real(() => {
      // An in-place question (a framed page gets no confirm() dialog).
      const yes = el("button", { className: "mini bad solid", type: "button", id: `ho-${c.app}-unlink-yes`, textContent: "Unlink", ariaLabel: `Yes, unlink ${c.A.name}` });
      const keep = el("button", { className: "mini", type: "button", textContent: "Keep" });
      const back = () => { acts.replaceChildren(test, unlink); unlink.focus(); };
      keep.addEventListener("click", back);
      for (const b of [yes, keep]) b.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); back(); } });
      yes.addEventListener("click", real(async () => {
        keep.disabled = true;
        if (!(await run(yes, { op: "unlink", app: c.app }, c.msg, "Unlinking…")) && acts.isConnected) back();
      }));
      acts.replaceChildren(el("span", { className: "ask", textContent: `Unlink ${c.A.name}?` }), yes, keep);
      keep.focus();
    }));
    // What linking means, once, next to the linked app: steps go to the phone too, through a link
    // that works from anywhere (or on your own address), while the step is open.
    const line = el("p", { className: "ho-phone-line", id: `ho-${c.app}-phone`, textContent: phoneLine(phone) || phoneLine({ ready: true }) });
    return [who, line, acts];
  }

  function drawCard(c, a) {
    c.root.dataset.state = a.state;
    c.pill.textContent = PILL[a.state];
    c.pill.dataset.state = a.state;
    c.sub.textContent = c.A.via;
    c.err.hidden = !a.error;
    c.err.textContent = a.error;
    // The body is built again only when what it shows changed (an event mid-typing keeps the field).
    const sig = JSON.stringify([a.state, a.bot, a.chat, a.code]);
    if (sig !== c.sig) {
      // A new state (linked, a new code, cancelled): an earlier message about the old one goes.
      if (c.shownState !== undefined && c.shownState !== a.state) say(c.msg, "");
      c.shownState = a.state;
      const had = c.root.contains(document.activeElement);
      c.sig = sig;
      c.left = null;
      c.expired = false;
      c.body.replaceChildren(...(a.state === "pending" ? pendingBody(c, a) : a.state === "linked" ? linkedBody(c, a) : noneBody(c, a)));
      // Focus stays in the card that changed: on its first control.
      if (had) c.root.querySelector(".ho-body input, .ho-body button:not([hidden])")?.focus();
    }
    c.expiresAt = a.expiresAt;
    tickCard(c);
    for (const b of c.body.querySelectorAll("button, input")) if (!b.hasAttribute("aria-busy")) b.disabled = !live();
  }

  // ---- the countdown: once a second while a code waits and the page shows ----
  let timer = 0;
  function tickCard(c) {
    if (!c.left) return;
    const t = timeLeft(c.expiresAt);
    const expired = !t;
    c.left.left.textContent = t;
    if (expired !== c.expired) {
      c.expired = expired;
      c.root.toggleAttribute("data-expired", expired);
      c.left.wait.querySelector(".ho-wait-text").textContent = expired ? "This code ended. Ask for a new one." : "Listening for the code";
      c.left.again.hidden = !expired;
    }
  }
  function clock() {
    const waiting = Object.values(cards).some((c) => c.left && !c.expired);
    if (waiting && !document.hidden && !timer) timer = setInterval(() => { for (const c of Object.values(cards)) tickCard(c); clock(); }, 1000);
    else if ((!waiting || document.hidden) && timer) { clearInterval(timer); timer = 0; }
  }
  document.addEventListener("visibilitychange", () => { for (const c of Object.values(cards)) tickCard(c); clock(); });

  // ---- what goes, answering; the phone line ----
  const answerBtn = $("ho-answer"), setMsg = $("ho-set-msg");
  const checks = [...document.querySelectorAll("#ho-send .ho-check")];
  function drawPhone(p) {
    if (p && typeof p === "object") phone = p;
    for (const n of document.querySelectorAll(".ho-phone-line")) n.textContent = phoneLine(phone) || phoneLine({ ready: true });
  }

  async function set(body, node) {
    node?.setAttribute("aria-busy", "true");
    say(setMsg, "Saving…");
    const r = await post({ op: "set", ...body });
    node?.removeAttribute("aria-busy");
    if (r.error) { say(setMsg, r.error, "error"); drawOptions(); return; }
    if (r.handoff) draw(r.handoff);
    say(setMsg, r.text ? String(r.text) : "Saved.", "ok");
  }
  for (const box of checks) box.addEventListener("change", real(() => set({ send: { [box.dataset.send]: box.checked } }, box.closest(".ho-opt"))));
  answerBtn.addEventListener("click", real(() => {
    if (!state) return;
    const on = answerBtn.getAttribute("aria-checked") !== "true";
    answerBtn.setAttribute("aria-checked", String(on));
    set({ answer: on }, null);
  }));
  function drawOptions() {
    for (const box of checks) { box.checked = !!state?.send[box.dataset.send]; box.disabled = !state || !live(); }
    answerBtn.setAttribute("aria-checked", String(!!state?.answer));
    answerBtn.disabled = !state || !live();
    watchCmd.setAttribute("aria-checked", String(state ? state.watchCommand : true));
    watchCmd.disabled = !state || !live();
    watchIn.setAttribute("aria-checked", String(!!state?.watchInMessages));
    watchIn.disabled = !state || !live();
    $("ho-watch-copy").disabled = !live();
  }

  // ---- watch links (ui/watch.js): Copy watch link, the open ones, /watch and the messages' link ----
  const watchCmd = $("ho-watch-cmd"), watchIn = $("ho-watch-in");
  for (const [btn, key] of [[watchCmd, "watchCommand"], [watchIn, "watchInMessages"]]) {
    btn.addEventListener("click", real(() => {
      if (!state || btn.disabled) return;
      const on = btn.getAttribute("aria-checked") !== "true";
      btn.setAttribute("aria-checked", String(on));
      set({ [key]: on }, null);
    }));
  }
  const watch = watchLinks({ button: $("ho-watch-copy"), list: $("ho-watch-list"), msg: $("ho-watch-msg"), field: $("ho-watch-field"), base: () => (live() ? base() : null),
    hours: () => Number($("ho-watch-hours").value) || 1 });

  // ---- the summary ----
  const apps = $("ho-apps");
  function draw(raw) {
    const s = summaryOf(raw);
    if (!s) return;
    state = s;
    if (!apps.children.length) apps.append(card("telegram").root, card("discord").root);
    $("ho-none").hidden = true;
    for (const app of ["telegram", "discord"]) drawCard(cards[app], s[app]);
    drawOptions();
    clock();
    try { shown(true); } catch {}
  }
  // The stream came or went: controls follow, what was read stays on screen.
  function setLive() {
    if (!state) $("ho-none").textContent = live() ? "Reading your apps…" : "Not connected to PairBrowse yet. Your apps show here once it is.";
    if (state) for (const app of ["telegram", "discord"]) drawCard(cards[app], state[app]);
    drawOptions();
  }
  async function load() {
    if (!base()) return false;
    const r = await fetch(base() + "handoff.json", { signal: AbortSignal.timeout(8000) })
      .then(async (x) => ({ status: x.status, body: x.ok ? await x.json().catch(() => null) : null }), () => ({ status: 0, body: null }));
    if (r.status === 404) { try { missing(); } catch {} return false; }
    if (r.status !== 200 || !summaryOf(r.body)) return false;
    draw(r.body);
    return true;
  }
  return { load, draw, drawPhone, setLive, drawWatch: (items) => watch.draw(items) };
}
