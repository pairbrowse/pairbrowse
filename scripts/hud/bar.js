  // The bottom bar: who's driving and Claude's last actions, like the PairBrowse live view's.
  // It takes no clicks but its "Pause agents" button's, and fades out while the pointer is near
  // the bottom of the page (not near the button).
  let bar, barItems = [], barTimer = 0, barWatched = false;
  let barPause = null; // { by } while agents are paused
  let barCanPause = false; // this person may pause and resume (not a watch joiner)
  let barWaiting = false; // Claude waits while you use the browser
  let barPerson = ""; // who is using this tab (empty: you)
  let barReconnecting = ""; // the host this shared tab is being reconnected to (empty: the channel is up)
  let barRecording = false; // this browser's recorder runs (the helper sends it to its own pages only)
  // Docked (the helper says so, kind "docked", only in the PairBrowse browser with its own pages):
  // the window's agent panel carries the bar's duties (who drives, the steps, Pause) and the
  // agent's status, so the bar draws only a join request's or an approval's card and the badge
  // only "your turn" (DESIGN.md Part G). What no dock carries stays as a note at the page's bottom
  // left: the agent waiting while a person uses the browser, a shared tab reconnecting, who paused,
  // and REC. Outside it nothing changes. No listener, timer or observer of its own.
  let docked = false;
  let lastBadge = null; // the badge's last { text, kind }, drawn again when docked changes
  const panelName = () => (docked ? "agent panel" : "side panel");
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rich = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]*)`/g, "<code>$1</code>");
  // "Alice" -> "Alice's Claude". Unnamed ("Claude 3fed") and app-labelled ("Alice · Codex") stay as they are.
  const whose = (who) => !who ? "Claude" : /^(Claude|Codex|Gemini|Cursor|Copilot)\b| · /.test(who) ? who : `${who}'s Claude`;
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function ensureBar() {
    if (barHost && barHost.isConnected) return;
    barHost = document.createElement(TAG_BAR);
    const shadow = barHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = html(`<style>
      :host{all:initial !important;position:fixed !important;z-index:2147483646 !important;left:0 !important;right:0 !important;bottom:0 !important;pointer-events:none !important}
      .bar{display:flex;align-items:center;gap:14px;height:30px;padding:0 14px;box-sizing:border-box;
        background:rgba(11,20,33,.96);
        border-top:1px solid #293B50;color:#A2B2C6;
        font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;
        transition:opacity .16s cubic-bezier(.22,1,.36,1),transform .16s cubic-bezier(.22,1,.36,1)}
      .bar.away{opacity:0;transform:translateY(8px)}
      .who{display:flex;align-items:center;gap:7px;white-space:nowrap;flex:none}
      .who b{color:#F1F5FA;font-weight:600}
      .dot{flex:none;width:8px;height:8px;border-radius:50%;background:__PB_AGENT_COLOR__}
      .rec{display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 7px;border-radius:6px;background:#192A3D;color:#F1F5FA;font:600 11px/1 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.06em}
      .rec[hidden]{display:none}
      .rec i{width:7px;height:7px;border-radius:50%;background:#EF6468}
      ol{display:flex;justify-content:flex-end;align-items:center;gap:6px;margin:0;padding:0;list-style:none;min-width:0;flex:1;overflow:hidden}
      li{display:flex;gap:6px;align-items:center;white-space:nowrap;flex:none}
      li.empty{margin-right:auto;color:#8699B1;font-size:12px}
      .chip{height:20px;padding:0 8px;border-radius:6px;background:#192A3D;font-size:12px;color:#A2B2C6}
      li.chip{flex:0 1 auto;min-width:44px;overflow:hidden}
      li.chip:last-child{flex-shrink:0}
      .chip span{min-width:0;max-width:min(360px,40vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .chip.now span{color:#F1F5FA}
      .g{display:flex;flex:none;width:12px;height:12px}
      .g svg{width:12px;height:12px}
      .done .g{color:#20C997}
      .now .g{color:#F1F5FA}
      .bad .g{color:#EF6468}
      time{font:500 11px system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums;color:#8699B1}
      li b{font-weight:600;color:#F1F5FA}
      code{font:500 11px system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums;padding:0 4px;border-radius:4px;background:#243750}
      .pz{flex:none;pointer-events:auto;cursor:pointer;border:0;border-radius:6px;padding:4px 10px;font:600 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;
        color:#0B1421;background:#F1F5FA}
      .pz:hover{background:#FFFFFF}
      .pz[hidden]{display:none}
      .bar.paused{background:rgba(11,20,33,.96);border-top-color:#F4B45D}
      .bar.paused .pz{background:#F4B45D;color:#0B1421}
      .bar.asking{background:#0B1421}
      .bar.docked{height:0;padding:0;border:0;background:none}
      .bar.docked>.who,.bar.docked>ol,.bar.docked>.pz{display:none}
      .bar.docked .jq{bottom:12px}
      .bar.docked.note{height:30px;padding:0 14px;width:max-content;max-width:100%;border-top:1px solid #293B50;border-right:1px solid #293B50;border-radius:0 8px 0 0;background:rgba(11,20,33,.96)}
      .bar.docked.note>.who{display:flex}
      .bar.docked.note .jq{bottom:40px}
      .bar.reconly .who>.dot,.bar.reconly .who>span:not(.rec){display:none}
      .jq{position:absolute;right:12px;bottom:40px;display:flex;flex-direction:column;gap:9px;box-sizing:border-box;max-width:min(420px,70vw);
        padding:12px 34px 12px 14px;border-radius:10px;background:rgba(25,42,61,.97);box-shadow:0 0 0 1px #293B50,0 8px 24px rgba(0,0,0,.35);
        pointer-events:auto;cursor:default;font:600 12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#F1F5FA}
      .jq[hidden]{display:none}
      .jq .hd{display:flex;align-items:center;gap:8px;min-width:0}
      .jq .av{flex:none;width:8px;height:8px;border-radius:50%;background:__PB_AGENT_COLOR__}
      .jq .t{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .jq .t b{color:#F1F5FA}
      .jq .r{color:#A2B2C6}
      .jq .h,.jq .m{font-weight:500;color:#A2B2C6;white-space:nowrap}
      .jq .m{padding-left:16px}
      .jq .m[hidden]{display:none}
      .jq .act{display:flex;gap:8px;padding-left:16px}
      .jq button{flex:none;border:0;border-radius:6px;padding:6px 14px;font:600 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}
      .jq .ok{background:#3285F6;color:#0B1421}
      .jq .ok:hover{filter:brightness(1.08)}
      .jq .no{background:#243750;color:#F1F5FA}
      .jq .no:hover{background:#293B50}
      .jq button:disabled{cursor:default;filter:saturate(.4)}
      .jq .x{position:absolute;right:8px;top:6px;color:#8699B1;font:500 15px/1 system-ui;cursor:pointer;padding:4px}
      .jq .x:hover{color:#F1F5FA}
      .jb{display:contents}
      .jb[hidden],.ab[hidden]{display:none}
      .jq.ap{width:360px;max-width:min(360px,92vw);padding:16px;border:1px solid #293B50;border-radius:12px;background:#192A3D;box-shadow:0 12px 32px rgb(0 0 0/.4)}
      .jq.ap.ph{display:none}
      .ab{display:flex;flex-direction:column;gap:10px;min-width:0;font:500 13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#A2B2C6}
      .ab .ah{display:flex;align-items:center;gap:10px;min-width:0;padding-right:22px}
      .ab .ai{flex:none;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:__PB_AGENT_COLOR__;color:#0B1421;font:700 13px/1 system-ui,-apple-system,"Segoe UI",sans-serif}
      .ab .aw{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ab .aw b{color:#F1F5FA;font-weight:600}
      .ab .ac{margin-bottom:-6px;font-size:12px;color:#A2B2C6}
      .ab .ag{padding:8px 10px;border:1px solid #293B50;border-radius:8px;color:#F1F5FA;font:600 13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
      .ab .ar{color:#A2B2C6;overflow-wrap:anywhere}
      .ab .ar[hidden],.ab .am[hidden],.ab .an[hidden]{display:none}
      .ab .aact{display:flex;align-items:center;gap:8px}
      .jq .ab button{font-weight:500;font-size:13px}
      .jq .ab button{transition:background-color 120ms ease-out,color 120ms ease-out,filter 120ms ease-out}
      .jq .ab .aok{background:#3285F6;color:#0B1421}
      .jq .ab .aok:enabled:hover{filter:brightness(1.08)}
      .jq .ab button:disabled{filter:saturate(.4)}
      .jq .ab .ano{background:#192A3D;color:#F1F5FA;box-shadow:inset 0 0 0 1px #293B50}
      .jq .ab .ano:enabled:hover{background:#243750}
      .jq .ab .atm{margin-left:auto;padding:6px 4px;background:none;color:#A2B2C6;font-weight:500}
      .jq .ab .atm:enabled:hover{color:#F1F5FA}
      .ab .am,.ab .an{font-size:12px;color:#A2B2C6}
      .ab .ax{position:absolute;right:8px;top:18px;box-sizing:border-box;width:24px;height:24px;display:flex;align-items:center;justify-content:center;color:#8699B1;font:500 15px/1 system-ui;cursor:pointer}
      .ab .ax:hover{color:#F1F5FA}
      @media (prefers-reduced-motion:reduce){.bar,.bar *{animation:none!important;transition:none!important}}
    </style><div class="bar" aria-hidden="true"><span class="who"><i class="dot"></i><span></span><span class="rec" hidden><i></i>REC</span></span><ol></ol><button class="pz" tabindex="-1" hidden></button><div class="jq" hidden><div class="jb"><div class="hd"><i class="av"></i><span class="t"><b></b> wants to join · <span class="r"></span><span class="h"></span></span></div><span class="m" hidden></span><div class="act"><button class="ok" tabindex="-1">Allow</button><button class="no" tabindex="-1">Deny</button></div><b class="x" title="Dismiss (it stays in the side panel)">×</b></div><div class="ab" hidden><div class="ah"><i class="ai"></i><span class="aw"><b></b> wants to click</span></div><span class="ac">Described by the agent as</span><div class="ag"></div><div class="ar"></div><div class="aact"><button class="aok" tabindex="-1">Allow</button><button class="ano" tabindex="-1">Deny</button><button class="atm" tabindex="-1">Ask in the terminal</button></div><span class="am" hidden></span><span class="an" hidden></span><b class="ax" title="Hide here (the terminal still asks)">×</b></div></div></div>`);
    bar = shadow.querySelector(".bar");
    joinWire(shadow); // a new bar: a join request it shows is drawn anew
    apWire(shadow); // and an approval
    joinShown = "";
    apShown = "";
    joinDraw();
    // Pressed by a person only (trusted); it never takes focus from the page's fields.
    const pz = shadow.querySelector(".pz");
    pz.addEventListener("mousedown", (e) => e.preventDefault());
    pz.addEventListener("click", (e) => { if (e.isTrusted && barCanPause) record(barPause ? "resume" : "pause", ""); });
    document.documentElement.appendChild(barHost);
    // Once per page: a page that removes the bar gets a new one, not another listener.
    if (!barWatched) {
      barWatched = true;
      const nearButton = (e) => {
        const b = bar?.querySelector(".pz");
        if (!b || b.hidden) return false;
        const r = b.getBoundingClientRect();
        return e.clientX >= r.left - 40 && e.clientX <= r.right + 40;
      };
      // Never while it asks someone in: its buttons stay put and fully visible.
      document.addEventListener("mousemove", (e) => bar?.classList.toggle("away", !joins.size && !aps.size && e.clientY > innerHeight - 56 && !nearButton(e)), { passive: true });
    }
  }
  const GLYPH = {
    done: '<svg viewBox="0 0 12 12"><path d="M2.6 6.3l2.2 2.2 4.6-4.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    now: '<svg viewBox="0 0 12 12"><circle cx="2.4" cy="6" r="1.25" fill="currentColor"/><circle cx="6" cy="6" r="1.25" fill="currentColor"/><circle cx="9.6" cy="6" r="1.25" fill="currentColor"/></svg>',
    bad: '<svg viewBox="0 0 12 12"><path d="M6 2v4.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="6" cy="9.6" r="1.15" fill="currentColor"/></svg>',
  };
  // The driver dot: the tab's spark color (orange until one is set), muted while reconnecting.
  function paintDot() {
    const d = bar?.querySelector(".dot");
    if (d) d.style.background = barReconnecting && !barPause ? "#8699B1" : sparkAgent || "__PB_AGENT_COLOR__";
  }
  function drawBar() {
    bar.classList.toggle("docked", docked);
    const x = bar.querySelector(".jb .x");
    if (x) x.title = `Dismiss (it stays in the ${panelName()})`;
    const driving = barItems.length && Date.now() - barItems.at(-1).t < 8000;
    bar.classList.toggle("driving", !!driving);
    const who = barItems.length ? whose(barItems.at(-1).who) : "Claude";
    bar.classList.toggle("paused", !!barPause);
    paintDot();
    bar.querySelector(".rec").hidden = !barRecording;
    // Docked: the who line only for what no dock shows (a wait, a reconnect, a pause, REC; REC
    // alone shows only its chip, never a driving line that would go stale without the re-check).
    const note = docked && !!(barWaiting || barReconnecting || barRecording || barPause);
    bar.classList.toggle("note", note);
    bar.classList.toggle("reconly", note && !barWaiting && !barReconnecting && !barPause);
    if (barPause) bar.querySelector(".who span").innerHTML = html(`Paused by <b>${esc(barPause.by)}</b>${barCanPause && !docked ? " \u00b7" : ""}`);
    else if (barReconnecting) bar.querySelector(".who span").innerHTML = html(`Reconnecting to <b>${esc(barReconnecting)}</b>…`);
    else bar.querySelector(".who span").innerHTML = html(barWaiting ? `<b>${esc(who)}</b> is waiting… ${barPerson ? `${esc(barPerson)} is using this tab` : "you're using the browser"}` : `<b>${esc(who)}</b> ${driving ? "is driving" : "is idle"}`);
    // Docked: no steps and no Pause (the docks' own), so nothing more is drawn or re-checked.
    if (docked) { clearTimeout(barTimer); barTimer = 0; return; }
    const pz = bar.querySelector(".pz");
    pz.hidden = !barCanPause;
    pz.textContent = barPause ? "Resume" : "Pause agents";
    // Oldest to newest, the newest at the right next to Pause agents. Each chip's state comes from
    // the bar's own lines: a failure says so, the newest is under way while the agent drives (or
    // its line says "Now:"), the rest are done. The glyph's shape says it too, not its color alone.
    const recent = barItems.slice(-3);
    const several = new Set(recent.map((a) => a.who || "")).size > 1; // name each line when people mix
    // Under way only while the agent really drives: not paused, not waiting for a person, not reconnecting.
    const underWay = driving && !barPause && !barWaiting && !barReconnecting;
    const stateOf = (a, i) => /^That didn't work/.test(a.text) ? "bad" : (underWay && i === recent.length - 1) || /^Now:/.test(a.text) ? "now" : "done";
    bar.querySelector("ol").innerHTML = html(recent.length
      ? recent.map((a, i) => { const st = stateOf(a, i); return `<li class="chip ${st}" title="${clock(a.t)}"><i class="g">${GLYPH[st]}</i><span>${several && a.who ? `<b>${esc(a.who)}</b> ` : ""}${rich(a.text)}</span></li>`; }).join("")
      : "<li class=\"empty\"><span>Claude's actions show up here</span></li>");
    clearTimeout(barTimer);
    if (driving) barTimer = setTimeout(drawBar, 8100 - (Date.now() - barItems.at(-1).t));
  }
  function setBar(json) {
    if (!/^https?:$/.test(location.protocol)) return; // web pages only, not the new tab page
    try {
      const v = JSON.parse(json);
      barWaiting = !Array.isArray(v) && !!v.waiting;
      barPerson = !Array.isArray(v) && typeof v.person === "string" && v.person !== "The host" ? v.person.slice(0, 60) : "";
      barItems = (Array.isArray(v) ? v : v.items || []).filter((a) => a && a.t && a.text);
      barPause = !Array.isArray(v) && v.pause && typeof v.pause.by === "string" ? { by: v.pause.by.slice(0, 60) } : null;
      barCanPause = !Array.isArray(v) && !!v.canPause;
      barReconnecting = !Array.isArray(v) && typeof v.reconnecting === "string" ? v.reconnecting.slice(0, 60) : "";
      barRecording = !Array.isArray(v) && v.recording === true;
    } catch { return; }
    ensureBar(); // always there, "idle" until the first action
    drawBar();
    placeBadge();
  }
  // The badge sits above the bar when there is one, and above a join card.
  function placeBadge() {
    if (!hostPlace) return;
    // Above the join card while one shows, so it never covers it (one layout read per change); its
    // drop shadow goes meanwhile, since the browser counts a shadow over the card as covering it
    // (and a click on Allow then wouldn't count).
    const card = joins.size || aps.size ? bar?.querySelector(".jq") : null;
    const lift = card && !card.hidden ? card.offsetHeight + 8 : 0;
    // Above the 30 px bar (12 px clear), or, docked, at the page's corner where the bar's card sits
    // (above the docked note while one shows).
    const note = docked && !!bar?.classList.contains("note");
    // Docked, the browser's own approval card sits over the page card's bottom right corner (its
    // own window, which this page can't see): "your turn" goes to the bottom's middle, so the two
    // never cover each other.
    const middle = docked ? "left:50% !important;right:auto !important;transform:translateX(-50%) !important;" : "";
    hostPlace.textContent = barHost?.isConnected ? `:host{bottom:${(docked && !note ? 12 : 42) + lift}px !important;${middle}}${lift ? ".b{box-shadow:0 0 0 1px #293B50 !important}" : ""}` : "";
  }

