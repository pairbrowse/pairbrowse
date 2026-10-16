  // Claude's cursor: moves to where Claude clicks or types the way a hand moves a mouse (a quick
  // reach that lands a touch short or past, then homes in: scripts/motion.mjs), rings on a click
  // when it presses, stays while the agent works (CURSOR_HOLD_MS after its last move: an agent
  // taking turns with others waits seconds between actions) and goes when it's done. The helper waits for it to arrive before acting, and the
  // press itself puts it exactly where the press was (the real point, which a humanized click
  // picks itself), so it never points beside the click or still at the previous target.
  const motion = "__PB_MOTION__";
  const CURSOR_MOTION = { fittsA: 30, fittsB: 35, minMs: 60, maxMs: 200 }; // much quicker than a hand: it shows where, it never holds the action up long
  const CURSOR_HOLD_MS = 12000;
  const PRESS_WINDOW_MS = 4000; // the first press this soon after the cursor was sent is the agent's
  let curHost, cur, curTimer, curAt = null, curFrame = 0, pressBy = 0, pressAct = "";
  let agentPtr = null; // where it last pointed, in document coordinates
  const reducedMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
  const placeCursor = (p) => { curAt = { x: p.x, y: p.y }; cur.style.transform = `translate(${+p.x.toFixed(3)}px, ${+p.y.toFixed(3)}px)`; };
  const ring = () => { cur.classList.remove("click"); void cur.offsetWidth; cur.classList.add("click"); };
  addEventListener("pointerdown", (e) => {
    if (!e.isTrusted || !cur || now() > pressBy) return;
    pressBy = 0;
    cancelAnimationFrame(curFrame);
    placeCursor({ x: e.clientX, y: e.clientY });
    if (pressAct === "click") ring();
  }, opts);
  // who, color: the agent's name on a tag in its color (people see whose cursor it is).
  // w: the target's smaller side (a small target takes a little longer to reach).
  // A name on a tag: at most 40 characters, cut between words.
  // The pointer's shape (its tip at 0,0 in a "1 1 22 22" view box: exactly at the point) and the
  // name pill (24 px tall, 12 px text: DESIGN.md B5), shared by the agent's cursor and other people's pointers: dark ink on the
  // participant's color, AA on every palette color (test/tokens.test.mjs), no border, outline or glow.
  const POINTER = "M1 1v16.6l4.3-3.8 2.7 6.1 2.8-1.3-2.7-6 5.6-.6z";
  const PILL = "padding:4px 10px;border-radius:999px;font:600 12px/16px system-ui,-apple-system,\"Segoe UI\",sans-serif;color:#0B1421;white-space:nowrap;-webkit-font-smoothing:antialiased";
  const shortWho = (who) => { const t = String(who || "Claude"); return t.length > 40 ? `${t.slice(0, 40).replace(/\s+\S*$/, "")}…` : t; };
  function pointer(x, y, act, who = "Claude", color = "", w = 24) {
    if (!curHost || !curHost.isConnected) {
      curHost = document.createElement(TAG_CURSOR);
      const shadow = curHost.attachShadow({ mode: "closed" });
      shadow.innerHTML = html(`<style>
        :host{all:initial !important;position:fixed !important;z-index:2147483647 !important;left:0 !important;top:0 !important;pointer-events:none !important}
        .c{position:fixed;left:0;top:0;transition:opacity .3s;opacity:0;will-change:transform}
        .c.on{opacity:1}
        svg{position:absolute;left:0;top:0;width:22px;height:22px;overflow:visible;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35))}
        .r{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(11,20,33,.5);opacity:0}
        .c.click .r{animation:p .45s ease-out}
        @keyframes p{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(1.4)}}
        span{position:absolute;left:16px;top:18px;${PILL};background:__PB_AGENT_COLOR__}
        .f{position:fixed;left:0;top:0;box-sizing:border-box;border:2px solid __PB_AGENT_COLOR__;border-radius:4px;opacity:0;transition:opacity .15s;pointer-events:none}
        .f.on{opacity:1}
        @media (prefers-reduced-motion:reduce){.c,.f{transition:none}.c.click .r{animation:none;opacity:.9;transform:scale(.4);background:#fff}}
      </style><div class="c" aria-hidden="true"><div class="r"></div><svg viewBox="1 1 22 22"><path d="${POINTER}" fill="#fff" stroke="__PB_AGENT_COLOR__" stroke-width="1.4" stroke-linejoin="round"/></svg><span></span></div><div class="f" aria-hidden="true"></div>`);
      cur = shadow.querySelector(".c");
      outlineEl = shadow.querySelector(".f");
      outline = null;
      document.documentElement.appendChild(curHost);
      curAt = null;
    }
    const tag = cur.querySelector("span");
    tag.textContent = shortWho(who);
    const col = /^#[0-9a-f]{6}$/i.test(color) ? color : "__PB_AGENT_COLOR__";
    tag.style.background = col;
    cur.querySelector("path").setAttribute("stroke", col); // a white pointer edged in the agent's color; the pill names it
    outlineEl.style.borderColor = col;
    cancelAnimationFrame(curFrame);
    cur.classList.remove("click");
    pressBy = now() + PRESS_WINDOW_MS;
    pressAct = act;
    const to = { x, y };
    let duration = 0;
    // Hidden or just made, or the person asked for less motion: it appears in place.
    if (!curAt || !cur.classList.contains("on") || reducedMotion()) {
      placeCursor(to);
    } else {
      const path = motion.plan(curAt, to, { ...CURSOR_MOTION, targetW: w });
      const start = now();
      duration = path.duration;
      const step = () => {
        const t = now() - start;
        placeCursor(path.at(t));
        if (t < path.duration) curFrame = requestAnimationFrame(step);
      };
      step();
    }
    cur.classList.add("on");
    clearTimeout(curTimer);
    curTimer = setTimeout(() => { cur.classList.remove("on"); hideOutline(); }, CURSOR_HOLD_MS);
    return Math.ceil(duration); // how long it takes to arrive, ms
  }

  // The outline around the field the agent acts on (the cursor's target box, then what it declares
  // it presses), in its color, inside the cursor's shadow root: the page's DOM never changes. It
  // goes with the cursor (its hold timer, cursor-off); the scroll listener above keeps it in place.
  function placeOutline() {
    if (!outline || !outlineEl) return;
    outlineEl.style.transform = `translate(${+(outline.x - scrollX).toFixed(1)}px, ${+(outline.y - scrollY).toFixed(1)}px)`;
    outlineEl.style.width = `${outline.w}px`;
    outlineEl.style.height = `${outline.h}px`;
  }
  // b: { x, y, w, h } in document pixels. Only while the agent's cursor is up.
  function showOutline(b) {
    if (!outlineEl || !cur?.classList.contains("on") || !(b?.w > 0 && b?.h > 0)) return;
    outline = { x: b.x, y: b.y, w: b.w, h: b.h };
    placeOutline();
    outlineEl.classList.add("on");
  }
  function hideOutline() {
    outline = null;
    outlineEl?.classList.remove("on");
  }

