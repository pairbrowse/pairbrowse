  // An agent waits for the person's OK on a named final click (pay, delete, publish, send,
  // submit): the same card, on the same rules as a join request (a trusted pointer click, armed
  // AP_ARM_MS after what it shows changed, fully visible), shows "<agent> wants to click", the
  // target (as the agent described it), the rule's reason, Allow, Deny, "Ask in the terminal" and
  // × (for Codex and other apps, which have no prompt of their own: "I'll do it myself", the
  // step handed to the person). Claude Code's terminal asks at the same time; the card stays
  // until it's answered somewhere (no timer here: the helper takes it down), × only hides it here. Answers are recorded in their own chain (kind
  // "approval-answers"), checked again by the helper (daemon/approvals.mjs). Hidden while an agent
  // takes a screenshot (peers-hidden). Its text comes as an object, never through JSON.parse.
  const AP_ARM_MS = 600, AP_KEEP = 5, AP_ID = /^ap-[0-9a-f]{32}$/;
  const aps = new Map(); // id -> { who, color, target, reason, terminal, verb }, oldest first
  let apShown = "", apAt = 0, apHidden = false;
  let apAnswered = null, apCount = 0, apDismissed = "";
  function apHint(text) { const h = bar?.querySelector(".ab .an"); if (h) { h.textContent = text; h.hidden = !text; } }
  function apWire(shadow) {
    const jq = shadow.querySelector(".jq");
    const answer = (kind) => (e) => {
      const id = apShown;
      if (!e.isTrusted || !(e.detail > 0) || !id || !aps.has(id)) return;
      if (now() - apAt < AP_ARM_MS) return;
      const terminal = aps.get(id).terminal;
      const elsewhere = terminal ? "answer in the terminal." : "move what is over it, or do it yourself in the page.";
      if (!joinVisible || apHidden) return apHint(`Covered: ${elsewhere}`);
      if (apCount < 5) { apAnswered = { t: now(), kind, what: id, next: apAnswered }; apCount++; }
      // Recorded: the helper answers and takes the card down. A click it doesn't take (not a
      // person's own, as it checks again) gives the buttons back after a moment.
      for (const b of jq.querySelectorAll(".ab button")) b.disabled = true;
      apHint(kind === "approval-allow" ? "Allowing…" : kind === "approval-deny" ? "Denying…" : terminal ? "Passing to the terminal…" : "Handing it to you…");
      setTimeout(() => { if (apShown === id && aps.has(id)) { for (const b of jq.querySelectorAll(".ab button")) b.disabled = false; apHint(`Didn't go through: ${elsewhere}`); } }, 3000);
    };
    for (const b of jq.querySelectorAll(".ab button, .ab .ax")) b.addEventListener("mousedown", (e) => e.preventDefault()); // never takes focus from the page
    jq.querySelector(".aok").addEventListener("click", answer("approval-allow"));
    jq.querySelector(".ano").addEventListener("click", answer("approval-deny"));
    jq.querySelector(".atm").addEventListener("click", answer("approval-terminal"));
    jq.querySelector(".ax").addEventListener("click", (e) => { if (e.isTrusted && apShown) { apDismissed = `${apDismissed},${apShown}`.slice(-400); apOff(apShown); } });
  }
  function apFill(jq, id) {
    const a = aps.get(id);
    jq.classList.toggle("ph", apHidden);
    const ai = jq.querySelector(".ai");
    ai.style.background = a.color;
    ai.textContent = (a.who.trim().charAt(0) || "A").toUpperCase();
    jq.querySelector(".aw b").textContent = a.who;
    jq.querySelector(".aw .vb").textContent = a.verb;
    jq.querySelector(".ag").textContent = a.target;
    // Codex and other apps have no prompt of their own: the third button hands the step over.
    jq.querySelector(".atm").textContent = a.terminal ? "Ask in the terminal" : "I'll do it myself";
    jq.querySelector(".ax").title = a.terminal ? "Hide here (the terminal still asks)" : "Hide here (the agent waits, then hands this step to you)";
    const r = jq.querySelector(".ar");
    r.textContent = a.reason;
    r.hidden = !a.reason;
    const more = aps.size - 1;
    const m = jq.querySelector(".am");
    m.hidden = !more;
    m.textContent = more ? `+${more} more waiting` : "";
  }
  function apOff(id) {
    if (!aps.delete(id)) return false;
    joinDraw();
    return true;
  }
  // v: { id, who, color, target, reason, terminal, verb } (terminal: the agent's app asks too;
  // verb: "wants to open" and the like for an ask that isn't a click).
  function apOn(v) {
    if (!/^https?:$/.test(location.protocol) || !v || typeof v !== "object") return false; // web pages only, like the bar
    const id = String(v.id || "");
    if (!AP_ID.test(id)) return false;
    if (aps.has(id)) return true;
    const wasBar = !!barHost?.isConnected;
    ensureBar();
    if (!wasBar) { drawBar(); placeBadge(); }
    for (const j of joins.values()) clearTimeout(j.timer); // the join requests wait unseen: no time runs out (joinLater)
    while (aps.size >= AP_KEEP) { const old = aps.keys().next().value; apDismissed = `${apDismissed},${old}`.slice(-400); aps.delete(old); }
    const color = /^#[0-9a-fA-F]{6}$/.test(String(v.color || "")) ? String(v.color) : "__PB_AGENT_COLOR__";
    aps.set(id, { who: String(v.who || "Agent").slice(0, 60), color, target: String(v.target || "").slice(0, 120), reason: String(v.reason || "").slice(0, 300), terminal: typeof v.terminal === "boolean" ? v.terminal : true, verb: String(v.verb || "wants to click").slice(0, 40) });
    joinDraw();
    return true;
  }
  // For the helper's tests: the approval the card shows and where its buttons are (geometry only).
  const apState = () => {
    const jq = bar?.querySelector(".jq");
    if (!apShown || !jq || jq.hidden || !barHost?.isConnected) return [];
    const a = aps.get(apShown);
    const at = (sel) => { const b = jq.querySelector(sel).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; };
    return [{ id: apShown, who: a.who, target: a.target, reason: a.reason, terminalLabel: jq.querySelector(".atm").textContent, closeTitle: jq.querySelector(".ax").title, more: aps.size - 1, visible: !!joinVisible && !apHidden, allow: at(".aok"), deny: at(".ano"), terminal: at(".atm"), close: at(".ax") }];
  };

