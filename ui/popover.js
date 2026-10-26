// Cards and questions over a page: Share, the session switcher, the switch question, and asking
// for a dock's state. Shared by the pages and the live view (common.js re-exports it; the live view
// serves it). A flat file at the ui/ root; definitions only, nothing runs on import.
import { postJson, UNREACHABLE } from "./helper.js";
import { el } from "./dom.js";
import { busy } from "./motion.js";

// Share (the side panel's header, the live view's toolbar): a card under btn that makes a join
// code (shared browser, can drive; or can drive and approve: role "approve") or a watch link with the owner's own key, through the
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
    const picked = radios().find((r) => r.checked)?.value;
    // A watch link: view only, opens in any browser for whoever has it (share "watch", an hour).
    const share = picked === "link" ? "watch" : "code";
    // The third choice: a join code whose joiner may also answer approval cards (role approve).
    const role = picked === "approve" ? { role: "approve" } : {};
    const given = name.value.trim();
    make.disabled = true;
    say("");
    const r = await busy(make, () => postJson(base() + "invite", { share, ...role, ...(given ? { name: given } : {}) }).then((x) => x.json()).catch(() => ({ error: UNREACHABLE })));
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
