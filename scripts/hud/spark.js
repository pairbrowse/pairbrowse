  // Claude's tab: the orange spark as its tab icon (the site's own icon comes back when Claude moves on).
  const SPARK = "M8 0.8c.5 0 .8.4.9.9l.5 4 3.3-2.3c.4-.3 1-.2 1.3.2.3.4.2 1-.2 1.3L10.6 7.3l4 .6c.5.1.9.5.8 1-.1.5-.5.8-1 .7l-4-.5 2.3 3.3c.3.4.2 1-.2 1.3-.4.3-1 .2-1.3-.2L8.9 10.2l-.5 4c-.1.5-.5.9-1 .8-.5 0-.8-.5-.8-1l.6-4-3.3 2.3c-.4.3-1 .2-1.3-.2-.3-.4-.2-1 .2-1.3l3.2-2.4-4-.5c-.5-.1-.9-.5-.8-1 .1-.5.5-.8 1-.8l4 .6L3.9 3.5c-.3-.4-.2-1 .2-1.3.4-.3 1-.2 1.3.2l2.4 3.3.5-4c0-.5.4-.9.9-.9Z";
  let sparkLink = null;
  let sparkColor = null; // kept here, not on the link: nothing extra for a page to see
  let sparkAgent = ""; // the agent spark's color alone: the bar's driver dot
  let savedIcons = [];
  function drawSpark(ctx, x, y, size, color = "__PB_AGENT_COLOR__") {
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
    if (color !== sparkAgent) { sparkAgent = color; paintDot(); }
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

