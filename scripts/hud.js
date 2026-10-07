// Injected into every page by the PairBrowse daemon. Shows a small status badge so you can
// see, in the browser itself, what Claude is doing and when it's your turn.
// The NAME, TOKEN and TAG placeholders below are replaced with random values each time the daemon
// starts, so a web page can't drive the badge or spot PairBrowse by a fixed name. The page
// elements carry no attributes (their styles live inside closed shadow roots); aria-hidden inside
// keeps them out of Claude's snapshot.
(() => {
  const NAME = "__PB_NAME__";
  // Element names, random per helper start (see hudScript in browser.mjs).
  const TAG_HUD = "__PB_TAG_HUD__", TAG_BAR = "__PB_TAG_BAR__", TAG_CURSOR = "__PB_TAG_CURSOR__";
  const TOKEN = "__PB_TOKEN__";

  // What you do in the page yourself, in every frame (card fields and 2FA codes often sit in one):
  // which button or field, never what you type. The helper reads it twice a second, drops what
  // happened during Claude's own actions, and checks every entry. Built from functions saved
  // here, before the page's own scripts run, so a page can't bend them.
  const now = Date.now.bind(Date);
  let userEvents = [];
  let lastMove = 0, lastWheel = 0;
  const CONTROL = 'button, a, input, select, textarea, label, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="menuitem"], [role="option"]';
  function named(el) {
    if (!el) return "";
    if (el.type === "password") return "a password field";
    const label = el.getAttribute?.("aria-label") || (el.labels && el.labels[0]?.innerText) || el.getAttribute?.("placeholder") || el.getAttribute?.("title") ||
      (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ? el.getAttribute("name") : el.innerText) || "";
    return String(label).trim().replace(/\s+/g, " ").slice(0, 60);
  }
  function record(kind, what, far = false) {
    if (userEvents.length >= 60) return;
    userEvents[userEvents.length] = far ? { t: now(), kind, what, far: true } : { t: now(), kind, what };
  }
  // A press well away from what the agent is acting on (its cursor's target, last placed by the
  // helper): a person's, even while an agent's action runs. The agent's own presses land on its
  // target, so everything near it stays the agent's.
  const FAR_PX = 48;
  const awayFromAgent = (e) => {
    const b = agentBox;
    if (!b || now() - b.t > 15_000) return false;
    const x = e.clientX + scrollX, y = e.clientY + scrollY;
    return x < b.x - FAR_PX || x > b.x + b.w + FAR_PX || y < b.y - FAR_PX || y > b.y + b.h + FAR_PX;
  };
  // Typing in a field other than the one the agent is filling (its target): a person's.
  const awayFromAgentEl = (el) => {
    const b = agentBox;
    if (!b || now() - b.t > 15_000 || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2 + scrollX, cy = r.top + r.height / 2 + scrollY;
    return cx < b.x - FAR_PX || cx > b.x + b.w + FAR_PX || cy < b.y - FAR_PX || cy > b.y + b.h + FAR_PX;
  };
  function drainUser() {
    const out = userEvents;
    userEvents = [];
    return out;
  }
  const opts = { capture: true, passive: true };
  // Pages that require Trusted Types (YouTube, Google's apps) refuse plain strings as HTML, which
  // left them without the bar, cursor and pointers. PairBrowse's own fixed templates (values in
  // them escaped) go through a policy of its own, kept in here; where a page allows no new policy,
  // plain strings as before.
  let ttPolicy = null;
  try { ttPolicy = globalThis.trustedTypes?.createPolicy?.(`pairbrowse-${Math.random().toString(36).slice(2)}`, { createHTML: (x) => x }) || null; } catch {}
  const html = (x) => (ttPolicy ? ttPolicy.createHTML(x) : x);
  // The element really under the pointer or holding focus, also inside shadow DOM.
  const control = (e) => { for (const el of e.composedPath()) if (el.matches?.(CONTROL)) return el; return null; };
  const focused = () => { let el = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return el; };
  // PairBrowse's own bar (its "Pause agents" button) is never input in the page.
  let barHost;
  const ours = (e) => !!barHost && e.composedPath().includes(barHost);
  // A press on a scrollbar (the page's, or a scrolling box's) is reading, like the wheel: it holds
  // nobody up. Same for scrolling keys outside a field.
  const onScrollbar = (e) => {
    const root = document.documentElement;
    if (e.clientX >= root.clientWidth || e.clientY >= root.clientHeight) return true;
    const el = e.composedPath()[0];
    if (!el || el.nodeType !== 1 || el === root || el === document.body) return false;
    const r = el.getBoundingClientRect();
    return (el.scrollHeight > el.clientHeight && e.clientX - r.left >= el.clientLeft + el.clientWidth) ||
      (el.scrollWidth > el.clientWidth && e.clientY - r.top >= el.clientTop + el.clientHeight);
  };
  const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);
  addEventListener("pointerdown", (e) => { if (e.isTrusted && !ours(e)) { if (onScrollbar(e)) record("scroll", ""); else record("click", named(control(e)), awayFromAgent(e)); } }, opts);
  addEventListener("keydown", (e) => {
    if (!e.isTrusted || ours(e)) return;
    const el = focused();
    if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) record("type", named(el), awayFromAgentEl(el));
    else if (SCROLL_KEYS.has(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) record("scroll", "");
    else if (e.key.length > 1) record("key", e.key); // Enter, Escape, Tab: never the letters
  }, opts);
  // A wheel is a person's, unless an agent's scroll step just put its cursor here (agentAt): it
  // wheels in small steps right after. Plain scroll events aren't counted: pages scroll themselves
  // (menus, smooth scrolling) and Claude's clicks bring buttons into view.
  addEventListener("wheel", (e) => { const n = now(); if (n - agentAt < 1500) return; personAt = n; if (e.isTrusted && n - lastWheel > 800) { lastWheel = n; record("wheel", ""); } }, opts);
  // Where the person is reading (the top of their viewport and its height, in document pixels):
  // a shared tab marks it on the other side's scrollbar. Taken from scrolling that follows their
  // own input (wheel, keys, a press on the scrollbar, touch), never the page's or an agent's.
  let view = null, personAt = 0, agentAt = 0;
  let agentBox = null; // { x, y, w, h, t }: what the agent acts on now, in document pixels
  const looked = () => {
    const n = now();
    if (n - agentAt < 1500) return;
    const y = Math.round(scrollY / 4) * 4, h = Math.round(innerHeight);
    if (!view || view.y !== y || view.h !== h) view = { y, h, t: n };
  };
  for (const kind of ["keydown", "pointerdown", "touchstart"]) addEventListener(kind, (e) => { if (e.isTrusted) personAt = now(); }, opts);
  addEventListener("scroll", () => { if (now() - personAt < 1500) looked(); }, opts);
  // Where the person's pointer is, in document coordinates (a shared tab shows it in the other
  // browser's copy at the same place in the page, whatever its window size). Never what's under it.
  let ptr = null;
  addEventListener("mousemove", (e) => {
    if (!e.isTrusted) return;
    const n = now();
    ptr = { x: Math.round(e.pageX), y: Math.round(e.pageY), t: n };
    // Only a move that moves: Chromium also sends one, with no distance, when a page loads or
    // scrolls under a resting pointer, and that isn't the person looking.
    if ((e.movementX || e.movementY) && (!view || n - view.t > 1000)) looked();
    if (n - lastMove > 500) { lastMove = n; record("move", ""); }
  }, opts);

  // A field changed here (typed by a person or an agent, or set by the page): a shared tab's
  // helper reads the fields again at once instead of waiting for its next round.
  let dirtyAt = 0;
  const changed = () => { dirtyAt = now(); };
  addEventListener("input", changed, opts);
  addEventListener("change", changed, opts);

  // Which fields people edit: the times of real (trusted) input in each one. Agents' typing is
  // trusted too, so the helper drops times that fall in an agent's action. A field a person edits
  // stays theirs for a while: agents leave it alone. "claim": a person in the other browser of a
  // shared tab edited it (their value was just set here).
  const edits = new WeakMap(); // field -> { times: [], rw, rt }
  const editOf = (el) => { let x = edits.get(el); if (!x) edits.set(el, (x = { times: [], rw: "", rt: 0 })); return x; };
  const edited = (e) => {
    if (!e.isTrusted) return;
    const el = e.composedPath()[0];
    if (!el || el.nodeType !== 1) return;
    // A text field's "change" comes on leaving it, also after a value set from the other browser
    // of a shared tab: typing there fires "input" anyway, so only that counts.
    if (e.type === "change" && (el.tagName === "TEXTAREA" || el.isContentEditable || (el.tagName === "INPUT" && !/^(checkbox|radio|file|range|color)$/.test(el.type)))) return;
    const x = editOf(el);
    // Typing without key presses (pasting, dictation, the live view) is typing all the same.
    if (now() - (x.times.at(-1) || 0) > 1000) record("type", named(el));
    x.times.push(now());
    if (x.times.length > 8) x.times.shift();
  };
  addEventListener("input", edited, opts);
  addEventListener("change", edited, opts);
  function fields(el, kind) {
    if (!el || el.nodeType !== 1) return null;
    if (kind === "claim") return false;
    const x = edits.get(el);
    return { times: x ? x.times.slice() : [], rw: x?.rw || "", rt: x?.rt || 0, focused: focused() === el, name: named(el) };
  }
  function claim(v) {
    if (!Array.isArray(v) || !v[0] || v[0].nodeType !== 1) return false;
    const x = editOf(v[0]);
    x.rw = String(v[1] || "").slice(0, 60);
    x.rt = now();
    // For the agent's next result: which field they filled (its name, never the value).
    if (userEvents.length < 60) userEvents[userEvents.length] = { t: now(), kind: "filled", what: named(v[0]), who: x.rw };
    return true;
  }
  function tickFrame() {
    const d = dirtyAt;
    dirtyAt = 0;
    return d;
  }

  if (window.top !== window) {
    // Frames only report input; the badge, bar and cursor live in the top page.
    Object.defineProperty(window, NAME, { value: (token, text, kind) => token !== TOKEN ? false : kind === "user" ? drainUser() : kind === "tick" ? { dirty: tickFrame() } :
      kind === "owned" ? fields(text, kind) : kind === "claim" ? claim(text) : false, enumerable: false, writable: false, configurable: false });
    return;
  }
  let host, box, hostPlace;

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement(TAG_HUD);
    const shadow = host.attachShadow({ mode: "closed" });
    // The app icon's look: deep navy glass, a light rim, the orange spark.
    shadow.innerHTML = html(`<style>
      :host{all:initial !important;position:fixed !important;z-index:2147483647 !important;right:12px !important;bottom:12px !important}
      .b{display:flex;align-items:center;gap:9px;font:600 12.5px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;color:#f4f6ff;
         padding:9px 14px 9px 11px;border-radius:14px;max-width:min(440px,62vw);cursor:default;
         background:linear-gradient(160deg,rgba(62,84,150,.94),rgba(27,30,64,.96));
         box-shadow:inset 0 0 0 1px rgba(255,255,255,.16),inset 0 1px 0 rgba(255,255,255,.18),0 8px 24px rgba(10,12,40,.35);
         -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
      .b span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      svg{flex:none;width:15px;height:15px;color:#ef7d45}
      .you{animation:g 1.8s ease-in-out infinite}
      .you svg{animation:s 1.8s ease-in-out infinite}
      .done svg{color:#6fd39a}
      .x{flex:none;margin-left:2px;color:#aab2df;font:500 15px/1 system-ui;cursor:pointer;padding:0 2px}
      .x:hover{color:#fff}
      @keyframes g{50%{box-shadow:inset 0 0 0 1px rgba(255,255,255,.16),inset 0 1px 0 rgba(255,255,255,.18),0 8px 24px rgba(10,12,40,.35),0 0 0 4px rgba(239,125,69,.28)}}
      @keyframes s{50%{transform:rotate(45deg) scale(1.12)}}
      @media (prefers-reduced-motion:reduce){.you,.you svg{animation:none}}
    </style><div class="b" aria-hidden="true"><svg viewBox="0 0 16 16"><path fill="currentColor" d="${SPARK}"/></svg><span></span><b class="x" title="Hide">×</b></div>`);
    box = shadow.querySelector(".b");
    hostPlace = document.createElement("style"); // where the badge sits: above the bar when there is one
    shadow.appendChild(hostPlace);
    placeBadge();
    shadow.querySelector(".x").addEventListener("click", () => host.remove()); // hide it on this page
    document.documentElement.appendChild(host);
  }

  // Claude's tab: the orange spark as its tab icon (the site's own icon comes back when Claude moves on).
  const SPARK = "M8 0.8c.5 0 .8.4.9.9l.5 4 3.3-2.3c.4-.3 1-.2 1.3.2.3.4.2 1-.2 1.3L10.6 7.3l4 .6c.5.1.9.5.8 1-.1.5-.5.8-1 .7l-4-.5 2.3 3.3c.3.4.2 1-.2 1.3-.4.3-1 .2-1.3-.2L8.9 10.2l-.5 4c-.1.5-.5.9-1 .8-.5 0-.8-.5-.8-1l.6-4-3.3 2.3c-.4.3-1 .2-1.3-.2-.3-.4-.2-1 .2-1.3l3.2-2.4-4-.5c-.5-.1-.9-.5-.8-1 .1-.5.5-.8 1-.8l4 .6L3.9 3.5c-.3-.4-.2-1 .2-1.3.4-.3 1-.2 1.3.2l2.4 3.3.5-4c0-.5.4-.9.9-.9Z";
  let sparkLink = null;
  let sparkColor = null; // kept here, not on the link: nothing extra for a page to see
  let savedIcons = [];
  function drawSpark(ctx, x, y, size, color = "#e9763f") {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 16, size / 16);
    ctx.fillStyle = color;
    ctx.fill(new Path2D(SPARK));
    ctx.restore();
  }
  // The spark fills the whole tab icon, so Claude's tab stands out in a row of tabs. A person from
  // the other browser of a shared tab: a dot in their color with a light rim (in the spark's
  // corner when an agent is there too).
  function drawDot(ctx, x, y, r, color) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = Math.max(2, r / 5);
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  }
  function sparkIcon(color, person) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d");
    if (color) drawSpark(ctx, 0, 0, 64, color);
    if (person) drawDot(ctx, color ? 48 : 32, color ? 48 : 32, color ? 14 : 24, person);
    return c.toDataURL("image/png");
  }
  // value: that participant's spark color ("#rrggbb"), a person's dot ("o#rrggbb"), both (space
  // apart), or "" to put the site's own icon back.
  function spark(value) {
    const head = document.head || document.documentElement;
    const parts = String(value || "").split(" ");
    const color = parts.find((p) => /^#[0-9a-f]{6}$/i.test(p)) || "";
    const person = parts.find((p) => /^o#[0-9a-f]{6}$/i.test(p))?.slice(1) || "";
    if (!color && !person) {
      if (!sparkLink) return;
      sparkLink.remove();
      sparkLink = null;
      for (const l of savedIcons) head.appendChild(l);
      savedIcons = [];
      return;
    }
    if (sparkLink?.isConnected) {
      if (sparkColor !== value) { sparkLink.href = sparkIcon(color, person); sparkColor = value; }
      return;
    }
    const icons = [...document.querySelectorAll('link[rel~="icon"]')];
    const href = sparkIcon(color, person);
    savedIcons = icons;
    icons.forEach((l) => l.remove());
    sparkLink = document.createElement("link");
    sparkLink.rel = "icon";
    sparkLink.href = href;
    sparkColor = value;
    head.appendChild(sparkLink);
  }

  // The bottom bar: who's driving and Claude's last actions, like the PairBrowse live view's.
  // It takes no clicks but its "Pause agents" button's, and fades out while the pointer is near
  // the bottom of the page (not near the button).
  let bar, barItems = [], barTimer = 0, barWatched = false;
  let barPause = null; // { by } while agents are paused
  let barCanPause = false; // this person may pause and resume (not a watch joiner)
  let barWaiting = false; // Claude waits while you use the browser
  let barPerson = ""; // who is using this tab (empty: you)
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rich = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]*)`/g, "<code>$1</code>");
  // "Alice" -> "Alice's Claude". Unnamed ("Claude 3fed") and app-labelled ("Alice · Codex") stay as they are.
  const whose = (who) => !who ? "Claude" : /^Claude\b| · /.test(who) ? who : `${who}'s Claude`;
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function ensureBar() {
    if (barHost && barHost.isConnected) return;
    barHost = document.createElement(TAG_BAR);
    const shadow = barHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = html(`<style>
      :host{all:initial !important;position:fixed !important;z-index:2147483646 !important;left:0 !important;right:0 !important;bottom:0 !important;pointer-events:none !important}
      .bar{display:flex;align-items:center;gap:14px;height:30px;padding:0 14px;box-sizing:border-box;
        background:rgba(27,30,60,.93);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
        border-top:1px solid rgba(255,255,255,.12);color:#c9cef0;
        font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;
        transition:opacity .18s ease,transform .18s ease}
      .bar.away{opacity:0;transform:translateY(8px)}
      .who{display:flex;align-items:center;gap:7px;white-space:nowrap;flex:none}
      .who b{color:#f5f6ff;font-weight:600}
      .who svg{width:13px;height:13px;color:#e9763f}
      .bar.driving .who svg{animation:r 2.4s linear infinite}
      @keyframes r{to{transform:rotate(360deg)}}
      ol{display:flex;gap:16px;margin:0;padding:0;list-style:none;min-width:0;flex:1;overflow:hidden;
        -webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 40px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 40px),transparent)}
      li{display:flex;gap:6px;align-items:baseline;white-space:nowrap}
      li+li::before{content:"\\00b7";color:#8a90b8;margin-right:10px}
      li:first-child{color:#eef0ff}
      time{font:500 11px system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums;color:#8a90b8}
      li b{font-weight:600;color:#f5f6ff}
      code{font:500 11px system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums;padding:0 4px;border-radius:4px;background:rgba(255,255,255,.12)}
      .pz{flex:none;pointer-events:auto;cursor:pointer;border:0;border-radius:6px;padding:4px 10px;font:600 11.5px/1 system-ui,-apple-system,"Segoe UI",sans-serif;
        color:#1b1e3c;background:#f4f6ff}
      .pz:hover{background:#fff}
      .pz[hidden]{display:none}
      .bar.paused{background:rgba(120,52,24,.95)}
      .bar.paused .pz{background:#ef7d45;color:#fff}
      .bar.asking{-webkit-backdrop-filter:none;backdrop-filter:none;background:rgb(27,30,60)}
      .jq{flex:none;pointer-events:auto;display:flex;align-items:center;gap:7px;max-width:min(520px,62vw);min-width:0;padding-left:12px;border-left:1px solid rgba(255,255,255,.16);cursor:default;font-weight:600;color:#f4f6ff}
      .jq[hidden]{display:none}
      .jq svg{flex:none;width:13px;height:13px;color:#ef7d45}
      .jq .t{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .jq .t b{color:#fff}
      .jq .h,.jq .m{font-weight:500;color:#ffd2bd;white-space:nowrap}
      .jq .m[hidden]{display:none}
      .jq button{flex:none;border:0;border-radius:6px;padding:4px 10px;font:600 11.5px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}
      .jq .ok{background:#ef7d45;color:#fff}
      .jq .ok:hover{background:#f48d5a}
      .jq .no{background:rgba(255,255,255,.14);color:#f4f6ff}
      .jq .no:hover{background:rgba(255,255,255,.24)}
      .jq button:disabled{cursor:default;filter:saturate(.4)}
      .jq .x{flex:none;color:#aab2df;font:500 15px/1 system-ui;cursor:pointer;padding:0 3px}
      .jq .x:hover{color:#fff}
      @media (prefers-reduced-motion:reduce){.bar,.bar *{animation:none!important;transition:none!important}}
    </style><div class="bar" aria-hidden="true"><span class="who"><svg viewBox="0 0 16 16"><path fill="currentColor" d="${SPARK}"/></svg><span></span></span><ol></ol><button class="pz" tabindex="-1" hidden></button><span class="jq" hidden><svg viewBox="0 0 16 16"><path fill="currentColor" d="${SPARK}"/></svg><span class="t"><b></b> wants to join (<span class="r"></span>)<span class="h"></span></span><span class="m" hidden></span><button class="ok" tabindex="-1">Allow</button><button class="no" tabindex="-1">Deny</button><b class="x" title="Dismiss (it stays in the side panel)">×</b></span></div>`);
    bar = shadow.querySelector(".bar");
    joinWire(shadow); // a new bar: a join request it shows is drawn anew
    joinShown = "";
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
      document.addEventListener("mousemove", (e) => bar?.classList.toggle("away", !joins.size && e.clientY > innerHeight - 56 && !nearButton(e)), { passive: true });
    }
  }
  function drawBar() {
    const driving = barItems.length && Date.now() - barItems.at(-1).t < 8000;
    bar.classList.toggle("driving", !!driving);
    const who = barItems.length ? whose(barItems.at(-1).who) : "Claude";
    bar.classList.toggle("paused", !!barPause);
    const pz = bar.querySelector(".pz");
    pz.hidden = !barCanPause;
    pz.textContent = barPause ? "Resume" : "Pause agents";
    if (barPause) bar.querySelector(".who span").innerHTML = html(`Paused by <b>${esc(barPause.by)}</b>${barCanPause ? " \u00b7" : ""}`);
    else bar.querySelector(".who span").innerHTML = html(barWaiting ? `<b>${esc(who)}</b> is waiting… ${barPerson ? `${esc(barPerson)} is using this tab` : "you're using the browser"}` : `<b>${esc(who)}</b> ${driving ? "is driving" : "is idle"}`);
    const recent = barItems.slice(-3).reverse();
    const several = new Set(recent.map((a) => a.who || "")).size > 1; // name each line when people mix
    bar.querySelector("ol").innerHTML = html(recent.length
      ? recent.map((a) => `<li><time>${clock(a.t)}</time><span>${several && a.who ? `<b>${esc(a.who)}</b> ` : ""}${rich(a.text)}</span></li>`).join("")
      : "<li><span>Claude's actions show up here</span></li>");
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
    } catch { return; }
    ensureBar(); // always there, "idle" until the first action
    drawBar();
    placeBadge();
  }
  // The badge sits above the bar when there is one.
  function placeBadge() {
    if (!hostPlace) return;
    hostPlace.textContent = barHost?.isConnected ? `:host{bottom:42px !important}` : "";
  }

  // Someone asks to join the session (shown on the host's tab in front only, when the browser has
  // the focus): the bottom bar keeps who's driving and Claude's last actions on the left, and at
  // its right end shows "Sam wants to join (drive) · Allow · Deny · ×", the newest request, with
  // "+N more" pointing to the side panel. Each goes by itself after JOIN_SHOWN_MS (not while the
  // pointer is on it); the request stays in the side panel.
  // It lives in the bar's closed shadow root, so the page's DOM doesn't change when it shows, and
  // a page can't read, click or fake it. Only a real click counts: trusted, from a pointer (not a
  // key), at least JOIN_ARM_MS after what it shows last changed, and while the browser reports it
  // fully visible (nothing over it, no opacity or filter: IntersectionObserver v2; the bar drops
  // its blur and never fades while it asks), so a page can't slip it under a click meant for
  // something else. The click is only recorded here; the helper reads it with the key, checks it
  // again (not during an agent's action, nor a joiner's or the live view's replayed input) and
  // answers the request the side panel's way (daemon/joinprompt.mjs). Its text comes as an
  // object, never through JSON.parse.
  const JOIN_SHOWN_MS = 10_000, JOIN_ARM_MS = 600, JOIN_KEEP = 5;
  let joinSeen = null, joinVisible = false, joinAt = 0, joinShown = "";
  // Answers given, for the helper (kind "join-answers"): a chain of object literals in this
  // closure, never an array a page could reach through Array.prototype; at most 5 kept. gone:
  // the ids whose time ran out (not dismissed), as one string.
  let answered = null, answeredCount = 0, gone = "", dismissed = "";
  const joins = new Map(); // id -> { timer, who, role }, oldest first
  function joinWire(shadow) {
    const jq = shadow.querySelector(".jq");
    const answer = (kind) => (e) => {
      const id = joinShown;
      if (!e.isTrusted || !(e.detail > 0) || !id || !joins.has(id)) return;
      if (now() - joinAt < JOIN_ARM_MS) return;
      if (!joinVisible) return joinHint("covered: answer in the side panel");
      if (answeredCount < 5) { answered = { t: now(), kind, what: id, next: answered }; answeredCount++; }
      for (const b of jq.querySelectorAll("button")) b.disabled = true;
      joinHint(kind === "join-allow" ? "letting them in…" : "");
      // Not answered after a moment (the helper didn't take the click): back to the buttons.
      setTimeout(() => { if (joinShown === id && joins.has(id)) { for (const b of jq.querySelectorAll("button")) b.disabled = false; joinHint("didn't go through: use the side panel"); } }, 3000);
    };
    for (const b of jq.querySelectorAll("button, .x")) b.addEventListener("mousedown", (e) => e.preventDefault()); // never takes focus from the page
    jq.querySelector(".ok").addEventListener("click", answer("join-allow"));
    jq.querySelector(".no").addEventListener("click", answer("join-deny"));
    jq.querySelector(".x").addEventListener("click", (e) => { if (e.isTrusted && joinShown) { dismissed = `${dismissed},${joinShown}`.slice(-200); joinOff(joinShown); } });
    // Not while the pointer is on it: someone reaching for Allow doesn't see it vanish.
    jq.addEventListener("pointerenter", () => { for (const j of joins.values()) clearTimeout(j.timer); });
    jq.addEventListener("pointerleave", () => { for (const id of joins.keys()) joinLater(id, 3000); });
    joinSeen?.disconnect();
    joinSeen = null;
    joinVisible = false;
    try {
      joinSeen = new IntersectionObserver((entries) => {
        for (const en of entries) joinVisible = "isVisible" in en ? en.isVisible : en.isIntersecting;
      }, { trackVisibility: true, delay: 100 });
      joinSeen.observe(jq);
    } catch { joinVisible = true; }
  }
  function joinHint(text) { const h = bar?.querySelector(".jq .h"); if (h) h.textContent = text ? ` · ${text}` : ""; }
  function joinLater(id, ms) {
    const j = joins.get(id);
    if (!j) return;
    clearTimeout(j.timer);
    j.timer = setTimeout(() => { if (joins.has(id)) { gone = `${gone},${id}`.slice(-200); joinOff(id); } }, ms);
  }
  // The bar shows the newest request, or none.
  function joinDraw() {
    if (!bar) return;
    const jq = bar.querySelector(".jq");
    const ids = [...joins.keys()];
    const id = ids.at(-1) || "";
    bar.classList.toggle("asking", !!id);
    if (id) bar.classList.remove("away");
    jq.hidden = !id;
    if (id !== joinShown) {
      joinShown = id;
      joinAt = now(); // what a click lands on just changed: no click counts for a moment
      for (const b of jq.querySelectorAll("button")) b.disabled = false;
      joinHint("");
    }
    if (!id) return;
    const j = joins.get(id);
    jq.querySelector(".t b").textContent = j.who;
    jq.querySelector(".r").textContent = j.role;
    const more = ids.length - 1;
    const m = jq.querySelector(".m");
    m.hidden = !more;
    m.textContent = more ? `+${more} more in the side panel` : "";
  }
  function joinOff(id) {
    const j = joins.get(id);
    if (!j) return false;
    clearTimeout(j.timer);
    joins.delete(id);
    joinDraw();
    return true;
  }
  // r: { id, who, role }.
  function joinOn(r) {
    if (!/^https?:$/.test(location.protocol) || !r || typeof r !== "object") return false; // web pages only, like the bar
    const id = String(r.id || "");
    if (!/^r[0-9a-f]{6}$/.test(id)) return false;
    if (joins.has(id)) return true;
    const wasBar = !!barHost?.isConnected;
    ensureBar();
    if (!wasBar) { drawBar(); placeBadge(); }
    while (joins.size >= JOIN_KEEP) { const old = joins.keys().next().value; dismissed = `${dismissed},${old}`.slice(-200); joinOff(old); }
    joins.set(id, { timer: 0, who: String(r.who || "Someone").slice(0, 60), role: r.role === "drive" ? "drive" : "watch" });
    joinLater(id, JOIN_SHOWN_MS);
    joinDraw();
    return true;
  }
  // For the helper's tests: the request the bar shows and where its buttons are (geometry only).
  const joinState = () => {
    const jq = bar?.querySelector(".jq");
    if (!joinShown || !jq || jq.hidden || !barHost?.isConnected) return [];
    const at = (sel) => { const b = jq.querySelector(sel).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; };
    return [{ id: joinShown, who: joins.get(joinShown).who, more: joins.size - 1, visible: !!joinVisible, allow: at(".ok"), deny: at(".no"), close: at(".x") }];
  };

  // Claude's cursor: moves to where Claude clicks or types the way a hand moves a mouse (a quick
  // reach that lands a touch short or past, then homes in: scripts/motion.mjs), rings on a click
  // when it presses, fades when idle. The helper waits for it to arrive before acting, and the
  // press itself puts it exactly where the press was (the real point, which a humanized click
  // picks itself), so it never points beside the click or still at the previous target.
  const motion = "__PB_MOTION__";
  const CURSOR_MOTION = { fittsA: 50, fittsB: 60, minMs: 120, maxMs: 350 }; // quicker than a hand
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
  function pointer(x, y, act, who = "Claude", color = "", w = 24) {
    if (!curHost || !curHost.isConnected) {
      curHost = document.createElement(TAG_CURSOR);
      const shadow = curHost.attachShadow({ mode: "closed" });
      shadow.innerHTML = html(`<style>
        :host{all:initial !important;position:fixed !important;z-index:2147483647 !important;left:0 !important;top:0 !important;pointer-events:none !important}
        .c{position:fixed;left:0;top:0;transition:opacity .3s;opacity:0;will-change:transform}
        .c.on{opacity:1}
        svg{width:22px;height:22px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.35))}
        .r{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(27,30,60,.5);opacity:0}
        .c.click .r{animation:p .45s ease-out}
        @keyframes p{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(1.4)}}
        span{position:absolute;left:16px;top:18px;padding:2px 8px;border-radius:999px;font:600 11px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
          color:#fff;background:#e9763f;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.25);-webkit-font-smoothing:antialiased}
      </style><div class="c" aria-hidden="true"><div class="r"></div><svg viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#fff" stroke="#1b1e3c" stroke-width="1.6" stroke-linejoin="round"/></svg><span></span></div>`);
      cur = shadow.querySelector(".c");
      document.documentElement.appendChild(curHost);
      curAt = null;
    }
    const tag = cur.querySelector("span");
    tag.textContent = String(who || "Claude").slice(0, 40);
    tag.style.background = /^#[0-9a-f]{6}$/i.test(color) ? color : "#e9763f";
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
    curTimer = setTimeout(() => cur.classList.remove("on"), 2500);
    return Math.ceil(duration); // how long it takes to arrive, ms
  }

  // Other people's and agents' pointers from the other browser of a shared tab: named, in their
  // color, at their place in the document. Updates come 20-30 times a second; in between each
  // pointer glides toward its latest place every frame, so it moves smoothly. It fades after 3 s
  // without moving.
  let peersHost, peersBox, peersFrame = 0;
  const peers = new Map(); // key -> { el, x, y, tx, ty, t }
  // Where each other person is reading (entries with v): a small mark in their color on the right
  // edge, like a scrollbar thumb for their viewport, named; the name fades, the mark stays.
  const views = new Map(); // key -> { el, y, h, t }
  function placeViews() {
    const total = Math.max(document.documentElement.scrollHeight, innerHeight, 1);
    for (const v of views.values()) {
      const top = (v.y / total) * innerHeight, height = Math.max(14, (v.h / total) * innerHeight);
      v.el.style.transform = `translate3d(0, ${Math.min(top, innerHeight - height).toFixed(1)}px, 0)`;
      v.el.firstChild.style.height = `${height.toFixed(1)}px`;
      v.el.classList.toggle("fresh", now() - v.t < 4000);
    }
  }
  function drawPeers() {
    peersFrame = 0;
    let moving = false;
    for (const p of peers.values()) {
      // Ease toward the target: a third of the way each frame (about 100 ms to arrive).
      p.x += (p.tx - p.x) * 0.35;
      p.y += (p.ty - p.y) * 0.35;
      if (Math.abs(p.tx - p.x) < 0.3 && Math.abs(p.ty - p.y) < 0.3) { p.x = p.tx; p.y = p.ty; } else moving = true;
      p.el.style.transform = `translate3d(${(p.x - scrollX).toFixed(1)}px, ${(p.y - scrollY).toFixed(1)}px, 0)`;
      const on = now() - p.t < 3000;
      if (on !== p.on) { p.on = on; p.el.classList.toggle("on", on); }
    }
    placeViews();
    if (moving) peersFrame = requestAnimationFrame(drawPeers);
  }
  const kickPeers = () => { if (!peersFrame) peersFrame = requestAnimationFrame(drawPeers); };
  function setPeers(json) {
    let list;
    try { list = JSON.parse(json); } catch { return; }
    if (!Array.isArray(list)) return;
    if (!peersHost || !peersHost.isConnected) {
      peersHost = document.createElement(TAG_CURSOR);
      const shadow = peersHost.attachShadow({ mode: "closed" });
      shadow.innerHTML = html(`<style>
        :host{all:initial !important;position:fixed !important;z-index:2147483647 !important;left:0 !important;top:0 !important;width:0 !important;height:0 !important;pointer-events:none !important}
        .p{position:fixed;left:0;top:0;opacity:0;transition:opacity .35s ease;will-change:transform;pointer-events:none}
        .p.on{opacity:1}
        svg{display:block;width:18px;height:18px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
        span{position:absolute;left:14px;top:16px;padding:2px 8px;border-radius:999px;font:600 11px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
          color:#fff;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.25);-webkit-font-smoothing:antialiased}
        .v{position:fixed;right:0;top:0;display:flex;align-items:flex-start;gap:4px;opacity:.8;pointer-events:none}
        .v i{display:block;width:4px;border-radius:2px 0 0 2px;box-shadow:0 0 0 1px rgba(255,255,255,.7)}
        .v b{order:-1;padding:1px 6px;border-radius:999px;font:600 10px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;white-space:nowrap;opacity:0;transition:opacity .35s ease}
        .v.fresh b{opacity:1}
        @media (prefers-reduced-motion:reduce){.p,.v b{transition:none}}
      </style><div aria-hidden="true"></div>`);
      peersBox = shadow.querySelector("div");
      document.documentElement.appendChild(peersHost);
      addEventListener("scroll", kickPeers, { passive: true });
      addEventListener("resize", kickPeers, { passive: true });
      peers.clear();
      views.clear();
    }
    const keep = new Set();
    for (const c of list.slice(0, 16)) {
      if (!c || typeof c.k !== "string") continue;
      const color = /^#[0-9a-f]{6}$/i.test(c.color || "") ? c.color : "#e9763f";
      if (c.v) {
        keep.add(c.k);
        let v = views.get(c.k);
        if (!v) {
          const el = document.createElement("div");
          el.className = "v";
          el.innerHTML = html("<i></i><b></b>");
          peersBox.appendChild(el);
          v = { el, y: -1, h: -1, t: 0, who: null, color: "" };
          views.set(c.k, v);
        }
        if (v.color !== color) { v.color = color; v.el.querySelector("i").style.background = color; v.el.querySelector("b").style.background = color; }
        const who = String(c.who || "").slice(0, 40);
        if (v.who !== who) { v.who = who; v.el.querySelector("b").textContent = who; }
        const y = Math.max(0, Number(c.y) || 0), h = Math.max(0, Number(c.h) || 0);
        if (y !== v.y || h !== v.h) { v.y = y; v.h = h; v.t = now(); }
        continue;
      }
      keep.add(c.k);
      const x = Number(c.x) || 0, y = Number(c.y) || 0;
      let p = peers.get(c.k);
      if (!p) {
        const el = document.createElement("div");
        el.className = "p";
        el.innerHTML = html(`<svg viewBox="0 0 24 24"><path d="M4 2.5l6.8 18.2 2.5-7.4 7.4-2.5z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span></span>`);
        peersBox.appendChild(el);
        p = { el, x, y, tx: x, ty: y, t: now(), on: false, color: "", who: null };
        peers.set(c.k, p);
      }
      if (p.color !== color) { p.color = color; p.el.querySelector("path").setAttribute("fill", color); p.el.querySelector("span").style.background = color; }
      const who = String(c.who || "").slice(0, 40);
      if (p.who !== who) { p.who = who; p.el.querySelector("span").textContent = who; }
      if (x !== p.tx || y !== p.ty) { p.tx = x; p.ty = y; p.t = now(); }
    }
    for (const [k, p] of peers) if (!keep.has(k)) { p.el.remove(); peers.delete(k); }
    for (const [k, v] of views) if (!keep.has(k)) { v.el.remove(); views.delete(k); }
    kickPeers();
    setTimeout(kickPeers, 3050); // the fade, once they stop
    setTimeout(kickPeers, 4050); // a mark's name, once they stop scrolling
  }

  function status(token, text, kind) {
    if (token !== TOKEN) return false;
    if (kind === "user") return drainUser();
    if (kind === "pointer") return { me: ptr, agent: agentPtr, view };
    if (kind === "owned") return fields(text, kind);
    if (kind === "claim") return claim(text);
    if (kind === "tick") return { me: ptr, agent: agentPtr, view, dirty: tickFrame() };
    if (kind === "cursors") { if (document.documentElement) setPeers(String(text || "[]")); return true; }
    // Agents' screenshots never show other people's pointers: hidden while one is taken.
    if (kind === "peers-hidden") { if (peersBox) peersBox.style.display = text ? "none" : ""; return true; }
    if (!document.documentElement) return false;
    if (kind === "cursor") {
      try {
        const c = JSON.parse(text);
        const ms = pointer(Number(c.x) || 0, Number(c.y) || 0, String(c.act || ""), String(c.who || "Claude"), String(c.color || ""), Number(c.w) || 24);
        agentPtr = { x: Math.round((Number(c.x) || 0) + scrollX), y: Math.round((Number(c.y) || 0) + scrollY), t: now() };
        const bw = Math.max(0, Number(c.bw) || 0), bh = Math.max(0, Number(c.bh) || 0);
        agentBox = { x: agentPtr.x - bw / 2, y: agentPtr.y - bh / 2, w: bw, h: bh, t: now() };
        agentAt = now(); // the scrolling an agent's action causes isn't the person's
        return { ms }; // until it arrives
      } catch {}
      return true;
    }
    if (kind === "bar") {
      setBar(text);
      return true;
    }
    if (kind === "join") return joinOn(text);
    if (kind === "join-off") return joinOff(String(text || ""));
    if (kind === "join-state") return joinState();
    if (kind === "join-answers") { const a = answered, g = gone, d = dismissed; answered = null; answeredCount = 0; gone = ""; dismissed = ""; return { a, open: joins.size, ids: [...joins.keys()].join(","), gone: g, dismissed: d }; }
    if (kind === "spark") {
      spark(String(text || ""));
      return true;
    }
    if (!text) {
      host?.remove();
      return true;
    }
    ensure();
    box.className = "b " + (kind === "you" || kind === "done" ? kind : "claude");
    box.querySelector("span").textContent = (kind === "you" ? "Your turn: " : kind === "done" ? "Done: " : "Claude: ") + String(text).slice(0, 140);
    return true;
  }

  Object.defineProperty(window, NAME, { value: status, enumerable: false, writable: false, configurable: false });
})();
