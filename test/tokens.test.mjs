// The design tokens (ui/tokens.css): one sheet for every surface PairBrowse
// styles itself. hud.js and record.js carry the same values inline; this keeps every literal color
// in those files and the page sheets equal to a sheet value or a participant color, and checks
// WCAG AA contrast for the text colors in both schemes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const UI = "ui/";
const sheet = read(UI + "tokens.css");

// Custom properties in a block: { name: value }.
const props = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
const noComments = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
const dark = props(noComments.match(/^:root\s*\{([^}]*)\}/m)[1]);
const lightBlock = noComments.match(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root\[data-scheme="system"\]\s*\{([^}]*)\}/);
const light = { ...dark, ...props(lightBlock ? lightBlock[1] : "") };

// "#abc", "#aabbcc", "rgb(1 2 3 / .5)", "rgba(1,2,3,.5)" -> "#rrggbb" (alpha ignored); else null.
function norm(c) {
  const s = String(c).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((x) => x + x).join("");
    return h.length >= 6 ? "#" + h.slice(0, 6) : null;
  }
  m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (m) return "#" + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  return null;
}
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(norm(a)), lum(norm(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const REQUIRED = ["bg", "chrome", "sidebar", "elevated", "hover", "ink", "ink-2", "muted", "edge", "accent", "accent-ink", "accent-soft",
  "edge-input", "ok", "warn", "bad", "spark", "sans", "mono", "fs-0", "fs-1", "fs-2", "fs-3", "fw-name", "r-1", "r-2", "r-3", "t",
  "tab-idle", "tab-top", "edge-tab", "tab-lit", "glow-tab", "edge-light", "edge-lit", "surface-grad", "shadow-raised", "glow-soft", "glow-accent",
  "glow-ok", "glow-focus", "live-bg", "live-edge", "live-ink", "btn", "edge-btn", "accent-fill", "panel", "panel-edge", "inset", "column"];
const PAGES = ["right/right.css", "picker/picker.css", "newtab/newtab.css", "screen/screen.css", "settings/settings.css"].map((x) => UI + x).concat("scripts/liveview.css");
// Every page sheet under ui/ (strip, docks, timeline, approve and the rest) plus the live view's.
const ALL_CSS = readdirSync(root + UI, { withFileTypes: true }).filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(root + UI + d.name).filter((f) => f.endsWith(".css")).map((f) => `${UI}${d.name}/${f}`)).concat("scripts/liveview.css");

test("the sheet has every token, dark by default and light only for the live view", () => {
  for (const k of REQUIRED) assert.ok(dark[k], `--${k}`);
  assert.ok(lightBlock, "a light block under :root[data-scheme=\"system\"]");
  for (const k of ["bg", "chrome", "sidebar", "elevated", "hover", "ink", "ink-2", "muted", "edge", "edge-input", "accent-ink", "ok", "warn", "bad"]) {
    assert.notEqual(light[k], dark[k], `light --${k}`);
  }
});

test("text colors meet WCAG AA on every surface, in both schemes", () => {
  for (const [scheme, t] of [["dark", dark], ["light", light]]) {
    for (const fg of ["ink", "ink-2", "muted", "accent-ink", "ok", "warn", "bad"]) {
      for (const bg of ["bg", "chrome", "sidebar", "elevated"]) {
        const r = contrast(t[fg], t[bg]);
        assert.ok(r >= 4.5, `${scheme}: --${fg} on --${bg} is ${r.toFixed(2)}:1`);
      }
    }
    for (const fg of ["muted", "accent-ink", "ink", "ink-2"]) {
      const r = contrast(t[fg], t.hover);
      assert.ok(r >= 3, `${scheme}: --${fg} on --hover is ${r.toFixed(2)}:1`);
    }
    for (const bg of ["bg", "chrome", "sidebar", "elevated"]) {
      const r = contrast(t["edge-input"], t[bg]);
      assert.ok(r >= 3, `${scheme}: a text field's border (--edge-input) on --${bg} is ${r.toFixed(2)}:1`);
    }
    for (const bg of ["bg", "chrome", "sidebar", "panel"]) {
      const r = contrast(t["edge-btn"], t[bg]);
      assert.ok(r >= 3, `${scheme}: a plain button's ring (--edge-btn) on --${bg} is ${r.toFixed(2)}:1`);
    }
    const r = contrast(t.bg, t.accent);
    assert.ok(r >= 4.5, `${scheme}: primary button text (--bg on --accent) is ${r.toFixed(2)}:1`);
    for (const bg of ["bg", "chrome", "sidebar"]) {
      const r = contrast(t.spark, t[bg]);
      assert.ok(r >= 3, `${scheme}: the spark on the tab Claude works in (--spark on --${bg}) is ${r.toFixed(2)}:1`);
    }
  }
});

test("dark ink on every participant color is AA (the cursor and avatar pills)", async () => {
  const { SPARK_COLORS } = await import("../scripts/daemon/hud.mjs");
  for (const c of SPARK_COLORS) {
    const r = contrast(dark.bg, c);
    assert.ok(r >= 4.5, `--bg on ${c} is ${r.toFixed(2)}:1`);
  }
  // The mockup's palette (the user, 2026-10-12): Codex purple, Gemini blue; white fails AA on each.
  for (const c of ["#9b7bfa", "#4b8ffb"]) assert.ok(SPARK_COLORS.includes(c), `${c} is in the palette`);
  for (const c of SPARK_COLORS) {
    const white = contrast("#ffffff", c);
    assert.ok(white < 4.5, `white on ${c} is ${white.toFixed(2)}:1, so the initials and pills take the dark ink`);
  }
  // The left page's "Shared with" avatars are neutral unless the helper sends a color (the mockup's Team row).
  assert.doesNotMatch(read(UI + "left/left.js"), /GUEST_COLORS/, "no colors picked from a name");
});

// oklch() literals allowed in the sheets: white or black with alpha (shadows, a scrim), the participant chip
// (its hue is var(--h)), and the live view's light loading skeleton, which stands for a page not yet drawn.
const SKELETON = new Set(["oklch(0.97 0.004 260)", "oklch(0.93 0.008 260)", "oklch(0.45 0.03 265)"]);
const oklchAllowed = (c) => /^oklch\((1|0) 0 0 \/ [\d.]+\)$/.test(c) || /var\(--h\b/.test(c) || SKELETON.has(c);

test("every literal color in the styled files is a sheet value, a participant color, white or black", async () => {
  const { SPARK_COLORS } = await import("../scripts/daemon/hud.mjs");
  const allowed = new Set(["#ffffff", "#000000", ...SPARK_COLORS.map(norm)]);
  for (const t of [dark, light]) for (const v of Object.values(t)) { const n = norm(v); if (n) allowed.add(n); }
  assert.equal(norm(dark.spark), norm(SPARK_COLORS[0]), "--spark is Claude's own spark color");
  const files = [UI + "right/right.css", UI + "picker/picker.css", UI + "newtab/newtab.css", UI + "screen/screen.css", UI + "settings/settings.css", "scripts/liveview.css", "scripts/hud.js", UI + "capture/record.js", "scripts/tabs.mjs", "scripts/daemon/preview.mjs"];
  for (const f of files) {
    const text = read(f).replace(/%23([0-9a-fA-F]{3,8})\b/g, "#$1");
    const found = [...text.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|oklch\((?:[^()]|\([^()]*\))*\)/g)].map(([m]) => m);
    assert.ok(found.length > 0 || f.endsWith("newtab.css") || f.endsWith("settings.css"), `${f} has colors`);
    for (const c of found) {
      if (c.startsWith("oklch")) { assert.ok(oklchAllowed(c), `${f}: ${c} is not a token value`); continue; }
      if (/var\(/.test(c)) continue;
      const n = norm(c);
      assert.ok(n && allowed.has(n), `${f}: ${c} is not a token value`);
    }
  }
});

test("every token in the sheet is read by a page", () => {
  // The sheet's own shared rules after :root (the motion language, DESIGN.md Part I) are on every
  // page, so a token they read counts, and so does one a token is made of (--t-close of --ease-in).
  const shared = noComments.slice(noComments.indexOf("}", noComments.search(/^:root\s*\{/m)) + 1) + Object.values(dark).join("\n");
  const css = [...ALL_CSS.map(read), shared].join("\n");
  for (const k of Object.keys(dark)) assert.match(css, new RegExp(`var\\(--${k}\\b`), `--${k} is used`);
  for (const f of PAGES) assert.doesNotMatch(read(f), /font(-size)?:[^;]*\b1[123]px/, `${f}: type sizes come from --fs-1..3`);
});

// rgb(r g b / a) over an opaque "#rrggbb" -> "#rrggbb".
function over(fg, alpha, bg) {
  const f = norm(fg), b = norm(bg);
  return "#" + [1, 3, 5].map((i) => Math.round(parseInt(f.slice(i, i + 2), 16) * alpha + parseInt(b.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, "0")).join("");
}
const alphaOf = (c) => { const m = String(c).match(/\/\s*([\d.]+)\s*\)$/); return m ? Number(m[1]) : 1; };
const colorsIn = (v) => [...String(v).matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map(([m]) => m);

// The mockup's active tab and timeline sizes, measured on its pixels (2026-10-13).
test("the active tab's colors and the 10 px size are the mockup's", () => {
  assert.deepEqual([norm(dark["tab-top"]), norm(dark["edge-tab"]), norm(dark["tab-lit"]), dark["fs-0"]], ["#1b365f", "#2493ed", "#55baf2", "10px"]);
  const sizes = Object.entries(dark).filter(([k]) => /^fs-\d$/.test(k)).map(([, v]) => v);
  // B11's scale: 10 (the timeline's time and caption) to 20 (page titles).
  assert.deepEqual(sizes, ["10px", "11px", "12px", "13px", "14px", "17px", "20px"]);
  assert.ok(contrast(dark["ink-2"], dark["tab-top"]) >= 4.5 && contrast(dark.ink, dark["tab-top"]) >= 4.5, "the active tab's text stays AA");
});
// A placeholder is text: a sheet text color at full opacity (a faded --muted fell to 4.46:1 on --bg),
// so the AA check above holds for it too.
test("every placeholder is a sheet text color at full opacity", () => {
  for (const f of ALL_CSS) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, sel, body] of css.matchAll(/([^{}]*::placeholder[^{}]*)\{([^}]*)\}/g)) {
      const color = body.match(/(?:^|;)\s*color\s*:\s*var\(--([a-z0-9-]+)\)/)?.[1];
      assert.ok(["ink", "ink-2", "muted"].includes(color), `${f}: ${sel.trim()} takes --ink, --ink-2 or --muted (${color})`);
      const opacity = body.match(/(?:^|;)\s*opacity\s*:\s*([\d.]+)/)?.[1];
      assert.equal(opacity, "1", `${f}: ${sel.trim()} sets opacity: 1`);
      for (const [scheme, t] of [["dark", dark], ["light", light]]) for (const bg of ["bg", "chrome", "elevated"]) {
        const r = contrast(t[color], t[bg]);
        assert.ok(r >= 4.5, `${scheme}: ${f} placeholder (--${color}) on --${bg} is ${r.toFixed(2)}:1`);
      }
    }
  }
});

test("the static light keeps text at AA", () => {
  const t = dark;
  const stops = colorsIn(t["surface-grad"]);
  assert.ok(stops.length >= 2, "--surface-grad has stops");
  for (const c of stops) assert.match(c, /^rgb\(0 0 0 \/ [\d.]+\)$/, `--surface-grad stop ${c} only darkens`);
  for (const bg of ["tab-idle", "tab-top"]) for (const fg of ["ink", "ink-2"]) {
    const r = contrast(t[fg], t[bg]);
    assert.ok(r >= 4.5, `--${fg} on --${bg} is ${r.toFixed(2)}:1`);
  }
  // The mockup's opaque fills under text: the Live session pill, Allow (white), the docks' panels; a
  // destructive confirm's red on the raised surface.
  for (const [fg, bg] of [["bad-ink", "elevated"], ["bad-ink", "chrome"], ["live-ink", "live-bg"], ["ink", "btn"], ["ink-2", "panel"], ["ink-2", "inset"], ["ink-soft", "sidebar"], ["accent-ink", "nav-active"], ["ink", "badge"]]) {
    const r = contrast(t[fg], t[bg]);
    assert.ok(r >= 4.5, `--${fg} on --${bg} is ${r.toFixed(2)}:1`);
  }
  assert.ok(contrast("#ffffff", t["accent-fill"]) >= 4.5, "white on --accent-fill (Allow)");
  const pairs = [["ink", "accent-soft", "sidebar"], ["accent-ink", "accent-soft", "sidebar"]];
  for (const [fg, tint, bg] of pairs) {
    const c = colorsIn(t[tint])[0];
    const r = contrast(t[fg], over(c, alphaOf(c), t[bg]));
    assert.ok(r >= 4.5, `--${fg} on --${tint} over --${bg} is ${r.toFixed(2)}:1`);
  }
  const sheetColors = new Set(["#ffffff", "#000000"]);
  for (const v of Object.values(t)) { const n = norm(v); if (n) sheetColors.add(n); }
  for (const k of Object.keys(t).filter((k) => /^(glow|shadow|edge)-/.test(k) && k !== "edge-input")) {
    const cs = colorsIn(t[k]);
    assert.ok(cs.length > 0, `--${k} has a color`);
    for (const c of cs) assert.ok(sheetColors.has(norm(c)), `--${k}: ${c} is a sheet color, white or black`);
  }
});

test("a joiner's picture page keeps its muted text at AA on the pill, even over a white page", () => {
  const css = read(UI + "screen/screen.css");
  const m = css.match(/--pill:\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/);
  assert.ok(m, "--pill is rgb(r g b / a)");
  const [r, g, b, a] = m.slice(1).map(Number);
  assert.equal(norm(`rgb(${r} ${g} ${b})`), norm(dark.bg), "--pill is the sheet's --bg");
  for (const under of [255, 0]) {
    const over = "#" + [r, g, b].map((c) => Math.round(c * a + under * (1 - a)).toString(16).padStart(2, "0")).join("");
    for (const fg of ["muted", "ink-2", "ink"]) {
      const c = contrast(dark[fg], over);
      assert.ok(c >= 4.5, `--${fg} on the pill over ${under ? "white" : "black"} is ${c.toFixed(2)}:1`);
    }
  }
});

test("no blur, no glass and no background picture", () => {
  for (const f of ["right/right.css", "picker/picker.css", "newtab/newtab.css", "screen/screen.css"].map((x) => UI + x).concat("scripts/liveview.css")) {
    const css = read(f);
    assert.doesNotMatch(css, /backdrop-filter/, f);
    assert.doesNotMatch(css, /ntp\.png/, f);
    assert.doesNotMatch(css, /^\s*:root\s*\{[^}]*--(?!pill)[a-z-]+\s*:/m, `${f} has no tokens of its own (screen.css keeps --pill)`);
  }
  assert.equal(existsSync(root + UI + "ntp.png"), false);
  assert.equal(existsSync(root + UI + "newtab/ntp.png"), false);
  const opening = read("scripts/tabs.mjs");
  for (const re of [/backdrop-filter/, /gradient\(/, /@keyframes/, /inset 0/]) assert.doesNotMatch(opening, re, "the Opening tabs page is flat");
});

test("every page links the sheet before its own", () => {
  for (const page of ["right", "picker", "newtab", "screen"]) {
    const html = read(`${UI}${page}/index.html`);
    const a = html.indexOf('<link rel="stylesheet" href="../tokens.css">'), b = html.indexOf(`href="${page}.css"`);
    assert.ok(a >= 0 && b > a, `${page}.html`);
  }
  const lv = read("scripts/liveview.html");
  const a = lv.indexOf('<link rel="stylesheet" href="assets/tokens.css">'), b = lv.indexOf('href="assets/liveview.css"');
  assert.ok(a >= 0 && b > a, "liveview.html");
  assert.match(lv, /<html[^>]*\sdata-scheme="system"/);
});

test("the window frame's seed is the sheet's chrome navy", async () => {
  const { THEME_COLOR } = await import("../scripts/browser.mjs");
  assert.equal("#" + (THEME_COLOR >>> 0).toString(16).slice(2), norm(dark.chrome));
});

test("text that sits on --hover takes --ink-2, which keeps AA there (muted does not)", () => {
  for (const [scheme, t] of [["dark", dark], ["light", light]]) {
    const r = contrast(t["ink-2"], t.hover);
    assert.ok(r >= 4.5, `${scheme}: --ink-2 on --hover is ${r.toFixed(2)}:1`);
  }
  const css = read("scripts/liveview.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = css.match(/([^{}]*\.overview \[aria-current="true"\] \.last[^{}]*)\{([^}]*)\}/);
  assert.ok(rule && /color:\s*var\(--ink-2\)/.test(rule[2]), "the current tab's last action is --ink-2");
  assert.match(rule[1], /\.activity li:not\(:first-child\) code/, "older actions' code chips are --ink-2");
});

test("Claude's owner dot in the live view is the sheet's --spark, like the spark beside it", async () => {
  const { SPARK_COLORS } = await import("../scripts/daemon/hud.mjs");
  const { AGENT_COLOR } = await import("../ui/vocab.js");
  const js = read("scripts/liveview.js");
  assert.equal(AGENT_COLOR, SPARK_COLORS[0]);
  assert.match(js, /^import \{ AGENT_COLOR \} from "\.\/vocab\.js";$/m);
  assert.ok(js.includes('=== AGENT_COLOR ? "var(--spark)"'));
});

test("the Opening tabs page says each row's state in text, not by color alone", async () => {
  const { loadingHtml } = await import("../scripts/tabs.mjs");
  const html = loadingHtml([{ url: "https://example.com/", title: "Example" }]);
  for (const s of ["waiting", "opening", "failed"]) assert.match(html, new RegExp(`li\\[data-s=${s}\\] \\.h::before\\{content:"${s} · "`), s);
  assert.doesNotMatch(html, /--card\b/, "the sheet's name, --sidebar");
});

test("the centre column (--column, 525): the mockup's value, the text on it AA and a field's border 3:1", () => {
  assert.equal(norm(dark.column), "#1b2836");
  for (const [fg, min, want] of [["ink", 4.5, 13.7], ["ink-2", 4.5, 6.9], ["muted", 4.5, 5.1], ["edge-input", 3, 3.3]]) {
    const r = contrast(dark[fg], dark.column);
    assert.ok(r >= min, `--${fg} on --column is ${r.toFixed(2)}:1`);
    assert.ok(Math.abs(r - want) < 0.1, `--${fg} on --column is ${r.toFixed(2)}:1, measured ${want}`);
  }
  // The omnibox (--panel) sits darker on the column, the docks (--sidebar) darker still.
  assert.ok(lum(norm(dark.panel)) < lum(norm(dark.column)), "--panel is darker than --column");
});

test("inkOn: the dark ink on every participant color, white on a dark fill, whichever has the higher contrast", async () => {
  const { inkOn, INK_DARK, INK_LIGHT } = await import("../ui/common.js");
  const { SPARK_COLORS } = await import("../scripts/daemon/hud.mjs");
  assert.equal(INK_DARK, "#0B1421");
  assert.equal(norm(INK_DARK), norm(dark.bg), "the dark ink is the sheet's --bg");
  for (const c of SPARK_COLORS) {
    assert.equal(inkOn(c), "#0B1421", `ink on ${c}`);
    assert.ok(contrast(inkOn(c), c) >= 4.5, `ink on ${c} is AA`);
  }
  for (const c of ["#E9763F", "#9B7BFA", "#4B8FFB", "#4ADE80"]) assert.equal(inkOn(c), "#0B1421", `ink on ${c} (upper case)`);
  assert.equal(inkOn("#1D2B3A"), INK_LIGHT, "white on a dark fill");
  assert.equal(inkOn("#000000"), INK_LIGHT);
  assert.equal(inkOn("#ffffff"), INK_DARK);
  for (const c of ["#3285F6", "#7a7a7a", "#2870E4", "#EF6468", "#1D2B3A"]) {
    const ink = inkOn(c), other = ink === INK_LIGHT ? INK_DARK : INK_LIGHT;
    assert.ok(contrast(ink, c) >= contrast(other, c), `inkOn(${c}) picks the higher contrast`);
  }
  assert.equal(inkOn("var(--spark)"), INK_DARK, "not a color: the dark ink");
  assert.equal(inkOn(""), INK_DARK);
});

// ---- one spacing, size and type scale (545, DESIGN.md Part G) ----
// Only the page sheets under ui/ (the live view has its own rhythm).
const UI_CSS = ALL_CSS.filter((f) => f.startsWith(UI));
// A line that keeps a measured value says so: /* mockup ... */ (the mockup's pixels, Part B) or
// /* native ... */ (a size the browser sets).
const exempt = (line) => /\/\*\s*(mockup|native)\b/.test(line);
// Function calls (calc, var, min, max) are left whole: their parts are tokens, or a 1 px border
// taken off one; what is left must be 0, 1, 2 or a multiple of 4 px.
const flat = (v) => { let out = "", depth = 0; for (const ch of v) { if (ch === "(") depth++; if (!depth) out += ch; if (ch === ")") { depth--; if (!depth) out += "0"; } } return out; };
const onGrid = (v) => !/^-?\d*\.?\d+px$/.test(v) || [0, 1, 2].includes(Math.abs(Number.parseFloat(v))) || Number.parseFloat(v) % 4 === 0;
const SPACING = /(?:^|[;{\s])((?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|gap|row-gap|column-gap|top|right|bottom|left|height|min-height)\s*:\s*([^;}]+)/g;

test("spacing on the 4 px grid: every padding, margin, gap, offset and height in the pages", () => {
  const off = [];
  for (const f of UI_CSS) {
    read(f).split("\n").forEach((line, i) => {
      if (exempt(line)) return;
      const code = line.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, prop, value] of code.matchAll(SPACING)) {
        const parts = flat(value.trim().replace(/\s*!important$/, "")).split(/[\s,/]+/);
        if (parts.some((v) => !onGrid(v))) off.push(`${f}:${i + 1} ${prop}: ${value.trim()}`);
      }
    });
  }
  assert.deepEqual(off, [], "a value off the grid takes a token or a 4 px step, or says /* mockup */ or /* native */ on its line");
  // The scale is in the sheet, and the docks share one content edge (gutter + inset = 20 px).
  for (const [k, v] of Object.entries({ "sp-1": "4px", "sp-2": "8px", "sp-3": "12px", "sp-4": "16px", "sp-5": "20px", "sp-6": "24px", "sp-8": "32px", "dock-gutter": "8px", "dock-inset": "12px", ctl: "32px", "ctl-sm": "28px", "ctl-xs": "24px", "ctl-strip": "34px", "row-nav": "36px", "row-person": "44px", "row-peer": "56px", "row-check": "30px", icon: "16px", "t-hover": "120ms ease-out" })) {
    assert.equal(dark[k], v, `--${k}`);
  }
  assert.equal(parseFloat(dark["dock-gutter"]) + parseFloat(dark["dock-inset"]), 20, "the docks' shared content edge is 20 px in");
});

test("font sizes come from the sheet: every font-size and font shorthand size is var(--fs-*)", () => {
  const off = [];
  for (const f of UI_CSS) {
    read(f).split("\n").forEach((line, i) => {
      const code = line.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, v] of code.matchAll(/(?:^|[;{\s])font-size\s*:\s*([^;}]+)/g)) if (!/^var\(--fs-\d\)$/.test(v.trim()) && v.trim() !== "inherit") off.push(`${f}:${i + 1} font-size: ${v.trim()}`);
      for (const [, raw] of code.matchAll(/(?:^|[;{\s])font\s*:\s*([^;}]+)/g)) {
        const v = raw.trim();
        if (v === "inherit" || /^var\(--[a-z-]+\)$/.test(v)) continue;
        const size = v.replace(/^(?:(?:normal|italic|[1-9]\d0|bold|var\(--fw-[a-z]+\))\s+)*/, "").split(/[\s/]/)[0];
        if (!/^var\(--fs-\d\)$/.test(size)) off.push(`${f}:${i + 1} font: ${v}`);
      }
    });
  }
  assert.deepEqual(off, []);
});

test("hover colors change in the sheet's 120 ms (--t-hover), not a literal", () => {
  for (const f of UI_CSS) assert.doesNotMatch(read(f), /\b120ms\b/, `${f}: transition durations come from --t-hover or --t`);
});
