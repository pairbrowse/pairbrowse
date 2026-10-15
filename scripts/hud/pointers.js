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
  const agentKey = (k) => /^host-agent:|:a\d+$/.test(k);
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
        svg{display:block;width:18px;height:18px;overflow:visible;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35))}
        span{position:absolute;left:14px;top:16px;${PILL}}
        .p.a svg{width:22px;height:22px}
        .p.a span{left:16px;top:18px}
        .v{position:fixed;right:0;top:0;display:flex;align-items:flex-start;gap:4px;opacity:.8;pointer-events:none}
        .v i{display:block;width:4px;border-radius:2px 0 0 2px;box-shadow:0 0 0 1px rgba(255,255,255,.7)}
        .v b{order:-1;${PILL};padding:1px 6px;font-size:10px;line-height:1.45;opacity:0;transition:opacity .35s ease}
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
      const color = /^#[0-9a-f]{6}$/i.test(c.color || "") ? c.color : "__PB_AGENT_COLOR__";
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
        const who = c.who ? shortWho(c.who) : "";
        if (v.who !== who) { v.who = who; v.el.querySelector("b").textContent = who; }
        const y = Math.max(0, Number(c.y) || 0), h = Math.max(0, Number(c.h) || 0);
        if (y !== v.y || h !== v.h) { v.y = y; v.h = h; v.t = now(); }
        continue;
      }
      keep.add(c.k);
      const x = Number(c.x) || 0, y = Number(c.y) || 0;
      let p = peers.get(c.k);
      // An agent's pointer (host-agent:<id>, <joiner>:a<n>) is drawn as the agent cursor: white,
      // edged in its color, at its size; a person's is filled with their color, edged in white.
      const agent = agentKey(c.k);
      if (!p) {
        const el = document.createElement("div");
        el.className = agent ? "p a" : "p";
        el.innerHTML = html(agent
          ? `<svg viewBox="1 1 22 22"><path d="${POINTER}" fill="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span></span>`
          : `<svg viewBox="1 1 22 22"><path d="${POINTER}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span></span>`);
        peersBox.appendChild(el);
        p = { el, x, y, tx: x, ty: y, t: now(), on: false, color: "", who: null };
        peers.set(c.k, p);
      }
      if (p.color !== color) { p.color = color; p.el.querySelector("path").setAttribute(agent ? "stroke" : "fill", color); p.el.querySelector("span").style.background = color; }
      const who = c.who ? shortWho(c.who) : "";
      if (p.who !== who) { p.who = who; p.el.querySelector("span").textContent = who; }
      if (x !== p.tx || y !== p.ty) { p.tx = x; p.ty = y; p.t = now(); }
    }
    for (const [k, p] of peers) if (!keep.has(k)) { p.el.remove(); peers.delete(k); }
    for (const [k, v] of views) if (!keep.has(k)) { v.el.remove(); views.delete(k); }
    kickPeers();
    setTimeout(kickPeers, 3050); // the fade, once they stop
    setTimeout(kickPeers, 4050); // a mark's name, once they stop scrolling
  }

