  function status(token, text, kind) {
    if (token !== TOKEN) return false;
    if (kind === "user") return drainUser();
    if (kind === "user-wait") return waitUser(text);
    if (kind === "pointer") return { me: ptr, agent: agentPtr, view };
    if (kind === "owned") return fields(text, kind);
    if (kind === "claim") return claim(text);
    if (kind === "tick") return { me: ptr, agent: agentPtr, view, dirty: tickFrame() };
    if (kind === "cursors") { if (document.documentElement) setPeers(String(text || "[]")); return true; }
    // Agents' screenshots never show other people's pointers: hidden while one is taken.
    if (kind === "peers-hidden") {
      if (peersBox) peersBox.style.display = text ? "none" : "";
      // Nor the outline of the agent's last field: in its picture it would cover the page.
      if (outlineEl) outlineEl.style.visibility = text ? "hidden" : "";
      // The approval card too: an agent's screenshot never shows it.
      apHidden = !!text;
      const jq = bar?.querySelector(".jq");
      if (jq) { jq.classList.toggle("ph", apHidden); const ab = jq.querySelector(".ab"); if (ab) ab.style.display = apHidden ? "none" : ""; }
      return true;
    }
    if (!document.documentElement) return false;
    // The agent is done here (its status says so, or it went away): its cursor goes now.
    if (kind === "cursor-off") {
      clearTimeout(curTimer);
      agentPtr = null; // joiners stop showing it too
      cur?.classList.remove("on");
      hideOutline();
      return true;
    }
    if (kind === "cursor") {
      try {
        const c = JSON.parse(text);
        const ms = pointer(Number(c.x) || 0, Number(c.y) || 0, String(c.act || ""), String(c.who || "Claude"), String(c.color || ""), Number(c.w) || 24);
        agentPtr = { x: Math.round((Number(c.x) || 0) + scrollX), y: Math.round((Number(c.y) || 0) + scrollY), t: now() };
        const bw = Math.max(0, Number(c.bw) || 0), bh = Math.max(0, Number(c.bh) || 0);
        agentBox = { x: agentPtr.x - bw / 2, y: agentPtr.y - bh / 2, w: bw, h: bh, t: now() };
        if (bw > 0 && bh > 0) showOutline(agentBox); else hideOutline();
        agentAt = now(); // the scrolling an agent's action causes isn't the person's
        return { ms, at: { ...agentPtr, w: bw, h: bh } }; // until it arrives; where it points (and its target's size), in document coordinates
      } catch {}
      return true;
    }
    // What PairBrowse presses next (an agent's click, a fast-mode step, its popup closer): the
    // boxes (viewport pixels, as the helper measured them), kept in document pixels for a while.
    if (kind === "press") {
      try {
        const list = JSON.parse(text);
        const until = now() + PRESS_KEEP_MS;
        if (Array.isArray(list)) for (const b of list.slice(0, 40)) agentPresses.push({ x: (Number(b.x) || 0) + scrollX, y: (Number(b.y) || 0) + scrollY, w: Math.max(0, Number(b.w) || 0), h: Math.max(0, Number(b.h) || 0), until });
        const box = Array.isArray(list) && agentPresses.findLast((p) => p.until === until && p.w > 0 && p.h > 0);
        if (box) showOutline(box);
        if (agentPresses.length > 80) agentPresses.splice(0, agentPresses.length - 80);
        agentAt = now(); // the scrolling its press causes isn't the person's
      } catch {}
      return true;
    }
    if (kind === "targets") {
      try {
        const list = JSON.parse(text);
        agentTargets = Array.isArray(list) ? { list: list.slice(0, 40).map((b) => ({ x: (Number(b.x) || 0) + scrollX, y: (Number(b.y) || 0) + scrollY, w: Number(b.w) || 0, h: Number(b.h) || 0 })), t: now() } : null;
        const first = agentTargets?.list.find((b) => b.w > 0 && b.h > 0);
        if (first) showOutline(first);
      } catch { agentTargets = null; }
      return true;
    }
    if (kind === "bar") {
      setBar(text);
      return true;
    }
    if (kind === "docked") {
      let on = false;
      try { on = JSON.parse(String(text || "null"))?.on === true; } catch {}
      if (on === docked) return true; // no change: a badge the person hid stays hidden
      docked = on;
      if (bar) drawBar();
      if (lastBadge) badge(lastBadge.text, lastBadge.kind);
      else placeBadge();
      return true;
    }
    if (kind === "join") return joinOn(text);
    if (kind === "join-off") return joinOff(String(text || ""));
    if (kind === "join-state") return joinState();
    if (kind === "approval") return apOn(text);
    if (kind === "approval-off") return apOff(String(text || ""));
    if (kind === "approval-state") return apState();
    if (kind === "approval-answers") { const a = apAnswered, d = apDismissed; apAnswered = null; apCount = 0; apDismissed = ""; return { a, ids: [...aps.keys()].join(","), dismissed: d }; }
    if (kind === "join-answers") { const a = answered, g = gone, d = dismissed; answered = null; answeredCount = 0; gone = ""; dismissed = ""; return { a, open: joins.size, ids: [...joins.keys()].join(","), gone: g, dismissed: d }; }
    if (kind === "tab-name") {
      setTabName(text);
      return true;
    }
    if (kind === "spark") {
      spark(String(text || ""));
      return true;
    }
    return badge(text, kind);
  }

  // The badge's text, plain or as data with the agent's spark color ({ text, color }), never
  // through JSON.parse. Docked, only "your turn" shows: the person must act in the page, and the
  // agent panel may be a rail or hidden; the agent's status is the panel's Status box.
  function badge(text, kind) {
    const label = text && typeof text === "object" ? String(text.text || "") : text;
    const edge = text && typeof text === "object" && /^#[0-9a-f]{6}$/i.test(text.color || "") ? text.color : "";
    lastBadge = label ? { text, kind } : null;
    if (!label || (docked && kind !== "you")) {
      host?.remove();
      return true;
    }
    ensure();
    const look = kind === "you" || kind === "done" ? kind : "claude";
    box.className = "b " + look;
    const c = look === "you" ? "#3285F6" : look === "done" ? "#20C997" : edge || "__PB_AGENT_COLOR__";
    box.style.borderLeftColor = c;
    box.querySelector("svg").style.color = c;
    // kind "agent": the text names the agent itself ("Codex: ...").
    // A text that already starts with its own kind's word ("Your turn: sign in") isn't prefixed twice.
    const own = kind === "you" ? /^your turn\b\s*[:\-–]?\s*/i : kind === "done" ? /^done\s*[:\-–]\s*/i : kind === "agent" ? null : /^claude\s*[:\-–]\s*/i;
    const said = own ? String(label).replace(own, "") : String(label);
    box.querySelector("span").textContent = (kind === "you" ? "Your turn: " : kind === "done" ? "Done: " : kind === "agent" ? "" : "Claude: ") + (said || String(label)).slice(0, 140);
    return true;
  }

  Object.defineProperty(window, NAME, { value: status, enumerable: false, writable: false, configurable: false });
})();
