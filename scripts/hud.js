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
  function record(kind, what) {
    if (userEvents.length >= 60) return;
    userEvents[userEvents.length] = { t: now(), kind, what };
  }
  function drainUser() {
    const out = userEvents;
    userEvents = [];
    return out;
  }
  const opts = { capture: true, passive: true };
  // The element really under the pointer or holding focus, also inside shadow DOM.
  const control = (e) => { for (const el of e.composedPath()) if (el.matches?.(CONTROL)) return el; return null; };
  const focused = () => { let el = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return el; };
  // PairBrowse's own bar (its "Pause agents" button) is never input in the page.
  let barHost;
  const ours = (e) => !!barHost && e.composedPath().includes(barHost);
  addEventListener("pointerdown", (e) => { if (e.isTrusted && !ours(e)) record("click", named(control(e))); }, opts);
  addEventListener("keydown", (e) => {
    if (!e.isTrusted || ours(e)) return;
    const el = focused();
    if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) record("type", named(el));
    else if (e.key.length > 1) record("key", e.key); // Enter, Escape, Tab, arrows: never the letters
  }, opts);
  // A wheel is always a person (Claude never sends one). Plain scroll events aren't counted: pages
  // scroll themselves (menus, smooth scrolling) and Claude's clicks bring buttons into view.
  addEventListener("wheel", (e) => { const n = now(); personAt = n; if (e.isTrusted && n - lastWheel > 800) { lastWheel = n; record("wheel", ""); } }, opts);
  // Where the person is reading (the top of their viewport and its height, in document pixels):
  // a shared tab marks it on the other side's scrollbar. Taken from scrolling that follows their
  // own input (wheel, keys, a press on the scrollbar, touch), never the page's or an agent's.
  let view = null, personAt = 0, agentAt = 0;
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
    if (!view || n - view.t > 1000) looked();
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
    shadow.innerHTML = `<style>
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
    </style><div class="b" aria-hidden="true"><svg viewBox="0 0 16 16"><path fill="currentColor" d="${SPARK}"/></svg><span></span><b class="x" title="Hide">×</b></div>`;
    box = shadow.querySelector(".b");
    hostPlace = document.createElement("style"); // where the badge sits: above the bar when there is one
    hostPlace.textContent = barHost?.isConnected ? ":host{bottom:42px !important}" : "";
    shadow.appendChild(hostPlace);
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
  // The spark fills the whole tab icon, so Claude's tab stands out in a row of tabs.
  function sparkIcon(color) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    drawSpark(c.getContext("2d"), 0, 0, 64, color);
    return c.toDataURL("image/png");
  }
  // color: that participant's spark color ("#rrggbb"), or "" to put the site's own icon back.
  function spark(color) {
    const head = document.head || document.documentElement;
    if (!/^#[0-9a-f]{6}$/i.test(color || "")) {
      if (!sparkLink) return;
      sparkLink.remove();
      sparkLink = null;
      for (const l of savedIcons) head.appendChild(l);
      savedIcons = [];
      return;
    }
    if (sparkLink?.isConnected) {
      if (sparkColor !== color) { sparkLink.href = sparkIcon(color); sparkColor = color; }
      return;
    }
    const icons = [...document.querySelectorAll('link[rel~="icon"]')];
    const href = sparkIcon(color);
    savedIcons = icons;
    icons.forEach((l) => l.remove());
    sparkLink = document.createElement("link");
    sparkLink.rel = "icon";
    sparkLink.href = href;
    sparkColor = color;
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
    shadow.innerHTML = `<style>
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
      @media (prefers-reduced-motion:reduce){.bar,.bar *{animation:none!important;transition:none!important}}
    </style><div class="bar" aria-hidden="true"><span class="who"><svg viewBox="0 0 16 16"><path fill="currentColor" d="${SPARK}"/></svg><span></span></span><ol></ol><button class="pz" tabindex="-1" hidden></button></div>`;
    bar = shadow.querySelector(".bar");
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
      document.addEventListener("mousemove", (e) => bar?.classList.toggle("away", e.clientY > innerHeight - 56 && !nearButton(e)), { passive: true });
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
    if (barPause) bar.querySelector(".who span").innerHTML = `Paused by <b>${esc(barPause.by)}</b>${barCanPause ? " \u00b7" : ""}`;
    else bar.querySelector(".who span").innerHTML = barWaiting ? `<b>${esc(who)}</b> is waiting… ${barPerson ? `${esc(barPerson)} is using this tab` : "you're using the browser"}` : `<b>${esc(who)}</b> ${driving ? "is driving" : "is idle"}`;
    const recent = barItems.slice(-3).reverse();
    const several = new Set(recent.map((a) => a.who || "")).size > 1; // name each line when people mix
    bar.querySelector("ol").innerHTML = recent.length
      ? recent.map((a) => `<li><time>${clock(a.t)}</time><span>${several && a.who ? `<b>${esc(a.who)}</b> ` : ""}${rich(a.text)}</span></li>`).join("")
      : "<li><span>Claude's actions show up here</span></li>";
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
    if (hostPlace) hostPlace.textContent = ":host{bottom:42px !important}"; // above the bar
  }

  // Claude's cursor: glides to where Claude clicks or types, rings on a click, fades when idle.
  let curHost, cur, curTimer;
  let agentPtr = null; // where it last pointed, in document coordinates
  function pointer(x, y, act) {
    if (!curHost || !curHost.isConnected) {
      curHost = document.createElement(TAG_CURSOR);
      const shadow = curHost.attachShadow({ mode: "closed" });
      shadow.innerHTML = `<style>
        :host{all:initial !important;position:fixed !important;z-index:2147483647 !important;left:0 !important;top:0 !important;pointer-events:none !important}
        .c{position:fixed;left:0;top:0;transition:transform .22s cubic-bezier(.22,1,.36,1),opacity .3s;opacity:0;will-change:transform}
        .c.on{opacity:1}
        svg{width:22px;height:22px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.35))}
        .r{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px rgba(27,30,60,.5);opacity:0}
        .c.click .r{animation:p .45s ease-out}
        @keyframes p{from{opacity:.9;transform:scale(.4)}to{opacity:0;transform:scale(1.4)}}
      </style><div class="c" aria-hidden="true"><div class="r"></div><svg viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#fff" stroke="#1b1e3c" stroke-width="1.6" stroke-linejoin="round"/></svg></div>`;
      cur = shadow.querySelector(".c");
      document.documentElement.appendChild(curHost);
    }
    cur.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    cur.classList.add("on");
    cur.classList.remove("click");
    if (act === "click") { void cur.offsetWidth; cur.classList.add("click"); }
    clearTimeout(curTimer);
    curTimer = setTimeout(() => cur.classList.remove("on"), 2500);
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
      shadow.innerHTML = `<style>
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
      </style><div aria-hidden="true"></div>`;
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
          el.innerHTML = "<i></i><b></b>";
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
        el.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 2.5l6.8 18.2 2.5-7.4 7.4-2.5z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span></span>`;
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
        pointer(Number(c.x) || 0, Number(c.y) || 0, String(c.act || ""));
        agentPtr = { x: Math.round((Number(c.x) || 0) + scrollX), y: Math.round((Number(c.y) || 0) + scrollY), t: now() };
        agentAt = now(); // the scrolling an agent's action causes isn't the person's

      } catch {}
      return true;
    }
    if (kind === "bar") {
      setBar(text);
      return true;
    }
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
