  let host, box, hostPlace;

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement(TAG_HUD);
    const shadow = host.attachShadow({ mode: "closed" });
    // The elevated navy surface, the sheet's values (tokens.css), a 3 px left edge in the agent's
    // color (accent for your turn, ok for done) and its spark. Your turn calls three times (a ring
    // and the spark), then stays lit: nothing endless but the Live dot (DESIGN.md B11, Part I).
    shadow.innerHTML = html(`<style>
      :host{all:initial !important;position:fixed !important;z-index:2147483647 !important;right:12px !important;bottom:12px !important}
      .b{display:flex;align-items:center;gap:9px;font:600 12px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;color:#F1F5FA;
         padding:9px 14px 9px 10px;border-radius:10px;max-width:min(440px,62vw);cursor:default;
         background:rgba(25,42,61,.97);border-left:3px solid __PB_AGENT_COLOR__;
         box-shadow:0 0 0 1px #293B50,0 8px 24px rgba(0,0,0,.35)}
      .b span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      svg{flex:none;width:15px;height:15px;color:__PB_AGENT_COLOR__}
      .you{animation:g 1.8s ease-in-out 3}
      .you svg{animation:s 1.8s ease-in-out 3}
      .x{flex:none;margin-left:2px;color:#8699B1;font:500 15px/1 system-ui;cursor:pointer;padding:0 2px}
      .x:hover{color:#F1F5FA}
      @keyframes g{50%{box-shadow:0 0 0 1px #293B50,0 8px 24px rgba(0,0,0,.35),0 0 0 4px rgba(50,133,246,.28)}}
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

